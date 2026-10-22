package org.gohigh.android.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import org.gohigh.android.api.ApiJson
import org.gohigh.android.api.ApiUser
import org.gohigh.android.api.PairResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Whether the app may talk to the server: paired and valid, never paired, or revoked (401). */
enum class AuthStatus { SIGNED_OUT, ACTIVE, EXPIRED }

/** Where the device token (ghm_…) lives. */
interface TokenStore {
    fun read(): String?
    fun write(token: String?)
}

/** For tests and previews. */
class InMemoryTokenStore(private var token: String? = null) : TokenStore {
    override fun read(): String? = token
    override fun write(token: String?) {
        this.token = token
    }
}

/**
 * The token encrypted with an AES-GCM key from the Android Keystore (never leaves the device, not in
 * backups). If the key is gone (e.g. after a restore), the token reads as null and the app pairs again.
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("gohigh_secure", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    @Synchronized
    override fun read(): String? {
        val data = prefs.getString(K_DATA, null) ?: return null
        val iv = prefs.getString(K_IV, null) ?: return null
        return runCatching {
            val c = Cipher.getInstance(TRANSFORMATION)
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(c.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrNull()
    }

    @Synchronized
    override fun write(token: String?) {
        if (token == null) {
            prefs.edit(commit = true) { remove(K_DATA); remove(K_IV) }
            return
        }
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, key())
        val enc = c.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit(commit = true) {
            putString(K_DATA, Base64.encodeToString(enc, Base64.NO_WRAP))
            putString(K_IV, Base64.encodeToString(c.iv, Base64.NO_WRAP))
        }
    }

    private companion object {
        const val ALIAS = "gohigh_device_token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val K_DATA = "token"
        const val K_IV = "iv"
    }
}

/**
 * Who is signed in. The token comes from pairing (WebView login → /api/mobile/pair); a 401 marks the
 * session expired until the next pairing. In demo mode the app is always "signed in" (FakeBackend answers).
 */
class Session(
    private val tokens: TokenStore,
    private val prefs: SharedPreferences,
    private val demo: () -> Boolean,
) {
    private val _status = MutableStateFlow(compute())
    val status: StateFlow<AuthStatus> = _status.asStateFlow()

    /** A device token is stored (it may still be revoked on the server). */
    val isPaired: Boolean get() = tokens.read() != null

    val user: ApiUser?
        get() = prefs.getString(K_USER, null)?.let { runCatching { ApiJson.decodeFromString(ApiUser.serializer(), it) }.getOrNull() }
            ?: if (demo()) ApiUser("u1", "Paul Demo", "paul@gohigh.app", "admin") else null

    val deviceId: String? get() = prefs.getString(K_DEVICE, null)

    fun token(): String? = if (demo()) DEMO_TOKEN else tokens.read()

    fun signIn(resp: PairResponse) {
        tokens.write(resp.token)
        prefs.edit(commit = true) {
            putString(K_USER, ApiJson.encodeToString(ApiUser.serializer(), resp.user))
            putString(K_DEVICE, resp.deviceId)
            putBoolean(K_EXPIRED, false)
        }
        refresh()
    }

    /** The server said 401: keep the user visible, ask for a new sign-in. */
    fun markExpired() {
        if (demo() || !isPaired) return
        prefs.edit { putBoolean(K_EXPIRED, true) }
        refresh()
    }

    fun signOut() {
        tokens.write(null)
        prefs.edit(commit = true) { clear() }
        refresh()
    }

    fun refresh() {
        _status.value = compute()
    }

    private fun compute(): AuthStatus = when {
        demo() -> AuthStatus.ACTIVE
        tokens.read() == null -> if (prefs.getBoolean(K_EXPIRED, false)) AuthStatus.EXPIRED else AuthStatus.SIGNED_OUT
        prefs.getBoolean(K_EXPIRED, false) -> AuthStatus.EXPIRED
        else -> AuthStatus.ACTIVE
    }

    private companion object {
        const val DEMO_TOKEN = "ghm_demo"
        const val K_USER = "user"
        const val K_DEVICE = "device_id"
        const val K_EXPIRED = "expired"
    }
}
