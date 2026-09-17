import { getConfig } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import { getLogger } from '../logging/index.js';
import { toParticipantDTO } from '../models/dto.js';
import * as roomRepo from '../repositories/room.repository.js';
import { getBroadcaster } from '../websocket/broadcaster.js';
import { SERVER_EVENTS, envelope } from '../websocket/events.js';
import { flushPending, forfeitOnDeparture, type PendingBroadcast } from './spin.service.js';
import { buildRoomState } from './state.service.js';

/**
 * Presence and the disconnect grace period (D13).
 *
 * A dropped socket is not a departure. Mobile clients lose connectivity
 * constantly -- in a tunnel, on a screen lock, switching from wifi to LTE --
 * and because leaving forfeits an active spin seat (D11), treating every drop
 * as a leave would knock players out of spins for a two-second blip.
 *
 * So: a drop marks the member DISCONNECTED and starts a timer. Only if the
 * grace period expires without a reconnect does `user_left` fire.
 */

/** Socket connected and subscribed to a room. Same path for first connect and reconnect (D19). */
export async function onSubscribe(roomId: string, userId: string): Promise<void> {
  await roomRepo.markConnected(roomId, userId);
  await broadcastPresence(roomId);
}

/** Socket dropped. Starts the grace period; membership is untouched. */
export async function onDisconnect(roomId: string, userId: string): Promise<void> {
  await roomRepo.markDisconnected(roomId, userId);
  await broadcastPresence(roomId);
  getLogger().debug({ roomId, userId }, 'Socket disconnected; grace period started');
}

/**
 * Presence changed without membership changing.
 *
 * Reported as `room_state` rather than a synthetic event: `user_joined` on a
 * reconnect would be a duplicate join, which the client contract forbids, and
 * `room_state` is already defined as the authoritative snapshot.
 */
async function broadcastPresence(roomId: string): Promise<void> {
  try {
    const state = await buildRoomState(roomId);
    getBroadcaster().emit(roomId, SERVER_EVENTS.ROOM_STATE, { ...envelope(roomId), ...state });
  } catch (err) {
    // The room may have been deleted between the disconnect and this read.
    getLogger().debug({ err, roomId }, 'Could not broadcast presence update');
  }
}

export interface SweepResult {
  expired: number;
}

/**
 * Expire grace periods that have run out.
 *
 * Claimed with SKIP LOCKED so overlapping sweeps -- or a second instance --
 * cannot expire the same member twice and emit two `user_left` events.
 */
export async function sweepExpiredDisconnects(limit = 50): Promise<SweepResult> {
  const cfg = getConfig();
  const departures: Array<{ roomId: string; userId: string; pending: PendingBroadcast[] }> = [];

  await withTransaction(async (client) => {
    const expired = await roomRepo.claimExpiredDisconnects(cfg.PRESENCE_GRACE_MS, limit, client);

    for (const member of expired) {
      const left = await roomRepo.markLeft(member.roomId, member.userId, client);
      if (!left) continue;

      // Same rule as an explicit leave: the seat is forfeited (D11).
      const pending = await forfeitOnDeparture(member.roomId, member.userId, client);
      departures.push({ roomId: member.roomId, userId: member.userId, pending });
    }
  });

  for (const d of departures) {
    const participants = (await roomRepo.listActiveMembers(d.roomId)).map(toParticipantDTO);

    getBroadcaster().emit(d.roomId, SERVER_EVENTS.USER_LEFT, {
      ...envelope(d.roomId),
      userId: d.userId,
      reason: 'DISCONNECT_TIMEOUT',
      participants,
    });
    flushPending(d.roomId, d.pending);

    getLogger().info(
      { roomId: d.roomId, userId: d.userId, graceMs: cfg.PRESENCE_GRACE_MS },
      'Membership expired after disconnect grace period',
    );
  }

  return { expired: departures.length };
}
