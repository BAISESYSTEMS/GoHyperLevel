package org.gohigh.android.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** Shared JSON configuration: tolerant to new/missing fields, omits nulls in requests. */
val ApiJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
    encodeDefaults = true
}

/** Failure of an API call, always with a short German message for the UI. */
sealed class ApiException(message: String, cause: Throwable? = null) : IOException(message, cause) {
    /** 401 – token unknown or revoked. The app shows "Neu anmelden". */
    class Unauthorized(message: String = "Bitte neu anmelden") : ApiException(message)

    class Http(val code: Int, message: String) : ApiException(message)

    class Network(cause: Throwable) : ApiException("Keine Verbindung zum Server", cause)

    class Parse(cause: Throwable) : ApiException("Unerwartete Antwort vom Server", cause)

    class NotConfigured(message: String) : ApiException(message)
}

/**
 * Typed client for every endpoint of the HyperLevel Mobile API contract.
 *
 * @param baseUrl current server, e.g. https://crm.example.com (read on every call, so the debug setting applies at once)
 * @param token current bearer token (ghm_…) or null
 * @param onUnauthorized called when a bearer call gets 401
 */
class GoHighApi(
    private val http: OkHttpClient,
    private val baseUrl: () -> String,
    private val token: () -> String?,
    private val userAgent: String,
    private val appVersion: String = "",
    private val onUnauthorized: () -> Unit = {},
    val json: Json = ApiJson,
    /** Every failed call (method, path with query, HTTP status or 0 for network, error text) – for bug reports. */
    private val onFailure: (method: String, path: String, status: Int, message: String) -> Unit = { _, _, _, _ -> },
) {
    private enum class Auth { NONE, BEARER, COOKIE }

    // ---------------- Auth / devices ----------------

    /** Exchanges the WebView session cookie for a long-lived device token. */
    suspend fun pair(cookie: String, request: PairRequest): PairResponse =
        send("POST", "api/mobile/pair", body = encode(PairRequest.serializer(), request), resp = PairResponse.serializer(), auth = Auth.COOKIE, cookie = cookie)

    suspend fun devices(): List<DeviceInfo> = get("api/mobile/devices", resp = ListSerializer(DeviceInfo.serializer()))

    suspend fun revokeDevice(id: String) {
        send("DELETE", "api/mobile/devices", segments = listOf(id), resp = JsonElement.serializer())
    }

    suspend fun logout() {
        send("POST", "api/mobile/logout", body = EMPTY_JSON, resp = JsonElement.serializer())
    }

    // ---------------- Read ----------------

    suspend fun me(): MeResponse = get("api/mobile/me", resp = MeResponse.serializer())

    suspend fun summary(location: String = ALL_LOCATIONS): Summary =
        get("api/mobile/summary", mapOf("location" to location), Summary.serializer())

    suspend fun inbox(location: String = ALL_LOCATIONS, limit: Int = 10, unreadOnly: Boolean = false): List<InboxItem> =
        get("api/mobile/inbox", mapOf("location" to location, "limit" to "$limit", "unread" to if (unreadOnly) "1" else null), ListSerializer(InboxItem.serializer()))

    suspend fun conversation(id: String, limit: Int = 20): ConversationDetail =
        get("api/mobile/conversations", mapOf("limit" to "$limit"), ConversationDetail.serializer(), listOf(id))

    suspend fun tasks(location: String = ALL_LOCATIONS, filter: String = "today", limit: Int = 20): List<TaskItem> =
        get("api/mobile/tasks", mapOf("location" to location, "filter" to filter, "limit" to "$limit"), ListSerializer(TaskItem.serializer()))

    suspend fun appointments(location: String = ALL_LOCATIONS, days: Int = 2): List<Appointment> =
        get("api/mobile/appointments", mapOf("location" to location, "days" to "$days"), ListSerializer(Appointment.serializer()))

    suspend fun deals(location: String = ALL_LOCATIONS, limit: Int = 10): DealsResponse =
        get("api/mobile/deals", mapOf("location" to location, "limit" to "$limit"), DealsResponse.serializer())

    suspend fun calls(location: String = ALL_LOCATIONS, limit: Int = 10, missedOnly: Boolean = true): List<CallItem> =
        get("api/mobile/calls", mapOf("location" to location, "limit" to "$limit", "missed" to if (missedOnly) "1" else null), ListSerializer(CallItem.serializer()))

    suspend fun projects(): List<ProjectItem> = get("api/mobile/projects", resp = ListSerializer(ProjectItem.serializer()))

    suspend fun reviews(location: String = ALL_LOCATIONS, limit: Int = 5): ReviewsResponse =
        get("api/mobile/reviews", mapOf("location" to location, "limit" to "$limit"), ReviewsResponse.serializer())

    suspend fun payments(location: String = ALL_LOCATIONS, limit: Int = 5): PaymentsResponse =
        get("api/mobile/payments", mapOf("location" to location, "limit" to "$limit"), PaymentsResponse.serializer())

    suspend fun social(location: String = ALL_LOCATIONS, limit: Int = 5): List<SocialPost> =
        get("api/mobile/social", mapOf("location" to location, "limit" to "$limit"), ListSerializer(SocialPost.serializer()))

    suspend fun contacts(location: String = ALL_LOCATIONS, query: String = "", limit: Int = 20): List<ContactItem> =
        get("api/mobile/contacts", mapOf("location" to location, "q" to query.ifBlank { null }, "limit" to "$limit"), ListSerializer(ContactItem.serializer()))

    /** Without [since] the server only returns a fresh cursor (no backlog). */
    suspend fun feed(since: String?): FeedResponse =
        get("api/mobile/feed", mapOf("since" to since?.ifBlank { null }), FeedResponse.serializer())

    /** Public release info; null when no APK is uploaded (404). */
    suspend fun appRelease(): AppRelease? = try {
        send("GET", "api/mobile/app", resp = AppRelease.serializer(), auth = Auth.NONE)
    } catch (e: ApiException.Http) {
        if (e.code == 404) null else throw e
    }

    // ---------------- Write ----------------

    suspend fun reply(conversationId: String, request: ReplyRequest): ChatMessage =
        send("POST", "api/mobile/conversations", listOf(conversationId, "reply"), encode(ReplyRequest.serializer(), request), ChatMessage.serializer())

    suspend fun markRead(conversationId: String) {
        send("POST", "api/mobile/conversations", listOf(conversationId, "read"), EMPTY_JSON, JsonElement.serializer())
    }

    suspend fun createTask(request: CreateTaskRequest): TaskItem =
        send("POST", "api/mobile/tasks", body = encode(CreateTaskRequest.serializer(), request), resp = TaskItem.serializer())

    suspend fun completeTask(id: String) {
        send("POST", "api/mobile/tasks", listOf(id, "complete"), EMPTY_JSON, JsonElement.serializer())
    }

    suspend fun reopenTask(id: String) {
        send("POST", "api/mobile/tasks", listOf(id, "reopen"), EMPTY_JSON, JsonElement.serializer())
    }

    suspend fun moveDeal(id: String, stageId: String) {
        send("POST", "api/mobile/deals", listOf(id, "stage"), encode(StageRequest.serializer(), StageRequest(stageId)), JsonElement.serializer())
    }

    /** [status] is "won", "lost" or "open". */
    suspend fun setDealStatus(id: String, status: String) {
        send("POST", "api/mobile/deals", listOf(id, "status"), encode(StatusRequest.serializer(), StatusRequest(status)), JsonElement.serializer())
    }

    suspend fun createContact(request: CreateContactRequest): ContactItem =
        send("POST", "api/mobile/contacts", body = encode(CreateContactRequest.serializer(), request), resp = ContactItem.serializer())

    suspend fun addNote(request: NoteRequest) {
        send("POST", "api/mobile/notes", body = encode(NoteRequest.serializer(), request), resp = JsonElement.serializer())
    }

    /** Twilio click-to-call; 400 with a German text when telephony isn't set up. */
    suspend fun clickToCall(contactId: String): CallStartResponse =
        send("POST", "api/mobile/calls", body = encode(CallRequest.serializer(), CallRequest(contactId)), resp = CallStartResponse.serializer())

    suspend fun capture(request: CaptureRequest): CaptureResponse =
        send("POST", "api/mobile/capture", body = encode(CaptureRequest.serializer(), request), resp = CaptureResponse.serializer())

    /** [status] is "confirmed", "cancelled", "showed" or "noshow". */
    suspend fun setAppointmentStatus(id: String, status: String) {
        send("POST", "api/mobile/appointments", listOf(id, "status"), encode(StatusRequest.serializer(), StatusRequest(status)), JsonElement.serializer())
    }

    // ---------------- Fehler & Wünsche ----------------

    suspend fun bugReports(): List<BugReport> = get("api/mobile/bug-reports", resp = ListSerializer(BugReport.serializer()))

    suspend fun createBugReport(request: BugReportRequest): BugReport =
        send("POST", "api/mobile/bug-reports", body = encode(BugReportRequest.serializer(), request), resp = BugReport.serializer())

    suspend fun bugReport(id: String): BugReportDetail = get("api/mobile/bug-reports", resp = BugReportDetail.serializer(), segments = listOf(id))

    suspend fun addBugMessage(id: String, request: MessageRequest): BugReportDetail =
        send("POST", "api/mobile/bug-reports", listOf(id, "messages"), encode(MessageRequest.serializer(), request), BugReportDetail.serializer())

    /** [sort]: votes, new or status. */
    suspend fun wishes(sort: String = "votes", query: String = ""): List<Wish> =
        get("api/mobile/wishes", mapOf("sort" to sort, "q" to query.ifBlank { null }), ListSerializer(Wish.serializer()))

    suspend fun createWish(request: WishRequest): WishDetail =
        send("POST", "api/mobile/wishes", body = encode(WishRequest.serializer(), request), resp = WishDetail.serializer())

    suspend fun vote(wishId: String, on: Boolean): VoteResponse =
        send(if (on) "POST" else "DELETE", "api/mobile/wishes", listOf(wishId, "vote"), if (on) EMPTY_JSON else null, VoteResponse.serializer())

    suspend fun clientErrors(request: ClientErrorsRequest) {
        send("POST", "api/mobile/client-errors", body = encode(ClientErrorsRequest.serializer(), request), resp = JsonElement.serializer())
    }

    // ---------------- plumbing ----------------

    /** Absolute URL for a path on the current server (used for downloads and deep links). */
    fun url(path: String): HttpUrl? = base()?.resolve(path)

    private fun base(): HttpUrl? = baseUrl().trim().trimEnd('/').let { "$it/" }.toHttpUrlOrNull()

    private fun <B> encode(serializer: SerializationStrategy<B>, value: B): RequestBody =
        json.encodeToString(serializer, value).toRequestBody(JSON)

    private suspend fun <T> get(path: String, query: Map<String, String?> = emptyMap(), resp: DeserializationStrategy<T>, segments: List<String> = emptyList()): T =
        send("GET", path, segments, null, resp, query = query)

    private suspend fun <T> send(
        method: String,
        path: String,
        segments: List<String> = emptyList(),
        body: RequestBody? = null,
        resp: DeserializationStrategy<T>,
        auth: Auth = Auth.BEARER,
        cookie: String? = null,
        query: Map<String, String?> = emptyMap(),
    ): T = withContext(Dispatchers.IO) {
        val base = base() ?: throw ApiException.NotConfigured("Server-Adresse ungültig")
        val url = base.newBuilder().apply {
            addPathSegments(path)
            segments.forEach { addPathSegment(it) }
            query.forEach { (k, v) -> if (v != null) addQueryParameter(k, v) }
        }.build()
        val builder = Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("User-Agent", userAgent)
            .method(method, body ?: if (method == "GET" || method == "DELETE") null else EMPTY_JSON)
        when (auth) {
            Auth.BEARER -> {
                val t = token() ?: throw ApiException.Unauthorized("Nicht angemeldet")
                builder.header("Authorization", "Bearer $t")
                if (appVersion.isNotBlank()) builder.header("x-app-version", appVersion)
            }
            Auth.COOKIE -> {
                builder.header("x-pghl", "1")
                if (!cookie.isNullOrBlank()) builder.header("Cookie", cookie)
            }
            Auth.NONE -> Unit
        }
        val response = try {
            http.newCall(builder.build()).execute()
        } catch (e: IOException) {
            runCatching { onFailure(method, url.encodedPath, 0, "Keine Verbindung zum Server") }
            throw ApiException.Network(e)
        }
        response.use { r ->
            val text = try {
                r.body?.string().orEmpty()
            } catch (e: IOException) {
                throw ApiException.Network(e)
            }
            if (!r.isSuccessful) {
                val msg = errorMessage(text) ?: defaultMessage(r.code)
                runCatching { onFailure(method, url.encodedPath + (url.encodedQuery?.let { "?$it" } ?: ""), r.code, msg) }
                if (r.code == 401) {
                    if (auth == Auth.BEARER) onUnauthorized()
                    throw ApiException.Unauthorized(msg)
                }
                throw ApiException.Http(r.code, msg)
            }
            try {
                json.decodeFromString(resp, text.ifBlank { "{}" })
            } catch (e: SerializationException) {
                throw ApiException.Parse(e)
            } catch (e: IllegalArgumentException) {
                throw ApiException.Parse(e)
            }
        }
    }

    private fun errorMessage(text: String): String? = try {
        json.decodeFromString(ApiError.serializer(), text).error.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    }

    private fun defaultMessage(code: Int): String = when (code) {
        401 -> "Bitte neu anmelden"
        403 -> "Keine Berechtigung"
        404 -> "Nicht gefunden"
        429 -> "Zu viele Anfragen – bitte kurz warten"
        in 500..599 -> "Serverfehler ($code)"
        else -> "Fehler ($code)"
    }

    companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
        private val EMPTY_JSON: RequestBody = "{}".toRequestBody(JSON)
    }
}
