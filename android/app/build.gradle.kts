import java.net.URI
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing: point -PsigningProps=/path/signing.properties (or env GOHIGH_SIGNING_PROPS) at a file with
// storeFile, storePassword, keyAlias, keyPassword. Never commit that file or the keystore.
val signingPropsPath: String? = (findProperty("signingProps") as String?) ?: System.getenv("GOHIGH_SIGNING_PROPS")
val signingProps: Properties? = signingPropsPath?.let { path ->
    val f = file(path)
    require(f.isFile) { "signingProps file not found: $path" }
    Properties().apply { f.inputStream().use { load(it) } }
}

// Your own server and app identity: -PgohighBaseUrl=https://crm.your-domain.com (or env GOHIGH_BASE_URL) sets
// the default server and the App Links host; -PgohighApplicationId=… (env GOHIGH_APPLICATION_ID) the package
// name that /.well-known/assetlinks.json on the server must name (PGHL_ANDROID_PACKAGE).
fun gohighProp(name: String, env: String, fallback: String): String =
    (findProperty(name) as String?)?.takeIf { it.isNotBlank() } ?: System.getenv(env)?.takeIf { it.isNotBlank() } ?: fallback
val gohighBaseUrl = gohighProp("gohighBaseUrl", "GOHIGH_BASE_URL", "https://crm.example.com").trimEnd('/')
val gohighApplicationId = gohighProp("gohighApplicationId", "GOHIGH_APPLICATION_ID", "org.gohigh.android")
val gohighAppLinkHost: String = URI(gohighBaseUrl).host ?: "crm.example.com"

android {
    namespace = "org.gohigh.android"
    compileSdk = 36

    defaultConfig {
        applicationId = gohighApplicationId
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "1.0.3"
        buildConfigField("String", "DEFAULT_BASE_URL", "\"$gohighBaseUrl\"")
        manifestPlaceholders["appLinkHost"] = gohighAppLinkHost
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (signingProps != null) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
            all { test ->
                test.maxHeapSize = "3g"
                // Screenshot/render tests use the debug-only Compose test activity; they run on the debug variant.
                if (test.name.contains("Release")) test.exclude("**/shots/**")
                // Screenshot output for the Robolectric render tests (see README).
                test.systemProperty("gohigh.shots.dir", findProperty("shotsDir") ?: layout.buildDirectory.dir("shots").get().asFile.path)
                test.systemProperty("robolectric.graphicsMode", "NATIVE")
                listOf("liveBase", "liveEmail", "livePassword").forEach { k ->
                    test.systemProperty("gohigh.live." + k.removePrefix("live").lowercase(), findProperty(k) ?: "")
                }
                test.systemProperty("gohigh.preview.dir", findProperty("previewDir")?.let { file(it).absolutePath } ?: "")
            }
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = true
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/LICENSE*", "/META-INF/NOTICE*")
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        optIn.add("kotlinx.serialization.ExperimentalSerializationApi")
    }
}

dependencies {
    implementation(libs.androidx.core)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.glance.appwidget)
    implementation(libs.glance.material3)
    implementation(libs.glance.preview)
    implementation(libs.glance.appwidget.preview)
    implementation(libs.work.runtime)
    implementation(libs.browser)
    implementation(libs.webkit)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.junit)
    testImplementation(libs.work.testing)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    debugImplementation(libs.compose.ui.test.manifest)
}
