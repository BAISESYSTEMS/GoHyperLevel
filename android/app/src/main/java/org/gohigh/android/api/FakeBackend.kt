package org.gohigh.android.api

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/**
 * Offline stand-in for the Mobile API (debug setting "Demo-Daten"). Answers every /api/mobile/… request
 * with [DemoData] so widgets, dialogs and the updater flow can be tried without a server.
 */
class FakeBackend(private val enabled: () -> Boolean, private val json: Json = ApiJson) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val path = req.url.encodedPath
        if (!enabled() || !path.startsWith("/api/mobile/")) return chain.proceed(req)
        val (code, body) = route(req.method, path.removePrefix("/api/mobile/"), req.url.queryParameter("location"), req.url.queryParameter("q").orEmpty(), req.url.queryParameter("filter"))
        return Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code < 400) "OK" else "Error")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()
    }

    fun route(method: String, path: String, location: String?, q: String = "", filter: String? = null): Pair<Int, String> {
        val d = DemoData()
        val loc = location ?: ALL_LOCATIONS
        val parts = path.split('/')
        fun ok(s: String) = 200 to s
        return when {
            method == "GET" && path == "me" -> ok(json.encodeToString(MeResponse.serializer(), d.me()))
            method == "GET" && path == "summary" -> ok(json.encodeToString(Summary.serializer(), d.summary(loc)))
            method == "GET" && path == "inbox" -> ok(json.encodeToString(ListSerializer(InboxItem.serializer()), d.inbox().forLoc(loc) { it.locationId }))
            method == "GET" && parts[0] == "conversations" && parts.size == 2 -> ok(json.encodeToString(ConversationDetail.serializer(), d.conversation(parts[1])))
            method == "GET" && path == "tasks" -> ok(json.encodeToString(ListSerializer(TaskItem.serializer()), d.tasks(filter ?: "today").forLoc(loc) { it.locationId }))
            method == "GET" && path == "appointments" -> ok(json.encodeToString(ListSerializer(Appointment.serializer()), d.appointments().forLoc(loc) { it.locationId }))
            method == "GET" && path == "deals" -> ok(json.encodeToString(DealsResponse.serializer(), d.deals()))
            method == "GET" && path == "calls" -> ok(json.encodeToString(ListSerializer(CallItem.serializer()), d.calls().forLoc(loc) { it.locationId.orEmpty() }))
            method == "GET" && path == "projects" -> ok(json.encodeToString(ListSerializer(ProjectItem.serializer()), d.projects()))
            method == "GET" && path == "reviews" -> ok(json.encodeToString(ReviewsResponse.serializer(), d.reviews()))
            method == "GET" && path == "payments" -> ok(json.encodeToString(PaymentsResponse.serializer(), d.payments()))
            method == "GET" && path == "social" -> ok(json.encodeToString(ListSerializer(SocialPost.serializer()), d.social()))
            method == "GET" && path == "contacts" -> ok(json.encodeToString(ListSerializer(ContactItem.serializer()), d.contacts(q).forLoc(loc) { it.locationId }))
            method == "GET" && path == "feed" -> ok("""{"cursor":"demo-${System.currentTimeMillis() / 60000}","events":[]}""")
            method == "GET" && path == "devices" -> ok("""[{"id":"dev1","device_name":"Dieses Gerät","platform":"android","current":true}]""")
            method == "GET" && path == "app" -> 404 to """{"error":"Keine App hochgeladen"}"""
            method == "POST" && path == "capture" -> ok("""{"kind":"task","item":{"id":"t99","title":"Notiz aus Sprache"}}""")
            method == "POST" && path == "tasks" -> ok("""{"id":"t100","title":"Neue Aufgabe","done":false}""")
            method == "POST" && path == "contacts" -> ok("""{"id":"k100","name":"Neuer Kontakt"}""")
            method == "POST" && path == "calls" -> 400 to """{"error":"Telefonie ist im Demo-Modus nicht verfügbar"}"""
            method == "POST" && parts.lastOrNull() == "reply" -> ok("""{"id":"m100","direction":"outbound","body":"ok"}""")
            method == "GET" && path == "bug-reports" -> ok(json.encodeToString(ListSerializer(BugReport.serializer()), d.bugReports()))
            method == "POST" && path == "bug-reports" -> ok(json.encodeToString(BugReport.serializer(), d.bugReports()[0].copy(id = "r99", number = 43, title = "Neue Meldung", status = FeedbackStatus("neu", label = "Neu", tone = "blue"), unread = false)))
            parts[0] == "bug-reports" && parts.size >= 2 -> ok(json.encodeToString(BugReportDetail.serializer(), d.bugReportDetail(parts[1])))
            method == "GET" && path == "wishes" -> ok(json.encodeToString(ListSerializer(Wish.serializer()), d.wishes()))
            method == "POST" && path == "wishes" -> ok(json.encodeToString(WishDetail.serializer(), WishDetail(d.wishes()[2].copy(id = "w99", number = 56, title = "Neuer Wunsch", votes = 1, myVote = true))))
            parts[0] == "wishes" && parts.lastOrNull() == "vote" -> {
                val w = d.wishes().firstOrNull { it.id == parts.getOrNull(1) }
                val on = method == "POST"
                ok(json.encodeToString(VoteResponse.serializer(), VoteResponse(parts.getOrNull(1).orEmpty(), (w?.votes ?: 0) + (if (on && w?.myVote != true) 1 else if (!on && w?.myVote == true) -1 else 0), on)))
            }
            method == "POST" || method == "DELETE" -> ok("""{"ok":true}""")
            else -> 404 to """{"error":"Nicht gefunden"}"""
        }
    }

    private fun <T> List<T>.forLoc(loc: String, id: (T) -> String) = if (loc == ALL_LOCATIONS) this else filter { id(it) == loc }
}
