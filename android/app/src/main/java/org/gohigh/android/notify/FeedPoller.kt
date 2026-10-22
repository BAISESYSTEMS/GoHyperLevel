package org.gohigh.android.notify

import org.gohigh.android.api.FeedEvent
import org.gohigh.android.api.FeedResponse
import org.gohigh.android.data.AppSettings
import org.gohigh.android.data.NotifyCategory

/**
 * Turns `/api/mobile/feed` pages into local notifications.
 *
 * Rules: the very first poll (no cursor) only stores the cursor – no backlog flood. Later polls notify new
 * events of enabled categories, skip ids already notified (overlapping pages) and advance the cursor only
 * after a successful fetch, so nothing is lost when a poll fails.
 */
class FeedPoller(
    private val settings: AppSettings,
    private val fetch: suspend (since: String?) -> FeedResponse,
    private val post: (FeedEvent, NotifyCategory) -> Unit,
) {
    data class Outcome(val notified: Int, val skipped: Int, val initialized: Boolean)

    suspend fun poll(): Outcome {
        val cursor = settings.feedCursor
        val page = fetch(cursor)
        if (cursor.isNullOrBlank()) {
            settings.feedCursor = page.cursor.ifBlank { null }
            return Outcome(0, page.events.size, initialized = true)
        }
        val seen = settings.feedSeen.toMutableList()
        val seenSet = seen.toHashSet()
        var notified = 0
        var skipped = 0
        for (event in page.events.sortedBy { it.at.orEmpty() }) {
            val category = NotifyCategory.forType(event.type)
            when {
                event.id in seenSet -> skipped++
                category == null || !settings.notifyEnabled(category) -> {
                    skipped++
                    seen += event.id
                    seenSet += event.id
                }
                else -> {
                    post(event, category)
                    notified++
                    seen += event.id
                    seenSet += event.id
                }
            }
        }
        settings.feedSeen = seen
        if (page.cursor.isNotBlank()) settings.feedCursor = page.cursor
        return Outcome(notified, skipped, initialized = false)
    }
}
