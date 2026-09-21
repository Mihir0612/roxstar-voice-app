package com.roxstar.app.audio

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/**
 * Pure Kotlin WAV post-processor used by the Edit Draft feature.
 *
 * All operations are performed in the IO dispatcher and produce a brand-new
 * WAV file -- the source is never modified.  The implementation is intentionally
 * simple (ring-buffer echo, linear-interpolation pitch shift) so it runs on any
 * device without native code.
 *
 * Supported input format: 16-bit PCM WAV (mono or stereo), any sample rate.
 */
object AudioEffectProcessor {

    /**
     * Apply the requested effects to [inputFile] and write the result to [outputFile].
     *
     * @param echoEnabled      whether to add an echo/delay layer
     * @param echoDelayMs      delay of the echo in milliseconds (default 300 ms)
     * @param echoDecay        echo feedback coefficient 0..1 (default 0.45)
     * @param reverseEchoEnabled  reverse the audio, apply echo, then reverse back
     * @param pitchSemitones   pitch shift in semitones (−12..+12, 0 = no change)
     */
    suspend fun applyEffects(
        inputFile: File,
        outputFile: File,
        echoEnabled: Boolean = false,
        echoDelayMs: Int = 300,
        echoDecay: Float = 0.45f,
        reverseEchoEnabled: Boolean = false,
        pitchSemitones: Float = 0f,
    ): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val wav = readWav(inputFile)

            var samples = wav.samples

            // 1. Pitch shift (resampling — must come before any time-domain echo
            //    so the delay amounts stay perceptually constant in real time).
            if (pitchSemitones != 0f) {
                samples = pitchShift(samples, pitchSemitones, wav.channels)
            }

            // 2. Reverse echo: reverse → echo → reverse, which produces a
            //    swell-before-the-hit effect familiar from the classic "reverse reverb".
            if (reverseEchoEnabled) {
                samples = samples.reversedArray()
                val delaySamples = (wav.sampleRate * echoDelayMs / 1000).coerceAtLeast(1)
                samples = applyEchoToSamples(samples, delaySamples, echoDecay * 0.65f, wav.channels)
                samples = samples.reversedArray()
            }

            // 3. Standard echo (can be stacked on top of reverse echo).
            if (echoEnabled) {
                val delaySamples = (wav.sampleRate * echoDelayMs / 1000).coerceAtLeast(1)
                samples = applyEchoToSamples(samples, delaySamples, echoDecay, wav.channels)
            }

            writeWav(outputFile, samples, wav.channels, wav.sampleRate)
            true
        }.getOrDefault(false)
    }

    // -------------------------------------------------------------------------
    // Internal WAV helpers
    // -------------------------------------------------------------------------

    private data class WavData(
        val samples: ShortArray,
        val channels: Int,
        val sampleRate: Int,
    )

    /**
     * Read a 16-bit PCM WAV into a ShortArray.
     *
     * We parse the header manually so there is no dependency on AudioTrack or
     * MediaExtractor, both of which require Android API calls that cannot be
     * unit-tested off-device.
     */
    private fun readWav(file: File): WavData {
        RandomAccessFile(file, "r").use { raf ->
            // Skip "RIFF", file size, "WAVE" (12 bytes), then parse fmt chunk.
            raf.seek(12)

            // fmt chunk
            val fmtId = ByteArray(4).also { raf.readFully(it) }
            check(String(fmtId) == "fmt ") { "Not a PCM WAV: missing fmt chunk" }
            val fmtSize = raf.readIntLE()
            check(fmtSize >= 16) { "fmt chunk too small" }
            val audioFormat = raf.readShortLE()
            check(audioFormat.toInt() == 1) { "Only PCM WAV (format 1) is supported" }
            val channels = raf.readShortLE().toInt()
            val sampleRate = raf.readIntLE()
            raf.skipBytes(6) // byteRate + blockAlign
            val bitsPerSample = raf.readShortLE()
            check(bitsPerSample.toInt() == 16) { "Only 16-bit WAV is supported" }
            if (fmtSize > 16) raf.skipBytes(fmtSize - 16)

            // Locate data chunk (skip any LIST/fact chunks)
            var dataSize = 0
            while (raf.filePointer < raf.length()) {
                val chunkId = ByteArray(4).also { raf.readFully(it) }
                val chunkSize = raf.readIntLE()
                if (String(chunkId) == "data") {
                    dataSize = chunkSize
                    break
                }
                raf.skipBytes(chunkSize)
            }
            check(dataSize > 0) { "No data chunk found" }

            val bytes = ByteArray(dataSize).also { raf.readFully(it) }
            val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            val shorts = ShortArray(dataSize / 2) { buf.get() }
            return WavData(shorts, channels, sampleRate)
        }
    }

    private fun writeWav(file: File, samples: ShortArray, channels: Int, sampleRate: Int) {
        val dataBytes = samples.size * 2
        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(0)
            // RIFF header
            raf.write("RIFF".toByteArray())
            raf.writeIntLE(36 + dataBytes)
            raf.write("WAVE".toByteArray())
            // fmt chunk
            raf.write("fmt ".toByteArray())
            raf.writeIntLE(16)
            raf.writeShortLE(1)                      // PCM
            raf.writeShortLE(channels)
            raf.writeIntLE(sampleRate)
            raf.writeIntLE(sampleRate * channels * 2) // byteRate
            raf.writeShortLE(channels * 2)            // blockAlign
            raf.writeShortLE(16)                      // bitsPerSample
            // data chunk
            raf.write("data".toByteArray())
            raf.writeIntLE(dataBytes)
            val buf = ByteBuffer.allocate(dataBytes).order(ByteOrder.LITTLE_ENDIAN)
            samples.forEach { buf.putShort(it) }
            raf.write(buf.array())
        }
    }

    // -------------------------------------------------------------------------
    // DSP algorithms
    // -------------------------------------------------------------------------

    /**
     * Ring-buffer echo.
     *
     * Each output sample is the sum of the input sample and a decayed copy of
     * the sample that occurred [delaySamples] frames ago.  Operates on
     * interleaved stereo or mono, always treating channels together so the
     * delay is the same for L and R.
     */
    private fun applyEchoToSamples(
        input: ShortArray,
        delaySamples: Int,
        decay: Float,
        channels: Int,
    ): ShortArray {
        val delayFrames = delaySamples * channels        // interleaved offset
        val out = ShortArray(input.size)
        for (i in input.indices) {
            val echoed = if (i >= delayFrames) out[i - delayFrames] * decay else 0f
            out[i] = (input[i] + echoed).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }
        return out
    }

    /**
     * Pitch shift via linear-interpolation resampling.
     *
     * We resample by a ratio of 2^(semitones/12).  This changes both pitch AND
     * duration, which is what a simple tape-speed effect does. It is audible
     * and sufficient for the preview use-case without needing phase-vocoder
     * complexity.
     */
    private fun pitchShift(input: ShortArray, semitones: Float, channels: Int): ShortArray {
        val ratio = Math.pow(2.0, semitones / 12.0).toFloat()   // > 1 = higher pitch
        val frameCount = input.size / channels
        val newFrameCount = (frameCount / ratio).roundToInt().coerceAtLeast(1)
        val out = ShortArray(newFrameCount * channels)

        for (frame in 0 until newFrameCount) {
            val srcFrame = frame * ratio
            val lo = srcFrame.toInt().coerceIn(0, frameCount - 1)
            val hi = (lo + 1).coerceAtMost(frameCount - 1)
            val frac = srcFrame - lo

            for (ch in 0 until channels) {
                val loSample = input[lo * channels + ch].toFloat()
                val hiSample = input[hi * channels + ch].toFloat()
                val interpolated = loSample + frac * (hiSample - loSample)
                out[frame * channels + ch] = interpolated.toInt()
                    .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
                    .toShort()
            }
        }
        return out
    }

    // -------------------------------------------------------------------------
    // RandomAccessFile little-endian helpers
    // -------------------------------------------------------------------------

    private fun RandomAccessFile.readIntLE(): Int {
        val b = ByteArray(4).also { readFully(it) }
        return ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).int
    }

    private fun RandomAccessFile.readShortLE(): Short {
        val b = ByteArray(2).also { readFully(it) }
        return ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).short
    }

    private fun RandomAccessFile.writeIntLE(value: Int) {
        val b = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()
        write(b)
    }

    private fun RandomAccessFile.writeShortLE(value: Int) {
        val b = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(value.toShort()).array()
        write(b)
    }
}
