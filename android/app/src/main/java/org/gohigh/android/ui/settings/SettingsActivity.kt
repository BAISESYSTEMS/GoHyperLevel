package org.gohigh.android.ui.settings

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.CookieManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import org.gohigh.android.AppGraph
import org.gohigh.android.BuildConfig
import org.gohigh.android.api.DeviceInfo
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.DataRequest
import org.gohigh.android.data.NotifyCategory
import org.gohigh.android.feedback.ScreenCapture
import org.gohigh.android.ui.report.ReportActivity
import org.gohigh.android.ui.report.ReportTab
import org.gohigh.android.ui.main.DiagnosticsSender
import org.gohigh.android.ui.main.LoadState
import org.gohigh.android.ui.main.MainActivity
import org.gohigh.android.ui.main.WebDataReset
import org.gohigh.android.ui.main.readWebViewInfo
import org.gohigh.android.ui.theme.GoHighTheme
import org.gohigh.android.update.UpdateController
import org.gohigh.android.update.UpdateDialog
import org.gohigh.android.util.DeepLinks
import org.gohigh.android.util.Fmt
import org.gohigh.android.widget.WidgetUpdater
import org.gohigh.android.work.WorkScheduler
import kotlinx.coroutines.launch

/** Native settings: account, devices, notifications, widgets, updates, logout (+ hidden developer options). */
class SettingsActivity : ComponentActivity(), SettingsActions {
    private val g by lazy { AppGraph.get(this) }
    private lateinit var updates: UpdateController
    private var devices by mutableStateOf<List<DeviceInfo>?>(null)
    private var widgetCount by mutableIntStateOf(0)
    private var versionTaps = 0

    /** Bumped when something outside the settings store changed (permission, devices, …). */
    private var localTick by mutableIntStateOf(0)
    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { localTick++ }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        updates = UpdateController(this, lifecycleScope)
        setContent {
            val tick by g.settings.changes.collectAsState()
            val auth by g.session.status.collectAsState()
            val state = buildState(tick + localTick, auth, devices, widgetCount)
            GoHighTheme(dynamic = state.dynamicColor) {
                SettingsScreen(state, this)
                UpdateDialog(updates)
            }
        }
        load()
    }

    override fun onResume() {
        super.onResume()
        updates.onResume()
        localTick++ // re-read notification permission state
    }

    private fun buildState(@Suppress("UNUSED_PARAMETER") tick: Long, auth: AuthStatus, devices: List<DeviceInfo>?, widgets: Int) = SettingsState(
        user = g.session.user,
        auth = auth,
        server = g.settings.baseUrl,
        demo = g.settings.demoMode,
        devices = devices,
        notify = NotifyCategory.entries.associateWith { g.settings.notifyEnabled(it) },
        notifyPermission = g.notifier.canPost(),
        refreshMinutes = g.settings.refreshMinutes,
        defaultLocation = g.settings.defaultLocation,
        locations = g.repository.me()?.locations.orEmpty(),
        dynamicColor = g.settings.dynamicColor,
        showMenuButton = g.settings.showMenuButton,
        diag = diagState(),
        version = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
        debugUnlocked = g.settings.debugUnlocked || BuildConfig.DEBUG,
        widgetCount = widgets,
        shakeToReport = g.settings.shakeToReport,
    )

    private fun diagState(): DiagState {
        val st = g.webLog.status
        val now = System.currentTimeMillis()
        val web = readWebViewInfo(this, null)
        return DiagState(
            webView = web.label,
            webViewTooOld = web.tooOld,
            server = g.settings.baseUrl,
            status = if (st.at > 0) "${st.state.label} · ${Fmt.ago(st.at, now)}" + st.detail.takeIf { it.isNotBlank() && st.state != LoadState.OK }?.let { " – $it" }.orEmpty() else "",
            statusFailed = st.state.isFailure || st.state == LoadState.NET_ERROR,
            errors = g.webLog.lines(6),
        )
    }

    private fun load() {
        lifecycleScope.launch {
            widgetCount = WidgetUpdater.placed(this@SettingsActivity).size
            if (g.session.status.value == AuthStatus.ACTIVE) {
                runCatching { g.repository.load(DataRequest.Me, maxAgeMs = 10 * 60_000) }
                devices = runCatching { g.api.devices() }.getOrNull()
                localTick++
            }
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    override fun back() = finish()

    override fun openDevicesInWeb() {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DeepLinks.accountDevices(g.settings.baseUrl)), this, MainActivity::class.java))
    }

    override fun revokeDevice(d: DeviceInfo) {
        lifecycleScope.launch {
            try {
                g.api.revokeDevice(d.id)
                devices = devices?.filterNot { it.id == d.id }
                toast("${d.label} abgemeldet")
            } catch (e: Exception) {
                toast(e.message ?: "Fehler")
            }
        }
    }

    override fun setNotify(c: NotifyCategory, on: Boolean) = g.settings.setNotifyEnabled(c, on)

    override fun requestNotifyPermission() {
        if (Build.VERSION.SDK_INT >= 33) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS) else openSystemNotifications()
    }

    override fun openSystemNotifications() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
    }

    override fun setRefresh(minutes: Int) {
        g.settings.refreshMinutes = minutes
        WorkScheduler.schedulePeriodic(this, minutes, replace = true)
    }

    override fun refreshNow() {
        WorkScheduler.refreshNow(this, feed = true)
        toast("Widgets werden aktualisiert")
    }

    override fun setDefaultLocation(id: String) {
        g.settings.defaultLocation = id
    }

    override fun setDynamicColor(on: Boolean) {
        g.settings.dynamicColor = on
    }

    override fun setShowMenuButton(on: Boolean) {
        g.settings.showMenuButton = on
    }

    override fun checkUpdate() = updates.check(manual = true)

    override fun versionTapped() {
        if (g.settings.debugUnlocked) return
        versionTaps++
        if (versionTaps >= 7) {
            g.settings.debugUnlocked = true
            toast("Entwickler-Optionen freigeschaltet")
        } else if (versionTaps >= 4) {
            toast("Noch ${7 - versionTaps}× tippen")
        }
    }

    override fun signIn() {
        startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN))
        finish()
    }

    override fun logout() {
        lifecycleScope.launch {
            runCatching { g.api.logout() } // revoke the token on the server (best effort)
            signOutLocally()
            toast("Abgemeldet")
            finish()
        }
    }

    private suspend fun signOutLocally() {
        g.session.signOut()
        g.settings.clearAccountState()
        g.repository.clear()
        // Clear the web login too – otherwise the app would pair again right away.
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WorkScheduler.cancelAll(this)
        WidgetUpdater.updateAll(this)
    }

    override fun setServer(url: String) {
        lifecycleScope.launch {
            if (g.session.isPaired) runCatching { g.api.logout() }
            signOutLocally()
            g.settings.baseUrl = url
            g.session.refresh()
            toast("Server: ${g.settings.baseUrl}")
            startActivity(Intent(this@SettingsActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    override fun setDemo(on: Boolean) {
        g.settings.demoMode = on
        g.session.refresh()
        g.repository.clear()
        lifecycleScope.launch {
            if (on) {
                runCatching { g.repository.refresh(DataRequest.Me) }
                WorkScheduler.refreshNow(this@SettingsActivity)
            }
            WidgetUpdater.updateAll(this@SettingsActivity)
        }
    }

    override fun reportBug() {
        ScreenCapture.capture(this) { file -> startActivity(ReportActivity.intent(this, screenshot = file, screen = "App-Einstellungen")) }
    }

    override fun openMyReports() = startActivity(ReportActivity.intent(this, ReportTab.MINE))

    override fun openWishes() = startActivity(ReportActivity.intent(this, ReportTab.WISHES))

    override fun setShakeToReport(on: Boolean) {
        g.settings.shakeToReport = on
    }

    override fun sendDiagnostics() {
        lifecycleScope.launch {
            val text = DiagnosticsSender.report(g, readWebViewInfo(this@SettingsActivity, null), reason = null)
            toast(DiagnosticsSender.send(this@SettingsActivity, g, text))
        }
    }

    /** Cache, offline data and the web login are deleted; the main screen then loads the start page afresh. */
    override fun resetWebData() {
        WebDataReset.clear(this, null, cookies = true)
        g.webLog.clear()
        toast("Web-Daten gelöscht")
        startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_RELOAD).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    override fun resetFeed() {
        g.settings.feedCursor = null
        g.settings.feedSeen = emptyList()
        toast("Zurückgesetzt")
    }
}

