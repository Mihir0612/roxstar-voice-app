import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';
import { getLogger } from '../logging/index.js';

/**
 * Migration runner (D30).
 *
 * Plain ordered .sql files, applied in one transaction each, tracked in
 * schema_migrations. An advisory lock serialises concurrent runners, which
 * matters because CI runs migrations and a Cloud Run revision may start at the
 * same moment -- without the lock both would try to create the same table.
 */

// Arbitrary but fixed: any two processes must pick the same lock id.
const ADVISORY_LOCK_ID = 8_274_113;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Resolve /database/migrations from either src/ (tsx) or dist/ (compiled). */
export function resolveMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, '../../../database/migrations'), // src/db -> repo root
    path.resolve(here, '../../database/migrations'), // dist/db -> backend/
    path.resolve(process.cwd(), '../database/migrations'),
    path.resolve(process.cwd(), 'database/migrations'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate the migrations directory. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(dir = resolveMigrationsDir()): Promise<MigrationResult> {
  const log = getLogger();
  const pool = getPool();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    if (files.length === 0) {
      log.warn({ dir }, 'No migration files found');
    }

    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }

      const sql = await readFile(path.join(dir, file), 'utf8');

      // One transaction per file: a failing migration leaves no partial schema.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        result.applied.push(file);
        log.info({ migration: file }, 'Applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ err, migration: file }, 'Migration failed');
        throw err;
      }
    }

    return result;
  } finally {
    // Release before returning the client, or the next caller deadlocks.
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/** Readiness check (D32): are all on-disk migrations present in the database? */
export async function pendingMigrationCount(dir = resolveMigrationsDir()): Promise<number> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  const { rows } = await getPool().query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  return files.filter((f) => !done.has(f)).length;
}
