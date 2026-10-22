package org.gohigh.android.shots

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.gohigh.android.api.DemoData
import org.gohigh.android.widget.KpiMetric
import org.gohigh.android.widget.WidgetConfig
import org.gohigh.android.widget.WidgetEnv
import org.gohigh.android.widget.WidgetKind
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Regenerates the widget-picker preview images (android:previewImage) from the real widget code.
 * Only runs with -PpreviewDir=app/src/main/res/drawable-nodpi (see README); convert to WebP afterwards.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class PreviewImagesTest {
    private val target = mapOf(
        WidgetKind.COCKPIT to (4 to 2), WidgetKind.INBOX to (4 to 3), WidgetKind.TASKS to (4 to 3),
        WidgetKind.APPOINTMENTS to (4 to 2), WidgetKind.PIPELINE to (4 to 3), WidgetKind.PROJECTS to (4 to 3),
        WidgetKind.QUICK to (4 to 1), WidgetKind.REVENUE to (3 to 2), WidgetKind.CALLS to (4 to 2),
        WidgetKind.REVIEWS to (3 to 2), WidgetKind.VOICE to (1 to 1), WidgetKind.KPI to (1 to 1), WidgetKind.SOCIAL to (4 to 2),
    )

    @Test fun previews() {
        val dir = System.getProperty("gohigh.preview.dir")?.takeIf { it.isNotBlank() }
        assumeTrue("set -PpreviewDir to regenerate preview images", dir != null)
        val out = File(dir!!).apply { mkdirs() }
        RuntimeEnvironment.setQualifiers("+notnight")
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        for ((kind, cells) in target) {
            @Suppress("UNCHECKED_CAST")
            val widget = kind.widget() as org.gohigh.android.widget.GoHighWidget<Any?>
            val config = if (kind == WidgetKind.KPI) WidgetConfig(metric = KpiMetric.LEADS_TODAY.key) else WidgetConfig()
            val env = WidgetEnv.preview(kind, config)
            val bmp = Shots.renderWidget(ctx, widget, env, widget.demo(env, DemoData(env.now)), Shots.cellsToDp(cells.first, cells.second))
            File(out, "preview_${kind.name.lowercase()}.png").outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
