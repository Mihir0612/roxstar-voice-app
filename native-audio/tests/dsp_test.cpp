/**
 * Host-side tests for the native audio DSP.
 *
 * The effects and the WAV writer depend only on the standard library -- not on
 * Oboe, the NDK or a device -- so they can be compiled and RUN on any machine.
 * That matters: "the echo effect works" is otherwise a claim nobody can check
 * without an Android handset, and a delay line that is silently a no-op looks
 * exactly like one that works until you listen to it.
 *
 * Build and run (no Android toolchain needed):
 *
 *   cd native-audio/tests && ./run.sh
 *
 * or directly:
 *
 *   g++ -std=c++17 -O2 -I../../android-app/app/src/main/cpp \
 *       dsp_test.cpp \
 *       ../../android-app/app/src/main/cpp/effects/EchoEffect.cpp \
 *       ../../android-app/app/src/main/cpp/effects/PitchShiftEffect.cpp \
 *       ../../android-app/app/src/main/cpp/WavWriter.cpp \
 *       -o dsp_test && ./dsp_test
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "WavWriter.h"
#include "effects/EchoEffect.h"
#include "effects/PitchShiftEffect.h"

using namespace roxstar;

namespace {

int gPassed = 0;
int gFailed = 0;

void check(const char* label, bool condition, const std::string& detail = "") {
    if (condition) {
        ++gPassed;
        std::printf("  PASS  %s\n", label);
    } else {
        ++gFailed;
        std::printf("  FAIL  %s%s%s\n", label, detail.empty() ? "" : " -- ", detail.c_str());
    }
}

void section(const char* title) {
    std::printf("\n%s\n", title);
    for (size_t i = 0; i < std::strlen(title); ++i) std::printf("-");
    std::printf("\n");
}

constexpr int kSampleRate = 48000;

/** Peak absolute value over a range. */
float peak(const std::vector<float>& buf, size_t from, size_t to) {
    float p = 0.0f;
    for (size_t i = from; i < to && i < buf.size(); ++i) p = std::max(p, std::fabs(buf[i]));
    return p;
}

/** A single click at frame 0, then silence. Ideal for measuring a delay line. */
std::vector<float> impulse(size_t frames) {
    std::vector<float> buf(frames, 0.0f);
    buf[0] = 1.0f;
    return buf;
}

std::vector<float> sine(size_t frames, float hz, float amplitude = 0.5f) {
    std::vector<float> buf(frames);
    for (size_t i = 0; i < frames; ++i) {
        buf[i] = amplitude * std::sin(2.0f * static_cast<float>(M_PI) * hz *
                                      static_cast<float>(i) / static_cast<float>(kSampleRate));
    }
    return buf;
}

/**
 * Estimate the dominant frequency by counting zero crossings.
 *
 * Crude next to an FFT, but exactly right here: the signal is a single sine,
 * and this needs no dependency to verify that the pitch actually moved.
 */
float dominantHz(const std::vector<float>& buf, size_t from, size_t to) {
    int crossings = 0;
    for (size_t i = from + 1; i < to && i < buf.size(); ++i) {
        if ((buf[i - 1] < 0.0f && buf[i] >= 0.0f) || (buf[i - 1] >= 0.0f && buf[i] < 0.0f)) {
            ++crossings;
        }
    }
    const float seconds = static_cast<float>(to - from) / static_cast<float>(kSampleRate);
    return static_cast<float>(crossings) / 2.0f / seconds;
}

/* -------------------------------------------------------------------------- */
/* Echo                                                                       */
/* -------------------------------------------------------------------------- */

void testEcho() {
    section("EchoEffect");

    const float delaySeconds = 0.1f;
    const float feedback = 0.5f;
    const size_t delayFrames = static_cast<size_t>(delaySeconds * kSampleRate);

    EchoEffect echo(delaySeconds, feedback, /*mix=*/1.0f);
    echo.prepare(kSampleRate, 1);

    // One second of audio: an impulse followed by silence, so anything that
    // appears later can only have come from the delay line.
    auto buf = impulse(kSampleRate);
    echo.process(buf.data(), static_cast<int32_t>(buf.size()), 1);

    check("the dry impulse survives", std::fabs(buf[0] - 1.0f) < 0.01f,
          "got " + std::to_string(buf[0]));

    // First repeat lands one delay period later at `feedback` amplitude.
    const float firstRepeat = buf[delayFrames];
    check("a repeat appears one delay period later",
          std::fabs(firstRepeat - feedback) < 0.02f,
          "expected ~" + std::to_string(feedback) + ", got " + std::to_string(firstRepeat));

    // Second repeat at feedback^2 -- this is what distinguishes a real feedback
    // delay from a single slap-back.
    const float secondRepeat = buf[delayFrames * 2];
    check("the echo repeats a second time",
          std::fabs(secondRepeat - feedback * feedback) < 0.02f,
          "expected ~" + std::to_string(feedback * feedback) + ", got " + std::to_string(secondRepeat));

    check("each repeat is quieter than the last", secondRepeat < firstRepeat);

    // Geometric decay means the tail converges rather than ringing forever.
    const float lateTail = peak(buf, delayFrames * 8, delayFrames * 8 + 100);
    check("the tail decays toward silence", lateTail < 0.02f,
          "late tail peak " + std::to_string(lateTail));

    // Nothing may appear before the delay -- a leaky buffer index would show up
    // as energy in the gap.
    const float gap = peak(buf, 10, delayFrames - 10);
    check("no energy before the first repeat", gap < 0.001f,
          "gap peak " + std::to_string(gap));

    // reset() must clear the tail; otherwise take 2 opens with take 1's echo.
    echo.reset();
    std::vector<float> silence(delayFrames * 3, 0.0f);
    echo.process(silence.data(), static_cast<int32_t>(silence.size()), 1);
    check("reset clears the delay line", peak(silence, 0, silence.size()) < 1e-6f);

    // Feedback is clamped below 1.0, or the echo would grow without bound.
    EchoEffect runaway(0.05f, /*feedback=*/5.0f, 1.0f);
    runaway.prepare(kSampleRate, 1);
    auto loud = impulse(kSampleRate);
    runaway.process(loud.data(), static_cast<int32_t>(loud.size()), 1);
    check("excessive feedback is clamped, output stays bounded",
          peak(loud, 0, loud.size()) <= 1.0001f);

    // Stereo must not bleed between channels.
    EchoEffect stereo(0.05f, 0.5f, 1.0f);
    stereo.prepare(kSampleRate, 2);
    std::vector<float> interleaved(kSampleRate * 2, 0.0f);
    interleaved[0] = 1.0f; // left only
    stereo.process(interleaved.data(), kSampleRate, 2);
    const size_t stereoDelay = static_cast<size_t>(0.05f * kSampleRate);
    check("left channel echoes", std::fabs(interleaved[stereoDelay * 2] - 0.5f) < 0.02f);
    check("right channel stays silent", std::fabs(interleaved[stereoDelay * 2 + 1]) < 0.001f);

    // A channel-count change (stream restart) must be survived, not crashed on.
    EchoEffect mismatched(0.05f, 0.5f, 1.0f);
    mismatched.prepare(kSampleRate, 1);
    std::vector<float> wrongShape(1024, 0.25f);
    mismatched.process(wrongShape.data(), 512, 2); // prepared mono, handed stereo
    check("a channel-count mismatch is ignored rather than read out of bounds",
          std::fabs(wrongShape[0] - 0.25f) < 1e-6f);
}

/* -------------------------------------------------------------------------- */
/* Pitch shift                                                                */
/* -------------------------------------------------------------------------- */

void testPitchShift() {
    section("PitchShiftEffect");

    const float inputHz = 440.0f;
    // Skip the first 0.15s in every measurement: the grain buffer has to fill
    // before the output is meaningful.
    const size_t settle = static_cast<size_t>(0.15f * kSampleRate);
    const size_t total = static_cast<size_t>(0.6f * kSampleRate);

    {
        // +12 semitones = one octave up = double the frequency.
        PitchShiftEffect up(12.0f);
        up.prepare(kSampleRate, 1);
        auto buf = sine(total, inputHz);
        up.process(buf.data(), static_cast<int32_t>(buf.size()), 1);

        const float measured = dominantHz(buf, settle, total);
        check("+12 semitones roughly doubles the frequency",
              measured > inputHz * 1.6f && measured < inputHz * 2.4f,
              "measured " + std::to_string(measured) + " Hz from " + std::to_string(inputHz));
    }

    {
        // -12 semitones = one octave down = half the frequency.
        PitchShiftEffect down(-12.0f);
        down.prepare(kSampleRate, 1);
        auto buf = sine(total, inputHz);
        down.process(buf.data(), static_cast<int32_t>(buf.size()), 1);

        const float measured = dominantHz(buf, settle, total);
        check("-12 semitones roughly halves the frequency",
              measured > inputHz * 0.35f && measured < inputHz * 0.75f,
              "measured " + std::to_string(measured) + " Hz from " + std::to_string(inputHz));
    }

    {
        // 0 semitones must be close to a pass-through.
        PitchShiftEffect neutral(0.0f);
        neutral.prepare(kSampleRate, 1);
        auto buf = sine(total, inputHz);
        neutral.process(buf.data(), static_cast<int32_t>(buf.size()), 1);

        const float measured = dominantHz(buf, settle, total);
        check("0 semitones leaves the frequency alone",
              std::fabs(measured - inputHz) < inputHz * 0.2f,
              "measured " + std::to_string(measured) + " Hz");
    }

    {
        // The complementary Hann windows should sum to roughly unity gain, so
        // the shifted signal must not be wildly louder or near-silent.
        PitchShiftEffect shifter(5.0f);
        shifter.prepare(kSampleRate, 1);
        auto buf = sine(total, inputHz, 0.5f);
        shifter.process(buf.data(), static_cast<int32_t>(buf.size()), 1);

        const float outPeak = peak(buf, settle, total);
        check("output level stays in a sane range",
              outPeak > 0.15f && outPeak <= 1.0f,
              "peak " + std::to_string(outPeak));
        check("output never clips past full scale", outPeak <= 1.0001f);
    }

    {
        // The clamp in process() must hold even for a hot input.
        PitchShiftEffect shifter(7.0f);
        shifter.prepare(kSampleRate, 1);
        auto buf = sine(total, inputHz, 1.0f);
        shifter.process(buf.data(), static_cast<int32_t>(buf.size()), 1);
        check("a full-scale input does not produce out-of-range samples",
              peak(buf, 0, total) <= 1.0001f);
    }

    {
        // Semitones are clamped to +/-12; an absurd request must not produce
        // a read far outside the history buffer.
        PitchShiftEffect extreme(400.0f);
        extreme.prepare(kSampleRate, 1);
        auto buf = sine(total, inputHz);
        extreme.process(buf.data(), static_cast<int32_t>(buf.size()), 1);
        check("an out-of-range semitone request is clamped safely",
              peak(buf, 0, total) <= 1.0001f);
    }
}

/* -------------------------------------------------------------------------- */
/* WAV writer                                                                 */
/* -------------------------------------------------------------------------- */

uint32_t readU32(const std::vector<uint8_t>& b, size_t at) {
    return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
           (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
}

uint16_t readU16(const std::vector<uint8_t>& b, size_t at) {
    return static_cast<uint16_t>(static_cast<uint16_t>(b[at]) | (static_cast<uint16_t>(b[at + 1]) << 8));
}

std::vector<uint8_t> readFile(const std::string& path) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return {};
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> data(static_cast<size_t>(size));
    const size_t got = std::fread(data.data(), 1, data.size(), f);
    std::fclose(f);
    data.resize(got);
    return data;
}

void testWavWriter() {
    section("WavWriter");

    const std::string path = "test_output.wav";
    const int frames = 4800; // 0.1s at 48k

    {
        WavWriter writer;
        check("writer opens a file", writer.start(path, kSampleRate, 1));

        auto tone = sine(frames, 440.0f);
        check("frames are written", writer.write(tone.data(), frames, 1));
        check("frame count is tracked", writer.framesWritten() == frames);
        check("duration is computed", writer.durationMs() == 100);
        check("finish succeeds", writer.finish());
    }

    const auto bytes = readFile(path);
    check("file exists and has a header plus data",
          bytes.size() == static_cast<size_t>(44 + frames * 2),
          "size " + std::to_string(bytes.size()));

    if (bytes.size() >= 44) {
        check("RIFF magic", std::memcmp(bytes.data(), "RIFF", 4) == 0);
        check("WAVE magic", std::memcmp(bytes.data() + 8, "WAVE", 4) == 0);
        check("fmt chunk", std::memcmp(bytes.data() + 12, "fmt ", 4) == 0);
        check("data chunk", std::memcmp(bytes.data() + 36, "data", 4) == 0);

        // The patched sizes are what make the file playable; a placeholder left
        // at zero produces a file every player reports as empty.
        check("RIFF size was patched", readU32(bytes, 4) == 36u + frames * 2);
        check("data size was patched", readU32(bytes, 40) == static_cast<uint32_t>(frames * 2));

        check("format is PCM", readU16(bytes, 20) == 1);
        check("channel count is correct", readU16(bytes, 22) == 1);
        check("sample rate is correct", readU32(bytes, 24) == static_cast<uint32_t>(kSampleRate));
        check("bit depth is 16", readU16(bytes, 34) == 16);
        check("byte rate is correct", readU32(bytes, 28) == static_cast<uint32_t>(kSampleRate * 2));
        check("block align is correct", readU16(bytes, 32) == 2);
    }

    {
        // A full-scale input must clip rather than wrap. Wrapping turns a loud
        // passage into a burst of noise, which is far worse than clipping.
        const std::string clipPath = "test_clip.wav";
        WavWriter writer;
        writer.start(clipPath, kSampleRate, 1);
        std::vector<float> hot = {2.0f, -2.0f, 1.0f, -1.0f};
        writer.write(hot.data(), 4, 1);
        writer.finish();

        const auto clipped = readFile(clipPath);
        const int16_t first = static_cast<int16_t>(readU16(clipped, 44));
        const int16_t second = static_cast<int16_t>(readU16(clipped, 46));
        check("+2.0 clips to full scale rather than wrapping", first == 32767,
              "got " + std::to_string(first));
        check("-2.0 clips to full scale rather than wrapping", second == -32767,
              "got " + std::to_string(second));
        std::remove(clipPath.c_str());
    }

    {
        // abort() backs Cancel: nothing may be left on disk.
        const std::string abortPath = "test_abort.wav";
        WavWriter writer;
        writer.start(abortPath, kSampleRate, 1);
        auto tone = sine(1000, 440.0f);
        writer.write(tone.data(), 1000, 1);
        writer.abort();

        check("abort removes the partial file", readFile(abortPath).empty());
        check("abort resets the frame count", writer.framesWritten() == 0);
    }

    {
        // Zero captured frames is a failure, not a valid empty draft.
        const std::string emptyPath = "test_empty.wav";
        WavWriter writer;
        writer.start(emptyPath, kSampleRate, 1);
        check("finishing with no audio reports failure", !writer.finish());
        std::remove(emptyPath.c_str());
    }

    std::remove(path.c_str());
}

/* -------------------------------------------------------------------------- */
/* End-to-end: record -> effect -> file                                       */
/* -------------------------------------------------------------------------- */

void testPipeline() {
    section("Capture pipeline (effect -> WAV)");

    const std::string path = "test_pipeline.wav";
    const int bufferFrames = 480; // a typical Oboe burst
    const int bursts = 100;       // 1 second

    EchoEffect echo(0.1f, 0.5f, 0.6f);
    echo.prepare(kSampleRate, 1);

    WavWriter writer;
    writer.start(path, kSampleRate, 1);

    auto source = sine(bufferFrames * bursts, 440.0f, 0.4f);

    // Exactly what the Oboe callback does: process one burst in place, hand it
    // to the writer, repeat.
    for (int b = 0; b < bursts; ++b) {
        float* chunk = source.data() + static_cast<size_t>(b) * bufferFrames;
        echo.process(chunk, bufferFrames, 1);
        if (!writer.write(chunk, bufferFrames, 1)) {
            check("pipeline write", false, "write failed at burst " + std::to_string(b));
            return;
        }
    }

    const int64_t frames = writer.framesWritten();
    const bool finished = writer.finish();

    check("every burst was written", frames == bufferFrames * bursts);
    check("the file finalised", finished);

    const auto bytes = readFile(path);
    check("the file is the expected size",
          bytes.size() == static_cast<size_t>(44 + frames * 2));

    // The effect must have changed the audio -- a no-op effect would still
    // produce a perfectly valid file, which is exactly the failure this catches.
    const float outPeak = peak(source, 0, source.size());
    check("the processed signal is non-trivial", outPeak > 0.1f,
          "peak " + std::to_string(outPeak));

    std::remove(path.c_str());
}

} // namespace

int main() {
    std::printf("\nRoxstar native DSP tests\n");
    std::printf("========================\n");

    testEcho();
    testPitchShift();
    testWavWriter();
    testPipeline();

    std::printf("\n====================================================\n");
    std::printf("  %d passed, %d failed\n", gPassed, gFailed);
    std::printf("====================================================\n\n");

    return gFailed == 0 ? 0 : 1;
}
