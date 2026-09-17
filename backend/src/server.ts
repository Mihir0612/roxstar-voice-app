import { buildApp } from './app.js';
import { getConfig } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { getLogger } from './logging/index.js';
import { startWorkers, type Workers } from './services/workers.js';
import { resetBroadcaster } from './websocket/broadcaster.js';
import { createSocketServer } from './websocket/server.js';

/**
 * Process entrypoint.
 *
 * Order matters: config is validated first so a bad deploy fails before it can
 * accept a request, migrations run before traffic is served, and the socket
 * server is attached to the same HTTP listener Fastify uses -- Cloud Run gives
 * the container exactly one port.
 */

async function main(): Promise<void> {
  const cfg = getConfig();
  const log = getLogger();

  // Applied at boot as well as in CI: a Cloud Run revision must not start
  // serving against a schema older than the code it is running.
  const { applied } = await runMigrations();
  if (applied.length > 0) log.info({ applied }, 'Applied pending migrations at startup');

  const app = await buildApp();
  await app.listen({ port: cfg.PORT, host: cfg.HOST });

  const io = createSocketServer(app.server);

  let workers: Workers | undefined;
  if (cfg.ENABLE_BACKGROUND_WORKERS) workers = startWorkers();

  log.info(
    { port: cfg.PORT, host: cfg.HOST, env: cfg.NODE_ENV, workers: Boolean(workers) },
    'Roxstar backend listening',
  );

  /* ---------------------------- graceful shutdown ------------------------- */

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down');

    // Stop taking new work first, then drain. An in-flight elimination is safe
    // either way: it is transactional, and an unfinished spin is resumed from
    // the database by whichever instance comes up next (D14).
    workers?.stop();

    const timeout = setTimeout(() => {
      log.error('Graceful shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    timeout.unref();

    try {
      await io.close();
      await app.close();
      resetBroadcaster();
      await closePool();
      clearTimeout(timeout);
      log.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    // Unknown state: log and let the orchestrator restart us cleanly.
    log.fatal({ err }, 'Uncaught exception; exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  // The logger may not exist yet if config validation is what failed.
  console.error('Failed to start Roxstar backend:', err instanceof Error ? err.message : err);
  process.exit(1);
});
