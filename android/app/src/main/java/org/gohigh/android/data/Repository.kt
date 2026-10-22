package org.gohigh.android.data

import org.gohigh.android.api.ApiException
import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.Appointment
import org.gohigh.android.api.CallItem
import org.gohigh.android.api.DealsResponse
import org.gohigh.android.api.GoHighApi
import org.gohigh.android.api.InboxItem
import org.gohigh.android.api.MeResponse
import org.gohigh.android.api.PaymentsResponse
import org.gohigh.android.api.ProjectItem
import org.gohigh.android.api.ReviewsResponse
import org.gohigh.android.api.SocialPost
import org.gohigh.android.api.Summary
import org.gohigh.android.api.TaskItem
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.io.File
import java.time.Instant
import java.time.ZoneId

/** Cached response with the time it was fetched. */
data class Cached<T>(val data: T, val fetchedAt: Long)

/** Last failure of a request (shown small on the widget next to the cached data). */
data class CacheError(val message: String, val at: Long, val unauthorized: Boolean = false)

/**
 * One JSON file per request key (`{"at": …, "data": …}`) plus `.err` files for the last failure.
 * Survives restarts so widgets render instantly from the last data.
 */
class DiskCache(private val dir: File, private val json: Json = ApiJson, private val clock: () -> Long = System::currentTimeMillis) {
    private fun file(key: String, ext: String) = File(dir, key.replace('/', '~').replace(Regex("[^A-Za-z0-9~._-]"), "_") + ext)

    @Synchronized
    fun <T> read(key: String, serializer: KSerializer<T>): Cached<T>? {
        val f = file(key, ".json")
        if (!f.isFile) return null
        return runCatching {
            val o = json.parseToJsonElement(f.readText()).jsonObject
            Cached(json.decodeFromJsonElement(serializer, o.getValue("data")), o.getValue("at").jsonPrimitive.long)
        }.getOrNull()
    }

    @Synchronized
    fun <T> write(key: String, serializer: KSerializer<T>, value: T, at: Long = clock()) {
        dir.mkdirs()
        val body: JsonObject = buildJsonObject {
            put("at", at)
            put("data", json.encodeToJsonElement(serializer, value))
        }
        val f = file(key, ".json")
        val tmp = File(dir, f.name + ".tmp")
        tmp.writeText(body.toString())
        if (!tmp.renameTo(f)) {
            f.delete()
            tmp.renameTo(f)
        }
        file(key, ".err").delete()
    }

    @Synchronized
    fun readError(key: String): CacheError? {
        val f = file(key, ".err")
        if (!f.isFile) return null
        return runCatching {
            val o = json.parseToJsonElement(f.readText()).jsonObject
            CacheError(o.getValue("message").jsonPrimitive.content, o.getValue("at").jsonPrimitive.long, o["unauthorized"]?.jsonPrimitive?.content == "true")
        }.getOrNull()
    }

    @Synchronized
    fun writeError(key: String, error: CacheError) {
        dir.mkdirs()
        file(key, ".err").writeText(buildJsonObject {
            put("message", error.message)
            put("at", error.at)
            put("unauthorized", error.unauthorized)
        }.toString())
    }

    /** Keys of cached responses starting with [prefix] (e.g. "tasks/"). */
    @Synchronized
    fun keys(prefix: String): List<String> =
        dir.listFiles { f -> f.name.endsWith(".json") }.orEmpty().map { it.name.removeSuffix(".json").replace('~', '/') }.filter { it.startsWith(prefix) }

    @Synchronized
    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }
}

/** What the app loads from the Mobile API. Equal requests (same key) are fetched once per refresh. */
sealed class DataRequest<T>(val key: String, val serializer: KSerializer<T>) {
    abstract suspend fun fetch(api: GoHighApi): T

    data object Me : DataRequest<MeResponse>("me", MeResponse.serializer()) {
        override suspend fun fetch(api: GoHighApi) = api.me()
    }

    data class SummaryOf(val location: String) : DataRequest<Summary>("summary/$location", Summary.serializer()) {
        override suspend fun fetch(api: GoHighApi) = api.summary(location)
    }

    data class Inbox(val location: String, val unreadOnly: Boolean) : DataRequest<List<InboxItem>>("inbox/$location/${if (unreadOnly) "unread" else "all"}", ListSerializer(InboxItem.serializer())) {
        override suspend fun fetch(api: GoHighApi) = api.inbox(location, limit = 10, unreadOnly = unreadOnly)
    }

    data class Tasks(val location: String, val filter: String) : DataRequest<List<TaskItem>>("tasks/$location/$filter", ListSerializer(TaskItem.serializer())) {
        override suspend fun fetch(api: GoHighApi) = api.tasks(location, filter)
    }

    data class Appointments(val location: String) : DataRequest<List<Appointment>>("appointments/$location", ListSerializer(Appointment.serializer())) {
        override suspend fun fetch(api: GoHighApi) = api.appointments(location)
    }

    data class Deals(val location: String) : DataRequest<DealsResponse>("deals/$location", DealsResponse.serializer()) {
        override suspend fun fetch(api: GoHighApi) = api.deals(location)
    }

    data object Projects : DataRequest<List<ProjectItem>>("projects", ListSerializer(ProjectItem.serializer())) {
        override suspend fun fetch(api: GoHighApi) = api.projects()
    }

    data class Payments(val location: String) : DataRequest<PaymentsResponse>("payments/$location", PaymentsResponse.serializer()) {
        override suspend fun fetch(api: GoHighApi) = api.payments(location)
    }

    data class Calls(val location: String, val missedOnly: Boolean) : DataRequest<List<CallItem>>("calls/$location/${if (missedOnly) "missed" else "all"}", ListSerializer(CallItem.serializer())) {
        override suspend fun fetch(api: GoHighApi) = api.calls(location, missedOnly = missedOnly)
    }

    data class Reviews(val location: String) : DataRequest<ReviewsResponse>("reviews/$location", ReviewsResponse.serializer()) {
        override suspend fun fetch(api: GoHighApi) = api.reviews(location)
    }

    data class Social(val location: String) : DataRequest<List<SocialPost>>("social/$location", ListSerializer(SocialPost.serializer())) {
        override suspend fun fetch(api: GoHighApi) = api.social(location)
    }
}

/**
 * Today's summary and the one from the last day the app saw – for the trend arrows of the "Zahl" widget
 * (metrics without a server-side history).
 */
@Serializable
data class SummaryHistory(val day: String, val current: Summary, val previousDay: String? = null, val previous: Summary? = null) {
    /** Rolls over when a new day starts. */
    fun record(today: String, s: Summary): SummaryHistory = if (today == day) copy(current = s) else SummaryHistory(today, s, day, current)
}

data class RefreshResult(val ok: Int, val failed: Int, val unauthorized: Boolean)

/**
 * Cached data for widgets and dialogs. [revision] ticks whenever something changed so live widget
 * sessions recompose from the cache.
 */
class Repository(
    private val api: GoHighApi,
    private val cache: DiskCache,
    private val session: Session,
    private val clock: () -> Long,
    private val zone: () -> ZoneId = { ZoneId.systemDefault() },
) {
    private val _revision = MutableStateFlow(0L)
    val revision: StateFlow<Long> = _revision.asStateFlow()

    fun bump() {
        _revision.value = _revision.value + 1
    }

    fun <T> cached(r: DataRequest<T>): Cached<T>? = cache.read(r.key, r.serializer)

    fun error(r: DataRequest<*>): CacheError? = cache.readError(r.key)

    fun me(): MeResponse? = cached(DataRequest.Me)?.data

    fun history(location: String): SummaryHistory? = cache.read("history/$location", SummaryHistory.serializer())?.data

    /** Fetches and caches; a failure is recorded for the widget and rethrown. */
    suspend fun <T> refresh(r: DataRequest<T>): Cached<T> {
        try {
            val value = r.fetch(api)
            val at = clock()
            cache.write(r.key, r.serializer, value, at)
            if (r is DataRequest.SummaryOf) recordHistory(r.location, value as Summary, at)
            bump()
            return Cached(value, at)
        } catch (e: ApiException) {
            cache.writeError(r.key, CacheError(e.message ?: "Fehler", clock(), e is ApiException.Unauthorized))
            bump()
            throw e
        }
    }

    /** The cached value when it is fresh enough, otherwise a new fetch. */
    suspend fun <T> load(r: DataRequest<T>, maxAgeMs: Long): Cached<T> {
        val c = cached(r)
        if (c != null && clock() - c.fetchedAt < maxAgeMs) return c
        return refresh(r)
    }

    /** Refreshes several requests (deduplicated, 4 at a time). Stops early when the token was revoked. */
    suspend fun refreshAll(requests: Collection<DataRequest<*>>): RefreshResult = coroutineScope {
        val unique = requests.distinctBy { it.key }
        val gate = Semaphore(4)
        val results = unique.map { r ->
            async {
                gate.withPermit {
                    if (session.status.value != AuthStatus.ACTIVE) return@withPermit false to true
                    try {
                        refresh(r)
                        true to false
                    } catch (e: ApiException.Unauthorized) {
                        false to true
                    } catch (e: ApiException) {
                        false to false
                    }
                }
            }
        }.awaitAll()
        RefreshResult(ok = results.count { it.first }, failed = results.count { !it.first }, unauthorized = results.any { it.second })
    }

    /** A task ticked on the home screen shows as done right away (the worker syncs it). */
    fun setTaskDoneLocally(id: String, done: Boolean) {
        val serializer = ListSerializer(TaskItem.serializer())
        for (key in cache.keys("tasks/")) {
            val c = cache.read(key, serializer) ?: continue
            if (c.data.none { it.id == id }) continue
            cache.write(key, serializer, c.data.map { if (it.id == id) it.copy(done = done) else it }, c.fetchedAt)
        }
        bump()
    }

    /** A conversation answered or opened from a widget is no longer unread. */
    fun markReadLocally(conversationId: String) {
        val serializer = ListSerializer(InboxItem.serializer())
        for (key in cache.keys("inbox/")) {
            val c = cache.read(key, serializer) ?: continue
            if (c.data.none { it.conversationId == conversationId }) continue
            val list = if (key.endsWith("/unread")) c.data.filterNot { it.conversationId == conversationId } else c.data.map { if (it.conversationId == conversationId) it.copy(unread = 0) else it }
            cache.write(key, serializer, list, c.fetchedAt)
        }
        bump()
    }

    fun clear() {
        cache.clear()
        bump()
    }

    private fun recordHistory(location: String, s: Summary, at: Long) {
        val today = Instant.ofEpochMilli(at).atZone(zone()).toLocalDate().toString()
        val next = history(location)?.record(today, s) ?: SummaryHistory(today, s)
        cache.write("history/$location", SummaryHistory.serializer(), next, at)
    }
}
