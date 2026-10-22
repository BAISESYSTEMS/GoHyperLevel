package org.gohigh.android.work

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.gohigh.android.AppGraph
import org.gohigh.android.api.ApiException
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.DataRequest
import org.gohigh.android.notify.FeedPoller
import org.gohigh.android.notify.Notifier
import org.gohigh.android.update.VersionCheck
import org.gohigh.android.BuildConfig
import org.gohigh.android.widget.WidgetUpdater
import java.util.concurrent.TimeUnit

/** Schedules background refreshes (periodic + on demand). */
object WorkScheduler {
    private const val PERIODIC = "gohigh_refresh_periodic"
    private const val NOW = "gohigh_refresh_now"

    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(context: Context, minutes: Int, replace: Boolean = false) {
        val req = PeriodicWorkRequestBuilder<RefreshWorker>(minutes.coerceAtLeast(15).toLong(), TimeUnit.MINUTES)
            .setConstraints(network)
            .setInputData(workDataOf(RefreshWorker.KEY_FEED to true))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC,
            if (replace) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            req,
        )
    }

    fun cancelAll(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(NOW)
    }

    /** Refresh right away (app opened, widget refresh button, after an action). */
    fun refreshNow(context: Context, feed: Boolean = false) {
        val req = OneTimeWorkRequestBuilder<RefreshWorker>()
            .setConstraints(network)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setInputData(workDataOf(RefreshWorker.KEY_FEED to feed))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, req)
    }

    fun completeTask(context: Context, taskId: String, done: Boolean) {
        val req = OneTimeWorkRequestBuilder<TaskActionWorker>()
            .setConstraints(network)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setInputData(workDataOf(TaskActionWorker.KEY_ID to taskId, TaskActionWorker.KEY_DONE to done))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("task_$taskId", ExistingWorkPolicy.REPLACE, req)
    }
}

/** Shared foreground info for expedited work on Android < 12. */
private fun syncForegroundInfo(context: Context): ForegroundInfo {
    val n = AppGraph.get(context).notifier.syncNotification()
    return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(Notifier.ID_SYNC, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else ForegroundInfo(Notifier.ID_SYNC, n)
}

/**
 * Refreshes everything the placed widgets need, polls the notification feed and checks for app updates
 * once a day, then re-renders all widgets.
 */
class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun getForegroundInfo(): ForegroundInfo = syncForegroundInfo(applicationContext)

    override suspend fun doWork(): Result {
        val g = AppGraph.get(applicationContext)
        if (g.session.status.value != AuthStatus.ACTIVE) {
            WidgetUpdater.updateAll(applicationContext)
            return Result.success()
        }
        val requests = WidgetUpdater.requirements(applicationContext).toMutableSet<DataRequest<*>>()
        val me = g.repository.cached(DataRequest.Me)
        if (me == null || g.clock() - me.fetchedAt > 6 * 3600_000L) requests += DataRequest.Me
        val result = g.repository.refreshAll(requests)
        if (!result.unauthorized && inputData.getBoolean(KEY_FEED, false)) {
            runCatching {
                FeedPoller(g.settings, { g.api.feed(it) }, g.notifier::postFeedEvent).poll()
            }
            checkUpdateDaily(g)
        }
        WidgetUpdater.updateAll(applicationContext)
        return Result.success()
    }

    private suspend fun checkUpdateDaily(g: AppGraph) {
        if (g.settings.demoMode || g.clock() - g.settings.lastUpdateCheck < 20 * 3600_000L) return
        val r = runCatching { g.updater.check() }.getOrNull() ?: return
        if (VersionCheck.isNewer(r, BuildConfig.VERSION_CODE) && g.settings.lastUpdatePromptCode < r.versionCode) {
            g.notifier.postUpdateAvailable(r.versionName)
        }
    }

    companion object {
        const val KEY_FEED = "feed"
    }
}

/** Sends a task check/uncheck made on the home screen; on failure the server state is re-fetched. */
class TaskActionWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun getForegroundInfo(): ForegroundInfo = syncForegroundInfo(applicationContext)

    override suspend fun doWork(): Result {
        val g = AppGraph.get(applicationContext)
        val id = inputData.getString(KEY_ID) ?: return Result.failure()
        val done = inputData.getBoolean(KEY_DONE, true)
        return try {
            if (done) g.api.completeTask(id) else g.api.reopenTask(id)
            refreshTasks(g)
            Result.success()
        } catch (e: ApiException.Network) {
            if (runAttemptCount < 3) Result.retry() else fail(g, e.message)
        } catch (e: ApiException) {
            fail(g, e.message)
        }
    }

    private suspend fun fail(g: AppGraph, message: String?): Result {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(applicationContext, "Aufgabe nicht gespeichert: ${message ?: "Fehler"}", Toast.LENGTH_LONG).show()
        }
        refreshTasks(g)
        return Result.failure()
    }

    private suspend fun refreshTasks(g: AppGraph) {
        val reqs = WidgetUpdater.requirements(applicationContext).filter { it is DataRequest.Tasks || it is DataRequest.SummaryOf }
        g.repository.refreshAll(reqs)
        WidgetUpdater.updateAll(applicationContext)
    }

    companion object {
        const val KEY_ID = "id"
        const val KEY_DONE = "done"
    }
}
