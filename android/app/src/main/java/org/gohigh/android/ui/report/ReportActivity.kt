package org.gohigh.android.ui.report

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import org.gohigh.android.AppGraph
import org.gohigh.android.api.BugReport
import org.gohigh.android.api.BugReportRequest
import org.gohigh.android.api.Wish
import org.gohigh.android.api.WishRequest
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.feedback.ScreenCapture
import org.gohigh.android.feedback.deviceDiagnostics
import org.gohigh.android.ui.main.MainActivity
import org.gohigh.android.ui.theme.GoHighTheme
import org.gohigh.android.util.DeepLinks
import kotlinx.coroutines.launch
import java.io.File

/**
 * „Fehler & Wünsche“ in the app: report a bug (with a screenshot of the screen it was started from,
 * device info and the last failed API calls – all visible and removable), „Meine Meldungen“ and a simple
 * wish list (vote, submit). Details open in the web app (/app/feedback/<id>, /app/wishes/<id>).
 */
class ReportActivity : ComponentActivity() {
    private val g by lazy { AppGraph.get(this) }
    private var tab by mutableStateOf(ReportTab.REPORT)
    private var form by mutableStateOf(ReportForm())
    private var screenshotFile: File? = null
    private var mine by mutableStateOf<List<BugReport>?>(null)
    private var mineError by mutableStateOf<String?>(null)
    private var wishes by mutableStateOf<List<Wish>?>(null)
    private var wishesError by mutableStateOf<String?>(null)
    private var sort by mutableStateOf("votes")
    private var sent by mutableStateOf<BugReport?>(null)
    private var newWish by mutableStateOf(false)

    private val picker = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri != null) lifecycleScope.launch { setScreenshot(ScreenCapture.fromUri(this@ReportActivity, uri)) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        tab = ReportTab.of(intent.getStringExtra(EXTRA_TAB))
        form = ReportForm(
            category = intent.getStringExtra(EXTRA_CATEGORY) ?: "bug",
            device = deviceDiagnostics(),
            apiErrors = g.apiErrors.snapshot(),
            screen = intent.getStringExtra(EXTRA_SCREEN),
        )
        intent.getStringExtra(EXTRA_SCREENSHOT)?.let { setScreenshot(File(it)) }
        setContent {
            val auth by g.session.status.collectAsState()
            GoHighTheme(dynamic = g.settings.dynamicColor) {
                ReportScaffold(tab, ::selectTab, ::finish) {
                    if (auth != AuthStatus.ACTIVE) SignInHint() else when (tab) {
                        ReportTab.REPORT -> ReportFormScreen(form, { form = it }, { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, ::send)
                        ReportTab.MINE -> MyReportsScreen(mine, mineError, System.currentTimeMillis(), ::openReport) { selectTab(ReportTab.REPORT) }
                        ReportTab.WISHES -> WishesScreen(wishes, wishesError, sort, { sort = it; loadWishes() }, ::vote, ::openWish) { newWish = true }
                    }
                }
                sent?.let { r -> SentDialog(r, { sent = null; selectTab(if (r.kind == "wish") ReportTab.WISHES else ReportTab.MINE) }, { sent = null; finish() }) }
                if (newWish) NewWishDialog({ newWish = false }) { title, what, area -> submitWish(title, what, area) }
            }
        }
        selectTab(tab)
    }

    private fun setScreenshot(file: File?) {
        if (file == null || !file.isFile) return
        screenshotFile = file
        val bmp = runCatching { BitmapFactory.decodeFile(file.path) }.getOrNull() ?: return
        form = form.copy(screenshot = bmp.asImageBitmap(), includeScreenshot = true)
    }

    private fun selectTab(t: ReportTab) {
        tab = t
        if (g.session.status.value != AuthStatus.ACTIVE) return
        when (t) {
            ReportTab.MINE -> loadMine()
            ReportTab.WISHES -> loadWishes()
            ReportTab.REPORT -> Unit
        }
    }

    private fun loadMine() = lifecycleScope.launch {
        mineError = null
        runCatching { g.api.bugReports() }.onSuccess { mine = it }.onFailure { mineError = it.message; mine = mine ?: emptyList() }
    }

    private fun loadWishes() = lifecycleScope.launch {
        wishesError = null
        runCatching { g.api.wishes(sort) }.onSuccess { wishes = it }.onFailure { wishesError = it.message; wishes = wishes ?: emptyList() }
    }

    private fun send() {
        val f = form
        if (!f.canSend) return
        form = f.copy(sending = true, error = null)
        lifecycleScope.launch {
            val shot = if (f.includeScreenshot) screenshotFile?.let { ScreenCapture.dataUrl(it) } else null
            val location = g.settings.defaultLocation ?: g.repository.me()?.locations?.singleOrNull()?.id
            try {
                val r = if (f.category == "wish") {
                    val w = g.api.createWish(WishRequest(title = f.title.trim(), what = f.what.trim(), area = f.area, screenshot = shot, locationId = location)).wish
                    BugReport(id = w.id, kind = "wish", number = w.number, title = w.title, status = w.status)
                } else {
                    val none = !f.includeDevice && (!f.includeApiErrors || f.apiErrors.isEmpty()) && f.screen.isNullOrBlank()
                    g.api.createBugReport(
                        BugReportRequest(
                            category = f.category,
                            what = f.what.trim(),
                            expected = f.expected.trim().ifBlank { null },
                            steps = f.steps.trim().ifBlank { null },
                            severity = f.severity,
                            locationId = location,
                            screen = f.screen,
                            screenshot = shot,
                            device = if (f.includeDevice) f.device else null,
                            apiErrors = if (f.includeApiErrors) f.apiErrors else null,
                            appVersion = if (f.includeDevice) f.device.appVersion else null,
                            diagnostics = if (none) false else null,
                        ),
                    )
                }
                form = ReportForm(device = f.device, apiErrors = g.apiErrors.snapshot())
                screenshotFile = null
                sent = r
            } catch (e: Exception) {
                form = f.copy(sending = false, error = e.message ?: "Senden fehlgeschlagen")
            }
        }
    }

    private fun vote(w: Wish) = lifecycleScope.launch {
        runCatching { g.api.vote(w.id, !w.myVote) }
            .onSuccess { r -> wishes = wishes?.map { if (it.id == w.id) it.copy(votes = r.votes, myVote = r.myVote) else it } }
            .onFailure { Toast.makeText(this@ReportActivity, it.message ?: "Fehler", Toast.LENGTH_SHORT).show() }
    }

    private fun submitWish(title: String, what: String, area: String) {
        newWish = false
        lifecycleScope.launch {
            runCatching { g.api.createWish(WishRequest(title.trim(), what.trim(), area, locationId = g.settings.defaultLocation)) }
                .onSuccess { Toast.makeText(this@ReportActivity, "Wunsch eingereicht", Toast.LENGTH_SHORT).show(); loadWishes() }
                .onFailure { Toast.makeText(this@ReportActivity, it.message ?: "Fehler", Toast.LENGTH_LONG).show() }
        }
    }

    private fun openWeb(path: String) {
        startActivity(Intent(Intent.ACTION_VIEW, DeepLinks.app(g.settings.baseUrl, path).toUri(), this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }

    private fun openReport(r: BugReport) = openWeb(r.url ?: "/app/feedback/${r.id}")

    private fun openWish(w: Wish) = openWeb("/app/wishes/${w.id}")

    @androidx.compose.runtime.Composable
    private fun SignInHint() {
        Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Text("Bitte zuerst in HyperLevel anmelden – dann kannst du Fehler melden und abstimmen.", textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
            Button(onClick = { startActivity(Intent(this@ReportActivity, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN)); finish() }) { Text("Anmelden") }
        }
    }

    companion object {
        const val EXTRA_TAB = "tab"
        const val EXTRA_SCREENSHOT = "screenshot"
        const val EXTRA_SCREEN = "screen"
        const val EXTRA_CATEGORY = "category"
        const val ACTION_REPORT = "org.gohigh.android.REPORT"

        fun intent(context: Context, tab: ReportTab = ReportTab.REPORT, screenshot: File? = null, screen: String? = null): Intent =
            Intent(context, ReportActivity::class.java)
                .setAction(ACTION_REPORT)
                .putExtra(EXTRA_TAB, tab.key)
                .putExtra(EXTRA_SCREENSHOT, screenshot?.path)
                .putExtra(EXTRA_SCREEN, screen)
    }
}
