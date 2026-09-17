#include "WavWriter.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <vector>

namespace roxstar {

namespace {

constexpr int kHeaderBytes = 44;
constexpr int kBitsPerSample = 16;

void writeU32(std::FILE* f, uint32_t v) {
    // WAV is little-endian regardless of host byte order, so the bytes are
    // written explicitly rather than by dumping the integer.
    const uint8_t bytes[4] = {
        static_cast<uint8_t>(v & 0xFF),
        static_cast<uint8_t>((v >> 8) & 0xFF),
        static_cast<uint8_t>((v >> 16) & 0xFF),
        static_cast<uint8_t>((v >> 24) & 0xFF),
    };
    std::fwrite(bytes, 1, 4, f);
}

void writeU16(std::FILE* f, uint16_t v) {
    const uint8_t bytes[2] = {
        static_cast<uint8_t>(v & 0xFF),
        static_cast<uint8_t>((v >> 8) & 0xFF),
    };
    std::fwrite(bytes, 1, 2, f);
}

} // namespace

WavWriter::~WavWriter() {
    if (mFile) {
        // Destructor during an error path: salvage what was captured rather
        // than leaking the handle.
        finish();
    }
}

bool WavWriter::start(const std::string& path, int32_t sampleRate, int32_t channelCount) {
    if (mFile) finish();

    mPath = path;
    mSampleRate = sampleRate > 0 ? sampleRate : 48000;
    mChannelCount = channelCount > 0 ? channelCount : 1;
    mFramesWritten = 0;

    mFile = std::fopen(path.c_str(), "wb");
    if (!mFile) return false;

    if (!writeHeaderPlaceholder()) {
        std::fclose(mFile);
        mFile = nullptr;
        return false;
    }
    return true;
}

bool WavWriter::writeHeaderPlaceholder() {
    const uint32_t byteRate =
        static_cast<uint32_t>(mSampleRate) * static_cast<uint32_t>(mChannelCount) * (kBitsPerSample / 8);
    const uint16_t blockAlign = static_cast<uint16_t>(mChannelCount * (kBitsPerSample / 8));

    std::fwrite("RIFF", 1, 4, mFile);
    writeU32(mFile, 0); // patched in finish()
    std::fwrite("WAVE", 1, 4, mFile);

    std::fwrite("fmt ", 1, 4, mFile);
    writeU32(mFile, 16);                                  // PCM fmt chunk size
    writeU16(mFile, 1);                                   // format = PCM
    writeU16(mFile, static_cast<uint16_t>(mChannelCount));
    writeU32(mFile, static_cast<uint32_t>(mSampleRate));
    writeU32(mFile, byteRate);
    writeU16(mFile, blockAlign);
    writeU16(mFile, kBitsPerSample);

    std::fwrite("data", 1, 4, mFile);
    writeU32(mFile, 0); // patched in finish()

    return std::ftell(mFile) == kHeaderBytes;
}

bool WavWriter::write(const float* audio, int32_t numFrames, int32_t channelCount) {
    if (!mFile || numFrames <= 0) return false;

    const size_t sampleCount = static_cast<size_t>(numFrames) * static_cast<size_t>(channelCount);

    // Reused across calls so a long recording does not allocate per buffer.
    static thread_local std::vector<int16_t> pcm;
    pcm.resize(sampleCount);

    for (size_t i = 0; i < sampleCount; ++i) {
        // Clamp before scaling: a float above 1.0 would wrap to a large
        // negative int16 and produce a loud click instead of clipping.
        const float clamped = std::max(-1.0f, std::min(1.0f, audio[i]));
        pcm[i] = static_cast<int16_t>(clamped * 32767.0f);
    }

    const size_t written = std::fwrite(pcm.data(), sizeof(int16_t), sampleCount, mFile);
    if (written != sampleCount) return false;

    mFramesWritten += numFrames;
    return true;
}

bool WavWriter::patchHeader() {
    const uint32_t dataBytes =
        static_cast<uint32_t>(mFramesWritten) * static_cast<uint32_t>(mChannelCount) * (kBitsPerSample / 8);

    if (std::fseek(mFile, 4, SEEK_SET) != 0) return false;
    writeU32(mFile, 36 + dataBytes); // RIFF chunk size

    if (std::fseek(mFile, 40, SEEK_SET) != 0) return false;
    writeU32(mFile, dataBytes); // data chunk size

    return true;
}

bool WavWriter::finish() {
    if (!mFile) return false;

    const bool patched = patchHeader();
    std::fclose(mFile);
    mFile = nullptr;

    // A header that could not be patched means the byte counts are wrong, so
    // the file is unplayable. Report it rather than handing back a bad draft.
    return patched && mFramesWritten > 0;
}

void WavWriter::abort() {
    if (mFile) {
        std::fclose(mFile);
        mFile = nullptr;
    }
    if (!mPath.empty()) {
        // Cancel must leave nothing behind -- a zero-length WAV would show up
        // in the draft list as a broken entry.
        std::remove(mPath.c_str());
    }
    mFramesWritten = 0;
}

int64_t WavWriter::durationMs() const {
    if (mSampleRate <= 0) return 0;
    return (mFramesWritten * 1000) / mSampleRate;
}

} // namespace roxstar
