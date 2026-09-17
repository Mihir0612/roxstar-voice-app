import { query, type Queryable } from '../db/pool.js';
import type { MemberRole, Room, RoomMember, RoomMemberWithUser } from '../models/types.js';

interface RoomRow {
  id: string;
  code: string;
  name: string;
  owner_id: string;
  status: 'OPEN' | 'CLOSED';
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  id: string;
  room_id: string;
  user_id: string;
  role: MemberRole;
  membership_status: 'ACTIVE' | 'LEFT';
  connection_status: 'CONNECTED' | 'DISCONNECTED';
  joined_at: Date;
  left_at: Date | null;
  last_seen_at: Date;
  disconnected_at: Date | null;
}

interface MemberWithUserRow extends MemberRow {
  display_name: string;
}

const mapRoom = (r: RoomRow): Room => ({
  id: r.id,
  code: r.code,
  name: r.name,
  ownerId: r.owner_id,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMember = (r: MemberRow): RoomMember => ({
  id: r.id,
  roomId: r.room_id,
  userId: r.user_id,
  role: r.role,
  membershipStatus: r.membership_status,
  connectionStatus: r.connection_status,
  joinedAt: r.joined_at,
  leftAt: r.left_at,
  lastSeenAt: r.last_seen_at,
  disconnectedAt: r.disconnected_at,
});

const mapMemberWithUser = (r: MemberWithUserRow): RoomMemberWithUser => ({
  ...mapMember(r),
  displayName: r.display_name,
});

const ROOM_COLS = 'id, code, name, owner_id, status, created_at, updated_at';
const MEMBER_COLS =
  'id, room_id, user_id, role, membership_status, connection_status, joined_at, left_at, last_seen_at, disconnected_at';

/* ------------------------------- rooms ----------------------------------- */

export async function createRoom(
  name: string,
  code: string,
  ownerId: string,
  db: Queryable = { query },
): Promise<Room> {
  const { rows } = await db.query<RoomRow>(
    `INSERT INTO rooms (name, code, owner_id) VALUES ($1, $2, $3) RETURNING ${ROOM_COLS}`,
    [name, code, ownerId],
  );
  return mapRoom(rows[0] as RoomRow);
}

export async function findRoomById(id: string, db: Queryable = { query }): Promise<Room | null> {
  const { rows } = await db.query<RoomRow>(`SELECT ${ROOM_COLS} FROM rooms WHERE id = $1`, [id]);
  return rows[0] ? mapRoom(rows[0]) : null;
}

export async function findRoomByCode(code: string, db: Queryable = { query }): Promise<Room | null> {
  const { rows } = await db.query<RoomRow>(
    `SELECT ${ROOM_COLS} FROM rooms WHERE code = $1`,
    [code.toUpperCase()],
  );
  return rows[0] ? mapRoom(rows[0]) : null;
}

/**
 * Take a row lock on the room.
 *
 * This is the serialisation point for "start a spin": two concurrent starts
 * both try to lock the same room row, so the second one waits and then sees
 * the spin the first one created (concurrency case 2).
 */
export async function lockRoom(id: string, db: Queryable): Promise<Room | null> {
  const { rows } = await db.query<RoomRow>(
    `SELECT ${ROOM_COLS} FROM rooms WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? mapRoom(rows[0]) : null;
}

/* ------------------------------ membership -------------------------------- */

/**
 * Join, or re-join after leaving.
 *
 * The unique (room_id, user_id) constraint plus ON CONFLICT makes a duplicate
 * join idempotent at the storage layer (concurrency case 1), and lets a user
 * who left rejoin without creating a second membership row.
 *
 * `role` is only applied on first insert -- re-joining never escalates a
 * MEMBER to OWNER (privilege-escalation guard).
 */
export async function upsertMember(
  roomId: string,
  userId: string,
  role: MemberRole,
  db: Queryable = { query },
): Promise<RoomMember> {
  const { rows } = await db.query<MemberRow>(
    `INSERT INTO room_members (room_id, user_id, role, membership_status, connection_status, last_seen_at)
          VALUES ($1, $2, $3, 'ACTIVE', 'DISCONNECTED', now())
     ON CONFLICT (room_id, user_id) DO UPDATE
        SET membership_status = 'ACTIVE',
            left_at           = NULL,
            last_seen_at      = now()
      RETURNING ${MEMBER_COLS}`,
    [roomId, userId, role],
  );
  return mapMember(rows[0] as MemberRow);
}

export async function findMember(
  roomId: string,
  userId: string,
  db: Queryable = { query },
): Promise<RoomMember | null> {
  const { rows } = await db.query<MemberRow>(
    `SELECT ${MEMBER_COLS} FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
  return rows[0] ? mapMember(rows[0]) : null;
}

export async function findActiveMember(
  roomId: string,
  userId: string,
  db: Queryable = { query },
): Promise<RoomMember | null> {
  const member = await findMember(roomId, userId, db);
  return member && member.membershipStatus === 'ACTIVE' ? member : null;
}

export async function listActiveMembers(
  roomId: string,
  db: Queryable = { query },
): Promise<RoomMemberWithUser[]> {
  const { rows } = await db.query<MemberWithUserRow>(
    `SELECT ${MEMBER_COLS.split(', ').map((c) => `m.${c}`).join(', ')}, u.display_name
       FROM room_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1 AND m.membership_status = 'ACTIVE'
      ORDER BY m.joined_at ASC`,
    [roomId],
  );
  return rows.map(mapMemberWithUser);
}

/** Explicit leave: immediate and permanent, no grace period (D13). */
export async function markLeft(
  roomId: string,
  userId: string,
  db: Queryable = { query },
): Promise<RoomMember | null> {
  const { rows } = await db.query<MemberRow>(
    `UPDATE room_members
        SET membership_status = 'LEFT',
            connection_status = 'DISCONNECTED',
            left_at           = now(),
            disconnected_at   = NULL
      WHERE room_id = $1 AND user_id = $2 AND membership_status = 'ACTIVE'
      RETURNING ${MEMBER_COLS}`,
    [roomId, userId],
  );
  return rows[0] ? mapMember(rows[0]) : null;
}

export async function markConnected(
  roomId: string,
  userId: string,
  db: Queryable = { query },
): Promise<void> {
  await db.query(
    `UPDATE room_members
        SET connection_status = 'CONNECTED',
            disconnected_at   = NULL,
            last_seen_at      = now()
      WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
}

/**
 * Socket dropped. This starts the grace period (D13) -- it does NOT remove the
 * member, so a tunnel or a screen lock cannot forfeit a player mid-spin.
 */
export async function markDisconnected(
  roomId: string,
  userId: string,
  db: Queryable = { query },
): Promise<void> {
  await db.query(
    `UPDATE room_members
        SET connection_status = 'DISCONNECTED',
            disconnected_at   = now(),
            last_seen_at      = now()
      WHERE room_id = $1 AND user_id = $2 AND membership_status = 'ACTIVE'`,
    [roomId, userId],
  );
}

/**
 * Members whose grace period has expired. Claimed with SKIP LOCKED so two
 * sweeper ticks (or two instances) cannot expire the same member twice.
 */
export async function claimExpiredDisconnects(
  graceMs: number,
  limit: number,
  db: Queryable,
): Promise<RoomMember[]> {
  const { rows } = await db.query<MemberRow>(
    `SELECT ${MEMBER_COLS}
       FROM room_members
      WHERE membership_status = 'ACTIVE'
        AND connection_status = 'DISCONNECTED'
        AND disconnected_at IS NOT NULL
        AND disconnected_at < now() - ($1::bigint * INTERVAL '1 millisecond')
      ORDER BY disconnected_at ASC
      LIMIT $2
        FOR UPDATE SKIP LOCKED`,
    [graceMs, limit],
  );
  return rows.map(mapMember);
}

export async function countActiveMembers(
  roomId: string,
  db: Queryable = { query },
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM room_members
      WHERE room_id = $1 AND membership_status = 'ACTIVE'`,
    [roomId],
  );
  return Number(rows[0]?.count ?? 0);
}
