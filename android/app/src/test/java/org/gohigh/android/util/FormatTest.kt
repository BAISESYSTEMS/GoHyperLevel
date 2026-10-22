package org.gohigh.android.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class FormatTest {
    private val berlin = ZoneId.of("Europe/Berlin")
    // Sun 2026-10-04 10:00 Berlin
    private val now = Instant.parse("2026-10-04T08:00:00Z").toEpochMilli()

    @Test fun money() {
        assertEquals("1.234 €", Fmt.money(123_400))
        assertEquals("12,50 €", Fmt.money(1_250))
        assertEquals("0 €", Fmt.money(0))
        assertEquals("980 €", Fmt.moneyShort(98_000))
        assertEquals("1,2k €", Fmt.moneyShort(123_400))
        assertEquals("48k €", Fmt.moneyShort(4_812_300))
        assertEquals("1,5 Mio. €", Fmt.moneyShort(150_000_000))
        assertEquals("12 $", Fmt.moneyShort(1_200, "USD"))
    }

    @Test fun ago() {
        assertEquals("gerade eben", Fmt.ago(now - 20_000, now))
        assertEquals("vor 5 Min.", Fmt.ago(now - 5 * 60_000, now))
        assertEquals("vor 2 Std.", Fmt.ago(now - 2 * 3600_000, now))
        assertEquals("vor 1 Tag", Fmt.ago(now - 25 * 3600_000L, now))
        assertEquals("vor 3 Tagen", Fmt.ago(now - 3 * 86_400_000L, now))
    }

    @Test fun dueDatesRespectDateOnlyValues() {
        // date-only (UTC midnight) means "that day", not 02:00 local time
        assertEquals("heute", Fmt.due("2026-10-04T00:00:00.000Z", now, berlin))
        assertEquals("morgen", Fmt.due("2026-10-05T00:00:00.000Z", now, berlin))
        assertEquals("überfällig", Fmt.due("2026-10-03T00:00:00.000Z", now, berlin))
        assertEquals("heute 16:00", Fmt.due("2026-10-04T14:00:00.000Z", now, berlin))
        assertEquals("morgen 09:30", Fmt.due("2026-10-05T07:30:00.000Z", now, berlin))
        assertEquals("", Fmt.due(null, now, berlin))
    }

    @Test fun overdue() {
        assertTrue(Fmt.isOverdue("2026-10-03T00:00:00.000Z", now, berlin))
        assertFalse(Fmt.isOverdue("2026-10-04T00:00:00.000Z", now, berlin)) // due today, not overdue
        assertTrue(Fmt.isOverdue("2026-10-04T07:00:00.000Z", now, berlin)) // timed, already passed
        assertFalse(Fmt.isOverdue("2026-10-04T09:00:00.000Z", now, berlin))
        assertFalse(Fmt.isOverdue(null, now, berlin))
    }

    @Test fun shortTimeAndClock() {
        assertEquals("09:58", Fmt.shortTime("2026-10-04T07:58:00.000Z", now, berlin))
        assertEquals("gestern", Fmt.shortTime("2026-10-03T07:58:00.000Z", now, berlin))
        assertEquals("15:00", Fmt.clock("2026-10-04T13:00:00Z", berlin))
        assertEquals("", Fmt.shortTime("kaputt", now, berlin))
    }

    @Test fun percentChange() {
        assertEquals("+50 %", Fmt.percentChange(3.0, 2.0))
        assertEquals("-25 %", Fmt.percentChange(3.0, 4.0))
        assertNull(Fmt.percentChange(3.0, 0.0))
    }
}
