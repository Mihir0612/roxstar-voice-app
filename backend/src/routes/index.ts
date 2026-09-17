import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config/index.js';
import { pendingMigrationCount } from '../db/migrate.js';
import { query } from '../db/pool.js';
import { notReady } from '../errors/index.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import * as authService from '../services/auth.service.js';
import * as draftService from '../services/draft.service.js';
import * as roomService from '../services/room.service.js';
import * as spinService from '../services/spin.service.js';
import {
  createRoomBody,
  createSessionBody,
  draftBody,
  draftIdParam,
  joinRoomParam,
  roomIdParam,
} from '../validators/schemas.js';

/**
 * HTTP surface. The frozen contract is /docs/api/openapi.yaml.
 *
 * Controllers stay thin on purpose: parse, authorise, delegate, shape. Every
 * business rule lives in a service so the WebSocket layer and the tests reach
 * the same logic rather than a copy of it.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const cfg = getConfig();

  /* ------------------------------ health --------------------------------- */

  // Liveness only -- deliberately no database call (D32). A liveness probe
  // that depends on Postgres turns a brief database blip into a restart storm.
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    service: 'roxstar-backend',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  // Readiness: can this instance actually serve traffic?
  app.get('/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await query('SELECT 1');
      const pending = await pendingMigrationCount();
      if (pending > 0) throw notReady({ pendingMigrations: pending });
      return { status: 'ready', database: 'ok', pendingMigrations: 0 };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) throw err;
      reply.log.error({ err }, 'Readiness check failed');
      throw notReady({ database: 'unreachable' });
    }
  });

  /* ------------------------------- auth ----------------------------------- */

  app.post('/api/v1/auth/session', async (req, reply) => {
    const body = createSessionBody.parse(req.body);
    const { token, expiresIn, user } = await authService.createSession(body.displayName, body.deviceId);
    reply.status(201);
    return {
      token,
      expiresIn,
      user: { userId: user.id, displayName: user.displayName },
    };
  });

  app.get('/api/v1/me', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    return { user: { userId: user.id, displayName: user.displayName } };
  });

  /* ------------------------------ drafts ---------------------------------- */

  app.post('/api/v1/drafts', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const body = draftBody.parse(req.body);
    return withIdempotency(req, reply, 'POST /api/v1/drafts', 201, async () => ({
      draft: await draftService.registerDraft(user.id, body),
    }));
  });

  app.get('/api/v1/drafts', { preHandler: requireAuth }, async (req) => ({
    drafts: await draftService.listDrafts(currentUser(req).id),
  }));

  app.delete('/api/v1/drafts/:draftId', { preHandler: requireAuth }, async (req, reply) => {
    const { draftId } = draftIdParam.parse(req.params);
    await draftService.deleteDraft(currentUser(req).id, draftId);
    reply.status(204);
    return null;
  });

  /* ------------------------------- rooms ---------------------------------- */

  app.post('/api/v1/rooms', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const body = createRoomBody.parse(req.body ?? {});
    return withIdempotency(req, reply, 'POST /api/v1/rooms', 201, async () => ({
      room: await roomService.createRoom(body.name, user.id),
    }));
  });

  app.post('/api/v1/rooms/:roomIdOrCode/join', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const { roomIdOrCode } = joinRoomParam.parse(req.params);
    return withIdempotency(req, reply, 'POST /api/v1/rooms/join', 200, async () => {
      const result = await roomService.joinRoom(roomIdOrCode, user.id);
      return { room: result.room, member: result.member, state: result.state };
    });
  });

  app.post('/api/v1/rooms/:roomId/leave', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { roomId } = roomIdParam.parse(req.params);
    // Deliberately not 404 when already gone: a retried leave must succeed.
    return roomService.leaveRoom(roomId, user.id);
  });

  app.get('/api/v1/rooms/:roomId/state', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { roomId } = roomIdParam.parse(req.params);
    await roomService.requireMembership(roomId, user.id);
    return roomService.getRoomState(roomId);
  });

  app.post('/api/v1/rooms/:roomId/drafts/share', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const { roomId } = roomIdParam.parse(req.params);
    const body = draftBody.parse(req.body);
    return withIdempotency(req, reply, 'POST /api/v1/rooms/drafts/share', 201, async () =>
      roomService.shareDraft(roomId, user.id, body),
    );
  });

  /* -------------------------------- spin ---------------------------------- */

  app.post(
    '/api/v1/rooms/:roomId/spin/start',
    {
      preHandler: requireAuth,
      // Tighter than the global limit (D22): this is the abuse-prone,
      // state-creating operation in the whole API.
      config: {
        rateLimit: { max: cfg.RATE_LIMIT_SPIN_START_MAX, timeWindow: cfg.RATE_LIMIT_WINDOW_MS },
      },
    },
    async (req, reply) => {
      const user = currentUser(req);
      const { roomId } = roomIdParam.parse(req.params);
      return withIdempotency(req, reply, 'POST /api/v1/rooms/spin/start', 201, async () => ({
        spin: await spinService.startSpin(roomId, user.id),
      }));
    },
  );

  app.get('/api/v1/rooms/:roomId/spin', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const { roomId } = roomIdParam.parse(req.params);
    await roomService.requireMembership(roomId, user.id);
    return { spin: await spinService.getSpinForRoom(roomId) };
  });
}
