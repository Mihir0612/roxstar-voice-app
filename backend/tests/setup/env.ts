/**
 * Vitest setup file. Runs before every test file's imports resolve, so config
 * is already valid the first time a module calls `getConfig()`.
 *
 * Timings are compressed so the suite finishes in seconds rather than minutes.
 * The PDF's real 5-second cadence is asserted separately and at full speed in
 * tests/integration/spin-timing-real.test.ts, and the default itself is
 * asserted in tests/unit/config.test.ts -- so compressing here cannot hide a
 * regression in the requirement.
 */

process.env.NODE_ENV = 'test';
// A SEPARATE database from the one docker-compose serves.
//
// The compose backend runs a scheduler that polls for due spins across its
// whole database every 500ms. Pointed at the same database, it silently claims
// and completes the suite's spins -- the tests then see 'skipped' and never
// observe their own events. Sharing a database with a running service makes a
// test suite non-deterministic, whichever service it is.
process.env.DATABASE_URL ??= 'postgres://roxstar:roxstar_local_dev@localhost:5432/roxstar_test';
process.env.AUTH_SECRET ??= 'test-secret-value-at-least-16-chars';
process.env.LOG_LEVEL = 'silent';

// Plain assignment, NOT `??=`.
//
// Setup files run before each test file's own module code, but `process.env` is
// shared across every file in a worker process. With `??=`, a file that
// overrides a timing (spin-timing-real.test.ts, rate-limit.test.ts) would leak
// that value into every file that ran after it in the same worker. Re-applying
// the baseline here means each file starts from the same clock, and a file's
// own top-level override still wins for that file.
process.env.SPIN_ELIMINATION_INTERVAL_MS = '400';
process.env.SPIN_SCHEDULER_TICK_MS = '50';
process.env.SPIN_MAX_CATCHUP_LAG_MS = '1200';

process.env.PRESENCE_GRACE_MS = '400';
process.env.PRESENCE_SWEEP_TICK_MS = '50';

// Rate limits are lifted by default so a suite that legitimately starts a
// dozen spins is not throttled mid-file. They are asserted for real, at
// production-like values, in tests/integration/rate-limit.test.ts.
process.env.RATE_LIMIT_SPIN_START_MAX = '100000';
process.env.RATE_LIMIT_MAX = '100000';

// Tests drive the scheduler explicitly unless a suite opts back in, so a
// background tick cannot race an assertion.
process.env.ENABLE_BACKGROUND_WORKERS = 'false';
