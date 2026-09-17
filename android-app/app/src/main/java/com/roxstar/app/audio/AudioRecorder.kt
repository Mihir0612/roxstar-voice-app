package com.roxstar.app.audio

import android.content.Context
import android.media.MediaPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * Recording state machine, exactly as the client plan specifies:
 *
 *     IDLE -> RECORDING -> STOPPING -> PROCESSING -> SAVED
 *                       \-> IDLE (cancel)
 *                       \-> FAILED (any error)
 *
 * Both FAILED and cancel return to a usable state, because "stability across
 * repeated operations" means the second take must work after the first one
 * went wrong.
 */
sealed interface RecordingState {
    data object Idle : RecordingState
    data class Recording(val durationMs: Long, val level: Float, val effect: AudioEffect) : RecordingState
    data object Stopping : RecordingState
    data class Saved(val file: File, val durationMs: Long, val effect: AudioEffect) : RecordingState
    data class Failed(val reason: RecordingError) : RecordingState
}

/** Failures the user can actually be told something useful about. */
enum class RecordingError(val message: String) {
    PERMISSION_DENIED("Microphone permission is required to record."),
    ENGINE_UNAVAILABLE("The native audio engine could not be loaded on this device."),
    MIC_UNAVAILABLE("The microphone could not be opened. Another app may be using it."),
    STORAGE_FAILED("The recording could not be written to storage."),
    NO_AUDIO("No audio was captured. Check that the microphone is not muted."),
    ALREADY_RECORDING("A recording is already in progress."),
    UNKNOWN("Recording failed unexpectedly."),
}

/**
 * Owns the recording lifecycle above the JNI boundary.
 *
 * Deliberately has no opinion about drafts, the network or the UI: it records
 * to a file and reports state. That separation is what lets the ViewModel be
 * tested without a microphone.
 */
class AudioRecorder(
    private val context: Context,
    private val scope: CoroutineScope,
    private val bridge: NativeAudioBridge = NativeAudioBridge,
) {
    private val _state = MutableStateFlow<RecordingState>(RecordingState.Idle)
    val state: StateFlow<RecordingState> = _state.asStateFlow()

    private var pollJob: Job? = null
    private var currentFile: File? = null
    private var currentEffect: AudioEffect = AudioEffect.NONE
    private var player: MediaPlayer? = null

    private val recordingsDir: File
        get() = File(context.filesDir, "recordings").apply { mkdirs() }

    fun start(effect: AudioEffect) {
        if (_state.value is RecordingState.Recording) {
            _state.value = RecordingState.Failed(RecordingError.ALREADY_RECORDING)
            return
        }
        if (!bridge.isAvailable) {
            _state.value = RecordingState.Failed(RecordingError.ENGINE_UNAVAILABLE)
            return
        }

        val file = File(recordingsDir, "draft-${UUID.randomUUID()}.wav")
        currentFile = file
        currentEffect = effect

        when (val result = bridge.startRecording(file.absolutePath, effect)) {
            NativeResult.OK -> {
                _state.value = RecordingState.Recording(0L, 0f, effect)
                startPolling(effect)
            }
            else -> {
                // Clean up the file the native side may have created before failing.
                file.delete()
                currentFile = null
                _state.value = RecordingState.Failed(result.toRecordingError())
            }
        }
    }

    fun stop() {
        val file = currentFile
        if (file == null || _state.value !is RecordingState.Recording) {
            _state.value = RecordingState.Failed(RecordingError.UNKNOWN)
            return
        }

        _state.value = RecordingState.Stopping
        stopPolling()

        scope.launch {
            // The native stop drains the writer thread and patches the WAV
            // header, both of which touch the filesystem.
            val result = withContext(Dispatchers.IO) { bridge.stopRecording() }
            val durationMs = bridge.durationMs()

            _state.value = if (result == NativeResult.OK && file.exists() && file.length() > 44) {
                RecordingState.Saved(file, durationMs, currentEffect)
            } else {
                file.delete()
                RecordingState.Failed(result.toRecordingError())
            }
            currentFile = null
        }
    }

    fun cancel() {
        stopPolling()
        bridge.cancelRecording()
        // Belt and braces: the native side deletes it too, but a cancel must
        // leave nothing behind even if the engine was never started.
        currentFile?.delete()
        currentFile = null
        _state.value = RecordingState.Idle
    }

    /** Return to Idle after the UI has consumed a Saved or Failed state. */
    fun acknowledge() {
        _state.value = RecordingState.Idle
    }

    /**
     * Poll duration and level for the UI.
     *
     * Polling rather than a native callback into Kotlin: an upcall from the
     * audio thread would need a JNI attach on every buffer, which is exactly
     * the kind of work that must never happen there.
     */
    private fun startPolling(effect: AudioEffect) {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (true) {
                delay(100)
                if (!bridge.isRecording()) {
                    // The stream dropped underneath us -- a call arrived, or the
                    // headset was unplugged. Native has already salvaged
                    // whatever was captured.
                    if (_state.value is RecordingState.Recording) finaliseAfterDisconnect()
                    return@launch
                }
                val current = _state.value
                if (current is RecordingState.Recording) {
                    _state.value = current.copy(durationMs = bridge.durationMs(), level = bridge.level())
                }
            }
        }
    }

    private fun finaliseAfterDisconnect() {
        val file = currentFile
        val durationMs = bridge.durationMs()
        _state.value = if (file != null && file.exists() && file.length() > 44 && durationMs > 0) {
            // Keep the partial take. A recording that ends early is much better
            // than one that disappears.
            RecordingState.Saved(file, durationMs, currentEffect)
        } else {
            file?.delete()
            RecordingState.Failed(RecordingError.MIC_UNAVAILABLE)
        }
        currentFile = null
    }

    private fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    /* ------------------------------ playback ------------------------------- */

    fun play(file: File, onComplete: () -> Unit = {}) {
        stopPlayback()
        if (!file.exists()) {
            onComplete()
            return
        }
        player = MediaPlayer().apply {
            runCatching {
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    stopPlayback()
                    onComplete()
                }
                setOnErrorListener { _, _, _ ->
                    stopPlayback()
                    onComplete()
                    true
                }
                prepare()
                start()
            }.onFailure {
                stopPlayback()
                onComplete()
            }
        }
    }

    fun stopPlayback() {
        player?.runCatching {
            if (isPlaying) stop()
            release()
        }
        player = null
    }

    /** Release native resources. Called from ViewModel.onCleared. */
    fun release() {
        stopPolling()
        stopPlayback()
        bridge.cancelRecording()
        bridge.release()
    }
}

private fun NativeResult.toRecordingError(): RecordingError = when (this) {
    NativeResult.ALREADY_RECORDING -> RecordingError.ALREADY_RECORDING
    // Oboe reports a permission problem the same way as a busy microphone:
    // the stream simply will not open. The UI checks the permission before
    // calling start, so by this point a busy mic is the likelier cause.
    NativeResult.STREAM_OPEN_FAILED, NativeResult.STREAM_START_FAILED -> RecordingError.MIC_UNAVAILABLE
    NativeResult.FILE_OPEN_FAILED, NativeResult.FILE_WRITE_FAILED -> RecordingError.STORAGE_FAILED
    NativeResult.NO_AUDIO_CAPTURED -> RecordingError.NO_AUDIO
    else -> RecordingError.UNKNOWN
}
