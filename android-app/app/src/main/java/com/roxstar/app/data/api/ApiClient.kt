package com.roxstar.app.data.api

import android.os.Build
import com.roxstar.app.BuildConfig
import com.squareup.moshi.Moshi
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit

/** Holds the session token. In-memory only -- see the note in TokenStore. */
class TokenStore {
    @Volatile
    var token: String? = null
        private set

    fun set(value: String?) {
        token = value
    }

    fun clear() {
        token = null
    }

    val isAuthenticated: Boolean get() = token != null
}

/**
 * Attaches the bearer token to every request (D8).
 *
 * An interceptor rather than a parameter on each call: a single place that can
 * be audited, and no endpoint can be added later that silently forgets to
 * authenticate.
 */
class AuthInterceptor(private val tokens: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = tokens.token
            ?: return chain.proceed(chain.request())

        return chain.proceed(
            chain.request().newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
        )
    }
}

object ApiClient {

    val tokenStore = TokenStore()

    // No KotlinJsonAdapterFactory: every DTO is annotated
    // @JsonClass(generateAdapter = true), so KSP generates its adapter at build
    // time. Adding the reflective factory as well would pull in kotlin-reflect
    // and shadow the generated adapters with slower reflection.
    private val moshi: Moshi = Moshi.Builder().build()

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(AuthInterceptor(tokenStore))
        .apply {
            if (BuildConfig.DEBUG) {
                // BODY level only in debug. In release this would print bearer
                // tokens to logcat, where any app with log access could read them.
                addInterceptor(HttpLoggingInterceptor().apply {
                    level = HttpLoggingInterceptor.Level.BODY
                    redactHeader("Authorization")
                })
            }
        }
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        // Mobile networks drop connections constantly; let OkHttp retry the
        // handshake on idempotent requests rather than surfacing a failure.
        .retryOnConnectionFailure(true)
        .build()

    val baseUrl: String = resolveBaseUrl().trimEnd('/') + "/"

    private fun resolveBaseUrl(): String {
        if (!BuildConfig.DEBUG) {
            return BuildConfig.API_BASE_URL
        }

        // The emulator exposes the development computer as 10.0.2.2. Every
        // physical device uses localhost because installDebug configures adb
        // reverse for its serial number; no phone model or LAN IP is needed.
        val emulator = Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.MODEL.contains("google_sdk", ignoreCase = true) ||
            Build.MODEL.contains("Emulator", ignoreCase = true) ||
            Build.MODEL.contains("Android SDK built for", ignoreCase = true) ||
            Build.MANUFACTURER.contains("Genymotion", ignoreCase = true)

        return if (emulator) "http://10.0.2.2:8080" else "http://127.0.0.1:8080"
    }

    val api: RoxstarApi = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(httpClient)
        .addConverterFactory(MoshiConverterFactory.create(moshi))
        .build()
        .create(RoxstarApi::class.java)

    private val errorAdapter = moshi.adapter(ApiErrorEnvelope::class.java)

    /**
     * Parse the backend's error envelope.
     *
     * Falls back to a generic message rather than showing a raw body: an
     * unparseable response usually means a proxy or a load balancer answered,
     * and its HTML is no use to a user.
     */
    fun parseError(body: String?): ApiErrorBody =
        body?.let { runCatching { errorAdapter.fromJson(it)?.error }.getOrNull() }
            ?: ApiErrorBody(code = "UNKNOWN", message = "Something went wrong. Please try again.")
}
