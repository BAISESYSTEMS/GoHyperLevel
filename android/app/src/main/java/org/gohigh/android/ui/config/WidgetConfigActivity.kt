package org.gohigh.android.ui.config

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.lifecycle.lifecycleScope
import org.gohigh.android.AppGraph
import org.gohigh.android.R
import org.gohigh.android.api.ALL_LOCATIONS
import org.gohigh.android.api.LocationInfo
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.DataRequest
import org.gohigh.android.ui.common.Section
import org.gohigh.android.ui.main.MainActivity
import org.gohigh.android.ui.theme.Brand
import org.gohigh.android.ui.theme.GoHighTheme
import org.gohigh.android.widget.KpiMetric
import org.gohigh.android.widget.QuickAction
import org.gohigh.android.widget.TaskFilter
import org.gohigh.android.widget.WidgetConfig
import org.gohigh.android.widget.WidgetKind
import org.gohigh.android.work.WorkScheduler
import kotlinx.coroutines.launch

/** Shown when a widget is added (and on "reconfigure"): project + widget-specific options. */
class WidgetConfigActivity : ComponentActivity() {
    private val g by lazy { AppGraph.get(this) }
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var locations by mutableStateOf<List<LocationInfo>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        appWidgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        setResult(Activity.RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        val kind = WidgetKind.ofAppWidget(this, appWidgetId) ?: WidgetKind.COCKPIT
        locations = g.repository.me()?.locations.orEmpty()
        lifecycleScope.launch {
            if (g.session.status.value == AuthStatus.ACTIVE) {
                runCatching { g.repository.load(DataRequest.Me, maxAgeMs = 10 * 60_000) }.getOrNull()?.data?.locations?.let { locations = it }
            }
        }
        val initial = g.widgetConfigs.get(appWidgetId)
        setContent {
            GoHighTheme(dynamic = g.settings.dynamicColor) {
                WidgetConfigScreen(
                    kind = kind,
                    initial = initial,
                    locations = locations,
                    signedIn = g.session.status.value == AuthStatus.ACTIVE,
                    onSignIn = { startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN)) },
                    onCancel = { finish() },
                    onSave = ::save,
                )
            }
        }
    }

    private fun save(config: WidgetConfig) {
        g.widgetConfigs.set(appWidgetId, config)
        lifecycleScope.launch {
            val kind = WidgetKind.ofAppWidget(this@WidgetConfigActivity, appWidgetId)
            if (kind != null) {
                runCatching {
                    val id = GlanceAppWidgetManager(this@WidgetConfigActivity).getGlanceIdBy(appWidgetId)
                    kind.widget().update(this@WidgetConfigActivity, id)
                }
            }
            g.repository.bump()
            WorkScheduler.schedulePeriodic(this@WidgetConfigActivity, g.settings.refreshMinutes)
            WorkScheduler.refreshNow(this@WidgetConfigActivity)
            setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
            finish()
        }
    }
}

@Composable
fun WidgetConfigScreen(
    kind: WidgetKind,
    initial: WidgetConfig,
    locations: List<LocationInfo>,
    signedIn: Boolean,
    onSignIn: () -> Unit,
    onCancel: () -> Unit,
    onSave: (WidgetConfig) -> Unit,
) {
    var cfg by remember { mutableStateOf(initial) }
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Box(modifier = Modifier.fillMaxWidth().background(Brand.Gradient)) {
            Column(modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars).padding(start = 8.dp, end = 20.dp, bottom = 20.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onCancel) { Icon(painterResource(R.drawable.ic_close), "Abbrechen", tint = Color.White) }
                    Text("Widget einrichten", style = MaterialTheme.typography.titleMedium, color = Color.White.copy(alpha = 0.9f))
                }
                Row(modifier = Modifier.padding(start = 12.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(48.dp).clip(RoundedCornerShape(16.dp)).background(Color.White.copy(alpha = 0.2f)), contentAlignment = Alignment.Center) {
                        Icon(painterResource(kind.icon), null, tint = Color.White, modifier = Modifier.size(26.dp))
                    }
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text(kind.title, style = MaterialTheme.typography.headlineSmall, color = Color.White)
                        Text(kind.description, style = MaterialTheme.typography.bodyMedium, color = Color.White.copy(alpha = 0.85f))
                    }
                }
            }
        }
        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            if (!signedIn) {
                Section("Anmeldung") {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("Melde dich einmal in der HyperLevel-App an – dann zeigt das Widget deine Daten.", style = MaterialTheme.typography.bodyMedium)
                        TextButton(onClick = onSignIn) { Text("Zur Anmeldung") }
                    }
                }
            }
            if (kind.supportsLocation) {
                Section("Projekt") {
                    Choice("Alle Projekte", "Zusammen über alle Sub-Accounts", cfg.location == ALL_LOCATIONS) { cfg = cfg.copy(location = ALL_LOCATIONS) }
                    locations.forEach { l ->
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Choice(l.name, null, cfg.location == l.id) { cfg = cfg.copy(location = l.id) }
                    }
                    if (locations.isEmpty() && signedIn) Text("Projekte werden geladen…", modifier = Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
            when (kind) {
                WidgetKind.INBOX -> Section("Anzeige") {
                    Toggle("Nur ungelesene", "Gelesene Unterhaltungen ausblenden", cfg.unreadOnly) { cfg = cfg.copy(unreadOnly = it) }
                }
                WidgetKind.CALLS -> Section("Anzeige") {
                    Toggle("Nur verpasste Anrufe", "Sonst alle letzten Anrufe", cfg.missedOnly) { cfg = cfg.copy(missedOnly = it) }
                }
                WidgetKind.TASKS -> Section("Welche Aufgaben") {
                    TaskFilter.entries.forEachIndexed { i, f ->
                        if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Choice(f.label, null, cfg.taskFilter == f.key) { cfg = cfg.copy(taskFilter = f.key) }
                    }
                }
                WidgetKind.KPI -> Section("Kennzahl") {
                    KpiMetric.entries.forEachIndexed { i, m ->
                        if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Choice(m.label, null, cfg.metric == m.key, icon = m.icon) { cfg = cfg.copy(metric = m.key) }
                    }
                }
                WidgetKind.QUICK -> Section("Knöpfe") {
                    QuickAction.entries.forEachIndexed { i, a ->
                        if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        val on = a.key in cfg.actions
                        Row(
                            modifier = Modifier.fillMaxWidth().clickable {
                                cfg = cfg.copy(actions = if (on) cfg.actions - a.key else QuickAction.entries.map { it.key }.filter { it in cfg.actions || it == a.key })
                            }.padding(horizontal = 12.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = on, onCheckedChange = null)
                            Spacer(Modifier.width(8.dp))
                            Icon(painterResource(a.icon), null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(a.label, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                    Text("Kleine Größen zeigen die ersten 4–5 Knöpfe.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                }
                else -> Unit
            }
            Spacer(Modifier.height(16.dp))
        }
        Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 8.dp) {
            Row(modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp)) {
                Button(
                    onClick = { onSave(cfg) },
                    enabled = kind != WidgetKind.QUICK || cfg.actions.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                    shape = RoundedCornerShape(16.dp),
                ) { Text("Widget hinzufügen") }
            }
        }
    }
}

@Composable
private fun Choice(title: String, subtitle: String?, selected: Boolean, icon: Int? = null, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = null)
        Spacer(Modifier.width(8.dp))
        if (icon != null) {
            Icon(painterResource(icon), null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
        }
        Column {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Toggle(title: String, subtitle: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().clickable { onChange(!value) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = value, onCheckedChange = onChange)
    }
}
