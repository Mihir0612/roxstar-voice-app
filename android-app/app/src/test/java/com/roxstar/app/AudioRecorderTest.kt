package com.roxstar.app

import com.roxstar.app.audio.AudioEffect
import com.roxstar.app.audio.NativeResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Tests for the parts of the audio layer that are pure logic.
 *
 * The recorder itself needs a real microphone and a real Oboe stream, so it is
 * exercised on device rather than here. What IS worth pinning down without a
 * device is the JNI contract: the effect ordinals are a hand-maintained
 * agreement with a C++ switch statement, and reordering the enum would silently
 * apply the wrong effect rather than fail to compile.
 */
class NativeContractTest {

    @Test
    fun `effect ordinals match the C++ switch in roxstar_audio_jni_cpp`() {
        assertEquals(0, AudioEffect.NONE.nativeOrdinal)
        assertEquals(1, AudioEffect.ECHO.nativeOrdinal)
        assertEquals(2, AudioEffect.REVERB.nativeOrdinal)
        assertEquals(3, AudioEffect.PITCH_SHIFT.nativeOrdinal)
    }

    @Test
    fun `effect api values match the database CHECK constraint`() {
        // drafts.effect CHECK (effect IN ('NONE','ECHO','REVERB','PITCH_SHIFT'))
        val allowed = setOf("NONE", "ECHO", "REVERB", "PITCH_SHIFT")
        AudioEffect.entries.forEach { effect ->
            assert(effect.apiValue in allowed) { "${effect.apiValue} would be rejected by the backend" }
        }
    }

    @Test
    fun `every effect has a distinct ordinal`() {
        val ordinals = AudioEffect.entries.map { it.nativeOrdinal }
        assertEquals(ordinals.size, ordinals.toSet().size)
    }

    @Test
    fun `native result codes map back from their integers`() {
        assertEquals(NativeResult.OK, NativeResult.from(0))
        assertEquals(NativeResult.ALREADY_RECORDING, NativeResult.from(1))
        assertEquals(NativeResult.NOT_RECORDING, NativeResult.from(2))
        assertEquals(NativeResult.STREAM_OPEN_FAILED, NativeResult.from(3))
        assertEquals(NativeResult.STREAM_START_FAILED, NativeResult.from(4))
        assertEquals(NativeResult.FILE_OPEN_FAILED, NativeResult.from(5))
        assertEquals(NativeResult.FILE_WRITE_FAILED, NativeResult.from(6))
        assertEquals(NativeResult.NO_AUDIO_CAPTURED, NativeResult.from(7))
    }

    @Test
    fun `an unrecognised native code does not silently become OK`() {
        // A new C++ status reaching an older Kotlin build must not be read as
        // success -- that would show the user a saved draft that does not exist.
        assertEquals(NativeResult.UNKNOWN, NativeResult.from(99))
        assertNotEquals(NativeResult.OK, NativeResult.from(99))
    }

    @Test
    fun `the reverb label does not claim to be a true reverb`() {
        // It is a short dense feedback delay. Saying otherwise in the UI would
        // misrepresent what was implemented.
        assert(AudioEffect.REVERB.label.contains("echo", ignoreCase = true))
    }
}
