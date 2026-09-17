#include "EchoEffect.h"

#include <algorithm>
#include <cmath>

namespace roxstar {

namespace {
/** Above 0.95 the tail takes uncomfortably long to decay; at 1.0 it never does. */
constexpr float kMaxFeedback = 0.95f;
constexpr float kMinDelaySeconds = 0.01f;
constexpr float kMaxDelaySeconds = 2.0f;

inline float clampf(float v, float lo, float hi) {
    return std::max(lo, std::min(hi, v));
}
} // namespace

EchoEffect::EchoEffect(float delaySeconds, float feedback, float mix)
    : mDelaySeconds(clampf(delaySeconds, kMinDelaySeconds, kMaxDelaySeconds)),
      mFeedback(clampf(feedback, 0.0f, kMaxFeedback)),
      mMix(clampf(mix, 0.0f, 1.0f)) {}

void EchoEffect::setParameters(float delaySeconds, float feedback, float mix) {
    mDelaySeconds = clampf(delaySeconds, kMinDelaySeconds, kMaxDelaySeconds);
    mFeedback = clampf(feedback, 0.0f, kMaxFeedback);
    mMix = clampf(mix, 0.0f, 1.0f);
}

void EchoEffect::prepare(int32_t sampleRate, int32_t channelCount) {
    mSampleRate = sampleRate > 0 ? sampleRate : 48000;
    mChannelCount = channelCount > 0 ? channelCount : 1;

    mDelayFrames = static_cast<size_t>(mDelaySeconds * static_cast<float>(mSampleRate));
    if (mDelayFrames == 0) mDelayFrames = 1;

    // Allocated exactly once, here, off the audio thread. `process` only ever
    // indexes into it.
    mBuffer.assign(mDelayFrames * static_cast<size_t>(mChannelCount), 0.0f);
    mWriteIndex = 0;
}

void EchoEffect::process(float* audio, int32_t numFrames, int32_t channelCount) {
    // A stream restart can hand us a different channel count than we prepared
    // for. Skipping is the safe response; the alternative is reading out of
    // bounds on the audio thread.
    if (mBuffer.empty() || channelCount != mChannelCount) return;

    const size_t channels = static_cast<size_t>(channelCount);

    for (int32_t frame = 0; frame < numFrames; ++frame) {
        const size_t slot = mWriteIndex * channels;

        for (size_t ch = 0; ch < channels; ++ch) {
            const size_t idx = static_cast<size_t>(frame) * channels + ch;

            const float dry = audio[idx];
            const float delayed = mBuffer[slot + ch];

            // Feed the mixed signal back in so the echo repeats and decays,
            // rather than producing one isolated slap.
            const float wet = dry + mFeedback * delayed;

            mBuffer[slot + ch] = wet;

            // Hard clip: the feedback path can exceed unity on loud input, and
            // a float above 1.0 becomes a harsh wrap when converted to int16.
            audio[idx] = clampf(dry * (1.0f - mMix) + wet * mMix, -1.0f, 1.0f);
        }

        mWriteIndex = (mWriteIndex + 1) % mDelayFrames;
    }
}

void EchoEffect::reset() {
    // Clear the tail without reallocating -- the next recording must not open
    // with the echo of the previous one.
    std::fill(mBuffer.begin(), mBuffer.end(), 0.0f);
    mWriteIndex = 0;
}

} // namespace roxstar
