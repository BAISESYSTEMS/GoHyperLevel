package org.gohigh.android.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/*
 * DTOs for the HyperLevel Mobile API (see docs: mobile-api contract). Field names follow the contract exactly
 * (snake_case via @SerialName). Nearly everything has a default so a missing field never breaks a widget.
 * Money is always in cents, times are ISO-8601 UTC strings.
 */

const val ALL_LOCATIONS = "all"

@Serializable
data class ApiUser(
    val id: String = "",
    val name: String = "",
    val email: String = "",
    val role: String = "",
)

// ---- Auth / devices ----

@Serializable
data class PairRequest(
    @SerialName("device_name") val deviceName: String,
    val platform: String = "android",
    @SerialName("app_version") val appVersion: String,
)

@Serializable
data class PairResponse(
    val token: String,
    @SerialName("device_id") val deviceId: String = "",
    val name: String? = null,
    val user: ApiUser = ApiUser(),
)

/** The contract does not spell out device fields; these are read leniently. */
@Serializable
data class DeviceInfo(
    @Serializable(LenientStringSerializer::class) val id: String = "",
    @SerialName("device_name") val deviceName: String? = null,
    val name: String? = null,
    val platform: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("last_used_at") val lastUsedAt: String? = null,
    @SerialName("last_ip") val lastIp: String? = null,
    @Serializable(LenientBooleanSerializer::class) val current: Boolean = false,
) {
    val label: String get() = deviceName ?: name ?: "Gerät"
}

// ---- Read endpoints ----

@Serializable
data class LocationInfo(
    @Serializable(LenientStringSerializer::class) val id: String,
    val name: String = "",
    val color: String? = null,
    val status: String? = null,
    val timezone: String? = null,
    /** Areas this user may use in the sub-account (e.g. "conversations", "tasks"). */
    val areas: List<String>? = null,
)

@Serializable
data class AppRelease(
    @SerialName("version_code") val versionCode: Int = 0,
    @SerialName("version_name") val versionName: String = "",
    @SerialName("apk_url") val apkUrl: String = "",
    val sha256: String = "",
    val size: Long? = null,
    val changelog: String? = null,
    @SerialName("min_supported_code") val minSupportedCode: Int? = null,
    @SerialName("uploaded_at") val uploadedAt: String? = null,
    @SerialName("page_url") val pageUrl: String? = null,
)

@Serializable
data class MeResponse(
    val user: ApiUser = ApiUser(),
    @Serializable(LenientBooleanSerializer::class) val agency: Boolean = false,
    val locations: List<LocationInfo> = emptyList(),
    @SerialName("server_time") val serverTime: String? = null,
    val app: AppRelease? = null,
    @SerialName("device_id") val deviceId: String? = null,
)

@Serializable
data class Rating(val avg: Double = 0.0, val count: Int = 0)

@Serializable
data class WebsiteStats(val up: Int = 0, val down: Int = 0)

@Serializable
data class Summary(
    @SerialName("leads_today") val leadsToday: Int = 0,
    @SerialName("leads_7d") val leads7d: Int = 0,
    @SerialName("open_deals_count") val openDealsCount: Int = 0,
    @SerialName("open_deals_value_cents") val openDealsValueCents: Long = 0,
    @SerialName("won_month_cents") val wonMonthCents: Long = 0,
    @SerialName("revenue_today_cents") val revenueTodayCents: Long = 0,
    @SerialName("revenue_month_cents") val revenueMonthCents: Long = 0,
    @SerialName("open_invoices_cents") val openInvoicesCents: Long = 0,
    @SerialName("unread_conversations") val unreadConversations: Int = 0,
    @SerialName("tasks_due_today") val tasksDueToday: Int = 0,
    @SerialName("tasks_overdue") val tasksOverdue: Int = 0,
    @SerialName("appointments_today") val appointmentsToday: Int = 0,
    @SerialName("missed_calls_today") val missedCallsToday: Int = 0,
    val rating: Rating? = null,
    val websites: WebsiteStats = WebsiteStats(),
    @SerialName("spark_revenue_30d") val sparkRevenue30d: List<Long> = emptyList(),
    @SerialName("spark_leads_14d") val sparkLeads14d: List<Int> = emptyList(),
    val currency: String = "EUR",
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
data class InboxItem(
    @SerialName("conversation_id") @Serializable(LenientStringSerializer::class) val conversationId: String,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String = "",
    @SerialName("location_name") val locationName: String = "",
    @SerialName("contact_id") @Serializable(LenientStringSerializer::class) val contactId: String? = null,
    @SerialName("contact_name") val contactName: String = "",
    val channel: String = "",
    @SerialName("last_message") val lastMessage: String = "",
    @SerialName("last_direction") val lastDirection: String = "",
    @SerialName("last_at") val lastAt: String? = null,
    /** Number of unread messages (the server sends a count). */
    @Serializable(LenientIntSerializer::class) val unread: Int = 0,
    @Serializable(LenientBooleanSerializer::class) val starred: Boolean = false,
) {
    val isUnread: Boolean get() = unread > 0
}

@Serializable
data class ConversationContact(
    @Serializable(LenientStringSerializer::class) val id: String = "",
    val name: String = "",
    val phone: String? = null,
    val email: String? = null,
)

@Serializable
data class ChatMessage(
    @Serializable(LenientStringSerializer::class) val id: String = "",
    val direction: String = "",
    val channel: String = "",
    val subject: String? = null,
    val body: String = "",
    val at: String? = null,
    val status: String? = null,
    val error: String? = null,
)

@Serializable
data class ConversationDetail(
    @SerialName("conversation_id") @Serializable(LenientStringSerializer::class) val conversationId: String = "",
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String = "",
    @SerialName("location_name") val locationName: String = "",
    @Serializable(LenientIntSerializer::class) val unread: Int = 0,
    @Serializable(LenientBooleanSerializer::class) val starred: Boolean = false,
    val contact: ConversationContact = ConversationContact(),
    val channels: List<String> = emptyList(),
    val messages: List<ChatMessage> = emptyList(),
)

@Serializable
data class TaskItem(
    @Serializable(LenientStringSerializer::class) val id: String,
    val title: String = "",
    val description: String? = null,
    @SerialName("due_at") val dueAt: String? = null,
    @Serializable(LenientBooleanSerializer::class) val done: Boolean = false,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String = "",
    @SerialName("location_name") val locationName: String = "",
    @SerialName("contact_id") @Serializable(LenientStringSerializer::class) val contactId: String? = null,
    @SerialName("contact_name") val contactName: String? = null,
    @SerialName("assigned_to") val assignedTo: String? = null,
)

@Serializable
data class Appointment(
    @Serializable(LenientStringSerializer::class) val id: String,
    val title: String = "",
    val start: String? = null,
    val end: String? = null,
    val status: String = "",
    @SerialName("contact_id") @Serializable(LenientStringSerializer::class) val contactId: String? = null,
    @SerialName("contact_name") val contactName: String? = null,
    val phone: String? = null,
    @SerialName("meeting_url") val meetingUrl: String? = null,
    val address: String? = null,
    @SerialName("calendar_name") val calendarName: String? = null,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String = "",
    @SerialName("location_name") val locationName: String = "",
)

@Serializable
data class Stage(
    @Serializable(LenientStringSerializer::class) val id: String,
    val name: String = "",
    val count: Int = 0,
    @SerialName("value_cents") val valueCents: Long = 0,
)

@Serializable
data class Pipeline(
    @Serializable(LenientStringSerializer::class) val id: String,
    val name: String = "",
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String = "",
    @SerialName("location_name") val locationName: String = "",
    val stages: List<Stage> = emptyList(),
)

@Serializable
data class Deal(
    @Serializable(LenientStringSerializer::class) val id: String,
    val name: String = "",
    @SerialName("value_cents") val valueCents: Long = 0,
    val status: String = "open",
    @SerialName("stage_id") @Serializable(LenientStringSerializer::class) val stageId: String = "",
    @SerialName("stage_name") val stageName: String = "",
    @SerialName("pipeline_id") @Serializable(LenientStringSerializer::class) val pipelineId: String = "",
    @SerialName("contact_id") @Serializable(LenientStringSerializer::class) val contactId: String? = null,
    @SerialName("contact_name") val contactName: String? = null,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String = "",
    @SerialName("location_name") val locationName: String = "",
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
data class DealsResponse(
    val pipelines: List<Pipeline> = emptyList(),
    val top: List<Deal> = emptyList(),
)

@Serializable
data class CallItem(
    @Serializable(LenientStringSerializer::class) val id: String,
    val direction: String = "",
    val status: String = "",
    @Serializable(LenientBooleanSerializer::class) val missed: Boolean = false,
    val from: String? = null,
    val to: String? = null,
    @SerialName("contact_id") @Serializable(LenientStringSerializer::class) val contactId: String? = null,
    @SerialName("contact_name") val contactName: String? = null,
    val at: String? = null,
    @SerialName("duration_s") val durationS: Int? = null,
    @SerialName("has_voicemail") @Serializable(LenientBooleanSerializer::class) val hasVoicemail: Boolean = false,
    val summary: String? = null,
    // Not listed for calls in the contract, but "every list item carries location_id and location_name".
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String? = null,
    @SerialName("location_name") val locationName: String? = null,
) {
    /** The other party's number: caller for inbound calls, callee for outbound ones (the server says "in"/"out"). */
    val otherNumber: String? get() = if (direction == "out" || direction == "outbound") to else from
}

@Serializable
data class Uptime(
    val up: Boolean? = null,
    @SerialName("checked_at") val checkedAt: String? = null,
    @SerialName("response_ms") val responseMs: Int? = null,
)

@Serializable
data class ProjectItem(
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String,
    @SerialName("location_name") val locationName: String? = null,
    val name: String = "",
    val status: String? = null,
    val website: String? = null,
    val uptime: Uptime? = null,
    @SerialName("open_tasks") val openTasks: Int = 0,
    @SerialName("overdue_tasks") val overdueTasks: Int = 0,
    @Serializable(LenientIntSerializer::class) val unread: Int = 0,
    @SerialName("claude_url") val claudeUrl: String? = null,
    @SerialName("deep_link") val deepLink: String? = null,
)

@Serializable
data class Review(
    @Serializable(LenientStringSerializer::class) val id: String,
    val author: String = "",
    val rating: Double = 0.0,
    val text: String? = null,
    val at: String? = null,
    val source: String? = null,
    @Serializable(LenientBooleanSerializer::class) val replied: Boolean = false,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String? = null,
    @SerialName("location_name") val locationName: String? = null,
    val link: String? = null,
)

@Serializable
data class ReviewsResponse(
    /** Average stars, null when there are no ratings yet. */
    val avg: Double? = null,
    val count: Int = 0,
    /** Change of the Google star rating over 30 days (e.g. 0.1), null without history. */
    @SerialName("delta_30d") val delta30d: Double? = null,
    /** New reviews in the last 30 days. */
    @SerialName("new_30d") val new30d: Int = 0,
    val latest: List<Review> = emptyList(),
)

@Serializable
data class PaymentItem(
    @Serializable(LenientStringSerializer::class) val id: String,
    val kind: String = "",
    val number: String? = null,
    val title: String = "",
    @SerialName("contact_name") val contactName: String? = null,
    @SerialName("total_cents") val totalCents: Long = 0,
    val currency: String = "EUR",
    val status: String = "",
    @Serializable(LenientBooleanSerializer::class) val overdue: Boolean = false,
    @SerialName("paid_at") val paidAt: String? = null,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String? = null,
    @SerialName("location_name") val locationName: String? = null,
)

@Serializable
data class PaymentsResponse(
    @SerialName("today_cents") val todayCents: Long = 0,
    @SerialName("month_cents") val monthCents: Long = 0,
    @SerialName("open_invoices_cents") val openInvoicesCents: Long = 0,
    @SerialName("overdue_count") val overdueCount: Int = 0,
    val latest: List<PaymentItem> = emptyList(),
    val currency: String = "EUR",
)

@Serializable
data class SocialPost(
    @Serializable(LenientStringSerializer::class) val id: String,
    val text: String = "",
    @SerialName("scheduled_at") val scheduledAt: String? = null,
    val status: String = "",
    val channels: List<String> = emptyList(),
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String? = null,
    @SerialName("location_name") val locationName: String? = null,
)

@Serializable
data class ContactItem(
    @Serializable(LenientStringSerializer::class) val id: String,
    val name: String = "",
    @SerialName("first_name") val firstName: String? = null,
    @SerialName("last_name") val lastName: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val company: String? = null,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String = "",
    @SerialName("location_name") val locationName: String = "",
)

@Serializable
data class FeedEvent(
    @Serializable(LenientStringSerializer::class) val id: String,
    val type: String = "",
    val title: String = "",
    val body: String? = null,
    @SerialName("location_id") @Serializable(LenientStringSerializer::class) val locationId: String? = null,
    @SerialName("location_name") val locationName: String? = null,
    @SerialName("deep_link") val deepLink: String? = null,
    val at: String? = null,
)

@Serializable
data class FeedResponse(
    @Serializable(LenientStringSerializer::class) val cursor: String = "",
    val events: List<FeedEvent> = emptyList(),
)

// ---- Write endpoints ----

@Serializable
data class ReplyRequest(val channel: String? = null, val body: String, val subject: String? = null)

@Serializable
data class CreateTaskRequest(
    @SerialName("location_id") val locationId: String,
    val title: String,
    val description: String? = null,
    @SerialName("due_at") val dueAt: String? = null,
    @SerialName("contact_id") val contactId: String? = null,
)

@Serializable
data class StageRequest(@SerialName("stage_id") val stageId: String)

@Serializable
data class StatusRequest(val status: String)

@Serializable
data class CreateContactRequest(
    @SerialName("location_id") val locationId: String,
    @SerialName("first_name") val firstName: String,
    @SerialName("last_name") val lastName: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val company: String? = null,
    val note: String? = null,
    val tags: List<String>? = null,
)

@Serializable
data class NoteRequest(@SerialName("contact_id") val contactId: String, val body: String)

@Serializable
data class CallRequest(@SerialName("contact_id") val contactId: String)

@Serializable
data class CaptureRequest(@SerialName("location_id") val locationId: String, val text: String)

@Serializable
data class CaptureResponse(
    val kind: String = "task",
    /** True when the AI assistant sorted the text. */
    @Serializable(LenientBooleanSerializer::class) val ai: Boolean = false,
    val item: JsonElement? = null,
) {
    /** Short label of what was created (task title or note body). */
    val label: String
        get() {
            val obj = item as? JsonObject ?: return ""
            val v = obj["title"] ?: obj["body"] ?: obj["text"]
            return (v as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()
        }
}

/** Answer of the Twilio click-to-call relay. */
@Serializable
data class CallStartResponse(val message: String? = null)

@Serializable
data class ApiError(val error: String = "")
