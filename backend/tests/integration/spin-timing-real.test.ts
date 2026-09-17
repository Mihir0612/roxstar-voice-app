/**
 * Real-time pacing, at the PDF's actual 5-second cadence.
 *
 * The rest of the suite compresses the interval so it runs fast. This file
 * deliberately does not: it is the check that "one elimination every 5
 * seconds" holds in wall-clock time, with the real background scheduler
 * running, not a hand-driven loop.
 *
 * Cost: about 11 seconds for a 3-player spin. Worth it -- this is the single
 * timing requirement the assessment states numerically.
 */
process.env.SPIN_ELIMINATION_INTERVAL_MS = '5000';
process.env.SPIN_SCHEDULER_TICK_MS = '250';
process.env.ENABLE_BACKGROUND_WORKERS = 'true';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkers, type Workers } from '../../src/services/workers.js';
import { RecordingBroadcaster, setBroadcaster } from '../../src/websocket/broadcaster.js';
import { makeApp, resetDatabase, seedRoomWithMembers, teardown, waitFor } from '../setup/helpers.js';

describe('spin pacing at the real 5-second interval', () => {
  let app: FastifyInstance;
  let workers: Workers;
  let broadcaster: RecordingBroadcaster;

  beforeAll(async () => {
    await resetDatabase();
    app = await makeApp();
    broadcaster = new RecordingBroadcaster();
    setBroadcaster(broadcaster);
    // The real background scheduler drives this test -- nothing is hand-ticked.
    workers = startWorkers();
  });

  afterAll(async () => {
    workers?.stop();
    await app?.close();
    await teardown();
  });

  it('eliminates one player every five seconds and announces one winner', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2); // 3 players
    broadcaster.clear();

    const t0 = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/spin/start`,
      headers: owner.authHeader,
      payload: {},
    });
    expect(res.statusCode).toBe(201);

    // Nothing may be eliminated before the first interval elapses.
    await new Promise((r) => setTimeout(r, 3000));
    expect(broadcaster.eventsOfType('user_eliminated')).toHaveLength(0);

    await waitFor(() => broadcaster.eventsOfType('winner_announced').length === 1, {
      timeoutMs: 20_000,
      label: 'winner announced',
    });

    const elapsed = Date.now() - t0;
    const eliminations = broadcaster.eventsOfType('user_eliminated');

    expect(eliminations).toHaveLength(2);

    // 3 players -> 2 eliminations -> the second one completes the spin, so the
    // whole thing takes ~10s. Bounds allow for scheduler granularity.
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(14_000);

    const spin = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/spin`,
        headers: owner.authHeader,
      })
    ).json().spin;

    expect(spin.status).toBe('COMPLETED');
    expect(spin.eliminationIntervalMs).toBe(5000);
    expect(spin.remainingParticipants).toHaveLength(1);
  });
});
