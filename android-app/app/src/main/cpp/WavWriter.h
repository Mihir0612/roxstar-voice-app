#ifndef ROXSTAR_WAV_WRITER_H
#define ROXSTAR_WAV_WRITER_H

#include <cstdint>
#include <cstdio>
#include <string>

namespace roxstar {

/**
 * Streaming 16-bit PCM WAV writer.
 *
 * WAV, not AAC/M4A: the point of this exercise is the Oboe capture path, and
 * an encoder would add a MediaCodec dependency and its own buffering between
 * the effect and the file. WAV is written directly, so what lands on disk is
 * exactly what the effect produced.
 *
 * The header carries byte counts that are not known until recording stops, so
 * a placeholder is written first and patched in `finish()`. A file that was
 * never finished is therefore detectable rather than silently truncated.
 *
 * Writing happens on the audio thread's data, but NOT inside the Oboe
 * callback: AudioEngine hands buffers to a writer thread, because fwrite can
 * block on flash I/O for longer than a callback deadline allows.
 */
class WavWriter {
public:
    WavWriter() = default;
    ~WavWriter();

    WavWriter(const WavWriter&) = delete;
    WavWriter& operator=(const WavWriter&) = delete;

    bool start(const std::string& path, int32_t sampleRate, int32_t channelCount);

    /** Convert and append interleaved float frames. Returns false on I/O error. */
    bool write(const float* audio, int32_t numFrames, int32_t channelCount);

    /** Patch the header with the real sizes and close. */
    bool finish();

    /** Close and delete the partial file -- used by Cancel. */
    void abort();

    bool isOpen() const { return mFile != nullptr; }
    int64_t framesWritten() const { return mFramesWritten; }
    int64_t durationMs() const;

private:
    std::FILE* mFile = nullptr;
    std::string mPath;
    int32_t mSampleRate = 48000;
    int32_t mChannelCount = 1;
    int64_t mFramesWritten = 0;

    bool writeHeaderPlaceholder();
    bool patchHeader();
};

} // namespace roxstar

#endif // ROXSTAR_WAV_WRITER_H
