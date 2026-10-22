package org.gohigh.android.util

import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

/** German formatting for money, numbers and relative times. */
object Fmt {
    private val DE = Locale.GERMANY
    private val symbols = DecimalFormatSymbols(DE)

    private fun currencySymbol(currency: String) = when (currency.uppercase()) {
        "EUR", "" -> "€"
        "USD" -> "$"
        "CHF" -> "CHF"
        "GBP" -> "£"
        else -> currency.uppercase()
    }

    /** 1.234,56 € (cents shown only below 100 € or when [cents] is true). */
    fun money(cents: Long, currency: String = "EUR", cents2: Boolean? = null): String {
        val euros = cents / 100.0
        val showCents = cents2 ?: (abs(cents) < 10_000 && cents % 100 != 0L)
        val pattern = if (showCents) "#,##0.00" else "#,##0"
        val value = if (showCents) euros else (euros).roundToLong().toDouble()
        return DecimalFormat(pattern, symbols).format(value) + " " + currencySymbol(currency)
    }

    /** Short money for tight widgets: 980 €, 12,3k €, 1,2 Mio. € */
    fun moneyShort(cents: Long, currency: String = "EUR"): String {
        val euros = cents / 100.0
        val sym = currencySymbol(currency)
        val a = abs(euros)
        return when {
            a >= 1_000_000 -> DecimalFormat("#,##0.#", symbols).format(euros / 1_000_000) + " Mio. $sym"
            a >= 10_000 -> DecimalFormat("#,##0", symbols).format(euros / 1_000) + "k $sym"
            a >= 1_000 -> DecimalFormat("#,##0.#", symbols).format(euros / 1_000) + "k $sym"
            else -> DecimalFormat("#,##0", symbols).format(euros) + " $sym"
        }
    }

    fun number(n: Long): String = DecimalFormat("#,##0", symbols).format(n)

    fun decimal(d: Double, digits: Int = 1): String =
        DecimalFormat(if (digits == 0) "#,##0" else "#,##0." + "0".repeat(digits), symbols).format(d)

    fun parseInstant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** "gerade eben", "vor 5 Min.", "vor 2 Std.", "vor 3 Tagen". */
    fun ago(thenMs: Long, nowMs: Long): String {
        val d = Duration.ofMillis((nowMs - thenMs).coerceAtLeast(0))
        return when {
            d.toMinutes() < 1 -> "gerade eben"
            d.toMinutes() < 60 -> "vor ${d.toMinutes()} Min."
            d.toHours() < 24 -> "vor ${d.toHours()} Std."
            d.toDays() == 1L -> "vor 1 Tag"
            else -> "vor ${d.toDays()} Tagen"
        }
    }

    /** Compact time for list rows: 14:30 today, "gestern", "Mo", or 12.10. */
    fun shortTime(iso: String?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val t = parseInstant(iso)?.atZone(zone) ?: return ""
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val day = t.toLocalDate()
        return when {
            day == today -> t.format(HHMM)
            day == today.minusDays(1) -> "gestern"
            day.isAfter(today.minusDays(7)) && day.isBefore(today) -> t.format(DateTimeFormatter.ofPattern("EE", DE)).trimEnd('.')
            else -> t.format(DateTimeFormatter.ofPattern("dd.MM.", DE))
        }
    }

    fun clock(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        parseInstant(iso)?.atZone(zone)?.format(HHMM) ?: ""

    /** "Heute", "Morgen", "Gestern" or "Mo, 12.10." */
    fun dayLabel(date: LocalDate, today: LocalDate): String = when (date) {
        today -> "Heute"
        today.plusDays(1) -> "Morgen"
        today.minusDays(1) -> "Gestern"
        else -> date.format(DateTimeFormatter.ofPattern("EE, dd.MM.", DE))
    }

    /** The server stores date-only due dates as UTC midnight ("2026-10-04T00:00:00.000Z"). */
    fun isDateOnly(iso: String?): Boolean = iso != null && DATE_ONLY.matches(iso)

    private fun dueDate(iso: String, zone: ZoneId): LocalDate? =
        if (isDateOnly(iso)) runCatching { LocalDate.parse(iso.substring(0, 10)) }.getOrNull()
        else parseInstant(iso)?.atZone(zone)?.toLocalDate()

    /** Due label for tasks: "überfällig", "heute 14:00", "morgen", "Fr 12.10." */
    fun due(iso: String?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        if (iso == null) return ""
        val day = dueDate(iso, zone) ?: return ""
        val now = Instant.ofEpochMilli(nowMs).atZone(zone)
        val today = now.toLocalDate()
        val time: ZonedDateTime? = if (isDateOnly(iso)) null else parseInstant(iso)?.atZone(zone)
        val t = time?.format(HHMM)
        return when {
            day.isBefore(today) -> "überfällig"
            day == today -> if (t != null) "heute $t" else "heute"
            day == today.plusDays(1) -> if (t != null) "morgen $t" else "morgen"
            else -> day.format(DateTimeFormatter.ofPattern("EE dd.MM.", DE))
        }
    }

    /** Due before today (local), or a timed task whose time has passed. */
    fun isOverdue(iso: String?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): Boolean {
        if (iso == null) return false
        val day = dueDate(iso, zone) ?: return false
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        if (day.isBefore(today)) return true
        if (isDateOnly(iso) || day != today) return false
        return (parseInstant(iso)?.toEpochMilli() ?: Long.MAX_VALUE) < nowMs
    }

    fun duration(seconds: Int?): String {
        val s = seconds ?: return ""
        return if (s < 60) "${s}s" else "${s / 60}:${"%02d".format(s % 60)} Min."
    }

    /** Percentage change label like "+12 %" (null when not computable). */
    fun percentChange(now: Double, before: Double): String? {
        if (before == 0.0) return null
        val p = (now - before) / abs(before) * 100
        val r = p.roundToLong()
        return (if (r > 0) "+" else "") + r + " %"
    }

    private val HHMM = DateTimeFormatter.ofPattern("HH:mm", DE)
    private val DATE_ONLY = Regex("""^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?Z)?$""")
}
