package org.gohigh.android.ui.report

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRowDefaults
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.gohigh.android.R
import org.gohigh.android.api.ApiErrorEntry
import org.gohigh.android.api.BugReport
import org.gohigh.android.api.DeviceDiagnostics
import org.gohigh.android.api.FeedbackStatus
import org.gohigh.android.api.SEVERITIES
import org.gohigh.android.api.WISH_AREAS
import org.gohigh.android.api.Wish
import org.gohigh.android.ui.theme.Brand
import org.gohigh.android.util.Fmt

/** Tabs of the „Fehler & Wünsche“ screen. */
enum class ReportTab(val key: String, val label: String) {
    REPORT("report", "Melden"),
    MINE("mine", "Meldungen"),
    WISHES("wishes", "Wunschliste");

    companion object {
        fun of(key: String?) = entries.firstOrNull { it.key == key } ?: REPORT
    }
}

/** Everything the report form shows. Diagnostics are visible and can be removed one by one. */
data class ReportForm(
    val category: String = "bug",
    val what: String = "",
    val expected: String = "",
    val steps: String = "",
    val severity: String = "mittel",
    val title: String = "",
    val area: String = "App",
    val screenshot: ImageBitmap? = null,
    val includeScreenshot: Boolean = true,
    val device: DeviceDiagnostics = DeviceDiagnostics(),
    val includeDevice: Boolean = true,
    val apiErrors: List<ApiErrorEntry> = emptyList(),
    val includeApiErrors: Boolean = true,
    val screen: String? = null,
    val sending: Boolean = false,
    val error: String? = null,
) {
    val canSend: Boolean get() = !sending && if (category == "wish") title.isNotBlank() else what.isNotBlank()
}

/** Header with tabs over a surface (sets the content colour for light and dark). */
@Composable
fun ReportScaffold(tab: ReportTab, onTab: (ReportTab) -> Unit, onClose: () -> Unit, content: @Composable () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize()) {
            ReportHeader(tab, onTab, onClose)
            content()
        }
    }
}

@Composable
fun ReportHeader(tab: ReportTab, onTab: (ReportTab) -> Unit, onClose: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Brand.Gradient)) {
        Row(Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(start = 4.dp, end = 16.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(painterResource(R.drawable.ic_close), "Schließen", tint = Color.White) }
            Text("Fehler & Wünsche", style = MaterialTheme.typography.titleLarge, color = Color.White)
        }
        PrimaryTabRow(
            selectedTabIndex = tab.ordinal,
            containerColor = Color.Transparent,
            contentColor = Color.White,
            divider = {},
            indicator = { TabRowDefaults.PrimaryIndicator(Modifier.tabIndicatorOffset(tab.ordinal, matchContentSize = true), width = androidx.compose.ui.unit.Dp.Unspecified, color = Color.White) },
        ) {
            ReportTab.entries.forEach { t ->
                Tab(selected = t == tab, onClick = { onTab(t) }, text = { Text(t.label, maxLines = 1) }, selectedContentColor = Color.White, unselectedContentColor = Color.White.copy(alpha = 0.75f))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun ReportFormScreen(f: ReportForm, onChange: (ReportForm) -> Unit, onPickImage: () -> Unit, onSend: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(16.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("bug" to "Fehler", "wish" to "Verbesserungswunsch", "question" to "Frage").forEach { (k, l) ->
                FilterChip(selected = f.category == k, onClick = { onChange(f.copy(category = k)) }, label = { Text(l) }, leadingIcon = {
                    Icon(painterResource(if (k == "bug") R.drawable.ic_bug_report else if (k == "wish") R.drawable.ic_thumb_up else R.drawable.ic_chat), null, modifier = Modifier.size(16.dp))
                })
            }
        }
        Spacer(Modifier.height(12.dp))
        if (f.category == "wish") {
            OutlinedTextField(f.title, { onChange(f.copy(title = it)) }, label = { Text("Titel") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(f.what, { onChange(f.copy(what = it)) }, label = { Text("Beschreibung") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Dropdown("Bereich", f.area, WISH_AREAS.map { it to it }) { onChange(f.copy(area = it)) }
            Text("Wünsche sieht jeder in der Wunschliste – ohne deinen Namen.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
        } else {
            OutlinedTextField(f.what, { onChange(f.copy(what = it)) }, label = { Text(if (f.category == "question") "Deine Frage" else "Was ist passiert?") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            if (f.category == "bug") {
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(f.expected, { onChange(f.copy(expected = it)) }, label = { Text("Was hast du erwartet?") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(f.steps, { onChange(f.copy(steps = it)) }, label = { Text("Schritte zum Nachstellen") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Dropdown("Wie schlimm ist es?", f.severity, SEVERITIES) { onChange(f.copy(severity = it)) }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("Screenshot", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(6.dp))
        if (f.screenshot != null && f.includeScreenshot) {
            Box {
                Image(f.screenshot, "Screenshot", contentScale = ContentScale.Crop, alignment = Alignment.TopCenter, modifier = Modifier.width(120.dp).height(190.dp).clip(RoundedCornerShape(12.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp)))
                Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp, modifier = Modifier.align(Alignment.TopEnd).padding(6.dp)) {
                    IconButton(onClick = { onChange(f.copy(includeScreenshot = false)) }, modifier = Modifier.size(32.dp)) { Icon(painterResource(R.drawable.ic_close), "Screenshot entfernen", modifier = Modifier.size(18.dp)) }
                }
            }
        } else {
            OutlinedButton(onClick = onPickImage) {
                Icon(painterResource(R.drawable.ic_photo_camera), null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(if (f.screenshot != null) "Screenshot wieder anhängen" else "Bild auswählen")
            }
            if (f.screenshot != null) TextButton(onClick = { onChange(f.copy(includeScreenshot = true)) }) { Text("Aktuellen Bildschirm wieder anhängen") }
        }

        if (f.category != "wish") {
            Spacer(Modifier.height(16.dp))
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text("Diagnosedaten", style = MaterialTheme.typography.titleSmall)
                    Text("Nur technische Angaben – keine Inhalte, Passwörter oder Schlüssel. Antippen ✕ entfernt sie.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(8.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (f.includeDevice) {
                            InputChip(selected = false, onClick = { onChange(f.copy(includeDevice = false)) }, label = {
                                Text("${f.device.manufacturer} ${f.device.model} · Android ${f.device.android} · App ${f.device.appVersion}".trim(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }, trailingIcon = { Icon(painterResource(R.drawable.ic_close), "Gerät entfernen", modifier = Modifier.size(16.dp)) })
                        }
                        if (f.includeApiErrors && f.apiErrors.isNotEmpty()) {
                            InputChip(selected = false, onClick = { onChange(f.copy(includeApiErrors = false)) }, label = { Text("${f.apiErrors.size} fehlgeschlagene Anfragen") }, trailingIcon = {
                                Icon(painterResource(R.drawable.ic_close), "Anfragen entfernen", modifier = Modifier.size(16.dp))
                            })
                        }
                        if (!f.screen.isNullOrBlank()) InputChip(selected = false, onClick = { onChange(f.copy(screen = null)) }, label = { Text("Seite: ${f.screen}", maxLines = 1, overflow = TextOverflow.Ellipsis) }, trailingIcon = {
                            Icon(painterResource(R.drawable.ic_close), "Seite entfernen", modifier = Modifier.size(16.dp))
                        })
                    }
                    if (f.includeApiErrors && f.apiErrors.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        f.apiErrors.takeLast(3).reversed().forEach { e ->
                            Text("${if (e.status == 0) "Netz" else e.status} · ${e.method} ${e.path} – ${e.error}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }

        f.error?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = onSend, enabled = f.canSend, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            if (f.sending) CircularProgressIndicator(Modifier.size(18.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
            else Icon(painterResource(R.drawable.ic_send), null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(if (f.sending) "Wird gesendet…" else "Senden")
        }
        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Dropdown(label: String, value: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = options.firstOrNull { it.first == value }?.second ?: value,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (k, l) -> DropdownMenuItem(text = { Text(l) }, onClick = { onPick(k); open = false }) }
        }
    }
}

/** Colour of a status pill (same tones as the web app). */
@Composable
fun StatusPill(s: FeedbackStatus) {
    val (bg, fg) = when (s.tone) {
        "blue" -> Color(0xFFDBEAFE) to Color(0xFF1E40AF)
        "purple" -> Color(0xFFEDE9FE) to Color(0xFF5B21B6)
        "yellow" -> Color(0xFFFEF3C7) to Color(0xFF92400E)
        "green" -> Color(0xFFD1FAE5) to Color(0xFF065F46)
        "red" -> Color(0xFFFEE2E2) to Color(0xFF991B1B)
        else -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(s.label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = fg, modifier = Modifier.clip(RoundedCornerShape(50)).background(bg).padding(horizontal = 9.dp, vertical = 2.dp), maxLines = 1)
}

private fun kindIcon(kind: String) = when (kind) {
    "wish" -> R.drawable.ic_thumb_up
    "question" -> R.drawable.ic_chat
    "auto" -> R.drawable.ic_warning
    else -> R.drawable.ic_bug_report
}

@Composable
fun MyReportsScreen(items: List<BugReport>?, error: String?, now: Long, onOpen: (BugReport) -> Unit, onReport: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
        when {
            items == null && error == null -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            items.isNullOrEmpty() -> Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(error ?: "Noch keine Meldungen.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                Button(onClick = onReport) { Text("Fehler melden") }
            }
            else -> items.forEachIndexed { i, r ->
                if (i > 0) HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                Row(Modifier.fillMaxWidth().clickable { onOpen(r) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                        Icon(painterResource(kindIcon(r.kind)), null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text((if (r.number > 0) "#${r.number} " else "") + r.title, style = MaterialTheme.typography.bodyLarge, fontWeight = if (r.unread) FontWeight.SemiBold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        val updated = Fmt.parseInstant(r.updatedAt)?.let { "aktualisiert " + Fmt.ago(it.toEpochMilli(), now) }
                        Text(listOfNotNull(updated, r.version.ifBlank { null }?.let { "Version $it" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (r.unread) Box(Modifier.padding(end = 8.dp).size(8.dp).clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.primary))
                    StatusPill(r.status)
                }
            }
        }
    }
}

@Composable
fun WishesScreen(items: List<Wish>?, error: String?, sort: String, onSort: (String) -> Unit, onVote: (Wish) -> Unit, onOpen: (Wish) -> Unit, onNew: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf("votes" to "Stimmen", "new" to "Neu", "status" to "Status").forEach { (k, l) ->
                FilterChip(selected = sort == k, onClick = { onSort(k) }, label = { Text(l) }, modifier = Modifier.padding(end = 6.dp))
            }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onNew) {
                Icon(painterResource(R.drawable.ic_add), null, modifier = Modifier.size(18.dp))
                Text("Wunsch")
            }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
            when {
                items == null && error == null -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                items.isNullOrEmpty() -> Text(error ?: "Noch keine Wünsche – sei die oder der Erste!", modifier = Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> items.forEach { w ->
                    Surface(shape = MaterialTheme.shapes.large, border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).clickable { onOpen(w) }) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
                            val on = w.myVote
                            Column(
                                Modifier.size(width = 52.dp, height = 56.dp).clip(RoundedCornerShape(12.dp))
                                    .background(if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface)
                                    .border(1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))
                                    .clickable(enabled = w.status.board != "declined" || on) { onVote(w) },
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.Center,
                            ) {
                                Icon(painterResource(R.drawable.ic_thumb_up), if (on) "Stimme zurücknehmen" else "Dafür stimmen", tint = if (on) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                                Text("${w.votes}", style = MaterialTheme.typography.titleSmall, color = if (on) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface)
                            }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(w.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
                                if (w.body.isNotBlank()) Text(w.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Spacer(Modifier.height(4.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    StatusPill(w.status)
                                    Spacer(Modifier.width(6.dp))
                                    Text(listOfNotNull(w.area, if (w.mine) "dein Wunsch" else null, w.version.ifBlank { null }?.let { "Version $it" }).joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                if (w.reason.isNotBlank()) Text("Begründung: ${w.reason}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
        }
    }
}

@Composable
fun NewWishDialog(onDismiss: () -> Unit, onSubmit: (title: String, what: String, area: String) -> Unit) {
    var title by remember { mutableStateOf("") }
    var what by remember { mutableStateOf("") }
    var area by remember { mutableStateOf("App") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Wunsch einreichen") },
        text = {
            Column {
                OutlinedTextField(title, { title = it }, label = { Text("Titel") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(what, { what = it }, label = { Text("Beschreibung") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Dropdown("Bereich", area, WISH_AREAS.map { it to it }) { area = it }
            }
        },
        confirmButton = { Button(onClick = { onSubmit(title, what, area) }, enabled = title.isNotBlank()) { Text("Einreichen") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

@Composable
fun SentDialog(r: BugReport, onShowMine: () -> Unit, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        icon = { Icon(painterResource(R.drawable.ic_task_alt), null, tint = Brand.Success) },
        title = { Text(if (r.kind == "wish") "Wunsch eingereicht" else "Danke für deine Meldung!") },
        text = { Text(if (r.kind == "wish") "Er steht jetzt in der Wunschliste (#${r.number})." else "Ticketnummer #${r.number} – du bekommst Bescheid, wenn das Team antwortet oder sich der Status ändert.") },
        confirmButton = { Button(onClick = onShowMine) { Text(if (r.kind == "wish") "Zur Wunschliste" else "Meine Meldungen") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Schließen") } },
    )
}
