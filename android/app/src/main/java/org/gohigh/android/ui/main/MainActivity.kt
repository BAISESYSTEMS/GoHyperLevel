package org.gohigh.android.ui.main

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.gohigh.android.AppGraph
import org.gohigh.android.BuildConfig
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.feedback.ScreenCapture
import org.gohigh.android.feedback.ShakeDetector
import org.gohigh.android.ui.report.ReportActivity
import org.gohigh.android.pair.Pairing
import org.gohigh.android.ui.settings.SettingsActivity
import org.gohigh.android.ui.theme.GoHighTheme
import org.gohigh.android.update.UpdateController
import org.gohigh.android.util.DeepLinks
import org.gohigh.android.work.WorkScheduler
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Observable state of the main screen. */
class MainUiState {
    var progress by mutableFloatStateOf(0f)
    var loadError by mutableStateOf<String?>(null)
    var menuOpen by mutableStateOf(false)
    var auth by mutableStateOf(AuthStatus.SIGNED_OUT)

    /** The native error screen in front of the page (empty page, never finished, render process lost over and over …). */
    var fallback by mutableStateOf<FallbackInfo?>(null)

    /** „Diagnose senden“ is running. */
    var sending by mutableStateOf(false)
}

/**
 * The full web app (`/app`) in a WebView, plus the native glue: pairing, deep links from widgets and
 * notifications, file uploads, downloads, microphone for the browser phone and external links.
 */
class MainActivity : ComponentActivity() {
    private val g by lazy { AppGraph.get(this) }
    private val pairing by lazy { Pairing(this, g) }
    private lateinit var web: WebView

    /** Holds the WebView; Compose only knows this container, so the WebView can be replaced (render process lost) without it. */
    private val webHost by lazy { FrameLayout(this) }
    /** Camera cutout and navigation bar insets for the page, re-applied after every page load. */
    private var edgeInsets: EdgeInsets? = null
    private val ui = MainUiState()
    private lateinit var updates: UpdateController
    private lateinit var monitor: WebMonitor

    private val shake by lazy { ShakeDetector(this) { reportBug() } }
    private var reporting = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pendingPermission?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
        pendingPermission = null
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        updates = UpdateController(this, lifecycleScope)
        monitor = WebMonitor(this, g, ui, web = { web }, replaceWeb = ::replaceWebView, loadUrl = ::load)
        installWebView()
        // restoreState() can return a history that is not null and still loads nothing (empty, no current page):
        // then – and without saved state – the start page is loaded.
        val restored = savedInstanceState?.let { web.restoreState(it) }
        val history = restored?.let { RestoredHistory(it.size, it.currentIndex, it.currentItem?.url) }
        if (RestorePolicy.needsFreshLoad(history)) load(startUrl(intent)) else monitor.loadRequested(history?.currentUrl.orEmpty())
        handleAction(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    ui.menuOpen -> ui.menuOpen = false
                    web.canGoBack() -> web.goBack()
                    else -> moveTaskToBack(true)
                }
            }
        })

        setContent {
            GoHighTheme(dynamic = g.settings.dynamicColor) {
                MainScreen(
                    web = webHost,
                    state = ui,
                    showMenuButton = g.settings.showMenuButton,
                    updates = updates,
                    onRetry = monitor::reload,
                    onSignIn = { load(DeepLinks.home(g.settings.baseUrl)) },
                    onMenuAction = ::onMenuAction,
                    fallbackActions = monitor,
                    onEdgeInsets = { e -> edgeInsets = e; web.evaluateJavascript(e.script(), null) },
                )
            }
        }

        lifecycleScope.launch {
            g.session.status.collect { ui.auth = it }
        }
        // While not paired, look for a fresh login every few seconds (only local cookie checks).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (true) {
                    if (g.session.status.value != AuthStatus.ACTIVE) onPairResult(pairing.maybePair())
                    delay(3000)
                }
            }
        }
        if (savedInstanceState == null) updates.check(manual = false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.data != null) load(startUrl(intent))
        handleAction(intent)
    }

    override fun onStart() {
        super.onStart()
        if (g.session.status.value == AuthStatus.ACTIVE) WorkScheduler.refreshNow(this)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        monitor.onResume()
        updates.onResume()
        reporting = false
        if (g.settings.shakeToReport) shake.start()
    }

    override fun onPause() {
        shake.stop()
        web.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        monitor.destroy()
        webHost.removeAllViews()
        web.destroy()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ intents

    private fun startUrl(intent: Intent?): String {
        val base = g.settings.baseUrl
        val data = intent?.data?.toString()
        if (data != null && (data.startsWith("https://") || data.startsWith("http://"))) {
            val rebased = DeepLinks.rebase(base, data)
            if (DeepLinks.isInternal(base, rebased)) return rebased
        }
        return DeepLinks.home(base)
    }

    private fun handleAction(intent: Intent?) {
        when (intent?.action) {
            ACTION_CHECK_UPDATE -> updates.check(manual = true)
            ACTION_SIGN_IN -> if (g.session.status.value != AuthStatus.ACTIVE) lifecycleScope.launch { onPairResult(pairing.maybePair(force = true)) }
            ACTION_RELOAD -> monitor.afterReset() // after Einstellungen → App zurücksetzen (Web-Daten)
        }
    }

    private fun onPairResult(r: Pairing.Result) {
        if (r != Pairing.Result.PAIRED) return
        android.widget.Toast.makeText(this, "Verbunden – Widgets werden gefüllt", android.widget.Toast.LENGTH_SHORT).show()
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun onMenuAction(action: MenuAction) {
        ui.menuOpen = false
        when (action) {
            MenuAction.RELOAD -> monitor.reload()
            MenuAction.HOME -> monitor.home()
            MenuAction.SETTINGS -> startActivity(Intent(this, SettingsActivity::class.java))
            MenuAction.BROWSER -> WebSupport.openExternal(this, Uri.parse(web.url ?: g.settings.baseUrl))
            MenuAction.REPORT -> lifecycleScope.launch {
                delay(350) // let the menu sheet close before the screenshot
                reportBug()
            }
            MenuAction.SHARE -> startActivity(
                Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, web.url), "Link teilen"),
            )
            is MenuAction.Quick -> startActivity(
                org.gohigh.android.widget.Launch.quick(this, action.action, g.settings.defaultLocation, "menu"),
            )
        }
    }

    /** „Fehler melden“ (menu or shake): screenshot of what is on screen, then the report form. */
    private fun reportBug() {
        if (reporting) return
        reporting = true
        val screen = web.url?.let { Uri.parse(it).path }
        ScreenCapture.capture(this) { file ->
            startActivity(ReportActivity.intent(this, screenshot = file, screen = screen))
        }
    }

    // ------------------------------------------------------------------ WebView

    /** Every page load goes through here, so the monitor knows a page is expected. */
    private fun load(url: String) {
        monitor.loadRequested(url)
        web.loadUrl(url)
    }

    private fun installWebView() {
        web = createWebView()
        webHost.removeAllViews()
        webHost.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) web.onResume()
    }

    /** After a lost render process the old WebView cannot be used any more: destroy it, start with a new one. */
    private fun replaceWebView() {
        val old = web
        webHost.removeView(old)
        runCatching { old.destroy() }
        installWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView = WebView(this).apply {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            allowFileAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString GoHighApp/${BuildConfig.VERSION_NAME}"
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // The web app has its own dark mode (prefers-color-scheme) – no forced darkening.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        webViewClient = Client()
        webChromeClient = Chrome()
        setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            if (url.startsWith("blob:")) {
                val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
                evaluateJavascript(WebSupport.blobFetchScript(url, name, mimeType), null)
            } else {
                WebSupport.download(this@MainActivity, url, userAgent, contentDisposition, mimeType)
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            val origin = Uri.parse(g.settings.baseUrl).let { "${it.scheme}://${it.authority}" }
            WebViewCompat.addWebMessageListener(this, "GoHighAndroid", setOf(origin)) { _, message, _, _, _ ->
                message.data?.let { WebSupport.onBlobMessage(this@MainActivity, it) }
            }
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val uri = request.url
            if (WebSupport.staysInside(g.settings.baseUrl, uri)) return false
            return WebSupport.openExternal(this@MainActivity, uri)
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            ui.loadError = null
            monitor.pageStarted(url)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            CookieManager.getInstance().flush()
            edgeInsets?.let { view.evaluateJavascript(it.script(), null) }
            monitor.pageFinished(url)
            if (g.session.status.value != AuthStatus.ACTIVE) lifecycleScope.launch { onPairResult(pairing.maybePair()) }
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // SPA navigation (pushState) – e.g. right after the login form succeeded.
            monitor.historyChanged(url)
            if (g.session.status.value != AuthStatus.ACTIVE) lifecycleScope.launch { onPairResult(pairing.maybePair()) }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            val text = error.description?.toString() ?: "Seite nicht erreichbar"
            if (request.isForMainFrame) {
                ui.loadError = text
                monitor.mainFrameError(text, request.url.toString())
            } else {
                monitor.resourceError(request, text)
            }
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel() // never continue past a certificate error
            monitor.sslError(error.primaryError, error.url)
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            monitor.httpError(request, errorResponse)
        }

        /** The renderer is gone: this WebView is dead. Replace it and load the page again (see [WebMonitor.renderGone]). */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = monitor.renderGone(detail)
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            ui.progress = newProgress / 100f
        }

        /** Console errors go to the ring buffer of the error screen and Einstellungen → Diagnose. */
        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
            monitor.console(consoleMessage)
            return super.onConsoleMessage(consoleMessage)
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                fileChooser.launch(params.createIntent())
                true
            } catch (e: Exception) {
                fileCallback = null
                callback.onReceiveValue(null)
                false
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val internal = DeepLinks.isInternal(g.settings.baseUrl, request.origin?.toString())
            if (!internal || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) {
                request.deny()
                return
            }
            if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                pendingPermission?.deny()
                pendingPermission = request
                micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        /** target=_blank / window.open: internal pages stay here, everything else goes to a Custom Tab. */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val temp = WebView(this@MainActivity)
            temp.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (WebSupport.staysInside(g.settings.baseUrl, uri) && DeepLinks.isAppPage(g.settings.baseUrl, uri.toString())) web.loadUrl(uri.toString())
                    else WebSupport.openExternal(this@MainActivity, uri)
                    v.destroy()
                    return true
                }

                override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                    v.destroy()
                    return true
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = temp
            resultMsg.sendToTarget()
            return true
        }
    }

    companion object {
        const val ACTION_CHECK_UPDATE = "org.gohigh.android.CHECK_UPDATE"
        const val ACTION_SIGN_IN = "org.gohigh.android.SIGN_IN"
        const val ACTION_RELOAD = "org.gohigh.android.RELOAD_WEB"
    }
}
