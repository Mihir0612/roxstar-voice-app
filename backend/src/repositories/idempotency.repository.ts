import { createHash } from 'node:crypto';
import { query, type Queryable } from '../db/pool.js';

/**
 * Idempotency store (D18).
 *
 * Scoped by (key, user_id, endpoint): one client's key can neither collide with
 * nor read back another client's response, which would otherwise be an
 * information leak dressed up as a convenience feature.
 */

export interface StoredResponse {
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export async function findStored(
  key: string,
  userId: string,
  endpoint: string,
  db: Queryable = { query },
): Promise<StoredResponse | null> {
  const { rows } = await db.query<{
    request_hash: string;
    response_status: number;
    response_body: unknown;
  }>(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_keys
      WHERE key = $1 AND user_id = $2 AND endpoint = $3`,
    [key, userId, endpoint],
  );
  const row = rows[0];
  return row
    ? {
        requestHash: row.request_hash,
        responseStatus: row.response_status,
        responseBody: row.response_body,
      }
    : null;
}

/**
 * Store the outcome. DO NOTHING on conflict: if two identical requests raced,
 * the first one to commit owns the record and the second replays it.
 */
export async function store(
  key: string,
  userId: string,
  endpoint: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown,
  db: Queryable = { query },
): Promise<void> {
  await db.query(
    `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_status, response_body)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (key, user_id, endpoint) DO NOTHING`,
    [key, userId, endpoint, requestHash, responseStatus, JSON.stringify(responseBody ?? null)],
  );
}

/** TTL sweep (D18): 24 hours. */
export async function purgeExpired(olderThanMs: number, db: Queryable = { query }): Promise<number> {
  const res = await db.query(
    `DELETE FROM idempotency_keys
      WHERE created_at < now() - ($1::bigint * INTERVAL '1 millisecond')`,
    [olderThanMs],
  );
  return res.rowCount ?? 0;
}
