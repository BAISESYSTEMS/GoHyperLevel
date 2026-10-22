package org.gohigh.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.CheckBox
import androidx.glance.appwidget.CheckboxDefaults
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.Text
import androidx.glance.text.TextDecoration
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.api.Appointment
import org.gohigh.android.api.CallItem
import org.gohigh.android.api.DemoData
import org.gohigh.android.api.InboxItem
import org.gohigh.android.api.TaskItem
import org.gohigh.android.data.DataRequest
import org.gohigh.android.ui.quick.QuickActivity
import org.gohigh.android.util.DeepLinks
import org.gohigh.android.util.Fmt
import org.gohigh.android.widget.ui.CardFrame
import org.gohigh.android.widget.ui.Chip
import org.gohigh.android.widget.ui.Dot
import org.gohigh.android.widget.ui.Empty
import org.gohigh.android.widget.ui.Gate
import org.gohigh.android.widget.ui.HSpace
import org.gohigh.android.widget.ui.Header
import org.gohigh.android.widget.ui.Icon
import org.gohigh.android.widget.ui.IconBadge
import org.gohigh.android.widget.ui.IconButton
import org.gohigh.android.widget.ui.Loaded
import org.gohigh.android.widget.ui.WC
import org.gohigh.android.widget.ui.WT
import org.gohigh.android.widget.ui.channelIcon
import org.gohigh.android.widget.ui.style
import java.time.Instant
import java.time.ZoneId

/** Stable Glance item id from a string id. */
internal fun itemId(id: String): Long = id.hashCode().toLong() and 0xffffffffL

// ---------------------------------------------------------------- Posteingang

class InboxWidget : GoHighWidget<Loaded<List<InboxItem>>>(WidgetKind.INBOX) {
    override val sizes = setOf(Sizes.S3x2, Sizes.S4x2, Sizes.S4x3, Sizes.S5x3, Sizes.S5x4)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<List<InboxItem>> {
        val r = DataRequest.Inbox(env.loc, env.config.unreadOnly)
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.inbox(), env.now - 60_000)

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<List<InboxItem>>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val wide = size.width >= 250.dp
        CardFrame {
            val unread = state.data?.count { it.isUnread } ?: 0
            Header(
                title = if (env.config.unreadOnly) "Ungelesen" else "Posteingang",
                icon = R.drawable.ic_inbox,
                env = env,
                fetchedAt = state.fetchedAt,
                open = actionStartActivity(Launch.web(ctx, DeepLinks.conversations(env.base, env.loc))),
                showAgo = wide,
                extra = if (unread > 0) ({ Chip("$unread neu"); HSpace(2.dp) }) else null,
            )
            Gate(env, state) { items ->
                if (items.isEmpty()) {
                    Empty("Alles gelesen 🎉", "Keine neuen Nachrichten")
                } else {
                    LazyColumn(modifier = GlanceModifier.fillMaxSize().padding(bottom = 6.dp)) {
                        items(items, itemId = { itemId(it.conversationId) }) { item -> Row(item, env, wide) }
                    }
                }
            }
        }
    }

    @Composable
    private fun Row(item: InboxItem, env: WidgetEnv, wide: Boolean) {
        val ctx = LocalContext.current
        val open = actionStartActivity(Launch.web(ctx, DeepLinks.conversation(env.base, item.conversationId, item.locationId.ifBlank { null })))
        Row(
            modifier = GlanceModifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp).clickable(open),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBadge(channelIcon(item.channel), size = 34.dp)
            HSpace(10.dp)
            Column(modifier = GlanceModifier.defaultWeight()) {
                Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        item.contactName.ifBlank { "Unbekannt" },
                        style = style(WC.text, WT.body, bold = item.isUnread, medium = !item.isUnread),
                        maxLines = 1,
                        modifier = GlanceModifier.defaultWeight(),
                    )
                    HSpace(6.dp)
                    Text(Fmt.shortTime(item.lastAt, env.now), style = style(if (item.isUnread) WC.accent else WC.muted, WT.small, bold = item.isUnread), maxLines = 1)
                }
                Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    val prefix = if (item.lastDirection == "outbound" || item.lastDirection == "out") "Du: " else ""
                    Text(prefix + item.lastMessage, style = style(if (item.isUnread) WC.text else WC.muted, WT.small), maxLines = 1, modifier = GlanceModifier.defaultWeight())
                    if (item.isUnread) {
                        HSpace(6.dp)
                        Dot(WC.accent, 8.dp)
                    }
                }
                if (env.showLocation && wide && item.locationName.isNotBlank()) {
                    Text(item.locationName, style = style(WC.muted, 10.sp), maxLines = 1)
                }
            }
            if (wide) {
                IconButton(R.drawable.ic_reply, actionStartActivity(Launch.reply(ctx, item.conversationId, item.contactName, item.locationId)), WC.accent, "Antworten", size = 38.dp, iconSize = 20.dp)
            } else {
                HSpace(8.dp)
            }
        }
    }
}

// ---------------------------------------------------------------- Aufgaben

class TasksWidget : GoHighWidget<Loaded<List<TaskItem>>>(WidgetKind.TASKS) {
    override val sizes = setOf(Sizes.S2x2, Sizes.S3x2, Sizes.S4x2, Sizes.S4x3, Sizes.S5x4)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<List<TaskItem>> {
        val reqs = kind.requests(env.config).filterIsInstance<DataRequest.Tasks>()
        val cached = reqs.map { g.repository.cached(it) }
        val error = reqs.firstNotNullOfOrNull { g.repository.error(it) }
        if (cached.all { it == null }) return Loaded(null, null, error?.message)
        val merged = cached.filterNotNull().flatMap { it.data }.distinctBy { it.id }
        return Loaded(sort(merged, env.now), cached.filterNotNull().minOf { it.fetchedAt }, error?.message)
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(sort(d.tasks("open"), env.now), env.now - 3 * 60_000)

    /** Open first (overdue on top, then by due time), done last. */
    private fun sort(list: List<TaskItem>, now: Long) =
        list.sortedWith(compareBy<TaskItem> { it.done }.thenBy { !Fmt.isOverdue(it.dueAt, now) }.thenBy { it.dueAt ?: "9999" })

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<List<TaskItem>>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val narrow = size.width < 180.dp
        CardFrame {
            val open = state.data?.count { !it.done } ?: 0
            Header(
                title = "Aufgaben",
                icon = R.drawable.ic_task_alt,
                env = env,
                fetchedAt = state.fetchedAt,
                open = actionStartActivity(Launch.web(ctx, DeepLinks.tasks(env.base, env.loc))),
                showAgo = !narrow,
                extra = {
                    if (open > 0 && !narrow) {
                        Chip("$open offen")
                    }
                    IconButton(R.drawable.ic_add, actionStartActivity(Launch.quick(ctx, QuickActivity.TASK, env.loc, "w${env.appWidgetId}")), WC.header, "Aufgabe hinzufügen", size = if (narrow) 30.dp else 34.dp, iconSize = 20.dp)
                },
            )
            Gate(env, state, compact = narrow) { items ->
                if (items.isEmpty()) {
                    Empty("Alles erledigt 🎉", if (narrow) null else "Keine offenen Aufgaben", compact = narrow)
                } else {
                    LazyColumn(modifier = GlanceModifier.fillMaxSize().padding(bottom = 6.dp)) {
                        items(items, itemId = { itemId(it.id) }) { t -> TaskRow(t, env, narrow) }
                    }
                }
            }
        }
    }

    @Composable
    private fun TaskRow(t: TaskItem, env: WidgetEnv, narrow: Boolean) {
        val ctx = LocalContext.current
        val overdue = !t.done && Fmt.isOverdue(t.dueAt, env.now)
        Row(modifier = GlanceModifier.fillMaxWidth().padding(start = 4.dp, end = 10.dp, top = 1.dp, bottom = 1.dp), verticalAlignment = Alignment.CenterVertically) {
            CheckBox(
                checked = t.done,
                onCheckedChange = actionRunCallback<ToggleTaskAction>(actionParametersOf(ToggleTaskAction.TASK_ID to t.id, ToggleTaskAction.TASK_DONE to !t.done)),
                colors = CheckboxDefaults.colors(checkedColor = WC.success, uncheckedColor = if (overdue) WC.danger else WC.muted),
                text = "",
            )
            Column(
                modifier = GlanceModifier.defaultWeight().clickable(actionStartActivity(Launch.web(ctx, DeepLinks.tasks(env.base, t.locationId.ifBlank { null })))),
            ) {
                val titleStyle = style(if (t.done) WC.muted else WC.text, WT.body, medium = !t.done)
                Text(t.title, style = if (t.done) titleStyle.copy(textDecoration = TextDecoration.LineThrough) else titleStyle, maxLines = if (narrow) 2 else 1)
                if (!narrow) {
                    val parts = listOfNotNull(
                        t.contactName?.takeIf { it.isNotBlank() },
                        t.locationName.takeIf { env.showLocation && it.isNotBlank() },
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val due = Fmt.due(t.dueAt, env.now)
                        if (due.isNotEmpty()) {
                            Text(due, style = style(if (overdue) WC.danger else WC.muted, WT.small, bold = overdue), maxLines = 1)
                            if (parts.isNotEmpty()) Text(" · ", style = style(WC.muted, WT.small))
                        }
                        if (parts.isNotEmpty()) Text(parts.joinToString(" · "), style = style(WC.muted, WT.small), maxLines = 1)
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- Termine

class AppointmentsWidget : GoHighWidget<Loaded<List<Appointment>>>(WidgetKind.APPOINTMENTS) {
    override val sizes = setOf(Sizes.S3x2, Sizes.S4x2, Sizes.S4x3, Sizes.S5x3)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<List<Appointment>> {
        val r = DataRequest.Appointments(env.loc)
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.appointments(), env.now - 5 * 60_000)

    private sealed interface Entry {
        data class Day(val label: String) : Entry
        data class Item(val a: Appointment) : Entry
    }

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<List<Appointment>>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        CardFrame {
            Header(
                title = "Termine",
                icon = R.drawable.ic_event,
                env = env,
                fetchedAt = state.fetchedAt,
                open = actionStartActivity(Launch.web(ctx, DeepLinks.calendars(env.base, env.loc))),
                showAgo = size.width >= 250.dp,
            )
            Gate(env, state) { list ->
                val zone = ZoneId.systemDefault()
                val today = Instant.ofEpochMilli(env.now).atZone(zone).toLocalDate()
                // Hide appointments that ended over an hour ago so the list stays about what's next.
                val upcoming = list.filter { a ->
                    val end = Fmt.parseInstant(a.end ?: a.start)?.toEpochMilli() ?: Long.MAX_VALUE
                    end > env.now - 3600_000
                }
                if (upcoming.isEmpty()) {
                    Empty("Keine Termine", "Heute und morgen ist frei", R.drawable.ic_event_available)
                } else {
                    val entries = mutableListOf<Entry>()
                    var lastDay: java.time.LocalDate? = null
                    for (a in upcoming) {
                        val day = Fmt.parseInstant(a.start)?.atZone(zone)?.toLocalDate()
                        if (day != null && day != lastDay) {
                            entries += Entry.Day(Fmt.dayLabel(day, today))
                            lastDay = day
                        }
                        entries += Entry.Item(a)
                    }
                    LazyColumn(modifier = GlanceModifier.fillMaxSize().padding(bottom = 6.dp)) {
                        items(entries, itemId = { e -> if (e is Entry.Item) itemId(e.a.id) else itemId("day_" + (e as Entry.Day).label) }) { e ->
                            when (e) {
                                is Entry.Day -> Text(
                                    e.label.uppercase(),
                                    style = style(WC.header, 10.sp, bold = true),
                                    modifier = GlanceModifier.padding(start = 14.dp, top = 8.dp, bottom = 2.dp),
                                )
                                is Entry.Item -> AppointmentRow(e.a, env, size.width >= 250.dp)
                            }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun AppointmentRow(a: Appointment, env: WidgetEnv, wide: Boolean) {
        val ctx = LocalContext.current
        val cancelled = a.status == "cancelled" || a.status == "noshow"
        val running = (Fmt.parseInstant(a.start)?.toEpochMilli() ?: 0) <= env.now && (Fmt.parseInstant(a.end)?.toEpochMilli() ?: 0) > env.now
        Row(
            modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp).clickable(actionStartActivity(Launch.appointment(ctx, a))),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = GlanceModifier.width(46.dp)) {
                Text(Fmt.clock(a.start), style = style(if (running) WC.accent else WC.text, WT.body, bold = true), maxLines = 1)
                if (a.end != null) Text(Fmt.clock(a.end), style = style(WC.muted, WT.small), maxLines = 1)
            }
            Box(modifier = GlanceModifier.width(3.dp).height(30.dp).background(if (cancelled) WC.neutralDot else if (running) WC.success else WC.accent)) {}
            HSpace(9.dp)
            Column(modifier = GlanceModifier.defaultWeight()) {
                val ts = style(if (cancelled) WC.muted else WC.text, WT.body, medium = true)
                Text(a.title.ifBlank { "Termin" }, style = if (cancelled) ts.copy(textDecoration = TextDecoration.LineThrough) else ts, maxLines = 1)
                val sub = listOfNotNull(
                    a.contactName?.takeIf { it.isNotBlank() },
                    a.calendarName?.takeIf { it.isNotBlank() && wide },
                    a.locationName.takeIf { env.showLocation && wide && it.isNotBlank() },
                ).joinToString(" · ")
                if (sub.isNotEmpty()) Text(sub, style = style(WC.muted, WT.small), maxLines = 1)
            }
            when {
                cancelled -> Chip(if (a.status == "noshow") "nicht da" else "abgesagt", WC.danger)
                a.status == "showed" -> Icon(R.drawable.ic_how_to_reg, WC.success, 18.dp)
                !a.meetingUrl.isNullOrBlank() -> Icon(R.drawable.ic_videocam, WC.accent, 18.dp)
                !a.address.isNullOrBlank() -> Icon(R.drawable.ic_directions, WC.accent, 18.dp)
                else -> Unit
            }
        }
    }
}

// ---------------------------------------------------------------- Anrufe

class CallsWidget : GoHighWidget<Loaded<List<CallItem>>>(WidgetKind.CALLS) {
    override val sizes = setOf(Sizes.S3x2, Sizes.S4x2, Sizes.S4x3, Sizes.S5x3)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<List<CallItem>> {
        val r = DataRequest.Calls(env.loc, env.config.missedOnly)
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.calls(), env.now - 2 * 60_000)

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<List<CallItem>>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        CardFrame {
            Header(
                title = if (env.config.missedOnly) "Verpasste Anrufe" else "Anrufe",
                icon = R.drawable.ic_phone_missed,
                env = env,
                fetchedAt = state.fetchedAt,
                open = actionStartActivity(Launch.web(ctx, DeepLinks.calls(env.base, env.loc))),
                showAgo = size.width >= 250.dp,
            )
            Gate(env, state) { calls ->
                if (calls.isEmpty()) {
                    Empty("Keine verpassten Anrufe 🎉", "Alle erreicht", R.drawable.ic_call)
                } else {
                    LazyColumn(modifier = GlanceModifier.fillMaxSize().padding(bottom = 6.dp)) {
                        items(calls, itemId = { itemId(it.id) }) { c -> CallRow(c, env, size.width >= 250.dp) }
                    }
                }
            }
        }
    }

    @Composable
    private fun CallRow(c: CallItem, env: WidgetEnv, wide: Boolean) {
        val ctx = LocalContext.current
        val missed = c.missed || c.status in setOf("missed", "no-answer", "busy", "voicemail", "canceled", "failed")
        Row(
            modifier = GlanceModifier.fillMaxWidth().padding(start = 12.dp, end = 6.dp, top = 5.dp, bottom = 5.dp)
                .clickable(actionStartActivity(Launch.web(ctx, DeepLinks.calls(env.base, c.locationId)))),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBadge(
                if (missed) R.drawable.ic_phone_missed else if (c.direction == "outbound" || c.direction == "out") R.drawable.ic_call_made else R.drawable.ic_call_received,
                tint = if (missed) WC.danger else WC.accent,
                size = 32.dp,
            )
            HSpace(10.dp)
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(c.contactName?.takeIf { it.isNotBlank() } ?: c.otherNumber ?: "Unbekannt", style = style(WC.text, WT.body, medium = true), maxLines = 1)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(Fmt.parseInstant(c.at)?.let { Fmt.ago(it.toEpochMilli(), env.now) } ?: "", style = style(WC.muted, WT.small), maxLines = 1)
                    if (c.hasVoicemail) {
                        HSpace(4.dp)
                        Icon(R.drawable.ic_voicemail, WC.accent, 13.dp)
                    }
                    val extra = c.summary?.takeIf { wide && it.isNotBlank() } ?: c.locationName?.takeIf { env.showLocation && wide && it.isNotBlank() }
                    if (extra != null) Text(" · $extra", style = style(WC.muted, WT.small), maxLines = 1)
                }
            }
            Box(
                modifier = GlanceModifier.size(36.dp).background(ImageProvider(R.drawable.widget_button_bg)).clickable(actionStartActivity(Launch.callBack(ctx, c))),
                contentAlignment = Alignment.Center,
            ) {
                Icon(R.drawable.ic_call, WC.onHero, 18.dp, description = "Zurückrufen")
            }
        }
    }
}
