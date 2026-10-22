package org.gohigh.android.ui.main

import android.view.View
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.ui.common.IconCircle
import org.gohigh.android.ui.common.LogoBadge
import org.gohigh.android.ui.quick.QuickActivity
import org.gohigh.android.ui.theme.Brand
import org.gohigh.android.update.UpdateController
import org.gohigh.android.update.UpdateDialog

sealed interface MenuAction {
    data object RELOAD : MenuAction
    data object HOME : MenuAction
    data object SETTINGS : MenuAction
    data object BROWSER : MenuAction
    data object SHARE : MenuAction
    data object REPORT : MenuAction
    data class Quick(val action: String) : MenuAction
}

@Composable
fun MainScreen(
    /** The view that holds the WebView (the WebView itself is replaced after a lost render process). */
    web: View,
    state: MainUiState,
    showMenuButton: Boolean,
    updates: UpdateController,
    onRetry: () -> Unit,
    onSignIn: () -> Unit,
    onMenuAction: (MenuAction) -> Unit,
    fallbackActions: WebFallbackActions,
    /** The camera cutout and navigation bar in CSS px (left, right, bottom): the web app keeps its content clear of them itself. */
    onEdgeInsets: (EdgeInsets) -> Unit = {},
) {
    // Edge to edge: the WebView only stays below the status bar and above the keyboard. Under the camera cutout (landscape) and the
    // navigation bar it draws its own background; the page gets those insets as --sal/--sar/--sab (WebView reports env() as 0).
    val edges = WindowInsets.displayCutout.union(WindowInsets.navigationBars)
    val density = LocalDensity.current
    val dir = LocalLayoutDirection.current
    val imeOpen = WindowInsets.ime.getBottom(density) > 0
    val insets = with(density) {
        val left = (if (dir == LayoutDirection.Ltr) edges.getLeft(this, dir) else edges.getRight(this, dir)).toDp().value
        val right = (if (dir == LayoutDirection.Ltr) edges.getRight(this, dir) else edges.getLeft(this, dir)).toDp().value
        EdgeInsets(left, right, if (imeOpen) 0f else edges.getBottom(this).toDp().value)
    }
    LaunchedEffect(insets) { onEdgeInsets(insets) }
    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars.union(WindowInsets.ime))) {
            AnimatedVisibility(visible = state.auth == AuthStatus.EXPIRED) { ExpiredBanner(onSignIn) }
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(factory = { web }, modifier = Modifier.fillMaxSize())
                if (state.progress in 0.01f..0.99f) {
                    LinearProgressIndicator(
                        progress = { state.progress },
                        modifier = Modifier.fillMaxWidth().height(2.dp).align(Alignment.TopCenter),
                        trackColor = Color.Transparent,
                    )
                }
                Box(Modifier.fillMaxSize().windowInsetsPadding(edges)) {
                    state.loadError?.let { OfflineScreen(it, onRetry) }
                    state.fallback?.let { WebFallbackScreen(it, sending = state.sending, actions = fallbackActions) }
                    if (showMenuButton) {
                        MenuFab(Modifier.align(Alignment.BottomStart).padding(start = 12.dp, bottom = 14.dp)) { state.menuOpen = true }
                    }
                }
            }
        }
        if (state.menuOpen) AppMenuSheet(onDismiss = { state.menuOpen = false }, onAction = onMenuAction)
        UpdateDialog(updates)
    }
}

@Composable
private fun ExpiredBanner(onSignIn: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.ic_lock), null, tint = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Text(
                "Die App ist abgemeldet. Melde dich neu an, damit Widgets und Mitteilungen wieder laufen.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onSignIn) { Text("Neu anmelden") }
        }
    }
}

@Composable
private fun OfflineScreen(error: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        IconCircle(R.drawable.ic_cloud_off, size = 64.dp)
        Spacer(Modifier.height(16.dp))
        Text("Keine Verbindung", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground)
        Spacer(Modifier.height(6.dp))
        Text(
            "HyperLevel ist gerade nicht erreichbar. Deine Widgets zeigen weiter die letzten Daten.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(4.dp))
        Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(20.dp))
        Button(onClick = onRetry) { Text("Erneut versuchen") }
    }
}

@Composable
private fun MenuFab(modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier.size(44.dp).shadow(6.dp, CircleShape).clip(CircleShape).background(Brand.Gradient).alpha(0.95f).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(R.drawable.ic_logo_mark), contentDescription = "HyperLevel-Menü", tint = Color.White, modifier = Modifier.size(24.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppMenuSheet(onDismiss: () -> Unit, onAction: (MenuAction) -> Unit) {
    val ctx = LocalContext.current
    val g = AppGraph.get(ctx)
    val user = g.session.user
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Row(modifier = Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                LogoBadge(40.dp)
                Spacer(Modifier.width(12.dp))
                Column {
                    Text(user?.name?.ifBlank { null } ?: "HyperLevel", style = MaterialTheme.typography.titleMedium)
                    Text(android.net.Uri.parse(g.settings.baseUrl).host ?: g.settings.baseUrl, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(16.dp))
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                QuickTile(R.drawable.ic_task_alt, "Aufgabe") { onAction(MenuAction.Quick(QuickActivity.TASK)) }
                QuickTile(R.drawable.ic_person_add, "Kontakt") { onAction(MenuAction.Quick(QuickActivity.CONTACT)) }
                QuickTile(R.drawable.ic_edit_note, "Notiz") { onAction(MenuAction.Quick(QuickActivity.NOTE)) }
                QuickTile(R.drawable.ic_mic, "Sprache") { onAction(MenuAction.Quick(QuickActivity.VOICE)) }
                QuickTile(R.drawable.ic_call, "Anruf") { onAction(MenuAction.Quick(QuickActivity.CALL)) }
            }
            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            MenuRow(R.drawable.ic_home, "Startseite") { onAction(MenuAction.HOME) }
            MenuRow(R.drawable.ic_refresh, "Neu laden") { onAction(MenuAction.RELOAD) }
            MenuRow(R.drawable.ic_share, "Link teilen") { onAction(MenuAction.SHARE) }
            MenuRow(R.drawable.ic_open_in_new, "Im Browser öffnen") { onAction(MenuAction.BROWSER) }
            MenuRow(R.drawable.ic_bug_report, "Fehler melden") { onAction(MenuAction.REPORT) }
            MenuRow(R.drawable.ic_settings, "App-Einstellungen") { onAction(MenuAction.SETTINGS) }
        }
    }
}

@Composable
private fun QuickTile(icon: Int, label: String, onClick: () -> Unit) {
    Column(
        modifier = Modifier.clip(MaterialTheme.shapes.medium).clickable(onClick = onClick).padding(horizontal = 6.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        IconCircle(icon, size = 48.dp)
        Spacer(Modifier.height(6.dp))
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun MenuRow(icon: Int, label: String, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 22.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(icon), null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(16.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

/** Insets the page must keep its content clear of, in CSS px (= dp in the WebView). */
data class EdgeInsets(val left: Float, val right: Float, val bottom: Float) {
    /** Sets them as custom properties on the page root (inline style beats the stylesheet's env() defaults). */
    fun script(): String =
        "(function(){var s=document.documentElement.style;s.setProperty('--sal','${left.toInt()}px');" +
            "s.setProperty('--sar','${right.toInt()}px');s.setProperty('--sab','${bottom.toInt()}px');})()"
}
