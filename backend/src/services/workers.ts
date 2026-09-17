import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/index.js';
import * as idempotencyRepo from '../repositories/idempotency.repository.js';
import { sweepExpiredDisconnects } from './presence.service.js';
import { processDueSpins } from './spin.service.js';

/**
 * Background workers.
 *
 * None of these owns any state. The spin scheduler in particular is only a
 * poller: it asks the database which spins are due and processes them. That is
 * what makes a restart mid-spin a non-event (D14) -- the replacement process
 * finds the same rows on its first tick.
 *
 * Each loop is self-rescheduling with setTimeout rather than setInterval, so a
 * slow pass cannot stack up behind itself.
 */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export interface Workers {
  stop: () => void;
}

export function startWorkers(): Workers {
  const cfg = getConfig();
  const log = getLogger();

  let stopped = false;
  const timers: NodeJS.Timeout[] = [];

  const loop = (name: string, intervalMs: number, task: () => Promise<unknown>): void => {
    const run = async (): Promise<void> => {
      if (stopped) return;
      try {
        await task();
      } catch (err) {
        // A worker must never die on a transient database error, or spins
        // would silently stop advancing until the next deploy.
        log.error({ err, worker: name }, 'Background worker iteration failed');
      }
      if (!stopped) {
        const t = setTimeout(run, intervalMs);
        t.unref();
        timers.push(t);
      }
    };
    const t = setTimeout(run, intervalMs);
    t.unref();
    timers.push(t);
  };

  loop('spin-scheduler', cfg.SPIN_SCHEDULER_TICK_MS, () => processDueSpins());
  loop('presence-sweeper', cfg.PRESENCE_SWEEP_TICK_MS, () => sweepExpiredDisconnects());
  loop('idempotency-purge', IDEMPOTENCY_PURGE_INTERVAL_MS, async () => {
    const purged = await idempotencyRepo.purgeExpired(IDEMPOTENCY_TTL_MS);
    if (purged > 0) log.info({ purged }, 'Purged expired idempotency keys');
  });

  log.info(
    {
      spinTickMs: cfg.SPIN_SCHEDULER_TICK_MS,
      presenceTickMs: cfg.PRESENCE_SWEEP_TICK_MS,
      graceMs: cfg.PRESENCE_GRACE_MS,
    },
    'Background workers started',
  );

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
