package org.gohigh.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.gohigh.android.R
import org.gohigh.android.api.ApiUser
import org.gohigh.android.api.DeviceInfo
import org.gohigh.android.api.LocationInfo
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.NotifyCategory
import org.gohigh.android.ui.common.LocationPicker
import org.gohigh.android.ui.common.LogoBadge
import org.gohigh.android.ui.common.Section
import org.gohigh.android.ui.common.SettingRow
import org.gohigh.android.ui.main.MIN_WEBVIEW_MAJOR
import org.gohigh.android.ui.theme.Brand
import org.gohigh.android.util.Fmt

data class SettingsState(
    val user: ApiUser?,
    val auth: AuthStatus,
    val server: String,
    val demo: Boolean,
    val devices: List<DeviceInfo>?,
    val notify: Map<NotifyCategory, Boolean>,
    val notifyPermission: Boolean,
    val refreshMinutes: Int,
    val defaultLocation: String?,
    val locations: List<LocationInfo>,
    val dynamicColor: Boolean,
    val showMenuButton: Boolean,
    val version: String,
    val debugUnlocked: Boolean,
    val widgetCount: Int,
    val shakeToReport: Boolean = false,
    val diag: DiagState = DiagState(),
    val now: Long = System.currentTimeMillis(),
)

/** Einstellungen → Diagnose: what helps when the web view stays blank. */
data class DiagState(
    /** Package and version of the system WebView. */
    val webView: String = "",
    val webViewTooOld: Boolean = false,
    val minWebView: Int = MIN_WEBVIEW_MAJOR,
    val server: String = "",
    /** Last load of the web app, e.g. "Geladen · vor 3 Min.". */
    val status: String = "",
    val statusFailed: Boolean = false,
    /** Newest console / HTTP errors of the web view, newest last. */
    val errors: List<String> = emptyList(),
)

interface SettingsActions {
    fun back()
    fun openDevicesInWeb()
    fun revokeDevice(d: DeviceInfo)
    fun setNotify(c: NotifyCategory, on: Boolean)
    fun requestNotifyPermission()
    fun openSystemNotifications()
    fun setRefresh(minutes: Int)
    fun refreshNow()
    fun setDefaultLocation(id: String)
    fun setDynamicColor(on: Boolean)
    fun setShowMenuButton(on: Boolean)
    fun checkUpdate()
    fun versionTapped()
    fun signIn()
    fun logout()
    fun setServer(url: String)
    fun setDemo(on: Boolean)
    fun resetFeed()
    fun reportBug() {}
    fun openMyReports() {}
    fun openWishes() {}
    fun setShakeToReport(on: Boolean) {}
    fun sendDiagnostics() {}
    fun resetWebData() {}
}

@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(s: SettingsState, a: SettingsActions) {
    var confirmLogout by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).verticalScroll(rememberScrollState())) {
        // ---- gradient header with account
        Box(modifier = Modifier.fillMaxWidth().background(Brand.Gradient)) {
            Column(modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(start = 8.dp, end = 20.dp, bottom = 22.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = a::back) { Icon(painterResource(R.drawable.ic_close), "Schließen", tint = Color.White) }
                    Text("Einstellungen", style = MaterialTheme.typography.titleLarge, color = Color.White)
                }
                Spacer(Modifier.height(10.dp))
                Row(modifier = Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(56.dp).clip(RoundedCornerShape(18.dp)).background(Color.White.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) {
                        LogoBadge(44.dp)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(s.user?.name?.ifBlank { null } ?: "Nicht angemeldet", style = MaterialTheme.typography.titleMedium, color = Color.White)
                        Text(s.user?.email?.ifBlank { null } ?: s.server.removePrefix("https://"), style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.85f))
                        Spacer(Modifier.height(6.dp))
                        StatusPill(s)
                    }
                }
            }
        }

        if (s.auth != AuthStatus.ACTIVE) {
            Section("Anmeldung") {
                SettingRow(
                    R.drawable.ic_lock,
                    if (s.auth == AuthStatus.EXPIRED) "Neu anmelden" else "In der App anmelden",
                    "Einmal im HyperLevel-Login anmelden – dann verbindet sich die App von selbst.",
                    onClick = a::signIn,
                )
            }
        }

        Section("Konto") {
            SettingRow(R.drawable.ic_account_circle, s.user?.name?.ifBlank { null } ?: "–", listOfNotNull(s.user?.email, s.user?.role?.let { roleLabel(it) }).joinToString(" · ").ifBlank { null })
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_devices, "Geräte (App)", "Verwalten auch im Web unter Einstellungen → Mein Konto → Geräte (App).", onClick = a::openDevicesInWeb, trailing = {
                Icon(painterResource(R.drawable.ic_open_in_new), null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            })
            s.devices?.forEach { d ->
                Row(modifier = Modifier.fillMaxWidth().padding(start = 52.dp, end = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(R.drawable.ic_smartphone), null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(d.label + if (d.current) " (dieses Gerät)" else "", style = MaterialTheme.typography.bodyMedium, fontWeight = if (d.current) FontWeight.SemiBold else FontWeight.Normal)
                        val used = Fmt.parseInstant(d.lastUsedAt)?.let { "zuletzt " + Fmt.ago(it.toEpochMilli(), s.now) }
                        Text(listOfNotNull(d.appVersion?.ifBlank { null }?.let { "App $it" }, used).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!d.current) TextButton(onClick = { a.revokeDevice(d) }) { Text("Abmelden") }
                }
            }
        }

        Section("Benachrichtigungen") {
            if (!s.notifyPermission) {
                SettingRow(R.drawable.ic_notifications, "Mitteilungen erlauben", "Ohne Erlaubnis kann HyperLevel nichts anzeigen.", onClick = a::requestNotifyPermission, tint = MaterialTheme.colorScheme.error)
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            NotifyCategory.entries.forEach { c ->
                SettingRow(categoryIcon(c), c.label, categoryHint(c), onClick = { a.setNotify(c, !(s.notify[c] ?: true)) }, trailing = {
                    Switch(checked = s.notify[c] ?: true, onCheckedChange = { a.setNotify(c, it) })
                })
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_settings, "Töne & Kanäle im System", "Klingelton, Vibration, Wichtigkeit", onClick = a::openSystemNotifications)
        }

        Section("Widgets") {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(R.drawable.ic_timer), null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text("Aktualisieren alle", style = MaterialTheme.typography.bodyLarge)
                        Text(if (s.widgetCount > 0) "${s.widgetCount} Widget${if (s.widgetCount == 1) "" else "s"} auf dem Startbildschirm" else "Noch keine Widgets platziert", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(10.dp))
                FlowRow(modifier = Modifier.padding(start = 36.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(15 to "15 Min.", 30 to "30 Min.", 60 to "1 Std.", 120 to "2 Std.").forEach { (m, label) ->
                        FilterChip(selected = s.refreshMinutes == m, onClick = { a.setRefresh(m) }, label = { Text(label) })
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_sync, "Jetzt aktualisieren", "Holt sofort neue Daten für alle Widgets", onClick = a::refreshNow)
            if (s.locations.size > 1) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(painterResource(R.drawable.ic_folder), null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(14.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Standard-Projekt", style = MaterialTheme.typography.bodyLarge)
                            Text("Für neue Aufgaben, Kontakte und Sprach-Notizen", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    LocationPicker(s.locations, s.defaultLocation, a::setDefaultLocation, modifier = Modifier.padding(start = 36.dp))
                }
            }
        }

        Section("Darstellung") {
            SettingRow(R.drawable.ic_palette, "Farben vom Hintergrundbild", "Material You statt HyperLevel-Blau (ab Android 12)", onClick = { a.setDynamicColor(!s.dynamicColor) }, trailing = {
                Switch(checked = s.dynamicColor, onCheckedChange = a::setDynamicColor)
            })
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_bolt, "Schnellmenü-Knopf", "Runder Knopf unten links in der App", onClick = { a.setShowMenuButton(!s.showMenuButton) }, trailing = {
                Switch(checked = s.showMenuButton, onCheckedChange = a::setShowMenuButton)
            })
        }

        Section("Hilfe & Feedback") {
            SettingRow(R.drawable.ic_bug_report, "Fehler melden", "Mit Screenshot, Gerät und App-Version – an das HyperLevel-Team", onClick = a::reportBug)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_inbox, "Meine Meldungen", "Status und Antworten des Teams", onClick = a::openMyReports)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_thumb_up, "Wunschliste", "Für neue Funktionen abstimmen oder selbst etwas vorschlagen", onClick = a::openWishes)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_smartphone, "Schütteln zum Melden", "Handy in der App schütteln öffnet „Fehler melden“", onClick = { a.setShakeToReport(!s.shakeToReport) }, trailing = {
                Switch(checked = s.shakeToReport, onCheckedChange = a::setShakeToReport)
            })
        }

        Section("App") {
            SettingRow(R.drawable.ic_info, "Version", s.version, onClick = a::versionTapped)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_update, "Nach Updates suchen", "Lädt neue Versionen direkt von deinem Server", onClick = a::checkUpdate)
        }

        Section("Diagnose") {
            SettingRow(
                R.drawable.ic_language,
                "WebView",
                s.diag.webView.ifBlank { "unbekannt" } + if (s.diag.webViewTooOld) " – zu alt, mindestens ${s.diag.minWebView} nötig. Bitte „Android System WebView“ aktualisieren." else "",
                tint = if (s.diag.webViewTooOld) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_cloud_off, "Server", s.diag.server.removePrefix("https://"))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(
                R.drawable.ic_info,
                "Letzter Start der Web-Ansicht",
                s.diag.status.ifBlank { "Noch nichts geladen" },
                tint = if (s.diag.statusFailed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
            if (s.diag.errors.isNotEmpty()) {
                Column(modifier = Modifier.fillMaxWidth().padding(start = 52.dp, end = 16.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("Letzte Fehler", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    s.diag.errors.forEach { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_bug_report, "Diagnose senden", "Schickt diese Angaben als Meldung an das Team (oder zum Teilen)", onClick = a::sendDiagnostics)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SettingRow(R.drawable.ic_refresh, "App zurücksetzen (Web-Daten)", "Löscht Cache, Offline-Daten und die Web-Anmeldung dieser App", onClick = { confirmReset = true }, tint = MaterialTheme.colorScheme.error)
        }

        if (s.debugUnlocked) DebugSection(s, a)

        if (s.auth == AuthStatus.ACTIVE && !s.demo) {
            Spacer(Modifier.height(20.dp))
            OutlinedButton(
                onClick = { confirmLogout = true },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) {
                Icon(painterResource(R.drawable.ic_logout), null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Abmelden")
            }
        }
        Spacer(Modifier.height(24.dp))
        Text(
            "HyperLevel für Android · Daten bleiben auf deinem Server",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
        Spacer(Modifier.height(16.dp))
    }
    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Web-Daten löschen?") },
            text = { Text("Löscht den Cache, die Offline-Daten und die Anmeldung in der Web-Ansicht. Du meldest dich danach dort neu an. Widgets und Mitteilungen bleiben verbunden, deine Daten auf dem Server bleiben.") },
            confirmButton = {
                Button(onClick = { confirmReset = false; a.resetWebData() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Zurücksetzen") }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Abbrechen") } },
        )
    }
    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Abmelden?") },
            text = { Text("Die App wird von deinem Konto getrennt, Widgets und Mitteilungen pausieren. Deine Daten auf dem Server bleiben.") },
            confirmButton = {
                Button(onClick = { confirmLogout = false; a.logout() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text("Abmelden") }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Abbrechen") } },
        )
    }
}

@Composable
private fun StatusPill(s: SettingsState) {
    val (label, color) = when {
        s.demo -> "Demo-Daten" to Color(0xFFFDE68A)
        s.auth == AuthStatus.ACTIVE -> "Verbunden" to Color(0xFFBBF7D0)
        s.auth == AuthStatus.EXPIRED -> "Neu anmelden" to Color(0xFFFECACA)
        else -> "Nicht verbunden" to Color(0xFFE2E8F0)
    }
    Row(
        modifier = Modifier.clip(RoundedCornerShape(50)).background(Color.White.copy(alpha = 0.18f)).padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.size(8.dp).clip(RoundedCornerShape(50)).background(color))
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = Color.White)
    }
}

@Composable
private fun DebugSection(s: SettingsState, a: SettingsActions) {
    var server by remember(s.server) { mutableStateOf(s.server) }
    Section("Entwickler") {
        Column(modifier = Modifier.padding(16.dp)) {
            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("Server-Adresse") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            Row {
                Button(onClick = { a.setServer(server) }, enabled = server.isNotBlank() && server != s.server) { Text("Übernehmen") }
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = { a.setServer("") }) { Text("Standard") }
            }
            Text("Beim Wechsel wird die App abgemeldet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        SettingRow(R.drawable.ic_bug_report, "Demo-Daten", "Widgets und Dialoge mit Beispieldaten – ohne Server", onClick = { a.setDemo(!s.demo) }, trailing = {
            Switch(checked = s.demo, onCheckedChange = a::setDemo)
        })
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        SettingRow(R.drawable.ic_notifications, "Mitteilungs-Zeiger zurücksetzen", "Nächster Abruf startet ohne alte Ereignisse", onClick = a::resetFeed)
    }
}

private fun roleLabel(role: String) = when (role) {
    "admin" -> "Agentur-Admin"
    "user", "member" -> "Mitglied"
    else -> role
}

private fun categoryIcon(c: NotifyCategory) = when (c) {
    NotifyCategory.MESSAGES -> R.drawable.ic_inbox
    NotifyCategory.CHAT -> R.drawable.ic_forum
    NotifyCategory.CALLS -> R.drawable.ic_phone_missed
    NotifyCategory.LEADS -> R.drawable.ic_person_add
    NotifyCategory.PAYMENTS -> R.drawable.ic_euro
    NotifyCategory.WEBSITES -> R.drawable.ic_language
    NotifyCategory.TASKS -> R.drawable.ic_task_alt
    NotifyCategory.REVIEWS -> R.drawable.ic_star
    NotifyCategory.FEEDBACK -> R.drawable.ic_bug_report
}

private fun categoryHint(c: NotifyCategory) = when (c) {
    NotifyCategory.MESSAGES -> "Neue E-Mails, SMS, WhatsApp, Chat"
    NotifyCategory.CHAT -> "Direktnachrichten und Erwähnungen im Team-Chat"
    NotifyCategory.CALLS -> "Verpasste Anrufe"
    NotifyCategory.LEADS -> "Neue Kontakte aus Formularen & Co."
    NotifyCategory.PAYMENTS -> "Bezahlte Rechnungen"
    NotifyCategory.WEBSITES -> "Website offline / wieder online"
    NotifyCategory.TASKS -> "Wenn Aufgaben fällig werden"
    NotifyCategory.REVIEWS -> "Neue Bewertungen"
    NotifyCategory.FEEDBACK -> "Antworten und Status deiner Meldungen"
}

