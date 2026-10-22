package org.gohigh.android

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.edit
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.work.Configuration
import android.util.Log
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.feedback.CrashReporter
import org.gohigh.android.ui.report.ReportActivity
import org.gohigh.android.ui.main.MainActivity
import org.gohigh.android.ui.quick.QuickActivity
import org.gohigh.android.util.DeepLinks
import org.gohigh.android.widget.Launch
import org.gohigh.android.widget.WidgetUpdater
import org.gohigh.android.work.WorkScheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** WorkManager is initialised on demand with this configuration (default initializer removed in the manifest). */
class GoHighApp : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setMinimumLoggingLevel(Log.INFO).build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        CrashReporter.install(this)
        val g = AppGraph.get(this)
        g.notifier.createChannels()
        if (g.session.status.value == AuthStatus.ACTIVE) WorkScheduler.schedulePeriodic(this, g.settings.refreshMinutes)
        publishShortcuts()
        // A crash from the last run goes to the team (if the user allowed automatic error reports).
        scope.launch { runCatching { CrashReporter.sendPending(this@GoHighApp, g) } }
        scope.launch {
            // Generated widget-picker previews (Android 15+), once per app version.
            val prefs = getSharedPreferences("gohigh_meta", Context.MODE_PRIVATE)
            if (prefs.getInt("previews_for", 0) != BuildConfig.VERSION_CODE) {
                WidgetUpdater.publishPreviews(this@GoHighApp)
                prefs.edit { putInt("previews_for", BuildConfig.VERSION_CODE) }
            }
        }
    }

    /** Long-press shortcuts on the launcher icon. */
    private fun publishShortcuts() {
        fun shortcut(id: String, label: String, icon: Int, intent: Intent) =
            ShortcutInfoCompat.Builder(this, id).setShortLabel(label).setIcon(IconCompat.createWithResource(this, icon)).setIntent(intent).build()
        val base = AppGraph.get(this).settings.baseUrl
        val list = listOf(
            shortcut("task", getString(R.string.shortcut_task), R.drawable.ic_shortcut_task, Launch.quick(this, QuickActivity.TASK, unique = "shortcut")),
            shortcut("voice", getString(R.string.shortcut_voice), R.drawable.ic_shortcut_voice, Launch.quick(this, QuickActivity.VOICE, unique = "shortcut")),
            shortcut("contact", getString(R.string.shortcut_contact), R.drawable.ic_shortcut_contact, Launch.quick(this, QuickActivity.CONTACT, unique = "shortcut")),
            shortcut("report", getString(R.string.shortcut_report), R.drawable.ic_shortcut_bug, ReportActivity.intent(this).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)),
            shortcut(
                "inbox", getString(R.string.shortcut_inbox), R.drawable.ic_shortcut_inbox,
                Intent(Intent.ACTION_VIEW, Uri.parse(DeepLinks.conversations(base)), this, MainActivity::class.java),
            ),
        )
        runCatching {
            ShortcutManagerCompat.setDynamicShortcuts(this, list.take(ShortcutManagerCompat.getMaxShortcutCountPerActivity(this).coerceAtMost(5)))
        }
    }
}
