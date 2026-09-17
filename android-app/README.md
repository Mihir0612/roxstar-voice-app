# Roxstar Android client

Kotlin + Jetpack Compose client with a native Oboe audio path.

## Prerequisites

| Requirement | Version | Note |
|---|---|---|
| Android Studio | Ladybug (2024.2) or newer | Bundles a JDK 17 runtime |
| Android SDK | API 35 | `compileSdk`/`targetSdk` |
| **Android NDK** | 26.x or newer | **Required** -- the audio engine is C++ |
| CMake | 3.22.1 | Installed through the SDK Manager |
| Minimum device | API 26 | Oboe's AAudio backend needs 26+ |

Install the NDK and CMake from **Android Studio -> SDK Manager -> SDK Tools**,
or on the command line:

```bash
sdkmanager "ndk;26.3.11579264" "cmake;3.22.1"
```

Without the NDK the Gradle build fails at the CMake step. Oboe itself needs no
manual install -- it arrives as a Maven AAR with a prefab package.

## Configure the backend URL

Debug builds default to `http://10.0.2.2:8080`, which is the host machine as
seen from the emulator. Start the backend with `docker compose up` and a debug
build will reach it.

Release builds need the deployed URL. In `gradle.properties`:

```properties
ROXSTAR_API_BASE_URL=https://roxstar-backend-xxxxx.a.run.app
```

The build **fails** if this is left as the placeholder or points at localhost --
see `verifyReleaseEndpoint` in `app/build.gradle.kts`. An APK that can only talk
to a developer laptop is a failed submission, so the mistake is made impossible
rather than merely documented.

## Build

```bash
./gradlew assembleDebug                 # debug APK
./gradlew test                          # JVM unit tests
./gradlew assembleRelease -PROXSTAR_API_BASE_URL=https://your-service.run.app
```

Output: `app/build/outputs/apk/release/app-release.apk`

A release build must be signed before install. Create a keystore and add a
`signingConfigs` block, or install the debug APK for a demo.

## Architecture

```
Compose UI
    |
ViewModel (StateFlow)
    |
    +-- RoxstarRepository --> Retrofit  --> REST
    |                     \-> Room      --> local draft metadata
    |
    +-- RoomSocket        --> Socket.IO --> real-time events
    |
    +-- AudioRecorder
            |
        NativeAudioBridge (JNI)
            |
        AudioEngine (C++)
            |
        Oboe input stream -> effect -> WAV writer -> local file
```

Two rules the client never breaks:

1. **It never decides game state.** No local elimination timer, no local winner.
   Everything on the spin screen is a projection of what the server sent.
2. **Audio never touches the network.** Sharing a draft sends name, duration and
   effect. The WAV stays on the device.

## Native audio

`app/src/main/cpp` holds the Oboe engine. The signal processing there is tested
on the host, with no device required:

```bash
cd ../native-audio/tests && ./run.sh --docker
```

That suite found a real bug in the pitch shifter during development -- see
`native-audio/tests/README.md`.
