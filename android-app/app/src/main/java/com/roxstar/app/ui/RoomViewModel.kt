package com.roxstar.app.ui

import android.media.MediaPlayer
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.roxstar.app.data.api.ParticipantDto
import com.roxstar.app.data.api.RoomDto
import com.roxstar.app.data.api.SharedDraftDto
import com.roxstar.app.data.api.SpinDto
import com.roxstar.app.data.local.DraftEntity
import com.roxstar.app.data.repository.ApiResult
import com.roxstar.app.data.repository.RoxstarRepository
import com.roxstar.app.data.repository.errorMessage
import com.roxstar.app.data.ws.ConnectionState
import com.roxstar.app.data.ws.RoomEvent
import com.roxstar.app.data.ws.RoomSocket
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Room and spin screen state.
 *
 * Everything here is a projection of what the server said. The client does not
 * decide eliminations, does not pick a winner, and does not run its own
 * five-second timer: it renders `spin`, which only ever changes because an
 * event or a snapshot arrived.
 */
data class RoomUiState(
    val room: RoomDto? = null,
    val participants: List<ParticipantDto> = emptyList(),
    val sharedDraft: SharedDraftDto? = null,
    val spin: SpinDto? = null,
    val connection: ConnectionState = ConnectionState.DISCONNECTED,
    val currentUserId: String? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    /** Transient feed for the UI, e.g. "Sam was eliminated". */
    val activity: List<String> = emptyList(),
    /** True while the shared draft is being played back on this device. */
    val isPlayingSharedDraft: Boolean = false,
) {
    val isInRoom: Boolean get() = room != null

    /** Whether THIS user may start a spin, per the role the server reported. */
    val canStartSpin: Boolean
        get() = participants.firstOrNull { it.userId == currentUserId }?.canStartSpin == true

    val eligibleCount: Int get() = participants.size

    /**
     * Mirrors the server's rule so the button can be disabled with a reason.
     * The server remains the authority -- this only avoids a pointless
     * round-trip and a confusing error.
     */
    val spinBlockedReason: String?
        get() = when {
            spin?.isRunning == true -> "A spin is already running."
            !canStartSpin -> "Only the room owner or an admin can start a spin."
            eligibleCount < 3 -> "Need at least 3 players (currently $eligibleCount)."
            eligibleCount > 20 -> "Too many players: $eligibleCount (maximum 20)."
            else -> null
        }
}

class RoomViewModel(
    private val repository: RoxstarRepository,
) : ViewModel() {

    private val socket = RoomSocket(tokenProvider = { repository.token })

    private val _state = MutableStateFlow(RoomUiState())
    val state: StateFlow<RoomUiState> = _state.asStateFlow()

    /** MediaPlayer for locally playing back a shared draft on this device. */
    private var player: MediaPlayer? = null

    /**
     * Held so a retried Start Spin reuses the same key (D18).
     *
     * Regenerated on success: the next spin is a new intent, not a retry of
     * this one.
     */
    private var pendingSpinKey: String? = null

    init {
        observeSocket()
    }

    fun setCurrentUser(userId: String) = _state.update { it.copy(currentUserId = userId) }

    /* -------------------------------- joining ------------------------------- */

    fun createRoom(name: String) = viewModelScope.launch {
        _state.update { it.copy(isLoading = true, error = null) }

        when (val result = repository.createRoom(name)) {
            is ApiResult.Success -> enterRoom(result.data.roomId)
            else -> _state.update { it.copy(isLoading = false, error = result.errorMessage) }
        }
    }

    fun joinRoom(roomIdOrCode: String) = viewModelScope.launch {
        _state.update { it.copy(isLoading = true, error = null) }

        when (val result = repository.joinRoom(roomIdOrCode)) {
            is ApiResult.Success -> {
                applySnapshot(result.data)
                _state.update { it.copy(isLoading = false) }
                connectSocket(result.data.room.roomId)
            }
            else -> _state.update { it.copy(isLoading = false, error = result.errorMessage) }
        }
    }

    private suspend fun enterRoom(roomId: String) {
        // The creator is already a member server-side, but joining is idempotent
        // and returns the full snapshot in one round-trip.
        when (val joined = repository.joinRoom(roomId)) {
            is ApiResult.Success -> {
                applySnapshot(joined.data)
                _state.update { it.copy(isLoading = false) }
                connectSocket(roomId)
            }
            else -> _state.update { it.copy(isLoading = false, error = joined.errorMessage) }
        }
    }

    private fun connectSocket(roomId: String) {
        socket.connect()
        socket.subscribe(roomId)
    }

    fun leaveRoom() = viewModelScope.launch {
        val roomId = _state.value.room?.roomId ?: return@launch

        // Leaving forfeits an active spin seat (D11). Warned about in the UI.
        repository.leaveRoom(roomId)
        socket.disconnect()
        _state.value = RoomUiState(currentUserId = _state.value.currentUserId)
    }

    /* -------------------------------- actions ------------------------------- */

    fun shareDraft(draft: DraftEntity) = viewModelScope.launch {
        val roomId = _state.value.room?.roomId ?: return@launch

        when (val result = repository.shareDraft(roomId, draft)) {
            is ApiResult.Success -> Unit // draft_shared will arrive over the socket
            else -> _state.update { it.copy(error = result.errorMessage) }
        }
    }

    fun startSpin() = viewModelScope.launch {
        val roomId = _state.value.room?.roomId ?: return@launch

        _state.value.spinBlockedReason?.let { reason ->
            _state.update { it.copy(error = reason) }
            return@launch
        }

        // Same key across retries of this tap, so a lost response cannot start
        // two spins (D18).
        val key = pendingSpinKey ?: UUID.randomUUID().toString().also { pendingSpinKey = it }

        _state.update { it.copy(isLoading = true, error = null) }

        when (val result = repository.startSpin(roomId, key)) {
            is ApiResult.Success -> {
                pendingSpinKey = null
                // Not applied to state here: spin_started arrives over the
                // socket and is the authoritative version of the same fact.
                _state.update { it.copy(isLoading = false) }
            }
            is ApiResult.Failure -> {
                // A definite answer means the key is spent; a later spin is a
                // new intent and deserves a new key.
                pendingSpinKey = null
                _state.update { it.copy(isLoading = false, error = result.message) }
            }
            is ApiResult.NetworkError -> {
                // No answer. Keep the key so a retry replays instead of
                // starting a second spin.
                _state.update { it.copy(isLoading = false, error = result.errorMessage) }
            }
        }
    }

    /** Pull the authoritative snapshot. Used by pull-to-refresh and on resume. */
    fun refresh() = viewModelScope.launch {
        val roomId = _state.value.room?.roomId ?: return@launch
        when (val result = repository.getRoomState(roomId)) {
            is ApiResult.Success -> applySnapshot(result.data)
            else -> _state.update { it.copy(error = result.errorMessage) }
        }
    }

    fun dismissError() = _state.update { it.copy(error = null) }

    /* ------------------------------ playback -------------------------------- */

    /**
     * Play the locally-stored WAV for [draft] (by draftId lookup in the local
     * draft store via the repository).
     *
     * Audio is device-local (D10): only the participant whose device holds the
     * WAV file can play it.  Callers are expected to show the button as disabled
     * or grayed out when the file is absent.
     */
    fun playSharedDraft(localDraft: DraftEntity?) {
        stopSharedDraftPlayback()
        if (localDraft == null || !localDraft.exists) {
            _state.update { it.copy(error = "Audio is stored on the recording device and cannot be played here.") }
            return
        }
        val mp = MediaPlayer()
        runCatching {
            mp.setDataSource(localDraft.filePath)
            mp.setOnCompletionListener { stopSharedDraftPlayback() }
            mp.setOnErrorListener { _, _, _ -> stopSharedDraftPlayback(); true }
            mp.prepare()
            mp.start()
        }.onFailure {
            mp.release()
            _state.update { it.copy(error = "Could not play the draft audio.") }
            return
        }
        player = mp
        _state.update { it.copy(isPlayingSharedDraft = true) }
    }

    fun stopSharedDraftPlayback() {
        player?.runCatching {
            if (isPlaying) stop()
            release()
        }
        player = null
        _state.update { it.copy(isPlayingSharedDraft = false) }
    }

    /* --------------------------------- events -------------------------------- */

    private fun observeSocket() {
        viewModelScope.launch {
            socket.connection.collect { conn -> _state.update { it.copy(connection = conn) } }
        }
        viewModelScope.launch {
            socket.events.collect(::apply)
        }
    }

    private fun apply(event: RoomEvent) {
        when (event) {
            // The snapshot always wins. After a reconnect, whatever the client
            // accumulated while it was away is discarded rather than merged --
            // merging is how two clients end up disagreeing about who is out.
            is RoomEvent.RoomStateSnapshot -> applySnapshot(event.state)

            is RoomEvent.UserJoined -> _state.update {
                it.copy(
                    participants = event.participants,
                    activity = it.activity.append("${event.participant.displayName} joined"),
                )
            }

            is RoomEvent.UserLeft -> _state.update {
                val who = it.participants.firstOrNull { p -> p.userId == event.userId }?.displayName
                    ?: "Someone"
                val how = if (event.reason == "DISCONNECT_TIMEOUT") "lost connection" else "left"
                it.copy(
                    participants = event.participants,
                    activity = it.activity.append("$who $how"),
                )
            }

            is RoomEvent.DraftShared -> _state.update {
                it.copy(
                    sharedDraft = event.sharedDraft,
                    activity = it.activity.append("Draft shared: ${event.sharedDraft.draft.name}"),
                )
            }

            is RoomEvent.SpinStarted -> _state.update {
                it.copy(
                    spin = event.spin,
                    activity = it.activity.append("Spin started with ${event.spin.participants.size} players"),
                )
            }

            is RoomEvent.UserEliminated -> _state.update {
                // D11: a forfeit reads differently from a wheel draw, and the
                // wording matters when someone's phone just died.
                val line = if (event.reason == "LEFT") {
                    "${event.eliminatedDisplayName} forfeited by leaving"
                } else {
                    "${event.eliminatedDisplayName} was eliminated"
                }
                it.copy(spin = event.spin, activity = it.activity.append(line))
            }

            is RoomEvent.WinnerAnnounced -> _state.update {
                it.copy(
                    spin = event.spin,
                    activity = it.activity.append("Winner: ${event.winner.displayName}"),
                )
            }

            is RoomEvent.SpinAborted -> _state.update {
                it.copy(
                    spin = event.spin,
                    activity = it.activity.append("Spin aborted (${event.reason})"),
                )
            }
        }
    }

    private fun applySnapshot(snapshot: com.roxstar.app.data.api.RoomStateDto) {
        _state.update {
            it.copy(
                room = snapshot.room,
                participants = snapshot.participants,
                sharedDraft = snapshot.sharedDraft,
                // A finished spin is still worth showing, so fall back to
                // lastSpin when nothing is running.
                spin = snapshot.activeSpin ?: snapshot.lastSpin,
                error = null,
            )
        }
    }

    override fun onCleared() {
        stopSharedDraftPlayback()
        socket.disconnect()
        super.onCleared()
    }
}

/** Keep the activity feed bounded -- it is a UI affordance, not a log. */
private fun List<String>.append(line: String): List<String> = (this + line).takeLast(30)
