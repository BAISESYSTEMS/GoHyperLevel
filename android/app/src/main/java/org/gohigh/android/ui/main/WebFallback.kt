package org.gohigh.android.ui.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.gohigh.android.R
import org.gohigh.android.ui.common.IconCircle

/**
 * Native error screen over the WebView: the page did not start (empty page, the web app's own failure page, page never
 * finished, render process lost over and over, server error). Says why, shows the last errors and the WebView version,
 * and has the four ways out: Neu laden, Cache & Offline-Daten löschen, Im Browser öffnen, Diagnose senden.
 * An outdated Android System WebView gets its own hint with a link to its Play Store page.
 */
@Composable
fun WebFallbackScreen(info: FallbackInfo, sending: Boolean, actions: WebFallbackActions, modifier: Modifier = Modifier) {
    // A Surface: texts without their own colour take the theme's, also in dark mode.
    Surface(
        // The page below must not receive touches meant for this screen.
        modifier = modifier.fillMaxSize().pointerInput(Unit) {},
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(start = 24.dp, end = 24.dp, top = 32.dp, bottom = 96.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            FallbackContent(info, sending, actions)
        }
    }
}

@Composable
private fun ColumnScope.FallbackContent(info: FallbackInfo, sending: Boolean, actions: WebFallbackActions) {
    IconCircle(R.drawable.ic_warning, size = 64.dp)
    Spacer(Modifier.height(16.dp))
    Text(FallbackInfo.TITLE, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
    Spacer(Modifier.height(6.dp))
    Text(info.reason, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)

    if (info.tooOld) {
        Spacer(Modifier.height(16.dp))
        Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("„Android System WebView“ ist zu alt", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onErrorContainer)
                Spacer(Modifier.height(4.dp))
                Text(
                    "Installiert ist Version ${info.webView.versionName}, HyperLevel braucht mindestens $MIN_WEBVIEW_MAJOR. Bitte aktualisiere „Android System WebView“ (oder Chrome) im Play Store und öffne HyperLevel danach neu.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                info.updatePackage?.let { pkg ->
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { actions.updateWebView(pkg) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Im Play Store aktualisieren") }
                }
            }
        }
    }

    Spacer(Modifier.height(16.dp))
    Text(
        "WebView: ${info.webView.label}",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )

    if (info.errors.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Letzte Fehler", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                info.errors.forEach { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
            }
        }
    }

    Spacer(Modifier.height(24.dp))
    Button(onClick = actions::reload, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
        Icon(painterResource(R.drawable.ic_refresh), null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Neu laden")
    }
    Spacer(Modifier.height(8.dp))
    OutlinedButton(onClick = actions::clearData, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Cache & Offline-Daten löschen") }
    Spacer(Modifier.height(8.dp))
    OutlinedButton(onClick = actions::openInBrowser, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
        Icon(painterResource(R.drawable.ic_open_in_new), null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Im Browser öffnen")
    }
    Spacer(Modifier.height(8.dp))
    OutlinedButton(onClick = actions::sendDiagnostics, enabled = !sending, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
        if (sending) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
            Text("Wird gesendet …")
        } else {
            Icon(painterResource(R.drawable.ic_bug_report), null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Diagnose senden")
        }
    }
}
