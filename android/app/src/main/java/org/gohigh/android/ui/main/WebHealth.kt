package org.gohigh.android.ui.main

import kotlinx.serialization.Serializable
import org.gohigh.android.api.ApiJson
import org.gohigh.android.util.DeepLinks
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * The main screen must never stay blank without a word. This file is the logic behind that – pure Kotlin, no Android
 * types, unit-tested (WebHealthTest):
 *
 *  - [RestorePolicy]: when to load the start page after the WebView state was restored (an empty history loads nothing),
 *    and how "Neu laden" works on a WebView that has no page to reload;
 *  - [RenderCrashTracker]: render-process losses – reload once, show the error screen from the second one within a minute;
 *  - [PageHealth] / [LoadWatchdog]: did the web app really start 6 s after the page finished (and did the page finish at all);
 *  - [WebLog]: ring buffer of console errors / HTTP errors / events plus the last load status (shown in the error screen
 *    and under Einstellungen → Diagnose);
 *  - [WebViewVersion]: the system WebView's version against the oldest one the web app is built for.
 *
 * The Android side (MainActivity, WebMonitor) only wires WebView callbacks to these.
 */

/** Oldest Android System WebView (Chrome major version) the web app is built for – `build.target` in vite.config.ts. */
const val MIN_WEBVIEW_MAJOR = 92

/** The WebView implementation in use: its package (com.google.android.webview, com.android.chrome …) and version. */
data class WebViewInfo(val packageName: String?, val versionName: String?) {
    val major: Int? get() = WebViewVersion.major(versionName)
    val tooOld: Boolean get() = WebViewVersion.isTooOld(versionName)
    val label: String get() = listOfNotNull(packageName?.takeIf { it.isNotBlank() }, versionName?.takeIf { it.isNotBlank() }).joinToString(" ").ifBlank { "unbekannt" }

    companion object {
        /** When the package is unknown (very old Android, odd ROMs): the Chrome version in the user agent. */
        fun fromUserAgent(ua: String?): WebViewInfo = WebViewInfo(null, ua?.let { Regex("""Chrome/([\d.]+)""").find(it)?.groupValues?.get(1) })
    }
}

object WebViewVersion {
    /** "129.0.6668.100" → 129; null when there is no version. */
    fun major(version: String?): Int? = version?.trim()?.substringBefore('.')?.toIntOrNull()?.takeIf { it > 0 }

    /** Unknown versions are not "too old" – only a version we can read and that is below the minimum. */
    fun isTooOld(version: String?, min: Int = MIN_WEBVIEW_MAJOR): Boolean = major(version)?.let { it < min } ?: false

    private val PLAY_PACKAGES = Regex("""com\.google\.android\.webview(\.beta|\.dev|\.canary)?|com\.android\.chrome(\.beta|\.dev|\.canary)?""")

    /** The Play Store page that updates this WebView; null for providers that are not in the Play Store (Vanadium, Bromite …). */
    fun playStorePackage(pkg: String?): String? = pkg?.takeIf { PLAY_PACKAGES.matches(it) } ?: if (pkg.isNullOrBlank()) "com.google.android.webview" else null

    fun marketUrl(pkg: String) = "market://details?id=$pkg"

    fun webUrl(pkg: String) = "https://play.google.com/store/apps/details?id=$pkg"
}

// ------------------------------------------------------------------------------------------------ restore / reload

/** What a restored WebView history looks like (from `WebBackForwardList`; null = `restoreState` returned null). */
data class RestoredHistory(val size: Int, val currentIndex: Int, val currentUrl: String?)

object RestorePolicy {
    /**
     * `restoreState` can return a list that is not null and still loads nothing (no entries, no current item, a blank
     * page). Anything but a history with a real current page needs the start page loaded.
     */
    fun needsFreshLoad(h: RestoredHistory?): Boolean =
        h == null || h.size <= 0 || h.currentIndex !in 0 until h.size || h.currentUrl.isNullOrBlank() || h.currentUrl == "about:blank"

    enum class ReloadAction { RELOAD, LOAD_HOME }

    /**
     * `WebView.reload()` does nothing without a page, and little for a restored page that never started loading
     * ([pageNeverFinished]); then (and for anything that is not our server) the start page is loaded.
     */
    fun reloadAction(currentUrl: String?, base: String, pageNeverFinished: Boolean = false): ReloadAction =
        if (!pageNeverFinished && currentUrl != null && (currentUrl.startsWith("https://") || currentUrl.startsWith("http://")) && DeepLinks.isInternal(base, currentUrl)) ReloadAction.RELOAD else ReloadAction.LOAD_HOME

    /** After a lost render process: the page the user was on if it was one of the app's, else the start page. */
    fun recoveryUrl(lastUrl: String?, base: String): String = lastUrl?.takeIf { DeepLinks.isAppPage(base, it) } ?: DeepLinks.home(base)
}

/** What a certificate error means (`SslError.getPrimaryError()`: 0 … 5), in words the user can act on. */
object SslProblem {
    fun describe(primaryError: Int): String = when (primaryError) {
        0 -> "Das Zertifikat des Servers ist noch nicht gültig – Datum und Uhrzeit des Handys prüfen."
        1 -> "Das Zertifikat des Servers ist abgelaufen – Datum und Uhrzeit des Handys prüfen."
        2 -> "Das Zertifikat passt nicht zum Namen des Servers."
        3 -> "Dem Zertifikat des Servers wird nicht vertraut."
        4 -> "Das Datum des Zertifikats ist ungültig."
        else -> "Das Zertifikat des Servers ist ungültig."
    }
}

/** Render process lost: reload once; two in a minute are not a hiccup any more. */
class RenderCrashTracker(private val windowMs: Long = 60_000, private val limit: Int = 2) {
    enum class Decision { REPLACE_AND_RELOAD, GIVE_UP }

    private val times = ArrayDeque<Long>()

    @Synchronized
    fun record(now: Long): Decision {
        times.addLast(now)
        while (times.isNotEmpty() && now - times.first() >= windowMs) times.removeFirst()
        return if (times.size >= limit) Decision.GIVE_UP else Decision.REPLACE_AND_RELOAD
    }

    /** The user chose to try again: the count starts over. */
    @Synchronized
    fun reset() = times.clear()

    companion object {
        /** [didCrash] false = the system ended the process (memory), true = the renderer crashed. */
        fun describe(didCrash: Boolean): String =
            if (didCrash) "Der Web-Prozess der Anzeige ist abgestürzt." else "Das System hat den Web-Prozess der Anzeige beendet (meist zu wenig Arbeitsspeicher)."
    }
}

// ------------------------------------------------------------------------------------------------ is the page alive?

enum class LoadState(val label: String) {
    IDLE("Noch nichts geladen"),
    LOADING("Lädt …"),
    OK("Geladen"),
    EMPTY("Seite leer – die Web-App ist nicht gestartet"),
    WEB_FALLBACK("Die Web-App meldet: konnte nicht starten"),
    NO_ANSWER("Web-Ansicht antwortet nicht"),
    NO_FINISH("Seite wurde nicht fertig geladen"),
    NET_ERROR("Keine Verbindung"),
    HTTP_ERROR("Serverfehler"),
    RENDERER_GONE("Web-Prozess beendet, neu geladen"),
    RENDERER_LOOP("Web-Prozess fällt wiederholt aus"),
    ;

    /** States that put the error screen in front of the page. */
    val isFailure: Boolean get() = this in setOf(EMPTY, WEB_FALLBACK, NO_ANSWER, NO_FINISH, HTTP_ERROR, RENDERER_LOOP)
}

/** What the page says about itself ([PageHealth.PROBE_JS]). */
@Serializable
data class PageProbe(
    /** There is a `#root` – the page is the web app's shell. */
    val root: Boolean = false,
    /** Child nodes of `#root`. */
    val children: Int = 0,
    val text: Int = 0,
    /** `window.__pghlMounted` (set by the app after its first render). */
    val mounted: Boolean = false,
    /** The boot guard script ran. */
    val guard: Boolean = false,
    /** The web's own "Die App konnte nicht starten" page is what `#root` shows. */
    val fallback: Boolean = false,
    /** Messages of the errors the boot guard buffered (newest last). */
    val errors: List<String> = emptyList(),
    val ready: String = "",
    val url: String = "",
)

enum class PageVerdict { HEALTHY, NOT_AN_APP_PAGE, EMPTY, WEB_FALLBACK, NO_ANSWER }

object PageHealth {
    /**
     * Runs inside the page: is `#root` filled, did the app flag its mount, is the web's fallback page showing, what did
     * the boot guard collect. Returns an object (null when the script threw).
     */
    const val PROBE_JS = "(function(){try{var r=document.getElementById('root'),b=window.__pghlBoot;" +
        "return {root:!!r,children:r?r.childNodes.length:0,text:r?(r.textContent||'').length:0,mounted:window.__pghlMounted===true,guard:!!b," +
        "fallback:!!document.getElementById('pghl-boot-fallback')," +
        "errors:(b&&b.errors&&b.errors.map)?b.errors.slice(-5).map(function(e){return String(e.message).slice(0,200)}):[]," +
        "ready:document.readyState,url:location.pathname};}catch(e){return null;}})()"

    /** `evaluateJavascript` hands back JSON text: an object, a quoted string containing one, or "null". */
    fun parseProbe(raw: String?): PageProbe? {
        val t = raw?.trim().orEmpty()
        if (t.isEmpty() || t == "null" || t == "undefined") return null
        return runCatching {
            val el = ApiJson.parseToJsonElement(t)
            val text = (el as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
            ApiJson.decodeFromString(PageProbe.serializer(), text ?: t)
        }.getOrNull()
    }

    /**
     * The root must hold something (the app flags its mount, but an older server build does not – content is what counts,
     * and a flag with an empty root means the tree was torn down). The web's own fallback page is a failure too.
     */
    fun judge(p: PageProbe?): PageVerdict = when {
        p == null -> PageVerdict.NO_ANSWER
        !p.root -> PageVerdict.NOT_AN_APP_PAGE
        p.fallback -> PageVerdict.WEB_FALLBACK
        p.children > 0 -> PageVerdict.HEALTHY
        else -> PageVerdict.EMPTY
    }

    fun stateOf(v: PageVerdict): LoadState = when (v) {
        PageVerdict.HEALTHY, PageVerdict.NOT_AN_APP_PAGE -> LoadState.OK
        PageVerdict.EMPTY -> LoadState.EMPTY
        PageVerdict.WEB_FALLBACK -> LoadState.WEB_FALLBACK
        PageVerdict.NO_ANSWER -> LoadState.NO_ANSWER
    }
}

/**
 * When to look at the page. After a load was requested the page has [startTimeoutMs] to finish; [settleMs] after it
 * finished the app has to be up (probe). A probe that fails is repeated every [recheckMs] for [recheckForMs] – a slow
 * device may still mount – and the error screen goes away by itself if the app does come up.
 */
class LoadWatchdog(
    private val settleMs: Long = 6_000,
    private val startTimeoutMs: Long = 30_000,
    private val recheckMs: Long = 5_000,
    private val recheckForMs: Long = 120_000,
) {
    enum class Action { NONE, PROBE, NO_FINISH }

    private enum class Phase { IDLE, WAIT_FINISH, SETTLING, RECHECK }

    private var phase = Phase.IDLE
    private var at = 0L
    private var until = 0L

    /** A load was requested (loadUrl, reload, restore). */
    @Synchronized
    fun loadStarted(now: Long) {
        phase = Phase.WAIT_FINISH
        at = now + startTimeoutMs
    }

    /** `onPageFinished`; only the web app's pages are probed. */
    @Synchronized
    fun pageFinished(now: Long, appPage: Boolean) {
        if (appPage) {
            phase = Phase.SETTLING
            at = now + settleMs
        } else {
            phase = Phase.IDLE
        }
    }

    /** What to do now. [Action.PROBE] and [Action.NO_FINISH] are reported once; answer a probe with [probeDone]. */
    @Synchronized
    fun due(now: Long): Action = when {
        phase == Phase.IDLE || now < at -> Action.NONE
        phase == Phase.WAIT_FINISH -> {
            phase = Phase.IDLE
            Action.NO_FINISH
        }
        else -> {
            // Hold until the answer comes: probeDone() decides about the next probe.
            at = Long.MAX_VALUE
            Action.PROBE
        }
    }

    /** Look at the page again soon (the app came back to the front). */
    @Synchronized
    fun recheck(now: Long, inMs: Long = 1_500) {
        phase = Phase.SETTLING
        at = now + inMs
    }

    @Synchronized
    fun probeDone(now: Long, healthy: Boolean) {
        if (healthy) {
            phase = Phase.IDLE
            return
        }
        if (phase == Phase.SETTLING) until = now + recheckForMs
        if (now < until) {
            phase = Phase.RECHECK
            at = now + recheckMs
        } else {
            phase = Phase.IDLE
        }
    }

    @Synchronized
    fun cancel() {
        phase = Phase.IDLE
    }

    /** True while a timer is armed (the monitor only ticks then). */
    @Synchronized
    fun armed(): Boolean = phase != Phase.IDLE
}

// ------------------------------------------------------------------------------------------------ what happened

@Serializable
data class WebLogEntry(val at: Long, val kind: String, val text: String, val count: Int = 1)

@Serializable
data class WebStatus(val state: LoadState = LoadState.IDLE, val at: Long = 0, val detail: String = "", val url: String = "")

@Serializable
private data class WebLogSnapshot(val status: WebStatus = WebStatus(), val entries: List<WebLogEntry> = emptyList())

/**
 * The last console errors, HTTP errors and watchdog events of the WebView (ring buffer, identical neighbours are
 * counted) and the last load status. Only text – never page content, cookies or query strings.
 */
class WebLog(private val capacity: Int = 30, private val clock: () -> Long = System::currentTimeMillis) {
    private val entries = ArrayDeque<WebLogEntry>()

    @Volatile
    var status: WebStatus = WebStatus()
        private set

    /** Called when the status changed (the app persists it). */
    @Volatile
    var onStatusChange: ((WebLog) -> Unit)? = null

    @Synchronized
    fun add(kind: String, text: String) {
        val t = text.trim().take(MAX_TEXT)
        if (t.isEmpty()) return
        val last = entries.lastOrNull()
        if (last != null && last.kind == kind && last.text == t) {
            entries[entries.lastIndex] = last.copy(at = clock(), count = last.count + 1)
        } else {
            entries.addLast(WebLogEntry(clock(), kind, t))
            while (entries.size > capacity) entries.removeFirst()
        }
    }

    fun setStatus(state: LoadState, detail: String = "", url: String? = null) {
        synchronized(this) { status = WebStatus(state, clock(), detail.take(MAX_TEXT), cleanUrl(url ?: status.url)) }
        onStatusChange?.invoke(this)
    }

    @Synchronized
    fun snapshot(): List<WebLogEntry> = entries.toList()

    @Synchronized
    fun clear() = entries.clear()

    /** The newest [n] entries as one line each, newest last. */
    fun lines(n: Int = 5, zone: ZoneId = ZoneId.systemDefault()): List<String> = snapshot().takeLast(n).map { it.line(zone) }

    @Synchronized
    fun toJson(): String = ApiJson.encodeToString(WebLogSnapshot.serializer(), WebLogSnapshot(status, entries.toList()))

    /** Brings back what [toJson] saved (after a restart); broken input leaves the log empty. */
    @Synchronized
    fun restore(json: String?) {
        val s = json?.let { runCatching { ApiJson.decodeFromString(WebLogSnapshot.serializer(), it) }.getOrNull() } ?: return
        status = s.status
        entries.clear()
        entries.addAll(s.entries.takeLast(capacity))
    }

    companion object {
        const val MAX_TEXT = 300

        /** Scheme, host and path only: query strings and fragments can carry tokens. */
        fun cleanUrl(url: String?): String = url?.substringBefore('#')?.substringBefore('?')?.take(200).orEmpty()

        /** Is a failed request worth a log line? The page itself and the app's scripts/styles (a missing one explains a blank page). */
        fun worthLogging(isMainFrame: Boolean, url: String?): Boolean = isMainFrame || cleanUrl(url).contains("/assets/")
    }
}

private val TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")

fun WebLogEntry.line(zone: ZoneId = ZoneId.systemDefault()): String =
    "${TIME.format(Instant.ofEpochMilli(at).atZone(zone))} $kind: $text" + if (count > 1) " (${count}×)" else ""

// ------------------------------------------------------------------------------------------------ error screen

/** What the error screen shows. */
data class FallbackInfo(
    val state: LoadState,
    /** One sentence: what went wrong. */
    val reason: String,
    /** The newest log lines. */
    val errors: List<String>,
    val webView: WebViewInfo,
    val url: String? = null,
) {
    val tooOld: Boolean get() = webView.tooOld

    /** Package to open in the Play Store to update the WebView; null when it cannot be updated from there. */
    val updatePackage: String? get() = if (tooOld) WebViewVersion.playStorePackage(webView.packageName) else null

    companion object {
        const val TITLE = "Die Seite lädt nicht"

        fun reasonFor(state: LoadState, detail: String? = null): String = when (state) {
            LoadState.EMPTY -> "Die Seite ist geladen, aber die Web-App hat nichts angezeigt."
            LoadState.WEB_FALLBACK -> "Die Web-App meldet, dass sie nicht starten konnte."
            LoadState.NO_ANSWER -> "Die Web-Ansicht antwortet nicht."
            LoadState.NO_FINISH -> "Die Seite wurde auch nach 30 Sekunden nicht fertig geladen."
            LoadState.RENDERER_LOOP -> detail?.takeIf { it.isNotBlank() }?.let { "$it Zweimal innerhalb einer Minute." } ?: "Der Web-Prozess ist zweimal innerhalb einer Minute ausgefallen."
            else -> detail?.takeIf { it.isNotBlank() } ?: state.label
        }
    }
}

/** The text „Diagnose senden“ sends (and the share sheet offers): everything needed, nothing private. */
object DiagnosticsReport {
    fun build(
        appVersion: String,
        device: String,
        baseUrl: String,
        webView: WebViewInfo,
        status: WebStatus,
        lines: List<String>,
        now: Long,
        /** One sentence: what went wrong (first line of the report). */
        reason: String,
        zone: ZoneId = ZoneId.systemDefault(),
    ): String {
        val host = baseUrl.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#').ifBlank { baseUrl }
        val state = if (status.at > 0) "${status.state.label} (vor ${((now - status.at) / 1000).coerceAtLeast(0)} s, ${TIME.format(Instant.ofEpochMilli(status.at).atZone(zone))})" else status.state.label
        return buildString {
            append("Weiße Seite in der HyperLevel-App: ").appendLine(reason)
            appendLine()
            appendLine("App: $appVersion")
            appendLine("Gerät: $device")
            append("WebView: ${webView.label}")
            if (webView.tooOld) append(" – zu alt (mindestens $MIN_WEBVIEW_MAJOR nötig)")
            appendLine()
            appendLine("Server: $host")
            appendLine("Status: $state")
            if (status.url.isNotBlank()) appendLine("Seite: ${status.url}")
            appendLine()
            if (lines.isEmpty()) append("Keine Fehler aufgezeichnet.") else {
                appendLine("Letzte Fehler (neueste zuletzt):")
                lines.forEach { appendLine("- $it") }
            }
        }.trimEnd().take(MAX_REPORT)
    }

    const val MAX_REPORT = 4000
}

/** Runs in the page: forget service workers and caches (the Android side also clears WebStorage and the HTTP cache). */
const val OFFLINE_RESET_JS = "(function(){try{var j=[];" +
    "if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){j.push(navigator.serviceWorker.getRegistrations().then(function(l){return Promise.all(l.map(function(r){return r.unregister()}))}))}" +
    "if(window.caches&&caches.keys){j.push(caches.keys().then(function(k){return Promise.all(k.map(function(x){return caches.delete(x)}))}))}" +
    "return Promise.all(j.map(function(p){return p.catch(function(){})})).then(function(){return 'ok'})}catch(e){return 'error'}})()"
