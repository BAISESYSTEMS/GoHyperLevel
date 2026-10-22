package org.gohigh.android.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.api.ALL_LOCATIONS
import org.gohigh.android.api.Appointment
import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.CallItem
import org.gohigh.android.api.Deal
import org.gohigh.android.api.DemoData
import org.gohigh.android.api.LocationInfo
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.DataRequest
import org.gohigh.android.ui.config.WidgetConfigActivity
import org.gohigh.android.ui.main.MainActivity
import org.gohigh.android.ui.quick.QuickActivity
import org.gohigh.android.work.WorkScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/** Common responsive breakpoints (classic launcher cell formula 70·n − 30 dp). */
object Sizes {
    val S1x1 = DpSize(40.dp, 40.dp)
    val S2x1 = DpSize(110.dp, 40.dp)
    val S2x2 = DpSize(110.dp, 110.dp)
    val S3x2 = DpSize(180.dp, 110.dp)
    val S3x3 = DpSize(180.dp, 180.dp)
    val S4x1 = DpSize(250.dp, 40.dp)
    val S4x2 = DpSize(250.dp, 110.dp)
    val S4x3 = DpSize(250.dp, 180.dp)
    val S4x4 = DpSize(250.dp, 250.dp)
    val S5x3 = DpSize(320.dp, 180.dp)
    val S5x4 = DpSize(320.dp, 250.dp)
}

/** Everything a widget needs besides its data. */
data class WidgetEnv(
    val kind: WidgetKind,
    val appWidgetId: Int,
    val config: WidgetConfig,
    val auth: AuthStatus,
    val now: Long,
    val base: String,
    val locations: List<LocationInfo>,
    val demo: Boolean,
    val preview: Boolean = false,
) {
    val loc: String get() = config.location

    /** Show the project name on items when the widget covers several projects. */
    val showLocation: Boolean get() = loc == ALL_LOCATIONS && locations.size != 1

    val locationName: String? get() = locations.firstOrNull { it.id == loc }?.name

    /** Location for creating things: the widget's project, else the default/only one. */
    fun createLocation(default: String?): String? = when {
        loc != ALL_LOCATIONS -> loc
        locations.size == 1 -> locations[0].id
        else -> default
    }

    companion object {
        fun build(context: Context, g: AppGraph, kind: WidgetKind, appWidgetId: Int) = WidgetEnv(
            kind = kind,
            appWidgetId = appWidgetId,
            config = g.widgetConfigs.get(appWidgetId),
            auth = g.session.status.value,
            now = g.clock(),
            base = g.settings.baseUrl,
            locations = g.repository.me()?.locations.orEmpty(),
            demo = g.settings.demoMode,
        )

        fun preview(kind: WidgetKind, config: WidgetConfig = WidgetConfig(), now: Long = System.currentTimeMillis(), base: String = "https://crm.example.com") =
            WidgetEnv(kind, 0, config, AuthStatus.ACTIVE, now, base, DemoData(now).locations, demo = false, preview = true)
    }
}

/**
 * Base class: renders instantly from the disk cache and recomposes whenever the repository revision
 * changes while the Glance session is alive. [demo] provides the widget-picker preview (Android 15+).
 */
abstract class GoHighWidget<S>(val kind: WidgetKind) : GlanceAppWidget() {
    abstract val sizes: Set<DpSize>

    override val sizeMode: SizeMode get() = SizeMode.Responsive(sizes)

    override val previewSizeMode get() = SizeMode.Responsive(sizes)

    /** Reads cached data (called on a background thread). */
    abstract fun load(context: Context, g: AppGraph, env: WidgetEnv): S

    /** Sample data for previews and screenshots. */
    abstract fun demo(env: WidgetEnv, d: DemoData): S

    @Composable
    abstract fun Content(env: WidgetEnv, state: S)

    data class Snapshot<S>(val env: WidgetEnv, val state: S)

    private fun snapshot(context: Context, g: AppGraph, id: Int): Snapshot<S> {
        val env = WidgetEnv.build(context, g, kind, id)
        return Snapshot(env, load(context, g, env))
    }

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val g = AppGraph.get(context)
        val appWidgetId = runCatching { GlanceAppWidgetManager(context).getAppWidgetId(id) }.getOrDefault(0)
        val initial = withContext(Dispatchers.IO) { snapshot(context, g, appWidgetId) }
        provideContent {
            val flow = remember { g.repository.revision.map { snapshot(context, g, appWidgetId) }.flowOn(Dispatchers.IO) }
            val snap by flow.collectAsState(initial)
            org.gohigh.android.widget.ui.WidgetTheme { Content(snap.env, snap.state) }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        val env = WidgetEnv.preview(kind)
        val state = demo(env, DemoData(env.now))
        provideContent { org.gohigh.android.widget.ui.WidgetTheme { Content(env, state) } }
    }
}

enum class WidgetKind(val title: String, val description: String, val icon: Int, val supportsLocation: Boolean) {
    COCKPIT("Cockpit", "Leads, Deals, Umsatz, Ungelesen und Aufgaben", R.drawable.ic_speed, true),
    INBOX("Posteingang", "Neueste Nachrichten mit Direkt-Antwort", R.drawable.ic_inbox, true),
    TASKS("Aufgaben", "Heute und überfällig – direkt abhaken", R.drawable.ic_task_alt, true),
    APPOINTMENTS("Termine", "Termine von heute und morgen", R.drawable.ic_event, true),
    PIPELINE("Pipeline", "Phasen und Top-Deals", R.drawable.ic_view_kanban, true),
    PROJECTS("Projekte", "Alle Projekte mit Website-Status", R.drawable.ic_grid_view, false),
    QUICK("Schnellaktionen", "Kontakt, Aufgabe, Notiz, Anruf …", R.drawable.ic_bolt, true),
    REVENUE("Umsatz", "Heute, Monat, offene Rechnungen", R.drawable.ic_euro, true),
    CALLS("Anrufe", "Verpasste Anrufe mit Rückruf", R.drawable.ic_phone_missed, true),
    REVIEWS("Bewertungen", "Sterne, Anzahl und neueste Bewertung", R.drawable.ic_star, true),
    VOICE("Sprach-Notiz", "Sprechen – wird Aufgabe oder Notiz", R.drawable.ic_mic, true),
    KPI("Zahl", "Eine Kennzahl mit Trend", R.drawable.ic_monitoring, true),
    SOCIAL("Social", "Nächste geplante Beiträge", R.drawable.ic_campaign, true);

    fun widget(): GoHighWidget<*> = when (this) {
        COCKPIT -> CockpitWidget()
        INBOX -> InboxWidget()
        TASKS -> TasksWidget()
        APPOINTMENTS -> AppointmentsWidget()
        PIPELINE -> PipelineWidget()
        PROJECTS -> ProjectsWidget()
        QUICK -> QuickActionsWidget()
        REVENUE -> RevenueWidget()
        CALLS -> CallsWidget()
        REVIEWS -> ReviewsWidget()
        VOICE -> VoiceWidget()
        KPI -> KpiWidget()
        SOCIAL -> SocialWidget()
    }

    val receiver: Class<out GlanceAppWidgetReceiver>
        get() = when (this) {
            COCKPIT -> CockpitReceiver::class.java
            INBOX -> InboxReceiver::class.java
            TASKS -> TasksReceiver::class.java
            APPOINTMENTS -> AppointmentsReceiver::class.java
            PIPELINE -> PipelineReceiver::class.java
            PROJECTS -> ProjectsReceiver::class.java
            QUICK -> QuickReceiver::class.java
            REVENUE -> RevenueReceiver::class.java
            CALLS -> CallsReceiver::class.java
            REVIEWS -> ReviewsReceiver::class.java
            VOICE -> VoiceReceiver::class.java
            KPI -> KpiReceiver::class.java
            SOCIAL -> SocialReceiver::class.java
        }

    companion object {
        fun ofReceiver(className: String?): WidgetKind? = entries.firstOrNull { it.receiver.name == className }

        fun ofAppWidget(context: Context, appWidgetId: Int): WidgetKind? =
            ofReceiver(AppWidgetManager.getInstance(context).getAppWidgetInfo(appWidgetId)?.provider?.className)
    }
}

/** Receiver base: schedules background refresh when the first widget is placed, cleans config on delete. */
abstract class GoHighReceiver(private val kind: WidgetKind) : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget get() = kind.widget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        val g = AppGraph.get(context)
        WorkScheduler.schedulePeriodic(context, g.settings.refreshMinutes)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        val store = AppGraph.get(context).widgetConfigs
        appWidgetIds.forEach { store.remove(it) }
    }
}

class CockpitReceiver : GoHighReceiver(WidgetKind.COCKPIT)
class InboxReceiver : GoHighReceiver(WidgetKind.INBOX)
class TasksReceiver : GoHighReceiver(WidgetKind.TASKS)
class AppointmentsReceiver : GoHighReceiver(WidgetKind.APPOINTMENTS)
class PipelineReceiver : GoHighReceiver(WidgetKind.PIPELINE)
class ProjectsReceiver : GoHighReceiver(WidgetKind.PROJECTS)
class QuickReceiver : GoHighReceiver(WidgetKind.QUICK)
class RevenueReceiver : GoHighReceiver(WidgetKind.REVENUE)
class CallsReceiver : GoHighReceiver(WidgetKind.CALLS)
class ReviewsReceiver : GoHighReceiver(WidgetKind.REVIEWS)
class VoiceReceiver : GoHighReceiver(WidgetKind.VOICE)
class KpiReceiver : GoHighReceiver(WidgetKind.KPI)
class SocialReceiver : GoHighReceiver(WidgetKind.SOCIAL)

/** Re-render all widgets and collect what they need. */
object WidgetUpdater {
    suspend fun updateAll(context: Context) {
        AppGraph.get(context).repository.bump()
        for (kind in WidgetKind.entries) {
            try {
                kind.widget().updateAll(context)
            } catch (e: Exception) {
                Log.w("GoHighWidget", "update ${kind.name} failed", e)
            }
        }
    }

    suspend fun placed(context: Context): List<Pair<WidgetKind, Int>> {
        val mgr = GlanceAppWidgetManager(context)
        return WidgetKind.entries.flatMap { kind ->
            runCatching { mgr.getGlanceIds(kind.widget().javaClass).map { kind to mgr.getAppWidgetId(it) } }.getOrDefault(emptyList())
        }
    }

    suspend fun requirements(context: Context): Set<DataRequest<*>> {
        val store = AppGraph.get(context).widgetConfigs
        return placed(context).flatMap { (kind, id) -> kind.requests(store.get(id)) }.toSet()
    }

    /** Android 15+: generated previews in the widget picker (rate limited by the system; best effort). */
    suspend fun publishPreviews(context: Context) {
        if (Build.VERSION.SDK_INT < 35) return
        val mgr = GlanceAppWidgetManager(context)
        for (kind in WidgetKind.entries) {
            runCatching { mgr.setWidgetPreviews(kind.receiver.kotlin) }
        }
    }
}

/** Widget button: refresh now. */
class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WorkScheduler.refreshNow(context)
    }
}

/** Widget checkbox: complete/reopen a task. Updates the cache at once, then syncs in the background. */
class ToggleTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[TASK_ID] ?: return
        val done = parameters[TASK_DONE] ?: true
        val g = AppGraph.get(context)
        g.repository.setTaskDoneLocally(id, done)
        WorkScheduler.completeTask(context, id, done)
    }

    companion object {
        val TASK_ID = ActionParameters.Key<String>("task_id")
        val TASK_DONE = ActionParameters.Key<Boolean>("task_done")
    }
}

/** Intents used by widget taps. Each gets unique data so PendingIntents never overwrite each other. */
object Launch {
    fun web(context: Context, url: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(url), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    fun signIn(context: Context): Intent =
        Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun configure(context: Context, appWidgetId: Int): Intent =
        Intent(context, WidgetConfigActivity::class.java)
            .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
            .setData(Uri.parse("gohigh://configure/$appWidgetId"))
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun quick(context: Context, action: String, location: String? = null, unique: String = action, extras: Map<String, String?> = emptyMap()): Intent =
        Intent(context, QuickActivity::class.java)
            .setAction(QuickActivity.PREFIX + action)
            .setData(Uri.parse("gohigh://quick/$action/${Uri.encode(unique)}"))
            .putExtra(QuickActivity.EXTRA_LOCATION, location)
            .apply { extras.forEach { (k, v) -> if (v != null) putExtra(k, v) } }
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)

    fun reply(context: Context, conversationId: String, contactName: String, location: String?) =
        quick(context, QuickActivity.REPLY, location, conversationId, mapOf(QuickActivity.EXTRA_ID to conversationId, QuickActivity.EXTRA_TITLE to contactName))

    fun deal(context: Context, deal: Deal) =
        quick(context, QuickActivity.DEAL, deal.locationId, deal.id, mapOf(QuickActivity.EXTRA_JSON to ApiJson.encodeToString(Deal.serializer(), deal)))

    fun appointment(context: Context, a: Appointment) =
        quick(context, QuickActivity.APPOINTMENT, a.locationId, a.id, mapOf(QuickActivity.EXTRA_JSON to ApiJson.encodeToString(Appointment.serializer(), a)))

    fun callBack(context: Context, c: CallItem) =
        quick(context, QuickActivity.CALLBACK, c.locationId, c.id, mapOf(QuickActivity.EXTRA_JSON to ApiJson.encodeToString(CallItem.serializer(), c)))

    fun component(context: Context, cls: Class<*>) = ComponentName(context, cls)
}
