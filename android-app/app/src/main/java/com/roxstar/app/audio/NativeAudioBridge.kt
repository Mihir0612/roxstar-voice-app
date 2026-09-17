package com.roxstar.app.audio

/**
 * Effects the native engine implements.
 *
 * The ordinal is the contract with C++ (`roxstar_audio_jni.cpp`), so the order
 * of these entries must not change without changing the switch on the other
 * side. `REVERB` is named honestly: it is a short dense feedback delay, not a
 * Schroeder or FDN reverb, and the UI label says so.
 */
enum class AudioEffect(val nativeOrdinal: Int, val label: String, val apiValue: String) {
    NONE(0, "None", "NONE"),
    ECHO(1, "Echo", "ECHO"),
    REVERB(2, "Reverb (echo-based)", "REVERB"),
    PITCH_SHIFT(3, "Pitch Shift (+5 semitones)", "PITCH_SHIFT"),
}

/** Native status codes, mirroring `roxstar::EngineResult`. */
enum class NativeResult(val code: Int) {
    OK(0),
    ALREADY_RECORDING(1),
    NOT_RECORDING(2),
    STREAM_OPEN_FAILED(3),
    STREAM_START_FAILED(4),
    FILE_OPEN_FAILED(5),
    FILE_WRITE_FAILED(6),
    NO_AUDIO_CAPTURED(7),
    UNKNOWN(-1);

    companion object {
        fun from(code: Int): NativeResult = entries.firstOrNull { it.code == code } ?: UNKNOWN
    }
}

/**
 * The only class in the app that touches JNI.
 *
 * Keeping the `external fun` declarations behind one object means the native
 * boundary is a single file to audit, and the rest of the codebase deals in
 * Kotlin types. Nothing here does I/O or state management -- that belongs to
 * [AudioRecorder].
 */
object NativeAudioBridge {

    /** Set to false when the .so is missing, so the UI can explain rather than crash. */
    val isAvailable: Boolean = runCatching { System.loadLibrary("roxstar_audio") }.isSuccess

    fun startRecording(outputPath: String, effect: AudioEffect): NativeResult =
        if (!isAvailable) NativeResult.STREAM_OPEN_FAILED
        else NativeResult.from(nativeStartRecording(outputPath, effect.nativeOrdinal))

    fun stopRecording(): NativeResult =
        if (!isAvailable) NativeResult.NOT_RECORDING else NativeResult.from(nativeStopRecording())

    fun cancelRecording() {
        if (isAvailable) nativeCancelRecording()
    }

    fun isRecording(): Boolean = isAvailable && nativeIsRecording()

    fun durationMs(): Long = if (isAvailable) nativeGetDurationMs() else 0L

    /** Peak level 0..1 of the latest buffer, for the live meter. */
    fun level(): Float = if (isAvailable) nativeGetLevel() else 0f

    fun sampleRate(): Int = if (isAvailable) nativeGetSampleRate() else 0

    /** Releases the engine and the microphone. Call from onCleared. */
    fun release() {
        if (isAvailable) nativeRelease()
    }

    private external fun nativeStartRecording(outputPath: String, effectOrdinal: Int): Int
    private external fun nativeStopRecording(): Int
    private external fun nativeCancelRecording()
    private external fun nativeIsRecording(): Boolean
    private external fun nativeGetDurationMs(): Long
    private external fun nativeGetLevel(): Float
    private external fun nativeGetSampleRate(): Int
    private external fun nativeRelease()
}
