package org.gohigh.android.api

import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The offline demo backend answers like the real server (and its sample data stays consistent). */
class DemoDataTest {
    private val fake = FakeBackend({ true })
    private val iso = Regex("""^\d{4}-\d{2}-\d{2}T""")

    private fun <T> get(path: String, s: kotlinx.serialization.KSerializer<T>, location: String? = null): T {
        val (code, body) = fake.route("GET", path, location)
        assertEquals(200, code)
        return ApiJson.decodeFromString(s, body)
    }

    @Test fun everyReadEndpointParses() {
        val me = get("me", MeResponse.serializer())
        val locIds = me.locations.map { it.id }.toSet()
        val locNames = me.locations.map { it.name }.toSet()
        assertTrue(get("summary", Summary.serializer()).sparkRevenue30d.size == 30)
        get("inbox", ListSerializer(InboxItem.serializer())).forEach { assertTrue(it.locationId in locIds); assertFalse(iso.containsMatchIn(it.lastMessage)) }
        get("conversations/c1", ConversationDetail.serializer()).messages.forEach {
            assertFalse("body looks like a timestamp: ${it.body}", iso.containsMatchIn(it.body))
            assertTrue(iso.containsMatchIn(it.at.orEmpty()))
        }
        get("tasks", ListSerializer(TaskItem.serializer())).forEach { assertTrue(it.locationName in locNames) }
        get("appointments", ListSerializer(Appointment.serializer())).forEach { assertTrue(iso.containsMatchIn(it.start.orEmpty())) }
        get("deals", DealsResponse.serializer()).top.forEach { assertTrue(it.locationId in locIds); assertTrue(it.stageName.isNotEmpty()) }
        get("calls", ListSerializer(CallItem.serializer())).forEach { assertTrue(it.missed); assertTrue(it.locationId in locIds) }
        assertTrue(get("projects", ListSerializer(ProjectItem.serializer())).size >= 4)
        assertEquals(4.8, get("reviews", ReviewsResponse.serializer()).avg!!, 0.01)
        get("payments", PaymentsResponse.serializer()).latest.forEach { assertTrue(it.totalCents > 0) }
        get("social", ListSerializer(SocialPost.serializer())).forEach { assertTrue(it.locationName in locNames); assertTrue(it.locationId in locIds) }
        get("contacts", ListSerializer(ContactItem.serializer())).forEach { c -> c.email?.let { assertTrue(it.contains('@')) }; assertTrue(c.locationId in locIds) }
        assertEquals(1, get("contacts", ListSerializer(ContactItem.serializer())).count { it.name == "Lena Fischer" })
    }

    @Test fun locationFilterApplies() {
        val all = get("tasks", ListSerializer(TaskItem.serializer()))
        val one = get("tasks", ListSerializer(TaskItem.serializer()), location = "loc_maler")
        assertTrue(one.isNotEmpty() && one.size < all.size && one.all { it.locationId == "loc_maler" })
    }

    @Test fun writesAndAppEndpoint() {
        assertEquals(404, fake.route("GET", "app", null).first)
        assertEquals(400, fake.route("POST", "calls", null).first)
        assertEquals(200, fake.route("POST", "tasks/t1/complete", null).first)
        assertEquals("task", ApiJson.decodeFromString(CaptureResponse.serializer(), fake.route("POST", "capture", null).second).kind)
    }
}
