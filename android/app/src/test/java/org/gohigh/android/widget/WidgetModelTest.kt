package org.gohigh.android.widget

import org.gohigh.android.api.Summary
import org.gohigh.android.data.DataRequest
import org.gohigh.android.data.SummaryHistory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetModelTest {
    @Test fun requirementsPerKind() {
        val c = WidgetConfig(location = "loc_a")
        assertEquals(listOf(DataRequest.SummaryOf("loc_a")), WidgetKind.COCKPIT.requests(c))
        assertEquals(listOf(DataRequest.Tasks("loc_a", "overdue"), DataRequest.Tasks("loc_a", "today")), WidgetKind.TASKS.requests(c))
        assertEquals(listOf(DataRequest.Tasks("loc_a", "week")), WidgetKind.TASKS.requests(c.copy(taskFilter = "week")))
        assertEquals(listOf(DataRequest.Inbox("loc_a", true)), WidgetKind.INBOX.requests(c.copy(unreadOnly = true)))
        assertEquals(listOf(DataRequest.Projects), WidgetKind.PROJECTS.requests(c))
        assertTrue(WidgetKind.QUICK.requests(c).isEmpty())
        assertEquals(2, WidgetKind.REVENUE.requests(c).size)
        // equal requests from different widgets collapse to one fetch
        assertEquals(1, (WidgetKind.KPI.requests(c) + WidgetKind.COCKPIT.requests(c)).toSet().size)
    }

    @Test fun cacheKeysAreDistinctPerOption() {
        assertEquals("inbox/all/unread", DataRequest.Inbox("all", true).key)
        assertEquals("calls/loc/missed", DataRequest.Calls("loc", true).key)
        assertEquals("tasks/all/today", DataRequest.Tasks("all", "today").key)
    }

    @Test fun trendsFromSparklinesAndHistory() {
        val s = Summary(leadsToday = 4, sparkLeads14d = listOf(1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 4), sparkRevenue30d = List(29) { 0L } + 500L, unreadConversations = 9)
        val leads = Trends.of(KpiMetric.LEADS_TODAY, s, null)!!
        assertEquals(TrendDir.UP, leads.dir)
        assertTrue(leads.good)
        assertEquals("+100 %", leads.label)
        assertEquals(TrendDir.UP, Trends.of(KpiMetric.LEADS_7D, s, null)!!.dir)
        // unread rising is bad
        val h = SummaryHistory("2026-10-04", s, "2026-10-03", Summary(unreadConversations = 3))
        val unread = Trends.of(KpiMetric.UNREAD, s, h)!!
        assertEquals(TrendDir.UP, unread.dir)
        assertEquals(false, unread.good)
        assertNull(Trends.of(KpiMetric.UNREAD, s, null))
    }

    @Test fun kpiFormatting() {
        val s = Summary(openDealsValueCents = 4_870_000, rating = org.gohigh.android.api.Rating(4.75, 10), tasksDueToday = 2, tasksOverdue = 1)
        assertEquals("49k €", KpiMetric.OPEN_DEALS.format(s))
        assertEquals("48.700 €", KpiMetric.OPEN_DEALS.format(s, short = false))
        assertEquals("4,8", KpiMetric.RATING.format(s))
        assertEquals("3", KpiMetric.TASKS_DUE.format(s))
    }

    @Test fun quickActionDefaultsAndLookup() {
        assertEquals(7, QuickAction.DEFAULTS.size)
        assertEquals(QuickAction.VOICE, QuickAction.of("voice"))
        assertNull(QuickAction.of("nope"))
        assertEquals(TaskFilter.TODAY_OVERDUE, TaskFilter.of("garbage"))
    }
}
