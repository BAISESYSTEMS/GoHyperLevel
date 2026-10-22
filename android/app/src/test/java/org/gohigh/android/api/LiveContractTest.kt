package org.gohigh.android.api

import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * End-to-end contract check against a real HyperLevel server (opt-in, never hits production by itself):
 *   ./gradlew :app:testDebugUnitTest --tests '*LiveContractTest*' -PliveBase=http://127.0.0.1:4795 -PliveEmail=… -PlivePassword=…
 * Logs in like the WebView, pairs with the session cookie and calls every endpoint the app uses.
 */
class LiveContractTest {
    private val base = System.getProperty("gohigh.live.base").orEmpty()
    private val email = System.getProperty("gohigh.live.email").orEmpty()
    private val password = System.getProperty("gohigh.live.password").orEmpty()

    @Test fun fullFlowAgainstRealServer() = runBlocking {
        assumeTrue("set -PliveBase/-PliveEmail/-PlivePassword", base.isNotBlank() && email.isNotBlank())
        val http = OkHttpClient()
        val login = http.newCall(
            Request.Builder().url("$base/api/auth/login").header("x-pghl", "1")
                .post("""{"email":"$email","password":"$password"}""".toRequestBody("application/json".toMediaType())).build(),
        ).execute()
        assertEquals(200, login.code)
        val cookie = login.headers("Set-Cookie").first { it.startsWith("pghl_session=") }.substringBefore(';')
        login.close()

        var token: String? = null
        var unauthorized = 0
        val api = GoHighApi(http, { base }, { token }, "HyperLevel-LiveTest", "1.0.0 (1)", onUnauthorized = { unauthorized++ })

        // --- pairing
        val pair = api.pair(cookie, PairRequest("Contract-Test", appVersion = "1.0.0 (1)"))
        assertTrue(pair.token.startsWith("ghm_"))
        token = pair.token

        // --- reads
        val me = api.me()
        assertTrue(me.locations.size >= 2)
        assertEquals(pair.deviceId, me.deviceId)
        val loc = me.locations.first().id
        val summary = api.summary()
        assertEquals(30, summary.sparkRevenue30d.size)
        assertEquals(14, summary.sparkLeads14d.size)
        assertTrue(summary.tasksOverdue >= 1)
        api.summary(loc)
        val inbox = api.inbox(limit = 10)
        assertTrue(inbox.any { it.isUnread })
        api.inbox(unreadOnly = true)
        val conv = api.conversation(inbox.first().conversationId)
        assertTrue(conv.messages.isNotEmpty())
        for (f in listOf("today", "overdue", "open", "week")) api.tasks(filter = f)
        val open = api.tasks(filter = "open")
        assertTrue(open.isNotEmpty())
        val appts = api.appointments(days = 2)
        assertTrue(appts.isNotEmpty())
        val deals = api.deals()
        assertTrue(deals.pipelines.isNotEmpty() && deals.top.isNotEmpty())
        val calls = api.calls(missedOnly = true)
        assertTrue(calls.any { it.hasVoicemail })
        val projects = api.projects()
        assertTrue(projects.isNotEmpty())
        val reviews = api.reviews()
        assertTrue(reviews.count >= 1)
        val payments = api.payments()
        assertTrue(payments.monthCents > 0)
        api.social()
        val contacts = api.contacts(query = "Anna")
        assertTrue(contacts.isNotEmpty())
        val devices = api.devices()
        assertTrue(devices.any { it.current })

        // --- feed: first call only returns a cursor; a new lead then shows up as event
        val first = api.feed(null)
        assertTrue(first.events.isEmpty())
        val created = api.createContact(CreateContactRequest(loc, "Lea", "Live", phone = "+491700000000", note = "Aus dem Vertragstest"))
        val next = api.feed(first.cursor)
        assertTrue("lead event expected: ${next.events}", next.events.any { it.type == "lead" })
        assertTrue(next.events.all { it.deepLink.orEmpty().contains("loc=") })

        // --- writes
        val task = api.createTask(CreateTaskRequest(loc, "Vertragstest-Aufgabe", dueAt = java.time.LocalDate.now().toString()))
        assertEquals(false, task.done)
        api.completeTask(task.id)
        assertTrue(api.tasks(filter = "done").any { it.id == task.id })
        api.reopenTask(task.id)
        api.addNote(NoteRequest(created.id, "Notiz aus dem Test"))
        api.markRead(conv.conversationId)
        val deal = deals.top.first()
        val stages = deals.pipelines.first { it.id == deal.pipelineId }.stages
        api.moveDeal(deal.id, stages.last().id)
        api.setDealStatus(deal.id, "won")
        api.setDealStatus(deal.id, "open")
        api.setAppointmentStatus(appts.first().id, "confirmed")
        val cap = api.capture(CaptureRequest(loc, "Morgen Angebot an Anna schicken"))
        assertTrue(cap.kind == "task" || cap.kind == "note")
        try {
            api.reply(conv.conversationId, ReplyRequest(body = "Antwort aus dem Vertragstest"))
        } catch (e: ApiException.Http) {
            assertTrue("German error expected: ${e.message}", e.message!!.isNotBlank()) // no SMS provider on a bare server
        }
        try {
            api.clickToCall(created.id)
        } catch (e: ApiException.Http) {
            assertEquals(400, e.code) // telephony not configured
        }
        assertEquals(null, api.appRelease()) // no APK uploaded on a fresh server

        // --- logout revokes the token
        api.logout()
        try {
            api.me()
            fail("token should be revoked")
        } catch (_: ApiException.Unauthorized) {
        }
        assertEquals(1, unauthorized)
    }
}
