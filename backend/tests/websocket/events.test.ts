import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import * as spinService from '../../src/services/spin.service.js';
import { resetBroadcaster } from '../../src/websocket/broadcaster.js';
import { createSocketServer } from '../../src/websocket/server.js';
import {
  createUser,
  driveSpinsToCompletion,
  joinRoom,
  resetDatabase,
  seedRoomWithMembers,
  sleep,
  teardown,
  waitFor,
  type TestUser,
} from '../setup/helpers.js';

/**
 * Section B2 -- the seven mandatory WebSocket events, over real sockets
 * against a real server. No mock transport: the handshake, the namespace, the
 * room fan-out and the payload shapes are all exercised as a client sees them.
 */
describe('websocket events', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let io: ReturnType<typeof createSocketServer>;
  const open: Socket[] = [];

  /** Connect, authenticate and subscribe -- the D19 sequence a client follows. */
  async function connect(user: TestUser, roomId?: string): Promise<Socket> {
    const socket = ioClient(`${baseUrl}/rooms`, {
      auth: { token: user.token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    open.push(socket);

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err) => reject(err));
      setTimeout(() => reject(new Error('socket connect timed out')), 8000);
    });

    if (roomId) {
      const ack = await socket.emitWithAck('subscribe_room', { roomId });
      if (!(ack as { ok: boolean }).ok) throw new Error(`subscribe failed: ${JSON.stringify(ack)}`);
    }
    return socket;
  }

  /** Collect every event of a type that arrives on a socket. */
  function collect(socket: Socket, event: string): unknown[] {
    const received: unknown[] = [];
    socket.on(event, (payload: unknown) => received.push(payload));
    return received;
  }

  beforeAll(async () => {
    await resetDatabase();
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    io = createSocketServer(app.server);
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await io?.close();
    await app?.close();
    resetBroadcaster();
    await teardown();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    for (const s of open.splice(0)) s.disconnect();
  });

  /* ------------------------------ handshake -------------------------------- */

  it('rejects a connection with no token', async () => {
    const socket = ioClient(`${baseUrl}/rooms`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    open.push(socket);

    const error = await new Promise<Error>((resolve) => {
      socket.once('connect_error', resolve);
    });
    expect(error.message).toBe('UNAUTHENTICATED');
  });

  it('rejects a connection with a forged token', async () => {
    const socket = ioClient(`${baseUrl}/rooms`, {
      auth: { token: 'forged.token.value' },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    open.push(socket);

    const error = await new Promise<Error>((resolve) => {
      socket.once('connect_error', resolve);
    });
    expect(error.message).toBe('UNAUTHENTICATED');
  });

  it('refuses to subscribe a socket to a room it is not a member of', async () => {
    const { roomId } = await seedRoomWithMembers(app, 2);
    const outsider = await createUser(app, 'Outsider');

    const socket = await connect(outsider);
    const ack = (await socket.emitWithAck('subscribe_room', { roomId })) as {
      ok: boolean;
      error: { code: string };
    };

    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe('NOT_A_MEMBER');
  });

  it('rejects a malformed subscribe payload', async () => {
    const { owner } = await seedRoomWithMembers(app, 2);
    const socket = await connect(owner);

    const ack = (await socket.emitWithAck('subscribe_room', { roomId: 'not-a-uuid' })) as {
      ok: boolean;
    };

    expect(ack.ok).toBe(false);
  });

  /* ------------------------------ room_state ------------------------------- */

  it('sends room_state on subscribe', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    const socket = await connect(owner);

    const statePromise = new Promise<Record<string, unknown>>((resolve) => {
      socket.once('room_state', resolve);
    });
    await socket.emitWithAck('subscribe_room', { roomId });
    const state = await statePromise;

    expect(state).toMatchObject({ roomId });
    expect((state as { room: { roomId: string } }).room.roomId).toBe(roomId);
    expect((state as { participants: unknown[] }).participants).toHaveLength(3);
    expect(state.eventId).toBeTruthy();
  });

  /* -------------------------- user_joined / user_left ---------------------- */

  it('broadcasts user_joined to existing members', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    const watcher = await connect(owner, roomId);
    const joined = collect(watcher, 'user_joined');

    const newcomer = await createUser(app, 'Newcomer');
    await joinRoom(app, newcomer, roomId);

    await waitFor(() => joined.length > 0, { label: 'user_joined' });

    const payload = joined[0] as {
      participant: { userId: string; displayName: string };
      participants: unknown[];
      eventId: string;
    };
    expect(payload.participant.userId).toBe(newcomer.userId);
    expect(payload.participant.displayName).toBe('Newcomer');
    expect(payload.participants).toHaveLength(4);
    expect(payload.eventId).toBeTruthy();
  });

  it('broadcasts user_left with an explicit reason when a member leaves', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2);
    const watcher = await connect(owner, roomId);
    const left = collect(watcher, 'user_left');

    const quitter = members[0] as TestUser;
    await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/leave`,
      headers: quitter.authHeader,
    });

    await waitFor(() => left.length > 0, { label: 'user_left' });

    const payload = left[0] as { userId: string; reason: string; participants: unknown[] };
    expect(payload.userId).toBe(quitter.userId);
    expect(payload.reason).toBe('EXPLICIT');
    expect(payload.participants).toHaveLength(2);
  });

  /* ------------------------------ draft_shared ----------------------------- */

  it('broadcasts draft_shared with metadata only', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2);
    const watcher = await connect(members[0] as TestUser, roomId);
    const shared = collect(watcher, 'draft_shared');

    await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/drafts/share`,
      headers: owner.authHeader,
      payload: {
        draftId: '11111111-2222-3333-4444-555555555555',
        name: 'Echo Take 2',
        durationMs: 9500,
        effect: 'ECHO',
      },
    });

    await waitFor(() => shared.length > 0, { label: 'draft_shared' });

    const payload = shared[0] as {
      sharedDraft: { draft: Record<string, unknown>; sharedBy: string };
    };
    expect(payload.sharedDraft.draft).toMatchObject({
      name: 'Echo Take 2',
      durationMs: 9500,
      effect: 'ECHO',
    });
    expect(payload.sharedDraft.sharedBy).toBe(owner.userId);
    // The event carries no audio -- the transport is for state, not media.
    expect(JSON.stringify(payload)).not.toMatch(/base64|audioData|pcm/i);
  });

  /* -------------------------- the full spin sequence ----------------------- */

  it('delivers the whole spin sequence to every member in order', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 2); // 3 players

    const sockets = await Promise.all([
      connect(owner, roomId),
      connect(members[0] as TestUser, roomId),
      connect(members[1] as TestUser, roomId),
    ]);
    const timelines = sockets.map((s) => {
      const events: string[] = [];
      for (const name of ['spin_started', 'user_eliminated', 'winner_announced']) {
        s.on(name, () => events.push(name));
      }
      return events;
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/spin/start`,
      headers: owner.authHeader,
      payload: {},
    });

    await driveSpinsToCompletion(spinService.processDueSpins);

    await waitFor(() => timelines.every((t) => t.includes('winner_announced')), {
      label: 'winner on every socket',
    });

    // Every member sees the same sequence -- room fan-out reaches all of them.
    for (const timeline of timelines) {
      expect(timeline).toEqual([
        'spin_started',
        'user_eliminated',
        'user_eliminated',
        'winner_announced',
      ]);
    }
  });

  it('carries the winner and the full spin state on winner_announced', async () => {
    const { owner, roomId } = await seedRoomWithMembers(app, 2);
    const socket = await connect(owner, roomId);

    const winnerPromise = new Promise<Record<string, unknown>>((resolve) => {
      socket.once('winner_announced', resolve);
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/spin/start`,
      headers: owner.authHeader,
      payload: {},
    });
    await driveSpinsToCompletion(spinService.processDueSpins);

    const payload = (await winnerPromise) as {
      winner: { userId: string; displayName: string };
      spin: { status: string; remainingParticipants: unknown[] };
      seq: string;
    };

    expect(payload.winner.userId).toBeTruthy();
    expect(payload.winner.displayName).toBeTruthy();
    expect(payload.spin.status).toBe('COMPLETED');
    expect(payload.spin.remainingParticipants).toHaveLength(1);
    expect(payload.seq).toBeTruthy();
  });

  /* --------------------------- reconnect recovery -------------------------- */

  it('gives a reconnecting socket the authoritative state it missed', async () => {
    const { owner, members, roomId } = await seedRoomWithMembers(app, 3);
    const rejoiner = members[0] as TestUser;

    const first = await connect(rejoiner, roomId);
    first.disconnect();
    open.splice(open.indexOf(first), 1);

    await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/spin/start`,
      headers: owner.authHeader,
      payload: {},
    });
    await waitFor(
      async () => (await spinService.processDueSpins()).some((o) => o.action === 'eliminated'),
      { label: 'one elimination while away' },
    );

    // Reconnect: same subscribe path, and room_state carries everything missed.
    const second = ioClient(`${baseUrl}/rooms`, {
      auth: { token: rejoiner.token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    open.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('connect', () => resolve());
      second.once('connect_error', reject);
    });

    const statePromise = new Promise<Record<string, unknown>>((resolve) => {
      second.once('room_state', resolve);
    });
    await second.emitWithAck('subscribe_room', { roomId });
    const state = (await statePromise) as {
      activeSpin: { status: string; eliminatedParticipants: unknown[] } | null;
    };

    expect(state.activeSpin?.status).toBe('RUNNING');
    expect(state.activeSpin?.eliminatedParticipants.length).toBeGreaterThanOrEqual(1);
  });

  /* ------------------------------ isolation -------------------------------- */

  it('does not leak one room\'s events into another room', async () => {
    const roomA = await seedRoomWithMembers(app, 2);
    const roomB = await seedRoomWithMembers(app, 2);

    const watcherB = await connect(roomB.owner, roomB.roomId);
    const leaked = collect(watcherB, 'spin_started');

    await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomA.roomId}/spin/start`,
      headers: roomA.owner.authHeader,
      payload: {},
    });

    await sleep(300);
    expect(leaked).toHaveLength(0);
  });
});
