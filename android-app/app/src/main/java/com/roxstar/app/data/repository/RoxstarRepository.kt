package com.roxstar.app.data.repository

import android.content.Context
import android.provider.Settings
import com.roxstar.app.data.api.ApiClient
import com.roxstar.app.data.api.ApiErrorBody
import com.roxstar.app.data.api.CreateRoomRequest
import com.roxstar.app.data.api.CreateSessionRequest
import com.roxstar.app.data.api.DraftDto
import com.roxstar.app.data.api.RoomDto
import com.roxstar.app.data.api.RoomStateDto
import com.roxstar.app.data.api.RoxstarApi
import com.roxstar.app.data.api.ShareDraftRequest
import com.roxstar.app.data.api.SharedDraftDto
import com.roxstar.app.data.api.SpinDto
import com.roxstar.app.data.api.UserDto
import com.roxstar.app.data.local.DraftDao
import com.roxstar.app.data.local.DraftEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import retrofit2.Response
import java.io.IOException
import java.util.UUID

/**
 * Result type for every network call.
 *
 * Three cases, not two: a validation rejection from the server and a dead
 * network need different UI, and collapsing them into one `Throwable` is how
 * an app ends up telling the user "check your connection" when the real
 * problem is that the room needs one more player.
 */
sealed interface ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>

    /** The server answered and said no. `code` is the stable machine code (D21). */
    data class Failure(val code: String, val message: String, val httpStatus: Int) : ApiResult<Nothing>

    /** No answer at all: offline, DNS failure, timeout. Always worth retrying. */
    data class NetworkError(val cause: Throwable) : ApiResult<Nothing>
}

val ApiResult<*>.errorMessage: String?
    get() = when (this) {
        is ApiResult.Failure -> message
        is ApiResult.NetworkError -> "Cannot reach the server. Check your connection."
        else -> null
    }

/**
 * Single repository over REST plus the local draft store.
 *
 * One class rather than four: the surface is small, and splitting it would add
 * indirection without adding a boundary that anything actually needs.
 */
class RoxstarRepository(
    private val context: Context,
    private val api: RoxstarApi = ApiClient.api,
    private val draftDao: DraftDao,
) {
    /* -------------------------------- session ------------------------------- */

    /**
     * A stable per-install identifier (D8).
     *
     * ANDROID_ID is per-app-signing-key per-device and resets on factory reset,
     * which is exactly the lifetime a session should have. It is deliberately
     * not an advertising id or a hardware serial -- no tracking identifier is
     * collected, and the value never leaves the device except as this opaque
     * login key.
     */
    @Suppress("HardwareIds")
    private val deviceId: String by lazy {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?: "fallback-${UUID.randomUUID()}"
    }

    suspend fun createSession(displayName: String): ApiResult<UserDto> = call {
        api.createSession(CreateSessionRequest(displayName = displayName, deviceId = deviceId))
    }.map { response ->
        ApiClient.tokenStore.set(response.token)
        response.user
    }

    fun signOut() = ApiClient.tokenStore.clear()

    val isAuthenticated: Boolean get() = ApiClient.tokenStore.isAuthenticated

    val token: String? get() = ApiClient.tokenStore.token

    /* --------------------------------- rooms -------------------------------- */

    suspend fun createRoom(name: String): ApiResult<RoomDto> =
        call { api.createRoom(CreateRoomRequest(name), newIdempotencyKey()) }.map { it.room }

    suspend fun joinRoom(roomIdOrCode: String): ApiResult<RoomStateDto> =
        call { api.joinRoom(roomIdOrCode.trim().uppercase(), emptyMap(), newIdempotencyKey()) }
            .map { it.state }

    suspend fun leaveRoom(roomId: String): ApiResult<Boolean> =
        call { api.leaveRoom(roomId) }.map { it.left }

    suspend fun getRoomState(roomId: String): ApiResult<RoomStateDto> =
        call { api.getRoomState(roomId) }

    /* --------------------------------- spin --------------------------------- */

    /**
     * Start a spin.
     *
     * The Idempotency-Key is generated per attempt, which is the point: if the
     * response is lost and the user taps again, the same key would replay --
     * but a *deliberate* second spin later gets a fresh key. The caller passes
     * a stable key when it is retrying the same tap.
     */
    suspend fun startSpin(roomId: String, idempotencyKey: String): ApiResult<SpinDto> =
        call { api.startSpin(roomId, emptyMap(), idempotencyKey) }.map { it.spin }

    suspend fun getSpin(roomId: String): ApiResult<SpinDto> =
        call { api.getSpin(roomId) }.map { it.spin }

    /* -------------------------------- drafts -------------------------------- */

    fun observeDrafts(): Flow<List<DraftEntity>> = draftDao.observeAll()

    suspend fun saveDraft(
        draftId: String,
        name: String,
        filePath: String,
        durationMs: Long,
        effect: String,
    ) = withContext(Dispatchers.IO) {
        draftDao.upsert(
            DraftEntity(
                draftId = draftId,
                name = name,
                filePath = filePath,
                durationMs = durationMs,
                effect = effect,
                createdAt = System.currentTimeMillis(),
            )
        )
    }

    suspend fun deleteDraft(draftId: String) = withContext(Dispatchers.IO) {
        val draft = draftDao.findById(draftId)
        // Remove the audio as well as the row. Leaving orphaned WAVs behind
        // would quietly fill the user's storage.
        draft?.file?.delete()
        draftDao.delete(draftId)
    }

    /**
     * Share draft metadata with a room (D10).
     *
     * The WAV is not uploaded and `hostedFileUrl` stays null: live audio is out
     * of scope, and nothing in the assessment asks for file hosting.
     */
    suspend fun shareDraft(roomId: String, draft: DraftEntity): ApiResult<SharedDraftDto> {
        val result = call {
            api.shareDraft(
                roomId = roomId,
                body = ShareDraftRequest(
                    draftId = draft.draftId,
                    name = draft.name,
                    durationMs = draft.durationMs,
                    effect = draft.effect,
                    hostedFileUrl = null,
                ),
                idempotencyKey = newIdempotencyKey(),
            )
        }.map { it.sharedDraft }

        if (result is ApiResult.Success) {
            withContext(Dispatchers.IO) {
                draftDao.markShared(draft.draftId, System.currentTimeMillis())
            }
        }
        return result
    }

    suspend fun listRemoteDrafts(): ApiResult<List<DraftDto>> =
        call { api.listDrafts() }.map { it.drafts }

    /* -------------------------------- plumbing ------------------------------- */

    private fun newIdempotencyKey(): String = UUID.randomUUID().toString()

    /**
     * Run a call and classify the outcome.
     *
     * IOException means the request never got an answer; anything else with a
     * response body is the server deliberately refusing, and its `code` is what
     * the UI branches on.
     */
    private suspend fun <T> call(block: suspend () -> Response<T>): ApiResult<T> =
        withContext(Dispatchers.IO) {
            try {
                val response = block()
                if (response.isSuccessful) {
                    val body = response.body()
                    @Suppress("UNCHECKED_CAST")
                    when {
                        body != null -> ApiResult.Success(body)
                        // 204 No Content is a success with no payload.
                        response.code() == 204 -> ApiResult.Success(Unit as T)
                        else -> ApiResult.Failure("EMPTY_RESPONSE", "The server returned no data.", response.code())
                    }
                } else {
                    val error: ApiErrorBody = ApiClient.parseError(response.errorBody()?.string())
                    ApiResult.Failure(error.code, error.message, response.code())
                }
            } catch (io: IOException) {
                ApiResult.NetworkError(io)
            } catch (t: Throwable) {
                // A parse failure or an unexpected runtime error. Reported as a
                // network error so the UI offers a retry rather than a dead end.
                ApiResult.NetworkError(t)
            }
        }
}

private inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Success -> ApiResult.Success(transform(data))
    is ApiResult.Failure -> this
    is ApiResult.NetworkError -> this
}
