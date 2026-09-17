#ifndef ROXSTAR_PITCH_SHIFT_EFFECT_H
#define ROXSTAR_PITCH_SHIFT_EFFECT_H

#include <vector>

#include "AudioEffect.h"

namespace roxstar {

/**
 * Pitch shift by overlap-add resampling (a time-domain granular shifter).
 *
 * Why this and not a phase vocoder: an FFT-based shifter gives better quality
 * on tonal material, but it needs an FFT library, a much larger latency window
 * and far more CPU inside the real-time callback. For a short voice clip the
 * time-domain approach is the right trade -- it is a few hundred lines lighter,
 * allocates nothing on the audio thread, and the artefacts it does produce are
 * exactly the "chipmunk / deep voice" character the feature is for.
 *
 * How it works:
 *   Input is written into a circular buffer. Output is read from a point
 *   `delay` samples behind the write head, and that delay RAMPS by
 *   (1 - pitchRatio) per output frame:
 *
 *       readPos(n)  = writePos(n) - delay(n)
 *       delay(n+1)  = delay(n) + (1 - pitchRatio),  wrapped into [0, grain)
 *
 *   So the read pointer advances by 1 + (pitchRatio - 1) = pitchRatio input
 *   samples per output sample. Ratio > 1 reads faster than the input arrives
 *   and raises the pitch; ratio < 1 reads slower and lowers it; ratio == 1
 *   holds the delay constant and passes the signal through unchanged.
 *
 *   The ramp has to wrap, and the wrap is a discontinuity. That is what the
 *   second read head is for: it runs half a grain out of phase, so one head is
 *   fading in while the other fades out. Both are windowed with a periodic
 *   Hann curve, and w(p) + w(p + grain/2) == 1, so the crossfade sums to unity
 *   gain instead of pumping.
 */
class PitchShiftEffect final : public AudioEffect {
public:
    /** @param semitones -12 (an octave down) to +12 (an octave up). */
    explicit PitchShiftEffect(float semitones = 5.0f);

    void prepare(int32_t sampleRate, int32_t channelCount) override;
    void process(float* audio, int32_t numFrames, int32_t channelCount) override;
    void reset() override;

    const char* name() const override { return "PITCH_SHIFT"; }

    void setSemitones(float semitones);

private:
    float mSemitones;
    /** 2^(semitones/12). Cached so `process` does no pow(). */
    float mPitchRatio = 1.0f;

    int32_t mSampleRate = 48000;
    int32_t mChannelCount = 1;

    std::vector<float> mBuffer;      ///< circular input history, interleaved
    std::vector<float> mWindow;      ///< precomputed periodic Hann window, one grain long

    size_t mBufferFrames = 0;
    size_t mGrainFrames = 0;
    size_t mWritePos = 0;
    /**
     * Current read delay in frames, within [0, grainFrames).
     * Ramps by (1 - pitchRatio) each output frame and wraps at the grain
     * boundary; the second head reads at mPhase + grainFrames/2.
     */
    float mPhase = 0.0f;

    /** Linear interpolation between neighbouring frames of the history buffer. */
    float sampleAt(float framePos, size_t channel, size_t channelCount) const;
};

} // namespace roxstar

#endif // ROXSTAR_PITCH_SHIFT_EFFECT_H
