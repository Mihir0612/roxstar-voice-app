# FRONTEND_AUDIT.md

**Auditor:** Senior Full Stack Integration Developer
**Target:** the implemented Android client in `/android-app` and `/native-audio`
**Basis:** `TECH_MANAGER_REQUIREMENTS.md`, `TECH_MANAGER_DECISIONS.md`, the frozen contract in `docs/api/`
**Verdict:** **PASS** — debug and release APKs built and inspected

---

## 1. Requirements coverage

| Requirement | Where | Verdict |
|---|---|---|
| Record via Oboe | `cpp/AudioEngine.cpp` — real `oboe::AudioStreamBuilder`, Input, LowLatency, Exclusive | PASS |
| Start / Stop / Cancel | `AudioRecorder` state machine, `AudioEngine` lifecycle | PASS |
| Valid local audio file | `WavWriter` — header verified field by field against the spec | PASS |
| Permission and failure handling | runtime request, 7 typed failure modes | PASS |
| At least one effect in the native path | Echo **and** Pitch Shift, both in C++ on the capture buffers | PASS |
| Playback | `MediaPlayer` over the produced WAV | PASS |
| Draft save / list / play / delete | Room DB + `AudioScreen` | PASS |
| Draft name, creation time, duration | shown in `DraftRow` | PASS |
| Create / Join / Leave / Get state | `RoxstarRepository` + `RoomViewModel` | PASS |
| Participant list | `RoomScreen`, with presence | PASS |
| Share a draft | metadata only, `hostedFileUrl` always null | PASS |
| All 7 events handled | `RoomSocket` + `RoomViewModel.apply` | PASS |
| Reconnect and state sync | re-subscribe, `room_state` replaces local state | PASS |
| Spin UI, owner-only start | `SpinSection`, role from the server | PASS |
| Backend authoritative | no local timer, no local winner | PASS |
| No live audio over WebSocket | audio never enters the socket layer | PASS |

---

## 2. Architecture boundaries

```
Compose → ViewModel(StateFlow) → Repository → Retrofit / Room
                               → RoomSocket → Socket.IO
                               → AudioRecorder → NativeAudioBridge(JNI) → Oboe
```

- **One JNI file.** Every `external fun` lives in `NativeAudioBridge`, so the
  native boundary is a single file to audit.
- **The recorder knows nothing about rooms or the network.** Recording works
  fully offline, which is why the audio path can be tested without a backend.
- **No business logic in composables.** Screens read state and emit intents.

---

## 3. Contract conformance

Checked field by field against `docs/api/openapi.yaml` and
`docs/api/websocket-events.md`.

| Item | Result |
|---|---|
| REST paths | PASS — identical to the spec |
| Request bodies | PASS |
| Response DTOs | PASS — `Dtos.kt` mirrors `dto.ts` field for field |
| Bearer header | PASS — one interceptor, no endpoint can forget it |
| `Idempotency-Key` on mutating POSTs | PASS — **adopted, as the Tech Manager assigned** |
| `Idempotency-Key` required on start spin | PASS |
| Error envelope parsed | PASS — `code` drives branching, not the message |
| Socket namespace `/rooms` | PASS |
| Handshake `auth.token` | PASS |
| `subscribe_room` then `room_state` | PASS |
| **`eventId` dedupe** | PASS — **adopted; this was gap C7** |
| `room_state` supersedes | PASS — replaces, does not merge |

Both items the frontend plan was missing — `eventId` dedupe and
`Idempotency-Key` — are now implemented. The dedupe window is bounded at 256
ids, which is far larger than any single spin produces, so a genuine duplicate
is always still in the window while the set cannot grow unbounded.

---

## 4. State management

| Category | Verdict |
|---|---|
| Room, participants, draft, spin, connection, audio | PASS — separate, all in `StateFlow` |
| `room_state` precedence mid-spin | PASS — replaces wholesale |
| Reconnect during an elimination tick | PASS — the snapshot carries what was missed |
| Recording state machine returns to a usable state | PASS — cancel and every failure path reach `Idle` |

The two gaps the plan-stage audit raised are closed: `room_state` precedence is
now explicit ("replace, do not merge"), and reconnect-during-a-tick is covered
because the client never runs a tick of its own — there is nothing to reconcile
beyond the snapshot.

---

## 5. Error handling

| Case | Handling |
|---|---|
| Permission denied | Typed error with an actionable message; requested on screen entry, not mid-gesture |
| Engine unavailable (.so missing) | `isAvailable` is false; the UI explains rather than crashing |
| Microphone busy | Distinct message from a permission failure |
| Storage failure | Partial file deleted, typed error |
| No audio captured | Reported rather than saving an empty draft |
| Stream disconnected mid-take | **Partial recording is salvaged**, engine left restartable |
| Network unreachable | `NetworkError` distinct from a server refusal |
| Server refusal | `code`-specific message shown |
| Socket disconnect | Exponential backoff, capped at 15 s; status pill shows "Reconnecting" |
| Invalid room / not a member | Server message surfaced |

**A distinction the plan called for and the code honours:** a definite server
answer clears the pending idempotency key, while a network error keeps it. So a
retry after a lost response *replays*; a retry after a rejection is a fresh
intent. Getting this backwards is how a client starts two spins.

---

## 6. Security

| Item | Result |
|---|---|
| No hardcoded secrets | PASS |
| Token in memory only | PASS — never written to disk or logs |
| `Authorization` redacted in debug logging | PASS |
| HTTP logging disabled in release | PASS — it would print bearer tokens to logcat |
| Cleartext HTTP restricted | PASS — debug only, loopback hosts only |
| Release requires HTTPS | PASS — enforced by the build |
| No tracking identifiers | PASS — `ANDROID_ID`, not an advertising id or serial |
| `allowBackup=false` | PASS |
| ProGuard keeps JNI names | PASS — renaming them would break the native lookup at runtime |

**Note:** the token lives only in memory, so the user re-enters a display name
after a process death. That is a deliberate trade — persisting a bearer token to
disk on a possibly-rooted device is the larger risk, and re-authenticating is
one tap with no password.

---

## 7. Native audio

| Property | Verdict |
|---|---|
| Real Oboe, not `AudioRecord` | PASS |
| LowLatency + Exclusive requested | PASS, with Oboe's automatic fallback |
| Effects in the native path | PASS |
| **No allocation on the audio thread** | PASS — every buffer sized in `prepare()` |
| No locking on the audio thread | PASS — `try_to_lock`, drops rather than blocks |
| No file I/O on the audio thread | PASS — separate writer thread |
| Disconnect handled | PASS — `onErrorAfterClose` salvages and leaves it restartable |
| Repeated start/stop | PASS — streams closed before reopening |
| Microphone released | PASS — `nativeRelease` from `onCleared` |

**Verified by execution, not review.** 45 host-compiled tests
(`native-audio/tests/`) measure the actual output: an impulse produces echo
repeats at the right delay and amplitude, a 440 Hz tone comes out at 880 Hz for
+12 semitones and 220 Hz for −12, and every WAV header field matches the spec.

> That suite found a **real bug**: the pitch shifter advanced its read pointer
> by `pitchRatio` instead of ramping the read delay by `1 − pitchRatio`. A
> no-op shift produced 7.8 Hz of noise and a +12-semitone shift produced no
> change at all. The code read plausibly and would have passed review. Fixed and
> re-measured.

**Honesty check on naming:** the "Reverb" preset is a short, dense, high-feedback
echo — not a Schroeder or FDN reverb. It is labelled *"Reverb (echo-based)"* in
the UI, and a unit test asserts the label says so. Claiming an algorithm that is
not implemented would be the wrong kind of shortcut.

---

## 8. Tests

| Suite | Count | Covers |
|---|---|---|
| `RoomUiStateTest` | 9 | Spin gating: roles, 3/20 boundaries, running-spin block, disconnected members still eligible |
| `SpinDtoTest` | 2 | Status helpers |
| `NativeContractTest` | 6 | JNI ordinals vs the C++ switch, API values vs the DB CHECK, unknown codes never read as success |
| `native-audio/tests` | 45 | Echo, pitch shift, WAV writer, pipeline — compiled and run |

**All 17 JVM tests executed and passing** on Temurin JDK 17.

**`NativeContractTest` is the one worth pointing at.** The effect ordinals are a
hand-maintained agreement with a C++ `switch`; reordering the Kotlin enum would
silently apply the wrong effect rather than fail to compile. The test pins them.

**Gaps:**
- No instrumented UI tests. Compose UI testing needs a device or emulator.
- `AudioRecorder` itself is not unit-tested — it needs a real microphone and a
  real Oboe stream. Its *logic* is thin by design; the substance is in the C++,
  which is tested.

---

## 9. The APK — built and inspected

Built on NDK 30.0.16248370 with Temurin JDK 17. AGP installed CMake 3.22.1
itself during the first configure.

| Artifact | Size | Contents |
|---|---|---|
| `app-debug.apk` | 21 MB | Both ABIs, unminified |
| `app-release-unsigned.apk` | 4.8 MB | R8-minified, 87 entries |

Native libraries present for **arm64-v8a** and **x86_64**:

```
lib/<abi>/libroxstar_audio.so   127 KB   the Oboe engine and effects
lib/<abi>/liboboe.so            280 KB   Oboe, via the Maven prefab
lib/<abi>/libc++_shared.so              C++ runtime
```

**ProGuard keep rules verified against the real minified DEX.** `NativeAudioBridge`
and `nativeStartRecording` both survive R8 — had R8 renamed them, the native
lookup would have thrown `UnsatisfiedLinkError` on the first tap to record, and
only on a release build.

**The endpoint guard was exercised, not just written:**

| Attempt | Result |
|---|---|
| Placeholder URL | BLOCKED — "ROXSTAR_API_BASE_URL is still the placeholder" |
| `http://localhost:8080` | BLOCKED — "points at a local address" |
| `https://roxstar-backend-demo.a.run.app` | Accepted, APK produced |

So *"APK ships pointing at localhost"* — on the Tech Manager's risk register — is
now impossible rather than merely documented.

**Remaining:** the release APK is unsigned. Signing needs a keystore, which is a
credential the candidate creates; `app-debug.apk` installs directly for a demo.

---

## 10. Verdict

**PASS.**

The client implements every scored requirement, respects every architectural
boundary, and adopted both contract items the Tech Manager assigned to it. The
audio path is verified by measurement rather than assertion — one real DSP bug
was found and fixed as a result — and the APK is built, with its native
libraries and ProGuard keep rules inspected rather than assumed.
