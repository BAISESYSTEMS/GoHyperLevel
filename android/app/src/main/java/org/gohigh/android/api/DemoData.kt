package org.gohigh.android.api

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/**
 * Realistic sample data relative to "now". Used by the hidden "Demo-Daten" mode (FakeBackend), widget
 * previews in the picker and the screenshot tests – so the app can be tried before the server ships.
 */
class DemoData(private val nowMs: Long = System.currentTimeMillis(), private val zone: ZoneId = ZoneId.systemDefault()) {
    private val now: Instant = Instant.ofEpochMilli(nowMs)
    private val today: LocalDate = now.atZone(zone).toLocalDate()

    private fun ago(minutes: Long) = now.minus(Duration.ofMinutes(minutes)).toString()
    private fun at(day: LocalDate, h: Int, m: Int = 0) = day.atTime(LocalTime.of(h, m)).atZone(zone).toInstant().toString()

    val locations = listOf(
        LocationInfo("loc_maler", "Malerbetrieb Fischer", "#2563eb", "active"),
        LocationInfo("loc_yoga", "Yoga Studio Lotus", "#16a34a", "active"),
        LocationInfo("loc_kanzlei", "Kanzlei Weber", "#9333ea", "active"),
        LocationInfo("loc_auto", "Autohaus Krämer", "#ea580c", "active"),
    )

    private fun loc(i: Int) = locations[i % locations.size]

    fun me() = MeResponse(
        user = ApiUser("u1", "Alex Demo", "demo@example.com", "admin"),
        agency = true,
        locations = locations,
        serverTime = now.toString(),
        app = null,
    )

    fun summary(location: String = ALL_LOCATIONS): Summary {
        val f = if (location == ALL_LOCATIONS) 1.0 else 0.35
        fun s(v: Long) = (v * f).toLong()
        fun i(v: Int) = (v * f).toInt().coerceAtLeast(if (v > 0) 1 else 0)
        val spark = listOf(
            820, 640, 910, 1200, 760, 0, 0, 1340, 1580, 990, 1720, 1410, 0, 0, 1880, 2140, 1650, 2420, 1960, 0, 0,
            2210, 2480, 2050, 2890, 2630, 0, 0, 3120, 2740,
        ).map { s(it * 100L) }
        return Summary(
            leadsToday = i(7), leads7d = i(38), openDealsCount = i(23), openDealsValueCents = s(4_870_000),
            wonMonthCents = s(1_245_000), revenueTodayCents = s(274_000), revenueMonthCents = s(4_268_000),
            openInvoicesCents = s(912_500), unreadConversations = i(12), tasksDueToday = i(6), tasksOverdue = i(2),
            appointmentsToday = i(4), missedCallsToday = i(3), rating = Rating(4.8, i(127)),
            websites = WebsiteStats(up = if (location == ALL_LOCATIONS) 3 else 1, down = if (location == ALL_LOCATIONS) 1 else 0),
            sparkRevenue30d = spark, sparkLeads14d = listOf(3, 5, 2, 6, 4, 1, 0, 5, 7, 4, 8, 6, 5, 7).map { i(it) },
            currency = "EUR", updatedAt = now.toString(),
        )
    }

    fun inbox(): List<InboxItem> = listOf(
        InboxItem("c1", loc(0).id, loc(0).name, "k1", "Lena Fischer", "whatsapp", "Super, dann passt Donnerstag um 9 Uhr! 👍", "inbound", ago(3), unread = 2),
        InboxItem("c2", loc(1).id, loc(1).name, "k2", "Jonas Becker", "email", "Re: Angebot Jahresmitgliedschaft – haben Sie noch Fragen?", "inbound", ago(18), unread = 1, starred = true),
        InboxItem("c3", loc(2).id, loc(2).name, "k3", "Miriam Koch", "sms", "Danke, die Unterlagen sind angekommen.", "inbound", ago(52), unread = 1),
        InboxItem("c4", loc(3).id, loc(3).name, "k4", "Tobias Wagner", "livechat", "Ist der Kombi noch verfügbar?", "inbound", ago(95)),
        InboxItem("c5", loc(0).id, loc(0).name, "k5", "Sandra Hoffmann", "instagram", "Wie lange dauert ein Wohnzimmer ungefähr?", "inbound", ago(180)),
        InboxItem("c6", loc(1).id, loc(1).name, "k6", "Felix Schulz", "messenger", "Ich komme heute etwas später.", "outbound", ago(260)),
        InboxItem("c7", loc(2).id, loc(2).name, "k7", "Anna Richter", "email", "Terminbestätigung für Montag", "outbound", ago(400)),
    )

    fun conversation(id: String) = ConversationDetail(
        conversationId = id,
        contact = ConversationContact("k1", "Lena Fischer", "+49 170 1234567", "lena@example.com"),
        channels = listOf("whatsapp", "sms", "email"),
        messages = listOf(
            ChatMessage("m1", direction = "inbound", channel = "whatsapp", body = "Hallo! Was kostet es, ein Wohnzimmer streichen zu lassen?", at = ago(240)),
            ChatMessage("m2", direction = "outbound", channel = "whatsapp", body = "Hallo Lena! Ein Raum bis 20 m² kostet ab 290 € inkl. Material.", at = ago(230)),
            ChatMessage("m3", direction = "inbound", channel = "whatsapp", body = "Super, dann passt Donnerstag um 9 Uhr! 👍", at = ago(3)),
        ),
    )

    fun tasks(filter: String = "today"): List<TaskItem> {
        val overdue = listOf(
            TaskItem("t1", "Angebot an Familie Braun schicken", dueAt = at(today.minusDays(1), 17), locationId = loc(0).id, locationName = loc(0).name, contactName = "Familie Braun"),
            TaskItem("t2", "Rückruf Steuerberater", dueAt = at(today.minusDays(2), 10), locationId = loc(2).id, locationName = loc(2).name),
        )
        val todays = listOf(
            TaskItem("t3", "Farbmuster bei Lena vorbeibringen", dueAt = at(today, 11), locationId = loc(0).id, locationName = loc(0).name, contactName = "Lena Fischer"),
            TaskItem("t4", "Newsletter für Oktober freigeben", dueAt = at(today, 14, 30), locationId = loc(1).id, locationName = loc(1).name),
            TaskItem("t5", "Mandantenakte Koch prüfen", dueAt = at(today, 16), locationId = loc(2).id, locationName = loc(2).name, contactName = "Miriam Koch"),
            TaskItem("t6", "Probefahrt Kombi vorbereiten", dueAt = at(today, 17, 30), done = true, locationId = loc(3).id, locationName = loc(3).name),
        )
        return when (filter) {
            "overdue" -> overdue
            "today" -> todays
            else -> overdue + todays
        }
    }

    fun appointments(): List<Appointment> = listOf(
        Appointment("a1", "Besichtigung Wohnzimmer", at(today, 9), at(today, 10), "confirmed", "k1", "Lena Fischer", "+49 170 1234567", null, "Lindenstraße 12, 50674 Köln", "Vor-Ort-Termine", loc(0).id, loc(0).name),
        Appointment("a2", "Probestunde Vinyasa", at(today, 12, 30), at(today, 13, 30), "confirmed", "k2", "Jonas Becker", "+49 151 2223334", null, null, "Kurse", loc(1).id, loc(1).name),
        Appointment("a3", "Erstberatung Erbrecht", at(today, 15), at(today, 15, 45), "booked", "k3", "Miriam Koch", "+49 160 5556667", "https://meet.example.com/koch", null, "Beratung", loc(2).id, loc(2).name),
        Appointment("a4", "Probefahrt Kombi", at(today.plusDays(1), 10), at(today.plusDays(1), 11), "booked", "k4", "Tobias Wagner", "+49 171 9998887", null, "Industriestraße 3, 51149 Köln", "Probefahrten", loc(3).id, loc(3).name),
        Appointment("a5", "Farbberatung", at(today.plusDays(1), 14), at(today.plusDays(1), 15), "confirmed", "k5", "Sandra Hoffmann", null, "https://meet.example.com/hoffmann", null, "Online", loc(0).id, loc(0).name),
    )

    fun deals() = DealsResponse(
        pipelines = listOf(
            Pipeline(
                "p1", "Vertrieb", loc(0).id, loc(0).name,
                listOf(
                    Stage("s1", "Neu", 9, 1_240_000),
                    Stage("s2", "Kontaktiert", 6, 980_000),
                    Stage("s3", "Angebot", 5, 1_630_000),
                    Stage("s4", "Verhandlung", 3, 1_020_000),
                ),
            ),
        ),
        top = listOf(
            Deal("d1", "Komplettsanierung Altbau", 1_850_000, stageId = "s3", stageName = "Angebot", pipelineId = "p1", contactName = "Familie Braun", locationId = loc(0).id, locationName = loc(0).name, updatedAt = ago(60)),
            Deal("d2", "Fassade Bürogebäude", 1_240_000, stageId = "s4", stageName = "Verhandlung", pipelineId = "p1", contactName = "Weber Immobilien", locationId = loc(0).id, locationName = loc(0).name, updatedAt = ago(300)),
            Deal("d3", "Treppenhaus 4 Etagen", 680_000, stageId = "s2", stageName = "Kontaktiert", pipelineId = "p1", contactName = "HV Müller", locationId = loc(0).id, locationName = loc(0).name, updatedAt = ago(900)),
            Deal("d4", "Wohnzimmer + Flur", 129_000, stageId = "s1", stageName = "Neu", pipelineId = "p1", contactName = "Lena Fischer", locationId = loc(0).id, locationName = loc(0).name, updatedAt = ago(30)),
        ),
    )

    fun calls(): List<CallItem> = listOf(
        CallItem("call1", "inbound", "missed", true, "+49 170 1234567", "+49 221 999000", "k1", "Lena Fischer", ago(12), null, hasVoicemail = true, summary = "Fragt nach Termin am Donnerstag", locationId = loc(0).id, locationName = loc(0).name),
        CallItem("call2", "inbound", "missed", true, "+49 152 7654321", "+49 221 999000", null, null, ago(75), null, locationId = loc(3).id, locationName = loc(3).name),
        CallItem("call3", "inbound", "missed", true, "+49 160 5556667", "+49 221 999001", "k3", "Miriam Koch", ago(210), null, locationId = loc(2).id, locationName = loc(2).name),
    )

    fun projects(): List<ProjectItem> = listOf(
        ProjectItem(loc(0).id, name = loc(0).name, status = "active", website = "https://maler-fischer.example", uptime = Uptime(true, ago(2), 182), openTasks = 5, unread = 4),
        ProjectItem(loc(1).id, name = loc(1).name, status = "active", website = "https://yoga-lotus.example", uptime = Uptime(true, ago(2), 240), openTasks = 2, unread = 1),
        ProjectItem(loc(2).id, name = loc(2).name, status = "active", website = "https://kanzlei-weber.example", uptime = Uptime(false, ago(4), null), openTasks = 7, unread = 3),
        ProjectItem(loc(3).id, name = loc(3).name, status = "active", website = "https://autohaus-kraemer.example", uptime = Uptime(true, ago(2), 310), openTasks = 1, unread = 4),
        ProjectItem("loc_baeckerei", name = "Bäckerei Sonnenschein", status = "active", website = null, uptime = null, openTasks = 0, unread = 0),
    )

    fun reviews() = ReviewsResponse(
        avg = 4.8, count = 127, delta30d = 0.1, new30d = 9,
        latest = listOf(
            Review("r1", "Katrin M.", 5.0, "Super sauber gearbeitet, pünktlich und sehr freundlich. Gerne wieder!", ago(300), "google"),
            Review("r2", "Peter S.", 4.0, "Gute Beratung, Termin hat sich etwas verschoben.", ago(2900), "google", replied = true),
        ),
    )

    fun payments() = PaymentsResponse(
        todayCents = 274_000, monthCents = 4_268_000, openInvoicesCents = 912_500, overdueCount = 2,
        latest = listOf(
            PaymentItem("i1", "invoice", number = "1043", title = "Rechnung #1043", contactName = "Familie Braun", totalCents = 189_000, status = "paid", paidAt = ago(40), locationName = loc(0).name),
            PaymentItem("i2", "invoice", number = "1044", title = "Jahresabo Yoga", contactName = "Jonas Becker", totalCents = 85_000, status = "paid", paidAt = ago(200), locationName = loc(1).name),
        ),
        currency = "EUR",
    )

    fun social(): List<SocialPost> = listOf(
        SocialPost("sp1", text = "Vorher/Nachher: So schön kann ein Altbau-Treppenhaus werden ✨", scheduledAt = at(today, 18), status = "scheduled", channels = listOf("instagram", "facebook"), locationId = loc(0).id, locationName = loc(0).name),
        SocialPost("sp2", text = "Neuer Kurs ab Montag: Yoga für Einsteiger – jetzt Platz sichern!", scheduledAt = at(today.plusDays(1), 8, 30), status = "scheduled", channels = listOf("instagram", "linkedin"), locationId = loc(1).id, locationName = loc(1).name),
        SocialPost("sp3", text = "5 Tipps zum Erbrecht, die jeder kennen sollte", scheduledAt = at(today.plusDays(2), 12), status = "scheduled", channels = listOf("linkedin", "x"), locationId = loc(2).id, locationName = loc(2).name),
    )

    fun contacts(query: String = ""): List<ContactItem> = listOf(
        ContactItem("k1", name = "Lena Fischer", email = "lena@example.com", phone = "+49 170 1234567", company = null, locationId = loc(0).id, locationName = loc(0).name),
        ContactItem("k2", name = "Jonas Becker", email = "jonas@example.com", phone = "+49 151 2223334", company = null, locationId = loc(1).id, locationName = loc(1).name),
        ContactItem("k3", name = "Miriam Koch", email = "miriam@example.com", phone = "+49 160 5556667", company = "Koch GmbH", locationId = loc(2).id, locationName = loc(2).name),
        ContactItem("k4", name = "Tobias Wagner", email = null, phone = "+49 171 9998887", company = null, locationId = loc(3).id, locationName = loc(3).name),
        ContactItem("k5", name = "Sandra Hoffmann", email = "sandra@example.com", phone = null, company = null, locationId = loc(0).id, locationName = loc(0).name),
    ).filter { query.isBlank() || it.name.contains(query, ignoreCase = true) }

    private fun st(key: String, label: String, tone: String, board: String = "", done: Boolean = false) = FeedbackStatus(key, board, label, tone, done)

    fun bugReports(): List<BugReport> = listOf(
        BugReport("r3", "bug", 42, "Widget zeigt keine Termine nach Neustart", st("in_arbeit", "In Arbeit", "yellow"), "hoch", "android", unread = true, createdAt = ago(60 * 26), updatedAt = ago(35)),
        BugReport("r2", "question", 37, "Wie exportiere ich alle Kontakte als CSV?", st("behoben", "Beantwortet", "green", done = true), createdAt = ago(60 * 72), updatedAt = ago(60 * 50)),
        BugReport("r1", "bug", 31, "Kalender zeigt Termine eine Stunde zu spät", st("ausgeliefert", "Ausgeliefert", "green", done = true), "mittel", "web", version = "2.4.1", note = "Termine stimmen nach der Zeitumstellung wieder.", createdAt = ago(60 * 24 * 9), updatedAt = ago(60 * 24 * 2)),
    )

    fun bugReportDetail(id: String): BugReportDetail {
        val r = bugReports().firstOrNull { it.id == id } ?: bugReports()[0]
        return BugReportDetail(
            report = r,
            body = r.title,
            thread = listOf(
                ThreadItem("e1", "status", label = "Bestätigt", at = ago(60 * 20)),
                ThreadItem("e2", "team", body = "Danke! Wir konnten es nachstellen – der Fix kommt mit dem nächsten Update.", author = "Team", at = ago(60 * 19)),
            ),
            canReply = true,
        )
    }

    fun wishes(): List<Wish> = listOf(
        Wish("w1", 51, "Termine direkt aus einer Rechnung buchen", "Beim Schreiben der Rechnung gleich den nächsten Termin anlegen.", "Umsatz", st("bestaetigt", "Geplant", "purple", "planned"), votes = 23, myVote = true, comments = 4),
        Wish("w2", 48, "WhatsApp-Vorlagen im Workflow auswählen", "Statt Text kopieren: freigegebene Vorlagen direkt wählen.", "Automationen", st("in_arbeit", "In Arbeit", "yellow", "in_progress"), votes = 17, comments = 2),
        Wish("w3", 55, "Widget für offene Tickets", "Offene Tickets auf dem Homescreen.", "App", st("neu", "Idee", "blue", "idea"), votes = 9, mine = true),
        Wish("w4", 39, "KI fasst Anrufe automatisch zusammen", "Nach jedem Anruf eine kurze Notiz am Kontakt.", "KI", st("ausgeliefert", "Fertig", "green", "done", true), votes = 31, myVote = true, version = "2.5.0"),
    )
}
