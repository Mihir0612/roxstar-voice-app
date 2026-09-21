package com.roxstar.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.roxstar.app.audio.AudioEffect
import com.roxstar.app.audio.AudioEffectProcessor
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
import java.io.File
import java.util.UUID

data class AudioUiState(
    val selectedEffect: AudioEffect = AudioEffect.ECHO,
    val hasMicPermission: Boolean = false,
    val playingDraftId: String? = null,
    val error: String? = null,
    /** Set when a take finishes, so the UI can prompt for a name. */
    val pendingSave: PendingSave? = null,

    // ── Edit-draft state ──────────────────────────────────────────────────────
    /** Non-null while the edit sheet is open. */
    val editingDraft: DraftEntity? = null,
    val editEchoEnabled: Boolean = false,
    val editReverseEchoEnabled: Boolean = false,
    /** Pitch shift in semitones, −12 to +12.  0 = no shift. */
    val editPitchSemitones: Float = 0f,
    /** True while a preview playback is in progress inside the edit sheet. */
    val editPreviewPlaying: Boolean = false,
    /** True while AudioEffectProcessor is running (preview or final export). */
    val editProcessing: Boolean = false,
    /** Set when the user taps Done so the name dialog can appear. */
    val pendingEditSave: PendingEditSave? = null,
)

data class PendingSave(
    val filePath: String,
    val durationMs: Long,
    val effect: AudioEffect,
)

/**
 * Carries the processed temp file path until the user gives it a name.
 */
data class PendingEditSave(
    val sourceDraftId: String,
    val processedFilePath: String,
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

    // ─────────────────────────────────────────────────────────────────────────
    // Edit-draft feature
    // ─────────────────────────────────────────────────────────────────────────

    /** Open the edit sheet for [draft]. Resets all effect controls to off. */
    fun openEditDraft(draft: DraftEntity) {
        stopPlayback()
        _ui.update {
            it.copy(
                editingDraft = draft,
                editEchoEnabled = false,
                editReverseEchoEnabled = false,
                editPitchSemitones = 0f,
                editPreviewPlaying = false,
                editProcessing = false,
                pendingEditSave = null,
            )
        }
    }

    /** Close the edit sheet without saving. Stops any in-progress preview. */
    fun closeEditDraft() {
        stopEditPreview()
        _ui.update {
            it.copy(
                editingDraft = null,
                editProcessing = false,
                pendingEditSave = null,
            )
        }
    }

    fun setEditEcho(enabled: Boolean) {
        stopEditPreview()
        _ui.update { it.copy(editEchoEnabled = enabled) }
    }

    fun setEditReverseEcho(enabled: Boolean) {
        stopEditPreview()
        _ui.update { it.copy(editReverseEchoEnabled = enabled) }
    }

    fun setEditPitch(semitones: Float) {
        stopEditPreview()
        _ui.update { it.copy(editPitchSemitones = semitones) }
    }

    /**
     * Apply current effect settings to a temp file and play it back so the
     * user can judge the result before committing.
     */
    fun previewEdit() = viewModelScope.launch {
        val draft = _ui.value.editingDraft ?: return@launch
        if (!draft.exists) {
            _ui.update { it.copy(error = "Source file is no longer on this device.") }
            return@launch
        }

        stopEditPreview()
        _ui.update { it.copy(editProcessing = true) }

        val tempFile = buildTempFile(draft)
        val ok = AudioEffectProcessor.applyEffects(
            inputFile = draft.file,
            outputFile = tempFile,
            echoEnabled = _ui.value.editEchoEnabled,
            reverseEchoEnabled = _ui.value.editReverseEchoEnabled,
            pitchSemitones = _ui.value.editPitchSemitones,
        )

        if (!ok || !tempFile.exists()) {
            tempFile.delete()
            _ui.update { it.copy(editProcessing = false, error = "Effect processing failed.") }
            return@launch
        }

        _ui.update { it.copy(editProcessing = false, editPreviewPlaying = true) }
        recorder.play(tempFile) {
            tempFile.delete()
            _ui.update { it.copy(editPreviewPlaying = false) }
        }
    }

    /** Stop a running preview. */
    fun stopEditPreview() {
        if (_ui.value.editPreviewPlaying) {
            recorder.stopPlayback()
            _ui.update { it.copy(editPreviewPlaying = false) }
        }
    }

    /**
     * User tapped Done: process the file and surface the name dialog.
     * The processed file lives in a temp path until [confirmEditSave].
     */
    fun finishEdit() = viewModelScope.launch {
        val draft = _ui.value.editingDraft ?: return@launch
        if (!draft.exists) {
            _ui.update { it.copy(error = "Source file is no longer on this device.") }
            return@launch
        }

        stopEditPreview()
        _ui.update { it.copy(editProcessing = true) }

        val outFile = buildTempFile(draft)
        val ok = AudioEffectProcessor.applyEffects(
            inputFile = draft.file,
            outputFile = outFile,
            echoEnabled = _ui.value.editEchoEnabled,
            reverseEchoEnabled = _ui.value.editReverseEchoEnabled,
            pitchSemitones = _ui.value.editPitchSemitones,
        )

        if (!ok || !outFile.exists()) {
            outFile.delete()
            _ui.update { it.copy(editProcessing = false, error = "Could not export the edited draft.") }
            return@launch
        }

        _ui.update {
            it.copy(
                editProcessing = false,
                pendingEditSave = PendingEditSave(
                    sourceDraftId = draft.draftId,
                    processedFilePath = outFile.absolutePath,
                ),
            )
        }
    }

    /**
     * User entered a name for the edited draft: save it and close the sheet.
     */
    fun confirmEditSave(name: String) = viewModelScope.launch {
        val pending = _ui.value.pendingEditSave ?: return@launch
        val outFile = File(pending.processedFilePath)

        // Duration of edited file can differ from original (pitch-shift changes
        // length slightly); use the file size as a proxy for now.
        val estimatedDurationMs = estimateDurationMs(outFile)

        repository.saveDraft(
            draftId = UUID.randomUUID().toString(),
            name = name.ifBlank { "Edited take" },
            filePath = outFile.absolutePath,
            durationMs = estimatedDurationMs,
            effect = buildEffectLabel(),
        )

        _ui.update {
            it.copy(
                editingDraft = null,
                pendingEditSave = null,
                editProcessing = false,
            )
        }
    }

    /** User dismissed the name dialog: delete the temp file and stay in edit sheet. */
    fun discardEditSave() {
        _ui.value.pendingEditSave?.let { File(it.processedFilePath).delete() }
        _ui.update { it.copy(pendingEditSave = null) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /** Scratch file in the recordings dir that is safe to delete on failure. */
    private fun buildTempFile(source: DraftEntity): File {
        val dir = source.file.parentFile ?: File(source.filePath).parentFile
            ?: throw IllegalStateException("Cannot resolve recordings directory")
        return File(dir, "edit-preview-${UUID.randomUUID()}.wav")
    }

    /** Human-readable effect tag stored in the draft row, e.g. "Echo+Pitch+3st". */
    private fun buildEffectLabel(): String {
        val parts = buildList {
            if (_ui.value.editEchoEnabled) add("Echo")
            if (_ui.value.editReverseEchoEnabled) add("RevEcho")
            val p = _ui.value.editPitchSemitones
            if (p != 0f) add("Pitch${if (p > 0) "+" else ""}${p.toInt()}st")
        }
        return if (parts.isEmpty()) "Edited" else parts.joinToString("+")
    }

    /**
     * Estimate duration from a 16-bit PCM WAV file size.
     *
     * WAV header is 44 bytes; each sample frame is 2 bytes × channels.
     * We fall back to reading [durationMs] from the WAV header later if needed,
     * but this linear approximation is sufficient for display purposes.
     */
    private fun estimateDurationMs(file: File): Long {
        // WAV data bytes ≈ fileSize − 44
        val dataBytes = (file.length() - 44).coerceAtLeast(0)
        // Assume 44100 Hz stereo (worst case; actual rate stored in WAV header)
        val bytesPerSecond = 44100L * 2 * 2
        return (dataBytes * 1000L / bytesPerSecond).coerceAtLeast(0L)
    }

    override fun onCleared() {
        // Releases the Oboe stream and the microphone. Without this the mic
        // stays held after the screen goes away.
        recorder.release()
        super.onCleared()
    }
}

