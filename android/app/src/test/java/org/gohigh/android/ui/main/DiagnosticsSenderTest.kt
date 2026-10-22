package org.gohigh.android.ui.main

import android.app.Application
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockWebServer
import org.gohigh.android.AppGraph
import org.gohigh.android.api.ApiJson
import org.gohigh.android.data.InMemoryTokenStore
import org.gohigh.android.support.fixture
import org.gohigh.android.support.json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** „Diagnose senden“: a bug report to the team through the existing feedback API, the share sheet when that is not possible. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DiagnosticsSenderTest {
    private lateinit var server: MockWebServer
    private val app: Application get() = ApplicationProvider.getApplicationContext()
    private val oldWebView = WebViewInfo("com.google.android.webview", "74.0.3729.136")

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
    }

    @After fun tearDown() = server.shutdown()

    private fun graph(token: String?): AppGraph {
        val g = AppGraph(app, InMemoryTokenStore(token))
        g.settings.baseUrl = server.url("/").toString()
        g.webLog.clear()
        g.webLog.add("JS", "Uncaught SyntaxError: Unexpected token '?.'")
        g.webLog.add("HTTP", "404 Not Found https://crm.example.com/assets/Settings-OLD.js")
        g.webLog.setStatus(LoadState.EMPTY, url = "https://crm.example.com/app?token=secret")
        return g
    }

    @Test fun sendsTheReportAsAnUrgentBugReport() = runBlocking {
        server.enqueue(json(fixture("bug_report_created.json")))
        val g = graph("ghm_test")
        val text = DiagnosticsSender.report(g, oldWebView, reason = null)
        assertEquals("Gesendet – Meldung #1", DiagnosticsSender.send(app, g, text))

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/mobile/bug-reports", req.path)
        assertEquals("Bearer ghm_test", req.getHeader("Authorization"))
        val body = ApiJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("bug", body["category"]!!.jsonPrimitive.content)
        assertEquals("hoch", body["severity"]!!.jsonPrimitive.content)
        assertEquals("Weiße Seite", body["screen"]!!.jsonPrimitive.content)
        val what = body["what"]!!.jsonPrimitive.content
        assertTrue(what.startsWith("Weiße Seite in der HyperLevel-App:"))
        assertTrue(what.contains("WebView: com.google.android.webview 74.0.3729.136 – zu alt"))
        assertTrue(what.contains("Uncaught SyntaxError: Unexpected token '?.'"))
        assertTrue(what.contains("404 Not Found https://crm.example.com/assets/Settings-OLD.js"))
        // no query strings (tokens) in what goes to the team
        assertTrue(!what.contains("secret"))
        assertNotNull(body["device"]!!.jsonObject["model"])
        // nothing was shared
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test fun withoutAConnectionToTheAccountTheDiagnosisIsOfferedForSharing() = runBlocking {
        val g = graph(null)
        val text = DiagnosticsSender.report(g, oldWebView, reason = null)
        val message = DiagnosticsSender.send(app, g, text)
        assertTrue(message, message.contains("nicht angemeldet"))
        assertEquals(0, server.requestCount)
        val chooser = shadowOf(app).nextStartedActivity
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        @Suppress("DEPRECATION") val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals(text, send.getStringExtra(Intent.EXTRA_TEXT))
    }

    @Test fun aServerErrorAlsoOffersTheShareSheet() = runBlocking {
        server.enqueue(json("""{"error":"Zu viele Anfragen – bitte kurz warten"}""", 429))
        val g = graph("ghm_test")
        val message = DiagnosticsSender.send(app, g, DiagnosticsSender.report(g, oldWebView, null))
        assertTrue(message, message.startsWith("Senden nicht möglich"))
        assertTrue(message.contains("kurz warten"))
        assertEquals(Intent.ACTION_CHOOSER, shadowOf(app).nextStartedActivity.action)
    }

    @Test fun theReportUsesTheLastLoadStatusAndTheAppVersion() {
        val g = graph("ghm_test")
        val text = DiagnosticsSender.report(g, WebViewInfo("com.google.android.webview", "129.0.6668.100"), reason = "Eigener Grund", now = g.webLog.status.at + 3_000)
        assertTrue(text.startsWith("Weiße Seite in der HyperLevel-App: Eigener Grund"))
        assertTrue(text.contains("Status: Seite leer – die Web-App ist nicht gestartet (vor 3 s"))
        assertTrue(Regex("""App: 1\.0\.\d+(-debug)? \(\d+\)""").containsMatchIn(text))
        assertTrue(!text.contains("zu alt"))
        assertTrue(text.contains("Seite: https://crm.example.com/app\n") || text.contains("Seite: https://crm.example.com/app"))
    }
}
