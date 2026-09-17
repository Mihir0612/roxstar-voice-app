import pg from 'pg';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/index.js';

const { Pool } = pg;

/**
 * Anything that can run a statement: the pool, a pooled client inside a
 * transaction, or a test double. Repositories take this so the same function
 * works standalone and inside a transaction without a second code path.
 */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

/**
 * Postgres access (D4).
 *
 * Deliberately no ORM: the spin engine depends on explicit `FOR UPDATE` and
 * `FOR UPDATE SKIP LOCKED` semantics, which ORMs either hide or emit
 * differently across versions. Every statement is parameterized, which is also
 * what satisfies the injection-protection requirement.
 */

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = getConfig();
    pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.DATABASE_POOL_MAX,
      // Cloud SQL requires TLS; a local docker-compose Postgres does not.
      ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // A single stuck statement must not hold a pool slot forever.
      statement_timeout: 15_000,
    });

    pool.on('error', (err) => {
      // An idle client erroring is not fatal -- pg replaces it -- but it is
      // the first sign of a database going away, so it must be visible.
      getLogger().error({ err }, 'Idle Postgres client error');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Run a statement on the shared pool. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Every multi-row state change in this service goes through here. The spin
 * engine relies on it: an elimination must update the participant, write the
 * audit event and advance the deadline atomically, or a crash mid-tick would
 * leave a spin that can never complete.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      getLogger().error({ err: rollbackErr }, 'Transaction rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** True when the error is a unique-constraint violation on the given index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  if (!e || e.code !== '23505') return false;
  return constraint ? e.constraint === constraint : true;
}

export type { pg };
