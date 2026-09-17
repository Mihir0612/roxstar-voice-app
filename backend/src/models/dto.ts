import type {
  Draft,
  Room,
  RoomMemberWithUser,
  SharedDraft,
  Spin,
  SpinParticipantWithUser,
} from './types.js';

/**
 * Wire DTOs -- the frozen contract shared with the Android client
 * (/docs/api/openapi.yaml and /docs/api/websocket-events.md).
 *
 * Mapping here rather than returning rows directly is what stops an internal
 * column (device_id, disconnected_at) from silently becoming public API.
 */

export interface UserDTO {
  userId: string;
  displayName: string;
}

export interface ParticipantDTO {
  userId: string;
  displayName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  connectionStatus: 'CONNECTED' | 'DISCONNECTED';
  joinedAt: string;
}

export interface RoomDTO {
  roomId: string;
  code: string;
  name: string;
  ownerId: string;
  status: 'OPEN' | 'CLOSED';
  createdAt: string;
}

export interface DraftDTO {
  draftId: string;
  name: string;
  durationMs: number;
  effect: string;
  hostedFileUrl: string | null;
  ownerId: string;
  createdAt: string;
}

export interface SharedDraftDTO {
  draft: DraftDTO;
  sharedBy: string;
  sharedAt: string;
}

export interface SpinParticipantDTO {
  userId: string;
  displayName: string;
  status: 'ACTIVE' | 'ELIMINATED' | 'LEFT' | 'WINNER';
  eliminationOrder: number | null;
  eliminatedAt: string | null;
}

export interface SpinDTO {
  spinId: string;
  roomId: string;
  status: 'WAITING' | 'RUNNING' | 'COMPLETED' | 'ABORTED';
  startedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  winner: UserDTO | null;
  abortReason: string | null;
  eliminationIntervalMs: number;
  nextEliminationAt: string | null;
  participants: SpinParticipantDTO[];
  remainingParticipants: SpinParticipantDTO[];
  eliminatedParticipants: SpinParticipantDTO[];
}

export interface RoomStateDTO {
  room: RoomDTO;
  participants: ParticipantDTO[];
  sharedDraft: SharedDraftDTO | null;
  activeSpin: SpinDTO | null;
  /** Present when the latest spin has already finished -- lets a late client
   *  render the result without a second request. */
  lastSpin: SpinDTO | null;
}

/* ----------------------------- mappers ----------------------------------- */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toRoomDTO = (room: Room): RoomDTO => ({
  roomId: room.id,
  code: room.code,
  name: room.name,
  ownerId: room.ownerId,
  status: room.status,
  createdAt: room.createdAt.toISOString(),
});

export const toParticipantDTO = (m: RoomMemberWithUser): ParticipantDTO => ({
  userId: m.userId,
  displayName: m.displayName,
  role: m.role,
  connectionStatus: m.connectionStatus,
  joinedAt: m.joinedAt.toISOString(),
});

export const toDraftDTO = (d: Draft): DraftDTO => ({
  draftId: d.id,
  name: d.name,
  durationMs: d.durationMs,
  effect: d.effect,
  hostedFileUrl: d.hostedFileUrl,
  ownerId: d.ownerId,
  createdAt: d.createdAt.toISOString(),
});

export const toSharedDraftDTO = (s: SharedDraft): SharedDraftDTO => ({
  draft: toDraftDTO(s.draft),
  sharedBy: s.sharedBy,
  sharedAt: s.sharedAt.toISOString(),
});

export const toSpinParticipantDTO = (p: SpinParticipantWithUser): SpinParticipantDTO => ({
  userId: p.userId,
  displayName: p.displayName,
  status: p.finalStatus,
  eliminationOrder: p.eliminationOrder,
  eliminatedAt: iso(p.eliminatedAt),
});

export function toSpinDTO(spin: Spin, participants: SpinParticipantWithUser[]): SpinDTO {
  const all = participants.map(toSpinParticipantDTO);
  const winner = participants.find((p) => p.userId === spin.winnerUserId);

  return {
    spinId: spin.id,
    roomId: spin.roomId,
    status: spin.status,
    startedBy: spin.startedBy,
    startedAt: iso(spin.startedAt),
    completedAt: iso(spin.completedAt),
    winner: winner ? { userId: winner.userId, displayName: winner.displayName } : null,
    abortReason: spin.abortReason,
    eliminationIntervalMs: spin.eliminationIntervalMs,
    nextEliminationAt: iso(spin.nextEliminationAt),
    participants: all,
    // "Remaining" means still able to win: ACTIVE now, or the declared WINNER.
    remainingParticipants: all.filter((p) => p.status === 'ACTIVE' || p.status === 'WINNER'),
    eliminatedParticipants: all
      .filter((p) => p.status === 'ELIMINATED' || p.status === 'LEFT')
      .sort((a, b) => (a.eliminationOrder ?? 0) - (b.eliminationOrder ?? 0)),
  };
}
