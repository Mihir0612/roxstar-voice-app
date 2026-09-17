import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool.js';
import * as spinService from '../../src/services/spin.service.js';
import { RecordingBroadcaster, setBroadcaster } from '../../src/websocket/broadcaster.js';
import {
  createUser,
  joinRoom,
  makeApp,
  resetDatabase,
  driveSpinsToCompletion,
  seedRoomWithMembers,
  teardown,
  waitFor,
  type TestUser,
} from '../setup/helpers.js';

/**
 * Section C -- spin wheel logic.
 *
 * The scheduler is driven explicitly here (`processDueSpins`) rather than by
 * the background worker, so each assertion observes a known number of ticks
 * instead of racing a timer. Real-time pacing is covered separately in
 * spin-timing-real.test.ts.
 */
describe('spin engine', () => {
  let app: FastifyInstance;
  let broadcaster: RecordingBroadcaster;

  const startSpin = (user: TestUser, roomId: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/spin/start`,
      headers: { ...user.authHeader, ...headers },
      payload: {},
    });

  const getSpin = (user: TestUser, roomId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/spin`,
      headers: user.authHeader,
    });

  /** Advance the spin until it leaves RUNNING. */
  const runToCompletion = () => driveSpinsToCompletion(spinService.processDueSpins);

  beforeAll(async () => {
    await resetDatabase();
    app = await makeApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardown();
  });

  beforeEach(async () => {
    await resetDatabase();
    broadcaster = new RecordingBroadcaster();
    setBroadcaster(broadcaster);
  });

  /* ---------------------------- start validation --------------------------- */

  it('refuses to start with fewer than 3 eligible users', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 1); // owner + 1 = 2

    const res = await startSpin(owner, roomId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_ENOUGH_PARTICIPANTS');
    expect(res.json().error.details).toMatchObject({ found: 2, required: 3 });
  });

  it('starts with exactly 3 eligible users', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);

    const res = await startSpin(owner, roomId);

    expect(res.statusCode).toBe(201);
    expect(res.json().spin).toMatchObject({ status: 'RUNNING', startedBy: owner.userId });
    expect(res.json().spin.participants).toHaveLength(3);
  });

  it('refuses to start with more than 20 eligible users', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 20); // owner + 20 = 21

    const res = await startSpin(owner, roomId);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TOO_MANY_PARTICIPANTS');
    expect(res.json().error.details).toMatchObject({ found: 21, allowed: 20 });
  });

  it('starts with exactly 20 eligible users', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 19);

    const res = await startSpin(owner, roomId);

    expect(res.statusCode).toBe(201);
    expect(res.json().spin.participants).toHaveLength(20);
  });

  it('refuses a spin started by a non-admin member', async () => {
    const { members, roomId } = await seedRoomWithMembers(app, 2);

    const res = await startSpin(members[0] as TestUser, roomId);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_ROOM_ADMIN');
  });

  it('refuses a spin started by a non-member', async () => {
    const { roomId } = await seedRoomWithMembers(app, 2);
    const outsider = await createUser(app, 'Outsider');

    const res = await startSpin(outsider, roomId);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_A_MEMBER');
  });

  it('allows only one active spin per room', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 3);

    expect((await startSpin(owner, roomId)).statusCode).toBe(201);

    const second = await startSpin(owner, roomId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('SPIN_ALREADY_RUNNING');
  });

  /* ------------------------------ elimination ------------------------------ */

  it('eliminates one participant per tick and leaves exactly one winner', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 4); // 5 players

    await startSpin(owner, roomId);
    await runToCompletion();

    const spin = (await getSpin(owner, roomId)).json().spin;

    expect(spin.status).toBe('COMPLETED');
    expect(spin.winner).not.toBeNull();
    expect(spin.eliminatedParticipants).toHaveLength(4);
    expect(spin.remainingParticipants).toHaveLength(1);
    expect(spin.remainingParticipants[0].userId).toBe(spin.winner.userId);

    // Exactly one WINNER across the whole roster -- never zero, never two.
    const winners = spin.participants.filter((p: { status: string }) => p.status === 'WINNER');
    expect(winners).toHaveLength(1);
  });

  it('assigns a dense, unique elimination order', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 4);

    await startSpin(owner, roomId);
    await runToCompletion();

    const spin = (await getSpin(owner, roomId)).json().spin;
    const orders = spin.eliminatedParticipants.map(
      (p: { eliminationOrder: number }) => p.eliminationOrder,
    );

    expect(orders).toEqual([1, 2, 3, 4]);
  });

  it('emits events in the order the PDF requires', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2); // 3 players
    // Drop the user_joined events from seeding so the assertion is about the
    // spin sequence only.
    broadcaster.clear();

    await startSpin(owner, roomId);
    await runToCompletion();

    const sequence = broadcaster.sent.map((s) => s.event);

    expect(sequence[0]).toBe('spin_started');
    expect(sequence.at(-1)).toBe('winner_announced');
    // 3 players -> 2 eliminations -> 1 winner.
    expect(sequence.filter((e) => e === 'user_eliminated')).toHaveLength(2);
    expect(sequence.filter((e) => e === 'winner_announced')).toHaveLength(1);
  });

  it('persists every event with a monotonic sequence and a unique event id', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 3);

    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;
    await runToCompletion();

    const { rows } = await query<{ seq: string; event_id: string; event_type: string }>(
      'SELECT seq::text AS seq, event_id, event_type FROM spin_events WHERE spin_id = $1 ORDER BY seq',
      [spinId],
    );

    expect(rows.map((r) => r.event_type)).toEqual([
      'spin_started',
      'user_eliminated',
      'user_eliminated',
      'user_eliminated',
      'winner_announced',
    ]);

    const seqs = rows.map((r) => Number(r.seq));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(rows.length);
  });

  it('carries eventId and seq on every broadcast so clients can dedupe', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    broadcaster.clear();

    await startSpin(owner, roomId);
    await runToCompletion();

    // `seq` is carried by spin events only -- it comes from the spin_events
    // primary key, which room-membership events do not have.
    for (const sent of broadcaster.sent) {
      const payload = sent.payload as { eventId?: string; occurredAt?: string; seq?: string };
      expect(payload.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(payload.occurredAt).toBeTruthy();
      expect(payload.seq).toBeTruthy();
    }

    const ids = broadcaster.sent.map((s) => (s.payload as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('persists the result so it survives a fresh read', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);

    await startSpin(owner, roomId);
    await runToCompletion();

    const viaApi = (await getSpin(owner, roomId)).json().spin;
    const { rows } = await query<{ status: string; winner_user_id: string; completed_at: Date }>(
      'SELECT status, winner_user_id, completed_at FROM spins WHERE room_id = $1',
      [roomId],
    );

    expect(rows[0]?.status).toBe('COMPLETED');
    expect(rows[0]?.winner_user_id).toBe(viaApi.winner.userId);
    expect(rows[0]?.completed_at).toBeTruthy();
  });

  it('exposes the finished spin through room state as lastSpin', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);

    await startSpin(owner, roomId);
    await runToCompletion();

    const state = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/state`,
        headers: owner.authHeader,
      })
    ).json();

    expect(state.activeSpin).toBeNull();
    expect(state.lastSpin.status).toBe('COMPLETED');
    expect(state.lastSpin.winner).not.toBeNull();
  });

  it('allows a new spin once the previous one has finished', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);

    await startSpin(owner, roomId);
    await runToCompletion();

    const second = await startSpin(owner, roomId);
    expect(second.statusCode).toBe(201);
    expect(second.json().spin.status).toBe('RUNNING');
  });

  /* ------------------------------ mid-spin joins --------------------------- */

  it('does not add a user who joins after the spin started', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);

    await startSpin(owner, roomId);

    const latecomer = await createUser(app, 'Latecomer');
    expect(await joinRoom(app, latecomer, roomId)).toBe(200);

    const spin = (await getSpin(owner, roomId)).json().spin;

    // The roster is frozen at start time: a late joiner is a spectator.
    expect(spin.participants).toHaveLength(3);
    expect(spin.participants.map((p: { userId: string }) => p.userId)).not.toContain(
      latecomer.userId,
    );
  });

  /* -------------------------------- lookups -------------------------------- */

  it('returns 404 when a room has never had a spin', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);

    const res = await getSpin(owner, roomId);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SPIN_NOT_FOUND');
  });

  it('refuses spin state to a non-member', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    await startSpin(owner, roomId);
    const outsider = await createUser(app, 'Outsider');

    const res = await getSpin(outsider, roomId);

    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for a spin in a room that does not exist', async () => {
    const user = await createUser(app, 'Solo');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${randomUUID()}/spin`,
      headers: user.authHeader,
    });

    expect(res.statusCode).toBe(404);
  });

  /* ------------------------------ tick safety ------------------------------ */

  it('is a no-op to tick a spin that is not due', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;

    // Deadline has not passed yet.
    const outcome = await spinService.processSpinTick(spinId);

    expect(outcome.action).toBe('skipped');
    const spin = (await getSpin(owner, roomId)).json().spin;
    expect(spin.eliminatedParticipants).toHaveLength(0);
  });

  it('is a no-op to tick a spin that already completed', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;
    await runToCompletion();

    const before = (await getSpin(owner, roomId)).json().spin;
    const outcome = await spinService.processSpinTick(spinId);
    const after = (await getSpin(owner, roomId)).json().spin;

    expect(outcome.action).toBe('skipped');
    expect(after).toEqual(before);
  });

  it('paces eliminations by the configured interval', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 3);
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;

    // Immediately after start nothing is due.
    expect((await spinService.processSpinTick(spinId)).action).toBe('skipped');

    // After one interval exactly one elimination happens.
    await waitFor(async () => (await spinService.processSpinTick(spinId)).action === 'eliminated', {
      label: 'first elimination',
    });
    const afterFirst = (await getSpin(owner, roomId)).json().spin;
    expect(afterFirst.eliminatedParticipants).toHaveLength(1);

    // And a second tick straight away does nothing -- one per interval.
    expect((await spinService.processSpinTick(spinId)).action).toBe('skipped');
  });
});
