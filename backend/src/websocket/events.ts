import { randomUUID } from 'node:crypto';
import type { ParticipantDTO, RoomStateDTO, SharedDraftDTO, SpinDTO, UserDTO } from '../models/dto.js';
import type { EliminationReason } from '../models/types.js';

/**
 * The seven mandatory server-to-client events, plus `spin_aborted`.
 *
 * `spin_aborted` is not in the PDF's mandatory list, but D11 can end a spin
 * with nobody left, and silently leaving clients on a RUNNING screen forever
 * would be worse than adding one honest event. It is additive -- no mandatory
 * event changed shape to accommodate it.
 */
export const SERVER_EVENTS = {
  USER_JOINED: 'user_joined',
  USER_LEFT: 'user_left',
  DRAFT_SHARED: 'draft_shared',
  SPIN_STARTED: 'spin_started',
  USER_ELIMINATED: 'user_eliminated',
  WINNER_ANNOUNCED: 'winner_announced',
  ROOM_STATE: 'room_state',
  SPIN_ABORTED: 'spin_aborted',
} as const;

export type ServerEventName = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

/** Client-to-server events. Clients may only subscribe -- never assert state. */
export const CLIENT_EVENTS = {
  SUBSCRIBE_ROOM: 'subscribe_room',
  UNSUBSCRIBE_ROOM: 'unsubscribe_room',
} as const;

/**
 * Envelope carried by every broadcast (D17).
 *
 * `eventId` is the client dedupe key. `seq` is present only on spin events,
 * where it comes from the spin_events primary key and gives a total order a
 * client can use to detect a gap after a reconnect.
 */
export interface EventEnvelope {
  eventId: string;
  occurredAt: string;
  roomId: string;
  seq?: string;
}

export const envelope = (roomId: string, eventId = randomUUID(), occurredAt = new Date()): EventEnvelope => ({
  eventId,
  occurredAt: occurredAt.toISOString(),
  roomId,
});

/* ----------------------------- payload types ------------------------------ */

export interface UserJoinedPayload extends EventEnvelope {
  participant: ParticipantDTO;
  participants: ParticipantDTO[];
}

export interface UserLeftPayload extends EventEnvelope {
  userId: string;
  /** EXPLICIT = called leave; DISCONNECT_TIMEOUT = grace period expired (D13). */
  reason: 'EXPLICIT' | 'DISCONNECT_TIMEOUT';
  participants: ParticipantDTO[];
}

export interface DraftSharedPayload extends EventEnvelope {
  sharedDraft: SharedDraftDTO;
}

export interface SpinStartedPayload extends EventEnvelope {
  spin: SpinDTO;
}

export interface UserEliminatedPayload extends EventEnvelope {
  spinId: string;
  eliminatedUserId: string;
  eliminatedDisplayName: string;
  eliminationOrder: number;
  /** SPIN = drawn by the wheel; LEFT = forfeited by leaving (D11). */
  reason: EliminationReason;
  remainingParticipants: SpinDTO['remainingParticipants'];
  spin: SpinDTO;
}

export interface WinnerAnnouncedPayload extends EventEnvelope {
  spinId: string;
  winner: UserDTO;
  spin: SpinDTO;
}

export interface SpinAbortedPayload extends EventEnvelope {
  spinId: string;
  reason: string;
  spin: SpinDTO;
}

export type RoomStatePayload = EventEnvelope & RoomStateDTO;

export interface ServerEventMap {
  user_joined: UserJoinedPayload;
  user_left: UserLeftPayload;
  draft_shared: DraftSharedPayload;
  spin_started: SpinStartedPayload;
  user_eliminated: UserEliminatedPayload;
  winner_announced: WinnerAnnouncedPayload;
  room_state: RoomStatePayload;
  spin_aborted: SpinAbortedPayload;
}
