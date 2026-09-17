#ifndef ROXSTAR_AUDIO_EFFECT_H
#define ROXSTAR_AUDIO_EFFECT_H

#include <cstdint>

namespace roxstar {

/**
 * Base class for every voice effect.
 *
 * The hard rule for all implementations: `process` runs on the Oboe callback
 * thread, which has a hard real-time deadline. Inside it there must be
 *
 *   - no allocation,
 *   - no locking,
 *   - no syscalls,
 *   - no logging.
 *
 * Every buffer an effect needs is sized once in `prepare`, which runs on the
 * calling thread before the stream starts. Breaking this rule does not produce
 * a slow app; it produces audible clicks and dropouts.
 */
class AudioEffect {
public:
    virtual ~AudioEffect() = default;

    /**
     * Allocate and size internal state. Called off the audio thread, before
     * the stream starts.
     */
    virtual void prepare(int32_t sampleRate, int32_t channelCount) = 0;

    /**
     * Process `numFrames` of interleaved float audio in place.
     * MUST be real-time safe.
     */
    virtual void process(float* audio, int32_t numFrames, int32_t channelCount) = 0;

    /**
     * Clear any tail state (delay lines, buffers) without reallocating, so the
     * next recording does not begin with the echo of the previous one.
     */
    virtual void reset() = 0;

    virtual const char* name() const = 0;
};

} // namespace roxstar

#endif // ROXSTAR_AUDIO_EFFECT_H
