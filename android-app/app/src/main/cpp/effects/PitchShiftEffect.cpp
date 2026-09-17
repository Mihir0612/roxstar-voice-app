#include "PitchShiftEffect.h"

#include <algorithm>
#include <cmath>

namespace roxstar {

namespace {
constexpr float kMaxSemitones = 12.0f;
/**
 * 50 ms grains. Shorter makes speech sound robotic as the grain rate enters the
 * audible range; longer smears consonants.
 */
constexpr float kGrainSeconds = 0.050f;
/** History must exceed one grain plus the read lag, with headroom. */
constexpr float kHistorySeconds = 0.5f;

inline float clampf(float v, float lo, float hi) {
    return std::max(lo, std::min(hi, v));
}
} // namespace

PitchShiftEffect::PitchShiftEffect(float semitones)
    : mSemitones(clampf(semitones, -kMaxSemitones, kMaxSemitones)) {
    mPitchRatio = std::pow(2.0f, mSemitones / 12.0f);
}

void PitchShiftEffect::setSemitones(float semitones) {
    mSemitones = clampf(semitones, -kMaxSemitones, kMaxSemitones);
    // Cached here so the audio thread never calls pow().
    mPitchRatio = std::pow(2.0f, mSemitones / 12.0f);
}

void PitchShiftEffect::prepare(int32_t sampleRate, int32_t channelCount) {
    mSampleRate = sampleRate > 0 ? sampleRate : 48000;
    mChannelCount = channelCount > 0 ? channelCount : 1;

    mBufferFrames = static_cast<size_t>(kHistorySeconds * static_cast<float>(mSampleRate));
    mGrainFrames = static_cast<size_t>(kGrainSeconds * static_cast<float>(mSampleRate));
    if (mGrainFrames < 2) mGrainFrames = 2;

    mBuffer.assign(mBufferFrames * static_cast<size_t>(mChannelCount), 0.0f);

    // PERIODIC Hann (divide by N, not N-1), precomputed once.
    //
    // The periodic form is what makes w(p) + w(p + N/2) == 1 exactly, which is
    // the property the two-head crossfade depends on; the symmetric form
    // (N-1) leaves a small ripple that shows up as level pumping at the grain
    // rate. Precomputed because a cos() per sample would be the single most
    // expensive thing in the callback.
    mWindow.resize(mGrainFrames);
    for (size_t i = 0; i < mGrainFrames; ++i) {
        mWindow[i] = 0.5f * (1.0f - std::cos(2.0f * static_cast<float>(M_PI) *
                                             static_cast<float>(i) /
                                             static_cast<float>(mGrainFrames)));
    }

    mWritePos = 0;
    mPhase = 0.0f;
}

float PitchShiftEffect::sampleAt(float framePos, size_t channel, size_t channelCount) const {
    // Wrap into the circular buffer, handling negative positions.
    const float wrapped =
        std::fmod(framePos + static_cast<float>(mBufferFrames), static_cast<float>(mBufferFrames));

    const size_t i0 = static_cast<size_t>(wrapped);
    const size_t i1 = (i0 + 1) % mBufferFrames;
    const float frac = wrapped - static_cast<float>(i0);

    const float a = mBuffer[i0 * channelCount + channel];
    const float b = mBuffer[i1 * channelCount + channel];

    // Linear interpolation: the read pointer lands between samples whenever
    // the pitch ratio is not an integer, which is essentially always.
    return a + frac * (b - a);
}

void PitchShiftEffect::process(float* audio, int32_t numFrames, int32_t channelCount) {
    if (mBuffer.empty() || channelCount != mChannelCount || mGrainFrames < 2) return;

    const size_t channels = static_cast<size_t>(channelCount);
    const float grainF = static_cast<float>(mGrainFrames);
    const float halfGrain = grainF * 0.5f;

    // How fast the read delay ramps. Zero at ratio 1.0, which is why unity
    // ratio is an exact pass-through rather than an approximation.
    const float phaseStep = 1.0f - mPitchRatio;

    for (int32_t frame = 0; frame < numFrames; ++frame) {
        // 1. Write the incoming frame into the history buffer.
        for (size_t ch = 0; ch < channels; ++ch) {
            mBuffer[mWritePos * channels + ch] = audio[static_cast<size_t>(frame) * channels + ch];
        }

        // 2. Two read heads, half a grain apart, so the wrap discontinuity in
        //    one is always masked by the other fading in.
        const float phaseA = mPhase;
        const float phaseB = phaseA < halfGrain ? phaseA + halfGrain : phaseA - halfGrain;

        const size_t windowA = static_cast<size_t>(phaseA) % mGrainFrames;
        const size_t windowB = static_cast<size_t>(phaseB) % mGrainFrames;

        // The extra -1 keeps the interpolator from straddling the write head:
        // at delay 0 the "next" sample would be the oldest one in the buffer,
        // which is a full-buffer-wide discontinuity.
        const float posA = static_cast<float>(mWritePos) - 1.0f - phaseA;
        const float posB = static_cast<float>(mWritePos) - 1.0f - phaseB;

        for (size_t ch = 0; ch < channels; ++ch) {
            const float a = sampleAt(posA, ch, channels) * mWindow[windowA];
            const float b = sampleAt(posB, ch, channels) * mWindow[windowB];

            // Periodic Hann windows half a grain apart sum to unity, so no
            // make-up gain is needed and the level stays consistent.
            audio[static_cast<size_t>(frame) * channels + ch] = clampf(a + b, -1.0f, 1.0f);
        }

        // 3. Advance. The write head moves one frame; the delay ramps by
        //    (1 - ratio), so the read head effectively advances `ratio` input
        //    frames per output frame.
        mWritePos = (mWritePos + 1) % mBufferFrames;

        mPhase += phaseStep;
        if (mPhase >= grainF) mPhase -= grainF;
        else if (mPhase < 0.0f) mPhase += grainF;
    }
}

void PitchShiftEffect::reset() {
    std::fill(mBuffer.begin(), mBuffer.end(), 0.0f);
    mWritePos = 0;
    mPhase = 0.0f;
}

} // namespace roxstar
