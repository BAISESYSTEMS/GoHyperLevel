package org.gohigh.android.ui.main

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.gohigh.android.AppGraph
import org.gohigh.android.BuildConfig
import org.gohigh.android.api.ApiException
import org.gohigh.android.api.BugReportRequest
import org.gohigh.android.feedback.deviceDiagnostics
import org.gohigh.android.util.DeepLinks
import kotlin.coroutines.resume

/** What the error screen can do. */
interface WebFallbackActions {
    fun reload()
    fun clearData()
    fun openInBrowser()
    fun sendDiagnostics()
    fun updateWebView(pkg: String)
}

/** Which WebView implementation runs here (`WebViewCompat.getCurrentWebViewPackage`; the user agent as a fallback). */
fun readWebViewInfo(context: Context, userAgent: String?): WebViewInfo {
    val pkg = runCatching { WebViewCompat.getCurrentWebViewPackage(context) }.getOrNull()
    return if (pkg != null) WebViewInfo(pkg.packageName, pkg.versionName) else WebViewInfo.fromUserAgent(userAgent)
}

/** Clearing what the WebView keeps: HTTP cache, history, WebStorage (local storage, IndexedDB, Cache Storage, service workers). */
object WebDataReset {
    /** Cookies carry the web login; they stay unless [cookies]. Main thread. */
    fun clear(context: Context, web: WebView?, cookies: Boolean) {
        val view = web ?: WebView(context)
        try {
            view.clearCache(true)
            view.clearFormData()
            view.clearHistory()
        } finally {
            if (web == null) view.destroy()
        }
        WebStorage.getInstance().deleteAllData()
        if (cookies) {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        }
    }
}

/**
 * Watches the main WebView so the screen never stays blank without a word: records console errors and failed
 * requests, restarts the page after a lost render process, and 6 s after a page finished checks that the web app
 * really started (see [LoadWatchdog], [PageHealth]). When it did not, [MainUiState.fallback] is set and the native
 * error screen (WebFallbackScreen) covers the page. All decisions live in WebHealth.kt; this class is the glue.
 */
class WebMonitor(
    private val activity: ComponentActivity,
    private val g: AppGraph,
    private val ui: MainUiState,
    /** The current WebView (it is replaced after a lost render process). */
    private val web: () -> WebView,
    /** Destroys the current WebView and puts a fresh one in its place. */
    private val replaceWeb: () -> Unit,
    /** Loads a URL in the WebView (reports it back through [loadRequested]). */
    private val loadUrl: (String) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) : WebFallbackActions {
    private val log get() = g.webLog
    private val dog = LoadWatchdog()
    private val crashes = RenderCrashTracker()
    private var ticker: Job? = null

    /** Bumped whenever the situation changes, so the answer of an older probe is ignored. */
    private var generation = 0
    private var mainFrameFailed = false
    private var lastUrl: String? = null

    val webView: WebViewInfo by lazy { readWebViewInfo(activity, web().settings.userAgentString) }

    private val base get() = g.settings.baseUrl

    // ------------------------------------------------------------------ WebView callbacks

    fun loadRequested(url: String) {
        generation++
        mainFrameFailed = false
        ui.fallback = null // a new attempt: the watchdog brings the error screen back if it fails again
        log.setStatus(LoadState.LOADING, url = url)
        dog.loadStarted(now())
        tick()
    }

    fun pageStarted(url: String?) {
        mainFrameFailed = false
        url?.let { lastUrl = it }
    }

    fun pageFinished(url: String?) {
        url?.let { lastUrl = it }
        if (mainFrameFailed) return
        generation++
        val appPage = url != null && DeepLinks.isAppPage(base, url)
        dog.pageFinished(now(), appPage)
        // Other pages of the server (download page, public pages) are not the web app: nothing to check.
        if (!appPage) log.setStatus(LoadState.OK, url = url)
        tick()
    }

    fun historyChanged(url: String?) {
        url?.let { lastUrl = it }
    }

    /** The page itself could not be loaded (no network …): the offline screen handles it, nothing to probe. */
    fun mainFrameError(description: String, url: String?) {
        mainFrameFailed = true
        generation++
        dog.cancel()
        ui.fallback = null
        log.add("Laden", "$description ${WebLog.cleanUrl(url)}".trim())
        log.setStatus(LoadState.NET_ERROR, description, url)
    }

    /** The certificate was refused (the page is not loaded, and the WebView says nothing more): same screen as no connection, with the reason. */
    fun sslError(primaryError: Int, url: String?) {
        val text = "Sichere Verbindung fehlgeschlagen. ${SslProblem.describe(primaryError)}"
        ui.loadError = text
        mainFrameError(text, url)
    }

    fun httpError(request: WebResourceRequest, response: WebResourceResponse) {
        val url = request.url.toString()
        if (!WebLog.worthLogging(request.isForMainFrame, url)) return
        val text = "${response.statusCode} ${response.reasonPhrase.orEmpty()} ${WebLog.cleanUrl(url)}".replace("  ", " ").trim()
        log.add("HTTP", text)
        if (request.isForMainFrame && response.statusCode >= 400) {
            mainFrameFailed = true
            generation++
            dog.cancel()
            log.setStatus(LoadState.HTTP_ERROR, "Der Server antwortete mit Fehler ${response.statusCode}.", url)
            showFallback(LoadState.HTTP_ERROR, "Der Server antwortete mit Fehler ${response.statusCode}.")
        }
    }

    /** A resource of the app failed outside the main frame (a missing script explains a blank page). */
    fun resourceError(request: WebResourceRequest, description: String) {
        if (request.isForMainFrame || !WebLog.worthLogging(false, request.url.toString())) return
        log.add("Laden", "$description ${WebLog.cleanUrl(request.url.toString())}")
    }

    fun console(message: ConsoleMessage) {
        if (message.messageLevel() != ConsoleMessage.MessageLevel.ERROR) return
        val where = WebLog.cleanUrl(message.sourceId()).substringAfter("://").substringAfter('/', "")
        log.add("JS", message.message().orEmpty() + if (where.isNotBlank()) " ($where:${message.lineNumber()})" else "")
    }

    /**
     * The renderer is gone: this WebView cannot be used any more. Put a new one in its place and load the page again;
     * the second loss within a minute shows the error screen instead of a loop. Always handled (returns true).
     */
    fun renderGone(detail: RenderProcessGoneDetail): Boolean {
        generation++
        dog.cancel()
        val reason = RenderCrashTracker.describe(detail.didCrash())
        log.add("Absturz", "$reason (Priorität ${detail.rendererPriorityAtExit()})")
        ui.progress = 0f
        when (crashes.record(now())) {
            RenderCrashTracker.Decision.REPLACE_AND_RELOAD -> {
                log.setStatus(LoadState.RENDERER_GONE, reason, lastUrl)
                val url = RestorePolicy.recoveryUrl(lastUrl, base)
                replaceWeb()
                loadUrl(url)
            }
            RenderCrashTracker.Decision.GIVE_UP -> {
                log.setStatus(LoadState.RENDERER_LOOP, reason, lastUrl)
                replaceWeb()
                showFallback(LoadState.RENDERER_LOOP, reason)
            }
        }
        return true
    }

    /** Back in front: a page that was fine a minute ago may have lost its content meanwhile. */
    fun onResume() {
        if (log.status.state == LoadState.OK && ui.loadError == null && ui.fallback == null && web().progress >= 100 && web().url?.let { DeepLinks.isAppPage(base, it) } == true) {
            dog.recheck(now())
            tick()
        }
    }

    fun destroy() {
        ticker?.cancel()
        dog.cancel()
    }

    // ------------------------------------------------------------------ the watchdog loop

    private fun tick() {
        if (ticker?.isActive == true || !dog.armed()) return
        ticker = activity.lifecycleScope.launch {
            while (isActive && dog.armed()) {
                delay(500)
                // Not in front: the page's timers are throttled, a probe would only mislead.
                if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) continue
                when (dog.due(now())) {
                    LoadWatchdog.Action.NONE -> Unit
                    LoadWatchdog.Action.NO_FINISH -> noFinish()
                    LoadWatchdog.Action.PROBE -> probe()
                }
            }
        }
    }

    private fun noFinish() {
        if (ui.loadError != null) return
        log.add("Prüfung", "Seite nach 30 s nicht fertig geladen")
        log.setStatus(LoadState.NO_FINISH, url = web().url ?: lastUrl)
        showFallback(LoadState.NO_FINISH)
    }

    private suspend fun probe() {
        val gen = generation
        val raw = withTimeoutOrNull(PROBE_TIMEOUT_MS) {
            suspendCancellableCoroutine { c: CancellableContinuation<String?> ->
                web().evaluateJavascript(PageHealth.PROBE_JS) { if (c.isActive) c.resume(it) }
            }
        }
        if (gen != generation) return // another load started meanwhile
        val probe = PageHealth.parseProbe(raw)
        probe?.errors?.forEach { log.add("JS", it) }
        val state = PageHealth.stateOf(PageHealth.judge(probe))
        dog.probeDone(now(), healthy = !state.isFailure)
        val url = web().url ?: lastUrl
        if (state.isFailure) {
            log.add("Prüfung", "${state.label} (${probe?.ready ?: "keine Antwort"})")
            log.setStatus(state, url = url)
            if (ui.loadError == null) showFallback(state)
        } else {
            log.setStatus(state, url = url)
            if (ui.fallback != null && ui.fallback?.state != LoadState.RENDERER_LOOP) ui.fallback = null // it came up after all
        }
    }

    private fun showFallback(state: LoadState, detail: String? = null) {
        ui.fallback = FallbackInfo(state, FallbackInfo.reasonFor(state, detail), log.lines(5), webView, web().url ?: lastUrl?.takeIf { it.isNotBlank() })
    }

    // ------------------------------------------------------------------ actions (error screen, menu, settings)

    /** „Neu laden“: reload the page – or load the start page when there is no page to reload (reload() would do nothing). */
    override fun reload() {
        val neverFinished = log.status.state == LoadState.NO_FINISH
        ui.fallback = null
        ui.loadError = null
        crashes.reset()
        val w = web()
        when (RestorePolicy.reloadAction(w.url, base, pageNeverFinished = neverFinished)) {
            RestorePolicy.ReloadAction.RELOAD -> {
                loadRequested(w.url!!)
                w.reload()
            }
            RestorePolicy.ReloadAction.LOAD_HOME -> loadUrl(DeepLinks.home(base))
        }
    }

    fun home() {
        ui.fallback = null
        ui.loadError = null
        loadUrl(DeepLinks.home(base))
    }

    override fun clearData() {
        WebDataReset.clear(activity, web(), cookies = false)
        log.add("Prüfung", "Cache und Offline-Daten gelöscht")
        toast("Offline-Daten gelöscht")
        afterReset()
    }

    /**
     * After the web data was cleared (here or in the settings): the page forgets its service workers and caches too
     * (WebStorage alone may leave them), then the start page loads afresh.
     */
    fun afterReset() {
        web().evaluateJavascript(OFFLINE_RESET_JS, null)
        activity.lifecycleScope.launch {
            delay(700) // let the page's service-worker cleanup go through
            home()
        }
    }

    override fun openInBrowser() {
        WebSupport.openExternal(activity, Uri.parse(lastUrl?.takeIf { DeepLinks.isInternal(base, it) } ?: DeepLinks.home(base)))
    }

    override fun updateWebView(pkg: String) {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse(WebViewVersion.marketUrl(pkg))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(market)
        } catch (e: Exception) {
            WebSupport.openExternal(activity, Uri.parse(WebViewVersion.webUrl(pkg)))
        }
    }

    /** The text of „Diagnose senden“ – also what the share sheet offers. */
    fun report(): String = DiagnosticsSender.report(g, webView, reason = null)

    /** Sends the report as a bug report to the team (needs the app to be connected); otherwise opens the share sheet. */
    override fun sendDiagnostics() {
        if (ui.sending) return
        ui.sending = true
        activity.lifecycleScope.launch {
            try {
                toast(DiagnosticsSender.send(activity, g, report()))
            } finally {
                ui.sending = false
            }
        }
    }

    private fun toast(s: String) = Toast.makeText(activity, s, Toast.LENGTH_LONG).show()

    private companion object {
        const val PROBE_TIMEOUT_MS = 4_000L
    }
}

/** „Diagnose senden“: the report text and its delivery (bug report to the team, share sheet as the fallback). */
object DiagnosticsSender {
    fun deviceLabel(): String =
        "${Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }} ${Build.MODEL.orEmpty()}, Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})"

    fun report(g: AppGraph, webView: WebViewInfo, reason: String?, now: Long = System.currentTimeMillis()): String {
        val st = g.webLog.status
        return DiagnosticsReport.build(
            appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            device = deviceLabel(),
            baseUrl = g.settings.baseUrl,
            webView = webView,
            status = st,
            lines = g.webLog.lines(15),
            now = now,
            reason = reason ?: FallbackInfo.reasonFor(st.state, st.detail),
        )
    }

    /** The message for the user. Without a connection to the account the share sheet opens instead. */
    suspend fun send(context: Context, g: AppGraph, text: String): String = try {
        val sent = g.api.createBugReport(
            BugReportRequest(
                category = "bug",
                what = text,
                severity = "hoch",
                screen = "Weiße Seite",
                device = deviceDiagnostics(),
                apiErrors = g.apiErrors.snapshot(),
                appVersion = deviceDiagnostics().appVersion,
            ),
        )
        if (sent.number > 0) "Gesendet – Meldung #${sent.number}" else "Gesendet"
    } catch (e: ApiException.Unauthorized) {
        share(context, text)
        "Die App ist nicht angemeldet – die Diagnose kannst du stattdessen teilen."
    } catch (e: ApiException) {
        share(context, text)
        "Senden nicht möglich (${e.message}) – die Diagnose kannst du stattdessen teilen."
    }

    private fun share(context: Context, text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        context.startActivity(Intent.createChooser(send, "Diagnose teilen").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
