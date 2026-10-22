package org.gohigh.android.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import org.gohigh.android.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Kinds of feed events the app turns into local notifications – one channel each, switchable in the settings. */
enum class NotifyCategory(val key: String, val label: String, private val types: Set<String>) {
    MESSAGES("messages", "Nachrichten", setOf("message")),
    CHAT("chat", "Team-Chat", setOf("chat")),
    CALLS("calls", "Anrufe", setOf("call_missed")),
    LEADS("leads", "Leads", setOf("lead")),
    PAYMENTS("payments", "Zahlungen", setOf("payment")),
    WEBSITES("websites", "Websites", setOf("website_down", "website_up")),
    TASKS("tasks", "Aufgaben", setOf("task_due")),
    REVIEWS("reviews", "Bewertungen", setOf("review")),
    FEEDBACK("feedback", "Meine Meldungen", setOf("feedback"));

    /** Android notification channel of this category. */
    val channelId: String get() = "feed_$key"

    companion object {
        /** Category of a feed event type; null for types this app version doesn't know (they are skipped). */
        fun forType(type: String): NotifyCategory? = entries.firstOrNull { type in it.types }
    }
}

/**
 * App settings in SharedPreferences (never backed up). [changes] ticks on every write so Compose screens
 * re-read their state.
 */
class AppSettings(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences(FILE, Context.MODE_PRIVATE))

    private val _changes = MutableStateFlow(0L)
    val changes: StateFlow<Long> = _changes.asStateFlow()

    private fun changed() {
        _changes.value = _changes.value + 1
    }

    private fun put(block: SharedPreferences.Editor.() -> Unit) {
        prefs.edit(action = block)
        changed()
    }

    /** Server address, e.g. https://crm.example.com (empty = the built-in default). */
    var baseUrl: String
        get() = prefs.getString(K_BASE, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.DEFAULT_BASE_URL
        set(v) = put { val n = normalizeUrl(v); if (n.isBlank()) remove(K_BASE) else putString(K_BASE, n) }

    var demoMode: Boolean
        get() = prefs.getBoolean(K_DEMO, false)
        set(v) = put { putBoolean(K_DEMO, v) }

    /** Cursor of /api/mobile/feed (null = next poll only initialises). */
    var feedCursor: String?
        get() = prefs.getString(K_CURSOR, null)
        set(v) = put { if (v.isNullOrBlank()) remove(K_CURSOR) else putString(K_CURSOR, v) }

    /** Feed ids already shown (bounded, newest last) – overlapping pages never notify twice. */
    var feedSeen: List<String>
        get() = prefs.getString(K_SEEN, null)?.split('\n')?.filter { it.isNotBlank() } ?: emptyList()
        set(v) = put { putString(K_SEEN, v.takeLast(MAX_SEEN).joinToString("\n")) }

    fun notifyEnabled(c: NotifyCategory): Boolean = prefs.getBoolean("notify_${c.key}", true)

    fun setNotifyEnabled(c: NotifyCategory, on: Boolean) = put { putBoolean("notify_${c.key}", on) }

    /** Background refresh interval of widgets and the feed (WorkManager minimum: 15). */
    var refreshMinutes: Int
        get() = prefs.getInt(K_REFRESH, 15).coerceIn(15, 24 * 60)
        set(v) = put { putInt(K_REFRESH, v.coerceIn(15, 24 * 60)) }

    /** Sub-account for new tasks, contacts and voice notes when several exist. */
    var defaultLocation: String?
        get() = prefs.getString(K_LOCATION, null)
        set(v) = put { if (v.isNullOrBlank()) remove(K_LOCATION) else putString(K_LOCATION, v) }

    var dynamicColor: Boolean
        get() = prefs.getBoolean(K_DYNAMIC, false)
        set(v) = put { putBoolean(K_DYNAMIC, v) }

    var showMenuButton: Boolean
        get() = prefs.getBoolean(K_MENU, true)
        set(v) = put { putBoolean(K_MENU, v) }

    /** „Schütteln zum Melden“: shaking the phone in the app opens „Fehler melden“ with a screenshot. */
    var shakeToReport: Boolean
        get() = prefs.getBoolean(K_SHAKE, false)
        set(v) = put { putBoolean(K_SHAKE, v) }

    var debugUnlocked: Boolean
        get() = prefs.getBoolean(K_DEBUG, false)
        set(v) = put { putBoolean(K_DEBUG, v) }

    var lastUpdateCheck: Long
        get() = prefs.getLong(K_UPDATE_CHECK, 0L)
        set(v) = put { putLong(K_UPDATE_CHECK, v) }

    /** Version code the update dialog was last shown for (no nagging on every start). */
    var lastUpdatePromptCode: Int
        get() = prefs.getInt(K_UPDATE_PROMPT, 0)
        set(v) = put { putInt(K_UPDATE_PROMPT, v) }

    /** Signing out: forget what belongs to the account (feed position, default project). */
    fun clearAccountState() = put {
        remove(K_CURSOR)
        remove(K_SEEN)
        remove(K_LOCATION)
    }

    companion object {
        const val FILE = "gohigh_settings"
        const val MAX_SEEN = 300
        private const val K_BASE = "base_url"
        private const val K_DEMO = "demo_mode"
        private const val K_CURSOR = "feed_cursor"
        private const val K_SEEN = "feed_seen"
        private const val K_REFRESH = "refresh_minutes"
        private const val K_LOCATION = "default_location"
        private const val K_DYNAMIC = "dynamic_color"
        private const val K_MENU = "show_menu_button"
        private const val K_SHAKE = "shake_to_report"
        private const val K_DEBUG = "debug_unlocked"
        private const val K_UPDATE_CHECK = "last_update_check"
        private const val K_UPDATE_PROMPT = "last_update_prompt_code"

        /** "gh.example.com/" → "https://gh.example.com"; blank stays blank. */
        fun normalizeUrl(v: String): String {
            val t = v.trim().trimEnd('/')
            if (t.isBlank()) return ""
            return if (t.startsWith("http://") || t.startsWith("https://")) t else "https://$t"
        }
    }
}
