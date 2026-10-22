package org.gohigh.android.ui.main

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/** The decisions behind the blank-screen protection: plain JVM tests, no WebView. */
class WebHealthTest {
    private val base = "https://crm.example.com"

    // ------------------------------------------------------------------ restoreState

    @Test fun restoredHistoryWithoutAPageLoadsTheStartPage() {
        // restoreState() == null (nothing saved / unreadable)
        assertTrue(RestorePolicy.needsFreshLoad(null))
        // …and the case that caused the blank screen: not null, but empty
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(0, -1, null)))
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(0, 0, null)))
        // entries, but no current item / index outside the list / nothing to show
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(3, -1, null)))
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(3, 3, "$base/app")))
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(1, 0, null)))
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(1, 0, "")))
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(1, 0, "  ")))
        assertTrue(RestorePolicy.needsFreshLoad(RestoredHistory(1, 0, "about:blank")))
    }

    @Test fun restoredHistoryWithARealPageIsKept() {
        assertFalse(RestorePolicy.needsFreshLoad(RestoredHistory(1, 0, "$base/app")))
        assertFalse(RestorePolicy.needsFreshLoad(RestoredHistory(4, 3, "$base/app/contacts/c1")))
        assertFalse(RestorePolicy.needsFreshLoad(RestoredHistory(2, 0, "$base/app/dashboard")))
    }

    @Test fun reloadNeedsAPageToReload() {
        // reload() on a WebView without a page does nothing – that is why „Neu laden“ never helped on a blank screen
        assertEquals(RestorePolicy.ReloadAction.LOAD_HOME, RestorePolicy.reloadAction(null, base))
        assertEquals(RestorePolicy.ReloadAction.LOAD_HOME, RestorePolicy.reloadAction("", base))
        assertEquals(RestorePolicy.ReloadAction.LOAD_HOME, RestorePolicy.reloadAction("about:blank", base))
        assertEquals(RestorePolicy.ReloadAction.LOAD_HOME, RestorePolicy.reloadAction("data:text/html,x", base))
        assertEquals(RestorePolicy.ReloadAction.LOAD_HOME, RestorePolicy.reloadAction("https://evil.example.org/app", base))
        assertEquals(RestorePolicy.ReloadAction.RELOAD, RestorePolicy.reloadAction("$base/app/tasks", base))
        assertEquals(RestorePolicy.ReloadAction.RELOAD, RestorePolicy.reloadAction("$base/android", base))
        // a page that never finished loading (restored but not started): a fresh load of the start page
        assertEquals(RestorePolicy.ReloadAction.LOAD_HOME, RestorePolicy.reloadAction("$base/app/tasks", base, pageNeverFinished = true))
    }

    @Test fun afterACrashTheAppPageIsLoadedAgainOtherwiseTheStartPage() {
        assertEquals("$base/app/contacts/c1?loc=l1", RestorePolicy.recoveryUrl("$base/app/contacts/c1?loc=l1", base))
        assertEquals("$base/app", RestorePolicy.recoveryUrl(null, base))
        assertEquals("$base/app", RestorePolicy.recoveryUrl("about:blank", base))
        assertEquals("$base/app", RestorePolicy.recoveryUrl("https://other.example.org/app", base))
        assertEquals("$base/app", RestorePolicy.recoveryUrl("$base/android", base))
    }

    // ------------------------------------------------------------------ render process lost

    @Test fun firstLossIsReplacedSecondWithinAMinuteGivesUp() {
        val t = RenderCrashTracker()
        assertEquals(RenderCrashTracker.Decision.REPLACE_AND_RELOAD, t.record(1_000))
        assertEquals(RenderCrashTracker.Decision.GIVE_UP, t.record(30_000))
    }

    @Test fun lossesFarApartAreHiccups() {
        val t = RenderCrashTracker()
        assertEquals(RenderCrashTracker.Decision.REPLACE_AND_RELOAD, t.record(0))
        assertEquals(RenderCrashTracker.Decision.REPLACE_AND_RELOAD, t.record(61_000))
        assertEquals(RenderCrashTracker.Decision.REPLACE_AND_RELOAD, t.record(125_000))
        // the minute is exactly over after 60 s
        assertEquals(RenderCrashTracker.Decision.REPLACE_AND_RELOAD, t.record(185_000))
        assertEquals(RenderCrashTracker.Decision.GIVE_UP, t.record(244_999))
    }

    @Test fun tryingAgainStartsTheCountOver() {
        val t = RenderCrashTracker()
        t.record(0)
        assertEquals(RenderCrashTracker.Decision.GIVE_UP, t.record(10_000))
        t.reset()
        assertEquals(RenderCrashTracker.Decision.REPLACE_AND_RELOAD, t.record(11_000))
    }

    @Test fun certificateErrorsAreExplained() {
        assertTrue(SslProblem.describe(0).contains("noch nicht gültig"))
        assertTrue(SslProblem.describe(1).contains("abgelaufen"))
        assertTrue(SslProblem.describe(1).contains("Uhrzeit"))
        assertTrue(SslProblem.describe(2).contains("Namen"))
        assertTrue(SslProblem.describe(3).contains("vertraut"))
        assertTrue(SslProblem.describe(4).contains("Datum"))
        assertTrue(SslProblem.describe(5).contains("ungültig"))
        assertTrue(SslProblem.describe(99).contains("ungültig"))
    }

    @Test fun theReasonSaysWhoEndedTheProcess() {
        assertTrue(RenderCrashTracker.describe(true).contains("abgestürzt"))
        assertTrue(RenderCrashTracker.describe(false).contains("Arbeitsspeicher"))
    }

    // ------------------------------------------------------------------ is the page alive?

    @Test fun probeAnswerIsParsedFromWhateverEvaluateJavascriptReturns() {
        val obj = """{"root":true,"children":2,"text":120,"mounted":true,"guard":true,"fallback":false,"errors":["a","b"],"ready":"complete","url":"/app"}"""
        val p = PageHealth.parseProbe(obj)!!
        assertTrue(p.root)
        assertEquals(2, p.children)
        assertEquals(listOf("a", "b"), p.errors)
        assertEquals("complete", p.ready)
        // a JSON string that contains the object (when a page returns JSON.stringify(...))
        assertEquals(p, PageHealth.parseProbe("\"" + obj.replace("\"", "\\\"") + "\""))
        // unknown keys and missing ones are fine (older and newer pages)
        assertEquals(PageProbe(root = true, children = 1), PageHealth.parseProbe("""{"root":true,"children":1,"extra":5}"""))
    }

    @Test fun noAnswerIsNoAnswer() {
        assertNull(PageHealth.parseProbe(null))
        assertNull(PageHealth.parseProbe(""))
        assertNull(PageHealth.parseProbe("null"))
        assertNull(PageHealth.parseProbe("undefined"))
        assertNull(PageHealth.parseProbe("not json"))
        assertNull(PageHealth.parseProbe("[1,2]"))
    }

    @Test fun theRootMustHoldSomething() {
        assertEquals(PageVerdict.HEALTHY, PageHealth.judge(PageProbe(root = true, children = 1, mounted = true, guard = true)))
        // an older server build has no flag and no guard: the content is what counts
        assertEquals(PageVerdict.HEALTHY, PageHealth.judge(PageProbe(root = true, children = 1)))
        // nothing in #root – flag or not
        assertEquals(PageVerdict.EMPTY, PageHealth.judge(PageProbe(root = true, children = 0)))
        assertEquals(PageVerdict.EMPTY, PageHealth.judge(PageProbe(root = true, children = 0, mounted = true, guard = true)))
        // the web's own "Die App konnte nicht starten" page has content, but it is the failure page
        assertEquals(PageVerdict.WEB_FALLBACK, PageHealth.judge(PageProbe(root = true, children = 1, fallback = true, guard = true)))
        // other pages of the server (download page, public pages) are not the app
        assertEquals(PageVerdict.NOT_AN_APP_PAGE, PageHealth.judge(PageProbe(root = false)))
        // the page could not even run the script
        assertEquals(PageVerdict.NO_ANSWER, PageHealth.judge(null))
    }

    @Test fun verdictsMapToStates() {
        assertEquals(LoadState.OK, PageHealth.stateOf(PageVerdict.HEALTHY))
        assertEquals(LoadState.OK, PageHealth.stateOf(PageVerdict.NOT_AN_APP_PAGE))
        assertEquals(LoadState.EMPTY, PageHealth.stateOf(PageVerdict.EMPTY))
        assertEquals(LoadState.WEB_FALLBACK, PageHealth.stateOf(PageVerdict.WEB_FALLBACK))
        assertEquals(LoadState.NO_ANSWER, PageHealth.stateOf(PageVerdict.NO_ANSWER))
        assertFalse(LoadState.OK.isFailure)
        assertFalse(LoadState.LOADING.isFailure)
        assertFalse(LoadState.NET_ERROR.isFailure) // the offline screen has it
        listOf(LoadState.EMPTY, LoadState.WEB_FALLBACK, LoadState.NO_ANSWER, LoadState.NO_FINISH, LoadState.HTTP_ERROR, LoadState.RENDERER_LOOP).forEach { assertTrue(it.name, it.isFailure) }
    }

    // ------------------------------------------------------------------ the watchdog timing

    @Test fun theAppIsChecked6SecondsAfterThePageFinished() {
        val w = LoadWatchdog()
        w.loadStarted(0)
        w.pageFinished(2_000, appPage = true)
        assertEquals(LoadWatchdog.Action.NONE, w.due(2_000))
        assertEquals(LoadWatchdog.Action.NONE, w.due(7_999))
        assertEquals(LoadWatchdog.Action.PROBE, w.due(8_000))
        // reported once, until the answer is in
        assertEquals(LoadWatchdog.Action.NONE, w.due(8_500))
        assertTrue(w.armed())
        w.probeDone(8_600, healthy = true)
        assertFalse(w.armed())
        assertEquals(LoadWatchdog.Action.NONE, w.due(60_000))
    }

    @Test fun aPageThatNeverFinishesIsReportedAfter30Seconds() {
        val w = LoadWatchdog()
        w.loadStarted(1_000)
        assertEquals(LoadWatchdog.Action.NONE, w.due(30_999))
        assertEquals(LoadWatchdog.Action.NO_FINISH, w.due(31_000))
        assertEquals(LoadWatchdog.Action.NONE, w.due(40_000))
        assertFalse(w.armed())
    }

    @Test fun finishingInTimeCancelsTheStartTimeout() {
        val w = LoadWatchdog()
        w.loadStarted(0)
        w.pageFinished(5_000, appPage = true)
        // long after the 30 s of the start timeout it is the check that is due, not "never finished"
        assertEquals(LoadWatchdog.Action.PROBE, w.due(31_000))
    }

    @Test fun otherPagesOfTheServerAreNotChecked() {
        val w = LoadWatchdog()
        w.loadStarted(0)
        w.pageFinished(1_000, appPage = false)
        assertFalse(w.armed())
        assertEquals(LoadWatchdog.Action.NONE, w.due(100_000))
    }

    @Test fun aFailedCheckIsRepeatedEvery5SecondsForTwoMinutesThenLeftAlone() {
        val w = LoadWatchdog()
        w.pageFinished(0, appPage = true)
        assertEquals(LoadWatchdog.Action.PROBE, w.due(6_000))
        w.probeDone(6_100, healthy = false)
        assertTrue(w.armed())
        assertEquals(LoadWatchdog.Action.NONE, w.due(11_000))
        assertEquals(LoadWatchdog.Action.PROBE, w.due(11_100))
        w.probeDone(11_200, healthy = false)
        // …until two minutes after the first failed check
        var t = 11_200L
        var probes = 0
        while (w.armed() && t < 400_000) {
            t += 100
            if (w.due(t) == LoadWatchdog.Action.PROBE) {
                probes++
                w.probeDone(t + 50, healthy = false)
            }
        }
        assertFalse(w.armed())
        assertTrue("probes: $probes", probes in 20..25)
        assertTrue(t < 6_100 + 120_000 + 6_000)
    }

    @Test fun theAppComingUpLaterEndsTheChecks() {
        val w = LoadWatchdog()
        w.pageFinished(0, appPage = true)
        w.due(6_000)
        w.probeDone(6_100, healthy = false)
        assertEquals(LoadWatchdog.Action.PROBE, w.due(11_100))
        w.probeDone(11_200, healthy = true)
        assertFalse(w.armed())
    }

    @Test fun aNewLoadStartsOver() {
        val w = LoadWatchdog()
        w.pageFinished(0, appPage = true)
        w.due(6_000)
        w.probeDone(6_100, healthy = false)
        w.loadStarted(7_000)
        assertEquals(LoadWatchdog.Action.NONE, w.due(11_100))
        w.pageFinished(8_000, appPage = true)
        assertEquals(LoadWatchdog.Action.NONE, w.due(13_999))
        assertEquals(LoadWatchdog.Action.PROBE, w.due(14_000))
    }

    @Test fun backInFrontLooksAgainSoon() {
        val w = LoadWatchdog()
        w.recheck(100_000)
        assertEquals(LoadWatchdog.Action.NONE, w.due(101_000))
        assertEquals(LoadWatchdog.Action.PROBE, w.due(101_500))
    }

    @Test fun cancelStopsEverything() {
        val w = LoadWatchdog()
        w.loadStarted(0)
        w.cancel()
        assertFalse(w.armed())
        assertEquals(LoadWatchdog.Action.NONE, w.due(1_000_000))
    }

    // ------------------------------------------------------------------ the log

    @Test fun logKeepsTheNewestAndCountsRepeats() {
        var t = 0L
        val log = WebLog(capacity = 5, clock = { t })
        repeat(8) { i -> t = i * 1000L; log.add("JS", "Fehler $i") }
        val s = log.snapshot()
        assertEquals(5, s.size)
        assertEquals("Fehler 3", s.first().text)
        assertEquals("Fehler 7", s.last().text)
        t = 9_000
        log.add("JS", "Fehler 7")
        log.add("JS", "Fehler 7")
        assertEquals(3, log.snapshot().last().count)
        assertEquals(9_000, log.snapshot().last().at)
        assertTrue(log.lines(1, ZoneOffset.UTC).single().endsWith("JS: Fehler 7 (3×)"))
        // another kind with the same text is its own line
        log.add("HTTP", "Fehler 7")
        assertEquals(2, log.snapshot().takeLast(2).map { it.kind }.toSet().size)
        log.add("JS", "   ")
        assertEquals("HTTP", log.snapshot().last().kind)
    }

    @Test fun logLinesAreShortAndReadable() {
        val log = WebLog(clock = { 3_600_000L * 20 + 41 * 60_000 + 3_000 })
        log.add("HTTP", "x".repeat(1000))
        assertEquals(WebLog.MAX_TEXT, log.snapshot().single().text.length)
        val line = log.lines(1, ZoneOffset.UTC).single()
        assertTrue(line, line.startsWith("20:41:03 HTTP: xxx"))
    }

    @Test fun logLinesAreTheNewestOnesNewestLast() {
        var t = 0L
        val log = WebLog(clock = { t })
        repeat(10) { t += 1000; log.add("JS", "e$it") }
        assertEquals(listOf("e7", "e8", "e9"), log.lines(3, ZoneOffset.UTC).map { it.substringAfter("JS: ") })
    }

    @Test fun statusAndErrorsSurviveARestart() {
        var t = 5_000L
        val log = WebLog(clock = { t })
        log.add("JS", "Uncaught SyntaxError: Unexpected token")
        log.setStatus(LoadState.EMPTY, "Leer", "$base/app/contacts?token=secret#frag")
        val saved = log.toJson()
        val again = WebLog(clock = { t })
        again.restore(saved)
        assertEquals(LoadState.EMPTY, again.status.state)
        assertEquals(5_000, again.status.at)
        assertEquals("Leer", again.status.detail)
        assertEquals("Uncaught SyntaxError: Unexpected token", again.snapshot().single().text)
        // broken or missing data leaves the log as it is
        again.restore("{ broken")
        again.restore(null)
        assertEquals(1, again.snapshot().size)
    }

    @Test fun neverKeepsQueryStringsOrFragmentsOfUrls() {
        assertEquals("$base/app/contacts", WebLog.cleanUrl("$base/app/contacts?token=secret&x=1#frag"))
        assertEquals("", WebLog.cleanUrl(null))
        val log = WebLog()
        log.setStatus(LoadState.OK, "", "$base/app/login?magic=abc123")
        assertEquals("$base/app/login", log.status.url)
    }

    @Test fun statusChangesAreAnnounced() {
        val log = WebLog()
        var seen: LoadState? = null
        log.onStatusChange = { seen = it.status.state }
        log.setStatus(LoadState.LOADING, url = "$base/app")
        assertEquals(LoadState.LOADING, seen)
        // a status without a URL keeps the last one
        log.setStatus(LoadState.OK)
        assertEquals("$base/app", log.status.url)
    }

    @Test fun onlyThePageAndTheAppsFilesAreWorthALogLine() {
        assertTrue(WebLog.worthLogging(true, "$base/app"))
        assertTrue(WebLog.worthLogging(false, "$base/assets/index-Ab12Cd34.js"))
        assertTrue(WebLog.worthLogging(false, "$base/assets/app-1.css?v=2"))
        assertFalse(WebLog.worthLogging(false, "$base/api/contacts"))
        assertFalse(WebLog.worthLogging(false, "https://tracker.example.org/pixel.gif"))
    }

    // ------------------------------------------------------------------ the WebView version

    @Test fun webViewVersionAgainstTheMinimum() {
        assertEquals(129, WebViewVersion.major("129.0.6668.100"))
        assertEquals(74, WebViewVersion.major(" 74.0.3729.136 "))
        assertNull(WebViewVersion.major(null))
        assertNull(WebViewVersion.major(""))
        assertNull(WebViewVersion.major("beta"))
        assertNull(WebViewVersion.major("0.1"))
        assertTrue(WebViewVersion.isTooOld("74.0.3729.136"))
        assertTrue(WebViewVersion.isTooOld("${MIN_WEBVIEW_MAJOR - 1}.0.0.0"))
        assertFalse(WebViewVersion.isTooOld("$MIN_WEBVIEW_MAJOR.0.0.0"))
        assertFalse(WebViewVersion.isTooOld("129.0.6668.100"))
        // unknown is not "too old": no false alarm
        assertFalse(WebViewVersion.isTooOld(null))
        assertFalse(WebViewVersion.isTooOld("weird"))
    }

    @Test fun theMinimumMatchesTheWebBuildTarget() {
        // vite.config.ts: build.target = [... 'chrome92' ...] – both move together
        val vite = java.io.File("../../vite.config.ts").takeIf { it.isFile } ?: java.io.File("../vite.config.ts").takeIf { it.isFile }
        if (vite != null) assertTrue(vite.readText().contains("'chrome$MIN_WEBVIEW_MAJOR'"))
    }

    @Test fun webViewInfoComesFromThePackageOrTheUserAgent() {
        val pkg = WebViewInfo("com.google.android.webview", "129.0.6668.100")
        assertEquals("com.google.android.webview 129.0.6668.100", pkg.label)
        assertEquals(129, pkg.major)
        assertFalse(pkg.tooOld)
        val ua = WebViewInfo.fromUserAgent("Mozilla/5.0 (Linux; Android 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.136 Mobile Safari/537.36 GoHighApp/1.0.2")
        assertEquals("74.0.3729.136", ua.versionName)
        assertTrue(ua.tooOld)
        assertEquals("74.0.3729.136", ua.label)
        assertEquals("unbekannt", WebViewInfo(null, null).label)
        assertNull(WebViewInfo.fromUserAgent(null).versionName)
    }

    @Test fun onlyPlayStoreWebViewsGetAnUpdateButton() {
        assertEquals("com.google.android.webview", WebViewVersion.playStorePackage("com.google.android.webview"))
        assertEquals("com.google.android.webview.beta", WebViewVersion.playStorePackage("com.google.android.webview.beta"))
        assertEquals("com.android.chrome", WebViewVersion.playStorePackage("com.android.chrome"))
        assertEquals("com.google.android.webview", WebViewVersion.playStorePackage(null))
        assertNull(WebViewVersion.playStorePackage("app.vanadium.webview"))
        assertNull(WebViewVersion.playStorePackage("com.example.fake"))
        assertEquals("market://details?id=com.google.android.webview", WebViewVersion.marketUrl("com.google.android.webview"))
        assertEquals("https://play.google.com/store/apps/details?id=com.google.android.webview", WebViewVersion.webUrl("com.google.android.webview"))
    }

    // ------------------------------------------------------------------ the error screen

    @Test fun theErrorScreenSaysWhyAndHintsAtAnOldWebView() {
        val old = FallbackInfo(LoadState.EMPTY, FallbackInfo.reasonFor(LoadState.EMPTY), listOf("20:00:01 JS: boom"), WebViewInfo("com.google.android.webview", "74.0.3729.136"))
        assertEquals("Die Seite lädt nicht", FallbackInfo.TITLE)
        assertTrue(old.tooOld)
        assertEquals("com.google.android.webview", old.updatePackage)
        assertTrue(old.reason.contains("nichts angezeigt"))
        val fine = old.copy(webView = WebViewInfo("com.google.android.webview", "129.0.6668.100"))
        assertFalse(fine.tooOld)
        assertNull(fine.updatePackage)
        // an old WebView that is not from the Play Store: the hint, but no store button
        assertNull(old.copy(webView = WebViewInfo("app.vanadium.webview", "80.0")).updatePackage)
        // unknown version: no false alarm
        assertFalse(old.copy(webView = WebViewInfo(null, null)).tooOld)
    }

    @Test fun reasonsAreReadable() {
        assertTrue(FallbackInfo.reasonFor(LoadState.NO_FINISH).contains("30 Sekunden"))
        assertTrue(FallbackInfo.reasonFor(LoadState.WEB_FALLBACK).contains("nicht starten"))
        assertTrue(FallbackInfo.reasonFor(LoadState.NO_ANSWER).contains("antwortet nicht"))
        assertEquals(
            "Der Web-Prozess der Anzeige ist abgestürzt. Zweimal innerhalb einer Minute.",
            FallbackInfo.reasonFor(LoadState.RENDERER_LOOP, RenderCrashTracker.describe(true)),
        )
        assertEquals("Der Server antwortete mit Fehler 502.", FallbackInfo.reasonFor(LoadState.HTTP_ERROR, "Der Server antwortete mit Fehler 502."))
    }

    @Test fun theDiagnosticsReportHasWhatTheTeamNeedsAndNothingPrivate() {
        val status = WebStatus(LoadState.EMPTY, at = 1_000_000, url = "$base/app/contacts")
        val text = DiagnosticsReport.build(
            appVersion = "1.0.2 (3)",
            device = "Google Pixel 7, Android 14 (SDK 34)",
            baseUrl = "https://crm.example.com/some/path?secret=1",
            webView = WebViewInfo("com.google.android.webview", "74.0.3729.136"),
            status = status,
            lines = listOf("20:41:03 JS: Uncaught SyntaxError", "20:41:04 HTTP: 404 /assets/x.js"),
            now = 1_012_000,
            reason = FallbackInfo.reasonFor(LoadState.EMPTY),
            zone = ZoneOffset.UTC,
        )
        assertTrue(text.startsWith("Weiße Seite in der HyperLevel-App: Die Seite ist geladen, aber die Web-App hat nichts angezeigt."))
        assertTrue(text, text.contains("App: 1.0.2 (3)"))
        assertTrue(text.contains("Gerät: Google Pixel 7, Android 14 (SDK 34)"))
        assertTrue(text.contains("WebView: com.google.android.webview 74.0.3729.136 – zu alt (mindestens $MIN_WEBVIEW_MAJOR nötig)"))
        assertTrue(text.contains("Server: crm.example.com\n"))
        assertFalse(text.contains("secret"))
        assertFalse(text.contains("/some/path"))
        assertTrue(text, text.contains("Status: Seite leer – die Web-App ist nicht gestartet (vor 12 s, 00:16:40)"))
        assertTrue(text.contains("Seite: $base/app/contacts"))
        assertTrue(text.contains("- 20:41:03 JS: Uncaught SyntaxError\n- 20:41:04 HTTP: 404 /assets/x.js"))
    }

    @Test fun theReportIsBoundedAndSaysWhenThereAreNoErrors() {
        val lines = List(200) { "x".repeat(200) }
        val long = DiagnosticsReport.build("1", "d", "https://a.example", WebViewInfo(null, null), WebStatus(), lines, 0, "r")
        assertTrue(long.length <= DiagnosticsReport.MAX_REPORT)
        val none = DiagnosticsReport.build("1", "d", "https://a.example", WebViewInfo("p", "129.0"), WebStatus(), emptyList(), 0, "r")
        assertTrue(none.endsWith("Keine Fehler aufgezeichnet."))
        assertFalse(none.contains("zu alt"))
        assertNotNull(none)
    }
}
