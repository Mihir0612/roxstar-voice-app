import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { runMigrations } from '../../src/db/migrate.js';
import { closePool, query } from '../../src/db/pool.js';
import { resetBroadcaster } from '../../src/websocket/broadcaster.js';

/** Shared test plumbing: a real app against a real Postgres, no mocks. */

const TABLES = [
  'spin_events',
  'spin_participants',
  'spins',
  'room_shared_drafts',
  'room_members',
  'drafts',
  'rooms',
  'idempotency_keys',
  'users',
];

let migrated = false;

export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await runMigrations();
  migrated = true;
}

export async function resetDatabase(): Promise<void> {
  await ensureSchema();
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function teardown(): Promise<void> {
  resetBroadcaster();
  await closePool();
}

export interface TestUser {
  userId: string;
  displayName: string;
  token: string;
  authHeader: { authorization: string };
}

/** Create an app instance ready for `inject()`. */
export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function createUser(app: FastifyInstance, displayName: string): Promise<TestUser> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    payload: { displayName, deviceId: `device-${randomUUID()}` },
  });
  if (res.statusCode !== 201) throw new Error(`createUser failed: ${res.statusCode} ${res.body}`);

  const body = res.json() as { token: string; user: { userId: string; displayName: string } };
  return {
    userId: body.user.userId,
    displayName: body.user.displayName,
    token: body.token,
    authHeader: { authorization: `Bearer ${body.token}` },
  };
}

export async function createRoom(
  app: FastifyInstance,
  owner: TestUser,
  name = 'Test Room',
): Promise<{ roomId: string; code: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rooms',
    headers: owner.authHeader,
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`createRoom failed: ${res.statusCode} ${res.body}`);

  const body = res.json() as { room: { roomId: string; code: string } };
  return { roomId: body.room.roomId, code: body.room.code };
}

export async function joinRoom(
  app: FastifyInstance,
  user: TestUser,
  roomIdOrCode: string,
): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${roomIdOrCode}/join`,
    headers: user.authHeader,
    payload: {},
  });
  return res.statusCode;
}

/** Owner plus `extra` joined members -- the usual starting point for a spin. */
export async function seedRoomWithMembers(
  app: FastifyInstance,
  extra: number,
): Promise<{ owner: TestUser; members: TestUser[]; roomId: string; code: string }> {
  const owner = await createUser(app, 'Owner');
  const { roomId, code } = await createRoom(app, owner);

  const members: TestUser[] = [];
  for (let i = 0; i < extra; i += 1) {
    const u = await createUser(app, `Member${i + 1}`);
    await joinRoom(app, u, roomId);
    members.push(u);
  }
  return { owner, members, roomId, code };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `predicate` holds. Preferred over a fixed sleep: the assertion
 * fails with the real reason instead of a flaky timeout.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 8000, intervalMs = 25, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/**
 * Drive the scheduler until every due spin reaches a terminal state.
 *
 * Budgeted by wall clock, not by a fixed iteration count. The property under
 * test is always "the spin completes and emits the right events", never "it
 * completes within N loops" -- and a fixed count turns a loaded CI machine into
 * a spurious failure.
 */
export async function driveSpinsToCompletion(
  processDueSpins: () => Promise<Array<{ action: string }>>,
  { budgetMs = 20_000, pollMs = 40 } = {},
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const outcomes = await processDueSpins();
    if (outcomes.some((o) => o.action === 'completed' || o.action === 'aborted')) return;
    await sleep(pollMs);
  }
  throw new Error(`No spin reached a terminal state within ${budgetMs}ms`);
}

export const draftPayload = (overrides: Record<string, unknown> = {}) => ({
  draftId: randomUUID(),
  name: 'Take 1',
  durationMs: 12_000,
  effect: 'ECHO',
  hostedFileUrl: null,
  ...overrides,
});
