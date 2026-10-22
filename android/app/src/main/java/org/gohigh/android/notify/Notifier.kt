package org.gohigh.android.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.gohigh.android.R
import org.gohigh.android.api.FeedEvent
import org.gohigh.android.data.AppSettings
import org.gohigh.android.data.NotifyCategory
import org.gohigh.android.ui.main.MainActivity
import org.gohigh.android.util.DeepLinks

/** Local notifications (no Firebase): one channel per category plus updates and background sync. */
class Notifier(private val context: Context, private val settings: AppSettings) {
    private val nm = NotificationManagerCompat.from(context)

    fun createChannels() {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channels = NotifyCategory.entries.map { c ->
            val importance = when (c) {
                NotifyCategory.MESSAGES, NotifyCategory.CALLS, NotifyCategory.LEADS, NotifyCategory.WEBSITES -> NotificationManager.IMPORTANCE_HIGH
                else -> NotificationManager.IMPORTANCE_DEFAULT
            }
            NotificationChannel(c.channelId, c.label, importance).apply { description = channelDescription(c) }
        } + listOf(
            NotificationChannel(CH_UPDATES, "App-Updates", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Neue Version von HyperLevel verfügbar" },
            NotificationChannel(CH_SYNC, "Synchronisierung", NotificationManager.IMPORTANCE_MIN).apply { description = "Kurz sichtbar, während Widgets aktualisiert werden" },
        )
        manager.createNotificationChannels(channels)
    }

    private fun channelDescription(c: NotifyCategory) = when (c) {
        NotifyCategory.MESSAGES -> "Neue Nachrichten im Posteingang"
        NotifyCategory.CHAT -> "Direktnachrichten und Erwähnungen im Team-Chat"
        NotifyCategory.CALLS -> "Verpasste Anrufe"
        NotifyCategory.LEADS -> "Neue Leads"
        NotifyCategory.PAYMENTS -> "Eingegangene Zahlungen"
        NotifyCategory.WEBSITES -> "Website offline oder wieder online"
        NotifyCategory.TASKS -> "Fällige Aufgaben"
        NotifyCategory.REVIEWS -> "Neue Bewertungen"
        NotifyCategory.FEEDBACK -> "Antworten und Status deiner Fehlermeldungen und Wünsche"
    }

    fun canPost(): Boolean =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun postFeedEvent(event: FeedEvent, category: NotifyCategory) {
        if (!canPost()) return
        val url = DeepLinks.resolve(settings.baseUrl, event.deepLink)
        val n = NotificationCompat.Builder(context, category.channelId)
            .setSmallIcon(R.drawable.ic_logo_mark)
            .setColor(0xFF2563EB.toInt())
            .setContentTitle(event.title.ifBlank { category.label })
            .setContentText(event.body.orEmpty())
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.body.orEmpty()))
            .setSubText(event.locationName)
            .setAutoCancel(true)
            .setGroup("gohigh_${category.key}")
            .setCategory(if (category == NotifyCategory.MESSAGES) Notification.CATEGORY_MESSAGE else Notification.CATEGORY_EVENT)
            .setContentIntent(openUrl(url, event.id.hashCode()))
            .build()
        notify(NOTIFY_BASE + (event.id.hashCode() and 0xffffff), n)
    }

    fun postUpdateAvailable(versionName: String) {
        if (!canPost()) return
        val n = NotificationCompat.Builder(context, CH_UPDATES)
            .setSmallIcon(R.drawable.ic_logo_mark)
            .setColor(0xFF2563EB.toInt())
            .setContentTitle("Update verfügbar")
            .setContentText("HyperLevel $versionName ist bereit. Tippen zum Installieren.")
            .setAutoCancel(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    context, 7001,
                    Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_CHECK_UPDATE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .build()
        notify(ID_UPDATE, n)
    }

    fun syncNotification(): Notification = NotificationCompat.Builder(context, CH_SYNC)
        .setSmallIcon(R.drawable.ic_logo_mark)
        .setContentTitle("HyperLevel aktualisiert…")
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setOngoing(true)
        .build()

    private fun openUrl(url: String, requestCode: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    @android.annotation.SuppressLint("MissingPermission") // checked in canPost()
    private fun notify(id: Int, n: Notification) {
        if (canPost()) nm.notify(id, n)
    }

    companion object {
        const val CH_UPDATES = "updates"
        const val CH_SYNC = "sync"
        const val ID_UPDATE = 9001
        const val ID_SYNC = 9002
        private const val NOTIFY_BASE = 100_000
    }
}
