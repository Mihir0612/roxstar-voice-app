package com.roxstar.app.data.ws

import android.util.Log
import com.roxstar.app.data.api.ApiClient
import com.roxstar.app.data.api.ParticipantDto
import com.roxstar.app.data.api.RoomStateDto
import com.roxstar.app.data.api.SharedDraftDto
import com.roxstar.app.data.api.SpinDto
import com.roxstar.app.data.api.UserDto
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.net.URI

private const val TAG = "RoomSocket"

/** Connection state the UI renders directly. */
enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

/**
 * Server-to-client events, parsed into types.
 *
 * `spin_aborted` is here because D11 can end a spin with nobody left; leaving
 * clients on a RUNNING screen forever would be worse than handling one extra
 * event.
 */
sealed interface RoomEvent {
    val eventId: String

    data class UserJoined(
        override val eventId: String,
        val participant: ParticipantDto,
        val participants: List<ParticipantDto>,
    ) : RoomEvent

    data class UserLeft(
        override val eventId: String,
        val userId: String,
        val reason: String,
        val participants: List<ParticipantDto>,
    ) : RoomEvent

    data class DraftShared(
        override val eventId: String,
        val sharedDraft: SharedDraftDto,
    ) : RoomEvent

    data class SpinStarted(override val eventId: String, val spin: SpinDto) : RoomEvent

    data class UserEliminated(
        override val eventId: String,
        val eliminatedUserId: String,
        val eliminatedDisplayName: String,
        val eliminationOrder: Int,
        /** SPIN = drawn by the wheel, LEFT = forfeited by leaving (D11). */
        val reason: String,
        val spin: SpinDto,
    ) : RoomEvent

    data class WinnerAnnounced(
        override val eventId: String,
        val winner: UserDto,
        val spin: SpinDto,
    ) : RoomEvent

    data class SpinAborted(
        override val eventId: String,
        val reason: String,
        val spin: SpinDto,
    ) : RoomEvent

    /** The authoritative snapshot. Always wins over accumulated local state. */
    data class RoomStateSnapshot(
        override val eventId: String,
        val state: RoomStateDto,
    ) : RoomEvent
}

/**
 * Socket.IO client for the `/rooms` namespace.
 *
 * Three rules this class exists to enforce:
 *
 *  1. The client never emits an authoritative event. It may only subscribe and
 *     unsubscribe; everything else is server-sent.
 *  2. Every event is deduplicated on `eventId` (D17). A reconnect can redeliver
 *     an event, and without this the UI would show the same elimination twice.
 *  3. `room_state` supersedes everything. After a reconnect the snapshot is the
 *     truth, not whatever the client accumulated while it was away.
 */
class RoomSocket(
    private val baseUrl: String = ApiClient.baseUrl,
    private val tokenProvider: () -> String?,
) {
    private val moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()
    private val stateAdapter = moshi.adapter(RoomStateDto::class.java)
    private val spinAdapter = moshi.adapter(SpinDto::class.java)
    private val participantAdapter = moshi.adapter(ParticipantDto::class.java)
    private val sharedDraftAdapter = moshi.adapter(SharedDraftDto::class.java)
    private val userAdapter = moshi.adapter(UserDto::class.java)

    private var socket: Socket? = null
    private var subscribedRoomId: String? = null

    private val _connection = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _events = MutableSharedFlow<RoomEvent>(
        // Replay 0 with a generous buffer: a slow collector during a spin must
        // not drop an elimination, but a late subscriber should not replay old
        // ones either -- it gets room_state instead.
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.SUSPEND,
    )
    val events: SharedFlow<RoomEvent> = _events.asSharedFlow()

    /**
     * Dedupe window (D17).
     *
     * Bounded: an unbounded set would grow for the life of the connection. 256
     * is far more than the number of events a single spin can produce, so a
     * genuine duplicate is always still in the window.
     */
    private val seenEventIds = object : LinkedHashSet<String>() {
        fun addBounded(id: String): Boolean {
            if (!add(id)) return false
            if (size > 256) iterator().let { it.next(); it.remove() }
            return true
        }
    }

    fun connect() {
        val token = tokenProvider()
        if (token == null) {
            Log.w(TAG, "Refusing to connect without a session token")
            return
        }
        if (socket?.connected() == true) return

        _connection.value = ConnectionState.CONNECTING

        val options = IO.Options.builder()
            .setTransports(arrayOf(io.socket.engineio.client.transports.WebSocket.NAME))
            // Exponential backoff, capped. Unbounded retries would drain the
            // battery of a phone that has genuinely lost the network.
            .setReconnection(true)
            .setReconnectionAttempts(Int.MAX_VALUE)
            .setReconnectionDelay(1_000)
            .setReconnectionDelayMax(15_000)
            .setRandomizationFactor(0.5)
            // D8: the handshake carries the same bearer token as REST.
            .setAuth(mapOf("token" to token))
            .build()

        socket = IO.socket(URI.create("${baseUrl.trimEnd('/')}/rooms"), options).apply {
            on(Socket.EVENT_CONNECT) {
                Log.i(TAG, "Connected")
                _connection.value = ConnectionState.CONNECTED
                // D19: one code path for first connect and reconnect. Re-subscribe
                // immediately so the server sends a fresh room_state.
                subscribedRoomId?.let { emitSubscribe(it) }
            }
            on(Socket.EVENT_DISCONNECT) {
                Log.w(TAG, "Disconnected")
                _connection.value = ConnectionState.RECONNECTING
            }
            on(Socket.EVENT_CONNECT_ERROR) { args ->
                Log.w(TAG, "Connect error: ${args.firstOrNull()}")
                _connection.value = ConnectionState.RECONNECTING
            }

            on("room_state") { args -> handle(args) { id, json -> parseRoomState(id, json) } }
            on("user_joined") { args -> handle(args) { id, json -> parseUserJoined(id, json) } }
            on("user_left") { args -> handle(args) { id, json -> parseUserLeft(id, json) } }
            on("draft_shared") { args -> handle(args) { id, json -> parseDraftShared(id, json) } }
            on("spin_started") { args -> handle(args) { id, json -> parseSpinStarted(id, json) } }
            on("user_eliminated") { args -> handle(args) { id, json -> parseEliminated(id, json) } }
            on("winner_announced") { args -> handle(args) { id, json -> parseWinner(id, json) } }
            on("spin_aborted") { args -> handle(args) { id, json -> parseAborted(id, json) } }

            connect()
        }
    }

    fun subscribe(roomId: String) {
        subscribedRoomId = roomId
        if (socket?.connected() == true) emitSubscribe(roomId)
    }

    fun unsubscribe() {
        val roomId = subscribedRoomId ?: return
        socket?.emit("unsubscribe_room", JSONObject(mapOf("roomId" to roomId)))
        subscribedRoomId = null
    }

    fun disconnect() {
        unsubscribe()
        socket?.off()
        socket?.disconnect()
        socket = null
        seenEventIds.clear()
        _connection.value = ConnectionState.DISCONNECTED
    }

    private fun emitSubscribe(roomId: String) {
        socket?.emit("subscribe_room", JSONObject(mapOf("roomId" to roomId)))
    }

    /**
     * Shared parsing path: extract the eventId, drop duplicates, then decode.
     *
     * Parsing is wrapped in runCatching because a malformed event must not take
     * the socket's reader thread down with it -- one bad payload would
     * otherwise stop every subsequent event from arriving.
     */
    private inline fun handle(args: Array<out Any>, parse: (String, JSONObject) -> RoomEvent?) {
        val json = args.firstOrNull() as? JSONObject ?: return
        val eventId = json.optString("eventId").takeIf { it.isNotEmpty() } ?: return

        // D17: a reconnect can redeliver. Showing the same elimination twice
        // would be a visible bug.
        if (!seenEventIds.addBounded(eventId)) {
            Log.d(TAG, "Dropping duplicate event $eventId")
            return
        }

        runCatching { parse(eventId, json) }
            .onSuccess { event -> event?.let { _events.tryEmit(it) } }
            .onFailure { Log.e(TAG, "Failed to parse event $eventId", it) }
    }

    private fun parseRoomState(id: String, json: JSONObject): RoomEvent? =
        stateAdapter.fromJson(json.toString())?.let { RoomEvent.RoomStateSnapshot(id, it) }

    private fun parseUserJoined(id: String, json: JSONObject): RoomEvent? {
        val participant = participantAdapter.fromJson(json.getJSONObject("participant").toString())
            ?: return null
        return RoomEvent.UserJoined(id, participant, parseParticipants(json))
    }

    private fun parseUserLeft(id: String, json: JSONObject): RoomEvent =
        RoomEvent.UserLeft(
            eventId = id,
            userId = json.getString("userId"),
            reason = json.optString("reason", "EXPLICIT"),
            participants = parseParticipants(json),
        )

    private fun parseDraftShared(id: String, json: JSONObject): RoomEvent? =
        sharedDraftAdapter.fromJson(json.getJSONObject("sharedDraft").toString())
            ?.let { RoomEvent.DraftShared(id, it) }

    private fun parseSpinStarted(id: String, json: JSONObject): RoomEvent? =
        spinAdapter.fromJson(json.getJSONObject("spin").toString())
            ?.let { RoomEvent.SpinStarted(id, it) }

    private fun parseEliminated(id: String, json: JSONObject): RoomEvent? {
        val spin = spinAdapter.fromJson(json.getJSONObject("spin").toString()) ?: return null
        return RoomEvent.UserEliminated(
            eventId = id,
            eliminatedUserId = json.getString("eliminatedUserId"),
            eliminatedDisplayName = json.optString("eliminatedDisplayName"),
            eliminationOrder = json.optInt("eliminationOrder"),
            reason = json.optString("reason", "SPIN"),
            spin = spin,
        )
    }

    private fun parseWinner(id: String, json: JSONObject): RoomEvent? {
        val spin = spinAdapter.fromJson(json.getJSONObject("spin").toString()) ?: return null
        val winner = userAdapter.fromJson(json.getJSONObject("winner").toString()) ?: return null
        return RoomEvent.WinnerAnnounced(id, winner, spin)
    }

    private fun parseAborted(id: String, json: JSONObject): RoomEvent? {
        val spin = spinAdapter.fromJson(json.getJSONObject("spin").toString()) ?: return null
        return RoomEvent.SpinAborted(id, json.optString("reason", "UNKNOWN"), spin)
    }

    private fun parseParticipants(json: JSONObject): List<ParticipantDto> {
        val array = json.optJSONArray("participants") ?: return emptyList()
        return (0 until array.length()).mapNotNull { i ->
            participantAdapter.fromJson(array.getJSONObject(i).toString())
        }
    }
}
