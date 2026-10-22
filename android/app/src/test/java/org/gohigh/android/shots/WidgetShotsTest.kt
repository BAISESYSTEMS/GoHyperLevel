package org.gohigh.android.shots

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.gohigh.android.api.DemoData
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.widget.AppointmentsWidget
import org.gohigh.android.widget.CallsWidget
import org.gohigh.android.widget.CockpitWidget
import org.gohigh.android.widget.GoHighWidget
import org.gohigh.android.widget.InboxWidget
import org.gohigh.android.widget.KpiMetric
import org.gohigh.android.widget.KpiWidget
import org.gohigh.android.widget.PipelineWidget
import org.gohigh.android.widget.ProjectsWidget
import org.gohigh.android.widget.QuickActionsWidget
import org.gohigh.android.widget.RevenueWidget
import org.gohigh.android.widget.ReviewsWidget
import org.gohigh.android.widget.SocialWidget
import org.gohigh.android.widget.TasksWidget
import org.gohigh.android.widget.VoiceWidget
import org.gohigh.android.widget.WidgetConfig
import org.gohigh.android.widget.WidgetEnv
import org.gohigh.android.widget.ui.Loaded
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

/**
 * Renders every widget (several sizes, light + dark, plus empty/error/signed-out states) from the real
 * Glance code → RemoteViews → inflated views → PNG. Output: -PshotsDir=… (default app/build/shots).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi")
class WidgetShotsTest {
    private val ctx: Context get() = ApplicationProvider.getApplicationContext()
    private val now = Instant.parse("2026-10-04T08:12:00Z").toEpochMilli()
    private val demo = DemoData(now)

    private fun <S> shot(widget: GoHighWidget<S>, w: Int, h: Int, name: String, config: WidgetConfig = WidgetConfig(), state: ((WidgetEnv) -> S)? = null, auth: AuthStatus = AuthStatus.ACTIVE) {
        for (night in listOf(false, true)) {
            RuntimeEnvironment.setQualifiers(if (night) "+night" else "+notnight")
            val env = WidgetEnv.preview(widget.kind, config, now).copy(auth = auth)
            val s = state?.invoke(env) ?: widget.demo(env, demo)
            val bmp = Shots.renderWidget(ctx, widget, env, s, Shots.cellsToDp(w, h))
            Shots.save(Shots.onWallpaper(bmp, night), "$name-${w}x$h-${if (night) "dark" else "light"}")
        }
    }

    @Test fun cockpit() {
        shot(CockpitWidget(), 2, 2, "01-cockpit")
        shot(CockpitWidget(), 4, 2, "01-cockpit")
        shot(CockpitWidget(), 5, 3, "01-cockpit")
    }

    @Test fun inbox() {
        shot(InboxWidget(), 3, 2, "02-inbox")
        shot(InboxWidget(), 5, 4, "02-inbox")
        shot(InboxWidget(), 4, 2, "02-inbox-empty", state = { Loaded(emptyList(), now - 60_000, null) })
    }

    @Test fun tasks() {
        shot(TasksWidget(), 2, 2, "03-tasks")
        shot(TasksWidget(), 4, 3, "03-tasks")
        shot(TasksWidget(), 4, 2, "03-tasks-empty", state = { Loaded(emptyList(), now - 60_000, null) })
    }

    @Test fun appointments() {
        shot(AppointmentsWidget(), 3, 2, "04-appointments")
        shot(AppointmentsWidget(), 5, 3, "04-appointments")
    }

    @Test fun pipeline() {
        shot(PipelineWidget(), 4, 2, "05-pipeline")
        shot(PipelineWidget(), 5, 3, "05-pipeline")
    }

    @Test fun projects() {
        shot(ProjectsWidget(), 3, 2, "06-projects")
        shot(ProjectsWidget(), 5, 4, "06-projects")
    }

    @Test fun quickActions() {
        shot(QuickActionsWidget(), 4, 1, "07-quick")
        shot(QuickActionsWidget(), 2, 2, "07-quick")
        shot(QuickActionsWidget(), 4, 2, "07-quick")
    }

    @Test fun revenue() {
        shot(RevenueWidget(), 2, 2, "08-revenue")
        shot(RevenueWidget(), 4, 2, "08-revenue")
    }

    @Test fun calls() {
        shot(CallsWidget(), 3, 2, "09-calls")
        shot(CallsWidget(), 5, 3, "09-calls")
    }

    @Test fun reviews() {
        shot(ReviewsWidget(), 2, 2, "10-reviews")
        shot(ReviewsWidget(), 4, 2, "10-reviews")
    }

    @Test fun voice() {
        shot(VoiceWidget(), 1, 1, "11-voice")
        shot(VoiceWidget(), 2, 1, "11-voice")
    }

    @Test fun kpi() {
        shot(KpiWidget(), 1, 1, "12-kpi", WidgetConfig(metric = KpiMetric.LEADS_TODAY.key))
        shot(KpiWidget(), 2, 1, "12-kpi", WidgetConfig(metric = KpiMetric.REVENUE_MONTH.key))
        shot(KpiWidget(), 1, 1, "12-kpi-unread", WidgetConfig(metric = KpiMetric.UNREAD.key))
    }

    @Test fun social() {
        shot(SocialWidget(), 3, 2, "13-social")
        shot(SocialWidget(), 4, 3, "13-social")
    }

    @Test fun states() {
        shot(InboxWidget(), 4, 2, "20-state-signed-out", auth = AuthStatus.SIGNED_OUT)
        shot(CockpitWidget(), 2, 2, "20-state-expired", auth = AuthStatus.EXPIRED)
        shot(TasksWidget(), 4, 2, "20-state-error", state = { Loaded(null, null, "Keine Verbindung zum Server") })
        shot(CallsWidget(), 3, 2, "20-state-loading", state = { Loaded(null, null, null) })
    }
}
