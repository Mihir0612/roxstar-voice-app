package com.roxstar.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.roxstar.app.audio.AudioEffect
import com.roxstar.app.audio.AudioRecorder
import com.roxstar.app.audio.RecordingState
import com.roxstar.app.data.local.DraftEntity
import com.roxstar.app.data.repository.RoxstarRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

data class AudioUiState(
    val selectedEffect: AudioEffect = AudioEffect.ECHO,
    val hasMicPermission: Boolean = false,
    val playingDraftId: String? = null,
    val error: String? = null,
    /** Set when a take finishes, so the UI can prompt for a name. */
    val pendingSave: PendingSave? = null,
)

data class PendingSave(
    val filePath: String,
    val durationMs: Long,
    val effect: AudioEffect,
)

/**
 * Audio and draft screen.
 *
 * Owns the recorder and the local draft list. Deliberately knows nothing about
 * rooms: sharing a draft is the room screen's concern, and keeping these apart
 * is what lets recording work with no network at all.
 */
class AudioViewModel(
    private val repository: RoxstarRepository,
    private val recorder: AudioRecorder,
) : ViewModel() {

    private val _ui = MutableStateFlow(AudioUiState())
    val ui: StateFlow<AudioUiState> = _ui.asStateFlow()

    val recordingState: StateFlow<RecordingState> = recorder.state

    val drafts: StateFlow<List<DraftEntity>> = repository.observeDrafts()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun selectEffect(effect: AudioEffect) = _ui.update { it.copy(selectedEffect = effect) }

    fun onPermissionResult(granted: Boolean) {
        _ui.update {
            it.copy(
                hasMicPermission = granted,
                error = if (granted) null
                else "Microphone access is needed to record. Enable it in Settings to continue.",
            )
        }
    }

    fun startRecording() {
        // Checked here rather than relying on the native layer to fail: Oboe
        // reports a denied permission the same way as a busy microphone, and
        // the user deserves the accurate message.
        if (!_ui.value.hasMicPermission) {
            _ui.update { it.copy(error = "Microphone permission is required.") }
            return
        }
        _ui.update { it.copy(error = null) }
        recorder.start(_ui.value.selectedEffect)
    }

    fun stopRecording() = recorder.stop()

    fun cancelRecording() {
        recorder.cancel()
        _ui.update { it.copy(pendingSave = null) }
    }

    /** Called when the recorder reaches Saved: offer to name and keep the take. */
    fun onRecordingSaved(state: RecordingState.Saved) {
        _ui.update {
            it.copy(
                pendingSave = PendingSave(
                    filePath = state.file.absolutePath,
                    durationMs = state.durationMs,
                    effect = state.effect,
                )
            )
        }
    }

    fun confirmSave(name: String) = viewModelScope.launch {
        val pending = _ui.value.pendingSave ?: return@launch

        repository.saveDraft(
            // Minted on the device: the backend upserts on this id when the
            // draft is shared, which keeps the local file and the shared
            // metadata referring to the same thing.
            draftId = UUID.randomUUID().toString(),
            name = name.ifBlank { "Untitled take" },
            filePath = pending.filePath,
            durationMs = pending.durationMs,
            effect = pending.effect.apiValue,
        )

        _ui.update { it.copy(pendingSave = null) }
        recorder.acknowledge()
    }

    fun discardPendingSave() = viewModelScope.launch {
        // The user recorded something and chose not to keep it: remove the file
        // rather than leaving an unreferenced WAV in app storage.
        _ui.value.pendingSave?.let { java.io.File(it.filePath).delete() }
        _ui.update { it.copy(pendingSave = null) }
        recorder.acknowledge()
    }

    fun playDraft(draft: DraftEntity) {
        if (!draft.exists) {
            _ui.update { it.copy(error = "That recording is no longer on this device.") }
            return
        }
        _ui.update { it.copy(playingDraftId = draft.draftId) }
        recorder.play(draft.file) {
            _ui.update { it.copy(playingDraftId = null) }
        }
    }

    fun stopPlayback() {
        recorder.stopPlayback()
        _ui.update { it.copy(playingDraftId = null) }
    }

    fun deleteDraft(draft: DraftEntity) = viewModelScope.launch {
        if (_ui.value.playingDraftId == draft.draftId) stopPlayback()
        repository.deleteDraft(draft.draftId)
    }

    fun dismissError() = _ui.update { it.copy(error = null) }

    override fun onCleared() {
        // Releases the Oboe stream and the microphone. Without this the mic
        // stays held after the screen goes away.
        recorder.release()
        super.onCleared()
    }
}
