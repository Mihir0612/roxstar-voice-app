#ifndef ROXSTAR_REVERSE_ECHO_EFFECT_H
#define ROXSTAR_REVERSE_ECHO_EFFECT_H

#include <vector>

#include "AudioEffect.h"

namespace roxstar {

/**
 * Reverse Echo Effect.
 *
 * Implements a backwards delay effect by storing input blocks into a circular history
 * buffer and playing back reversed delay tails mixed with feedback.
 *
 * Real-time safe: pre-allocates buffer in prepare(), zero allocations inside process().
 */
class ReverseEchoEffect final : public AudioEffect {
public:
    ReverseEchoEffect(float delaySeconds = 0.35f, float feedback = 0.5f, float mix = 0.55f);

    void prepare(int32_t sampleRate, int32_t channelCount) override;
    void process(float* audio, int32_t numFrames, int32_t channelCount) override;
    void reset() override;

    const char* name() const override { return "REVERSE_ECHO"; }

    void setParameters(float delaySeconds, float feedback, float mix);

private:
    float mDelaySeconds;
    float mFeedback;
    float mMix;

    int32_t mSampleRate = 48000;
    int32_t mChannelCount = 1;

    std::vector<float> mBuffer;
    size_t mWriteIndex = 0;
    size_t mDelayFrames = 0;
    size_t mBlockSize = 512;
};

} // namespace roxstar

#endif // ROXSTAR_REVERSE_ECHO_EFFECT_H
