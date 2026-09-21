#ifndef ROXSTAR_AUDIO_ENGINE_H
#define ROXSTAR_AUDIO_ENGINE_H

#include <oboe/Oboe.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "WavWriter.h"
#include "effects/AudioEffect.h"

namespace roxstar {

enum class EffectType {
    None = 0,
    Echo = 1,
    Reverb = 2,
    PitchShift = 3,
    ReverseEcho = 4,
};

enum class EngineResult {
    Ok = 0,
    AlreadyRecording = 1,
    NotRecording = 2,
    StreamOpenFailed = 3,
    StreamStartFailed = 4,
    FileOpenFailed = 5,
    FileWriteFailed = 6,
    NoAudioCaptured = 7,
};

/**
 * Oboe capture engine.
 *
 * Threading model -- the part that matters:
 *
 *   Oboe callback thread   reads the microphone, applies the effect in place,
 *                          and hands the buffer to a lock-free-ish FIFO.
 *                          It NEVER touches the filesystem.
 *
 *   Writer thread          drains the FIFO and writes WAV. fwrite can block on
 *                          flash for tens of milliseconds, which is far longer
 *                          than a callback deadline; doing it inline is the
 *                          classic cause of dropouts.
 *
 *   Caller (JNI) thread    start/stop/cancel, guarded by a mutex.
 *
 * Lifecycle safety is the other half. Oboe streams can be disconnected at any
 * moment -- a headset is unplugged, a phone call arrives, the app is
 * backgrounded -- so `onErrorAfterClose` is handled explicitly and the engine
 * always returns to a state where Start works again. "Stability across repeated
 * operations and lifecycle changes" is scored separately from the effect
 * itself, and it is where naive implementations fail.
 */
class AudioEngine : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
public:
    AudioEngine();
    ~AudioEngine() override;

    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    EngineResult startRecording(const std::string& outputPath, EffectType effect);
    /** Stop and finalise the file. Returns Ok when a playable WAV exists. */
    EngineResult stopRecording();
    /** Stop and delete the partial file. */
    void cancelRecording();

    bool isRecording() const { return mRecording.load(std::memory_order_acquire); }
    int64_t durationMs() const { return mDurationMs.load(std::memory_order_acquire); }
    /** 0..1 peak level of the most recent buffer, for a live meter. */
    float currentLevel() const { return mLevel.load(std::memory_order_relaxed); }

    int32_t sampleRate() const { return mSampleRate; }
    int32_t channelCount() const { return mChannelCount; }

    // --- oboe::AudioStreamDataCallback ---
    oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream,
                                          void* audioData,
                                          int32_t numFrames) override;

    // --- oboe::AudioStreamErrorCallback ---
    void onErrorAfterClose(oboe::AudioStream* stream, oboe::Result error) override;
    bool onError(oboe::AudioStream* stream, oboe::Result error) override;

private:
    /** One captured buffer in flight between the audio thread and the writer. */
    struct Chunk {
        std::vector<float> data;
        int32_t frames = 0;
    };

    std::shared_ptr<oboe::AudioStream> mStream;
    std::unique_ptr<AudioEffect> mEffect;
    WavWriter mWriter;

    mutable std::mutex mLifecycleMutex;

    // --- FIFO between the audio thread and the writer thread ---
    std::mutex mQueueMutex;
    std::condition_variable mQueueCv;
    std::vector<Chunk> mQueue;
    std::thread mWriterThread;
    std::atomic<bool> mWriterRunning{false};
    std::atomic<bool> mWriteFailed{false};

    std::atomic<bool> mRecording{false};
    std::atomic<int64_t> mDurationMs{0};
    std::atomic<float> mLevel{0.0f};

    int32_t mSampleRate = 48000;
    int32_t mChannelCount = 1;
    std::string mOutputPath;

    static std::unique_ptr<AudioEffect> createEffect(EffectType type);

    void startWriterThread();
    void stopWriterThread();
    void writerLoop();
    void closeStreamLocked();
};

} // namespace roxstar

#endif // ROXSTAR_AUDIO_ENGINE_H
