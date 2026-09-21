#include <jni.h>

#include <memory>
#include <string>

#include "AudioEngine.h"

/**
 * JNI bridge between Kotlin's NativeAudioBridge and the Oboe engine.
 *
 * The engine is a single process-wide instance: there is one microphone, so a
 * second engine could only ever fail to open a stream. It is created lazily on
 * the first call and torn down explicitly from `nativeRelease`, which the
 * ViewModel calls in onCleared.
 *
 * Every function returns an int status rather than throwing. A JNI exception
 * crossing back into a Kotlin coroutine is awkward to handle and easy to get
 * wrong; an enum the Kotlin side maps to a sealed class is not.
 */

namespace {

std::unique_ptr<roxstar::AudioEngine> gEngine;

roxstar::AudioEngine* engine() {
    if (!gEngine) gEngine = std::make_unique<roxstar::AudioEngine>();
    return gEngine.get();
}

std::string toStdString(JNIEnv* env, jstring value) {
    if (!value) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars ? chars : "");
    if (chars) env->ReleaseStringUTFChars(value, chars);
    return result;
}

} // namespace

extern "C" {

JNIEXPORT jint JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeStartRecording(
    JNIEnv* env, jobject /*thiz*/, jstring outputPath, jint effectOrdinal) {

    const std::string path = toStdString(env, outputPath);
    if (path.empty()) return static_cast<jint>(roxstar::EngineResult::FileOpenFailed);

    // Anything outside the known range becomes None rather than undefined
    // behaviour -- the ordinal crosses a language boundary and must be treated
    // as untrusted input.
    auto effect = roxstar::EffectType::None;
    switch (effectOrdinal) {
        case 1: effect = roxstar::EffectType::Echo; break;
        case 2: effect = roxstar::EffectType::Reverb; break;
        case 3: effect = roxstar::EffectType::PitchShift; break;
        case 4: effect = roxstar::EffectType::ReverseEcho; break;
        default: break;
    }

    return static_cast<jint>(engine()->startRecording(path, effect));
}

JNIEXPORT jint JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeStopRecording(JNIEnv*, jobject) {
    return static_cast<jint>(engine()->stopRecording());
}

JNIEXPORT void JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeCancelRecording(JNIEnv*, jobject) {
    engine()->cancelRecording();
}

JNIEXPORT jboolean JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeIsRecording(JNIEnv*, jobject) {
    return gEngine && gEngine->isRecording() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jlong JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeGetDurationMs(JNIEnv*, jobject) {
    return gEngine ? static_cast<jlong>(gEngine->durationMs()) : 0;
}

JNIEXPORT jfloat JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeGetLevel(JNIEnv*, jobject) {
    return gEngine ? static_cast<jfloat>(gEngine->currentLevel()) : 0.0f;
}

JNIEXPORT jint JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeGetSampleRate(JNIEnv*, jobject) {
    return gEngine ? static_cast<jint>(gEngine->sampleRate()) : 0;
}

JNIEXPORT void JNICALL
Java_com_roxstar_app_audio_NativeAudioBridge_nativeRelease(JNIEnv*, jobject) {
    // Destructor cancels any recording in flight and closes the stream, so the
    // microphone is released even if the app is killed mid-take.
    gEngine.reset();
}

} // extern "C"
