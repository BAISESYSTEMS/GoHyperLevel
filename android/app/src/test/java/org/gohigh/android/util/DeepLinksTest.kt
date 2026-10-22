package org.gohigh.android.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinksTest {
    private val base = "https://crm.example.com"

    @Test fun conversationWithLocation() {
        assertEquals("https://crm.example.com/app/conversations?c=conv_1&loc=loc_a", DeepLinks.conversation(base, "conv_1", "loc_a"))
    }

    @Test fun allProjectsOmitsLoc() {
        assertEquals("https://crm.example.com/app/tasks", DeepLinks.tasks(base, "all"))
        assertEquals("https://crm.example.com/app/tasks", DeepLinks.tasks(base, null))
        assertEquals("https://crm.example.com/app/project?loc=loc%20b", DeepLinks.project(base, "loc b"))
    }

    @Test fun contactIdIsEscaped() {
        assertEquals("https://crm.example.com/app/contacts/a%2Fb?loc=l1", DeepLinks.contact(base, "a/b", "l1"))
    }

    @Test fun trailingSlashAndPathPrefixedBase() {
        assertEquals("https://crm.example.com/app/calls", DeepLinks.calls("https://crm.example.com/"))
        assertEquals("https://example.com/crm/app/calendars?loc=x", DeepLinks.calendars("https://example.com/crm", "x"))
    }

    @Test fun resolveFeedLinks() {
        assertEquals("https://crm.example.com/app/conversations?c=1&loc=l", DeepLinks.resolve(base, "/app/conversations?c=1&loc=l"))
        assertEquals("https://other.host/x", DeepLinks.resolve(base, "https://other.host/x"))
        assertEquals("https://crm.example.com/app", DeepLinks.resolve(base, null))
        assertEquals("https://example.com/crm/app/calls?loc=l", DeepLinks.resolve("https://example.com/crm", "/app/calls?loc=l"))
    }

    @Test fun internalAndAppPages() {
        assertTrue(DeepLinks.isInternal(base, "https://crm.example.com/api/x"))
        assertTrue(DeepLinks.isInternal(base, "https://CRM.example.com/app"))
        assertFalse(DeepLinks.isInternal(base, "https://evil.example/app"))
        assertFalse(DeepLinks.isInternal(base, "http://crm.example.com/app")) // other port/scheme default
        assertTrue(DeepLinks.isAppPage(base, "https://crm.example.com/app"))
        assertTrue(DeepLinks.isAppPage(base, "https://crm.example.com/app/tasks?x=1"))
        assertFalse(DeepLinks.isAppPage(base, "https://crm.example.com/application"))
        assertFalse(DeepLinks.isAppPage(base, "https://crm.example.com/android"))
    }

    @Test fun appLinksAreRebasedOntoTheConfiguredServer() {
        assertEquals("http://10.0.2.2:3000/app/tasks?loc=a", DeepLinks.rebase("http://10.0.2.2:3000", "https://crm.example.com/app/tasks?loc=a"))
        assertEquals("https://crm.example.com/app/x", DeepLinks.rebase(base, "https://crm.example.com/app/x"))
    }
}
