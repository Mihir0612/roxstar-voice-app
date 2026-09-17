#ifndef ROXSTAR_ECHO_EFFECT_H
#define ROXSTAR_ECHO_EFFECT_H

#include <vector>

#include "AudioEffect.h"

namespace roxstar {

/**
 * Feedback-delay echo.
 *
 *   out[n] = in[n] + feedback * delayLine[n - D]
 *   delayLine[n] = out[n]
 *
 * Writing the mixed output back into the delay line (rather than the dry
 * input) is what makes the echo repeat and decay instead of producing a single
 * slap. Each repeat is `feedback` times quieter than the last, so with
 * feedback < 1 the tail converges; the decay is geometric, which is why the
 * ring buffer never needs to be longer than one delay period.
 *
 * Implemented as a circular buffer sized once in `prepare`, so `process`
 * allocates nothing and is safe to run on the Oboe callback thread.
 */
class EchoEffect final : public AudioEffect {
public:
    EchoEffect(float delaySeconds = 0.25f, float feedback = 0.45f, float mix = 0.5f);

    void prepare(int32_t sampleRate, int32_t channelCount) override;
    void process(float* audio, int32_t numFrames, int32_t channelCount) override;
    void reset() override;

    const char* name() const override { return "ECHO"; }

    void setParameters(float delaySeconds, float feedback, float mix);

private:
    float mDelaySeconds;
    /** Clamped below 1.0: at or above it the echo grows without bound. */
    float mFeedback;
    /** Dry/wet balance, 0 = dry only, 1 = wet only. */
    float mMix;

    int32_t mSampleRate = 48000;
    int32_t mChannelCount = 1;

    /** Circular delay line, interleaved, sized in `prepare`. */
    std::vector<float> mBuffer;
    size_t mWriteIndex = 0;
    size_t mDelayFrames = 0;
};

} // namespace roxstar

#endif // ROXSTAR_ECHO_EFFECT_H
