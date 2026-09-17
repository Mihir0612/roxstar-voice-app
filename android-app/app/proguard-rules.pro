# Moshi generates adapters via KSP; the reflective fallback needs the models.
-keep class com.roxstar.app.data.api.** { *; }
-keepclassmembers class com.roxstar.app.data.api.** { *; }

# Socket.IO and its Engine.IO transport use reflection internally.
-keep class io.socket.** { *; }
-dontwarn io.socket.**

# OkHttp / Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**

# Retrofit keeps generic signatures for suspend functions.
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response

# JNI entry points are called by name from C++ and must not be renamed.
-keepclasseswithmembernames class com.roxstar.app.audio.NativeAudioBridge {
    native <methods>;
}
-keep class com.roxstar.app.audio.NativeAudioBridge { *; }
