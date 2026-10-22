package org.gohigh.android.widget.ui

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import androidx.glance.LocalContext
import org.gohigh.android.R
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.CacheError
import org.gohigh.android.data.Cached
import org.gohigh.android.widget.Launch
import org.gohigh.android.widget.RefreshAction
import org.gohigh.android.widget.WidgetEnv

/** Widget palette (day/night). Backgrounds with rounded shapes come from drawables (work on every API level). */
object WC {
    val text = ColorProvider(day = Color(0xFF0F172A), night = Color(0xFFF1F5F9))
    val muted = ColorProvider(day = Color(0xFF64748B), night = Color(0xFF94A3B8))
    val accent = ColorProvider(day = Color(0xFF2563EB), night = Color(0xFF60A5FA))
    val header = ColorProvider(day = Color(0xFF1D4ED8), night = Color(0xFFBFDBFE))
    val success = ColorProvider(day = Color(0xFF16A34A), night = Color(0xFF4ADE80))
    val danger = ColorProvider(day = Color(0xFFDC2626), night = Color(0xFFF87171))
    val warning = ColorProvider(day = Color(0xFFD97706), night = Color(0xFFFBBF24))
    val star = ColorProvider(day = Color(0xFFF59E0B), night = Color(0xFFFBBF24))
    val divider = ColorProvider(day = Color(0xFFE2E8F0), night = Color(0xFF1E293B))
    val iconBg = ColorProvider(day = Color(0xFFDBEAFE), night = Color(0xFF1E3A8A))
    val neutralDot = ColorProvider(day = Color(0xFFCBD5E1), night = Color(0xFF475569))
    val onHero = ColorProvider(Color.White)
    val onHeroMuted = ColorProvider(Color(0xD9FFFFFF))
    val onHeroFaint = ColorProvider(Color(0x99FFFFFF))
}

/** Type scale (sp). */
object WT {
    val title: TextUnit = 14.sp
    val body: TextUnit = 13.sp
    val small: TextUnit = 11.sp
    val kpi: TextUnit = 22.sp
    val hero: TextUnit = 30.sp
}

fun style(color: ColorProvider = WC.text, size: TextUnit = WT.body, bold: Boolean = false, center: Boolean = false, medium: Boolean = false) =
    TextStyle(
        color = color,
        fontSize = size,
        fontWeight = when {
            bold -> FontWeight.Bold
            medium -> FontWeight.Medium
            else -> FontWeight.Normal
        },
        textAlign = if (center) TextAlign.Center else TextAlign.Start,
    )

/** Rounded clipping on Android 12+ (older versions get the rounded background drawable only). */
fun GlanceModifier.rounded(): GlanceModifier =
    if (Build.VERSION.SDK_INT >= 31) cornerRadius(android.R.dimen.system_app_widget_background_radius) else this

/** Cached data plus last error, as a widget sees it. */
data class Loaded<T>(val data: T?, val fetchedAt: Long?, val error: String?) {
    companion object {
        fun <T> of(c: Cached<T>?, e: CacheError?): Loaded<T> = Loaded(c?.data, c?.fetchedAt, e?.message)
        fun <T> demo(data: T, at: Long) = Loaded(data, at, null)
    }
}

/** White/dark card with an optional gradient header. */
@Composable
fun CardFrame(content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = GlanceModifier.fillMaxSize().appWidgetBackground().background(ImageProvider(R.drawable.widget_card_bg)).rounded(),
        content = content,
    )
}

/** Brand-gradient card for KPI widgets. */
@Composable
fun HeroFrame(padding: Dp = 12.dp, onClick: Action? = null, content: @Composable ColumnScope.() -> Unit) {
    var m = GlanceModifier.fillMaxSize().appWidgetBackground().background(ImageProvider(R.drawable.widget_hero_bg)).rounded()
    if (onClick != null) m = m.clickable(onClick)
    Column(modifier = m.padding(padding), content = content)
}

@Composable
fun Icon(res: Int, tint: ColorProvider, size: Dp = 18.dp, modifier: GlanceModifier = GlanceModifier, description: String? = null) {
    Image(ImageProvider(res), contentDescription = description, modifier = modifier.size(size), colorFilter = ColorFilter.tint(tint))
}

@Composable
fun IconButton(res: Int, action: Action, tint: ColorProvider, description: String, size: Dp = 36.dp, iconSize: Dp = 20.dp) {
    Box(modifier = GlanceModifier.size(size).clickable(action), contentAlignment = Alignment.Center) {
        Icon(res, tint, iconSize, description = description)
    }
}

/** Round tinted icon (channel badges, list leading icons). */
@Composable
fun IconBadge(res: Int, tint: ColorProvider = WC.accent, bg: ColorProvider = WC.iconBg, size: Dp = 32.dp) {
    Box(
        modifier = GlanceModifier.size(size).background(ImageProvider(R.drawable.widget_circle), colorFilter = ColorFilter.tint(bg)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(res, tint, size * 0.55f)
    }
}

@Composable
fun Dot(color: ColorProvider, size: Dp = 8.dp) {
    Image(ImageProvider(R.drawable.widget_circle), contentDescription = null, modifier = GlanceModifier.size(size), colorFilter = ColorFilter.tint(color))
}

@Composable
fun HSpace(w: Dp) = Spacer(GlanceModifier.width(w))

@Composable
fun VSpace(h: Dp) = Spacer(GlanceModifier.height(h))

@Composable
fun Divider() {
    Box(modifier = GlanceModifier.fillMaxWidth().height(1.dp).background(WC.divider)) {}
}

/** Gradient header: icon, title, "vor x Min.", optional extras and a refresh button. */
@Composable
fun Header(
    title: String,
    icon: Int,
    env: WidgetEnv,
    fetchedAt: Long?,
    open: Action?,
    showAgo: Boolean = true,
    extra: (@Composable RowScope.() -> Unit)? = null,
) {
    val narrow = androidx.glance.LocalSize.current.width < 180.dp
    Row(
        modifier = GlanceModifier.fillMaxWidth().height(42.dp).background(ImageProvider(R.drawable.widget_header_bg)).padding(start = 12.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        var titleMod = GlanceModifier.defaultWeight()
        if (open != null) titleMod = titleMod.clickable(open)
        Row(modifier = titleMod, verticalAlignment = Alignment.CenterVertically) {
            if (!narrow) {
                Icon(icon, WC.header, 18.dp)
                HSpace(7.dp)
            }
            Text(title, style = style(WC.header, if (narrow) 13.sp else WT.title, bold = true), maxLines = 1)
            val ago = if (showAgo && env.auth == AuthStatus.ACTIVE) agoLabel(env, fetchedAt) else null
            if (ago != null) {
                HSpace(6.dp)
                Text(ago, style = style(WC.muted, WT.small), maxLines = 1)
            }
        }
        if (env.auth == AuthStatus.ACTIVE) extra?.invoke(this)
        IconButton(R.drawable.ic_refresh, actionRunCallback<RefreshAction>(), WC.header, "Aktualisieren", size = if (narrow) 30.dp else 34.dp, iconSize = 18.dp)
    }
}

/** Header row for hero widgets (white on gradient). */
@Composable
fun HeroHeader(title: String, icon: Int, env: WidgetEnv, fetchedAt: Long?, showAgo: Boolean = true, refresh: Boolean = true) {
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, WC.onHero, 16.dp)
        HSpace(6.dp)
        Text(title, style = style(WC.onHero, WT.title, bold = true), maxLines = 1)
        val ago = if (showAgo && env.auth == AuthStatus.ACTIVE) agoLabel(env, fetchedAt) else null
        Spacer(GlanceModifier.defaultWeight())
        if (ago != null) Text(ago, style = style(WC.onHeroFaint, WT.small), maxLines = 1)
        if (refresh) IconButton(R.drawable.ic_refresh, actionRunCallback<RefreshAction>(), WC.onHeroMuted, "Aktualisieren", size = 28.dp, iconSize = 16.dp)
    }
}

fun agoLabel(env: WidgetEnv, fetchedAt: Long?): String? = when {
    env.demo -> "Demo"
    fetchedAt == null -> null
    else -> org.gohigh.android.util.Fmt.ago(fetchedAt, env.now)
}

@Composable
fun PillButton(label: String, action: Action, icon: Int? = null) {
    Row(
        modifier = GlanceModifier.background(ImageProvider(R.drawable.widget_button_bg)).padding(horizontal = 14.dp, vertical = 7.dp).clickable(action),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, WC.onHero, 16.dp)
            HSpace(6.dp)
        }
        Text(label, style = style(WC.onHero, WT.body, bold = true), maxLines = 1)
    }
}

/** Centered message used for empty, error, loading and signed-out states. */
@Composable
fun StateMessage(
    icon: Int,
    title: String,
    subtitle: String? = null,
    button: String? = null,
    action: Action? = null,
    tint: ColorProvider = WC.accent,
    textColor: ColorProvider = WC.text,
    subColor: ColorProvider = WC.muted,
    compact: Boolean = false,
) {
    Column(
        modifier = GlanceModifier.fillMaxSize().padding(10.dp).let { if (action != null && (button == null || compact)) it.clickable(action) else it },
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, tint, if (compact) 22.dp else 28.dp)
        VSpace(6.dp)
        Text(title, style = style(textColor, if (compact) WT.small else WT.title, bold = true, center = true), maxLines = 2)
        if (subtitle != null && !compact) {
            VSpace(2.dp)
            Text(subtitle, style = style(subColor, WT.small, center = true), maxLines = 2)
        }
        if (button != null && action != null && !compact) {
            VSpace(8.dp)
            PillButton(button, action)
        }
    }
}

/**
 * Shows sign-in / error / loading states, or [content] when data is there. Keeps the widget useful offline:
 * cached data wins over a fresh error.
 */
@Composable
fun <T> Gate(env: WidgetEnv, loaded: Loaded<T>, hero: Boolean = false, compact: Boolean = false, content: @Composable (T) -> Unit) {
    val ctx = LocalContext.current
    val textColor = if (hero) WC.onHero else WC.text
    val subColor = if (hero) WC.onHeroMuted else WC.muted
    val tint = if (hero) WC.onHero else WC.accent
    when {
        env.auth == AuthStatus.SIGNED_OUT -> StateMessage(
            R.drawable.ic_lock, "In HyperLevel anmelden", "Einmal in der App einloggen – dann füllt sich das Widget.",
            "Anmelden", actionStartActivity(Launch.signIn(ctx)), tint, textColor, subColor, compact,
        )
        env.auth == AuthStatus.EXPIRED -> StateMessage(
            R.drawable.ic_lock, "Neu anmelden", "Die Anmeldung ist abgelaufen.",
            "Neu anmelden", actionStartActivity(Launch.signIn(ctx)), tint, textColor, subColor, compact,
        )
        loaded.data != null -> content(loaded.data)
        loaded.error != null -> StateMessage(
            R.drawable.ic_cloud_off, "Keine Daten", loaded.error,
            "Erneut versuchen", actionRunCallback<RefreshAction>(), if (hero) WC.onHero else WC.danger, textColor, subColor, compact,
        )
        else -> StateMessage(R.drawable.ic_sync, "Wird geladen…", null, null, actionRunCallback<RefreshAction>(), tint, textColor, subColor, compact)
    }
}

/** "Alles erledigt 🎉"-style empty state. */
@Composable
fun Empty(title: String, subtitle: String? = null, icon: Int = R.drawable.ic_done_all, compact: Boolean = false) =
    StateMessage(icon, title, subtitle, tint = WC.success, compact = compact)

@Composable
fun WidgetTheme(content: @Composable () -> Unit) = GlanceTheme(content = content)

/** Small rounded label chip. */
@Composable
fun Chip(text: String, color: ColorProvider = WC.header) {
    Box(modifier = GlanceModifier.background(ImageProvider(R.drawable.widget_chip_bg)).padding(horizontal = 7.dp, vertical = 2.dp)) {
        Text(text, style = style(color, WT.small, medium = true), maxLines = 1)
    }
}

/** Material Symbol for a conversation channel. */
fun channelIcon(channel: String): Int = when (channel.lowercase()) {
    "email", "mail" -> R.drawable.ic_mail
    "sms" -> R.drawable.ic_sms
    "whatsapp" -> R.drawable.ic_chat
    "instagram" -> R.drawable.ic_photo_camera
    "messenger", "facebook" -> R.drawable.ic_forum
    "call", "phone", "voice" -> R.drawable.ic_call
    "livechat", "chat", "webchat" -> R.drawable.ic_forum
    else -> R.drawable.ic_chat
}

fun channelLabel(channel: String): String = when (channel.lowercase()) {
    "email", "mail" -> "E-Mail"
    "sms" -> "SMS"
    "whatsapp" -> "WhatsApp"
    "instagram" -> "Instagram"
    "messenger" -> "Messenger"
    "facebook" -> "Facebook"
    "livechat", "chat", "webchat" -> "Live-Chat"
    "call", "phone", "voice" -> "Telefon"
    "x", "twitter" -> "X"
    "linkedin" -> "LinkedIn"
    "tiktok" -> "TikTok"
    "google", "gbp" -> "Google"
    else -> channel.replaceFirstChar { it.uppercase() }
}
