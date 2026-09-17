import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/index.js';
import { resolveUser } from '../services/auth.service.js';
import * as presenceService from '../services/presence.service.js';
import * as roomService from '../services/room.service.js';
import { buildRoomState } from '../services/state.service.js';
import { subscribeRoomPayload } from '../validators/schemas.js';
import { SocketIoBroadcaster, roomChannel, setBroadcaster } from './broadcaster.js';
import { CLIENT_EVENTS, SERVER_EVENTS, envelope } from './events.js';

/**
 * Real-time layer (D19, D20).
 *
 * The client can do exactly two things here: subscribe to a room it is already
 * a member of, and unsubscribe. It cannot assert presence, membership, spin
 * state or an elimination. Everything else is server-emitted, which is what
 * "the backend is authoritative" has to mean in practice.
 */

interface SocketState {
  userId: string;
  displayName: string;
  rooms: Set<string>;
}

const state = new WeakMap<Socket, SocketState>();

export function createSocketServer(httpServer: HttpServer): SocketServer {
  const cfg = getConfig();
  const log = getLogger();

  const io = new SocketServer(httpServer, {
    path: '/socket.io',
    cors: {
      origin: cfg.corsAllowedOrigins.length > 0 ? cfg.corsAllowedOrigins : false,
      credentials: true,
    },
    // Cloud Run's idle timeout is 5 minutes; pinging well inside that keeps the
    // connection from being culled as idle between eliminations.
    pingInterval: 20_000,
    pingTimeout: 20_000,
    // The transport carries JSON events only -- never audio (PDF: out of scope).
    maxHttpBufferSize: 64 * 1024,
  });

  const nsp = io.of('/rooms');

  /* ------------------------- handshake authentication --------------------- */

  nsp.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth as { token?: string } | undefined)?.token ??
        extractHeaderToken(socket.handshake.headers.authorization);

      if (!token) return next(new Error('UNAUTHENTICATED'));

      const user = await resolveUser(token);
      state.set(socket, { userId: user.id, displayName: user.displayName, rooms: new Set() });
      return next();
    } catch {
      // Deliberately opaque: a client must not learn whether a token was
      // expired, forged or simply absent.
      return next(new Error('UNAUTHENTICATED'));
    }
  });

  /* ------------------------------ connection ------------------------------ */

  nsp.on('connection', (socket) => {
    const self = state.get(socket);
    if (!self) {
      socket.disconnect(true);
      return;
    }

    log.debug({ socketId: socket.id, userId: self.userId }, 'Socket connected');

    socket.on(CLIENT_EVENTS.SUBSCRIBE_ROOM, async (raw: unknown, ack?: (res: unknown) => void) => {
      try {
        const { roomId } = subscribeRoomPayload.parse(raw);

        // Membership is re-checked here, not trusted from the client: a socket
        // that guessed a room id must not receive its events.
        await roomService.requireMembership(roomId, self.userId);

        await socket.join(roomChannel(roomId));
        self.rooms.add(roomId);

        await presenceService.onSubscribe(roomId, self.userId);

        // Same path on first connect and on reconnect (D19), so there is one
        // recovery flow to reason about rather than two.
        const snapshot = await buildRoomState(roomId);
        socket.emit(SERVER_EVENTS.ROOM_STATE, { ...envelope(roomId), ...snapshot });

        ack?.({ ok: true, roomId });
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'SUBSCRIBE_FAILED';
        log.warn({ err, userId: self.userId }, 'subscribe_room rejected');
        ack?.({ ok: false, error: { code, message: safeMessage(err) } });
      }
    });

    socket.on(CLIENT_EVENTS.UNSUBSCRIBE_ROOM, async (raw: unknown, ack?: (res: unknown) => void) => {
      try {
        const { roomId } = subscribeRoomPayload.parse(raw);
        await socket.leave(roomChannel(roomId));
        self.rooms.delete(roomId);
        await presenceService.onDisconnect(roomId, self.userId);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: { code: 'UNSUBSCRIBE_FAILED', message: safeMessage(err) } });
      }
    });

    socket.on('disconnect', async (reason) => {
      log.debug({ socketId: socket.id, userId: self.userId, reason }, 'Socket disconnected');

      // Starts the grace period for each subscribed room (D13). Membership is
      // untouched -- this is not a departure yet.
      for (const roomId of self.rooms) {
        try {
          await presenceService.onDisconnect(roomId, self.userId);
        } catch (err) {
          log.warn({ err, roomId, userId: self.userId }, 'Failed to record disconnect');
        }
      }
      state.delete(socket);
    });
  });

  setBroadcaster(new SocketIoBroadcaster(nsp));
  return io;
}

function extractHeaderToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

/** Only AppError messages are safe to return; anything else is generic. */
function safeMessage(err: unknown): string {
  const e = err as { statusCode?: number; message?: string };
  return typeof e?.statusCode === 'number' && e.message ? e.message : 'Request failed.';
}
