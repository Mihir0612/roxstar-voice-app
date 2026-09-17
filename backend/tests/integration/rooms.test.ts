import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRoom,
  createUser,
  draftPayload,
  joinRoom,
  makeApp,
  resetDatabase,
  teardown,
  type TestUser,
} from '../setup/helpers.js';

/**
 * Room and draft REST behaviour, against a real Postgres.
 *
 * Section B of the assessment: REST design, authoritative room state,
 * validation and invalid-operation handling, membership data model.
 */
describe('rooms API', () => {
  let app: FastifyInstance;
  let owner: TestUser;

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
    owner = await createUser(app, 'Owner');
  });

  /* ------------------------------ health --------------------------------- */

  it('reports liveness without touching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'roxstar-backend' });
  });

  it('reports readiness including migration state', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', database: 'ok', pendingMigrations: 0 });
  });

  /* --------------------------------- auth --------------------------------- */

  it('returns the same user for the same device', async () => {
    const deviceId = `device-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { displayName: 'Ada', deviceId },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { displayName: 'Ada Lovelace', deviceId },
    });

    expect(first.json().user.userId).toBe(second.json().user.userId);
    // The display name is refreshed, so renaming works without a new identity.
    expect(second.json().user.displayName).toBe('Ada Lovelace');
  });

  it('rejects a missing bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('gives an identical rejection for a malformed, wrongly-signed and expired token', async () => {
    // Signed with a different secret -- valid JWT structure, bad signature.
    const wrongSecret = jwt.sign({ name: 'Mallory' }, 'a-completely-different-secret', {
      subject: randomUUID(),
      issuer: 'roxstar-backend',
      algorithm: 'HS256',
    });
    // Correctly signed but already expired.
    const expired = jwt.sign({ name: 'Ada' }, process.env.AUTH_SECRET as string, {
      subject: randomUUID(),
      issuer: 'roxstar-backend',
      algorithm: 'HS256',
      expiresIn: -60,
    });

    const responses = await Promise.all(
      ['not.a.real.token', wrongSecret, expired].map((token) =>
        app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } }),
      ),
    );

    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_TOKEN');
    }
    // The point: an attacker cannot tell which of the three failures occurred,
    // so token probing yields no signal.
    const messages = new Set(responses.map((r) => r.json().error.message));
    expect(messages.size).toBe(1);
  });

  it('rejects an invalid display name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { displayName: '', deviceId: 'device-12345678' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  /* -------------------------------- rooms --------------------------------- */

  it('creates a room with the creator as OWNER and a member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: owner.authHeader,
      payload: { name: 'Studio A' },
    });

    expect(res.statusCode).toBe(201);
    const { room } = res.json();
    expect(room).toMatchObject({ name: 'Studio A', ownerId: owner.userId, status: 'OPEN' });
    expect(room.code).toMatch(/^[0-9A-Z]{6}$/);

    const state = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${room.roomId}/state`,
      headers: owner.authHeader,
    });
    expect(state.json().participants).toHaveLength(1);
    expect(state.json().participants[0]).toMatchObject({ userId: owner.userId, role: 'OWNER' });
  });

  it('lets a second user join by room id and by join code', async () => {
    const { roomId, code } = await createRoom(app, owner);

    const byId = await createUser(app, 'ById');
    const byCode = await createUser(app, 'ByCode');

    expect(await joinRoom(app, byId, roomId)).toBe(200);
    expect(await joinRoom(app, byCode, code)).toBe(200);

    const state = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/state`,
      headers: owner.authHeader,
    });
    expect(state.json().participants).toHaveLength(3);
  });

  it('treats a duplicate join as a no-op rather than an error', async () => {
    const { roomId } = await createRoom(app, owner);
    const user = await createUser(app, 'Twice');

    expect(await joinRoom(app, user, roomId)).toBe(200);
    expect(await joinRoom(app, user, roomId)).toBe(200);

    const state = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/state`,
      headers: owner.authHeader,
    });
    // Two joins, one membership -- the unique constraint is doing its job.
    expect(state.json().participants).toHaveLength(2);
  });

  it('returns 404 for an unknown room', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${randomUUID()}/join`,
      headers: owner.authHeader,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROOM_NOT_FOUND');
  });

  it('refuses room state to a non-member', async () => {
    const { roomId } = await createRoom(app, owner);
    const outsider = await createUser(app, 'Outsider');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/state`,
      headers: outsider.authHeader,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_A_MEMBER');
  });

  it('removes a member on leave and stays idempotent on retry', async () => {
    const { roomId } = await createRoom(app, owner);
    const user = await createUser(app, 'Leaver');
    await joinRoom(app, user, roomId);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/leave`,
      headers: user.authHeader,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ left: true });

    // A retried leave must succeed, not 404 -- the client may not have seen
    // the first response.
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/leave`,
      headers: user.authHeader,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ left: false });

    const state = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/state`,
      headers: owner.authHeader,
    });
    expect(state.json().participants).toHaveLength(1);
  });

  /* -------------------------------- drafts -------------------------------- */

  it('shares a draft as metadata and reflects it in room state', async () => {
    const { roomId } = await createRoom(app, owner);
    const payload = draftPayload({ name: 'Reverb Take', durationMs: 8400 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/drafts/share`,
      headers: owner.authHeader,
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().sharedDraft.draft).toMatchObject({
      draftId: payload.draftId,
      name: 'Reverb Take',
      durationMs: 8400,
      effect: 'ECHO',
      // D10: metadata only. No audio is uploaded or hosted.
      hostedFileUrl: null,
    });

    const state = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}/state`,
      headers: owner.authHeader,
    });
    expect(state.json().sharedDraft.draft.draftId).toBe(payload.draftId);
  });

  it('refuses to share into a room the user is not in', async () => {
    const { roomId } = await createRoom(app, owner);
    const outsider = await createUser(app, 'Outsider');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/drafts/share`,
      headers: outsider.authHeader,
      payload: draftPayload(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('will not let one user overwrite another user\'s draft metadata', async () => {
    const { roomId } = await createRoom(app, owner);
    const attacker = await createUser(app, 'Attacker');
    await joinRoom(app, attacker, roomId);

    const payload = draftPayload({ name: 'Original' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/drafts/share`,
      headers: owner.authHeader,
      payload,
    });

    // Same draft id, different user. The upsert's owner guard rejects it, and
    // it is reported as 404 so the response does not confirm the id exists.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/drafts/share`,
      headers: attacker.authHeader,
      payload: { ...payload, name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DRAFT_NOT_FOUND');
  });

  it('rejects malformed draft metadata', async () => {
    const { roomId } = await createRoom(app, owner);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/drafts/share`,
      headers: owner.authHeader,
      payload: draftPayload({ durationMs: -5, draftId: 'not-a-uuid' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('lists and deletes the caller\'s own drafts only', async () => {
    const other = await createUser(app, 'Other');
    const mine = draftPayload({ name: 'Mine' });

    await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: owner.authHeader,
      payload: mine,
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: other.authHeader,
      payload: draftPayload({ name: 'Theirs' }),
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/drafts',
      headers: owner.authHeader,
    });
    expect(list.json().drafts).toHaveLength(1);
    expect(list.json().drafts[0].name).toBe('Mine');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/drafts/${mine.draftId}`,
      headers: other.authHeader,
    });
    expect(del.statusCode).toBe(404);
  });

  /* ------------------------------ error safety ---------------------------- */

  it('never leaks internals in an error response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${randomUUID()}/state`,
      headers: owner.authHeader,
    });
    const body = res.body;
    expect(body).not.toMatch(/postgres|pg_|relation|at Object\.|\.ts:\d+/i);
    expect(res.json().error).toHaveProperty('code');
    expect(res.json()).toHaveProperty('requestId');
  });

  it('accepts a no-payload POST that still sets a JSON content-type', async () => {
    // Regression: real HTTP clients (fetch, Retrofit, curl -H) send
    // `Content-Type: application/json` with an empty body on a POST that has
    // no payload. Fastify's default parser rejects that outright with 400.
    // Found by tests/e2e/verify.mjs, which drives the server over real HTTP --
    // app.inject() omits the header, so an in-process test cannot see it.
    const { roomId } = await createRoom(app, owner);
    const user = await createUser(app, 'EmptyBody');

    for (const url of [`/api/v1/rooms/${roomId}/join`, `/api/v1/rooms/${roomId}/leave`]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { ...owner.authHeader, 'content-type': 'application/json' },
        body: '',
      });
      expect(res.statusCode, `${url} with an empty JSON body`).toBe(200);
    }
    expect(user).toBeTruthy();
  });

  it('rejects malformed JSON as a clean 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: { ...owner.authHeader, 'content-type': 'application/json' },
      body: '{"name": "unterminated',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it('returns a structured 404 for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
