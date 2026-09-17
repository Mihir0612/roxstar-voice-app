package com.roxstar.app.data.api

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

/**
 * Wire DTOs.
 *
 * These mirror `/docs/api/openapi.yaml` and the backend's `src/models/dto.ts`
 * field for field. They are the contract the integration audit called
 * "mismatch #14-20"; keeping them in one file makes a drift easy to spot in
 * review.
 */

@JsonClass(generateAdapter = true)
data class CreateSessionRequest(
    val displayName: String,
    val deviceId: String,
)

@JsonClass(generateAdapter = true)
data class SessionResponse(
    val token: String,
    val expiresIn: Long,
    val user: UserDto,
)

@JsonClass(generateAdapter = true)
data class UserDto(
    val userId: String,
    val displayName: String,
)

@JsonClass(generateAdapter = true)
data class CreateRoomRequest(
    val name: String,
)

@JsonClass(generateAdapter = true)
data class RoomDto(
    val roomId: String,
    val code: String,
    val name: String,
    val ownerId: String,
    val status: String,
    val createdAt: String,
)

@JsonClass(generateAdapter = true)
data class CreateRoomResponse(val room: RoomDto)

@JsonClass(generateAdapter = true)
data class ParticipantDto(
    val userId: String,
    val displayName: String,
    val role: String,
    val connectionStatus: String,
    val joinedAt: String,
) {
    val isConnected: Boolean get() = connectionStatus == "CONNECTED"
    val canStartSpin: Boolean get() = role == "OWNER" || role == "ADMIN"
}

@JsonClass(generateAdapter = true)
data class DraftDto(
    val draftId: String,
    val name: String,
    val durationMs: Long,
    val effect: String,
    val hostedFileUrl: String?,
    val ownerId: String,
    val createdAt: String,
)

@JsonClass(generateAdapter = true)
data class SharedDraftDto(
    val draft: DraftDto,
    val sharedBy: String,
    val sharedAt: String,
)

@JsonClass(generateAdapter = true)
data class SpinParticipantDto(
    val userId: String,
    val displayName: String,
    val status: String,
    val eliminationOrder: Int?,
    val eliminatedAt: String?,
)

@JsonClass(generateAdapter = true)
data class SpinDto(
    val spinId: String,
    val roomId: String,
    val status: String,
    val startedBy: String?,
    val startedAt: String?,
    val completedAt: String?,
    val winner: UserDto?,
    val abortReason: String?,
    val eliminationIntervalMs: Long,
    val nextEliminationAt: String?,
    val participants: List<SpinParticipantDto>,
    val remainingParticipants: List<SpinParticipantDto>,
    val eliminatedParticipants: List<SpinParticipantDto>,
) {
    val isRunning: Boolean get() = status == "RUNNING"
    val isFinished: Boolean get() = status == "COMPLETED" || status == "ABORTED"
}

@JsonClass(generateAdapter = true)
data class RoomStateDto(
    val room: RoomDto,
    val participants: List<ParticipantDto>,
    val sharedDraft: SharedDraftDto?,
    val activeSpin: SpinDto?,
    val lastSpin: SpinDto?,
)

@JsonClass(generateAdapter = true)
data class JoinRoomResponse(
    val room: RoomDto,
    val member: ParticipantDto,
    val state: RoomStateDto,
)

@JsonClass(generateAdapter = true)
data class LeaveRoomResponse(val left: Boolean)

@JsonClass(generateAdapter = true)
data class ShareDraftRequest(
    val draftId: String,
    val name: String,
    val durationMs: Long,
    val effect: String,
    // Always null from this client: drafts are metadata-only (D10) and the
    // audio never leaves the device. The field exists because the contract
    // allows a hosted URL, not because we produce one.
    val hostedFileUrl: String? = null,
)

@JsonClass(generateAdapter = true)
data class ShareDraftResponse(
    val sharedDraft: SharedDraftDto,
    val draft: DraftDto,
)

@JsonClass(generateAdapter = true)
data class StartSpinResponse(val spin: SpinDto)

@JsonClass(generateAdapter = true)
data class GetSpinResponse(val spin: SpinDto)

@JsonClass(generateAdapter = true)
data class DraftListResponse(val drafts: List<DraftDto>)

/** Error envelope (D21). Every non-2xx response has this shape. */
@JsonClass(generateAdapter = true)
data class ApiErrorEnvelope(
    val error: ApiErrorBody,
    val requestId: String?,
)

@JsonClass(generateAdapter = true)
data class ApiErrorBody(
    val code: String,
    val message: String,
    @Json(name = "details") val details: Map<String, Any?>? = null,
)
