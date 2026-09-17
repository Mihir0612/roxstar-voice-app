import { query, type Queryable } from '../db/pool.js';
import type { User } from '../models/types.js';

interface UserRow {
  id: string;
  display_name: string;
  device_id: string;
  created_at: Date;
}

const map = (r: UserRow): User => ({
  id: r.id,
  displayName: r.display_name,
  deviceId: r.device_id,
  createdAt: r.created_at,
});

/**
 * Upsert the device-bound identity (D8).
 *
 * ON CONFLICT rather than select-then-insert: two sessions opened from the
 * same device at the same moment would otherwise race and one would fail on
 * the unique constraint.
 */
export async function upsertByDevice(
  displayName: string,
  deviceId: string,
  db: Queryable = { query },
): Promise<User> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (display_name, device_id)
          VALUES ($1, $2)
     ON CONFLICT (device_id)
       DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, display_name, device_id, created_at`,
    [displayName, deviceId],
  );
  return map(rows[0] as UserRow);
}

export async function findById(id: string, db: Queryable = { query }): Promise<User | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT id, display_name, device_id, created_at FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}
