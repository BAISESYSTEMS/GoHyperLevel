package org.gohigh.android.update

import android.app.Activity
import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import org.gohigh.android.AppGraph
import org.gohigh.android.BuildConfig
import org.gohigh.android.R
import org.gohigh.android.api.AppRelease
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** State + flow for the update dialog, shared by the main screen and the settings. */
class UpdateController(private val activity: Activity, private val scope: CoroutineScope) {
    private val g = AppGraph.get(activity)
    var release by mutableStateOf<AppRelease?>(null)
        private set
    var progress by mutableStateOf<Float?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var checking by mutableStateOf(false)
        private set
    private var job: Job? = null
    private var waitingForPermission = false

    val forced: Boolean get() = release?.let { g.updater.isForced(it) } ?: false

    /** [manual]: from settings – always shows a result. Otherwise only once per version. */
    fun check(manual: Boolean) {
        if (checking) return
        checking = true
        scope.launch {
            try {
                val r = g.updater.check()
                when {
                    r == null -> if (manual) toast("Du hast die neueste Version (${BuildConfig.VERSION_NAME})")
                    manual || g.updater.isForced(r) || g.settings.lastUpdatePromptCode < r.versionCode -> release = r
                }
            } catch (e: Exception) {
                if (manual) toast(e.message ?: "Prüfung fehlgeschlagen")
            } finally {
                checking = false
            }
        }
    }

    fun later() {
        release?.let { g.settings.lastUpdatePromptCode = it.versionCode }
        job?.cancel()
        progress = null
        error = null
        release = null
    }

    fun install() {
        val r = release ?: return
        if (!g.updater.canInstall()) {
            waitingForPermission = true
            toast("Bitte \"Apps aus dieser Quelle zulassen\" einschalten und zurückkehren")
            activity.startActivity(g.updater.installPermissionIntent())
            return
        }
        if (job?.isActive == true) return
        error = null
        progress = 0f
        job = scope.launch {
            try {
                val apk = g.updater.download(r) { progress = it }
                progress = 1f
                activity.startActivity(g.updater.installIntent(apk))
            } catch (e: Exception) {
                error = e.message ?: "Download fehlgeschlagen"
                progress = null
            }
        }
    }

    /** Call from onResume: continue after the user granted "install unknown apps". */
    fun onResume() {
        if (waitingForPermission && g.updater.canInstall()) {
            waitingForPermission = false
            install()
        }
    }

    private fun toast(msg: String) = Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
}

@Composable
fun UpdateDialog(c: UpdateController) {
    val r = c.release ?: return
    AlertDialog(
        onDismissRequest = { if (!c.forced && c.progress == null) c.later() },
        icon = { Icon(painterResource(R.drawable.ic_update), contentDescription = null) },
        title = { Text(if (c.forced) "Update erforderlich" else "Update verfügbar") },
        text = {
            Column {
                Text("HyperLevel ${r.versionName} ist da." + (VersionCheck.sizeLabel(r.size)?.let { " ($it)" } ?: ""), style = MaterialTheme.typography.bodyLarge)
                if (!r.changelog.isNullOrBlank()) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        r.changelog,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.heightIn(max = 220.dp).verticalScroll(rememberScrollState()),
                    )
                }
                if (c.forced) {
                    Spacer(Modifier.height(10.dp))
                    Text("Diese Version wird nicht mehr unterstützt.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                c.progress?.let {
                    Spacer(Modifier.height(14.dp))
                    LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(4.dp))
                    Text(if (it >= 1f) "Prüfsumme ok – Installation startet…" else "Wird geladen… ${(it * 100).toInt()} %", style = MaterialTheme.typography.bodySmall)
                }
                c.error?.let {
                    Spacer(Modifier.height(10.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            Button(onClick = { c.install() }, enabled = c.progress == null || c.progress == 1f) {
                Text(if (c.error != null) "Erneut versuchen" else "Installieren")
            }
        },
        dismissButton = {
            if (!c.forced) TextButton(onClick = { c.later() }) { Text("Später") }
        },
    )
}
