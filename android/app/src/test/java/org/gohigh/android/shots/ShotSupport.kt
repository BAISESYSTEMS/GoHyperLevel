package org.gohigh.android.shots

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.view.View
import android.widget.FrameLayout
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.compose
import androidx.glance.appwidget.provideContent
import org.gohigh.android.widget.GoHighWidget
import org.gohigh.android.widget.WidgetEnv
import org.gohigh.android.widget.ui.WidgetTheme
import kotlinx.coroutines.runBlocking
import java.io.File

/** Renders a widget's real Glance content (no AppGraph, fixed env/state). */
class ShotWidget<S>(private val inner: GoHighWidget<S>, private val env: WidgetEnv, private val state: S) : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { WidgetTheme { inner.Content(env, state) } }
    }
}

object Shots {
    val dir: File = File(System.getProperty("gohigh.shots.dir") ?: "build/shots").apply { mkdirs() }

    /** Launcher-like cell size (5-column grid on a ~412dp wide phone). */
    fun cellsToDp(w: Int, h: Int): DpSize = DpSize((w * 82 - 16).dp, (h * 96 - 16).dp)

    /** What SizeMode.Responsive would pick: the largest breakpoint that fits, else the smallest. */
    fun breakpoint(sizes: Set<DpSize>, actual: DpSize): DpSize {
        val fitting = sizes.filter { it.width <= actual.width && it.height <= actual.height }
        return fitting.maxByOrNull { it.width.value * it.height.value } ?: sizes.minBy { it.width.value * it.height.value }
    }

    /** Composes to RemoteViews, inflates them like a launcher would and draws them to a bitmap. */
    fun <S> renderWidget(context: Context, widget: GoHighWidget<S>, env: WidgetEnv, state: S, actual: DpSize): Bitmap {
        val bp = breakpoint(widget.sizes, actual)
        val rv = runBlocking { ShotWidget(widget, env, state).compose(context, size = bp) }
        val d = context.resources.displayMetrics.density
        val w = (actual.width.value * d).toInt()
        val h = (actual.height.value * d).toInt()
        val host = android.appwidget.AppWidgetHostView(context)
        val view = rv.apply(context, host)
        host.addView(view, FrameLayout.LayoutParams(w, h))
        return draw(host, w, h)
    }

    fun draw(view: View, w: Int, h: Int): Bitmap {
        view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, w, h)
        // Collection views (ListView) populate on layout; run a second pass so rows are measured.
        view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, w, h)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bmp))
        return bmp
    }

    /** Puts the widget on a wallpaper-like background with a margin (looks like the home screen). */
    fun onWallpaper(widget: Bitmap, night: Boolean, margin: Int = 36): Bitmap {
        val out = Bitmap.createBitmap(widget.width + margin * 2, widget.height + margin * 2, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val colors = if (night) intArrayOf(0xFF0B1020.toInt(), 0xFF1E1B4B.toInt()) else intArrayOf(0xFFBFDBFE.toInt(), 0xFFFDE68A.toInt())
        c.drawRect(0f, 0f, out.width.toFloat(), out.height.toFloat(), Paint().apply { shader = LinearGradient(0f, 0f, out.width.toFloat(), out.height.toFloat(), colors[0], colors[1], Shader.TileMode.CLAMP) })
        c.drawBitmap(widget, margin.toFloat(), margin.toFloat(), null)
        return out
    }

    fun save(bmp: Bitmap, name: String): File {
        val f = File(dir, "$name.png")
        f.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return f
    }
}
