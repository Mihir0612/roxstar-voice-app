import { query, type Queryable } from '../db/pool.js';
import { roomNotFound } from '../errors/index.js';
import {
  toParticipantDTO,
  toRoomDTO,
  toSharedDraftDTO,
  toSpinDTO,
  type RoomStateDTO,
  type SpinDTO,
} from '../models/dto.js';
import type { Spin } from '../models/types.js';
import * as draftRepo from '../repositories/draft.repository.js';
import * as roomRepo from '../repositories/room.repository.js';
import * as spinRepo from '../repositories/spin.repository.js';

/**
 * Authoritative state assembly.
 *
 * Every path that has to tell a client "here is the truth" -- GET
 * /rooms/:id/state, the `room_state` event on connect and reconnect, and the
 * state embedded in each spin event -- comes through here. One builder means
 * REST and WebSocket cannot drift apart, which was mismatch #20 in the
 * integration audit.
 */

export async function buildSpinDTO(spin: Spin, db: Queryable = { query }): Promise<SpinDTO> {
  const participants = await spinRepo.listParticipants(spin.id, db);
  return toSpinDTO(spin, participants);
}

export async function buildRoomState(
  roomId: string,
  db: Queryable = { query },
): Promise<RoomStateDTO> {
  const room = await roomRepo.findRoomById(roomId, db);
  if (!room) throw roomNotFound();

  // Sequential, not Promise.all: `db` is frequently a single pooled client
  // inside a transaction, and one pg client cannot run overlapping queries.
  const members = await roomRepo.listActiveMembers(roomId, db);
  const sharedDraft = await draftRepo.findLatestSharedDraft(roomId, db);
  const activeSpin = await spinRepo.findActiveSpin(roomId, db);
  const latestSpin = await spinRepo.findLatestSpin(roomId, db);

  const activeSpinDto = activeSpin ? await buildSpinDTO(activeSpin, db) : null;

  // When the newest spin is the running one, `lastSpin` would duplicate it.
  // A finished spin is still reported so a client joining after the fact can
  // render the result without issuing a second request.
  const lastSpinDto =
    latestSpin && latestSpin.id !== activeSpin?.id ? await buildSpinDTO(latestSpin, db) : null;

  return {
    room: toRoomDTO(room),
    participants: members.map(toParticipantDTO),
    sharedDraft: sharedDraft ? toSharedDraftDTO(sharedDraft) : null,
    activeSpin: activeSpinDto,
    lastSpin: lastSpinDto,
  };
}
