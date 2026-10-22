package org.gohigh.android.feedback

import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.BugReport
import org.gohigh.android.api.BugReportDetail
import org.gohigh.android.api.BugReportRequest
import org.gohigh.android.api.DeviceDiagnostics
import org.gohigh.android.api.FakeBackend
import org.gohigh.android.api.VoteResponse
import org.gohigh.android.api.Wish
import org.gohigh.android.api.WishDetail
import org.gohigh.android.api.WishRequest
import org.gohigh.android.api.ApiException
import org.gohigh.android.api.GoHighApi
import org.gohigh.android.support.fixture
import org.gohigh.android.support.json
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.TimeUnit

class FeedbackTest {
    @Test fun apiErrorLogKeepsTheLast20WithoutReportingCalls() {
        var t = 0L
        val log = ApiErrorLog(clock = { t })
        repeat(25) { i -> t = i * 1000L; log.record("GET", "/api/mobile/tasks?i=$i", 500, "Serverfehler (500)") }
        log.record("POST", "/api/mobile/client-errors", 500, "x")
        val s = log.snapshot()
        assertEquals(20, s.size)
        assertEquals("/api/mobile/tasks?i=5", s.first().path)
        assertEquals("/api/mobile/tasks?i=24", s.last().path)
        assertEquals("1970-01-01T00:00:24Z", s.last().at)
        log.record("GET", "/x/" + "a".repeat(500), 0, "b".repeat(500))
        assertEquals(300, log.snapshot().last().path.length)
        assertEquals(300, log.snapshot().last().error.length)
    }

    @Test fun shakeNeedsThreeJoltsAndThenRests() {
        val l = ShakeLogic()
        val strong = 9.81f * 3f
        // walking / normal handling: never
        assertFalse((0..50).any { l.onSample(0f, 9.81f, 1f, it * 20L) })
        // one jolt with many samples above the threshold counts once (gap)
        assertFalse(l.onSample(strong, 0f, 0f, 2000))
        assertFalse(l.onSample(strong, 0f, 0f, 2020))
        assertFalse(l.onSample(strong, 0f, 0f, 2200))
        assertTrue(l.onSample(strong, 0f, 0f, 2400))
        // cooldown
        assertFalse(l.onSample(strong, 0f, 0f, 2600))
        assertFalse(l.onSample(strong, 0f, 0f, 2800))
        assertFalse(l.onSample(strong, 0f, 0f, 3000))
        // too slow: jolts spread over more than the window
        val slow = ShakeLogic()
        assertFalse(slow.onSample(strong, 0f, 0f, 0) || slow.onSample(strong, 0f, 0f, 1000) || slow.onSample(strong, 0f, 0f, 2000) || slow.onSample(strong, 0f, 0f, 3000))
    }

    @Test fun serverResponsesParse() {
        val list = ApiJson.decodeFromString(ListSerializer(BugReport.serializer()), fixture("bug_reports.json"))
        assertEquals(1, list.size)
        assertEquals("in_arbeit", list[0].status.key)
        assertEquals("In Arbeit", list[0].status.label)
        assertTrue(list[0].unread)
        assertNull(list[0].duplicateOf)
        val d = ApiJson.decodeFromString(BugReportDetail.serializer(), fixture("bug_report_detail.json"))
        assertEquals(listOf("user", "team", "status", "status"), d.thread.map { it.type }) // reply → Bestätigt, then In Arbeit
        assertTrue(d.thread[0].mine)
        assertEquals("Pixel 9", d.diagnostics!!.jsonObject["device"]!!.jsonObject["model"]!!.jsonPrimitive.content)
        assertTrue(d.canReply)
        val created = ApiJson.decodeFromString(BugReport.serializer(), fixture("bug_report_created.json"))
        assertEquals(1, created.number)
        assertEquals("android", created.platform)
        val wishes = ApiJson.decodeFromString(ListSerializer(Wish.serializer()), fixture("wishes.json"))
        assertEquals("planned", wishes[0].status.board)
        assertEquals("Geplant", wishes[0].status.label)
        assertTrue(wishes[0].myVote && wishes[0].mine)
        assertEquals(1, ApiJson.decodeFromString(WishDetail.serializer(), fixture("wish_created.json")).wish.votes)
        val v = ApiJson.decodeFromString(VoteResponse.serializer(), fixture("vote.json"))
        assertEquals(0, v.votes)
        assertFalse(v.myVote)
    }

    @Test fun clientSendsReportsWishesAndVotes() = runBlocking {
        val server = MockWebServer().apply { start() }
        val failures = mutableListOf<String>()
        val api = GoHighApi(
            http = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build(),
            baseUrl = { server.url("/").toString() },
            token = { "ghm_test" },
            userAgent = "HyperLevel-Test",
            onFailure = { m, p, s, msg -> failures += "$m $p $s $msg" },
        )
        try {
            server.enqueue(json(fixture("bug_report_created.json")))
            server.enqueue(json(fixture("bug_reports.json")))
            server.enqueue(json(fixture("wishes.json")))
            server.enqueue(json(fixture("vote.json")))
            server.enqueue(json(fixture("wish_created.json")))
            server.enqueue(json("""{"error":"Zu viele Anfragen – bitte kurz warten"}""", 429))

            val r = api.createBugReport(BugReportRequest(category = "bug", what = "Widget leer", severity = "hoch", screen = "/app/dashboard", device = DeviceDiagnostics("Pixel 9", "Google", "15", 35, "1.0.1 (2)"), apiErrors = emptyList(), screenshot = "data:image/jpeg;base64,AAAA"))
            assertEquals(1, r.number)
            api.bugReports()
            api.wishes("new", "ticket")
            api.vote("w1", on = false)
            api.createWish(WishRequest("Widget für Tickets", "Bitte", "App"))
            try {
                api.vote("w1", on = true); fail()
            } catch (e: ApiException.Http) {
                assertEquals(429, e.code)
            }

            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/api/mobile/bug-reports", req.path)
            assertEquals("Bearer ghm_test", req.getHeader("Authorization"))
            val body = ApiJson.parseToJsonElement(req.body.readUtf8()).jsonObject
            assertEquals("Pixel 9", body["device"]!!.jsonObject["model"]!!.jsonPrimitive.content)
            assertEquals("/app/dashboard", body["screen"]!!.jsonPrimitive.content)
            assertTrue(body["screenshot"]!!.jsonPrimitive.content.startsWith("data:image/jpeg;base64,"))
            assertNull(body["diagnostics"]) // only sent as false when the user removed everything
            assertEquals("/api/mobile/bug-reports", server.takeRequest().path)
            assertEquals("/api/mobile/wishes?sort=new&q=ticket", server.takeRequest().path)
            server.takeRequest().let { assertEquals("DELETE", it.method); assertEquals("/api/mobile/wishes/w1/vote", it.path) }
            assertEquals("/api/mobile/wishes", server.takeRequest().path)
            assertEquals(listOf("POST /api/mobile/wishes/w1/vote 429 Zu viele Anfragen – bitte kurz warten"), failures)
        } finally {
            server.shutdown()
        }
    }

    @Test fun demoBackendAnswersFeedbackEndpoints() {
        val fb = FakeBackend({ true })
        assertEquals(200, fb.route("GET", "bug-reports", null).first)
        assertEquals(200, fb.route("GET", "wishes", null).first)
        val vote = ApiJson.decodeFromString(VoteResponse.serializer(), fb.route("POST", "wishes/w3/vote", null).second)
        assertEquals(10, vote.votes)
        assertTrue(vote.myVote)
        assertEquals("Neue Meldung", ApiJson.decodeFromString(BugReport.serializer(), fb.route("POST", "bug-reports", null).second).title)
    }
}
