#!/usr/bin/env bash
#
# Compile and run the native DSP tests on the HOST -- no Android device, no NDK,
# no emulator. The effects and the WAV writer depend only on the standard
# library, so their correctness is checkable anywhere.
#
#   ./run.sh              use the local g++/clang++
#   ./run.sh --docker     use a gcc container instead (no local toolchain needed)

set -euo pipefail

cd "$(dirname "$0")"
CPP_DIR="../../android-app/app/src/main/cpp"

SOURCES=(
  dsp_test.cpp
  "$CPP_DIR/effects/EchoEffect.cpp"
  "$CPP_DIR/effects/PitchShiftEffect.cpp"
  "$CPP_DIR/WavWriter.cpp"
)

if [ "${1:-}" = "--docker" ]; then
  REPO_ROOT="$(cd ../.. && pwd)"
  # Git Bash on Windows rewrites anything that looks like a Unix path inside
  # docker arguments, which turns /work into C:/Program Files/Git/work.
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
  exec docker run --rm -v "${REPO_ROOT}:/work" -w /work gcc:14 bash -c '
    g++ -std=c++17 -O2 -Wall -Wextra -I android-app/app/src/main/cpp \
      native-audio/tests/dsp_test.cpp \
      android-app/app/src/main/cpp/effects/EchoEffect.cpp \
      android-app/app/src/main/cpp/effects/PitchShiftEffect.cpp \
      android-app/app/src/main/cpp/WavWriter.cpp \
      -o /tmp/dsp_test
    cd /tmp && ./dsp_test'
fi

CXX="${CXX:-g++}"
command -v "$CXX" >/dev/null 2>&1 || {
  echo "No $CXX on PATH. Re-run with --docker to use a container instead." >&2
  exit 1
}

"$CXX" -std=c++17 -O2 -Wall -Wextra -I "$CPP_DIR" "${SOURCES[@]}" -o dsp_test
./dsp_test
