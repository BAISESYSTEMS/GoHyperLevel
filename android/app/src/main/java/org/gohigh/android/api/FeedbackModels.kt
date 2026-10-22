package org.gohigh.android.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/*
 * „Fehler & Wünsche“ (server: docs/bug-reports.md, API: /api/mobile/bug-reports and /api/mobile/wishes).
 * Status keys: neu, bestaetigt, in_arbeit, behoben, ausgeliefert, abgelehnt, duplikat; wishes also carry a
 * board key (idea, planned, in_progress, done, declined).
 */

@Serializable
data class FeedbackStatus(
    val key: String = "neu",
    val board: String = "",
    val label: String = "",
    val tone: String = "gray",
    @Serializable(LenientBooleanSerializer::class) val done: Boolean = false,
)

@Serializable
data class FeedbackRef(
    @Serializable(LenientStringSerializer::class) val id: String = "",
    @Serializable(LenientIntSerializer::class) val number: Int = 0,
    val title: String = "",
    val url: String? = null,
)

/** A report as its reporter sees it („Meine Meldungen“). */
@Serializable
data class BugReport(
    @Serializable(LenientStringSerializer::class) val id: String,
    /** bug, question, wish or auto. */
    val kind: String = "bug",
    @Serializable(LenientIntSerializer::class) val number: Int = 0,
    val title: String = "",
    val status: FeedbackStatus = FeedbackStatus(),
    val severity: String = "",
    val platform: String = "",
    val version: String = "",
    val reason: String = "",
    val note: String = "",
    @SerialName("duplicate_of") val duplicateOf: FeedbackRef? = null,
    @Serializable(LenientBooleanSerializer::class) val unread: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val url: String? = null,
)

@Serializable
data class FeedbackFile(@Serializable(LenientStringSerializer::class) val id: String = "", val mime: String = "", val url: String = "")

@Serializable
data class ThreadItem(
    @Serializable(LenientStringSerializer::class) val id: String = "",
    /** team, user or status. */
    val type: String = "",
    val body: String? = null,
    val label: String? = null,
    val author: String? = null,
    @Serializable(LenientBooleanSerializer::class) val mine: Boolean = false,
    val at: String? = null,
)

@Serializable
data class BugReportDetail(
    val report: BugReport,
    val body: String = "",
    val expected: String = "",
    val steps: String = "",
    val diagnostics: JsonElement? = null,
    val files: List<FeedbackFile> = emptyList(),
    val thread: List<ThreadItem> = emptyList(),
    @SerialName("can_reply") @Serializable(LenientBooleanSerializer::class) val canReply: Boolean = false,
)

/** What the app sends along with a report (shown to the user, removable). */
@Serializable
data class DeviceDiagnostics(
    val model: String = "",
    val manufacturer: String = "",
    val android: String = "",
    val sdk: Int = 0,
    @SerialName("app_version") val appVersion: String = "",
)

/** One failed API call of the app: status, path and the server's error text – never request bodies. */
@Serializable
data class ApiErrorEntry(val method: String = "GET", val path: String = "", val status: Int = 0, val error: String = "", val at: String = "")

@Serializable
data class BugReportRequest(
    /** bug, wish or question. */
    val category: String,
    val what: String,
    val expected: String? = null,
    val steps: String? = null,
    /** gering, mittel, hoch, kritisch. */
    val severity: String = "mittel",
    @SerialName("location_id") val locationId: String? = null,
    /** Name of the screen the report was started from. */
    val screen: String? = null,
    /** data:image/jpeg;base64,… */
    val screenshot: String? = null,
    val device: DeviceDiagnostics? = null,
    @SerialName("api_errors") val apiErrors: List<ApiErrorEntry>? = null,
    @SerialName("app_version") val appVersion: String? = null,
    /** false = the user removed all diagnostics. */
    val diagnostics: Boolean? = null,
)

@Serializable
data class MessageRequest(val body: String, val screenshot: String? = null)

@Serializable
data class Wish(
    @Serializable(LenientStringSerializer::class) val id: String,
    @Serializable(LenientIntSerializer::class) val number: Int = 0,
    val title: String = "",
    val body: String = "",
    val area: String = "",
    val status: FeedbackStatus = FeedbackStatus(),
    @Serializable(LenientIntSerializer::class) val votes: Int = 0,
    @SerialName("my_vote") @Serializable(LenientBooleanSerializer::class) val myVote: Boolean = false,
    @Serializable(LenientIntSerializer::class) val comments: Int = 0,
    @Serializable(LenientBooleanSerializer::class) val mine: Boolean = false,
    val version: String = "",
    val reason: String = "",
)

@Serializable
data class WishDetail(val wish: Wish, val files: List<FeedbackFile> = emptyList(), val thread: List<ThreadItem> = emptyList())

@Serializable
data class WishRequest(
    val title: String,
    val what: String,
    val area: String = "Sonstiges",
    val screenshot: String? = null,
    @SerialName("location_id") val locationId: String? = null,
)

@Serializable
data class VoteResponse(@Serializable(LenientStringSerializer::class) val id: String = "", @Serializable(LenientIntSerializer::class) val votes: Int = 0, @SerialName("my_vote") @Serializable(LenientBooleanSerializer::class) val myVote: Boolean = false)

/** A crash of the app, sent on the next start (only kept by the server when the user allowed automatic reports). */
@Serializable
data class ClientErrorEntry(val message: String, val stack: String = "", val at: String = "")

@Serializable
data class ClientErrorDiagnostics(val device: DeviceDiagnostics? = null, @SerialName("app_version") val appVersion: String? = null, val route: String? = null)

@Serializable
data class ClientErrorsRequest(val errors: List<ClientErrorEntry>, val platform: String = "android", val diagnostics: ClientErrorDiagnostics? = null)

/** Areas of the wish list (same list as the server). */
val WISH_AREAS = listOf("CRM", "Marketing", "Websites & Funnels", "Automationen", "Service", "Umsatz", "KI", "App", "Agentur", "Sonstiges")

/** Severity keys with labels for the form. */
val SEVERITIES = listOf("gering" to "Kleinigkeit", "mittel" to "Stört bei der Arbeit", "hoch" to "Blockiert mich", "kritisch" to "Kritisch")
