package org.gohigh.android.update

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.gohigh.android.api.AppRelease
import org.gohigh.android.data.AppSettings
import org.gohigh.android.support.FakePrefs
import org.gohigh.android.support.json
import org.gohigh.android.support.testApi
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UpdaterTest {
    private lateinit var server: MockWebServer
    private lateinit var updater: Updater
    private val abcSha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        updater = Updater(ctx, testApi(server), OkHttpClient(), AppSettings(FakePrefs()), localCode = 2, allowHttp = true)
    }

    @After fun tearDown() = server.shutdown()

    @Test fun versionCompare() {
        assertTrue(VersionCheck.isNewer(AppRelease(versionCode = 3), 2))
        assertFalse(VersionCheck.isNewer(AppRelease(versionCode = 2), 2))
        assertFalse(VersionCheck.isNewer(AppRelease(versionCode = 1), 2))
        assertFalse(VersionCheck.isNewer(null, 2))
        assertTrue(VersionCheck.isForced(AppRelease(versionCode = 5, minSupportedCode = 3), 2))
        assertFalse(VersionCheck.isForced(AppRelease(versionCode = 5, minSupportedCode = 2), 2))
        assertFalse(VersionCheck.isForced(AppRelease(versionCode = 5), 2))
        assertEquals("1,5 MB", VersionCheck.sizeLabel(1_572_864))
        assertNull(VersionCheck.sizeLabel(0))
    }

    @Test fun sha256() {
        assertEquals(abcSha, Sha256.of("abc".byteInputStream()))
        assertTrue(Sha256.matches(abcSha, abcSha.uppercase()))
        assertTrue(Sha256.matches(abcSha, "sha256:$abcSha"))
        assertTrue(Sha256.matches(abcSha, abcSha.chunked(2).joinToString(":")))
        assertFalse(Sha256.matches(abcSha, abcSha.dropLast(1) + "0"))
        assertFalse(Sha256.matches(abcSha, ""))
    }

    @Test fun checkReturnsOnlyNewerReleases() = runBlocking {
        server.enqueue(json("""{"version_code":3,"version_name":"1.1.0","apk_url":"/downloads/gohigh.apk","sha256":"$abcSha"}"""))
        server.enqueue(json("""{"version_code":2,"version_name":"1.0.1","apk_url":"/downloads/gohigh.apk","sha256":"$abcSha"}"""))
        server.enqueue(json("""{"error":"Noch keine App"}""", 404))
        assertEquals(3, updater.check()?.versionCode)
        assertNull(updater.check())
        assertNull(updater.check())
    }

    @Test fun downloadVerifiesChecksum() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().writeUtf8("abc")))
        var last = 0f
        val file = updater.download(AppRelease(3, "1.1.0", server.url("/downloads/gohigh.apk").toString(), abcSha, 3)) { last = it }
        assertEquals("abc", file.readText())
        assertEquals(1f, last)
        assertEquals("/downloads/gohigh.apk", server.takeRequest().path)
    }

    @Test fun downloadRejectsTamperedApk() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().writeUtf8("abd")))
        try {
            updater.download(AppRelease(3, "1.1.0", server.url("/downloads/gohigh.apk").toString(), abcSha))
            fail("tampered download accepted")
        } catch (e: UpdateException) {
            assertTrue(e.message!!.contains("Prüfsumme"))
        }
        val dir = java.io.File(ApplicationProvider.getApplicationContext<Context>().cacheDir, "updates")
        assertTrue(dir.listFiles().isNullOrEmpty())
    }

    @Test fun downloadNeedsAChecksum() = runBlocking {
        try {
            updater.download(AppRelease(3, "1.1.0", server.url("/x.apk").toString(), ""))
            fail()
        } catch (e: UpdateException) {
            assertEquals(0, server.requestCount)
        }
    }

    @Test fun releaseBuildsRefusePlainHttp() = runBlocking {
        val strict = Updater(ApplicationProvider.getApplicationContext(), testApi(server), OkHttpClient(), AppSettings(FakePrefs()), localCode = 2, allowHttp = false)
        try {
            strict.download(AppRelease(3, "1.1.0", server.url("/downloads/gohigh.apk").toString(), abcSha))
            fail()
        } catch (e: UpdateException) {
            assertEquals("Update nur über HTTPS erlaubt", e.message)
            assertEquals(0, server.requestCount)
        }
    }
}
