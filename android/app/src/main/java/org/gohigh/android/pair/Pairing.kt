package org.gohigh.android.pair

import android.content.Context
import android.os.Build
import android.webkit.CookieManager
import org.gohigh.android.AppGraph
import org.gohigh.android.BuildConfig
import org.gohigh.android.api.ApiException
import org.gohigh.android.api.PairRequest
import org.gohigh.android.data.AuthStatus
import org.gohigh.android.data.DataRequest
import org.gohigh.android.work.WorkScheduler
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Trades the WebView login (session cookie `pghl_session`) for a device token once the user is signed in.
 * Cheap to call often: without a session cookie, or with a cookie that already failed, nothing is sent.
 */
class Pairing(private val context: Context, private val g: AppGraph = AppGraph.get(context)) {
    enum class Result { PAIRED, ALREADY, NO_SESSION, REJECTED, FAILED }

    private val mutex = Mutex()
    private var failedCookie: String? = null

    fun sessionCookie(): String? {
        val cookies = runCatching { CookieManager.getInstance().getCookie(g.settings.baseUrl) }.getOrNull() ?: return null
        return cookies.takeIf { c -> c.split(';').any { it.trim().startsWith("$SESSION_COOKIE=") && it.trim().length > SESSION_COOKIE.length + 1 } }
    }

    suspend fun maybePair(force: Boolean = false): Result = mutex.withLock {
        if (g.settings.demoMode || (g.session.status.value == AuthStatus.ACTIVE && g.session.isPaired)) return Result.ALREADY
        val cookie = sessionCookie() ?: return Result.NO_SESSION
        if (!force && cookie == failedCookie) return Result.REJECTED
        try {
            val resp = g.api.pair(cookie, PairRequest(deviceName = deviceName(), appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"))
            g.session.signIn(resp)
            failedCookie = null
            g.repository.bump()
            runCatching { g.repository.refresh(DataRequest.Me) }
            WorkScheduler.schedulePeriodic(context, g.settings.refreshMinutes)
            WorkScheduler.refreshNow(context, feed = true)
            Result.PAIRED
        } catch (e: ApiException.Unauthorized) {
            failedCookie = cookie
            Result.REJECTED
        } catch (e: ApiException.Http) {
            if (e.code in 400..499) failedCookie = cookie
            Result.FAILED
        } catch (e: ApiException) {
            Result.FAILED
        }
    }

    companion object {
        const val SESSION_COOKIE = "pghl_session"

        fun deviceName(): String {
            val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
            val model = Build.MODEL.orEmpty()
            return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model".trim().ifBlank { "Android-Gerät" }
        }
    }
}
