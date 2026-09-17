import { getConfig } from '../config/index.js';
import { isUniqueViolation, query, withTransaction, type Queryable } from '../db/pool.js';
import {
  notAMember,
  notEnoughParticipants,
  notRoomAdmin,
  roomClosed,
  roomNotFound,
  spinAlreadyRunning,
  spinNotFound,
  tooManyParticipants,
} from '../errors/index.js';
import { getLogger } from '../logging/index.js';
import type { SpinDTO } from '../models/dto.js';
import type { Spin, SpinAbortReason } from '../models/types.js';
import * as roomRepo from '../repositories/room.repository.js';
import * as spinRepo from '../repositories/spin.repository.js';
import { pickRandom } from '../util/ids.js';
import { getBroadcaster } from '../websocket/broadcaster.js';
import { SERVER_EVENTS, type ServerEventMap, type ServerEventName } from '../websocket/events.js';
import { buildSpinDTO } from './state.service.js';

/**
 * The spin engine.
 *
 * Two invariants hold everywhere in this file:
 *
 *   1. State changes and their audit events commit in ONE transaction, and the
 *      broadcast happens only after that transaction commits. A client can
 *      therefore never observe an event the database does not record.
 *   2. No timer in this process is authoritative. `spins.next_elimination_at`
 *      is the clock (D14); `setInterval` only asks the database what is due.
 */

/** A broadcast held back until its transaction has committed. */
interface Pending<E extends ServerEventName = ServerEventName> {
  event: E;
  payload: ServerEventMap[E];
}

function flush(roomId: string, pending: Pending[]): void {
  const broadcaster = getBroadcaster();
  for (const p of pending) {
    broadcaster.emit(roomId, p.event, p.payload as never);
  }
}

/** Build the event envelope from a persisted spin_events row (D17). */
function envelopeFrom(
  roomId: string,
  row: { seq: string; eventId: string; createdAt: Date },
): { eventId: string; occurredAt: string; roomId: string; seq: string } {
  return {
    eventId: row.eventId,
    occurredAt: row.createdAt.toISOString(),
    roomId,
    seq: row.seq,
  };
}

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

export async function startSpin(roomId: string, userId: string): Promise<SpinDTO> {
  const cfg = getConfig();
  const pending: Pending[] = [];

  const dto = await withTransaction(async (client) => {
    // Locking the room row is the serialisation point for concurrent starts:
    // the second request waits here, then sees the spin the first one created.
    const room = await roomRepo.lockRoom(roomId, client);
    if (!room) throw roomNotFound();
    if (room.status === 'CLOSED') throw roomClosed();

    const member = await roomRepo.findActiveMember(roomId, userId, client);
    if (!member) throw notAMember();
    // PDF: "An admin or room owner starts the spin manually."
    if (member.role !== 'OWNER' && member.role !== 'ADMIN') throw notRoomAdmin();

    const existing = await spinRepo.findActiveSpin(roomId, client);
    if (existing) throw spinAlreadyRunning();

    // The roster is frozen at start time. Someone joining mid-spin is a
    // spectator, not a late entrant -- otherwise the 3-20 rule would be
    // unverifiable at any single moment.
    const members = await roomRepo.listActiveMembers(roomId, client);
    const eligible = members.map((m) => m.userId);

    if (eligible.length < cfg.SPIN_MIN_PARTICIPANTS) {
      throw notEnoughParticipants(eligible.length, cfg.SPIN_MIN_PARTICIPANTS);
    }
    if (eligible.length > cfg.SPIN_MAX_PARTICIPANTS) {
      throw tooManyParticipants(eligible.length, cfg.SPIN_MAX_PARTICIPANTS);
    }

    const firstDeadline = new Date(Date.now() + cfg.SPIN_ELIMINATION_INTERVAL_MS);

    let spin: Spin;
    try {
      spin = await spinRepo.createRunningSpin(
        roomId,
        userId,
        cfg.SPIN_ELIMINATION_INTERVAL_MS,
        firstDeadline,
        client,
      );
    } catch (err) {
      // Belt and braces: the row lock above should already have prevented this,
      // but the partial unique index is the real guarantee and it must surface
      // as a clean 409 rather than a 500.
      if (isUniqueViolation(err, 'spins_one_active_per_room_idx')) throw spinAlreadyRunning();
      throw err;
    }

    await spinRepo.addParticipants(spin.id, eligible, client);

    const spinDto = await buildSpinDTO(spin, client);
    const row = await spinRepo.appendEvent(
      spin.id,
      roomId,
      'spin_started',
      { spinId: spin.id, startedBy: userId, eligibleUserIds: eligible },
      client,
    );

    pending.push({
      event: SERVER_EVENTS.SPIN_STARTED,
      payload: { ...envelopeFrom(roomId, row), spin: spinDto },
    });

    return spinDto;
  });

  flush(roomId, pending);
  getLogger().info(
    { roomId, spinId: dto.spinId, participants: dto.participants.length },
    'Spin started',
  );
  return dto;
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/** Active spin if there is one, otherwise the most recent finished spin. */
export async function getSpinForRoom(roomId: string, db: Queryable = { query }): Promise<SpinDTO> {
  const spin = (await spinRepo.findActiveSpin(roomId, db)) ?? (await spinRepo.findLatestSpin(roomId, db));
  if (!spin) throw spinNotFound();
  return buildSpinDTO(spin, db);
}

/* -------------------------------------------------------------------------- */
/* Scheduled elimination                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Next deadline (D15).
 *
 * Anchored on the *scheduled* time, not on `now`, so normal jitter does not
 * accumulate into drift. If the process was down long enough to fall further
 * behind than the catch-up budget, the deadline is re-anchored instead: users
 * must not see nine eliminations replayed in one frame because a deploy took a
 * minute.
 */
export function computeNextDeadline(
  scheduled: Date,
  intervalMs: number,
  maxLagMs: number,
  now: Date = new Date(),
): Date {
  const candidate = new Date(scheduled.getTime() + intervalMs);
  const lag = now.getTime() - candidate.getTime();
  if (lag > maxLagMs) return new Date(now.getTime() + intervalMs);
  return candidate;
}

export interface TickOutcome {
  spinId: string;
  action: 'eliminated' | 'completed' | 'aborted' | 'skipped';
}

/** Process one due spin. Returns what happened, for logs and tests. */
export async function processSpinTick(spinId: string): Promise<TickOutcome> {
  const cfg = getConfig();
  const pending: Pending[] = [];
  let roomId = '';

  const outcome = await withTransaction<TickOutcome>(async (client) => {
    const spin = await spinRepo.claimDueSpin(spinId, client);
    // Not due, already finished, or held by another worker -- all benign.
    if (!spin) return { spinId, action: 'skipped' };
    roomId = spin.roomId;

    const active = await spinRepo.lockActiveParticipants(spin.id, client);

    // Everyone forfeited (D11). Nothing can win, so end the spin honestly
    // rather than leaving clients on a RUNNING screen forever.
    if (active.length === 0) {
      await finishAborted(spin, 'NO_PARTICIPANTS', client, pending);
      return { spinId, action: 'aborted' };
    }

    // Defensive: a single survivor should already have been declared the
    // winner by the previous tick or by a forfeit.
    if (active.length === 1) {
      await finishWithWinner(spin, (active[0] as { userId: string }).userId, client, pending);
      return { spinId, action: 'completed' };
    }

    const victim = pickRandom(active);
    const order = await spinRepo.nextEliminationOrder(spin.id, client);
    await spinRepo.eliminateParticipant(spin.id, victim.userId, order, 'ELIMINATED', client);

    await emitElimination(spin, victim.userId, order, 'SPIN', client, pending);

    const remaining = active.length - 1;

    if (remaining === 1) {
      // PDF: "The last remaining participant is the winner." The winner is
      // announced in the same tick as the final elimination, so clients never
      // sit on a one-player wheel waiting five seconds for nothing.
      const survivor = active.find((p) => p.userId !== victim.userId);
      await finishWithWinner(spin, (survivor as { userId: string }).userId, client, pending);
      return { spinId, action: 'completed' };
    }

    const next = computeNextDeadline(
      spin.nextEliminationAt ?? new Date(),
      spin.eliminationIntervalMs,
      cfg.SPIN_MAX_CATCHUP_LAG_MS,
    );
    await spinRepo.setNextDeadline(spin.id, next, client);

    return { spinId, action: 'eliminated' };
  });

  if (roomId) flush(roomId, pending);
  return outcome;
}

/** One scheduler pass: process every spin whose deadline has passed. */
export async function processDueSpins(limit = 20): Promise<TickOutcome[]> {
  const ids = await spinRepo.findDueSpinIds(limit);
  const outcomes: TickOutcome[] = [];

  for (const id of ids) {
    try {
      outcomes.push(await processSpinTick(id));
    } catch (err) {
      // One failing spin must not stop the others, and must not kill the
      // scheduler loop. The deadline is unchanged, so the next tick retries.
      getLogger().error({ err, spinId: id }, 'Spin tick failed');
    }
  }
  return outcomes;
}

/* -------------------------------------------------------------------------- */
/* Departure during a spin (D11)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Forfeit a participant who left the room while a spin is running.
 *
 * Runs inside the caller's transaction so leaving the room and forfeiting the
 * spin commit together. Returns the broadcasts for the caller to flush after
 * commit.
 *
 * Rationale for forfeiting rather than ignoring: "the last remaining
 * participant is the winner" has to stay literally true. A user who walked out
 * cannot win, and a ghost winner would be persisted as the result.
 */
export async function forfeitOnDeparture(
  roomId: string,
  userId: string,
  client: Queryable,
): Promise<Pending[]> {
  const pending: Pending[] = [];

  const spin = await spinRepo.lockActiveSpinForRoom(roomId, client);
  if (!spin) return pending;

  const order = await spinRepo.nextEliminationOrder(spin.id, client);
  const eliminated = await spinRepo.eliminateParticipant(spin.id, userId, order, 'LEFT', client);
  // Not in this spin, or already out -- nothing to forfeit.
  if (!eliminated) return pending;

  await emitElimination(spin, userId, order, 'LEFT', client, pending);

  const active = await spinRepo.lockActiveParticipants(spin.id, client);

  if (active.length === 1) {
    await finishWithWinner(spin, (active[0] as { userId: string }).userId, client, pending);
  } else if (active.length === 0) {
    await finishAborted(spin, 'NO_PARTICIPANTS', client, pending);
  }

  return pending;
}

/** Exposed so the room service can flush what `forfeitOnDeparture` returned. */
export const flushPending = flush;
export type PendingBroadcast = Pending;

/* -------------------------------------------------------------------------- */
/* Shared transitions                                                         */
/* -------------------------------------------------------------------------- */

async function emitElimination(
  spin: Spin,
  userId: string,
  order: number,
  reason: 'SPIN' | 'LEFT',
  client: Queryable,
  pending: Pending[],
): Promise<void> {
  const dto = await buildSpinDTO(spin, client);
  const participant = dto.participants.find((p) => p.userId === userId);

  const row = await spinRepo.appendEvent(
    spin.id,
    spin.roomId,
    'user_eliminated',
    { spinId: spin.id, eliminatedUserId: userId, eliminationOrder: order, reason },
    client,
  );

  pending.push({
    event: SERVER_EVENTS.USER_ELIMINATED,
    payload: {
      ...envelopeFrom(spin.roomId, row),
      spinId: spin.id,
      eliminatedUserId: userId,
      eliminatedDisplayName: participant?.displayName ?? '',
      eliminationOrder: order,
      reason,
      remainingParticipants: dto.remainingParticipants,
      spin: dto,
    },
  });
}

async function finishWithWinner(
  spin: Spin,
  winnerUserId: string,
  client: Queryable,
  pending: Pending[],
): Promise<void> {
  await spinRepo.markWinner(spin.id, winnerUserId, client);
  const completed = await spinRepo.completeSpin(spin.id, winnerUserId, client);

  const dto = await buildSpinDTO(completed, client);
  const winner = dto.participants.find((p) => p.userId === winnerUserId);

  const row = await spinRepo.appendEvent(
    spin.id,
    spin.roomId,
    'winner_announced',
    { spinId: spin.id, winnerUserId },
    client,
  );

  pending.push({
    event: SERVER_EVENTS.WINNER_ANNOUNCED,
    payload: {
      ...envelopeFrom(spin.roomId, row),
      spinId: spin.id,
      winner: { userId: winnerUserId, displayName: winner?.displayName ?? '' },
      spin: dto,
    },
  });

  getLogger().info({ roomId: spin.roomId, spinId: spin.id, winnerUserId }, 'Spin completed');
}

async function finishAborted(
  spin: Spin,
  reason: SpinAbortReason,
  client: Queryable,
  pending: Pending[],
): Promise<void> {
  const aborted = await spinRepo.abortSpin(spin.id, reason, client);
  const dto = await buildSpinDTO(aborted, client);

  const row = await spinRepo.appendEvent(
    spin.id,
    spin.roomId,
    'spin_aborted',
    { spinId: spin.id, reason },
    client,
  );

  pending.push({
    event: SERVER_EVENTS.SPIN_ABORTED,
    payload: { ...envelopeFrom(spin.roomId, row), spinId: spin.id, reason, spin: dto },
  });

  getLogger().warn({ roomId: spin.roomId, spinId: spin.id, reason }, 'Spin aborted');
}
