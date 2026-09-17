/**
 * Domain types.
 *
 * These mirror the database rows exactly (snake_case is mapped at the
 * repository boundary). DTOs sent to clients live in `dto.ts` -- the split
 * exists so an internal column can be added without leaking into the frozen
 * wire contract.
 */

export type RoomStatus = 'OPEN' | 'CLOSED';
export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type MembershipStatus = 'ACTIVE' | 'LEFT';
export type ConnectionStatus = 'CONNECTED' | 'DISCONNECTED';
export type SpinStatus = 'WAITING' | 'RUNNING' | 'COMPLETED' | 'ABORTED';
export type ParticipantStatus = 'ACTIVE' | 'ELIMINATED' | 'LEFT' | 'WINNER';
export type AudioEffect = 'NONE' | 'ECHO' | 'REVERB' | 'PITCH_SHIFT';
export type SpinAbortReason = 'NO_PARTICIPANTS' | 'ROOM_CLOSED' | 'MANUAL';

export type SpinEventType = 'spin_started' | 'user_eliminated' | 'winner_announced' | 'spin_aborted';

/** Why a participant left the spin -- surfaced on `user_eliminated` (D11). */
export type EliminationReason = 'SPIN' | 'LEFT';

export interface User {
  id: string;
  displayName: string;
  deviceId: string;
  createdAt: Date;
}

export interface Room {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  status: RoomStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoomMember {
  id: string;
  roomId: string;
  userId: string;
  role: MemberRole;
  membershipStatus: MembershipStatus;
  connectionStatus: ConnectionStatus;
  joinedAt: Date;
  leftAt: Date | null;
  lastSeenAt: Date;
  disconnectedAt: Date | null;
}

export interface RoomMemberWithUser extends RoomMember {
  displayName: string;
}

export interface Draft {
  id: string;
  ownerId: string;
  name: string;
  durationMs: number;
  effect: AudioEffect;
  hostedFileUrl: string | null;
  createdAt: Date;
}

export interface SharedDraft {
  id: string;
  roomId: string;
  draftId: string;
  sharedBy: string;
  sharedAt: Date;
  draft: Draft;
}

export interface Spin {
  id: string;
  roomId: string;
  status: SpinStatus;
  startedBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  winnerUserId: string | null;
  nextEliminationAt: Date | null;
  eliminationIntervalMs: number;
  abortReason: SpinAbortReason | null;
  createdAt: Date;
}

export interface SpinParticipant {
  id: string;
  spinId: string;
  userId: string;
  eligible: boolean;
  eliminationOrder: number | null;
  eliminatedAt: Date | null;
  finalStatus: ParticipantStatus;
}

export interface SpinParticipantWithUser extends SpinParticipant {
  displayName: string;
}

export interface SpinEventRow {
  seq: string;
  eventId: string;
  spinId: string;
  roomId: string;
  eventType: SpinEventType;
  payload: Record<string, unknown>;
  createdAt: Date;
}
