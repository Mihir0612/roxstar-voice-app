import { query, withTransaction, type Queryable } from '../db/pool.js';
import { draftNotFound, notAMember, roomClosed, roomNotFound } from '../errors/index.js';
import { getLogger } from '../logging/index.js';
import {
  toParticipantDTO,
  toRoomDTO,
  toSharedDraftDTO,
  type DraftDTO,
  type ParticipantDTO,
  type RoomDTO,
  type RoomStateDTO,
  type SharedDraftDTO,
} from '../models/dto.js';
import type { AudioEffect, RoomMember } from '../models/types.js';
import * as draftRepo from '../repositories/draft.repository.js';
import * as roomRepo from '../repositories/room.repository.js';
import { newRoomCode } from '../util/ids.js';
import { getBroadcaster } from '../websocket/broadcaster.js';
import { SERVER_EVENTS, envelope } from '../websocket/events.js';
import { flushPending, forfeitOnDeparture, type PendingBroadcast } from './spin.service.js';
import { buildRoomState } from './state.service.js';

/**
 * Room lifecycle.
 *
 * The backend is authoritative: clients ask for state, they never assert it.
 * Every mutation here commits before its event is broadcast.
 */

async function participantsOf(roomId: string, db: Queryable = { query }): Promise<ParticipantDTO[]> {
  return (await roomRepo.listActiveMembers(roomId, db)).map(toParticipantDTO);
}

/* --------------------------------- create --------------------------------- */

export async function createRoom(name: string, ownerId: string): Promise<RoomDTO> {
  // Room codes are short enough to collide occasionally; retry rather than
  // lengthening the code and making it harder to read out during a demo.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const room = await withTransaction(async (client) => {
        const created = await roomRepo.createRoom(name, newRoomCode(), ownerId, client);
        // The creator is a member from the first moment, so the room never
        // exists in a state where its owner is not in it.
        await roomRepo.upsertMember(created.id, ownerId, 'OWNER', client);
        return created;
      });

      getLogger().info({ roomId: room.id, code: room.code, ownerId }, 'Room created');
      return toRoomDTO(room);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const constraint = (err as { constraint?: string }).constraint;
      if (code === '23505' && constraint === 'rooms_code_key') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a unique room code after 5 attempts');
}

/* ---------------------------------- join ---------------------------------- */

export interface JoinResult {
  room: RoomDTO;
  member: ParticipantDTO;
  state: RoomStateDTO;
  /** False when the caller was already an active member (idempotent re-join). */
  created: boolean;
}

export async function joinRoom(roomIdOrCode: string, userId: string): Promise<JoinResult> {
  let broadcast: { participant: ParticipantDTO; participants: ParticipantDTO[] } | null = null;

  const result = await withTransaction(async (client) => {
    const room = await resolveRoom(roomIdOrCode, client);
    if (!room) throw roomNotFound();
    if (room.status === 'CLOSED') throw roomClosed();

    const existing = await roomRepo.findMember(room.id, userId, client);
    const alreadyActive = existing?.membershipStatus === 'ACTIVE';

    // Re-joining never escalates a role; upsertMember only applies MEMBER on
    // first insert, so the owner keeps OWNER and nobody else gains it.
    const member = await roomRepo.upsertMember(room.id, userId, 'MEMBER', client);
    const state = await buildRoomState(room.id, client);

    return { room, member, state, created: !alreadyActive };
  });

  const dto = await memberDTO(result.room.id, result.member);

  // A duplicate join is a no-op: no second `user_joined`, because clients would
  // otherwise render the same participant twice (concurrency case 1).
  if (result.created) {
    broadcast = { participant: dto, participants: await participantsOf(result.room.id) };
    getBroadcaster().emit(result.room.id, SERVER_EVENTS.USER_JOINED, {
      ...envelope(result.room.id),
      participant: broadcast.participant,
      participants: broadcast.participants,
    });
    getLogger().info({ roomId: result.room.id, userId }, 'User joined room');
  }

  return {
    room: toRoomDTO(result.room),
    member: dto,
    state: result.state,
    created: result.created,
  };
}

/* --------------------------------- leave ---------------------------------- */

/**
 * Leave a room.
 *
 * Explicit and immediate -- no grace period (D13) -- and it forfeits an active
 * spin seat (D11) in the same transaction, so a client can never observe the
 * user gone from the room but still alive in the spin.
 */
export async function leaveRoom(roomId: string, userId: string): Promise<{ left: boolean }> {
  const spinBroadcasts: PendingBroadcast[] = [];

  const left = await withTransaction(async (client) => {
    const room = await roomRepo.findRoomById(roomId, client);
    if (!room) throw roomNotFound();

    const member = await roomRepo.markLeft(roomId, userId, client);
    // Already gone. Idempotent by design: a retried leave must not 404.
    if (!member) return false;

    spinBroadcasts.push(...(await forfeitOnDeparture(roomId, userId, client)));
    return true;
  });

  if (left) {
    getBroadcaster().emit(roomId, SERVER_EVENTS.USER_LEFT, {
      ...envelope(roomId),
      userId,
      reason: 'EXPLICIT',
      participants: await participantsOf(roomId),
    });
    flushPending(roomId, spinBroadcasts);
    getLogger().info({ roomId, userId }, 'User left room');
  }

  return { left };
}

/* --------------------------------- state ---------------------------------- */

export async function getRoomState(roomId: string, db: Queryable = { query }): Promise<RoomStateDTO> {
  return buildRoomState(roomId, db);
}

/* ------------------------------ share draft -------------------------------- */

export interface ShareDraftInput {
  draftId: string;
  name: string;
  durationMs: number;
  effect: AudioEffect;
  hostedFileUrl?: string | null;
}

export interface ShareDraftResult {
  sharedDraft: SharedDraftDTO;
  draft: DraftDTO;
}

/**
 * Share a draft with the room (D10 -- metadata only).
 *
 * The audio file stays on the device. `hostedFileUrl` is persisted if the
 * client supplies one, but this service hosts nothing and streams nothing:
 * live audio is out of scope per the PDF.
 */
export async function shareDraft(
  roomId: string,
  userId: string,
  input: ShareDraftInput,
): Promise<ShareDraftResult> {
  const result = await withTransaction(async (client) => {
    const room = await roomRepo.findRoomById(roomId, client);
    if (!room) throw roomNotFound();
    if (room.status === 'CLOSED') throw roomClosed();

    const member = await roomRepo.findActiveMember(roomId, userId, client);
    if (!member) throw notAMember();

    const draft = await draftRepo.upsertDraft(
      {
        id: input.draftId,
        ownerId: userId,
        name: input.name,
        durationMs: input.durationMs,
        effect: input.effect,
        hostedFileUrl: input.hostedFileUrl ?? null,
      },
      client,
    );

    // Null means the draft id exists under a different owner. Reported as 404
    // rather than 403 so the response does not confirm that it exists.
    if (!draft) throw draftNotFound();

    const share = await draftRepo.recordShare(roomId, draft.id, userId, client);

    return {
      sharedDraft: toSharedDraftDTO({
        id: share.id,
        roomId,
        draftId: draft.id,
        sharedBy: userId,
        sharedAt: share.sharedAt,
        draft,
      }),
      draft,
    };
  });

  getBroadcaster().emit(roomId, SERVER_EVENTS.DRAFT_SHARED, {
    ...envelope(roomId),
    sharedDraft: result.sharedDraft,
  });
  getLogger().info({ roomId, userId, draftId: input.draftId }, 'Draft shared');

  return { sharedDraft: result.sharedDraft, draft: result.sharedDraft.draft };
}

/* ------------------------------- guards ----------------------------------- */

/** Assert active membership. Used by every room-scoped route (D9). */
export async function requireMembership(
  roomId: string,
  userId: string,
  db: Queryable = { query },
): Promise<RoomMember> {
  const room = await roomRepo.findRoomById(roomId, db);
  if (!room) throw roomNotFound();

  const member = await roomRepo.findActiveMember(roomId, userId, db);
  if (!member) throw notAMember();

  return member;
}

/* ------------------------------- helpers ---------------------------------- */

async function resolveRoom(roomIdOrCode: string, client: Queryable) {
  // Codes are 6 chars; ids are UUIDs. Length is enough to tell them apart, and
  // passing a code to a uuid column would otherwise raise a driver error.
  const looksLikeUuid = roomIdOrCode.length === 36 && roomIdOrCode.includes('-');
  return looksLikeUuid
    ? roomRepo.findRoomById(roomIdOrCode, client)
    : roomRepo.findRoomByCode(roomIdOrCode, client);
}

async function memberDTO(roomId: string, member: RoomMember): Promise<ParticipantDTO> {
  const all = await roomRepo.listActiveMembers(roomId);
  const found = all.find((m) => m.userId === member.userId);
  return found
    ? toParticipantDTO(found)
    : {
        userId: member.userId,
        displayName: '',
        role: member.role,
        connectionStatus: member.connectionStatus,
        joinedAt: member.joinedAt.toISOString(),
      };
}
