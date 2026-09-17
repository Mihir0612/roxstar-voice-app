/**
 * Rate limiting (D22) at production-like values.
 *
 * The rest of the suite lifts these limits so that a test starting a dozen
 * spins is not throttled. This file puts them back so the control is actually
 * verified rather than merely configured.
 */
process.env.RATE_LIMIT_SPIN_START_MAX = '2';
process.env.RATE_LIMIT_MAX = '10000';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingBroadcaster, setBroadcaster } from '../../src/websocket/broadcaster.js';
import { makeApp, resetDatabase, seedRoomWithMembers, teardown } from '../setup/helpers.js';

describe('rate limiting', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await resetDatabase();
    app = await makeApp();
    setBroadcaster(new RecordingBroadcaster());
  });

  afterAll(async () => {
    await app?.close();
    await teardown();
  });

  it('throttles repeated spin-start attempts with a safe error', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);

    const statuses: number[] = [];
    let limited: Record<string, unknown> | undefined;

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${roomId}/spin/start`,
        headers: owner.authHeader,
        payload: {},
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) limited ??= res.json();
    }

    // Limit is 2/min: the first two are served (201 then 409 for the duplicate
    // spin), and everything after that is rejected before it reaches a handler.
    expect(statuses.slice(0, 2)).toEqual([201, 409]);
    expect(statuses.slice(2)).toEqual([429, 429, 429]);

    expect(limited).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    // The rejection must not describe the internal limiter.
    expect(JSON.stringify(limited)).not.toMatch(/redis|bucket|nonce/i);
  });

  it('never rate-limits the health endpoint', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      statuses.push((await app.inject({ method: 'GET', url: '/health' })).statusCode);
    }
    // A throttled liveness probe would make the orchestrator kill a healthy
    // container.
    expect(new Set(statuses)).toEqual(new Set([200]));
  });
});
