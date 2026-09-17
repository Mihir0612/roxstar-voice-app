# Native DSP tests

Host-runnable tests for the Oboe audio path's signal processing.

## Why these exist

The Android audio code cannot be unit-tested on the JVM, and testing it only on
a device means "the echo works" is a claim nobody can check during review. The
effects and the WAV writer, however, depend on nothing but the C++ standard
library -- no Oboe, no NDK, no JNI. So they are compiled and **run** here, on
any machine.

This is not theatre. On its first run this suite found a real bug: the pitch
shifter advanced its read pointer by `pitchRatio` per frame instead of ramping
the read *delay* by `1 - pitchRatio`, which made a unity-ratio shift produce
noise and a +12-semitone shift produce no change at all. The code looked
correct and reviewed fine. Measuring the output frequency is what caught it.

## Running

```bash
./run.sh            # local g++ or clang++
./run.sh --docker   # no local toolchain needed
```

## What is covered

**EchoEffect** -- an impulse is fed in and the output is measured:
repeats land exactly one delay period apart, each at `feedback` times the
previous amplitude, the tail decays to silence, nothing leaks before the first
repeat, `reset()` clears the delay line, excessive feedback is clamped, stereo
channels stay independent, and a channel-count mismatch is refused rather than
read out of bounds.

**PitchShiftEffect** -- a 440 Hz sine is fed in and the output frequency is
measured by zero-crossing count: +12 semitones lands near 880 Hz, -12 near
220 Hz, 0 stays at 440. Levels stay in range and never clip.

**WavWriter** -- every field of the 44-byte header is checked against the WAV
specification, including the two sizes that are patched on `finish()`. Samples
above full scale clip rather than wrapping; `abort()` leaves nothing on disk;
finishing with zero frames reports failure instead of producing an empty file.

**Pipeline** -- effect and writer driven together in 480-frame bursts, the way
the Oboe callback does it.

## What is NOT covered here

Oboe stream lifecycle, microphone permission, device disconnect handling and
JNI marshalling all need a real device. They are exercised by
`AudioEngine.cpp`'s error paths and by manual testing on hardware; see the
demo checklist in the root README.
