package org.gohigh.android.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import org.gohigh.android.BuildConfig
import org.gohigh.android.api.AppRelease
import org.gohigh.android.api.GoHighApi
import org.gohigh.android.data.AppSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

class UpdateException(message: String) : IOException(message)

/** Pure helpers (unit tested). */
object VersionCheck {
    fun isNewer(remote: AppRelease?, localCode: Int): Boolean = remote != null && remote.versionCode > localCode

    /** The server says this build is too old to keep working. */
    fun isForced(remote: AppRelease, localCode: Int): Boolean = (remote.minSupportedCode ?: 0) > localCode

    fun sizeLabel(bytes: Long?): String? = bytes?.takeIf { it > 0 }?.let { "%.1f MB".format(java.util.Locale.GERMANY, it / 1_048_576.0) }
}

object Sha256 {
    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun of(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return hex(md.digest())
    }

    fun of(file: File): String = file.inputStream().use { of(it) }

    /** Accepts upper/lower case, "sha256:" prefixes and colon-separated hex. */
    fun matches(actualHex: String, expected: String): Boolean {
        val norm = expected.trim().lowercase().removePrefix("sha256:").replace(":", "").replace(" ", "")
        return norm.length == 64 && norm == actualHex.lowercase()
    }
}

/**
 * In-app updater: `GET /api/mobile/app` → download the APK → verify sha256 → hand it to the system installer
 * through a FileProvider URI (needs "Unbekannte Apps installieren" for HyperLevel once).
 */
class Updater(
    private val context: Context,
    private val api: GoHighApi,
    http: OkHttpClient,
    private val settings: AppSettings,
    private val localCode: Int = BuildConfig.VERSION_CODE,
    /** Plain http only for debug builds (local dev server); release builds insist on HTTPS. */
    private val allowHttp: Boolean = BuildConfig.DEBUG,
) {
    private val downloadClient = http.newBuilder().readTimeout(2, TimeUnit.MINUTES).build()

    /** Newer release or null. Throws ApiException on network errors. */
    suspend fun check(): AppRelease? {
        val r = api.appRelease()
        settings.lastUpdateCheck = System.currentTimeMillis()
        return r?.takeIf { VersionCheck.isNewer(it, localCode) }
    }

    fun isForced(r: AppRelease) = VersionCheck.isForced(r, localCode)

    /** Downloads into the cache dir, verifying the checksum while streaming. */
    suspend fun download(release: AppRelease, onProgress: (Float) -> Unit = {}): File = withContext(Dispatchers.IO) {
        val url = api.url(release.apkUrl.ifBlank { "/downloads/gohigh.apk" }) ?: throw UpdateException("Download-Adresse ungültig")
        if (!url.isHttps && !allowHttp) throw UpdateException("Update nur über HTTPS erlaubt")
        if (release.sha256.isBlank()) throw UpdateException("Keine Prüfsumme vom Server")
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val target = File(dir, "gohigh-${release.versionCode}.apk")
        val req = Request.Builder().url(url).header("User-Agent", "HyperLevel-Android/${BuildConfig.VERSION_NAME}").build()
        downloadClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw UpdateException("Download fehlgeschlagen (${resp.code})")
            val body = resp.body ?: throw UpdateException("Leere Antwort")
            val total = body.contentLength().takeIf { it > 0 } ?: release.size ?: -1L
            val md = MessageDigest.getInstance("SHA-256")
            var read = 0L
            body.byteStream().use { input ->
                target.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                        read += n
                        if (total > 0) onProgress((read.toFloat() / total).coerceIn(0f, 1f))
                    }
                }
            }
            if (!Sha256.matches(Sha256.hex(md.digest()), release.sha256)) {
                target.delete()
                throw UpdateException("Prüfsumme stimmt nicht – Update verworfen")
            }
        }
        target
    }

    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    fun installPermissionIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))

    fun installIntent(apk: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", apk)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
