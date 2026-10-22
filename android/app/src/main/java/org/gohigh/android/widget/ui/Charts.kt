package org.gohigh.android.widget.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import kotlin.math.max
import kotlin.math.min

/**
 * Small bitmaps for widgets (RemoteViews cannot draw paths): a smooth sparkline with gradient fill and
 * rounded progress bars. Sizes are in pixels and capped to keep the RemoteViews payload small.
 */
object Charts {
    private const val MAX_W = 900
    private const val MAX_H = 300

    fun sparkline(
        values: List<Number>,
        widthPx: Int,
        heightPx: Int,
        lineColor: Int,
        fillTop: Int,
        fillBottom: Int,
        strokePx: Float,
        dotColor: Int? = null,
    ): Bitmap {
        val w = widthPx.coerceIn(8, MAX_W)
        val h = heightPx.coerceIn(8, MAX_H)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val v = values.map { it.toDouble() }
        if (v.size < 2) return bmp
        val pad = strokePx * 1.5f
        val padX = if (dotColor != null) strokePx * 3f else pad
        val minV = min(0.0, v.min())
        val maxV = max(v.max(), minV + 1)
        fun x(i: Int) = padX + (w - 2 * padX) * i / (v.size - 1)
        val padTop = if (dotColor != null) strokePx * 3f else pad
        fun y(d: Double) = (h - pad - (h - pad - padTop) * ((d - minV) / (maxV - minV))).toFloat()

        val line = Path()
        val xs = FloatArray(v.size) { x(it) }
        val ys = FloatArray(v.size) { y(v[it]) }
        val tangents = monotoneTangents(xs, ys)
        line.moveTo(xs[0], ys[0])
        for (i in 1 until v.size) {
            val dx = (xs[i] - xs[i - 1]) / 3f
            line.cubicTo(xs[i - 1] + dx, ys[i - 1] + tangents[i - 1] * dx, xs[i] - dx, ys[i] - tangents[i] * dx, xs[i], ys[i])
        }
        val fill = Path(line).apply {
            lineTo(x(v.size - 1), h.toFloat())
            lineTo(x(0), h.toFloat())
            close()
        }
        c.drawPath(fill, Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            shader = LinearGradient(0f, 0f, 0f, h.toFloat(), fillTop, fillBottom, Shader.TileMode.CLAMP)
        })
        c.drawPath(line, Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = strokePx
            color = lineColor
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        })
        if (dotColor != null) {
            val lx = x(v.size - 1)
            val ly = y(v.last())
            c.drawCircle(lx, ly, strokePx * 2.2f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = dotColor })
            c.drawCircle(lx, ly, strokePx * 1.1f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = lineColor })
        }
        return bmp
    }

    /** Fritsch–Carlson tangents: smooth curve that never overshoots the data (no dips below zero). */
    private fun monotoneTangents(x: FloatArray, y: FloatArray): FloatArray {
        val n = x.size
        val d = FloatArray(n - 1) { (y[it + 1] - y[it]) / (x[it + 1] - x[it]) }
        val m = FloatArray(n)
        m[0] = d[0]
        m[n - 1] = d[n - 2]
        for (i in 1 until n - 1) m[i] = if (d[i - 1] * d[i] <= 0f) 0f else (d[i - 1] + d[i]) / 2f
        for (i in 0 until n - 1) {
            if (d[i] == 0f) {
                m[i] = 0f
                m[i + 1] = 0f
                continue
            }
            val a = m[i] / d[i]
            val b = m[i + 1] / d[i]
            val h = a * a + b * b
            if (h > 9f) {
                val t = 3f / kotlin.math.sqrt(h)
                m[i] = t * a * d[i]
                m[i + 1] = t * b * d[i]
            }
        }
        return m
    }

    /** Rounded horizontal bar; [fraction] 0..1 of the width is filled. */
    fun bar(fraction: Float, widthPx: Int, heightPx: Int, fillStart: Int, fillEnd: Int, track: Int): Bitmap {
        val w = widthPx.coerceIn(8, MAX_W)
        val h = heightPx.coerceIn(2, 60)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val r = h / 2f
        c.drawRoundRect(RectF(0f, 0f, w.toFloat(), h.toFloat()), r, r, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = track })
        val f = fraction.coerceIn(0f, 1f)
        if (f > 0f) {
            val fw = max(h.toFloat(), w * f)
            c.drawRoundRect(RectF(0f, 0f, fw, h.toFloat()), r, r, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                shader = LinearGradient(0f, 0f, fw, 0f, fillStart, fillEnd, Shader.TileMode.CLAMP)
            })
        }
        return bmp
    }
}
