#include "ReverseEchoEffect.h"

#include <algorithm>
#include <cmath>

namespace roxstar {

namespace {
constexpr float kMaxFeedback = 0.90f;
constexpr float kMinDelaySeconds = 0.05f;
constexpr float kMaxDelaySeconds = 2.0f;

inline float clampf(float v, float lo, float hi) {
    return std::max(lo, std::min(hi, v));
}
} // namespace

ReverseEchoEffect::ReverseEchoEffect(float delaySeconds, float feedback, float mix)
    : mDelaySeconds(clampf(delaySeconds, kMinDelaySeconds, kMaxDelaySeconds)),
      mFeedback(clampf(feedback, 0.0f, kMaxFeedback)),
      mMix(clampf(mix, 0.0f, 1.0f)) {}

void ReverseEchoEffect::setParameters(float delaySeconds, float feedback, float mix) {
    mDelaySeconds = clampf(delaySeconds, kMinDelaySeconds, kMaxDelaySeconds);
    mFeedback = clampf(feedback, 0.0f, kMaxFeedback);
    mMix = clampf(mix, 0.0f, 1.0f);
}

void ReverseEchoEffect::prepare(int32_t sampleRate, int32_t channelCount) {
    mSampleRate = sampleRate > 0 ? sampleRate : 48000;
    mChannelCount = channelCount > 0 ? channelCount : 1;

    mDelayFrames = static_cast<size_t>(mDelaySeconds * static_cast<float>(mSampleRate));
    if (mDelayFrames == 0) mDelayFrames = 1;

    mBlockSize = static_cast<size_t>(0.05f * static_cast<float>(mSampleRate)); // 50ms reversal blocks
    if (mBlockSize == 0) mBlockSize = 256;

    mBuffer.assign(mDelayFrames * static_cast<size_t>(mChannelCount), 0.0f);
    mWriteIndex = 0;
}

void ReverseEchoEffect::process(float* audio, int32_t numFrames, int32_t channelCount) {
    if (mBuffer.empty() || channelCount != mChannelCount) return;

    const size_t channels = static_cast<size_t>(channelCount);
    const size_t totalDelaySamples = mDelayFrames * channels;

    for (int32_t frame = 0; frame < numFrames; ++frame) {
        const size_t slot = mWriteIndex * channels;
        const size_t blockOffset = (mWriteIndex % mBlockSize);
        const size_t reverseBlockOffset = (mBlockSize - 1 - blockOffset);

        // Read sample from reversed offset within history window
        size_t readFrameIndex = 0;
        if (mWriteIndex >= mDelayFrames) {
            readFrameIndex = mWriteIndex - mDelayFrames + reverseBlockOffset;
        } else {
            readFrameIndex = (mWriteIndex + mDelayFrames - (mBlockSize - reverseBlockOffset)) % mDelayFrames;
        }

        const size_t readSlot = (readFrameIndex % mDelayFrames) * channels;

        for (size_t ch = 0; ch < channels; ++ch) {
            const size_t idx = static_cast<size_t>(frame) * channels + ch;

            const float dry = audio[idx];
            const float delayedRev = mBuffer[readSlot + ch];

            const float wet = dry + mFeedback * delayedRev;

            mBuffer[slot + ch] = wet;

            audio[idx] = clampf(dry * (1.0f - mMix) + wet * mMix, -1.0f, 1.0f);
        }

        mWriteIndex = (mWriteIndex + 1) % mDelayFrames;
    }
}

void ReverseEchoEffect::reset() {
    std::fill(mBuffer.begin(), mBuffer.end(), 0.0f);
    mWriteIndex = 0;
}

} // namespace roxstar
