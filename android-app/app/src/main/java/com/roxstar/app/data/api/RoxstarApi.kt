package com.roxstar.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * REST surface, matching `/docs/api/openapi.yaml` exactly.
 *
 * Every call returns `Response<T>` rather than a bare `T` so the repository can
 * read the status code and the error envelope. Letting Retrofit throw on 4xx
 * would collapse "not enough players" and "the network is down" into the same
 * exception, and the UI has to tell those apart.
 */
interface RoxstarApi {

    @POST("api/v1/auth/session")
    suspend fun createSession(@Body body: CreateSessionRequest): Response<SessionResponse>

    /* -------------------------------- rooms -------------------------------- */

    @POST("api/v1/rooms")
    suspend fun createRoom(
        @Body body: CreateRoomRequest,
        // D18: retrying a create must not leave two rooms behind.
        @Header("Idempotency-Key") idempotencyKey: String,
    ): Response<CreateRoomResponse>

    /** [roomIdOrCode] accepts either a room UUID or the 6-character join code. */
    @POST("api/v1/rooms/{roomIdOrCode}/join")
    suspend fun joinRoom(
        @Path("roomIdOrCode") roomIdOrCode: String,
        @Body body: Map<String, String> = emptyMap(),
        @Header("Idempotency-Key") idempotencyKey: String,
    ): Response<JoinRoomResponse>

    @POST("api/v1/rooms/{roomId}/leave")
    suspend fun leaveRoom(
        @Path("roomId") roomId: String,
        @Body body: Map<String, String> = emptyMap(),
    ): Response<LeaveRoomResponse>

    @GET("api/v1/rooms/{roomId}/state")
    suspend fun getRoomState(@Path("roomId") roomId: String): Response<RoomStateDto>

    /* -------------------------------- drafts ------------------------------- */

    @POST("api/v1/rooms/{roomId}/drafts/share")
    suspend fun shareDraft(
        @Path("roomId") roomId: String,
        @Body body: ShareDraftRequest,
        @Header("Idempotency-Key") idempotencyKey: String,
    ): Response<ShareDraftResponse>

    @GET("api/v1/drafts")
    suspend fun listDrafts(): Response<DraftListResponse>

    @DELETE("api/v1/drafts/{draftId}")
    suspend fun deleteDraft(@Path("draftId") draftId: String): Response<Unit>

    /* --------------------------------- spin -------------------------------- */

    @POST("api/v1/rooms/{roomId}/spin/start")
    suspend fun startSpin(
        @Path("roomId") roomId: String,
        @Body body: Map<String, String> = emptyMap(),
        // Required here, not merely recommended: a retried start that created a
        // second spin is the worst failure this system can produce.
        @Header("Idempotency-Key") idempotencyKey: String,
    ): Response<StartSpinResponse>

    @GET("api/v1/rooms/{roomId}/spin")
    suspend fun getSpin(@Path("roomId") roomId: String): Response<GetSpinResponse>
}
