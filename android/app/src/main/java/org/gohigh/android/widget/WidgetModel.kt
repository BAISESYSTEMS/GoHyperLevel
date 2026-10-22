package org.gohigh.android.widget

import android.content.Context
import androidx.core.content.edit
import org.gohigh.android.R
import org.gohigh.android.api.ALL_LOCATIONS
import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.Summary
import org.gohigh.android.data.DataRequest
import org.gohigh.android.data.SummaryHistory
import org.gohigh.android.util.Fmt
import kotlinx.serialization.Serializable

/** Per-widget settings chosen in the configuration screen. One shape for all widget kinds. */
@Serializable
data class WidgetConfig(
    val location: String = ALL_LOCATIONS,
    val unreadOnly: Boolean = false,
    /** Aufgaben: "today_overdue", "week" or "open". */
    val taskFilter: String = "today_overdue",
    val missedOnly: Boolean = true,
    val metric: String = KpiMetric.LEADS_TODAY.key,
    val actions: List<String> = QuickAction.DEFAULTS.map { it.key },
)

/** Stores [WidgetConfig] by appWidgetId. */
class WidgetConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences("gohigh_widgets", Context.MODE_PRIVATE)

    fun get(appWidgetId: Int): WidgetConfig = prefs.getString("w_$appWidgetId", null)
        ?.let { runCatching { ApiJson.decodeFromString(WidgetConfig.serializer(), it) }.getOrNull() }
        ?: WidgetConfig()

    fun has(appWidgetId: Int): Boolean = prefs.contains("w_$appWidgetId")

    fun set(appWidgetId: Int, config: WidgetConfig) =
        prefs.edit(commit = true) { putString("w_$appWidgetId", ApiJson.encodeToString(WidgetConfig.serializer(), config)) }

    fun remove(appWidgetId: Int) = prefs.edit { remove("w_$appWidgetId") }
}

/** Buttons of the "Schnellaktionen" widget (and app shortcuts). */
enum class QuickAction(val key: String, val label: String, val icon: Int, val short: String = label) {
    CONTACT("contact", "Kontakt", R.drawable.ic_person_add),
    TASK("task", "Aufgabe", R.drawable.ic_task_alt),
    NOTE("note", "Notiz", R.drawable.ic_edit_note),
    CALL("call", "Anruf", R.drawable.ic_call),
    VOICE("voice", "Sprach-Notiz", R.drawable.ic_mic, "Sprache"),
    INVOICE("invoice", "Rechnung", R.drawable.ic_receipt_long),
    INBOX("inbox", "Posteingang", R.drawable.ic_inbox, "Eingang");

    companion object {
        val DEFAULTS = listOf(CONTACT, TASK, NOTE, VOICE, CALL, INVOICE, INBOX)
        fun of(key: String) = entries.firstOrNull { it.key == key }
    }
}

enum class TaskFilter(val key: String, val label: String) {
    TODAY_OVERDUE("today_overdue", "Heute & überfällig"),
    WEEK("week", "Diese Woche"),
    OPEN("open", "Alle offenen");

    companion object {
        fun of(key: String) = entries.firstOrNull { it.key == key } ?: TODAY_OVERDUE
    }
}

/** KPIs the "Zahl" widget can show. [higherIsBetter] decides the trend arrow colour. */
enum class KpiMetric(val key: String, val label: String, val short: String, val icon: Int, val money: Boolean = false, val higherIsBetter: Boolean = true, val tiny: String = short) {
    LEADS_TODAY("leads_today", "Neue Leads heute", "Leads heute", R.drawable.ic_person_add, tiny = "Leads"),
    LEADS_7D("leads_7d", "Leads (7 Tage)", "Leads 7 T.", R.drawable.ic_person_add, tiny = "Leads 7T"),
    OPEN_DEALS("open_deals", "Offene Deals (€)", "Offene Deals", R.drawable.ic_view_kanban, money = true, tiny = "Deals"),
    WON_MONTH("won_month", "Gewonnen im Monat", "Gewonnen", R.drawable.ic_emoji_events, money = true, tiny = "Gewonnen"),
    REVENUE_TODAY("revenue_today", "Umsatz heute", "Umsatz heute", R.drawable.ic_euro, money = true, tiny = "Heute"),
    REVENUE_MONTH("revenue_month", "Umsatz Monat", "Umsatz Monat", R.drawable.ic_euro, money = true, tiny = "Monat"),
    OPEN_INVOICES("open_invoices", "Offene Rechnungen", "Offen", R.drawable.ic_receipt_long, money = true, higherIsBetter = false),
    UNREAD("unread", "Ungelesene Nachrichten", "Ungelesen", R.drawable.ic_inbox, higherIsBetter = false),
    TASKS_DUE("tasks_due", "Aufgaben fällig", "Aufgaben", R.drawable.ic_task_alt, higherIsBetter = false),
    APPOINTMENTS("appointments", "Termine heute", "Termine", R.drawable.ic_event),
    MISSED_CALLS("missed_calls", "Verpasste Anrufe", "Verpasst", R.drawable.ic_phone_missed, higherIsBetter = false),
    RATING("rating", "Bewertung (Sterne)", "Sterne", R.drawable.ic_star, tiny = "Sterne"),
    WEBSITES_DOWN("websites_down", "Websites offline", "Offline", R.drawable.ic_language, higherIsBetter = false);

    fun value(s: Summary): Double = when (this) {
        LEADS_TODAY -> s.leadsToday.toDouble()
        LEADS_7D -> s.leads7d.toDouble()
        OPEN_DEALS -> s.openDealsValueCents.toDouble()
        WON_MONTH -> s.wonMonthCents.toDouble()
        REVENUE_TODAY -> s.revenueTodayCents.toDouble()
        REVENUE_MONTH -> s.revenueMonthCents.toDouble()
        OPEN_INVOICES -> s.openInvoicesCents.toDouble()
        UNREAD -> s.unreadConversations.toDouble()
        TASKS_DUE -> (s.tasksDueToday + s.tasksOverdue).toDouble()
        APPOINTMENTS -> s.appointmentsToday.toDouble()
        MISSED_CALLS -> s.missedCallsToday.toDouble()
        RATING -> s.rating?.avg ?: 0.0
        WEBSITES_DOWN -> s.websites.down.toDouble()
    }

    fun format(s: Summary, short: Boolean = true): String {
        val v = value(s)
        return when {
            money -> if (short) Fmt.moneyShort(v.toLong(), s.currency) else Fmt.money(v.toLong(), s.currency)
            this == RATING -> Fmt.decimal(v, 1)
            else -> Fmt.number(v.toLong())
        }
    }

    companion object {
        fun of(key: String) = entries.firstOrNull { it.key == key } ?: LEADS_TODAY
    }
}

enum class TrendDir { UP, DOWN, FLAT }

data class Trend(val dir: TrendDir, val good: Boolean, val label: String?)

object Trends {
    /**
     * Today vs. yesterday: leads and revenue from the sparklines (last vs. second-to-last day), everything
     * else from the summary the app saw yesterday ([SummaryHistory]). Null when there is nothing to compare.
     */
    fun of(metric: KpiMetric, s: Summary, history: SummaryHistory?): Trend? {
        val (now, before) = when (metric) {
            KpiMetric.LEADS_TODAY -> s.sparkLeads14d.takeLast(2).takeIf { it.size == 2 }?.let { it[1].toDouble() to it[0].toDouble() }
            KpiMetric.REVENUE_TODAY -> s.sparkRevenue30d.takeLast(2).takeIf { it.size == 2 }?.let { it[1].toDouble() to it[0].toDouble() }
            KpiMetric.LEADS_7D -> s.sparkLeads14d.takeIf { it.size >= 14 }?.let { l -> l.takeLast(7).sum().toDouble() to l.take(7).sum().toDouble() }
            else -> history?.previous?.let { metric.value(s) to metric.value(it) }
        } ?: return null
        val dir = when {
            now > before -> TrendDir.UP
            now < before -> TrendDir.DOWN
            else -> TrendDir.FLAT
        }
        val good = when (dir) {
            TrendDir.FLAT -> true
            TrendDir.UP -> metric.higherIsBetter
            TrendDir.DOWN -> !metric.higherIsBetter
        }
        return Trend(dir, good, Fmt.percentChange(now, before))
    }
}

/** Data a widget of a kind needs for a config (collected by the refresh worker, deduplicated). */
fun WidgetKind.requests(c: WidgetConfig): List<DataRequest<*>> = when (this) {
    WidgetKind.COCKPIT, WidgetKind.KPI -> listOf(DataRequest.SummaryOf(c.location))
    WidgetKind.INBOX -> listOf(DataRequest.Inbox(c.location, c.unreadOnly))
    WidgetKind.TASKS -> when (TaskFilter.of(c.taskFilter)) {
        TaskFilter.TODAY_OVERDUE -> listOf(DataRequest.Tasks(c.location, "overdue"), DataRequest.Tasks(c.location, "today"))
        TaskFilter.WEEK -> listOf(DataRequest.Tasks(c.location, "week"))
        TaskFilter.OPEN -> listOf(DataRequest.Tasks(c.location, "open"))
    }
    WidgetKind.APPOINTMENTS -> listOf(DataRequest.Appointments(c.location))
    WidgetKind.PIPELINE -> listOf(DataRequest.Deals(c.location))
    WidgetKind.PROJECTS -> listOf(DataRequest.Projects)
    WidgetKind.QUICK, WidgetKind.VOICE -> emptyList()
    WidgetKind.REVENUE -> listOf(DataRequest.Payments(c.location), DataRequest.SummaryOf(c.location))
    WidgetKind.CALLS -> listOf(DataRequest.Calls(c.location, c.missedOnly))
    WidgetKind.REVIEWS -> listOf(DataRequest.Reviews(c.location))
    WidgetKind.SOCIAL -> listOf(DataRequest.Social(c.location))
}
