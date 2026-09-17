import { getLogger } from '../logging/index.js';
import type { ServerEventMap, ServerEventName } from './events.js';

/**
 * Minimal shape of what we need from Socket.IO. Typed structurally so both a
 * Server and a Namespace satisfy it without a cast -- we broadcast on the
 * `/rooms` namespace, not on the root server.
 */
export interface Emittable {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

/**
 * Broadcast seam.
 *
 * Services depend on this interface, not on Socket.IO. That keeps the spin
 * engine testable without opening sockets, and it is also the boundary that
 * enforces "persist first, broadcast second" -- a service calls the
 * broadcaster only after its transaction has committed.
 */
export interface RoomBroadcaster {
  emit<E extends ServerEventName>(roomId: string, event: E, payload: ServerEventMap[E]): void;
}

export const roomChannel = (roomId: string): string => `room:${roomId}`;

export class SocketIoBroadcaster implements RoomBroadcaster {
  constructor(private readonly target: Emittable) {}

  emit<E extends ServerEventName>(roomId: string, event: E, payload: ServerEventMap[E]): void {
    this.target.to(roomChannel(roomId)).emit(event, payload);
  }
}

/** Collects emitted events instead of sending them. Used by the unit tests. */
export class RecordingBroadcaster implements RoomBroadcaster {
  readonly sent: Array<{ roomId: string; event: ServerEventName; payload: unknown }> = [];

  emit<E extends ServerEventName>(roomId: string, event: E, payload: ServerEventMap[E]): void {
    this.sent.push({ roomId, event, payload });
  }

  eventsOfType(event: ServerEventName): unknown[] {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Drops everything. Installed by default so that a service invoked before the
 * Socket.IO server is wired up logs a warning instead of throwing -- a missing
 * broadcast must never roll back a committed state change.
 */
class NullBroadcaster implements RoomBroadcaster {
  emit(roomId: string, event: ServerEventName): void {
    getLogger().warn({ roomId, event }, 'Broadcast dropped: no broadcaster registered');
  }
}

let current: RoomBroadcaster = new NullBroadcaster();

export const setBroadcaster = (b: RoomBroadcaster): void => {
  current = b;
};

export const getBroadcaster = (): RoomBroadcaster => current;

export const resetBroadcaster = (): void => {
  current = new NullBroadcaster();
};
