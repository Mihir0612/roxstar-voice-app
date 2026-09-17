import { query, type Queryable } from '../db/pool.js';
import type {
  ParticipantStatus,
  Spin,
  SpinAbortReason,
  SpinEventRow,
  SpinEventType,
  SpinParticipant,
  SpinParticipantWithUser,
} from '../models/types.js';

interface SpinRow {
  id: string;
  room_id: string;
  status: Spin['status'];
  started_by: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  winner_user_id: string | null;
  next_elimination_at: Date | null;
  elimination_interval_ms: number;
  abort_reason: SpinAbortReason | null;
  created_at: Date;
}

interface ParticipantRow {
  id: string;
  spin_id: string;
  user_id: string;
  eligible: boolean;
  elimination_order: number | null;
  eliminated_at: Date | null;
  final_status: ParticipantStatus;
}

interface ParticipantWithUserRow extends ParticipantRow {
  display_name: string;
}

const SPIN_COLS =
  'id, room_id, status, started_by, started_at, completed_at, winner_user_id, ' +
  'next_elimination_at, elimination_interval_ms, abort_reason, created_at';

const PARTICIPANT_COLS =
  'id, spin_id, user_id, eligible, elimination_order, eliminated_at, final_status';

const mapSpin = (r: SpinRow): Spin => ({
  id: r.id,
  roomId: r.room_id,
  status: r.status,
  startedBy: r.started_by,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  winnerUserId: r.winner_user_id,
  nextEliminationAt: r.next_elimination_at,
  eliminationIntervalMs: r.elimination_interval_ms,
  abortReason: r.abort_reason,
  createdAt: r.created_at,
});

const mapParticipant = (r: ParticipantRow): SpinParticipant => ({
  id: r.id,
  spinId: r.spin_id,
  userId: r.user_id,
  eligible: r.eligible,
  eliminationOrder: r.elimination_order,
  eliminatedAt: r.eliminated_at,
  finalStatus: r.final_status,
});

const mapParticipantWithUser = (r: ParticipantWithUserRow): SpinParticipantWithUser => ({
  ...mapParticipant(r),
  displayName: r.display_name,
});

/* --------------------------------- spins ---------------------------------- */

/**
 * Create the spin already in RUNNING state.
 *
 * There is no WAITING row written first: the partial unique index
 * `spins_one_active_per_room_idx` only covers RUNNING, so inserting directly as
 * RUNNING is what makes a concurrent second start fail at the database instead
 * of racing in application code.
 */
export async function createRunningSpin(
  roomId: string,
  startedBy: string,
  intervalMs: number,
  firstDeadline: Date,
  db: Queryable,
): Promise<Spin> {
  const { rows } = await db.query<SpinRow>(
    `INSERT INTO spins (room_id, status, started_by, started_at, next_elimination_at, elimination_interval_ms)
          VALUES ($1, 'RUNNING', $2, now(), $3, $4)
       RETURNING ${SPIN_COLS}`,
    [roomId, startedBy, firstDeadline, intervalMs],
  );
  return mapSpin(rows[0] as SpinRow);
}

export async function addParticipants(
  spinId: string,
  userIds: readonly string[],
  db: Queryable,
): Promise<void> {
  if (userIds.length === 0) return;
  // One statement with unnest instead of N inserts: the roster must land
  // atomically with the spin row.
  await db.query(
    `INSERT INTO spin_participants (spin_id, user_id, eligible, final_status)
     SELECT $1, u, TRUE, 'ACTIVE' FROM unnest($2::uuid[]) AS u`,
    [spinId, userIds],
  );
}

export async function findActiveSpin(
  roomId: string,
  db: Queryable = { query },
): Promise<Spin | null> {
  const { rows } = await db.query<SpinRow>(
    `SELECT ${SPIN_COLS} FROM spins WHERE room_id = $1 AND status = 'RUNNING'`,
    [roomId],
  );
  return rows[0] ? mapSpin(rows[0]) : null;
}

export async function findLatestSpin(
  roomId: string,
  db: Queryable = { query },
): Promise<Spin | null> {
  const { rows } = await db.query<SpinRow>(
    `SELECT ${SPIN_COLS} FROM spins WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [roomId],
  );
  return rows[0] ? mapSpin(rows[0]) : null;
}

export async function findSpinById(id: string, db: Queryable = { query }): Promise<Spin | null> {
  const { rows } = await db.query<SpinRow>(`SELECT ${SPIN_COLS} FROM spins WHERE id = $1`, [id]);
  return rows[0] ? mapSpin(rows[0]) : null;
}

/** Row lock used by every elimination tick, so two ticks cannot interleave. */
export async function lockSpin(id: string, db: Queryable): Promise<Spin | null> {
  const { rows } = await db.query<SpinRow>(
    `SELECT ${SPIN_COLS} FROM spins WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? mapSpin(rows[0]) : null;
}

/** Lock the room's running spin, if any. Used by the leave/forfeit path. */
export async function lockActiveSpinForRoom(roomId: string, db: Queryable): Promise<Spin | null> {
  const { rows } = await db.query<SpinRow>(
    `SELECT ${SPIN_COLS} FROM spins WHERE room_id = $1 AND status = 'RUNNING' FOR UPDATE`,
    [roomId],
  );
  return rows[0] ? mapSpin(rows[0]) : null;
}

/**
 * Spins whose deadline has passed (D14). Unlocked, cheap read used to pick
 * candidates; each one is then claimed individually so a single slow spin
 * cannot hold a transaction open across the whole batch.
 *
 * This query is also the entire server-restart recovery path -- a fresh
 * process finds RUNNING spins here on its first tick, with no special-case
 * recovery code that could itself be buggy.
 */
export async function findDueSpinIds(limit: number, db: Queryable = { query }): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id
       FROM spins
      WHERE status = 'RUNNING'
        AND next_elimination_at IS NOT NULL
        AND next_elimination_at <= now()
      ORDER BY next_elimination_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Claim one due spin for processing.
 *
 * SKIP LOCKED is what makes the scheduler safe: a tick that is still processing
 * a spin is skipped by the next tick rather than blocking it, and a second
 * instance can never claim a spin the first one already holds. The status and
 * deadline are re-checked inside the lock, so a spin that completed between the
 * candidate read and the claim is simply not returned.
 */
export async function claimDueSpin(id: string, db: Queryable): Promise<Spin | null> {
  const { rows } = await db.query<SpinRow>(
    `SELECT ${SPIN_COLS}
       FROM spins
      WHERE id = $1
        AND status = 'RUNNING'
        AND next_elimination_at IS NOT NULL
        AND next_elimination_at <= now()
        FOR UPDATE SKIP LOCKED`,
    [id],
  );
  return rows[0] ? mapSpin(rows[0]) : null;
}

export async function setNextDeadline(
  spinId: string,
  deadline: Date,
  db: Queryable,
): Promise<void> {
  await db.query('UPDATE spins SET next_elimination_at = $2 WHERE id = $1', [spinId, deadline]);
}

export async function completeSpin(
  spinId: string,
  winnerUserId: string,
  db: Queryable,
): Promise<Spin> {
  const { rows } = await db.query<SpinRow>(
    `UPDATE spins
        SET status              = 'COMPLETED',
            winner_user_id      = $2,
            completed_at        = now(),
            next_elimination_at = NULL
      WHERE id = $1
      RETURNING ${SPIN_COLS}`,
    [spinId, winnerUserId],
  );
  return mapSpin(rows[0] as SpinRow);
}

export async function abortSpin(
  spinId: string,
  reason: SpinAbortReason,
  db: Queryable,
): Promise<Spin> {
  const { rows } = await db.query<SpinRow>(
    `UPDATE spins
        SET status              = 'ABORTED',
            abort_reason        = $2,
            completed_at        = now(),
            next_elimination_at = NULL
      WHERE id = $1
      RETURNING ${SPIN_COLS}`,
    [spinId, reason],
  );
  return mapSpin(rows[0] as SpinRow);
}

/* ----------------------------- participants ------------------------------- */

export async function listParticipants(
  spinId: string,
  db: Queryable = { query },
): Promise<SpinParticipantWithUser[]> {
  const { rows } = await db.query<ParticipantWithUserRow>(
    `SELECT ${PARTICIPANT_COLS.split(', ').map((c) => `p.${c}`).join(', ')}, u.display_name
       FROM spin_participants p
       JOIN users u ON u.id = p.user_id
      WHERE p.spin_id = $1
      ORDER BY p.elimination_order NULLS LAST, u.display_name ASC`,
    [spinId],
  );
  return rows.map(mapParticipantWithUser);
}

/** Still-in-play participants, locked for the duration of the tick. */
export async function lockActiveParticipants(
  spinId: string,
  db: Queryable,
): Promise<SpinParticipant[]> {
  const { rows } = await db.query<ParticipantRow>(
    `SELECT ${PARTICIPANT_COLS}
       FROM spin_participants
      WHERE spin_id = $1 AND final_status = 'ACTIVE'
      ORDER BY id
        FOR UPDATE`,
    [spinId],
  );
  return rows.map(mapParticipant);
}

/**
 * Next elimination slot. Derived from the table rather than kept in memory so
 * that a forfeit (D11) and a scheduled elimination can interleave without
 * colliding on `spin_participants_order_key`.
 */
export async function nextEliminationOrder(spinId: string, db: Queryable): Promise<number> {
  const { rows } = await db.query<{ next: number }>(
    `SELECT COALESCE(max(elimination_order), 0) + 1 AS next
       FROM spin_participants
      WHERE spin_id = $1`,
    [spinId],
  );
  return Number(rows[0]?.next ?? 1);
}

export async function eliminateParticipant(
  spinId: string,
  userId: string,
  order: number,
  status: Extract<ParticipantStatus, 'ELIMINATED' | 'LEFT'>,
  db: Queryable,
): Promise<SpinParticipant | null> {
  const { rows } = await db.query<ParticipantRow>(
    `UPDATE spin_participants
        SET final_status      = $4,
            elimination_order = $3,
            eliminated_at     = now()
      WHERE spin_id = $1 AND user_id = $2 AND final_status = 'ACTIVE'
      RETURNING ${PARTICIPANT_COLS}`,
    [spinId, userId, order, status],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}

export async function markWinner(
  spinId: string,
  userId: string,
  db: Queryable,
): Promise<SpinParticipant | null> {
  const { rows } = await db.query<ParticipantRow>(
    `UPDATE spin_participants
        SET final_status = 'WINNER'
      WHERE spin_id = $1 AND user_id = $2 AND final_status = 'ACTIVE'
      RETURNING ${PARTICIPANT_COLS}`,
    [spinId, userId],
  );
  return rows[0] ? mapParticipant(rows[0]) : null;
}

/* -------------------------------- events ---------------------------------- */

/**
 * Append to the audit log.
 *
 * Called inside the same transaction as the state change and always before the
 * broadcast, so there can never be an event clients saw that the database does
 * not record.
 */
export async function appendEvent(
  spinId: string,
  roomId: string,
  eventType: SpinEventType,
  payload: Record<string, unknown>,
  db: Queryable,
): Promise<{ seq: string; eventId: string; createdAt: Date }> {
  const { rows } = await db.query<{ seq: string; event_id: string; created_at: Date }>(
    `INSERT INTO spin_events (spin_id, room_id, event_type, payload)
          VALUES ($1, $2, $3, $4::jsonb)
       RETURNING seq::text AS seq, event_id, created_at`,
    [spinId, roomId, eventType, JSON.stringify(payload)],
  );
  const row = rows[0] as { seq: string; event_id: string; created_at: Date };
  return { seq: row.seq, eventId: row.event_id, createdAt: row.created_at };
}

export async function listEvents(
  spinId: string,
  db: Queryable = { query },
): Promise<SpinEventRow[]> {
  const { rows } = await db.query<{
    seq: string;
    event_id: string;
    spin_id: string;
    room_id: string;
    event_type: SpinEventType;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT seq::text AS seq, event_id, spin_id, room_id, event_type, payload, created_at
       FROM spin_events
      WHERE spin_id = $1
      ORDER BY seq ASC`,
    [spinId],
  );
  return rows.map((r) => ({
    seq: r.seq,
    eventId: r.event_id,
    spinId: r.spin_id,
    roomId: r.room_id,
    eventType: r.event_type,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}
