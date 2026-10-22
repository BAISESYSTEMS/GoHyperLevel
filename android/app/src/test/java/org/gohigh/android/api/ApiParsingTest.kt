package org.gohigh.android.api

import org.gohigh.android.support.fixture
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every response of the mobile API contract parses into the DTOs (fixtures mirror the server output). */
class ApiParsingTest {
    private val json = ApiJson

    private inline fun <reified T> parse(name: String, s: kotlinx.serialization.KSerializer<T>): T = json.decodeFromString(s, fixture(name))

    @Test fun pair() {
        val r = parse("pair.json", PairResponse.serializer())
        assertTrue(r.token.startsWith("ghm_"))
        assertEquals("dev_1", r.deviceId)
        assertEquals("Pixel 9", r.name)
        assertEquals("admin", r.user.role)
    }

    @Test fun devices() {
        val r = parse("devices.json", ListSerializer(DeviceInfo.serializer()))
        assertEquals(2, r.size)
        assertTrue(r[0].current)
        assertEquals("Pixel 9", r[0].label)
        assertNull(r[1].lastUsedAt)
    }

    @Test fun me() {
        val r = parse("me.json", MeResponse.serializer())
        assertTrue(r.agency)
        assertEquals(listOf("loc_a", "loc_b"), r.locations.map { it.id })
        assertEquals("Europe/Berlin", r.locations[0].timezone)
        assertEquals(listOf("dashboard", "conversations", "tasks"), r.locations[0].areas)
        assertNull(r.locations[1].color)
        assertEquals(2, r.app?.versionCode)
        assertEquals("dev_1", r.deviceId)
    }

    @Test fun summary() {
        val s = parse("summary.json", Summary.serializer())
        assertEquals(3, s.leadsToday)
        assertEquals(1_250_000L, s.openDealsValueCents)
        assertEquals(4.7, s.rating!!.avg, 0.001)
        assertEquals(1, s.websites.down)
        assertEquals(30, s.sparkRevenue30d.size)
        assertEquals(14, s.sparkLeads14d.size)
        assertEquals(45000L, s.sparkRevenue30d.last())
    }

    @Test fun summaryWithoutRatingOrSparklines() {
        val s = parse("summary_empty.json", Summary.serializer())
        assertNull(s.rating)
        assertTrue(s.sparkRevenue30d.isEmpty())
    }

    @Test fun inboxUnreadIsACount() {
        val r = parse("inbox.json", ListSerializer(InboxItem.serializer()))
        assertEquals(2, r[0].unread)
        assertTrue(r[0].isUnread)
        assertFalse(r[1].isUnread)
        assertTrue(r[1].starred)
        // null channel/direction become empty strings
        assertEquals("", r[1].channel)
        assertEquals("", r[1].lastDirection)
    }

    @Test fun inboxAcceptsBooleanUnreadToo() {
        val r = json.decodeFromString(ListSerializer(InboxItem.serializer()), """[{"conversation_id":7,"unread":true},{"conversation_id":"x","unread":false}]""")
        assertEquals("7", r[0].conversationId)
        assertEquals(1, r[0].unread)
        assertEquals(0, r[1].unread)
    }

    @Test fun conversation() {
        val c = parse("conversation.json", ConversationDetail.serializer())
        assertEquals("Testfirma", c.locationName)
        assertEquals(listOf("sms", "whatsapp"), c.channels)
        assertEquals("Twilio nicht eingerichtet", c.messages[1].error)
        assertNull(c.contact.email)
    }

    @Test fun tasks() {
        val t = parse("tasks.json", ListSerializer(TaskItem.serializer()))
        assertEquals("2026-10-04T00:00:00.000Z", t[0].dueAt)
        assertFalse(t[0].done)
        assertEquals("u1", t[1].assignedTo)
        assertEquals("Max Muster", t[1].contactName)
    }

    @Test fun appointments() {
        val a = parse("appointments.json", ListSerializer(Appointment.serializer()))
        assertEquals("https://meet.example.com/x", a[0].meetingUrl)
        assertEquals("Lindenstraße 1, Köln", a[1].address)
        assertNull(a[1].contactName)
    }

    @Test fun deals() {
        val d = parse("deals.json", DealsResponse.serializer())
        assertEquals(2, d.pipelines[0].stages.size)
        assertEquals(1_050_000L, d.top[0].valueCents)
        assertEquals("c_1", d.top[0].contactId)
        assertEquals("open", d.top[0].status)
    }

    @Test fun calls() {
        val c = parse("calls.json", ListSerializer(CallItem.serializer()))
        assertTrue(c[0].missed)
        assertEquals("+491701234567", c[0].otherNumber)
        assertTrue(c[1].hasVoicemail)
        assertNull(c[1].from)
        assertEquals("Zweitfirma", c[1].locationName)
        // outgoing calls come as "out": the other party is the callee, not our own number
        assertEquals("+491709876543", c[2].otherNumber)
    }

    @Test fun projects() {
        val p = parse("projects.json", ListSerializer(ProjectItem.serializer()))
        assertEquals(true, p[0].uptime?.up)
        assertEquals(1, p[0].overdueTasks)
        assertEquals("/app/project?loc=loc_a", p[0].deepLink)
        assertNull(p[1].uptime?.up)
    }

    @Test fun reviews() {
        val r = parse("reviews.json", ReviewsResponse.serializer())
        assertEquals(4.7, r.avg!!, 0.001)
        assertEquals(0.1, r.delta30d!!, 0.0001)
        assertEquals(4, r.new30d)
        assertTrue(r.latest[0].replied)
        val empty = parse("reviews_empty.json", ReviewsResponse.serializer())
        assertNull(empty.avg)
        assertNull(empty.delta30d)
    }

    @Test fun payments() {
        val p = parse("payments.json", PaymentsResponse.serializer())
        assertEquals(1, p.overdueCount)
        assertEquals("2026-0042", p.latest[0].number)
        assertEquals("EUR", p.latest[0].currency)
    }

    @Test fun social() {
        val s = parse("social.json", ListSerializer(SocialPost.serializer()))
        assertEquals(listOf("instagram", "linkedin"), s[0].channels)
        assertTrue(s[1].channels.isEmpty())
        assertEquals("draft", s[1].status)
    }

    @Test fun contacts() {
        val c = parse("contacts.json", ListSerializer(ContactItem.serializer()))
        assertEquals("Lena", c[0].firstName)
        assertNull(c[0].company)
    }

    @Test fun feed() {
        val first = parse("feed_first.json", FeedResponse.serializer())
        assertEquals("57", first.cursor)
        assertTrue(first.events.isEmpty())
        val f = parse("feed.json", FeedResponse.serializer())
        assertEquals(listOf("58", "59", "60"), f.events.map { it.id })
        assertEquals("/app/conversations?c=conv_1&loc=loc_a", f.events[0].deepLink)
        // numeric cursor is accepted as well
        assertEquals("12", json.decodeFromString(FeedResponse.serializer(), """{"cursor":12,"events":[]}""").cursor)
    }

    @Test fun appRelease() {
        val a = parse("app.json", AppRelease.serializer())
        assertEquals(3, a.versionCode)
        assertEquals(2, a.minSupportedCode)
        assertEquals("https://crm.example.com/android", a.pageUrl)
    }

    @Test fun writeResponses() {
        assertEquals("Ja, passt!", parse("reply.json", ChatMessage.serializer()).body)
        assertEquals("t9", parse("task_created.json", TaskItem.serializer()).id)
        assertEquals("Max Muster", parse("contact_created.json", ContactItem.serializer()).name)
        val task = parse("capture_task.json", CaptureResponse.serializer())
        assertEquals("task", task.kind)
        assertTrue(task.ai)
        assertEquals("Angebot an Meier schicken", task.label)
        val note = parse("capture_note.json", CaptureResponse.serializer())
        assertEquals("note", note.kind)
        assertEquals("Will das Angebot erst im März", note.label)
        assertNotNull(parse("call_started.json", CallStartResponse.serializer()).message)
    }

    @Test fun requestsUseContractFieldNames() {
        val body = json.encodeToString(CreateTaskRequest.serializer(), CreateTaskRequest("loc_a", "Titel", dueAt = "2026-10-05"))
        assertEquals("""{"location_id":"loc_a","title":"Titel","due_at":"2026-10-05"}""", body)
        val c = json.encodeToString(CreateContactRequest.serializer(), CreateContactRequest("loc_a", "Max", phone = "+49"))
        assertEquals("""{"location_id":"loc_a","first_name":"Max","phone":"+49"}""", c)
        assertEquals("""{"device_name":"Pixel","platform":"android","app_version":"1.0.0 (1)"}""", json.encodeToString(PairRequest.serializer(), PairRequest("Pixel", appVersion = "1.0.0 (1)")))
    }

    @Test fun unknownFieldsAndNullsAreTolerated() {
        val s = json.decodeFromString(Summary.serializer(), """{"leads_today":null,"brand_new_field":{"a":1},"websites":{"up":1}}""")
        assertEquals(0, s.leadsToday)
        assertEquals(1, s.websites.up)
    }
}
