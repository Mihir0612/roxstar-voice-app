/**
 * CLI entrypoint: `npm run migrate`.
 * Used by docker-compose, by CI before the test run, and by the deploy job.
 */
import { runMigrations } from './migrate.js';
import { closePool } from './pool.js';

try {
  const { applied, skipped } = await runMigrations();
  console.log(
    `Migrations complete: ${applied.length} applied, ${skipped.length} already present.`,
  );
  for (const name of applied) console.log(`  + ${name}`);
  await closePool();
  process.exit(0);
} catch (err) {
  console.error('Migration run failed:', err instanceof Error ? err.message : err);
  await closePool().catch(() => undefined);
  process.exit(1);
}
