package org.gohigh.android.feedback

import android.os.Build
import org.gohigh.android.BuildConfig
import org.gohigh.android.api.ApiErrorEntry
import org.gohigh.android.api.DeviceDiagnostics
import java.time.Instant
import kotlin.math.sqrt

/**
 * The app's last failed API calls (method, path, status, the server's error text – never request bodies),
 * attached to bug reports so the team sees what went wrong right before.
 */
class ApiErrorLog(private val max: Int = 20, private val clock: () -> Long = System::currentTimeMillis) {
    private val entries = ArrayDeque<ApiErrorEntry>()

    @Synchronized
    fun record(method: String, path: String, status: Int, message: String) {
        // Reporting itself must not fill the log (and the token never appears in paths).
        if (path.contains("/client-errors")) return
        entries.addLast(ApiErrorEntry(method, path.take(300), status, message.take(300), Instant.ofEpochMilli(clock()).toString()))
        while (entries.size > max) entries.removeFirst()
    }

    @Synchronized
    fun snapshot(): List<ApiErrorEntry> = entries.toList()

    @Synchronized
    fun clear() = entries.clear()
}

/** Model, manufacturer, Android version and app version – what the report form shows and sends. */
fun deviceDiagnostics(): DeviceDiagnostics = DeviceDiagnostics(
    model = Build.MODEL.orEmpty(),
    manufacturer = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() },
    android = Build.VERSION.RELEASE.orEmpty(),
    sdk = Build.VERSION.SDK_INT,
    appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
)

/**
 * Shake recognition from accelerometer samples (m/s²): three strong jolts (> [threshold] g, at least
 * [gapMs] apart) within [windowMs]; afterwards quiet for [cooldownMs]. Pure logic, unit-tested.
 */
class ShakeLogic(
    private val threshold: Float = 2.6f,
    private val windowMs: Long = 1500,
    private val gapMs: Long = 120,
    private val cooldownMs: Long = 3000,
    private val needed: Int = 3,
) {
    private var firstAt = Long.MIN_VALUE / 2
    private var lastPeak = Long.MIN_VALUE / 2
    private var count = 0
    private var lastTrigger = Long.MIN_VALUE / 2

    fun onSample(x: Float, y: Float, z: Float, atMs: Long): Boolean {
        val g = sqrt(x * x + y * y + z * z) / 9.81f
        if (g < threshold || atMs - lastPeak < gapMs) return false
        lastPeak = atMs
        if (atMs - firstAt > windowMs) {
            firstAt = atMs
            count = 0
        }
        count++
        if (count >= needed && atMs - lastTrigger > cooldownMs) {
            lastTrigger = atMs
            count = 0
            return true
        }
        return false
    }
}
