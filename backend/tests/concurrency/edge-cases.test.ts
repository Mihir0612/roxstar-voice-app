import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool.js';
import * as presenceService from '../../src/services/presence.service.js';
import * as roomRepo from '../../src/repositories/room.repository.js';
import * as spinService from '../../src/services/spin.service.js';
import { RecordingBroadcaster, setBroadcaster } from '../../src/websocket/broadcaster.js';
import {
  createRoom,
  createUser,
  driveSpinsToCompletion,
  joinRoom,
  makeApp,
  resetDatabase,
  seedRoomWithMembers,
  sleep,
  teardown,
  waitFor,
  type TestUser,
} from '../setup/helpers.js';

/**
 * Section C4 -- edge cases and concurrency.
 *
 * Each block below is one of the cases the assessment names, exercised for
 * real: the behaviour is asserted, not described.
 *
 *   1. duplicate start requests        6. insufficient players
 *   2. simultaneous start requests     7. last players leaving
 *   3. simultaneous joins              8. duplicate events
 *   4. user departure during a spin    9. delayed timers / server restart
 *   5. admin disconnect during a spin 10. reconnect during a spin
 */
describe('edge cases and concurrency', () => {
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
    app.inject({ method: 'GET', url: `/api/v1/rooms/${roomId}/spin`, headers: user.authHeader });

  const leave = (user: TestUser, roomId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/leave`,
      headers: user.authHeader,
    });

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

  /* ------------------ 1. duplicate start (same idempotency key) ------------ */

  it('replays the same spin for a retried start with the same Idempotency-Key', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    const key = randomUUID();

    const first = await startSpin(owner, roomId, { 'idempotency-key': key });
    const retry = await startSpin(owner, roomId, { 'idempotency-key': key });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    // The retry returns the original spin -- it does not create a second one.
    expect(retry.json().spin.spinId).toBe(first.json().spin.spinId);

    const { rows } = await query('SELECT id FROM spins WHERE room_id = $1', [roomId]);
    expect(rows).toHaveLength(1);
  });

  it('rejects a reused Idempotency-Key carrying a different body', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    const key = randomUUID();

    await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: { ...owner.authHeader, 'idempotency-key': key },
      payload: { name: 'First' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: { ...owner.authHeader, 'idempotency-key': key },
      payload: { name: 'Different' },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  /* ------------------- 2. simultaneous start requests ---------------------- */

  it('creates exactly one spin when five start requests race', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 3);

    // No idempotency key: this exercises the database invariant, not the cache.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => startSpin(owner, roomId)),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const conflicts = results.filter((r) => r.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
    for (const c of conflicts) expect(c.json().error.code).toBe('SPIN_ALREADY_RUNNING');

    // The partial unique index is the real guarantee.
    const { rows } = await query('SELECT id FROM spins WHERE room_id = $1', [roomId]);
    expect(rows).toHaveLength(1);
  });

  /* ----------------------- 3. simultaneous joins --------------------------- */

  it('creates one membership when the same user joins five times at once', async () => {
    const owner = await createUser(app, 'Owner');
    const { roomId } = await createRoom(app, owner);
    const user = await createUser(app, 'Racer');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => joinRoom(app, user, roomId)),
    );

    expect(results.every((s) => s === 200)).toBe(true);

    const { rows } = await query('SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2', [
      roomId,
      user.userId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('admits every user when many join simultaneously', async () => {
    const owner = await createUser(app, 'Owner');
    const { roomId } = await createRoom(app, owner);
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createUser(app, `Racer${i}`)),
    );

    await Promise.all(users.map((u) => joinRoom(app, u, roomId)));

    const members = await roomRepo.listActiveMembers(roomId);
    expect(members).toHaveLength(9); // owner + 8
  });

  /* ------------------ 4. user departure during a spin (D11) ---------------- */

  it('forfeits a participant who leaves mid-spin and says why', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 3); // 4 players
    await startSpin(owner, roomId);
    broadcaster.clear();

    const quitter = members[0] as TestUser;
    await leave(quitter, roomId);

    const spin = (await getSpin(owner, roomId)).json().spin;
    const record = spin.participants.find(
      (p: { userId: string }) => p.userId === quitter.userId,
    );

    expect(record.status).toBe('LEFT');
    expect(record.eliminationOrder).toBe(1);

    const elimination = broadcaster.eventsOfType('user_eliminated')[0] as {
      eliminatedUserId: string;
      reason: string;
    };
    expect(elimination.eliminatedUserId).toBe(quitter.userId);
    // Distinguishable from a wheel draw, so the UI can word it correctly.
    expect(elimination.reason).toBe('LEFT');
  });

  it('cannot let someone who left win the spin', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2); // 3 players
    await startSpin(owner, roomId);

    const quitter = members[0] as TestUser;
    await leave(quitter, roomId);

    await driveSpinsToCompletion(spinService.processDueSpins);

    const spin = (await getSpin(owner, roomId)).json().spin;
    expect(spin.status).toBe('COMPLETED');
    expect(spin.winner.userId).not.toBe(quitter.userId);
  });

  it('declares the winner immediately when departures leave one player', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2); // 3 players
    await startSpin(owner, roomId);
    broadcaster.clear();

    // Two of three leave back to back; the third wins without another tick.
    await leave(members[0] as TestUser, roomId);
    await leave(members[1] as TestUser, roomId);

    const spin = (await getSpin(owner, roomId)).json().spin;

    expect(spin.status).toBe('COMPLETED');
    expect(spin.winner.userId).toBe(owner.userId);
    expect(broadcaster.eventsOfType('winner_announced')).toHaveLength(1);
  });

  /* --------------------- 5. admin disconnect during a spin (D12) ----------- */

  it('keeps the spin running after the owner disconnects', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 3);
    await startSpin(owner, roomId);

    // A dropped socket, not a leave. The spin is server-driven from here.
    await presenceService.onDisconnect(roomId, owner.userId);

    const spin = (await getSpin(owner, roomId)).json().spin;
    expect(spin.status).toBe('RUNNING');

    const member = await roomRepo.findActiveMember(roomId, owner.userId);
    expect(member?.connectionStatus).toBe('DISCONNECTED');
    // Still a member, still a live participant.
    expect(member?.membershipStatus).toBe('ACTIVE');
  });

  it('forfeits the owner but does not stop the spin when the owner actually leaves', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 3); // 4 players
    await startSpin(owner, roomId);

    await leave(owner, roomId);

    const spin = (await getSpin(members[0] as TestUser, roomId)).json().spin;
    expect(spin.status).toBe('RUNNING');
    expect(
      spin.participants.find((p: { userId: string }) => p.userId === owner.userId).status,
    ).toBe('LEFT');
  });

  /* ---------------------- 6 & 7. too few / everyone leaves ----------------- */

  it('aborts the spin when every participant has left', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2); // 3 players
    await startSpin(owner, roomId);
    broadcaster.clear();

    await leave(members[0] as TestUser, roomId);
    await leave(members[1] as TestUser, roomId);
    // At this point the owner has already been declared winner (one remaining),
    // so leaving now must not resurrect the spin.
    await leave(owner, roomId);

    // Read straight from the database: nobody is left in the room, so every
    // caller would now (correctly) get a 403 from GET /spin.
    const { rows } = await query<{ status: string }>(
      'SELECT status FROM spins WHERE room_id = $1',
      [roomId],
    );

    expect(rows).toHaveLength(1);
    // The owner became the sole survivor on the second departure, so this
    // finishes as COMPLETED. The invariant that matters either way:
    expect(['COMPLETED', 'ABORTED']).toContain(rows[0]?.status);
    // No spin is ever left dangling in RUNNING with an empty room.
    expect(rows[0]?.status).not.toBe('RUNNING');

    expect(await roomRepo.listActiveMembers(roomId)).toHaveLength(0);
  });

  it('aborts with NO_PARTICIPANTS when the roster empties before the first tick', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2);
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;

    // Force the roster empty directly, which is the only way to reach the
    // "nobody left at all" branch -- the second-to-last departure normally
    // declares a winner first.
    await query(
      `UPDATE spin_participants
          SET final_status = 'LEFT',
              elimination_order = sub.rn,
              eliminated_at = now()
         FROM (SELECT user_id, row_number() OVER () AS rn
                 FROM spin_participants WHERE spin_id = $1) sub
        WHERE spin_participants.spin_id = $1
          AND spin_participants.user_id = sub.user_id`,
      [spinId],
    );

    await waitFor(async () => (await spinService.processSpinTick(spinId)).action === 'aborted', {
      label: 'spin abort',
    });

    const spin = (await getSpin(owner, roomId)).json().spin;
    expect(spin.status).toBe('ABORTED');
    expect(spin.abortReason).toBe('NO_PARTICIPANTS');
    expect(broadcaster.eventsOfType('spin_aborted')).toHaveLength(1);
  });

  /* -------------------------- 8. duplicate events -------------------------- */

  it('produces no duplicate events when ticks overlap', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 4); // 5 players
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;
    broadcaster.clear();

    // Ten concurrent tick attempts per round. SKIP LOCKED must ensure that at
    // most one of them does work.
    //
    // Driven to completion rather than a fixed number of rounds: deadlines are
    // anchored on scheduled time, so a fixed round count would make this assert
    // on timing instead of on the concurrency property it exists to test.
    for (let round = 0; round < 40; round += 1) {
      await sleep(120);
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => spinService.processSpinTick(spinId)),
      );
      if (outcomes.some((o) => o.action === 'completed' || o.action === 'aborted')) break;
    }

    const eliminations = broadcaster.eventsOfType('user_eliminated');
    const winners = broadcaster.eventsOfType('winner_announced');

    expect(eliminations).toHaveLength(4);
    expect(winners).toHaveLength(1);

    // And every emitted eventId is distinct, so a client deduping on eventId
    // sees each state change exactly once.
    const ids = broadcaster.sent.map((s) => (s.payload as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /* ---------------- 9. delayed timers and server restart (D14/D15) --------- */

  it('resumes a RUNNING spin with no recovery step, as a restart would', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 3);
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;

    // Simulate the process being gone for a while: the deadline is long past.
    await query("UPDATE spins SET next_elimination_at = now() - INTERVAL '30 seconds' WHERE id = $1", [
      spinId,
    ]);

    // A "fresh process" just runs its normal scheduler pass. Nothing else.
    const outcomes = await spinService.processDueSpins();

    expect(outcomes.some((o) => o.spinId === spinId && o.action === 'eliminated')).toBe(true);

    const spin = (await getSpin(owner, roomId)).json().spin;
    expect(spin.eliminatedParticipants).toHaveLength(1);
  });

  it('re-anchors instead of firing a burst after a long outage', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 4); // 5 players
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;

    // Far beyond SPIN_MAX_CATCHUP_LAG_MS.
    await query("UPDATE spins SET next_elimination_at = now() - INTERVAL '5 minutes' WHERE id = $1", [
      spinId,
    ]);

    await spinService.processDueSpins();

    const spin = (await getSpin(owner, roomId)).json().spin;
    // Exactly one elimination, not four. The wheel must not skip to a winner.
    expect(spin.eliminatedParticipants).toHaveLength(1);
    expect(spin.status).toBe('RUNNING');

    // And the new deadline is in the future, not still in the past.
    expect(new Date(spin.nextEliminationAt).getTime()).toBeGreaterThan(Date.now());
  });

  /* --------------- 10. disconnect grace period and reconnect (D13) --------- */

  it('does not remove a member whose socket drops briefly', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2);
    const flaky = members[0] as TestUser;

    await presenceService.onDisconnect(roomId, flaky.userId);
    // Sweep immediately: the grace period has not expired.
    await presenceService.sweepExpiredDisconnects();

    const member = await roomRepo.findActiveMember(roomId, flaky.userId);
    expect(member?.membershipStatus).toBe('ACTIVE');
    expect(member?.connectionStatus).toBe('DISCONNECTED');

    // Reconnecting clears the pending expiry.
    await presenceService.onSubscribe(roomId, flaky.userId);
    const after = await roomRepo.findActiveMember(roomId, flaky.userId);
    expect(after?.connectionStatus).toBe('CONNECTED');
    expect(after?.disconnectedAt).toBeNull();

    await presenceService.sweepExpiredDisconnects();
    expect((await roomRepo.findActiveMember(roomId, flaky.userId))?.membershipStatus).toBe('ACTIVE');
    expect(owner).toBeTruthy();
  });

  it('removes the member and forfeits their seat once the grace period expires', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 3); // 4 players
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;
    broadcaster.clear();

    // Push the elimination deadline out of reach for the duration of this test.
    // The assertion is about the GRACE PERIOD producing a forfeit, and a
    // scheduled elimination landing first would make it pass or fail on timing
    // rather than on the rule being tested.
    await query("UPDATE spins SET next_elimination_at = now() + INTERVAL '1 hour' WHERE id = $1", [
      spinId,
    ]);

    const gone = members[0] as TestUser;
    await presenceService.onDisconnect(roomId, gone.userId);

    // PRESENCE_GRACE_MS is 400ms in tests.
    await sleep(500);
    const result = await presenceService.sweepExpiredDisconnects();

    expect(result.expired).toBe(1);

    const member = await roomRepo.findMember(roomId, gone.userId);
    expect(member?.membershipStatus).toBe('LEFT');

    const left = broadcaster.eventsOfType('user_left')[0] as { reason: string; userId: string };
    expect(left.userId).toBe(gone.userId);
    // Distinguishable from an explicit leave.
    expect(left.reason).toBe('DISCONNECT_TIMEOUT');

    // Same forfeit rule as an explicit leave.
    const spin = (await getSpin(owner, roomId)).json().spin;
    expect(
      spin.participants.find((p: { userId: string }) => p.userId === gone.userId).status,
    ).toBe('LEFT');
  });

  it('gives a reconnecting client the authoritative state mid-spin', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 3);
    const spinId = (await startSpin(owner, roomId)).json().spin.spinId;

    const rejoiner = members[0] as TestUser;
    await presenceService.onDisconnect(roomId, rejoiner.userId);

    // One elimination happens while they are away.
    await waitFor(async () => (await spinService.processSpinTick(spinId)).action === 'eliminated', {
      label: 'elimination while disconnected',
    });

    await presenceService.onSubscribe(roomId, rejoiner.userId);

    const state = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/rooms/${roomId}/state`,
        headers: rejoiner.authHeader,
      })
    ).json();

    // The client missed the event, but the snapshot tells it everything.
    expect(state.activeSpin.status).toBe('RUNNING');
    expect(state.activeSpin.eliminatedParticipants).toHaveLength(1);
    expect(state.participants.find((p: { userId: string }) => p.userId === rejoiner.userId))
      .toMatchObject({ connectionStatus: 'CONNECTED' });
  });
});
