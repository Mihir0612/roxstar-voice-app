#!/usr/bin/env node
/**
 * End-to-end verification of a RUNNING Roxstar deployment.
 *
 * This is the script the DevOps plan demands before anyone is allowed to say
 * "deployment successful". It does not inspect code or read logs -- it drives
 * the real HTTP and WebSocket surface the Android client uses, from outside
 * the process, and fails loudly if any step does not behave.
 *
 *   node tests/e2e/verify.mjs                          # defaults to localhost:8080
 *   node tests/e2e/verify.mjs https://roxstar-xyz.run.app
 *
 * Exit code 0 means every check passed. Anything else means do not ship.
 */

import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';

const BASE = (process.argv[2] ?? process.env.ROXSTAR_BASE_URL ?? 'http://localhost:8080').replace(
  /\/$/,
  '',
);
// 3 players is the PDF minimum, and the fastest spin that still exercises
// "eliminate until one remains".
const PLAYERS = 3;
const SPIN_INTERVAL_MS = Number(process.env.SPIN_ELIMINATION_INTERVAL_MS ?? 5000);

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 45_000, intervalMs = 100, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function connectSocket(token) {
  const socket = ioClient(`${BASE}/rooms`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(new Error(`socket connect failed: ${err.message}`)));
    setTimeout(() => reject(new Error('socket connect timed out')), 15_000);
  });
}

async function main() {
  console.log(`\nRoxstar end-to-end verification`);
  console.log(`Target: ${BASE}\n`);

  /* ------------------------------ 1. health ------------------------------- */
  section('1. Health and readiness');

  const health = await api('/health');
  check('GET /health returns 200', health.status === 200, `got ${health.status}`);
  check('health payload names the service', health.body?.service === 'roxstar-backend');

  const ready = await api('/ready');
  check('GET /ready returns 200', ready.status === 200, `got ${ready.status}`);
  check('database is reachable', ready.body?.database === 'ok');
  check('no migrations pending', ready.body?.pendingMigrations === 0);

  if (health.status !== 200 || ready.status !== 200) {
    console.log('\nService is not healthy. Aborting the remaining checks.');
    return finish();
  }

  /* --------------------------- 2. authentication --------------------------- */
  section('2. Authentication and authorization');

  const users = [];
  for (let i = 0; i < PLAYERS; i += 1) {
    const res = await api('/api/v1/auth/session', {
      method: 'POST',
      body: { displayName: `E2E Player ${i + 1}`, deviceId: `e2e-${randomUUID()}` },
    });
    if (res.status !== 201) throw new Error(`session creation failed: ${JSON.stringify(res.body)}`);
    users.push({ ...res.body.user, token: res.body.token });
  }
  check(`created ${PLAYERS} sessions`, users.length === PLAYERS);

  const noAuth = await api('/api/v1/me');
  check('unauthenticated request is rejected', noAuth.status === 401);

  const badAuth = await api('/api/v1/me', { token: 'forged.token.value' });
  check('forged token is rejected', badAuth.status === 401);
  check(
    'auth error exposes no internals',
    !/stack|postgres|jwt malformed/i.test(JSON.stringify(badAuth.body)),
  );

  /* ------------------------------- 3. rooms -------------------------------- */
  section('3. Room lifecycle');

  const [owner, ...others] = users;

  const created = await api('/api/v1/rooms', {
    method: 'POST',
    token: owner.token,
    body: { name: 'E2E Verification Room' },
  });
  check('room created', created.status === 201, `got ${created.status}`);
  const roomId = created.body?.room?.roomId;
  const roomCode = created.body?.room?.code;
  check('room has a join code', typeof roomCode === 'string' && roomCode.length === 6);

  for (const u of others) {
    const res = await api(`/api/v1/rooms/${roomId}/join`, {
      method: 'POST',
      token: u.token,
      body: {},
    });
    if (res.status !== 200) throw new Error(`join failed: ${JSON.stringify(res.body)}`);
  }

  const state = await api(`/api/v1/rooms/${roomId}/state`, { token: owner.token });
  check('room state is retrievable', state.status === 200);
  check(
    `all ${PLAYERS} participants are present`,
    state.body?.participants?.length === PLAYERS,
    `got ${state.body?.participants?.length}`,
  );

  /* ---------------------------- 4. authorization --------------------------- */
  section('4. Authorization rules');

  const outsiderRes = await api('/api/v1/auth/session', {
    method: 'POST',
    body: { displayName: 'Outsider', deviceId: `e2e-${randomUUID()}` },
  });
  const outsider = { ...outsiderRes.body.user, token: outsiderRes.body.token };

  const outsiderState = await api(`/api/v1/rooms/${roomId}/state`, { token: outsider.token });
  check('non-member cannot read room state', outsiderState.status === 403);

  const memberStart = await api(`/api/v1/rooms/${roomId}/spin/start`, {
    method: 'POST',
    token: others[0].token,
    body: {},
  });
  check('non-admin cannot start a spin', memberStart.status === 403);
  check('rejection names the rule', memberStart.body?.error?.code === 'NOT_ROOM_ADMIN');

  /* ------------------------------ 5. websocket ----------------------------- */
  section('5. WebSocket connection and events');

  const sockets = [];
  const received = users.map(() => []);

  for (let i = 0; i < users.length; i += 1) {
    const socket = await connectSocket(users[i].token);
    sockets.push(socket);
    for (const name of [
      'room_state',
      'user_joined',
      'user_left',
      'draft_shared',
      'spin_started',
      'user_eliminated',
      'winner_announced',
      'spin_aborted',
    ]) {
      socket.on(name, (payload) => received[i].push({ name, payload }));
    }
    const ack = await socket.emitWithAck('subscribe_room', { roomId });
    if (!ack?.ok) throw new Error(`subscribe failed: ${JSON.stringify(ack)}`);
  }
  check('all clients connected over WebSocket', sockets.length === PLAYERS);

  await waitFor(() => received.every((r) => r.some((e) => e.name === 'room_state')), {
    label: 'room_state on every socket',
  });
  check('room_state delivered on subscribe', true);

  /* ---------------------------- 6. draft sharing --------------------------- */
  section('6. Draft sharing');

  const draftId = randomUUID();
  const share = await api(`/api/v1/rooms/${roomId}/drafts/share`, {
    method: 'POST',
    token: owner.token,
    body: { draftId, name: 'E2E Echo Take', durationMs: 7200, effect: 'ECHO' },
  });
  check('draft shared', share.status === 201, `got ${share.status}`);

  await waitFor(() => received.every((r) => r.some((e) => e.name === 'draft_shared')), {
    label: 'draft_shared broadcast',
  });
  check('draft_shared reached every member', true);

  const draftEvent = received[1].find((e) => e.name === 'draft_shared');
  check('draft event carries metadata only', draftEvent.payload.sharedDraft.draft.name === 'E2E Echo Take');
  check(
    'no audio bytes travel over the socket',
    !/base64|audioData|pcm|"data:audio/i.test(JSON.stringify(draftEvent.payload)),
  );

  /* ------------------------------- 7. the spin ----------------------------- */
  section('7. Spin lifecycle');

  const t0 = Date.now();
  const idemKey = randomUUID();
  const start = await api(`/api/v1/rooms/${roomId}/spin/start`, {
    method: 'POST',
    token: owner.token,
    body: {},
    headers: { 'idempotency-key': idemKey },
  });
  check('owner started the spin', start.status === 201, `got ${start.status}`);
  check('spin is RUNNING', start.body?.spin?.status === 'RUNNING');
  check(
    `spin has ${PLAYERS} participants`,
    start.body?.spin?.participants?.length === PLAYERS,
  );

  const retry = await api(`/api/v1/rooms/${roomId}/spin/start`, {
    method: 'POST',
    token: owner.token,
    body: {},
    headers: { 'idempotency-key': idemKey },
  });
  check('retry with the same Idempotency-Key replays', retry.status === 201);
  check(
    'retry did not create a second spin',
    retry.body?.spin?.spinId === start.body?.spin?.spinId,
  );

  const duplicate = await api(`/api/v1/rooms/${roomId}/spin/start`, {
    method: 'POST',
    token: owner.token,
    body: {},
  });
  check('a fresh duplicate start is refused', duplicate.status === 409);
  check('refusal names the conflict', duplicate.body?.error?.code === 'SPIN_ALREADY_RUNNING');

  await waitFor(() => received.every((r) => r.some((e) => e.name === 'spin_started')), {
    label: 'spin_started on every socket',
  });
  check('spin_started reached every member', true);

  await waitFor(() => received.every((r) => r.some((e) => e.name === 'winner_announced')), {
    timeoutMs: SPIN_INTERVAL_MS * (PLAYERS + 2),
    label: 'winner_announced',
  });
  const elapsed = Date.now() - t0;

  const eliminations = received[0].filter((e) => e.name === 'user_eliminated');
  const winners = received[0].filter((e) => e.name === 'winner_announced');

  check(
    `${PLAYERS - 1} eliminations were broadcast`,
    eliminations.length === PLAYERS - 1,
    `got ${eliminations.length}`,
  );
  check('exactly one winner was announced', winners.length === 1);

  // 3 players -> 2 intervals. Allow generous slack for network latency.
  const expectedMs = SPIN_INTERVAL_MS * (PLAYERS - 1);
  check(
    `pacing is about ${SPIN_INTERVAL_MS}ms per elimination (took ${elapsed}ms)`,
    elapsed >= expectedMs * 0.85 && elapsed <= expectedMs * 2.5,
    `expected ~${expectedMs}ms`,
  );

  const orders = eliminations.map((e) => e.payload.eliminationOrder);
  check(
    'elimination order is dense and sequential',
    JSON.stringify(orders) === JSON.stringify(orders.map((_, i) => i + 1)),
    JSON.stringify(orders),
  );

  const allEventIds = received[0].map((e) => e.payload.eventId).filter(Boolean);
  check(
    'every event carries a unique eventId for client dedupe',
    new Set(allEventIds).size === allEventIds.length,
  );

  const everyoneSawTheSameWinner = new Set(
    received.map((r) => r.find((e) => e.name === 'winner_announced').payload.winner.userId),
  );
  check('every client saw the same winner', everyoneSawTheSameWinner.size === 1);

  /* ---------------------------- 8. persistence ----------------------------- */
  section('8. Persistence');

  const finalSpin = await api(`/api/v1/rooms/${roomId}/spin`, { token: owner.token });
  check('spin result is retrievable', finalSpin.status === 200);
  check('spin is COMPLETED', finalSpin.body?.spin?.status === 'COMPLETED');
  check('winner is persisted', Boolean(finalSpin.body?.spin?.winner?.userId));
  check(
    'persisted winner matches the broadcast winner',
    finalSpin.body?.spin?.winner?.userId === [...everyoneSawTheSameWinner][0],
  );
  check(
    'exactly one remaining participant',
    finalSpin.body?.spin?.remainingParticipants?.length === 1,
  );

  const finalState = await api(`/api/v1/rooms/${roomId}/state`, { token: owner.token });
  check('finished spin appears as lastSpin in room state', finalState.body?.lastSpin?.status === 'COMPLETED');
  check('no spin is left active', finalState.body?.activeSpin === null);

  /* --------------------------- 9. reconnect recovery ----------------------- */
  section('9. Reconnect and state recovery');

  sockets[1].disconnect();
  await sleep(500);

  const reconnected = await connectSocket(users[1].token);
  sockets.push(reconnected);
  const recoveryPromise = new Promise((resolve) => reconnected.once('room_state', resolve));
  await reconnected.emitWithAck('subscribe_room', { roomId });
  const recovered = await recoveryPromise;

  check('reconnecting client receives room_state', Boolean(recovered));
  check(
    'recovered state includes the finished spin',
    recovered?.lastSpin?.status === 'COMPLETED',
  );
  check(
    'recovered winner matches',
    recovered?.lastSpin?.winner?.userId === [...everyoneSawTheSameWinner][0],
  );

  /* -------------------------- 10. expected failures ------------------------ */
  section('10. Expected failure handling');

  const tooFew = await api('/api/v1/rooms', {
    method: 'POST',
    token: outsider.token,
    body: { name: 'Lonely Room' },
  });
  const lonelyRoomId = tooFew.body.room.roomId;
  const lonelyStart = await api(`/api/v1/rooms/${lonelyRoomId}/spin/start`, {
    method: 'POST',
    token: outsider.token,
    body: {},
  });
  check('a 1-player spin is refused', lonelyStart.status === 409);
  check(
    'refusal explains the rule',
    lonelyStart.body?.error?.code === 'NOT_ENOUGH_PARTICIPANTS',
  );
  check(
    'refusal reports the actual counts',
    lonelyStart.body?.error?.details?.required === 3,
  );

  const badBody = await api(`/api/v1/rooms/${roomId}/drafts/share`, {
    method: 'POST',
    token: owner.token,
    body: { draftId: 'not-a-uuid', name: '', durationMs: -1 },
  });
  check('malformed input is rejected', badBody.status === 400);
  check('validation error is structured', badBody.body?.error?.code === 'VALIDATION_ERROR');

  const missing = await api(`/api/v1/rooms/${randomUUID()}/state`, { token: owner.token });
  check('unknown room returns 404', missing.status === 404);
  check(
    'error response leaks no internals',
    !/postgres|relation|\.ts:\d+|at Object\./i.test(JSON.stringify(missing.body)),
  );

  /* ------------------------------ 11. departure ---------------------------- */
  section('11. Departure handling');

  const leaveRes = await api(`/api/v1/rooms/${roomId}/leave`, {
    method: 'POST',
    token: others[0].token,
  });
  check('member can leave', leaveRes.status === 200 && leaveRes.body.left === true);

  const retryLeave = await api(`/api/v1/rooms/${roomId}/leave`, {
    method: 'POST',
    token: others[0].token,
  });
  check('repeated leave is idempotent', retryLeave.status === 200 && retryLeave.body.left === false);

  await waitFor(() => received[0].some((e) => e.name === 'user_left'), { label: 'user_left' });
  const leftEvent = received[0].find((e) => e.name === 'user_left');
  check('user_left names the departing user', leftEvent.payload.userId === others[0].userId);
  check('user_left states the reason', leftEvent.payload.reason === 'EXPLICIT');

  for (const s of sockets) s.disconnect();
  return finish();
}

function finish() {
  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f}`);
    console.log(`\n  VERDICT: NOT VERIFIED -- do not ship.`);
  } else {
    console.log(`\n  VERDICT: VERIFIED against ${BASE}`);
  }
  console.log(`${'='.repeat(52)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nVerification aborted: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
