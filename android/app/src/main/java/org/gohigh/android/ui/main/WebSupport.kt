package org.gohigh.android.ui.main

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.widget.Toast
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import org.gohigh.android.util.DeepLinks
import org.json.JSONObject
import java.io.File

/** Helpers for the main WebView: external links, downloads (http, blob: and data: URLs). */
object WebSupport {

    /** Opens a link outside the WebView: http(s) in a Custom Tab, other schemes via their app. */
    fun openExternal(context: Context, uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        return try {
            when (scheme) {
                "http", "https" -> {
                    val colors = CustomTabColorSchemeParams.Builder().setToolbarColor(0xFF2563EB.toInt()).build()
                    CustomTabsIntent.Builder().setDefaultColorSchemeParams(colors).setShowTitle(true).build().launchUrl(context, uri)
                }
                "intent" -> {
                    val intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                        addCategory(Intent.CATEGORY_BROWSABLE)
                        component = null
                        selector = null
                    }
                    try {
                        context.startActivity(intent)
                    } catch (e: ActivityNotFoundException) {
                        intent.getStringExtra("browser_fallback_url")?.let { openExternal(context, Uri.parse(it)) }
                    }
                }
                "mailto", "sms", "smsto" -> context.startActivity(Intent(Intent.ACTION_SENDTO, uri))
                "tel" -> context.startActivity(Intent(Intent.ACTION_DIAL, uri))
                else -> context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
            }
            true
        } catch (e: Exception) {
            Toast.makeText(context, "Keine App für diesen Link gefunden", Toast.LENGTH_SHORT).show()
            true
        }
    }

    /** Should the WebView handle this navigation itself? */
    fun staysInside(base: String, uri: Uri): Boolean {
        val s = uri.scheme?.lowercase()
        if (s == "about" || s == "blob" || s == "data" || s == "javascript") return true
        return (s == "http" || s == "https") && DeepLinks.isInternal(base, uri.toString())
    }

    /** Regular download through the system DownloadManager (with the WebView cookies for logged-in files). */
    fun download(context: Context, url: String, userAgent: String?, contentDisposition: String?, mime: String?) {
        if (url.startsWith("data:")) {
            saveDataUrl(context, url, URLUtil.guessFileName(url, contentDisposition, mime))
            return
        }
        try {
            val name = URLUtil.guessFileName(url, contentDisposition, mime)
            val req = DownloadManager.Request(Uri.parse(url))
                .setTitle(name)
                .setDescription("HyperLevel")
                .setMimeType(mime)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
            userAgent?.let { req.addRequestHeader("User-Agent", it) }
            if (Build.VERSION.SDK_INT >= 29) req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            else req.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
            context.getSystemService(DownloadManager::class.java).enqueue(req)
            Toast.makeText(context, "Download gestartet: $name", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(context, "Download nicht möglich", Toast.LENGTH_SHORT).show()
        }
    }

    /** JavaScript that reads a blob: URL in the page and posts it back as data URL. */
    fun blobFetchScript(url: String, name: String, mime: String?): String {
        val u = JSONObject.quote(url)
        val n = JSONObject.quote(name)
        val m = JSONObject.quote(mime ?: "application/octet-stream")
        return """
            (function(){fetch($u).then(function(r){return r.blob();}).then(function(b){
              var fr=new FileReader();fr.onloadend=function(){GoHighAndroid.postMessage(JSON.stringify({name:$n,mime:b.type||$m,data:fr.result}));};
              fr.readAsDataURL(b);}).catch(function(e){GoHighAndroid.postMessage(JSON.stringify({error:String(e)}));});})();
        """.trimIndent()
    }

    /** Handles the message posted by [blobFetchScript]. */
    fun onBlobMessage(context: Context, message: String) {
        val o = runCatching { JSONObject(message) }.getOrNull() ?: return
        if (o.has("error")) {
            Toast.makeText(context, "Download nicht möglich", Toast.LENGTH_SHORT).show()
            return
        }
        saveDataUrl(context, o.optString("data"), o.optString("name").ifBlank { "download" })
    }

    private fun saveDataUrl(context: Context, dataUrl: String, name: String) {
        try {
            val comma = dataUrl.indexOf(',')
            val meta = dataUrl.substring(5, comma)
            val mime = meta.substringBefore(';').ifBlank { "application/octet-stream" }
            val bytes = if (meta.endsWith(";base64")) Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
            else Uri.decode(dataUrl.substring(comma + 1)).toByteArray()
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                }
                val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("insert failed")
                val out = context.contentResolver.openOutputStream(uri) ?: error("no stream")
                out.use { it.write(bytes) }
            } else {
                val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
                File(dir, name).writeBytes(bytes)
            }
            Toast.makeText(context, "Gespeichert in Downloads: $name", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(context, "Speichern fehlgeschlagen", Toast.LENGTH_SHORT).show()
        }
    }
}
