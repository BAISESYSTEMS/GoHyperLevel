package org.gohigh.android.api

import org.gohigh.android.support.fixture
import org.gohigh.android.support.json
import org.gohigh.android.support.testApi
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private lateinit var server: MockWebServer
    private var unauthorizedCalls = 0
    private lateinit var api: GoHighApi

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        api = testApi(server, onUnauthorized = { unauthorizedCalls++ })
    }

    @After fun tearDown() = server.shutdown()

    @Test fun pairSendsSessionCookieAndCsrfHeaderButNoBearer() = runBlocking {
        server.enqueue(json(fixture("pair.json")))
        val r = api.pair("pghl_session=abc; other=1", PairRequest("Pixel 9", appVersion = "1.0.0 (1)"))
        assertEquals("dev_1", r.deviceId)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/mobile/pair", req.path)
        assertEquals("1", req.getHeader("x-pghl"))
        assertEquals("pghl_session=abc; other=1", req.getHeader("Cookie"))
        assertNull(req.getHeader("Authorization"))
        assertEquals("""{"device_name":"Pixel 9","platform":"android","app_version":"1.0.0 (1)"}""", req.body.readUtf8())
    }

    @Test fun readCallsUseBearerAndQueryParameters() = runBlocking {
        server.enqueue(json(fixture("summary.json")))
        server.enqueue(json(fixture("inbox.json")))
        server.enqueue(json(fixture("tasks.json")))
        server.enqueue(json(fixture("appointments.json")))
        server.enqueue(json(fixture("deals.json")))
        server.enqueue(json(fixture("calls.json")))
        server.enqueue(json(fixture("projects.json")))
        server.enqueue(json(fixture("reviews.json")))
        server.enqueue(json(fixture("payments.json")))
        server.enqueue(json(fixture("social.json")))
        server.enqueue(json(fixture("contacts.json")))
        server.enqueue(json(fixture("conversation.json")))
        server.enqueue(json(fixture("me.json")))
        server.enqueue(json(fixture("devices.json")))

        api.summary("loc_a")
        api.inbox("all", limit = 15, unreadOnly = true)
        api.tasks("loc_b", "overdue", 25)
        api.appointments(days = 2)
        api.deals("loc_a", 10)
        api.calls(missedOnly = true)
        api.projects()
        api.reviews(limit = 5)
        api.payments()
        api.social(limit = 6)
        api.contacts("loc_a", "Lena F", 8)
        api.conversation("conv/1", limit = 6)
        api.me()
        api.devices()

        val paths = (1..14).map { server.takeRequest() }.onEach {
            assertEquals("Bearer ghm_test", it.getHeader("Authorization"))
            assertEquals("1.0.0 (1)", it.getHeader("x-app-version"))
            assertEquals("GET", it.method)
        }.map { it.path }
        assertEquals(
            listOf(
                "/api/mobile/summary?location=loc_a",
                "/api/mobile/inbox?location=all&limit=15&unread=1",
                "/api/mobile/tasks?location=loc_b&filter=overdue&limit=25",
                "/api/mobile/appointments?location=all&days=2",
                "/api/mobile/deals?location=loc_a&limit=10",
                "/api/mobile/calls?location=all&limit=10&missed=1",
                "/api/mobile/projects",
                "/api/mobile/reviews?location=all&limit=5",
                "/api/mobile/payments?location=all&limit=5",
                "/api/mobile/social?location=all&limit=6",
                "/api/mobile/contacts?location=loc_a&q=Lena%20F&limit=8",
                "/api/mobile/conversations/conv%2F1?limit=6",
                "/api/mobile/me",
                "/api/mobile/devices",
            ),
            paths,
        )
    }

    @Test fun writeCallsPostContractBodies() = runBlocking {
        repeat(12) { server.enqueue(json("""{"ok":true}""")) }
        server.enqueue(json(fixture("reply.json")))
        server.enqueue(json(fixture("task_created.json")))
        server.enqueue(json(fixture("contact_created.json")))
        server.enqueue(json(fixture("capture_task.json")))
        server.enqueue(json(fixture("call_started.json")))

        api.markRead("conv_1")
        api.completeTask("t1")
        api.reopenTask("t1")
        api.moveDeal("o1", "s2")
        api.setDealStatus("o1", "won")
        api.addNote(NoteRequest("c_1", "Notiz"))
        api.setAppointmentStatus("a1", "showed")
        api.revokeDevice("dev_2")
        api.logout()
        api.feed(null)
        api.feed("57")
        api.feed("")
        api.reply("conv_1", ReplyRequest(channel = "whatsapp", body = "Ja, passt!"))
        api.createTask(CreateTaskRequest("loc_a", "Neue Aufgabe", dueAt = "2026-10-05"))
        api.createContact(CreateContactRequest("loc_a", "Max", "Muster", note = "Kam über Messe"))
        val cap = api.capture(CaptureRequest("loc_a", "Angebot an Meier morgen"))
        val call = api.clickToCall("c_1")

        val reqs = (1..17).map { server.takeRequest() }
        fun r(i: Int) = reqs[i].method + " " + reqs[i].path + " " + reqs[i].body.readUtf8()
        assertEquals("POST /api/mobile/conversations/conv_1/read {}", r(0))
        assertEquals("POST /api/mobile/tasks/t1/complete {}", r(1))
        assertEquals("POST /api/mobile/tasks/t1/reopen {}", r(2))
        assertEquals("""POST /api/mobile/deals/o1/stage {"stage_id":"s2"}""", r(3))
        assertEquals("""POST /api/mobile/deals/o1/status {"status":"won"}""", r(4))
        assertEquals("""POST /api/mobile/notes {"contact_id":"c_1","body":"Notiz"}""", r(5))
        assertEquals("""POST /api/mobile/appointments/a1/status {"status":"showed"}""", r(6))
        assertEquals("DELETE /api/mobile/devices/dev_2 ", r(7))
        assertEquals("POST /api/mobile/logout {}", r(8))
        assertEquals("GET /api/mobile/feed ", r(9))
        assertEquals("GET /api/mobile/feed?since=57 ", r(10))
        assertEquals("GET /api/mobile/feed ", r(11))
        assertEquals("""POST /api/mobile/conversations/conv_1/reply {"channel":"whatsapp","body":"Ja, passt!"}""", r(12))
        assertEquals("""POST /api/mobile/tasks {"location_id":"loc_a","title":"Neue Aufgabe","due_at":"2026-10-05"}""", r(13))
        assertEquals("""POST /api/mobile/contacts {"location_id":"loc_a","first_name":"Max","last_name":"Muster","note":"Kam über Messe"}""", r(14))
        assertEquals("""POST /api/mobile/capture {"location_id":"loc_a","text":"Angebot an Meier morgen"}""", r(15))
        assertEquals("""POST /api/mobile/calls {"contact_id":"c_1"}""", r(16))
        assertEquals("Angebot an Meier schicken", cap.label)
        assertTrue(call.message!!.startsWith("Dein Telefon"))
    }

    @Test fun unauthorizedThrowsAndNotifies() = runBlocking {
        server.enqueue(json("""{"error":"Dieses Gerät ist abgemeldet – bitte in der App neu anmelden"}""", 401))
        try {
            api.summary()
            fail("expected 401")
        } catch (e: ApiException.Unauthorized) {
            assertEquals("Dieses Gerät ist abgemeldet – bitte in der App neu anmelden", e.message)
        }
        assertEquals(1, unauthorizedCalls)
    }

    @Test fun pair401DoesNotFlipTheSession() = runBlocking {
        server.enqueue(json("""{"error":"Nicht angemeldet"}""", 401))
        try {
            api.pair("pghl_session=old", PairRequest("x", appVersion = "1"))
            fail()
        } catch (_: ApiException.Unauthorized) {
        }
        assertEquals(0, unauthorizedCalls)
    }

    @Test fun missingTokenFailsWithoutRequest() = runBlocking {
        val noToken = testApi(server, token = { null })
        try {
            noToken.me()
            fail()
        } catch (_: ApiException.Unauthorized) {
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun httpErrorsCarryTheGermanServerText() = runBlocking {
        server.enqueue(json("""{"error":"Telefonie ist auf diesem Server nicht verfügbar"}""", 400))
        server.enqueue(MockResponse().setResponseCode(500).setBody("<html>oops</html>"))
        server.enqueue(json("""{"error":"Zu viele Anfragen von diesem Gerät – bitte kurz warten"}""", 429))
        try {
            api.clickToCall("c_1"); fail()
        } catch (e: ApiException.Http) {
            assertEquals(400, e.code)
            assertEquals("Telefonie ist auf diesem Server nicht verfügbar", e.message)
        }
        try {
            api.projects(); fail()
        } catch (e: ApiException.Http) {
            assertEquals("Serverfehler (500)", e.message)
        }
        try {
            api.projects(); fail()
        } catch (e: ApiException.Http) {
            assertEquals(429, e.code)
        }
    }

    @Test fun networkAndParseErrors() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        server.enqueue(json("this is not json"))
        try {
            api.me(); fail()
        } catch (e: ApiException.Network) {
            assertEquals("Keine Verbindung zum Server", e.message)
        }
        try {
            api.me(); fail()
        } catch (e: ApiException.Parse) {
        }
    }

    @Test fun appReleaseIsPublicAnd404MeansNone() = runBlocking {
        server.enqueue(json(fixture("app.json")))
        server.enqueue(json("""{"error":"Noch keine App hochgeladen"}""", 404))
        assertEquals(3, api.appRelease()?.versionCode)
        assertNull(api.appRelease())
        val req = server.takeRequest()
        assertEquals("/api/mobile/app", req.path)
        assertNull(req.getHeader("Authorization"))
    }

    @Test fun baseUrlWithPathPrefixAndTrailingSlash() = runBlocking {
        val prefixed = GoHighApi(okhttp3.OkHttpClient(), { server.url("/crm/").toString() }, { "t" }, "ua")
        server.enqueue(json("[]"))
        prefixed.projects()
        assertEquals("/crm/api/mobile/projects", server.takeRequest().path)
        assertEquals(server.url("/crm/downloads/gohigh.apk"), prefixed.url("downloads/gohigh.apk"))
    }
}
