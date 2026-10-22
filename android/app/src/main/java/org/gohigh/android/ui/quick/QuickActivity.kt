package org.gohigh.android.ui.quick

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.Appointment
import org.gohigh.android.api.CallItem
import org.gohigh.android.api.CaptureRequest
import org.gohigh.android.api.ChatMessage
import org.gohigh.android.api.ConversationDetail
import org.gohigh.android.api.CreateContactRequest
import org.gohigh.android.api.CreateTaskRequest
import org.gohigh.android.api.Deal
import org.gohigh.android.api.NoteRequest
import org.gohigh.android.api.Pipeline
import org.gohigh.android.api.ReplyRequest
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.DataRequest
import org.gohigh.android.ui.common.IconCircle
import org.gohigh.android.ui.common.LocationPicker
import org.gohigh.android.ui.main.MainActivity
import org.gohigh.android.ui.theme.Brand
import org.gohigh.android.ui.theme.GoHighTheme
import org.gohigh.android.util.DeepLinks
import org.gohigh.android.util.Fmt
import org.gohigh.android.widget.ui.channelLabel
import org.gohigh.android.work.WorkScheduler
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters

/**
 * Quick actions as dialogs over the home screen (from widgets, app shortcuts and the in-app menu).
 * One translucent activity; the intent action picks the screen.
 */
class QuickActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        val action = intent.action?.removePrefix(PREFIX) ?: TASK
        if (intent.data?.lastPathSegment == "shortcut") {
            androidx.core.content.pm.ShortcutManagerCompat.reportShortcutUsed(this, action)
        }
        setContent {
            GoHighTheme(dynamic = AppGraph.get(this).settings.dynamicColor) {
                QuickHost(action, intent, onClose = { finish() })
            }
        }
    }

    companion object {
        const val PREFIX = "org.gohigh.android.quick."
        const val REPLY = "reply"
        const val TASK = "task"
        const val CONTACT = "contact"
        const val NOTE = "note"
        const val DEAL = "deal"
        const val APPOINTMENT = "appointment"
        const val CALLBACK = "callback"
        const val CALL = "call"
        const val VOICE = "voice"
        const val EXTRA_LOCATION = "location"
        const val EXTRA_ID = "id"
        const val EXTRA_TITLE = "title"
        const val EXTRA_JSON = "json"
    }
}

@Composable
fun QuickHost(action: String, intent: Intent, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    val loc = intent.getStringExtra(QuickActivity.EXTRA_LOCATION)
    val auth by g.session.status.collectAsState()
    if (auth != AuthStatus.ACTIVE) {
        QuickSheet("HyperLevel", R.drawable.ic_lock, onClose) {
            Text("Bitte zuerst in der App anmelden – danach funktionieren alle Schnellaktionen.", style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(16.dp))
            Button(onClick = {
                ctx.startActivity(Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                onClose()
            }, modifier = Modifier.fillMaxWidth()) { Text("Zur Anmeldung") }
        }
        return
    }
    val json = intent.getStringExtra(QuickActivity.EXTRA_JSON)
    when (action) {
        QuickActivity.REPLY -> ReplyScreen(intent.getStringExtra(QuickActivity.EXTRA_ID).orEmpty(), intent.getStringExtra(QuickActivity.EXTRA_TITLE).orEmpty(), onClose)
        QuickActivity.CONTACT -> ContactScreen(loc, onClose)
        QuickActivity.NOTE -> NoteScreen(loc, onClose)
        QuickActivity.DEAL -> json?.let { runCatching { ApiJson.decodeFromString(Deal.serializer(), it) }.getOrNull() }?.let { DealScreen(it, onClose) } ?: onClose()
        QuickActivity.APPOINTMENT -> json?.let { runCatching { ApiJson.decodeFromString(Appointment.serializer(), it) }.getOrNull() }?.let { AppointmentScreen(it, onClose) } ?: onClose()
        QuickActivity.CALLBACK -> json?.let { runCatching { ApiJson.decodeFromString(CallItem.serializer(), it) }.getOrNull() }?.let {
            CallScreen(it.contactName?.takeIf { n -> n.isNotBlank() } ?: it.otherNumber ?: "Unbekannt", it.otherNumber, it.contactId, it.summary, it.locationId, onClose)
        } ?: onClose()
        QuickActivity.CALL -> CallPickScreen(loc, onClose)
        QuickActivity.VOICE -> VoiceScreen(loc, onClose)
        else -> TaskScreen(loc, onClose)
    }
}

/** Runs an API action with busy/error state and refreshes widgets afterwards. */
@Composable
private fun rememberRunner(): Pair<Busy, (suspend () -> String) -> Unit> {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf<Busy>(Busy.Idle) }
    val run: (suspend () -> String) -> Unit = { block ->
        busy = Busy.Working
        scope.launch {
            busy = try {
                val msg = block()
                WorkScheduler.refreshNow(ctx)
                Busy.Done(msg)
            } catch (e: Exception) {
                Busy.Failed(e.message ?: "Fehler")
            }
        }
    }
    return busy to run
}

// ------------------------------------------------------------------ Antworten

@Composable
fun ReplyScreen(conversationId: String, contactName: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    var detail by remember { mutableStateOf<ConversationDetail?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var text by rememberSaveable { mutableStateOf("") }
    var channel by rememberSaveable { mutableStateOf<String?>(null) }
    val (busy, run) = rememberRunner()
    val speech = rememberSpeech { text = (text + " " + it).trim() }
    LaunchedEffect(conversationId) {
        try {
            val d = g.api.conversation(conversationId, limit = 6)
            detail = d
            channel = channel ?: d.messages.lastOrNull { it.direction == "inbound" || it.direction == "in" }?.channel?.takeIf { it in d.channels } ?: d.channels.firstOrNull()
            runCatching { g.api.markRead(conversationId) }
            g.repository.markReadLocally(conversationId)
        } catch (e: Exception) {
            loadError = e.message
        }
    }
    QuickSheet(detail?.contact?.name?.ifBlank { null } ?: contactName.ifBlank { "Antworten" }, R.drawable.ic_reply, onClose, subtitle = detail?.locationName?.ifBlank { null }) {
        if (busy is Busy.Done) {
            DoneView(busy.message, onClose)
            return@QuickSheet
        }
        loadError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        detail?.messages?.takeLast(3)?.forEach { m -> Bubble(m) }
        Spacer(Modifier.height(10.dp))
        val channels = detail?.channels.orEmpty()
        if (channels.size > 1) {
            ChannelChips(channels, channel) { channel = it }
            Spacer(Modifier.height(8.dp))
        }
        Field(text, { text = it }, "Nachricht", minLines = 3, trailing = { MicButton(speech) })
        ErrorText(busy)
        Spacer(Modifier.height(12.dp))
        PrimaryButton("Senden", busy, enabled = text.isNotBlank(), icon = R.drawable.ic_send) {
            run {
                g.api.reply(conversationId, ReplyRequest(channel = channel, body = text.trim()))
                "Gesendet" + (channel?.let { " per ${channelLabel(it)}" } ?: "")
            }
        }
        TextButton(onClick = {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DeepLinks.conversation(g.settings.baseUrl, conversationId, detail?.locationId?.ifBlank { null })), ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            onClose()
        }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Ganzen Verlauf öffnen") }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChannelChips(channels: List<String>, selected: String?, onSelect: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        channels.forEach { c ->
            FilterChip(selected = c == selected, onClick = { onSelect(c) }, label = { Text(channelLabel(c)) }, leadingIcon = {
                Icon(painterResource(org.gohigh.android.widget.ui.channelIcon(c)), null, modifier = Modifier.size(16.dp))
            })
        }
    }
}

@Composable
private fun Bubble(m: ChatMessage) {
    val out = m.direction == "outbound" || m.direction == "out"
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = if (out) Arrangement.End else Arrangement.Start) {
        Surface(
            color = if (out) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth(0.85f),
        ) {
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Text(m.body.ifBlank { m.subject ?: "" }, style = MaterialTheme.typography.bodyMedium, maxLines = 4)
                Text(
                    listOfNotNull(channelLabel(m.channel).takeIf { m.channel.isNotBlank() }, Fmt.shortTime(m.at, System.currentTimeMillis()).ifBlank { null }).joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// ------------------------------------------------------------------ Aufgabe

enum class Due(val label: String) { TODAY("Heute"), TOMORROW("Morgen"), NEXT_WEEK("Nächste Woche"), NONE("Ohne") }

fun Due.date(today: LocalDate): LocalDate? = when (this) {
    Due.TODAY -> today
    Due.TOMORROW -> today.plusDays(1)
    Due.NEXT_WEEK -> today.with(TemporalAdjusters.next(DayOfWeek.MONDAY))
    Due.NONE -> null
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaskScreen(initialLocation: String?, onClose: () -> Unit, initialTitle: String = "") {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    val locations = rememberLocations()
    var title by rememberSaveable { mutableStateOf(initialTitle) }
    var description by rememberSaveable { mutableStateOf("") }
    var due by rememberSaveable { mutableStateOf(Due.TODAY) }
    var location by rememberSaveable { mutableStateOf(initialLocation?.takeIf { it != org.gohigh.android.api.ALL_LOCATIONS }) }
    val effective = location ?: pickLocation(null, g.settings.defaultLocation, locations)
    val (busy, run) = rememberRunner()
    val speech = rememberSpeech { title = if (title.isBlank()) it else "$title $it" }
    QuickSheet("Neue Aufgabe", R.drawable.ic_task_alt, onClose) {
        if (busy is Busy.Done) {
            DoneView(busy.message, onClose)
            return@QuickSheet
        }
        Field(title, { title = it }, "Was ist zu tun?", trailing = { MicButton(speech) })
        Spacer(Modifier.height(12.dp))
        Text("Fällig", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Due.entries.forEach { d -> FilterChip(selected = due == d, onClick = { due = d }, label = { Text(d.label) }) }
        }
        if (locations.size > 1) {
            Spacer(Modifier.height(10.dp))
            LocationPicker(locations, effective, { location = it })
        }
        Spacer(Modifier.height(10.dp))
        Field(description, { description = it }, "Details (optional)", minLines = 2)
        ErrorText(busy)
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Aufgabe speichern", busy, enabled = title.isNotBlank() && effective != null, icon = R.drawable.ic_check) {
            run {
                val day = due.date(LocalDate.now())
                g.api.createTask(CreateTaskRequest(effective!!, title.trim(), description.trim().ifBlank { null }, day?.toString()))
                "Aufgabe gespeichert" + (day?.let { " – ${Fmt.dayLabel(it, LocalDate.now())}" } ?: "")
            }
        }
        if (effective == null && locations.size > 1) Text("Bitte ein Projekt wählen", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}

// ------------------------------------------------------------------ Kontakt

@Composable
fun ContactScreen(initialLocation: String?, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    val locations = rememberLocations()
    var first by rememberSaveable { mutableStateOf("") }
    var last by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var company by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var location by rememberSaveable { mutableStateOf(initialLocation?.takeIf { it != org.gohigh.android.api.ALL_LOCATIONS }) }
    val effective = location ?: pickLocation(null, g.settings.defaultLocation, locations)
    val (busy, run) = rememberRunner()
    val speech = rememberSpeech { note = (note + " " + it).trim() }
    QuickSheet("Neuer Kontakt", R.drawable.ic_person_add, onClose) {
        if (busy is Busy.Done) {
            DoneView(busy.message, onClose)
            return@QuickSheet
        }
        Row {
            Field(first, { first = it }, "Vorname", modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Field(last, { last = it }, "Nachname", modifier = Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        Field(phone, { phone = it }, "Telefon", keyboard = KeyboardType.Phone)
        Spacer(Modifier.height(8.dp))
        Field(email, { email = it }, "E-Mail", keyboard = KeyboardType.Email)
        Spacer(Modifier.height(8.dp))
        Field(company, { company = it }, "Firma")
        Spacer(Modifier.height(8.dp))
        Field(note, { note = it }, "Notiz", minLines = 2, trailing = { MicButton(speech) })
        if (locations.size > 1) {
            Spacer(Modifier.height(10.dp))
            LocationPicker(locations, effective, { location = it })
        }
        ErrorText(busy)
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Kontakt anlegen", busy, enabled = first.isNotBlank() && effective != null, icon = R.drawable.ic_person_add) {
            run {
                val c = g.api.createContact(
                    CreateContactRequest(
                        locationId = effective!!, firstName = first.trim(), lastName = last.trim().ifBlank { null },
                        email = email.trim().ifBlank { null }, phone = phone.trim().ifBlank { null },
                        company = company.trim().ifBlank { null }, note = note.trim().ifBlank { null },
                    ),
                )
                "${c.name.ifBlank { first }} angelegt"
            }
        }
    }
}

// ------------------------------------------------------------------ Notiz

@Composable
fun NoteScreen(initialLocation: String?, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    var contactId by rememberSaveable { mutableStateOf<String?>(null) }
    var contactName by rememberSaveable { mutableStateOf("") }
    var text by rememberSaveable { mutableStateOf("") }
    val (busy, run) = rememberRunner()
    val speech = rememberSpeech { text = (text + " " + it).trim() }
    QuickSheet(if (contactId == null) "Notiz zu Kontakt" else contactName, R.drawable.ic_edit_note, onClose, subtitle = if (contactId == null) "Kontakt wählen" else "Notiz hinzufügen") {
        if (busy is Busy.Done) {
            DoneView(busy.message, onClose)
            return@QuickSheet
        }
        if (contactId == null) {
            ContactSearch(initialLocation?.takeIf { it != org.gohigh.android.api.ALL_LOCATIONS }) {
                contactId = it.id
                contactName = it.name
            }
        } else {
            Field(text, { text = it }, "Notiz", minLines = 4, trailing = { MicButton(speech) })
            ErrorText(busy)
            Spacer(Modifier.height(14.dp))
            PrimaryButton("Notiz speichern", busy, enabled = text.isNotBlank(), icon = R.drawable.ic_check) {
                run {
                    g.api.addNote(NoteRequest(contactId!!, text.trim()))
                    "Notiz gespeichert"
                }
            }
            TextButton(onClick = { contactId = null }) { Text("Anderen Kontakt wählen") }
        }
    }
}

// ------------------------------------------------------------------ Deal

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DealScreen(deal: Deal, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    var pipeline by remember { mutableStateOf<Pipeline?>(null) }
    val (busy, run) = rememberRunner()
    LaunchedEffect(deal.id) {
        // Cached first (instant), then fresh from the server.
        pipeline = g.repository.cached(DataRequest.Deals(deal.locationId))?.data?.pipelines?.firstOrNull { it.id == deal.pipelineId }
            ?: g.repository.cached(DataRequest.Deals(org.gohigh.android.api.ALL_LOCATIONS))?.data?.pipelines?.firstOrNull { it.id == deal.pipelineId }
        runCatching { g.api.deals(deal.locationId, limit = 1) }.getOrNull()?.pipelines?.firstOrNull { it.id == deal.pipelineId }?.let { pipeline = it }
    }
    QuickSheet(deal.name.ifBlank { "Deal" }, R.drawable.ic_view_kanban, onClose, subtitle = listOfNotNull(Fmt.money(deal.valueCents), deal.contactName, deal.stageName.ifBlank { null }).joinToString(" · ")) {
        if (busy is Busy.Done) {
            DoneView(busy.message, onClose)
            return@QuickSheet
        }
        Text("In Phase verschieben", style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        val stages = pipeline?.stages.orEmpty()
        if (stages.isEmpty()) Text("Phasen werden geladen…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            stages.forEach { s ->
                FilterChip(
                    selected = s.id == deal.stageId,
                    enabled = busy !is Busy.Working,
                    onClick = { if (s.id != deal.stageId) run { g.api.moveDeal(deal.id, s.id); "Verschoben nach „${s.name}“" } },
                    label = { Text(s.name) },
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Row {
            Button(
                onClick = { run { g.api.setDealStatus(deal.id, "won"); "Gewonnen 🎉" } },
                enabled = busy !is Busy.Working,
                colors = ButtonDefaults.buttonColors(containerColor = Brand.Success),
                modifier = Modifier.weight(1f).height(50.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Icon(painterResource(R.drawable.ic_emoji_events), null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Gewonnen")
            }
            Spacer(Modifier.width(10.dp))
            OutlinedButton(
                onClick = { run { g.api.setDealStatus(deal.id, "lost"); "Als verloren markiert" } },
                enabled = busy !is Busy.Working,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.weight(1f).height(50.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Icon(painterResource(R.drawable.ic_thumb_down), null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Verloren")
            }
        }
        ErrorText(busy)
        TextButton(onClick = {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DeepLinks.opportunities(g.settings.baseUrl, deal.locationId)), ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            onClose()
        }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("In der Pipeline öffnen") }
    }
}

// ------------------------------------------------------------------ Termin

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AppointmentScreen(a: Appointment, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    val (busy, run) = rememberRunner()
    val start = Fmt.parseInstant(a.start)
    val today = LocalDate.now()
    val day = start?.atZone(java.time.ZoneId.systemDefault())?.toLocalDate()?.let { Fmt.dayLabel(it, today) } ?: ""
    val time = listOfNotNull(Fmt.clock(a.start).ifBlank { null }, Fmt.clock(a.end).ifBlank { null }).joinToString("–")
    fun open(intent: Intent) {
        runCatching { ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    QuickSheet(a.title.ifBlank { "Termin" }, R.drawable.ic_event, onClose, subtitle = listOf("$day $time".trim(), a.contactName.orEmpty(), a.calendarName.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ")) {
        if (busy is Busy.Done) {
            DoneView(busy.message, onClose)
            return@QuickSheet
        }
        if (!a.address.isNullOrBlank()) {
            Text(a.address, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
        }
        Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
            if (!a.phone.isNullOrBlank()) ActionTile(R.drawable.ic_call, "Anrufen") { open(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + a.phone))) }
            if (!a.address.isNullOrBlank()) ActionTile(R.drawable.ic_directions, "Navigieren") { open(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(a.address)))) }
            if (!a.meetingUrl.isNullOrBlank()) ActionTile(R.drawable.ic_videocam, "Meeting") { open(Intent(Intent.ACTION_VIEW, Uri.parse(a.meetingUrl))) }
            ActionTile(R.drawable.ic_today, "Kalender") {
                open(Intent(Intent.ACTION_VIEW, Uri.parse(DeepLinks.calendars(g.settings.baseUrl, a.locationId)), ctx, MainActivity::class.java))
                onClose()
            }
        }
        Spacer(Modifier.height(14.dp))
        Text("Status: " + statusLabel(a.status), style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (a.status != "confirmed") StatusChip("Bestätigen", R.drawable.ic_check, busy) { run { g.api.setAppointmentStatus(a.id, "confirmed"); "Termin bestätigt" } }
            StatusChip("Erschienen", R.drawable.ic_how_to_reg, busy) { run { g.api.setAppointmentStatus(a.id, "showed"); "Als erschienen markiert" } }
            StatusChip("Nicht erschienen", R.drawable.ic_event_busy, busy) { run { g.api.setAppointmentStatus(a.id, "noshow"); "Als nicht erschienen markiert" } }
            StatusChip("Absagen", R.drawable.ic_cancel, busy) { run { g.api.setAppointmentStatus(a.id, "cancelled"); "Termin abgesagt" } }
        }
        ErrorText(busy)
    }
}

private fun statusLabel(s: String) = when (s) {
    "confirmed" -> "bestätigt"
    "cancelled" -> "abgesagt"
    "showed" -> "erschienen"
    "noshow" -> "nicht erschienen"
    "booked", "new" -> "gebucht"
    else -> s.ifBlank { "–" }
}

@Composable
private fun StatusChip(label: String, icon: Int, busy: Busy, onClick: () -> Unit) {
    FilterChip(selected = false, enabled = busy !is Busy.Working, onClick = onClick, label = { Text(label) }, leadingIcon = { Icon(painterResource(icon), null, modifier = Modifier.size(16.dp)) })
}

@Composable
private fun ActionTile(icon: Int, label: String, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(4.dp)) {
        Surface(onClick = onClick, shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.primaryContainer) {
            Icon(painterResource(icon), label, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(14.dp).size(24.dp))
        }
        Spacer(Modifier.height(4.dp))
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

// ------------------------------------------------------------------ Anrufen / Rückruf

@Composable
fun CallScreen(name: String, number: String?, contactId: String?, summary: String?, locationId: String?, onClose: () -> Unit, onBack: (() -> Unit)? = null) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    val (busy, run) = rememberRunner()
    QuickSheet(name, R.drawable.ic_phone_callback, onClose, subtitle = listOfNotNull(number?.takeIf { it != name }, summary).joinToString(" · ").ifBlank { null }) {
        if (busy is Busy.Done) {
            DoneView(busy.message, onClose)
            return@QuickSheet
        }
        if (!number.isNullOrBlank()) {
            PrimaryButton("Mit dem Handy anrufen", Busy.Idle, icon = R.drawable.ic_call) {
                runCatching { ctx.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                onClose()
            }
            Spacer(Modifier.height(10.dp))
        }
        if (!contactId.isNullOrBlank()) {
            OutlinedButton(
                onClick = { run { g.api.clickToCall(contactId).message ?: "Dein Telefon klingelt gleich" } },
                enabled = busy !is Busy.Working,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(16.dp),
            ) {
                Icon(painterResource(R.drawable.ic_phone_callback), null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Über HyperLevel anrufen (Twilio)")
            }
            Text(
                "HyperLevel ruft zuerst dich an und verbindet dann – mit deiner Firmennummer.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp),
                textAlign = TextAlign.Start,
            )
        }
        if (number.isNullOrBlank() && contactId.isNullOrBlank()) Text("Keine Nummer bekannt.", style = MaterialTheme.typography.bodyMedium)
        ErrorText(busy)
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            if (onBack != null) TextButton(onClick = onBack) { Text("Anderer Kontakt") }
            TextButton(onClick = {
                ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DeepLinks.calls(g.settings.baseUrl, locationId)), ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                onClose()
            }) { Text("Anrufliste öffnen") }
        }
    }
}

@Composable
fun CallPickScreen(initialLocation: String?, onClose: () -> Unit) {
    var picked by remember { mutableStateOf<org.gohigh.android.api.ContactItem?>(null) }
    val p = picked
    if (p == null) {
        QuickSheet("Anrufen", R.drawable.ic_call, onClose, subtitle = "Kontakt wählen") {
            ContactSearch(initialLocation?.takeIf { it != org.gohigh.android.api.ALL_LOCATIONS }) { picked = it }
        }
    } else {
        CallScreen(p.name.ifBlank { p.phone ?: "Kontakt" }, p.phone, p.id, p.company, p.locationId, onClose, onBack = { picked = null })
    }
}

// ------------------------------------------------------------------ Sprach-Notiz

@Composable
fun VoiceScreen(initialLocation: String?, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    val locations = rememberLocations()
    var text by rememberSaveable { mutableStateOf("") }
    var started by rememberSaveable { mutableStateOf(false) }
    var location by rememberSaveable { mutableStateOf<String?>(null) }
    val effective = location ?: pickLocation(initialLocation, g.settings.defaultLocation, locations)
    val (busy, run) = rememberRunner()
    fun send(t: String, loc: String) = run {
        val r = g.api.capture(CaptureRequest(loc, t))
        val label = r.label.ifBlank { t }.take(80)
        if (r.kind == "note") "Notiz gespeichert: $label" else "Aufgabe erstellt: $label"
    }
    val speech = rememberSpeech(prompt = "Was soll ich notieren?", onCancel = { if (text.isBlank()) onClose() }) { heard ->
        text = heard
        // One tap: if the project is clear, save right away.
        pickLocation(location ?: initialLocation, g.settings.defaultLocation, locations)?.let { send(heard, it) }
    }
    LaunchedEffect(Unit) {
        if (!started) {
            started = true
            speech.start()
        }
    }
    QuickSheet("Sprach-Notiz", R.drawable.ic_mic, onClose, subtitle = "Wird zur Aufgabe – oder zur Notiz, wenn ein Kontakt genannt wird") {
        when (busy) {
            is Busy.Done -> {
                DoneView(busy.message, onClose)
                return@QuickSheet
            }
            Busy.Working -> {
                Column(modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    androidx.compose.material3.CircularProgressIndicator()
                    Spacer(Modifier.height(10.dp))
                    Text("„$text“", style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
                }
                return@QuickSheet
            }
            else -> Unit
        }
        if (text.isBlank()) {
            Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Surface(onClick = { speech.start() }, shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.primary) {
                    Icon(painterResource(R.drawable.ic_mic), "Sprechen", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.padding(22.dp).size(36.dp))
                }
                Spacer(Modifier.height(8.dp))
                Text("Tippen und sprechen", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(8.dp))
            Field(text, { text = it }, "…oder tippen", minLines = 2)
        } else {
            Field(text, { text = it }, "Text", minLines = 3, trailing = { MicButton(speech) })
            if (locations.size > 1) {
                Spacer(Modifier.height(10.dp))
                LocationPicker(locations, effective, { location = it })
            }
            ErrorText(busy)
            Spacer(Modifier.height(14.dp))
            PrimaryButton("Speichern", busy, enabled = text.isNotBlank() && effective != null, icon = R.drawable.ic_check) { send(text.trim(), effective!!) }
        }
    }
}

