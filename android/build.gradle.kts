// R8 bundled with AGP 8.13 predates Kotlin 2.4 metadata; a newer R8 shrinks Kotlin 2.4 classes correctly.
buildscript {
    repositories {
        google()
    }
    dependencies {
        classpath(libs.r8)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
