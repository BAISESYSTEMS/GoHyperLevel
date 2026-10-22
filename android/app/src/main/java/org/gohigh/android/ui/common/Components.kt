package org.gohigh.android.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.gohigh.android.R
import org.gohigh.android.api.ALL_LOCATIONS
import org.gohigh.android.api.LocationInfo
import org.gohigh.android.ui.theme.Brand

/** App mark on the brand gradient. */
@Composable
fun LogoBadge(size: Dp = 44.dp) {
    Box(
        modifier = Modifier.size(size).clip(RoundedCornerShape(size * 0.3f)).background(Brand.Gradient),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(R.drawable.ic_logo_mark), contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.6f))
    }
}

@Composable
fun IconCircle(icon: Int, tint: Color = MaterialTheme.colorScheme.primary, bg: Color = MaterialTheme.colorScheme.primaryContainer, size: Dp = 40.dp) {
    Box(modifier = Modifier.size(size).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

/** Rounded section with a small caps title. */
@Composable
fun Section(title: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            title.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 20.dp, bottom = 6.dp, top = 18.dp),
        )
        Surface(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(content = content)
        }
    }
}

@Composable
fun SettingRow(
    icon: Int,
    title: String,
    subtitle: String? = null,
    onClick: (() -> Unit)? = null,
    tint: Color = MaterialTheme.colorScheme.primary,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = Modifier.fillMaxWidth().let { if (onClick != null) it.clickable(onClick = onClick) else it }.padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        }
    }
}

/** Dropdown to pick a project (sub-account), optionally with "Alle Projekte". */
@Composable
fun LocationPicker(
    locations: List<LocationInfo>,
    selected: String?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    allowAll: Boolean = false,
) {
    var open by remember { mutableStateOf(false) }
    val label = when {
        selected == ALL_LOCATIONS -> "Alle Projekte"
        selected == null -> "Projekt wählen"
        else -> locations.firstOrNull { it.id == selected }?.name ?: "Projekt wählen"
    }
    Box(modifier = modifier) {
        Surface(
            onClick = { open = true },
            shape = RoundedCornerShape(14.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Row(modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_folder), null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(4.dp))
                Icon(painterResource(R.drawable.ic_keyboard_arrow_down), null, modifier = Modifier.size(18.dp))
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (allowAll) DropdownMenuItem(text = { Text("Alle Projekte") }, onClick = { open = false; onSelect(ALL_LOCATIONS) })
            locations.forEach { l ->
                DropdownMenuItem(text = { Text(l.name) }, onClick = { open = false; onSelect(l.id) })
            }
        }
    }
}

/** Horizontal row of options with consistent spacing. */
@Composable
fun ChipRow(content: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { content() }
}
