#!/usr/bin/env node
/**
 * Join bot participants to a room so a spin can be tested from ONE device.
 *
 * A spin needs at least 3 eligible players. Without this you would need three
 * phones, or three emulators, to see an elimination at all.
 *
 * The bots are ordinary clients: they authenticate, join by code, open a real
 * WebSocket and stay subscribed. They do not decide anything -- they cannot,
 * because the server is authoritative. They just occupy seats and print what
 * the server sends, which doubles as a live view of the event stream while you
 * drive the app by hand.
 *
 *   node tests/e2e/join-bots.mjs 7K4MPQ                  # 2 bots, localhost
 *   node tests/e2e/join-bots.mjs 7K4MPQ 4                # 4 bots
 *   node tests/e2e/join-bots.mjs 7K4MPQ 2 http://192.168.1.24:8080
 *
 * Ctrl+C to disconnect them. Leaving them connected is fine -- they stay in the
 * room until you stop the script, and the 15-second disconnect grace period
 * then removes them.
 */

import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';

const [, , roomCodeArg, countArg, baseArg] = process.argv;

if (!roomCodeArg) {
  console.error(`
Usage: node tests/e2e/join-bots.mjs <ROOM_CODE> [botCount] [baseUrl]

  ROOM_CODE   the 6-character code shown in the app's room header
  botCount    default 2, which is the minimum to reach 3 players with you
  baseUrl     default http://localhost:8080
`);
  process.exit(1);
}

const ROOM_CODE = roomCodeArg.trim().toUpperCase();
const BOT_COUNT = Number(countArg ?? 2);
const BASE = (baseArg ?? process.env.ROXSTAR_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');

const NAMES = ['Bot Ada', 'Bot Linus', 'Bot Grace', 'Bot Alan', 'Bot Edsger',
               'Bot Barbara', 'Bot Ken', 'Bot Margaret', 'Bot Donald'];

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const stamp = () => new Date().toLocaleTimeString();

async function makeBot(index) {
  const name = NAMES[index % NAMES.length] ?? `Bot ${index + 1}`;

  const session = await api('/api/v1/auth/session', {
    method: 'POST',
    body: { displayName: name, deviceId: `bot-${randomUUID()}` },
  });
  if (session.status !== 201) {
    throw new Error(`${name}: session failed (${session.status}) ${JSON.stringify(session.body)}`);
  }
  const { token, user } = session.body;

  const joined = await api(`/api/v1/rooms/${ROOM_CODE}/join`, {
    method: 'POST',
    token,
    body: {},
  });
  if (joined.status !== 200) {
    // The most common cause by far is a mistyped or stale room code.
    throw new Error(
      `${name}: join failed (${joined.status}) ${joined.body?.error?.message ?? ''}`,
    );
  }

  const roomId = joined.body.room.roomId;

  const socket = ioClient(`${BASE}/rooms`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    forceNew: true,
  });

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (e) => reject(new Error(`${name}: socket ${e.message}`)));
    setTimeout(() => reject(new Error(`${name}: socket connect timed out`)), 10_000);
  });

  const ack = await socket.emitWithAck('subscribe_room', { roomId });
  if (!ack?.ok) throw new Error(`${name}: subscribe failed ${JSON.stringify(ack)}`);

  // Only the first bot narrates, or three bots would triple every line.
  if (index === 0) {
    socket.on('user_joined', (p) =>
      console.log(`[${stamp()}] + ${p.participant.displayName} joined (${p.participants.length} in room)`));

    socket.on('user_left', (p) =>
      console.log(`[${stamp()}] - someone left (${p.reason}), ${p.participants.length} remain`));

    socket.on('draft_shared', (p) =>
      console.log(`[${stamp()}] ♪ draft shared: "${p.sharedDraft.draft.name}" ` +
                  `${p.sharedDraft.draft.durationMs}ms, effect=${p.sharedDraft.draft.effect}`));

    socket.on('spin_started', (p) =>
      console.log(`\n[${stamp()}] ▶ SPIN STARTED with ${p.spin.participants.length} players: ` +
                  p.spin.participants.map((x) => x.displayName).join(', ')));

    socket.on('user_eliminated', (p) =>
      console.log(`[${stamp()}]   ✗ ${p.eliminatedDisplayName} out ` +
                  `(#${p.eliminationOrder}, ${p.reason}) — ${p.remainingParticipants.length} left`));

    socket.on('winner_announced', (p) =>
      console.log(`[${stamp()}] 🏆 WINNER: ${p.winner.displayName}\n`));

    socket.on('spin_aborted', (p) =>
      console.log(`[${stamp()}] ✖ spin aborted (${p.reason})`));
  }

  socket.on('disconnect', (reason) => console.log(`[${stamp()}] ${name} socket lost: ${reason}`));

  return { name, userId: user.userId, roomId, socket };
}

async function main() {
  console.log(`\nJoining ${BOT_COUNT} bot(s) to room ${ROOM_CODE} on ${BASE}\n`);

  // Check the backend is actually up before producing a confusing auth error.
  try {
    const health = await api('/health');
    if (health.status !== 200) throw new Error(`/health returned ${health.status}`);
  } catch (err) {
    console.error(`Cannot reach the backend at ${BASE}`);
    console.error(`  ${err.message}`);
    console.error(`\nIs it running?  docker compose up -d\n`);
    process.exit(1);
  }

  const bots = [];
  for (let i = 0; i < BOT_COUNT; i += 1) {
    try {
      const bot = await makeBot(i);
      bots.push(bot);
      console.log(`  connected: ${bot.name}`);
    } catch (err) {
      console.error(`\n  ${err.message}\n`);
      if (String(err.message).includes('join failed')) {
        console.error(`Check the room code. It is shown under the room name in the app,`);
        console.error(`and it is 6 characters from the alphabet 23456789ABCDEFGHJKMNPQRSTVWXYZ.\n`);
      }
      for (const b of bots) b.socket.disconnect();
      process.exit(1);
    }
  }

  const state = await api(`/api/v1/rooms/${bots[0].roomId}/state`, {
    method: 'GET',
    token: undefined,
  }).catch(() => null);

  console.log(`\n${bots.length} bot(s) in the room. With you that is ${bots.length + 1} players.`);
  console.log(bots.length + 1 >= 3
    ? `Enough to start a spin — tap "Start spin" in the app.\n`
    : `You need at least 3. Re-run with a higher bot count.\n`);
  console.log(`Watching events. Ctrl+C to disconnect the bots.\n`);
  if (state) { /* state fetch is best-effort; bots already report via sockets */ }

  const shutdown = () => {
    console.log(`\nDisconnecting ${bots.length} bot(s)...`);
    for (const b of bots) b.socket.disconnect();
    // They stay members until the 15s disconnect grace period expires, which is
    // itself worth watching in the app: they show as "reconnecting" first.
    console.log(`Done. They will drop out of the room after the grace period.\n`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Hold the process open so the sockets stay connected.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}\n`);
  process.exit(1);
});
