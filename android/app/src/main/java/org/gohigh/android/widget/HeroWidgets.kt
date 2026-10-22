package org.gohigh.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
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
import androidx.glance.layout.width
import androidx.glance.text.Text
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.api.DemoData
import org.gohigh.android.api.PaymentsResponse
import org.gohigh.android.api.Summary
import org.gohigh.android.data.DataRequest
import org.gohigh.android.data.SummaryHistory
import org.gohigh.android.ui.quick.QuickActivity
import org.gohigh.android.util.DeepLinks
import org.gohigh.android.util.Fmt
import org.gohigh.android.widget.ui.Charts
import org.gohigh.android.widget.ui.Gate
import org.gohigh.android.widget.ui.HSpace
import org.gohigh.android.widget.ui.HeroFrame
import org.gohigh.android.widget.ui.HeroHeader
import org.gohigh.android.widget.ui.Icon
import org.gohigh.android.widget.ui.Loaded
import org.gohigh.android.widget.ui.VSpace
import org.gohigh.android.widget.ui.WC
import org.gohigh.android.widget.ui.WT
import org.gohigh.android.widget.ui.agoLabel
import org.gohigh.android.widget.ui.style

// ---------------------------------------------------------------- shared hero bits

@Composable
private fun HeroTile(value: String, label: String, modifier: GlanceModifier, big: Boolean = false, alert: Boolean = false) {
    Column(modifier = modifier.background(ImageProvider(R.drawable.widget_tile_bg)).padding(horizontal = 10.dp, vertical = 7.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(value, style = style(WC.onHero, if (big) 22.sp else 18.sp, bold = true), maxLines = 1)
            if (alert) {
                HSpace(4.dp)
                Icon(R.drawable.ic_warning, WC.onHero, 12.dp)
            }
        }
        Text(label, style = style(WC.onHeroMuted, WT.small), maxLines = 1)
    }
}

@Composable
private fun density(): Float = LocalContext.current.resources.displayMetrics.density

/** White sparkline sized for the given dp box. */
@Composable
private fun HeroSparkline(values: List<Number>, width: Dp, height: Dp, modifier: GlanceModifier = GlanceModifier) {
    if (values.size < 2) return
    val d = density()
    val bmp = Charts.sparkline(
        values, (width.value * d).toInt(), (height.value * d).toInt(),
        lineColor = 0xFFFFFFFF.toInt(), fillTop = 0x55FFFFFF, fillBottom = 0x00FFFFFF, strokePx = 2.2f * d, dotColor = 0x66FFFFFF,
    )
    Image(ImageProvider(bmp), contentDescription = "Verlauf", modifier = modifier, contentScale = ContentScale.FillBounds)
}

// ---------------------------------------------------------------- Cockpit

class CockpitWidget : GoHighWidget<Loaded<Summary>>(WidgetKind.COCKPIT) {
    override val sizes = setOf(Sizes.S2x2, Sizes.S3x2, Sizes.S4x2, Sizes.S4x3, Sizes.S5x3)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): Loaded<Summary> {
        val r = DataRequest.SummaryOf(env.loc)
        return Loaded.of(g.repository.cached(r), g.repository.error(r))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = Loaded.demo(d.summary(env.loc), env.now - 4 * 60_000)

    @Composable
    override fun Content(env: WidgetEnv, state: Loaded<Summary>) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        HeroFrame(onClick = actionStartActivity(Launch.web(ctx, DeepLinks.dashboard(env.base, env.loc)))) {
            HeroHeader(env.locationName ?: "Cockpit", R.drawable.ic_speed, env, state.fetchedAt, showAgo = size.width >= 180.dp)
            VSpace(6.dp)
            Gate(env, state, hero = true, compact = size.width < 180.dp) { s -> Body(s, size) }
        }
    }

    @Composable
    private fun Body(s: Summary, size: DpSize) {
        val tasks = s.tasksDueToday + s.tasksOverdue
        when {
            size.width < 180.dp -> Column(modifier = GlanceModifier.fillMaxSize()) {
                HeroStatRow(R.drawable.ic_person_add, "Leads heute", Fmt.number(s.leadsToday.toLong()))
                HeroStatRow(R.drawable.ic_inbox, "Ungelesen", Fmt.number(s.unreadConversations.toLong()))
                HeroStatRow(R.drawable.ic_task_alt, "Aufgaben", Fmt.number(tasks.toLong()), alert = s.tasksOverdue > 0)
                HeroStatRow(R.drawable.ic_euro, "Umsatz", Fmt.moneyShort(s.revenueMonthCents, s.currency))
            }
            size.height < 180.dp -> Column(modifier = GlanceModifier.fillMaxSize()) {
                val stats = listOf(
                    Triple(Fmt.number(s.leadsToday.toLong()), "Leads heute", false),
                    Triple(Fmt.moneyShort(s.openDealsValueCents, s.currency), "Offene Deals", false),
                    Triple(Fmt.moneyShort(s.revenueMonthCents, s.currency), "Umsatz Mon.", false),
                    Triple(Fmt.number(s.unreadConversations.toLong()), "Ungelesen", false),
                    Triple(Fmt.number(tasks.toLong()), "Aufgaben", s.tasksOverdue > 0),
                ).take(
                    when {
                        size.width >= 320.dp -> 5
                        size.width >= 250.dp -> 4
                        else -> 3
                    },
                )
                Row(modifier = GlanceModifier.fillMaxWidth().background(ImageProvider(R.drawable.widget_tile_bg)).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    stats.forEachIndexed { i, (value, label, alert) ->
                        if (i > 0) Box(modifier = GlanceModifier.width(1.dp).height(28.dp).background(WC.onHeroFaint)) {}
                        HeroStat(value, label, GlanceModifier.defaultWeight(), alert)
                    }
                }
                VSpace(8.dp)
                HeroSparkline(s.sparkRevenue30d, size.width, 36.dp, GlanceModifier.fillMaxWidth().defaultWeight())
            }
            else -> Column(modifier = GlanceModifier.fillMaxSize()) {
                Row(modifier = GlanceModifier.fillMaxWidth()) {
                    HeroTile(Fmt.number(s.leadsToday.toLong()), "Neue Leads heute", GlanceModifier.defaultWeight(), big = true)
                    HSpace(6.dp)
                    HeroTile(Fmt.moneyShort(s.openDealsValueCents, s.currency), "Offene Deals (${s.openDealsCount})", GlanceModifier.defaultWeight(), big = true)
                    HSpace(6.dp)
                    HeroTile(Fmt.moneyShort(s.revenueMonthCents, s.currency), "Umsatz Monat", GlanceModifier.defaultWeight(), big = true)
                }
                VSpace(6.dp)
                Row(modifier = GlanceModifier.fillMaxWidth()) {
                    HeroTile(Fmt.number(s.unreadConversations.toLong()), "Ungelesen", GlanceModifier.defaultWeight())
                    HSpace(6.dp)
                    HeroTile(Fmt.number(tasks.toLong()), if (s.tasksOverdue > 0) "Aufgaben · ${s.tasksOverdue} überf." else "Aufgaben fällig", GlanceModifier.defaultWeight(), alert = s.tasksOverdue > 0)
                    HSpace(6.dp)
                    HeroTile(Fmt.number(s.appointmentsToday.toLong()), "Termine heute", GlanceModifier.defaultWeight())
                }
                VSpace(8.dp)
                Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Umsatz 30 Tage", style = style(WC.onHeroMuted, WT.small, medium = true))
                    Spacer(GlanceModifier.defaultWeight())
                    Text("heute " + Fmt.moneyShort(s.revenueTodayCents, s.currency), style = style(WC.onHero, WT.small, bold = true))
                }
                HeroSparkline(s.sparkRevenue30d, size.width, 48.dp, GlanceModifier.fillMaxWidth().defaultWeight())
            }
        }
    }
}

/** Value over label, centered (compact KPI strip). */
@Composable
private fun HeroStat(value: String, label: String, modifier: GlanceModifier, alert: Boolean = false) {
    Column(modifier = modifier.padding(horizontal = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(value, style = style(WC.onHero, 19.sp, bold = true), maxLines = 1)
            if (alert) {
                HSpace(3.dp)
                Icon(R.drawable.ic_warning, WC.onHero, 12.dp)
            }
        }
        Text(label, style = style(WC.onHeroMuted, 10.sp, center = true), maxLines = 1)
    }
}

/** Icon · label · value row for the narrow (2-column) cockpit. */
@Composable
private fun androidx.glance.layout.ColumnScope.HeroStatRow(icon: Int, label: String, value: String, alert: Boolean = false) {
    Row(modifier = GlanceModifier.fillMaxWidth().defaultWeight(), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, WC.onHeroMuted, 15.dp)
        HSpace(6.dp)
        Text(label, style = style(WC.onHeroMuted, WT.small), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        HSpace(4.dp)
        if (alert) {
            Icon(R.drawable.ic_warning, WC.onHero, 12.dp)
            HSpace(3.dp)
        }
        Text(value, style = style(WC.onHero, 15.sp, bold = true), maxLines = 1)
    }
}

// ---------------------------------------------------------------- Umsatz

data class RevenueState(val payments: Loaded<PaymentsResponse>, val spark: List<Long>)

class RevenueWidget : GoHighWidget<RevenueState>(WidgetKind.REVENUE) {
    override val sizes = setOf(Sizes.S2x2, Sizes.S3x2, Sizes.S4x2)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): RevenueState {
        val p = DataRequest.Payments(env.loc)
        val s = g.repository.cached(DataRequest.SummaryOf(env.loc))?.data
        return RevenueState(Loaded.of(g.repository.cached(p), g.repository.error(p)), s?.sparkRevenue30d.orEmpty())
    }

    override fun demo(env: WidgetEnv, d: DemoData) =
        RevenueState(Loaded.demo(d.payments(), env.now - 2 * 60_000), d.summary(env.loc).sparkRevenue30d)

    @Composable
    override fun Content(env: WidgetEnv, state: RevenueState) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        HeroFrame(onClick = actionStartActivity(Launch.web(ctx, DeepLinks.invoices(env.base, env.loc)))) {
            HeroHeader("Umsatz", R.drawable.ic_euro, env, state.payments.fetchedAt, showAgo = size.width >= 180.dp)
            VSpace(4.dp)
            Gate(env, state.payments, hero = true, compact = size.width < 180.dp) { p ->
                if (size.width < 250.dp) {
                    Column(modifier = GlanceModifier.fillMaxSize()) {
                        Text(Fmt.moneyShort(p.monthCents, p.currency), style = style(WC.onHero, if (size.width < 180.dp) 24.sp else 28.sp, bold = true), maxLines = 1)
                        Text("Monat · heute ${Fmt.moneyShort(p.todayCents, p.currency)}", style = style(WC.onHeroMuted, WT.small), maxLines = 1)
                        VSpace(4.dp)
                        HeroSparkline(state.spark, size.width, 30.dp, GlanceModifier.fillMaxWidth().defaultWeight())
                        if (size.width >= 180.dp) OpenInvoices(p)
                    }
                } else {
                    Row(modifier = GlanceModifier.fillMaxSize()) {
                        Column(modifier = GlanceModifier.defaultWeight().fillMaxHeight()) {
                            Text(Fmt.moneyShort(p.monthCents, p.currency), style = style(WC.onHero, WT.hero, bold = true), maxLines = 1)
                            Text("Umsatz Monat", style = style(WC.onHeroMuted, WT.small), maxLines = 1)
                            Spacer(GlanceModifier.defaultWeight())
                            Text("Heute " + Fmt.money(p.todayCents, p.currency), style = style(WC.onHero, WT.body, bold = true), maxLines = 1)
                            OpenInvoices(p)
                        }
                        HSpace(8.dp)
                        HeroSparkline(state.spark, size.width / 2, size.height - 50.dp, GlanceModifier.defaultWeight().fillMaxHeight())
                    }
                }
            }
        }
    }

    @Composable
    private fun OpenInvoices(p: PaymentsResponse) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(R.drawable.ic_receipt_long, WC.onHeroMuted, 13.dp)
            HSpace(4.dp)
            val overdue = if (p.overdueCount > 0) " · ${p.overdueCount} überfällig" else ""
            Text("Offen ${Fmt.moneyShort(p.openInvoicesCents, p.currency)}$overdue", style = style(WC.onHeroMuted, WT.small), maxLines = 1)
        }
    }
}

// ---------------------------------------------------------------- Zahl (single KPI)

data class KpiState(val summary: Loaded<Summary>, val history: SummaryHistory?)

class KpiWidget : GoHighWidget<KpiState>(WidgetKind.KPI) {
    override val sizes = setOf(Sizes.S1x1, Sizes.S2x1, Sizes.S2x2)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv): KpiState {
        val r = DataRequest.SummaryOf(env.loc)
        return KpiState(Loaded.of(g.repository.cached(r), g.repository.error(r)), g.repository.history(env.loc))
    }

    override fun demo(env: WidgetEnv, d: DemoData) = KpiState(Loaded.demo(d.summary(env.loc), env.now), null)

    @Composable
    override fun Content(env: WidgetEnv, state: KpiState) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val metric = KpiMetric.of(env.config.metric)
        val target = when (metric) {
            KpiMetric.UNREAD -> DeepLinks.conversations(env.base, env.loc)
            KpiMetric.TASKS_DUE -> DeepLinks.tasks(env.base, env.loc)
            KpiMetric.APPOINTMENTS -> DeepLinks.calendars(env.base, env.loc)
            KpiMetric.MISSED_CALLS -> DeepLinks.calls(env.base, env.loc)
            KpiMetric.OPEN_DEALS, KpiMetric.WON_MONTH -> DeepLinks.opportunities(env.base, env.loc)
            KpiMetric.OPEN_INVOICES, KpiMetric.REVENUE_MONTH, KpiMetric.REVENUE_TODAY -> DeepLinks.invoices(env.base, env.loc)
            KpiMetric.RATING -> DeepLinks.reviews(env.base, env.loc)
            KpiMetric.WEBSITES_DOWN -> DeepLinks.project(env.base, env.loc)
            else -> DeepLinks.dashboard(env.base, env.loc)
        }
        val small = size.width < 110.dp
        HeroFrame(padding = if (small) 6.dp else 10.dp, onClick = actionStartActivity(Launch.web(ctx, target))) {
            Gate(env, state.summary, hero = true, compact = true) { s ->
                val trend = Trends.of(metric, s, state.history)
                if (small) {
                    Column(modifier = GlanceModifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalAlignment = Alignment.CenterVertically) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(metric.format(s), style = style(WC.onHero, if (metric.money) 15.sp else 20.sp, bold = true), maxLines = 1)
                            if (trend != null) TrendIcon(trend, 12.dp)
                        }
                        Text(metric.tiny, style = style(WC.onHeroMuted, 10.sp, center = true), maxLines = 1)
                    }
                } else {
                    Row(modifier = GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                        Box(modifier = GlanceModifier.size(34.dp).background(ImageProvider(R.drawable.widget_tile_bg)), contentAlignment = Alignment.Center) {
                            Icon(metric.icon, WC.onHero, 18.dp)
                        }
                        HSpace(8.dp)
                        Column(modifier = GlanceModifier.defaultWeight()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(metric.format(s), style = style(WC.onHero, 20.sp, bold = true), maxLines = 1)
                                if (trend != null) {
                                    HSpace(2.dp)
                                    TrendIcon(trend, 14.dp)
                                    if (size.height >= 110.dp && trend.label != null) Text(trend.label, style = style(WC.onHeroMuted, WT.small), maxLines = 1)
                                }
                            }
                            Text(metric.short + (env.locationName?.let { " · $it" } ?: ""), style = style(WC.onHeroMuted, WT.small), maxLines = 1)
                            if (size.height >= 110.dp) Text(agoLabel(env, state.summary.fetchedAt) ?: "", style = style(WC.onHeroFaint, 10.sp), maxLines = 1)
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun TrendIcon(t: Trend, size: Dp) {
        val res = when (t.dir) {
            TrendDir.UP -> R.drawable.ic_trending_up
            TrendDir.DOWN -> R.drawable.ic_trending_down
            TrendDir.FLAT -> R.drawable.ic_trending_flat
        }
        // On the gradient: good = white, bad = warm amber so it stands out.
        Icon(res, if (t.good) WC.onHero else androidx.glance.unit.ColorProvider(androidx.compose.ui.graphics.Color(0xFFFDE68A)), size)
    }
}

// ---------------------------------------------------------------- Sprach-Notiz (1×1)

class VoiceWidget : GoHighWidget<Unit>(WidgetKind.VOICE) {
    override val sizes = setOf(Sizes.S1x1, Sizes.S2x1)

    override fun load(context: Context, g: AppGraph, env: WidgetEnv) = Unit

    override fun demo(env: WidgetEnv, d: DemoData) = Unit

    @Composable
    override fun Content(env: WidgetEnv, state: Unit) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val action = actionStartActivity(Launch.quick(ctx, QuickActivity.VOICE, env.loc.takeIf { env.config.location != org.gohigh.android.api.ALL_LOCATIONS }, "w${env.appWidgetId}"))
        HeroFrame(padding = 6.dp, onClick = action) {
            if (size.width < 110.dp) {
                Column(modifier = GlanceModifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = GlanceModifier.size(36.dp).background(ImageProvider(R.drawable.widget_tile_bg)), contentAlignment = Alignment.Center) {
                        Icon(R.drawable.ic_mic, WC.onHero, 22.dp, description = "Sprach-Notiz")
                    }
                    VSpace(2.dp)
                    Text("Notiz", style = style(WC.onHero, 10.sp, bold = true, center = true), maxLines = 1)
                }
            } else {
                Row(modifier = GlanceModifier.fillMaxSize().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = GlanceModifier.size(36.dp).background(ImageProvider(R.drawable.widget_tile_bg)), contentAlignment = Alignment.Center) {
                        Icon(R.drawable.ic_mic, WC.onHero, 22.dp, description = "Sprach-Notiz")
                    }
                    HSpace(8.dp)
                    Column {
                        Text("Sprach-Notiz", style = style(WC.onHero, WT.body, bold = true), maxLines = 1)
                        Text(env.locationName ?: "Antippen", style = style(WC.onHeroMuted, WT.small), maxLines = 1)
                    }
                }
            }
        }
    }
}
