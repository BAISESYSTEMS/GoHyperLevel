package org.gohigh.android.ui.quick

import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.api.ALL_LOCATIONS
import org.gohigh.android.api.ContactItem
import org.gohigh.android.api.LocationInfo
import org.gohigh.android.data.DataRequest
import org.gohigh.android.ui.common.IconCircle
import org.gohigh.android.ui.theme.Brand
import kotlinx.coroutines.delay

/** Result state of a quick action. */
sealed interface Busy {
    data object Idle : Busy
    data object Working : Busy
    data class Done(val message: String) : Busy
    data class Failed(val message: String) : Busy
}

/** Bottom sheet over the home screen with a header and a ✕. Tapping outside closes it. */
@Composable
fun QuickSheet(title: String, icon: Int, onClose: () -> Unit, subtitle: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize().clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClose),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth().widthIn(max = 600.dp).imePadding()
                .clickable(remember { MutableInteractionSource() }, indication = null, onClick = {}),
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 12.dp,
        ) {
            Column(modifier = Modifier.navigationBarsPadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 12.dp, top = 10.dp, bottom = 20.dp)) {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Box(modifier = Modifier.width(36.dp).height(4.dp).background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(2.dp)))
                }
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconCircle(icon, size = 42.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                    }
                    IconButton(onClick = onClose) { Icon(painterResource(R.drawable.ic_close), contentDescription = "Schließen") }
                }
                Spacer(Modifier.height(14.dp))
                Column(modifier = Modifier.padding(end = 8.dp), content = content)
            }
        }
    }
}

/** "Gespeichert ✓" then close. */
@Composable
fun DoneView(message: String, onClose: () -> Unit) {
    LaunchedEffect(message) {
        delay(1300)
        onClose()
    }
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        IconCircle(R.drawable.ic_check, tint = Brand.Success, bg = Brand.Success.copy(alpha = 0.14f), size = 64.dp)
        Spacer(Modifier.height(12.dp))
        Text(message, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
    }
}

@Composable
fun ErrorText(busy: Busy) {
    if (busy is Busy.Failed) {
        Spacer(Modifier.height(8.dp))
        Text(busy.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
fun PrimaryButton(label: String, busy: Busy, enabled: Boolean = true, icon: Int? = null, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled && busy !is Busy.Working, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) {
        if (busy is Busy.Working) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp), color = MaterialTheme.colorScheme.onPrimary)
        } else {
            if (icon != null) {
                Icon(painterResource(icon), null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(label)
        }
    }
}

/** Speech input (German) via the system recognizer. */
class Speech(private val launch: () -> Unit) {
    fun start() = launch()
}

@Composable
fun rememberSpeech(prompt: String = "Sprich jetzt", onCancel: () -> Unit = {}, onText: (String) -> Unit): Speech {
    val ctx = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val text = r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (text.isNullOrBlank()) onCancel() else onText(text)
    }
    return remember {
        Speech {
            try {
                launcher.launch(
                    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "de-DE")
                        .putExtra(RecognizerIntent.EXTRA_PROMPT, prompt),
                )
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(ctx, "Spracheingabe ist auf diesem Gerät nicht verfügbar", Toast.LENGTH_LONG).show()
                onCancel()
            }
        }
    }
}

@Composable
fun MicButton(speech: Speech) {
    IconButton(onClick = { speech.start() }) {
        Icon(painterResource(R.drawable.ic_mic), contentDescription = "Diktieren", tint = MaterialTheme.colorScheme.primary)
    }
}

@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    minLines: Int = 1,
    keyboard: KeyboardType = KeyboardType.Text,
    trailing: (@Composable () -> Unit)? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        modifier = modifier.fillMaxWidth(),
        minLines = minLines,
        singleLine = minLines == 1,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        trailingIcon = trailing,
        shape = RoundedCornerShape(14.dp),
    )
}

/** Locations of the user (cache first, then a refresh). */
@Composable
fun rememberLocations(): List<LocationInfo> {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    var list by remember { mutableStateOf(g.repository.me()?.locations.orEmpty()) }
    LaunchedEffect(Unit) {
        runCatching { g.repository.load(DataRequest.Me, maxAgeMs = 6 * 3600_000L) }.getOrNull()?.data?.locations?.let { list = it }
    }
    return list
}

/** Project for new items: explicit > widget > default setting > only project. */
fun pickLocation(explicit: String?, default: String?, locations: List<LocationInfo>): String? = when {
    !explicit.isNullOrBlank() && explicit != ALL_LOCATIONS -> explicit
    !default.isNullOrBlank() && (locations.isEmpty() || locations.any { it.id == default }) -> default
    locations.size == 1 -> locations[0].id
    else -> null
}

/** Debounced contact search with recent contacts when the query is empty. */
@Composable
fun ContactSearch(location: String?, onPick: (ContactItem) -> Unit) {
    val ctx = LocalContext.current
    val g = remember { AppGraph.get(ctx) }
    var q by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<ContactItem>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(q, location) {
        delay(if (q.isEmpty()) 0 else 300)
        try {
            results = g.api.contacts(location ?: ALL_LOCATIONS, q.trim(), 8)
            error = null
        } catch (e: Exception) {
            error = e.message
        }
    }
    Field(q, { q = it }, "Kontakt suchen", trailing = { Icon(painterResource(R.drawable.ic_person_search), null) })
    Spacer(Modifier.height(6.dp))
    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    val list = results
    when {
        list == null -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp) }
        list.isEmpty() -> Text("Kein Kontakt gefunden", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp))
        else -> Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
            list.forEachIndexed { i, c ->
                if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(
                    modifier = Modifier.fillMaxWidth().clickable { onPick(c) }.padding(vertical = 10.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconCircle(R.drawable.ic_person, size = 36.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(c.name.ifBlank { c.email ?: c.phone ?: "Kontakt" }, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
                        val sub = listOfNotNull(c.phone, c.email, c.company, c.locationName.ifBlank { null }).joinToString(" · ")
                        if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
