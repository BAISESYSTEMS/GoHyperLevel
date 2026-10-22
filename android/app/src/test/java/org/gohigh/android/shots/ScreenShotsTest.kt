package org.gohigh.android.shots

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import org.gohigh.android.AppGraph
import org.gohigh.android.api.ApiUser
import org.gohigh.android.api.DemoData
import org.gohigh.android.api.DeviceInfo
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.DataRequest
import org.gohigh.android.data.InMemoryTokenStore
import org.gohigh.android.data.NotifyCategory
import org.gohigh.android.ui.config.WidgetConfigScreen
import org.gohigh.android.ui.quick.AppointmentScreen
import org.gohigh.android.ui.quick.CallScreen
import org.gohigh.android.ui.quick.ContactScreen
import org.gohigh.android.ui.quick.DealScreen
import org.gohigh.android.ui.quick.ReplyScreen
import org.gohigh.android.ui.quick.TaskScreen
import org.gohigh.android.ui.main.FallbackInfo
import org.gohigh.android.ui.main.LoadState
import org.gohigh.android.ui.main.WebFallbackActions
import org.gohigh.android.ui.main.WebFallbackScreen
import org.gohigh.android.ui.main.WebViewInfo
import org.gohigh.android.ui.settings.DiagState
import org.gohigh.android.ui.settings.SettingsActions
import org.gohigh.android.ui.settings.SettingsScreen
import org.gohigh.android.ui.settings.SettingsState
import org.gohigh.android.ui.theme.GoHighTheme
import org.gohigh.android.ui.report.MyReportsScreen
import org.gohigh.android.ui.report.ReportForm
import org.gohigh.android.ui.report.ReportFormScreen
import org.gohigh.android.ui.report.ReportScaffold
import org.gohigh.android.ui.report.ReportTab
import org.gohigh.android.ui.report.WishesScreen
import org.gohigh.android.api.ApiErrorEntry
import org.gohigh.android.api.DeviceDiagnostics
import androidx.compose.ui.graphics.asImageBitmap
import org.gohigh.android.widget.KpiMetric
import org.gohigh.android.widget.WidgetConfig
import org.gohigh.android.widget.WidgetKind
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Native screens rendered with Robolectric + Roborazzi (demo data, no network). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w400dp-h860dp-xhdpi")
class ScreenShotsTest {
    @get:Rule val compose = createComposeRule()
    private val ctx: Context get() = ApplicationProvider.getApplicationContext()
    private val demo = DemoData()

    @Before fun setUp() {
        System.setProperty("roborazzi.test.record", "true")
        val g = AppGraph(ctx, InMemoryTokenStore("ghm_test"))
        g.settings.demoMode = true
        g.session.refresh()
        g.cache.write(DataRequest.Me.key, DataRequest.Me.serializer, demo.me())
        g.cache.write(DataRequest.Deals("loc_maler").key, DataRequest.Deals("loc_maler").serializer, demo.deals())
        AppGraph.install(g)
    }

    private fun file(name: String) = File(Shots.dir, "$name.png").path

    private fun shot(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        compose.setContent { GoHighTheme(dark = dark) { content() } }
        compose.waitForIdle()
        compose.onRoot().captureRoboImage(file(name))
    }

    /** Quick-action sheets sit on a dimmed home screen. */
    @Composable
    private fun OverHome(content: @Composable () -> Unit) {
        Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF93C5FD), Color(0xFFFDE68A))))) {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)))
            content()
        }
    }

    private val actions = object : SettingsActions {
        override fun back() {}
        override fun openDevicesInWeb() {}
        override fun revokeDevice(d: DeviceInfo) {}
        override fun setNotify(c: NotifyCategory, on: Boolean) {}
        override fun requestNotifyPermission() {}
        override fun openSystemNotifications() {}
        override fun setRefresh(minutes: Int) {}
        override fun refreshNow() {}
        override fun setDefaultLocation(id: String) {}
        override fun setDynamicColor(on: Boolean) {}
        override fun setShowMenuButton(on: Boolean) {}
        override fun checkUpdate() {}
        override fun versionTapped() {}
        override fun signIn() {}
        override fun logout() {}
        override fun setServer(url: String) {}
        override fun setDemo(on: Boolean) {}
        override fun resetFeed() {}
    }

    private fun settingsState(auth: AuthStatus = AuthStatus.ACTIVE, debug: Boolean = false) = SettingsState(
        user = ApiUser("u1", "Alex Beispiel", "alex@example.com", "admin"),
        auth = auth,
        server = "https://crm.example.com",
        demo = false,
        devices = listOf(
            DeviceInfo("d1", name = "Pixel 9 Pro", appVersion = "1.0.0 (1)", lastUsedAt = java.time.Instant.now().minusSeconds(60).toString(), current = true),
            DeviceInfo("d2", name = "Galaxy Tab S9", appVersion = "1.0.0 (1)", lastUsedAt = java.time.Instant.now().minusSeconds(86400 * 2).toString()),
        ),
        notify = NotifyCategory.entries.associateWith { it != NotifyCategory.REVIEWS },
        notifyPermission = true,
        refreshMinutes = 15,
        defaultLocation = "loc_maler",
        locations = demo.locations,
        dynamicColor = false,
        showMenuButton = true,
        version = "1.0.0 (1)",
        debugUnlocked = debug,
        widgetCount = 6,
    )

    @Test fun settings() {
        shot("40-settings-light") { SettingsScreen(settingsState(), actions) }
    }

    @Test fun settingsDarkSignedOut() {
        shot("40-settings-dark-expired", dark = true) { SettingsScreen(settingsState(AuthStatus.EXPIRED, debug = true), actions) }
    }

    private val fallbackActions = object : WebFallbackActions {
        override fun reload() {}
        override fun clearData() {}
        override fun openInBrowser() {}
        override fun sendDiagnostics() {}
        override fun updateWebView(pkg: String) {}
    }

    private val errors = listOf(
        "20:41:03 JS: Uncaught SyntaxError: Unexpected token '?.' (assets/index-D-oRyKG2.js:1)",
        "20:41:03 Laden: net::ERR_TOO_MANY_RETRIES https://crm.example.com/assets/app-Dh471pur.js",
        "20:41:09 Prüfung: Seite leer – die Web-App ist nicht gestartet (complete)",
    )

    @Test fun webFallback() {
        val info = FallbackInfo(LoadState.EMPTY, FallbackInfo.reasonFor(LoadState.EMPTY), errors, WebViewInfo("com.google.android.webview", "129.0.6668.100"), "https://crm.example.com/app")
        shot("70-web-fallback") { WebFallbackScreen(info, sending = false, actions = fallbackActions) }
    }

    @Test fun webFallbackOldWebViewDark() {
        val info = FallbackInfo(LoadState.EMPTY, FallbackInfo.reasonFor(LoadState.EMPTY), errors, WebViewInfo("com.google.android.webview", "74.0.3729.136"), "https://crm.example.com/app")
        shot("70-web-fallback-old-dark", dark = true) { WebFallbackScreen(info, sending = true, actions = fallbackActions) }
    }

    @Test fun settingsDiagnose() {
        val diag = DiagState(
            webView = "com.google.android.webview 74.0.3729.136",
            webViewTooOld = true,
            server = "https://crm.example.com",
            status = "Seite leer – die Web-App ist nicht gestartet · vor 2 Min.",
            statusFailed = true,
            errors = errors,
        )
        compose.setContent { GoHighTheme { SettingsScreen(settingsState().copy(diag = diag), actions) } }
        compose.waitForIdle()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("App zurücksetzen (Web-Daten)"))
        compose.waitForIdle()
        compose.onRoot().captureRoboImage(file("40-settings-diagnose"))
    }

    @Test fun widgetConfigKpi() {
        shot("41-config-kpi") {
            WidgetConfigScreen(WidgetKind.KPI, WidgetConfig(location = "loc_yoga", metric = KpiMetric.REVENUE_MONTH.key), demo.locations, true, {}, {}, {})
        }
    }

    @Test fun widgetConfigQuickDark() {
        shot("41-config-quick-dark", dark = true) {
            WidgetConfigScreen(WidgetKind.QUICK, WidgetConfig(actions = listOf("contact", "task", "voice", "inbox")), demo.locations, true, {}, {}, {})
        }
    }

    @Test fun quickTask() {
        shot("42-quick-task") { OverHome { TaskScreen("loc_maler", {}, initialTitle = "Angebot an Familie Braun schicken") } }
    }

    @Test fun quickContactDark() {
        shot("42-quick-contact-dark", dark = true) { OverHome { ContactScreen(null, {}) } }
    }

    @Test fun quickDeal() {
        shot("42-quick-deal") { OverHome { DealScreen(demo.deals().top[0], {}) } }
    }

    @Test fun quickAppointment() {
        shot("42-quick-appointment") { OverHome { AppointmentScreen(demo.appointments()[0], {}) } }
    }

    @Test fun quickCallBackDark() {
        val c = demo.calls()[0]
        shot("42-quick-callback-dark", dark = true) { OverHome { CallScreen(c.contactName!!, c.otherNumber, c.contactId, c.summary, c.locationId, {}) } }
    }

    @Test fun quickReply() {
        compose.setContent { GoHighTheme { OverHome { ReplyScreen("c1", "Lena Fischer", {}) } } }
        // The conversation loads on Dispatchers.IO (FakeBackend); let the main looper pick up the result.
        repeat(50) {
            if (compose.onAllNodesWithText("Super, dann passt Donnerstag um 9 Uhr! 👍").fetchSemanticsNodes().isNotEmpty()) return@repeat
            Thread.sleep(100)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            compose.waitForIdle()
        }
        compose.waitForIdle()
        compose.onRoot().captureRoboImage(file("42-quick-reply"))
    }

    /** A fake app screen as the report's screenshot. */
    private fun fakeScreen(): android.graphics.Bitmap {
        val b = android.graphics.Bitmap.createBitmap(360, 760, android.graphics.Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(b)
        c.drawColor(0xFFF8FAFC.toInt())
        val p = android.graphics.Paint()
        p.color = 0xFF2563EB.toInt(); c.drawRect(0f, 0f, 360f, 70f, p)
        p.color = 0xFFFFFFFF.toInt()
        for (i in 0..5) c.drawRoundRect(16f, 90f + i * 110f, 344f, 180f + i * 110f, 18f, 18f, p)
        p.color = 0xFFE2E8F0.toInt()
        for (i in 0..5) c.drawRoundRect(32f, 110f + i * 110f, 200f, 126f + i * 110f, 8f, 8f, p)
        return b
    }

    @Test fun reportForm() {
        val form = ReportForm(
            what = "Das Termine-Widget bleibt nach dem Neustart leer.",
            expected = "Die Termine von heute erscheinen.",
            severity = "hoch",
            screenshot = fakeScreen().asImageBitmap(),
            device = DeviceDiagnostics("Pixel 9", "Google", "15", 35, "1.0.1 (2)"),
            apiErrors = listOf(ApiErrorEntry("GET", "/api/mobile/appointments?location=all", 503, "Serverfehler (503)")),
            screen = "/app/dashboard",
        )
        shot("60-report-form") { ReportScaffold(ReportTab.REPORT, {}, {}) { ReportFormScreen(form, {}, {}, {}) } }
    }

    @Test fun reportMineDark() {
        shot("61-report-mine-dark", dark = true) { ReportScaffold(ReportTab.MINE, {}, {}) { MyReportsScreen(demo.bugReports(), null, System.currentTimeMillis(), {}, {}) } }
    }

    @Test fun reportWishes() {
        shot("62-report-wishes") { ReportScaffold(ReportTab.WISHES, {}, {}) { WishesScreen(demo.wishes(), null, "votes", {}, {}, {}, {}) } }
    }

    @Test fun reportFormDark() {
        shot("60-report-form-dark", dark = true) { ReportScaffold(ReportTab.REPORT, {}, {}) { ReportFormScreen(ReportForm(category = "wish", title = "Widget für offene Tickets", what = "Offene Tickets auf dem Homescreen", device = DeviceDiagnostics("Pixel 9", "Google", "15", 35, "1.0.1 (2)")), {}, {}, {}) } }
    }

    /** Launcher icon: adaptive icon under a circle and a rounded-square mask, plus the themed (monochrome) look. */
    @Test fun launcherIcon() {
        val d = ctx.resources.displayMetrics.density
        val size = (108 * d).toInt()
        val icon = ctx.getDrawable(org.gohigh.android.R.mipmap.ic_launcher) as android.graphics.drawable.AdaptiveIconDrawable
        val out = android.graphics.Bitmap.createBitmap(size * 3 + 80, size + 40, android.graphics.Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(out)
        c.drawColor(0xFFE2E8F0.toInt())
        fun layer(left: Float, clip: android.graphics.Path, themed: Boolean) {
            c.save()
            c.translate(left, 20f)
            c.clipPath(clip)
            if (themed) {
                c.drawColor(0xFF1E3A8A.toInt())
                icon.monochrome!!.apply { setBounds(0, 0, size, size); setTint(0xFFBFDBFE.toInt()); draw(c) }
            } else {
                icon.background.apply { setBounds(0, 0, size, size); draw(c) }
                icon.foreground.apply { setBounds(0, 0, size, size); draw(c) }
            }
            c.restore()
        }
        val inset = 18 * d // launchers show the inner 72dp of the 108dp layers
        val circle = android.graphics.Path().apply { addCircle(size / 2f, size / 2f, size / 2f - inset, android.graphics.Path.Direction.CW) }
        val squircle = android.graphics.Path().apply { addRoundRect(inset, inset, size - inset, size - inset, 22 * d, 22 * d, android.graphics.Path.Direction.CW) }
        layer(20f, circle, false)
        layer(40f + size, squircle, false)
        layer(60f + 2 * size, circle, true)
        Shots.save(out, "50-launcher-icon")
    }
}
