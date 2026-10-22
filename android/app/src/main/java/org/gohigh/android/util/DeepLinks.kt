package org.gohigh.android.util

import org.gohigh.android.api.ALL_LOCATIONS
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Builds URLs of the web app (opened inside the app's WebView). `?loc=<id>` makes the SPA switch to that
 * sub-account first; it is left out for "Alle Projekte".
 */
object DeepLinks {
    fun app(base: String, path: String = "/app", params: Map<String, String?> = emptyMap(), loc: String? = null): String {
        val root = baseUrl(base) ?: return path
        val p = if (path.startsWith("/")) path else "/$path"
        val b = root.newBuilder().encodedPath("/")
        // keep a possible base path prefix (e.g. https://host/crm)
        val prefix = root.encodedPath.trimEnd('/')
        b.encodedPath(prefix + p.substringBefore('?'))
        p.substringAfter('?', "").takeIf { it.isNotEmpty() }?.let { b.encodedQuery(it) }
        params.forEach { (k, v) -> if (!v.isNullOrBlank()) b.addQueryParameter(k, v) }
        if (!loc.isNullOrBlank() && loc != ALL_LOCATIONS) b.setQueryParameter("loc", loc)
        return b.build().toString()
    }

    fun home(base: String) = app(base, "/app")
    fun dashboard(base: String, loc: String? = null) = app(base, "/app/dashboard", loc = loc)
    fun conversations(base: String, loc: String? = null) = app(base, "/app/conversations", loc = loc)
    fun conversation(base: String, id: String, loc: String? = null) = app(base, "/app/conversations", mapOf("c" to id), loc)
    fun contact(base: String, id: String, loc: String? = null) = app(base, "/app/contacts/${enc(id)}", loc = loc)
    fun contacts(base: String, loc: String? = null) = app(base, "/app/contacts", loc = loc)
    fun opportunities(base: String, loc: String? = null) = app(base, "/app/opportunities", loc = loc)
    fun tasks(base: String, loc: String? = null) = app(base, "/app/tasks", loc = loc)
    fun calendars(base: String, loc: String? = null) = app(base, "/app/calendars", loc = loc)
    fun calls(base: String, loc: String? = null) = app(base, "/app/calls", loc = loc)
    fun project(base: String, loc: String? = null) = app(base, "/app/project", loc = loc)
    fun invoices(base: String, loc: String? = null) = app(base, "/app/invoices", loc = loc)
    fun reviews(base: String, loc: String? = null) = app(base, "/app/reviews", loc = loc)
    fun social(base: String, loc: String? = null) = app(base, "/app/social", loc = loc)
    fun accountDevices(base: String) = app(base, "/app/settings/account")

    /** Feed/notification links may be absolute or relative ("/app/…"). */
    fun resolve(base: String, link: String?): String {
        if (link.isNullOrBlank()) return home(base)
        if (link.startsWith("http://") || link.startsWith("https://")) return link
        val root = baseUrl(base) ?: return link
        val prefix = root.encodedPath.trimEnd('/')
        val path = if (link.startsWith("/")) link else "/$link"
        return root.resolve(prefix + path)?.toString() ?: link
    }

    /** True when [url] belongs to the configured server (stays in the WebView). */
    fun isInternal(base: String, url: String?): Boolean {
        val u = url?.toHttpUrlOrNull() ?: return false
        val b = baseUrl(base) ?: return false
        return u.host.equals(b.host, ignoreCase = true) && u.port == b.port
    }

    /** True for web-app pages (path /app or /app/…), the ones App Links / widgets open in the WebView. */
    fun isAppPage(base: String, url: String?): Boolean {
        if (!isInternal(base, url)) return false
        val u = url!!.toHttpUrlOrNull() ?: return false
        val prefix = baseUrl(base)!!.encodedPath.trimEnd('/')
        val path = u.encodedPath.removePrefix(prefix)
        return path == "/app" || path.startsWith("/app/")
    }

    /**
     * Rewrites an App Link for the default host (https://crm.example.com/app/…) onto the configured server,
     * so links keep working after the base URL was changed in the debug settings.
     */
    fun rebase(base: String, url: String): String {
        val u = url.toHttpUrlOrNull() ?: return url
        val b = baseUrl(base) ?: return url
        if (u.host == b.host && u.port == b.port && u.scheme == b.scheme) return url
        val prefix = b.encodedPath.trimEnd('/')
        return u.newBuilder().scheme(b.scheme).host(b.host).port(b.port).encodedPath(prefix + u.encodedPath).build().toString()
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    private fun baseUrl(base: String): HttpUrl? = base.trim().trimEnd('/').let { "$it/" }.toHttpUrlOrNull()
}
