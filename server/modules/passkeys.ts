import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now, token } from '../core/util.js';
import { WebAuthnError, verifyAssertion, verifyRegistration, type CredentialJSON } from '../services/webauthn.js';
import { getBranding } from './agency.js';
import type { HostInfo } from './login-policy.js';

/**
 * Passkeys (WebAuthn): register them under "Mein Konto", sign in without a password ("Mit Passkey
 * anmelden", discoverable credentials) or confirm a password login with one instead of the
 * authenticator code. A passkey belongs to the domain it was made on (rpId) – the main address,
 * the agency domain or a client's login domain.
 */

const CHALLENGE_TTL = 5 * 60_000;
const MAX_PER_USER = 20;

interface Rp {
  id: string;
  origin: string;
  name: string;
}

export const passkeysModule: Module = {
  name: 'passkeys',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE webauthn_credentials (
        id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
        transports TEXT NOT NULL DEFAULT '[]', rp_id TEXT NOT NULL, backed_up INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, last_used_at TEXT
      );
      CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id);
      CREATE TABLE webauthn_challenges (
        id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, user_id TEXT,
        rp_id TEXT NOT NULL, origin TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const lp = () => app.services.loginPolicy;

    const rpOf = (ctx: Ctx): Rp => {
      const h: HostInfo = lp().hostInfo(ctx);
      return { id: new URL(h.origin).hostname, origin: h.origin, name: getBranding(app).name };
    };
    const credsOf = (uid: string, rpId?: string) =>
      db.all(`SELECT * FROM webauthn_credentials WHERE user_id = ?${rpId ? ' AND rp_id = ?' : ''} ORDER BY created_at`, uid, ...(rpId ? [rpId] : []));
    const descriptor = (c: any) => ({ type: 'public-key', id: c.credential_id, transports: JSON.parse(c.transports || '[]') });

    function newChallenge(purpose: string, rp: Rp, userId: string | null) {
      const challenge = token(32);
      const cid = id(24);
      db.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', now());
      db.insert('webauthn_challenges', { id: cid, challenge, purpose, user_id: userId, rp_id: rp.id, origin: rp.origin, expires_at: new Date(Date.now() + CHALLENGE_TTL).toISOString() });
      return { challenge_id: cid, challenge };
    }
    /** Single use: gone after the first try, right or wrong. */
    function takeChallenge(cid: unknown, purpose: string, rp: Rp) {
      if (typeof cid !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(cid)) return undefined;
      const row = db.get('DELETE FROM webauthn_challenges WHERE id = ? RETURNING *', cid);
      if (!row || row.purpose !== purpose || row.expires_at < now() || row.rp_id !== rp.id || row.origin !== rp.origin) return undefined;
      return row;
    }

    /** Checks an assertion for a stored credential and bumps its counter. */
    function useCredential(cred: CredentialJSON, ch: any, rp: Rp, o: { userId?: string; requireUV?: boolean }) {
      const credId = typeof cred?.id === 'string' ? cred.id.replace(/=+$/, '') : '';
      const row = credId ? db.get('SELECT * FROM webauthn_credentials WHERE credential_id = ? AND rp_id = ?', credId, rp.id) : undefined;
      if (!row || (o.userId && row.user_id !== o.userId)) throw new WebAuthnError('Dieser Passkey ist hier nicht bekannt');
      const r = verifyAssertion(cred, { challenge: ch.challenge, origins: [rp.origin], rpId: rp.id, jwk: JSON.parse(row.public_key), alg: row.alg, storedSignCount: row.sign_count, requireUV: o.requireUV });
      if (r.userHandle && r.userHandle !== row.user_id) throw new WebAuthnError('Passkey gehört zu einem anderen Konto');
      db.run('UPDATE webauthn_credentials SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE id = ?', r.signCount, r.backedUp ? 1 : 0, now(), row.id);
      return { row, uv: r.uv };
    }

    app.services.passkeys = { count: (uid: string) => db.get<{ n: number }>('SELECT COUNT(*) n FROM webauthn_credentials WHERE user_id = ?', uid)!.n };

    // --- passkey as second factor (wraps the authenticator-code check of the twofactor module) -------
    const codeCheck = app.services.secondFactor as ((u: any, code: unknown, ctx?: Ctx) => 'ok' | 'needed' | 'invalid') | undefined;
    app.services.secondFactor = (u: any, code: unknown, ctx?: Ctx) => {
      const keys = ctx ? credsOf(u.id, rpOf(ctx).id) : [];
      const required = !!u.totp_enabled || (keys.length > 0 && !!lp()?.adminNeeds2fa(u));
      if (!required) return 'ok';
      const pk = ctx?.body?.passkey;
      if (pk && typeof pk === 'object' && keys.length && ctx) {
        const rp = rpOf(ctx);
        const ch = takeChallenge(pk.challenge_id, '2fa', rp);
        if (!ch || ch.user_id !== u.id) return 'invalid';
        try {
          useCredential(pk.credential, ch, rp, { userId: u.id });
          return 'ok';
        } catch {
          return 'invalid';
        }
      }
      if (u.totp_enabled) return codeCheck ? codeCheck(u, code, ctx) : 'invalid';
      return 'needed';
    };
    app.services.secondFactorOptions = (u: any, ctx: Ctx) => {
      const rp = rpOf(ctx);
      const keys = credsOf(u.id, rp.id);
      // Without a passkey here the answer stays as before ({needs_code: true}): the code is the only way.
      if (!keys.length) return {};
      const methods = [...(u.totp_enabled ? ['code'] : []), 'passkey'];
      const ch = newChallenge('2fa', rp, u.id);
      return { methods, passkey: { challenge_id: ch.challenge_id, options: { challenge: ch.challenge, rpId: rp.id, timeout: 120_000, userVerification: 'discouraged', allowCredentials: keys.map(descriptor) } } };
    };

    // --- register (Mein Konto) ---------------------------------------------------------------------
    router.get('/api/me/passkeys', 'user', (ctx) => {
      const here = rpOf(ctx).id;
      return credsOf(ctx.user!.id).map((c) => ({ id: c.id, name: c.name, created_at: c.created_at, last_used_at: c.last_used_at, backed_up: !!c.backed_up, rp_id: c.rp_id, here: c.rp_id === here }));
    });
    router.post('/api/me/passkeys/options', 'user', (ctx) => {
      if (ctx.via !== 'session') throw new HttpError(403, 'Passkeys gehen nur angemeldet im Browser');
      if (!lp().get().passkey) throw new HttpError(403, 'Passkeys sind von der Agentur ausgeschaltet');
      const u = ctx.user!;
      const rp = rpOf(ctx);
      if (credsOf(u.id).length >= MAX_PER_USER) throw bad(`Höchstens ${MAX_PER_USER} Passkeys je Konto`);
      const ch = newChallenge('register', rp, u.id);
      return {
        challenge_id: ch.challenge_id,
        options: {
          challenge: ch.challenge,
          rp: { id: rp.id, name: rp.name },
          user: { id: Buffer.from(u.id).toString('base64url'), name: u.email, displayName: u.name || u.email },
          pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: 'public-key', alg })),
          timeout: 120_000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
          excludeCredentials: credsOf(u.id, rp.id).map(descriptor),
        },
      };
    });
    router.post('/api/me/passkeys', 'user', (ctx) => {
      const u = ctx.user!;
      const rp = rpOf(ctx);
      const ch = takeChallenge(ctx.body.challenge_id, 'register', rp);
      if (!ch || ch.user_id !== u.id) throw bad('Die Anfrage ist abgelaufen – bitte noch einmal');
      let r;
      try {
        r = verifyRegistration(ctx.body.credential, { challenge: ch.challenge, origins: [rp.origin], rpId: rp.id });
      } catch (e) {
        throw bad((e as Error).message);
      }
      if (db.get('SELECT id FROM webauthn_credentials WHERE credential_id = ?', r.credentialId)) throw bad('Dieser Passkey ist schon registriert');
      const name = str(ctx.body.name, 'Name', { max: 60 }) || (r.backedUp ? 'Passkey (synchronisiert)' : 'Sicherheitsschlüssel');
      const row = { id: id(), credential_id: r.credentialId, user_id: u.id, name, public_key: JSON.stringify(r.jwk), alg: r.alg, sign_count: r.signCount, transports: JSON.stringify(r.transports), rp_id: rp.id, backed_up: r.backedUp ? 1 : 0, created_at: now() };
      db.insert('webauthn_credentials', row);
      app.services.audit?.({ ctx, action: 'passkey.create', summary: `${name} (${rp.id})` });
      return { id: row.id, name, rp_id: rp.id, backed_up: r.backedUp };
    });
    router.patch('/api/me/passkeys/:id', 'user', (ctx) => {
      const name = str(ctx.body.name, 'Name', { required: true, max: 60 });
      if (!db.run('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?', name, ctx.params.id, ctx.user!.id).changes) throw notFound();
      return { ok: true };
    });
    router.delete('/api/me/passkeys/:id', 'user', (ctx) => {
      const uid = ctx.user!.id;
      const row = db.get('SELECT * FROM webauthn_credentials WHERE id = ? AND user_id = ?', ctx.params.id, uid);
      if (!row) throw notFound();
      const u = db.get('SELECT password_set FROM users WHERE id = ?', uid);
      let identities = 0;
      try {
        identities = db.get<{ n: number }>('SELECT COUNT(*) n FROM auth_identities WHERE user_id = ?', uid)!.n;
      } catch {
        identities = 0;
      }
      if (!u?.password_set && !identities && credsOf(uid).length <= 1) throw bad('Das ist deine einzige Anmeldeart – lege erst ein Passwort fest');
      db.run('DELETE FROM webauthn_credentials WHERE id = ?', row.id);
      app.services.audit?.({ ctx, action: 'passkey.delete', summary: row.name });
      return { ok: true };
    });
    /** Lost device: the agency removes all passkeys of a login. */
    router.post('/api/users/:id/passkeys/reset', 'admin', (ctx) => {
      if (!db.get('SELECT id FROM users WHERE id = ?', ctx.params.id)) throw notFound();
      return { ok: true, removed: db.run('DELETE FROM webauthn_credentials WHERE user_id = ?', ctx.params.id).changes };
    });

    // --- sign in with a passkey -----------------------------------------------------------------------
    const hits = new Map<string, number[]>();
    const throttle = (ip: string) => {
      const t = Date.now();
      const list = (hits.get(ip) ?? []).filter((x) => t - x < 10 * 60_000);
      list.push(t);
      hits.set(ip, list);
      if (hits.size > 20_000) hits.clear();
      if (list.length > 60) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten');
    };
    const methodOn = (ctx: Ctx) => {
      const m = app.services.loginPolicy.get();
      const h = lp().hostInfo(ctx);
      const c = h.locationId ? m.clients[h.locationId] : undefined;
      if (!m.passkey || (c && !c.passkey)) throw new HttpError(403, 'Anmelden mit Passkey ist hier ausgeschaltet');
    };
    router.post('/api/auth/passkey/options', 'public', (ctx) => {
      throttle(ctx.ip);
      methodOn(ctx);
      const rp = rpOf(ctx);
      const ch = newChallenge('login', rp, null);
      return { challenge_id: ch.challenge_id, options: { challenge: ch.challenge, rpId: rp.id, timeout: 120_000, userVerification: 'preferred', allowCredentials: [] } };
    });
    router.post('/api/auth/passkey/login', 'public', (ctx) => {
      throttle(ctx.ip);
      methodOn(ctx);
      const rp = rpOf(ctx);
      const ch = takeChallenge(ctx.body.challenge_id, 'login', rp);
      if (!ch) throw new HttpError(400, 'Die Anfrage ist abgelaufen – bitte noch einmal');
      let used;
      try {
        used = useCredential(ctx.body.credential, ch, rp, {});
      } catch (e) {
        app.services.audit?.({ ctx, action: 'login.failed', summary: `Passkey: ${(e as Error).message}` });
        throw new HttpError(401, (e as Error).message);
      }
      const u = db.get('SELECT * FROM users WHERE id = ?', used.row.user_id);
      if (!u) throw new HttpError(401, 'Konto nicht gefunden');
      // With user verification (PIN/biometrics) a passkey alone is two factors.
      return lp().finish(ctx, u, { method: 'passkey', mfa: used.uv, next: ctx.body.next });
    });

    app.onTick(() => void db.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', now()));
  },
};
