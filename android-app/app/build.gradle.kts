import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.roxstar.app"
    compileSdk = 35

    // Pinned to the NDK actually installed via the SDK Manager. AGP otherwise
    // demands its own default version and fails the configure step. Override
    // with -PROXSTAR_NDK_VERSION=... if your SDK has a different one.
    ndkVersion = providers.gradleProperty("ROXSTAR_NDK_VERSION").orNull ?: "30.0.16248370"

    defaultConfig {
        applicationId = "com.roxstar.app"
        minSdk = 26 // Oboe supports 16+, but AAudio (its low-latency backend) needs 26+.
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        externalNativeBuild {
            cmake {
                // Oboe is C++17; -frtti/-fexceptions keep the JNI bridge able to
                // report failures as exceptions rather than aborting the process.
                cppFlags += listOf("-std=c++17", "-frtti", "-fexceptions")
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }

        ndk {
            // 32-bit ABIs are omitted deliberately: every device that supports
            // AAudio is 64-bit, and shipping them doubles the APK for nothing.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    val apiBaseUrlRelease: String = providers.gradleProperty("ROXSTAR_API_BASE_URL").orNull
        ?: "https://REPLACE-WITH-YOUR-CLOUD-RUN-URL.run.app"
    val apiBaseUrlDebug: String = providers.gradleProperty("ROXSTAR_API_BASE_URL_DEBUG").orNull
        ?: "http://10.0.2.2:8080"

    buildTypes {
        debug {
            isMinifyEnabled = false
            buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrlDebug\"")
            // Debug builds talk to a local backend over plain HTTP, which the
            // platform blocks by default. Scoped to debug only.
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "API_BASE_URL", "\"$apiBaseUrlRelease\"")
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
        // Exposes the Oboe AAR's headers and .so to CMake via find_package.
        prefab = true
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            // Version deliberately not pinned: AGP then uses whichever CMake the
            // SDK Manager installed, instead of failing because one exact build
            // is absent.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.kotlinx.coroutines.android)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // Native audio. The AAR carries prebuilt Oboe binaries for every ABI and
    // a prefab package that CMake consumes with find_package(oboe CONFIG).
    implementation(libs.oboe)

    // REST
    implementation(libs.retrofit)
    implementation(libs.retrofit.moshi)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.moshi)
    ksp(libs.moshi.kotlin.codegen)

    // Real-time
    implementation(libs.socketio.client)

    // Local draft metadata
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.turbine)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)

    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

/**
 * Release safety net.
 *
 * "APK ships pointing at localhost" is on the Tech Manager's risk register, and
 * it is the kind of mistake that is invisible until a reviewer installs the
 * build and nothing works. Make the build fail instead.
 */
val verifyReleaseEndpoint by tasks.registering {
    group = "verification"
    description = "Fails the release build if the backend URL is a placeholder or a loopback address."

    doLast {
        val url = providers.gradleProperty("ROXSTAR_API_BASE_URL").orNull.orEmpty()

        val problem = when {
            url.isBlank() -> "ROXSTAR_API_BASE_URL is not set"
            url.contains("REPLACE-WITH") -> "ROXSTAR_API_BASE_URL is still the placeholder"
            url.contains("localhost") || url.contains("127.0.0.1") || url.contains("10.0.2.2") ->
                "ROXSTAR_API_BASE_URL points at a local address ($url)"
            !url.startsWith("https://") -> "Release builds must use https (got $url)"
            else -> null
        }

        if (problem != null) {
            throw GradleException(
                """
                |Release build blocked: $problem
                |
                |Set the deployed backend URL in android-app/gradle.properties:
                |    ROXSTAR_API_BASE_URL=https://your-service.run.app
                |
                |or pass it for one build:
                |    ./gradlew assembleRelease -PROXSTAR_API_BASE_URL=https://your-service.run.app
                """.trimMargin()
            )
        }

        logger.lifecycle("Release endpoint verified: $url")
    }
}

tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
    dependsOn(verifyReleaseEndpoint)
}

// Keep physical debug devices on the same endpoint as the emulator. The
// forwarding is recreated after every install, which also covers a device
// restart where Android drops adb reverse rules.
val reverseDebugPort by tasks.registering {
    group = "development"
    description = "Forwards the local backend to a USB-connected debug device."

    val localProperties = Properties().apply {
        rootProject.file("local.properties").inputStream().use { load(it) }
    }
    val sdkPath = System.getenv("ANDROID_HOME")
        ?: System.getenv("ANDROID_SDK_ROOT")
        ?: localProperties.getProperty("sdk.dir")
    val adbName = if (System.getProperty("os.name").contains("Windows", ignoreCase = true)) {
        "adb.exe"
    } else {
        "adb"
    }
    val adb = sdkPath?.let { file("$it/platform-tools/$adbName") }

    doLast {
        if (adb == null || !adb.isFile) {
            logger.lifecycle("adb was not found; skipping USB backend forwarding.")
            return@doLast
        }

        val devices = ProcessBuilder(adb.absolutePath, "devices")
            .redirectErrorStream(true)
            .start()
            .let { process ->
                process.inputStream.bufferedReader().useLines { lines ->
                    lines.map { it.trim().split("\t") }
                        .filter { it.size == 2 && it[1] == "device" }
                        .map { it[0] }
                        .toList()
                }
            }

        if (devices.isEmpty()) {
            logger.lifecycle("No online Android devices found; skipping USB backend forwarding.")
            return@doLast
        }

        devices.forEach { serial ->
            project.exec {
                commandLine(adb.absolutePath, "-s", serial, "reverse", "tcp:8080", "tcp:8080")
                isIgnoreExitValue = true
            }
            logger.lifecycle("Backend forwarding configured for $serial")
        }
    }
}

tasks.matching { it.name == "installDebug" }.configureEach {
    dependsOn(reverseDebugPort)
}
