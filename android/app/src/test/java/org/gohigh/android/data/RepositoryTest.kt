package org.gohigh.android.data

import org.gohigh.android.BuildConfig
import org.gohigh.android.api.ApiException
import org.gohigh.android.api.PairResponse
import org.gohigh.android.api.ApiUser
import org.gohigh.android.api.Summary
import org.gohigh.android.support.FakePrefs
import org.gohigh.android.support.fixture
import org.gohigh.android.support.json
import org.gohigh.android.support.testApi
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.time.ZoneOffset

class RepositoryTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private var now = 1_759_572_000_000L // 2025-10-04T10:00Z
    private lateinit var session: Session
    private lateinit var cache: DiskCache
    private lateinit var repo: Repository

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        session = Session(InMemoryTokenStore("ghm_test"), FakePrefs()) { false }
        cache = DiskCache(tmp.newFolder("cache"), clock = { now })
        repo = Repository(testApi(server, onUnauthorized = { session.markExpired() }), cache, session, { now }, { ZoneOffset.UTC })
    }

    @After fun tearDown() = server.shutdown()

    @Test fun refreshCachesAndRecordsErrors() = runBlocking {
        server.enqueue(json(fixture("tasks.json")))
        val c = repo.refresh(DataRequest.Tasks("all", "today"))
        assertEquals(now, c.fetchedAt)
        assertEquals(c.data, repo.cached(DataRequest.Tasks("all", "today"))!!.data)
        assertEquals(listOf("tasks/all/today"), cache.keys("tasks/"))
        server.enqueue(json("""{"error":"Serverfehler (500)"}""", 500))
        try {
            repo.refresh(DataRequest.Tasks("all", "today")); fail()
        } catch (_: ApiException.Http) {
        }
        assertEquals("Serverfehler (500)", repo.error(DataRequest.Tasks("all", "today"))!!.message)
        // the old data stays for the widget
        assertNotNull(repo.cached(DataRequest.Tasks("all", "today")))
        // a fresh value is served from the cache
        assertEquals(c.fetchedAt, repo.load(DataRequest.Tasks("all", "today"), 60_000).fetchedAt)
    }

    @Test fun localTaskToggleAndInboxRead() = runBlocking {
        server.enqueue(json(fixture("tasks.json")))
        val tasks = repo.refresh(DataRequest.Tasks("all", "today")).data
        val first = tasks.first { !it.done }
        val rev = repo.revision.value
        repo.setTaskDoneLocally(first.id, true)
        assertTrue(repo.cached(DataRequest.Tasks("all", "today"))!!.data.first { it.id == first.id }.done)
        assertTrue(repo.revision.value > rev)
        server.enqueue(json(fixture("inbox.json")))
        val inbox = repo.refresh(DataRequest.Inbox("all", false)).data
        val unread = inbox.first { it.isUnread }
        repo.markReadLocally(unread.conversationId)
        assertFalse(repo.cached(DataRequest.Inbox("all", false))!!.data.first { it.conversationId == unread.conversationId }.isUnread)
    }

    @Test fun summaryHistoryRollsOverPerDay() = runBlocking {
        server.enqueue(json("""{"unread_conversations":3}"""))
        repo.refresh(DataRequest.SummaryOf("all"))
        assertNull(repo.history("all")!!.previous)
        now += 24 * 3600_000L
        server.enqueue(json("""{"unread_conversations":9}"""))
        repo.refresh(DataRequest.SummaryOf("all"))
        val h = repo.history("all")!!
        assertEquals(3, h.previous!!.unreadConversations)
        assertEquals(9, h.current.unreadConversations)
        assertEquals(h, SummaryHistory("2025-10-04", Summary(unreadConversations = 3)).record("2025-10-05", Summary(unreadConversations = 9)))
    }

    @Test fun revokedTokenExpiresTheSessionAndStopsTheRefresh() = runBlocking {
        server.enqueue(json("""{"error":"Dieses Gerät ist abgemeldet"}""", 401))
        server.enqueue(json(fixture("summary.json")))
        val r = repo.refreshAll(listOf(DataRequest.Me, DataRequest.SummaryOf("all")))
        assertTrue(r.unauthorized)
        assertEquals(AuthStatus.EXPIRED, session.status.value)
        session.signIn(PairResponse("ghm_new", "dev_2", "Pixel", ApiUser("u1", "Paul")))
        assertEquals(AuthStatus.ACTIVE, session.status.value)
        assertEquals("Paul", session.user!!.name)
        session.signOut()
        assertEquals(AuthStatus.SIGNED_OUT, session.status.value)
        assertNull(session.token())
    }

    @Test fun settingsNormaliseAndForgetAccountState() {
        val s = AppSettings(FakePrefs())
        assertEquals(BuildConfig.DEFAULT_BASE_URL, s.baseUrl)
        s.baseUrl = "crm.example.com/"
        assertEquals("https://crm.example.com", s.baseUrl)
        s.baseUrl = ""
        assertEquals(BuildConfig.DEFAULT_BASE_URL, s.baseUrl)
        s.refreshMinutes = 5
        assertEquals(15, s.refreshMinutes)
        s.feedCursor = "9"
        s.defaultLocation = "loc_a"
        val tick = s.changes.value
        s.clearAccountState()
        assertNull(s.feedCursor)
        assertNull(s.defaultLocation)
        assertTrue(s.changes.value > tick)
        assertEquals(NotifyCategory.FEEDBACK, NotifyCategory.forType("feedback"))
        assertEquals(NotifyCategory.CHAT, NotifyCategory.forType("chat"))
        assertEquals(NotifyCategory.WEBSITES, NotifyCategory.forType("website_up"))
        assertNull(NotifyCategory.forType("nope"))
    }
}
