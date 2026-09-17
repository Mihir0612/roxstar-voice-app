cmake_minimum_required(VERSION 3.22.1)
project(roxstar_audio LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# Oboe
#
# Pulled from Maven as an AAR prefab rather than vendored as source: the
# prebuilt package is what Google publishes and keeps in step with NDK
# releases, and it keeps the repository free of a large third-party tree.
#
# Requires in app/build.gradle.kts:
#     buildFeatures { prefab = true }
#     implementation("com.google.oboe:oboe:1.9.0")
#
# The fallback below builds Oboe from /native-audio/oboe if it has been cloned
# there instead, so the project builds either way.
# ---------------------------------------------------------------------------
find_package(oboe CONFIG QUIET)

if (NOT oboe_FOUND)
    set(OBOE_VENDORED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../native-audio/oboe")
    if (EXISTS "${OBOE_VENDORED_DIR}/CMakeLists.txt")
        message(STATUS "Oboe prefab not found; building vendored Oboe from ${OBOE_VENDORED_DIR}")
        add_subdirectory("${OBOE_VENDORED_DIR}" ./oboe-build)
    else()
        message(FATAL_ERROR
            "Oboe not found.\n"
            "Either enable prefab and add com.google.oboe:oboe to app/build.gradle.kts,\n"
            "or clone https://github.com/google/oboe into /native-audio/oboe.")
    endif()
endif()

add_library(roxstar_audio SHARED
        roxstar_audio_jni.cpp
        AudioEngine.cpp
        effects/EchoEffect.cpp
        effects/PitchShiftEffect.cpp
        WavWriter.cpp
)

target_include_directories(roxstar_audio PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

target_link_libraries(roxstar_audio
        PRIVATE
        oboe::oboe
        android
        log
)

# -O3 on the audio path: effect processing runs inside the Oboe callback, where
# a missed deadline is an audible glitch rather than a slow frame.
target_compile_options(roxstar_audio PRIVATE
        $<$<CONFIG:Release>:-O3>
        -Wall
        -Wextra
)
