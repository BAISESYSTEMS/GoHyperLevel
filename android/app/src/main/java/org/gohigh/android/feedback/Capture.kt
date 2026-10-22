package org.gohigh.android.feedback

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import androidx.core.graphics.createBitmap
import androidx.core.graphics.scale
import androidx.core.view.drawToBitmap
import org.gohigh.android.AppGraph
import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.ClientErrorDiagnostics
import org.gohigh.android.api.ClientErrorEntry
import org.gohigh.android.api.ClientErrorsRequest
import org.gohigh.android.api.ApiException
import org.gohigh.android.data.AuthStatus
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant

/** Screenshots for bug reports: the current window (incl. the WebView) or a picked image, as small JPEGs. */
object ScreenCapture {
    private const val MAX_BYTES = 2_500_000

    private fun dir(context: Context) = File(context.cacheDir, "reports").apply { mkdirs() }

    /** Captures [activity]'s window with PixelCopy (falls back to drawing the view). Calls back on the main thread. */
    fun capture(activity: Activity, onDone: (File?) -> Unit) {
        val view = activity.window?.decorView ?: return onDone(null)
        if (view.width <= 0 || view.height <= 0) return onDone(null)
        val bitmap = runCatching { createBitmap(view.width, view.height) }.getOrNull() ?: return onDone(null)
        val save = { bmp: Bitmap? -> onDone(bmp?.let { save(activity, it) }) }
        try {
            PixelCopy.request(activity.window, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) save(bitmap) else save(runCatching { view.drawToBitmap() }.getOrNull())
            }, Handler(Looper.getMainLooper()))
        } catch (e: IllegalArgumentException) {
            save(runCatching { view.drawToBitmap() }.getOrNull())
        }
    }

    /** An image the user picked (photo picker) as JPEG in the report folder. */
    fun fromUri(context: Context, uri: Uri): File? = runCatching {
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        var sample = 1
        while (opts.outWidth / sample > 2560 || opts.outHeight / sample > 4000) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        save(context, bmp)
    }.getOrNull()

    private fun save(context: Context, bmp: Bitmap): File? = runCatching {
        dir(context).listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 3600_000L }?.forEach { it.delete() }
        val f = File(dir(context), "screen-${System.currentTimeMillis()}.jpg")
        f.outputStream().use { scaled(bmp, 1280).compress(Bitmap.CompressFormat.JPEG, 82, it) }
        f
    }.getOrNull()

    private fun scaled(bmp: Bitmap, maxWidth: Int): Bitmap =
        if (bmp.width <= maxWidth) bmp else bmp.scale(maxWidth, (bmp.height * maxWidth.toFloat() / bmp.width).toInt().coerceAtLeast(1))

    /** `data:image/jpeg;base64,…` small enough for the server (3 MB limit). */
    fun dataUrl(file: File): String? = runCatching {
        var bytes = file.readBytes()
        if (bytes.size > MAX_BYTES) {
            val bmp = BitmapFactory.decodeFile(file.path) ?: return null
            val out = ByteArrayOutputStream()
            scaled(bmp, 900).compress(Bitmap.CompressFormat.JPEG, 70, out)
            bytes = out.toByteArray()
        }
        "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }.getOrNull()
}

/** Listens to the accelerometer while an activity is in front and calls [onShake] (see [ShakeLogic]). */
class ShakeDetector(context: Context, private val onShake: () -> Unit) : SensorEventListener {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val logic = ShakeLogic()
    private var running = false

    fun start() {
        if (running) return
        val acc = sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        running = sensors.registerListener(this, acc, SensorManager.SENSOR_DELAY_UI)
    }

    fun stop() {
        if (!running) return
        sensors?.unregisterListener(this)
        running = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (logic.onSample(event.values[0], event.values[1], event.values[2], event.timestamp / 1_000_000)) onShake()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}

/**
 * App crashes: written to a file when they happen, sent on the next start to /api/mobile/client-errors
 * (the server only keeps them when the user allowed automatic error reports).
 */
object CrashReporter {
    private fun file(context: Context) = File(context.filesDir, "last_crash.json")

    fun install(context: Context) {
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            runCatching {
                val entry = ClientErrorEntry("${e.javaClass.name}: ${e.message.orEmpty()}".take(500), e.stackTraceToString().take(6000), Instant.now().toString())
                file(app).writeText(ApiJson.encodeToString(ClientErrorEntry.serializer(), entry))
            }
            previous?.uncaughtException(thread, e)
        }
    }

    suspend fun sendPending(context: Context, g: AppGraph = AppGraph.get(context)) {
        val f = file(context)
        if (!f.isFile || g.settings.demoMode || g.session.status.value != AuthStatus.ACTIVE) return
        val entry = runCatching { ApiJson.decodeFromString(ClientErrorEntry.serializer(), f.readText()) }.getOrNull()
        if (entry == null) {
            f.delete()
            return
        }
        try {
            g.api.clientErrors(ClientErrorsRequest(listOf(entry), diagnostics = ClientErrorDiagnostics(device = deviceDiagnostics(), appVersion = deviceDiagnostics().appVersion, route = "Absturz")))
            f.delete()
        } catch (e: ApiException.Network) {
            // try again next start
        } catch (e: ApiException) {
            f.delete()
        }
    }
}
