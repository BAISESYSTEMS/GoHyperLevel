package org.gohigh.android.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.text.Text
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.api.Deal
import org.gohigh.android.api.DealsResponse
import org.gohigh.android.api.DemoData
import org.gohigh.android.api.Pipeline
import org.gohigh.android.api.ProjectItem
import org.gohigh.android.api.ReviewsResponse
import org.gohigh.android.api.SocialPost
import org.gohigh.android.api.Stage
import org.gohigh.android.data.DataRequest
import org.gohigh.android.ui.quick.QuickActivity
import org.gohigh.android.util.DeepLinks
import org.gohigh.android.util.Fmt
import org.gohigh.android.widget.ui.CardFrame
import org.gohigh.android.widget.ui.Charts
import org.gohigh.android.widget.ui.Chip
import org.gohigh.android.widget.ui.Divider
import org.gohigh.android.widget.ui.Dot
import org.gohigh.android.widget.ui.Empty
import org.gohigh.android.widget.ui.Gate
import org.gohigh.android.widget.ui.HSpace
import org.gohigh.android.widget.ui.Header
import org.gohigh.android.widget.ui.Icon
import org.gohigh.android.widget.ui.IconBadge
import org.gohigh.android.widget.ui.Loaded
import org.gohigh.android.widget.ui.PillButton
import org.gohigh.android.widget.ui.StateMessage
import org.gohigh.android.widget.ui.VSpace
import org.gohigh.android.widget.ui.WC
import org.gohigh.android.widget.ui.WT
import org.gohigh.android.widget.ui.channelLabel
import org.gohigh.android.widget.ui.style
import java.time.Instant
import java.time.ZoneId

// ---------------------------------------------------------------- Pipeline

class PipelineWidget : GoHighWidget<Loaded<DealsResponse>>(WidgetKind.PIPELINE) {
    override val sizes = setOf(Sizes.S4x2, Sizes.S4x3, Sizes.S5x3, Sizes.S5x4)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<DealsResponse> {
        val r = DataRequest.Deals(env.loc)
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.deals(), env.now - 6 * 60_000)

    /** The pipeline with the most open value (the one worth watching). */
    private fun main(d: DealsResponse): Pipeline? = d.pipelines.maxByOrNull { p -> p.stages.sumOf { it.valueCents } * 1000 + p.stages.sumOf { it.count } }

    private sealed interface Entry {
        data class StageRow(val stage: Stage, val max: Long) : Entry
        data object DealsLabel : Entry
        data class DealRow(val deal: Deal) : Entry
    }

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<DealsResponse>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        CardFrame {
            val p = state.data?.let { main(it) }
            Header(
                title = "Pipeline",
                icon = R.drawable.ic_view_kanban,
                env = env,
                fetchedAt = state.fetchedAt,
                open = actionStartActivity(Launch.web(ctx, DeepLinks.opportunities(env.base, env.loc))),
                extra = p?.let { { Chip(Fmt.moneyShort(it.stages.sumOf { s -> s.valueCents })); HSpace(2.dp) } },
            )
            Gate(env, state) { d ->
                val pipeline = main(d)
                if (pipeline == null || (pipeline.stages.all { it.count == 0 } && d.top.isEmpty())) {
                    Empty("Keine offenen Deals", "Zeit für neue Leads 🚀", R.drawable.ic_view_kanban)
                } else if (size.height < 180.dp) {
                    StageTiles(pipeline)
                } else {
                    val maxValue = pipeline.stages.maxOfOrNull { it.valueCents }?.coerceAtLeast(1) ?: 1
                    val entries = pipeline.stages.take(6).map { Entry.StageRow(it, maxValue) } +
                        (if (d.top.isNotEmpty()) listOf(Entry.DealsLabel) + d.top.take(8).map { Entry.DealRow(it) } else emptyList())
                    LazyColumn(modifier = GlanceModifier.fillMaxSize().padding(bottom = 6.dp)) {
                        items(entries, itemId = { e ->
                            when (e) {
                                is Entry.StageRow -> itemId("s_" + e.stage.id)
                                Entry.DealsLabel -> 1L
                                is Entry.DealRow -> itemId("d_" + e.deal.id)
                            }
                        }) { e ->
                            when (e) {
                                is Entry.StageRow -> StageBar(e.stage, e.max, size.width)
                                Entry.DealsLabel -> Text("TOP-DEALS", style = style(WC.header, 10.sp, bold = true), modifier = GlanceModifier.padding(start = 14.dp, top = 8.dp, bottom = 2.dp))
                                is Entry.DealRow -> DealRow(e.deal, env)
                            }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun StageTiles(p: Pipeline) {
        val stages = p.stages.take(5)
        val max = stages.maxOfOrNull { it.valueCents }?.coerceAtLeast(1) ?: 1
        Row(modifier = GlanceModifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 8.dp)) {
            stages.forEachIndexed { i, s ->
                if (i > 0) HSpace(6.dp)
                Column(
                    modifier = GlanceModifier.defaultWeight().fillMaxHeight().background(ImageProvider(R.drawable.widget_row_bg)).padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    Text(s.name, style = style(WC.muted, 10.sp, medium = true), maxLines = 1)
                    Spacer(GlanceModifier.defaultWeight())
                    Text("${s.count}", style = style(WC.text, 20.sp, bold = true), maxLines = 1)
                    Text(Fmt.moneyShort(s.valueCents), style = style(WC.accent, WT.small, medium = true), maxLines = 1)
                    VSpace(4.dp)
                    val d = LocalContext.current.resources.displayMetrics.density
                    val bar = Charts.bar(s.valueCents.toFloat() / max, (60 * d).toInt(), (4 * d).toInt(), 0xFF2563EB.toInt(), 0xFF0EA5E9.toInt(), 0x332563EB)
                    Image(ImageProvider(bar), contentDescription = null, modifier = GlanceModifier.fillMaxWidth().height(4.dp), contentScale = ContentScale.FillBounds)
                }
            }
        }
    }

    @Composable
    private fun StageBar(s: Stage, max: Long, width: Dp) {
        val d = LocalContext.current.resources.displayMetrics.density
        val barW = (width.value - 28) * d
        val bmp = Charts.bar(s.valueCents.toFloat() / max, barW.toInt(), (6 * d).toInt(), 0xFF2563EB.toInt(), 0xFF0EA5E9.toInt(), 0x332563EB)
        Column(modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)) {
            Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(s.name, style = style(WC.text, WT.small, medium = true), maxLines = 1, modifier = GlanceModifier.defaultWeight())
                Text("${s.count} · ${Fmt.moneyShort(s.valueCents)}", style = style(WC.muted, WT.small), maxLines = 1)
            }
            VSpace(3.dp)
            Image(ImageProvider(bmp), contentDescription = null, modifier = GlanceModifier.fillMaxWidth().height(6.dp), contentScale = ContentScale.FillBounds)
        }
    }

    @Composable
    private fun DealRow(deal: Deal, env: WidgetEnv) {
        val ctx = LocalContext.current
        Row(
            modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 5.dp).clickable(actionStartActivity(Launch.deal(ctx, deal))),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(deal.name.ifBlank { "Deal" }, style = style(WC.text, WT.body, medium = true), maxLines = 1)
                val sub = listOfNotNull(deal.contactName?.takeIf { it.isNotBlank() }, deal.stageName.takeIf { it.isNotBlank() }, deal.locationName.takeIf { env.showLocation && it.isNotBlank() })
                Text(sub.joinToString(" · "), style = style(WC.muted, WT.small), maxLines = 1)
            }
            HSpace(8.dp)
            Text(Fmt.moneyShort(deal.valueCents), style = style(WC.text, WT.body, bold = true), maxLines = 1)
            Icon(R.drawable.ic_chevron_right, WC.muted, 18.dp)
        }
    }
}

// ---------------------------------------------------------------- Projekte

class ProjectsWidget : GoHighWidget<Loaded<List<ProjectItem>>>(WidgetKind.PROJECTS) {
    override val sizes = setOf(Sizes.S3x2, Sizes.S4x2, Sizes.S4x3, Sizes.S5x4)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<List<ProjectItem>> {
        val r = DataRequest.Projects
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.projects(), env.now - 60_000)

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<List<ProjectItem>>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        CardFrame {
            val down = state.data?.count { it.uptime?.up == false } ?: 0
            Header(
                title = "Projekte",
                icon = R.drawable.ic_grid_view,
                env = env,
                fetchedAt = state.fetchedAt,
                open = actionStartActivity(Launch.web(ctx, DeepLinks.project(env.base))),
                showAgo = size.width >= 250.dp,
                extra = if (down > 0) ({ Chip("$down offline", WC.danger); HSpace(2.dp) }) else null,
            )
            Gate(env, state) { list ->
                if (list.isEmpty()) {
                    Empty("Keine Projekte", null, R.drawable.ic_folder)
                } else {
                    // Problems first: offline sites, then most unread/open work.
                    val sorted = list.sortedWith(compareBy<ProjectItem> { it.uptime?.up != false }.thenByDescending { it.unread + it.overdueTasks * 2 + it.openTasks })
                    LazyColumn(modifier = GlanceModifier.fillMaxSize().padding(bottom = 6.dp)) {
                        items(sorted, itemId = { itemId(it.locationId) }) { p -> ProjectRow(p, env, size.width >= 250.dp) }
                    }
                }
            }
        }
    }

    @Composable
    private fun ProjectRow(p: ProjectItem, env: WidgetEnv, wide: Boolean) {
        val ctx = LocalContext.current
        val url = p.deepLink?.let { DeepLinks.resolve(env.base, it) } ?: DeepLinks.project(env.base, p.locationId)
        Row(
            modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp).clickable(actionStartActivity(Launch.web(ctx, url))),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Dot(
                when (p.uptime?.up) {
                    true -> WC.success
                    false -> WC.danger
                    null -> WC.neutralDot
                },
                10.dp,
            )
            HSpace(10.dp)
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(p.name.ifBlank { p.locationName ?: "Projekt" }, style = style(WC.text, WT.body, medium = true), maxLines = 1)
                val host = p.website?.removePrefix("https://")?.removePrefix("http://")?.trimEnd('/')
                val sub = when {
                    p.uptime?.up == false -> "Website offline"
                    host != null && wide && p.uptime?.responseMs != null -> "$host · ${p.uptime.responseMs} ms"
                    host != null -> host
                    else -> "Keine Website"
                }
                Text(sub, style = style(if (p.uptime?.up == false) WC.danger else WC.muted, WT.small, bold = p.uptime?.up == false), maxLines = 1)
            }
            Metric(R.drawable.ic_task_alt, p.openTasks, if (p.overdueTasks > 0) WC.danger else WC.muted)
            HSpace(10.dp)
            Metric(R.drawable.ic_inbox, p.unread, if (p.unread > 0) WC.accent else WC.muted)
        }
    }

    @Composable
    private fun Metric(icon: Int, n: Int, color: androidx.glance.unit.ColorProvider) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, color, 14.dp)
            HSpace(3.dp)
            Text("$n", style = style(color, WT.small, bold = n > 0), maxLines = 1)
        }
    }
}

// ---------------------------------------------------------------- Schnellaktionen

class QuickActionsWidget : GoHighWidget<Unit>(WidgetKind.QUICK) {
    override val sizes = setOf(Sizes.S4x1, DpSizes.S4x1Tall, Sizes.S2x2, Sizes.S4x2)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv) = Unit

    override fun demo(env: WidgetEnv, d: DemoData) = Unit

    @Composable
    override fun Content(env: WidgetEnv, state: Unit) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val actions = env.config.actions.mapNotNull { QuickAction.of(it) }.ifEmpty { QuickAction.DEFAULTS }
        CardFrame {
            Gate(env, Loaded(Unit, null, null), compact = size.height < 110.dp) {
                val labels = size.height >= 64.dp
                val oneRow = size.height < 110.dp
                val columns = when {
                    oneRow -> if (size.width >= 250.dp) 5 else 4
                    size.width < 250.dp -> 2
                    else -> 4
                }
                val rows: List<List<QuickAction?>> = when {
                    oneRow -> listOf(actions.take(columns))
                    size.width < 250.dp -> actions.take(4).chunked(2)
                    else -> actions.take(8).chunked(4)
                }.map { r -> if (oneRow) r else r + List(columns - r.size) { null } }
                Column(modifier = GlanceModifier.fillMaxSize().padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    rows.forEachIndexed { i, row ->
                        if (i > 0) VSpace(4.dp)
                        Row(modifier = GlanceModifier.fillMaxWidth().defaultWeight(), verticalAlignment = Alignment.CenterVertically) {
                            row.forEach { a ->
                                if (a == null) {
                                    Spacer(GlanceModifier.defaultWeight())
                                    return@forEach
                                }
                                Column(
                                    modifier = GlanceModifier.defaultWeight().fillMaxHeight().clickable(actionStartActivity(intentFor(ctx, a, env))),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    IconBadge(a.icon, size = if (labels) 40.dp else 36.dp)
                                    if (labels) {
                                        VSpace(3.dp)
                                        Text(if (oneRow) a.short else a.label, style = style(WC.text, WT.small, medium = true, center = true), maxLines = 1)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun intentFor(ctx: Context, a: QuickAction, env: WidgetEnv): Intent {
        val loc = env.loc.takeIf { env.config.location != org.gohigh.android.api.ALL_LOCATIONS }
        val unique = "w${env.appWidgetId}"
        return when (a) {
            QuickAction.CONTACT -> Launch.quick(ctx, QuickActivity.CONTACT, loc, unique)
            QuickAction.TASK -> Launch.quick(ctx, QuickActivity.TASK, loc, unique)
            QuickAction.NOTE -> Launch.quick(ctx, QuickActivity.NOTE, loc, unique)
            QuickAction.CALL -> Launch.quick(ctx, QuickActivity.CALL, loc, unique)
            QuickAction.VOICE -> Launch.quick(ctx, QuickActivity.VOICE, loc, unique)
            QuickAction.INVOICE -> Launch.web(ctx, DeepLinks.invoices(env.base, loc))
            QuickAction.INBOX -> Launch.web(ctx, DeepLinks.conversations(env.base, loc))
        }
    }
}

/** Extra breakpoint: a one-row widget tall enough for labels. */
object DpSizes {
    val S4x1Tall = androidx.compose.ui.unit.DpSize(250.dp, 64.dp)
}

// ---------------------------------------------------------------- Bewertungen

class ReviewsWidget : GoHighWidget<Loaded<ReviewsResponse>>(WidgetKind.REVIEWS) {
    override val sizes = setOf(Sizes.S2x2, Sizes.S3x2, Sizes.S4x2)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<ReviewsResponse> {
        val r = DataRequest.Reviews(env.loc)
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.reviews(), env.now - 10 * 60_000)

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<ReviewsResponse>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val narrow = size.width < 180.dp
        CardFrame {
            Header(
                title = "Bewertungen",
                icon = R.drawable.ic_star,
                env = env,
                fetchedAt = state.fetchedAt,
                open = actionStartActivity(Launch.web(ctx, DeepLinks.reviews(env.base, env.loc))),
                showAgo = size.width >= 250.dp,
            )
            Gate(env, state, compact = narrow) { r ->
                if (r.count == 0 || r.avg == null) {
                    StateMessage(R.drawable.ic_star_outline, "Noch keine Bewertungen", if (narrow) null else "Bewertungen anfragen lohnt sich", tint = WC.star, compact = narrow)
                } else {
                    Row(
                        modifier = GlanceModifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 8.dp).clickable(actionStartActivity(Launch.web(ctx, DeepLinks.reviews(env.base, env.loc)))),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = if (size.width >= 250.dp) GlanceModifier else GlanceModifier.defaultWeight()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(Fmt.decimal(r.avg, 1), style = style(WC.text, 28.sp, bold = true), maxLines = 1)
                                HSpace(6.dp)
                                Delta(r)
                            }
                            Stars(r.avg, 15.dp)
                            VSpace(2.dp)
                            Text("${Fmt.number(r.count.toLong())} Bewertungen", style = style(WC.muted, WT.small), maxLines = 1)
                            if (r.new30d > 0) Text("+${r.new30d} in 30 Tagen", style = style(WC.success, WT.small, medium = true), maxLines = 1)
                        }
                        val latest = r.latest.firstOrNull()
                        if (size.width >= 250.dp && latest != null) {
                            HSpace(12.dp)
                            Column(modifier = GlanceModifier.defaultWeight().fillMaxHeight().background(ImageProvider(R.drawable.widget_row_bg)).padding(horizontal = 10.dp, vertical = 8.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(latest.author.ifBlank { "Kunde" }, style = style(WC.text, WT.small, bold = true), maxLines = 1, modifier = GlanceModifier.defaultWeight())
                                    Stars(latest.rating, 11.dp)
                                }
                                VSpace(2.dp)
                                Text(latest.text?.takeIf { it.isNotBlank() } ?: "Ohne Text", style = style(WC.muted, WT.small), maxLines = 3)
                                Spacer(GlanceModifier.defaultWeight())
                                Text(listOfNotNull(Fmt.shortTime(latest.at, env.now).takeIf { it.isNotEmpty() }, if (latest.replied) "beantwortet" else "noch offen").joinToString(" · "), style = style(if (latest.replied) WC.muted else WC.warning, 10.sp), maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun Delta(r: ReviewsResponse) {
        val d = r.delta30d ?: return
        if (d == 0.0) return
        val up = d > 0
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(if (up) R.drawable.ic_trending_up else R.drawable.ic_trending_down, if (up) WC.success else WC.danger, 14.dp)
            Text((if (up) "+" else "") + Fmt.decimal(d, 1), style = style(if (up) WC.success else WC.danger, WT.small, bold = true), maxLines = 1)
        }
    }

    @Composable
    private fun Stars(avg: Double, size: Dp) {
        Row {
            for (i in 1..5) {
                val res = when {
                    avg >= i - 0.25 -> R.drawable.ic_star
                    avg >= i - 0.75 -> R.drawable.ic_star_half
                    else -> R.drawable.ic_star_outline
                }
                Icon(res, WC.star, size)
            }
        }
    }
}

// ---------------------------------------------------------------- Social

class SocialWidget : GoHighWidget<Loaded<List<SocialPost>>>(WidgetKind.SOCIAL) {
    override val sizes = setOf(Sizes.S3x2, Sizes.S4x2, Sizes.S4x3)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<List<SocialPost>> {
        val r = DataRequest.Social(env.loc)
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.social(), env.now - 8 * 60_000)

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<List<SocialPost>>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val open = actionStartActivity(Launch.web(ctx, DeepLinks.social(env.base, env.loc)))
        CardFrame {
            Header("Social", R.drawable.ic_campaign, env, state.fetchedAt, open, showAgo = size.width >= 250.dp)
            Gate(env, state) { posts ->
                val next = posts.filter { it.status != "published" }.ifEmpty { posts.take(0) }
                if (next.isEmpty()) {
                    StateMessage(R.drawable.ic_campaign, "Nichts geplant", "Plane den nächsten Beitrag", "Beitrag planen", open)
                } else {
                    LazyColumn(modifier = GlanceModifier.fillMaxSize().padding(bottom = 6.dp)) {
                        items(next, itemId = { itemId(it.id) }) { p -> PostRow(p, env) }
                    }
                }
            }
        }
    }

    @Composable
    private fun PostRow(p: SocialPost, env: WidgetEnv) {
        val ctx = LocalContext.current
        val zone = ZoneId.systemDefault()
        val t = Fmt.parseInstant(p.scheduledAt)?.atZone(zone)
        val today = Instant.ofEpochMilli(env.now).atZone(zone).toLocalDate()
        val whenLabel = t?.let { Fmt.dayLabel(it.toLocalDate(), today) + " " + Fmt.clock(p.scheduledAt) } ?: "ohne Termin"
        Row(
            modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).clickable(actionStartActivity(Launch.web(ctx, DeepLinks.social(env.base, p.locationId)))),
            verticalAlignment = Alignment.Top,
        ) {
            IconBadge(if (p.status == "draft") R.drawable.ic_edit_note else R.drawable.ic_schedule, size = 30.dp)
            HSpace(10.dp)
            Column(modifier = GlanceModifier.defaultWeight()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (p.status == "draft") "Entwurf" else whenLabel, style = style(WC.accent, WT.small, bold = true), maxLines = 1)
                    val ch = p.channels.joinToString(" · ") { channelLabel(it) }
                    if (ch.isNotEmpty()) Text("  $ch", style = style(WC.muted, WT.small), maxLines = 1)
                }
                Text(p.text.ifBlank { "Ohne Text" }, style = style(WC.text, WT.body), maxLines = 2)
                if (env.showLocation && !p.locationName.isNullOrBlank()) Text(p.locationName, style = style(WC.muted, 10.sp), maxLines = 1)
            }
        }
    }
}

