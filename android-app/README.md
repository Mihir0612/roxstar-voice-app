# Roxstar Android client

Kotlin + Jetpack Compose client with a native Oboe audio path.

## Prerequisites

| Requirement | Version | Note |
|---|---|---|
| Android Studio | Ladybug (2024.2) or newer | Bundles a JDK 17 runtime |
| Android SDK | API 35 | `compileSdk`/`targetSdk` |
| **Android NDK** | 26.x or newer | **Required** -- the audio engine is C++. Verified on 30.0.16248370. |
| CMake | 3.22.1 | AGP installs this itself on the first native build |
| JDK | 17 | Temurin 17 verified. Studio's bundled JBR 25 is newer than Gradle 8.11.1 supports. |
| Minimum device | API 26 | Oboe's AAudio backend needs 26+ |

Install the NDK from **Android Studio -> Settings -> Languages & Frameworks ->
Android SDK -> SDK Tools**, ticking **NDK (Side by side)**. CMake does not need
to be ticked -- AGP downloads the exact version it wants on the first native
build. Oboe needs no install either; it arrives as a Maven AAR with a prefab
package.

`ndkVersion` is pinned in `app/build.gradle.kts` to the version this was built
against. If your SDK has a different one:

```bash
./gradlew assembleDebug -PROXSTAR_NDK_VERSION=<your-version>
```

Set `JAVA_HOME` to a JDK 17 before building from the terminal:

```bash
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot"
```

## Configure the backend URL

Debug builds use the emulator alias automatically. On a physical device,
`installDebug` automatically runs `adb reverse`, so the app can use the same
local endpoint without embedding the computer's LAN IP in the APK. Keep USB
debugging enabled and accept the computer authorization prompt on the device.

Start the backend with `docker compose up` first, then run the app from Android
Studio or with `./gradlew installDebug`. The forwarding rule is recreated after
each install, including after a device restart. The phone and computer do not
need to be on the same Wi-Fi network.

For devices that cannot use USB debugging, a local development server needs a
reachable LAN hostname/IP, or the backend must be deployed to a public HTTPS
domain. There is no device-independent address for a server running only on a
developer's computer.

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

Outputs, both verified:

| File | Size | Notes |
|---|---|---|
| `app/build/outputs/apk/debug/app-debug.apk` | 21 MB | Installs directly |
| `app/build/outputs/apk/release/app-release-unsigned.apk` | 4.8 MB | R8-minified, needs signing |

Both carry `libroxstar_audio.so` and `liboboe.so` for arm64-v8a and x86_64.

The release APK is unsigned. Create a keystore and add a `signingConfigs` block
before distributing it, or install the debug APK for a demo.

The release build **refuses** a placeholder, localhost or non-HTTPS endpoint --
both bad cases were tested and rejected by name.

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
