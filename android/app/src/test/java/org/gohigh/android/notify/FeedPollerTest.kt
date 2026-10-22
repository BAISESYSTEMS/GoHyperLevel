package org.gohigh.android.notify

import org.gohigh.android.api.ApiException
import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.FeedEvent
import org.gohigh.android.api.FeedResponse
import org.gohigh.android.data.AppSettings
import org.gohigh.android.data.NotifyCategory
import org.gohigh.android.support.FakePrefs
import org.gohigh.android.support.fixture
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FeedPollerTest {
    private val settings = AppSettings(FakePrefs())
    private val posted = mutableListOf<Pair<FeedEvent, NotifyCategory>>()
    private val sinceSeen = mutableListOf<String?>()
    private var next: () -> FeedResponse = { error("no page") }
    private val poller = FeedPoller(settings, { since -> sinceSeen += since; next() }, { e, c -> posted += e to c })

    private fun page(name: String) = ApiJson.decodeFromString(FeedResponse.serializer(), fixture(name))

    @Test fun firstPollOnlyStoresTheCursor() = runBlocking {
        next = { page("feed_first.json") }
        val o = poller.poll()
        assertTrue(o.initialized)
        assertEquals("57", settings.feedCursor)
        assertTrue(posted.isEmpty())
        assertEquals(listOf<String?>(null), sinceSeen)
    }

    @Test fun firstPollIgnoresBacklogEvenIfServerSendsEvents() = runBlocking {
        next = { page("feed.json") }
        poller.poll()
        assertTrue(posted.isEmpty())
        assertEquals("60", settings.feedCursor)
    }

    @Test fun laterPollsNotifyAndAdvance() = runBlocking {
        settings.feedCursor = "57"
        next = { page("feed.json") }
        val o = poller.poll()
        assertEquals(3, o.notified)
        assertEquals(listOf(NotifyCategory.MESSAGES, NotifyCategory.CALLS, NotifyCategory.WEBSITES), posted.map { it.second })
        assertEquals("60", settings.feedCursor)
        assertEquals(listOf<String?>("57"), sinceSeen)
    }

    @Test fun duplicatesAreNotNotifiedTwice() = runBlocking {
        settings.feedCursor = "57"
        next = { page("feed.json") }
        poller.poll()
        settings.feedCursor = "57" // e.g. the server resent an overlapping page
        val o = poller.poll()
        assertEquals(0, o.notified)
        assertEquals(3, o.skipped)
        assertEquals(3, posted.size)
    }

    @Test fun disabledCategoriesAndUnknownTypesAreSkipped() = runBlocking {
        settings.feedCursor = "1"
        settings.setNotifyEnabled(NotifyCategory.CALLS, false)
        next = {
            FeedResponse("5", page("feed.json").events + FeedEvent("61", type = "something_new", title = "?"))
        }
        val o = poller.poll()
        assertEquals(2, o.notified)
        assertEquals(2, o.skipped)
        assertTrue(posted.none { it.second == NotifyCategory.CALLS })
    }

    @Test fun failedFetchKeepsTheCursor() = runBlocking {
        settings.feedCursor = "57"
        next = { throw ApiException.Http(500, "Serverfehler (500)") }
        try {
            poller.poll(); fail()
        } catch (_: ApiException) {
        }
        assertEquals("57", settings.feedCursor)
    }

    @Test fun seenListIsBounded() {
        settings.feedSeen = (1..1000).map { "$it" }
        assertEquals(AppSettings.MAX_SEEN, settings.feedSeen.size)
        assertEquals("1000", settings.feedSeen.last())
    }
}
