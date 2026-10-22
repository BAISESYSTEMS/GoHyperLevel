package org.gohigh.android

import android.annotation.SuppressLint
import android.content.Context
import org.gohigh.android.api.FakeBackend
import org.gohigh.android.api.GoHighApi
import org.gohigh.android.data.AppSettings
import org.gohigh.android.data.DiskCache
import org.gohigh.android.data.KeystoreTokenStore
import org.gohigh.android.data.Repository
import org.gohigh.android.data.Session
import org.gohigh.android.data.TokenStore
import org.gohigh.android.feedback.ApiErrorLog
import org.gohigh.android.notify.Notifier
import org.gohigh.android.ui.main.WebLog
import org.gohigh.android.update.Updater
import org.gohigh.android.widget.WidgetConfigStore
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** Hand-wired app singletons (small app, no DI framework needed). Tests may [install] their own graph. */
class AppGraph(
    context: Context,
    tokenStore: TokenStore? = null,
    clock: () -> Long = System::currentTimeMillis,
) {
    val context: Context = context.applicationContext
    val clock: () -> Long = clock
    val settings = AppSettings(this.context)
    val tokens: TokenStore = tokenStore ?: KeystoreTokenStore(this.context)
    val session = Session(tokens, this.context.getSharedPreferences("gohigh_session", Context.MODE_PRIVATE)) { settings.demoMode }

    val http: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(FakeBackend({ settings.demoMode }))
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    val userAgent = "HyperLevel-Android/${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

    /** Last failed API calls, attached to bug reports. */
    val apiErrors = ApiErrorLog(clock = clock)

    /** Console errors, failed requests and the last load status of the main WebView (error screen, Einstellungen → Diagnose); the status survives a restart. */
    val webLog = WebLog(clock = clock).also { log ->
        val prefs = this.context.getSharedPreferences("gohigh_meta", Context.MODE_PRIVATE)
        log.restore(prefs.getString("web_diag", null))
        log.onStatusChange = { prefs.edit().putString("web_diag", it.toJson()).apply() }
    }

    val api = GoHighApi(
        http = http,
        baseUrl = { settings.baseUrl },
        token = { session.token() },
        userAgent = userAgent,
        appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
        onUnauthorized = { session.markExpired() },
        onFailure = apiErrors::record,
    )

    val cache = DiskCache(File(this.context.filesDir, "cache"), clock = clock)
    val repository = Repository(api, cache, session, clock)
    val widgetConfigs = WidgetConfigStore(this.context)
    val notifier by lazy { Notifier(this.context, settings) }
    val updater by lazy { Updater(this.context, api, http, settings) }

    companion object {
        @SuppressLint("StaticFieldLeak") // holds the application context only
        @Volatile
        private var instance: AppGraph? = null

        fun get(context: Context): AppGraph =
            instance ?: synchronized(this) { instance ?: AppGraph(context.applicationContext).also { instance = it } }

        /** For tests and previews. */
        fun install(graph: AppGraph) {
            instance = graph
        }
    }
}
