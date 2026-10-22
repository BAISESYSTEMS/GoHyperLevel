import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { HttpError, bad, html, notFound, num, str, type Ctx } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { id, now, sha256 } from '../core/util.js';
import { getBranding } from './agency.js';

/**
 * Distribution of the native Android app (outside the Play Store):
 * - admins upload a signed APK (PUT /api/mobile/app, raw bytes) – stored in the data folder with SHA-256;
 * - `/android` is the public download page (German, white-label, QR code rendered server-side),
 *   `/downloads/gohigh.apk` the latest file, `GET /api/mobile/app` its metadata (the app's update check);
 * - `/.well-known/assetlinks.json` verifies Android App Links for the release certificate, so links
 *   to this server open in the app.
 */

/** Package name of the open-source build (android/app/build.gradle.kts); your own build sets PGHL_ANDROID_PACKAGE or the agency setting. */
export const ANDROID_PACKAGE = 'org.gohigh.android';
const CERT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_APK = 200 * 1024 * 1024;
const KEEP_FILES = 3;
const APK_TYPE = 'application/vnd.android.package-archive';

interface MobileAppSettings {
  cert_sha256: string;
  package_name: string;
  min_supported_code: number;
}

/** "51:33:…" or "513342…" (64 hex) → upper-case with colons; empty string when invalid. */
export function normalizeFingerprint(v: unknown): string {
  const hex = String(v ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 64) return '';
  const out = hex.match(/.{2}/g)!.join(':');
  return CERT_RE.test(out) ? out : '';
}

export function mobileAppSettings(app: App): MobileAppSettings {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'mobile_app');
  const s = row ? JSON.parse(row.value) : {};
  return { cert_sha256: String(s.cert_sha256 ?? ''), package_name: String(s.package_name ?? ''), min_supported_code: Math.max(0, Math.round(Number(s.min_supported_code) || 0)) };
}

/**
 * Fingerprints App Links trust: agency setting, else PGHL_ANDROID_CERT_SHA256 (comma-separated). Nothing is
 * trusted by default – every self-hoster signs the app with their own key.
 */
export function certFingerprints(app: App): string[] {
  const raw = mobileAppSettings(app).cert_sha256 || process.env.PGHL_ANDROID_CERT_SHA256 || '';
  return [...new Set(raw.split(/[\s,;]+/).map(normalizeFingerprint).filter(Boolean))];
}

/** Package name App Links name: agency setting, else PGHL_ANDROID_PACKAGE, else the open-source default. */
export function androidPackage(app: App): string {
  const env = String(process.env.PGHL_ANDROID_PACKAGE ?? '').trim();
  return mobileAppSettings(app).package_name || (PACKAGE_RE.test(env) ? env : ANDROID_PACKAGE);
}

/** assetlinks.json: empty until a signing certificate is configured (then App Links verify for that build). */
export function assetLinks(app: App) {
  const certs = certFingerprints(app);
  if (!certs.length) return [];
  return [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: androidPackage(app), sha256_cert_fingerprints: certs } }];
}

/**
 * Whether a request may send a large raw body (an app binary) – a signed-in admin or an agency write key, checked from the
 * headers before the bytes are read (and again by the normal auth). Shared with modules/desktop-app.ts.
 */
export function mayUploadRaw(app: App, req: any, cookies: Record<string, string>): boolean {
  const bearer = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
  try {
    if (bearer?.startsWith('pghla_')) return !!app.db.get(`SELECT id FROM agency_api_keys WHERE key_hash = ? AND scope = 'write'`, sha256(bearer));
    const sid = cookies[SESSION_COOKIE];
    if (!sid || bearer) return false;
    return app.db.get(`SELECT u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(sid), now())?.role === 'admin';
  } catch {
    return false;
  }
}

export const mobileAppModule: Module = {
  name: 'mobile-app',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE mobile_app_releases (
        id TEXT PRIMARY KEY, version_code INTEGER NOT NULL, version_name TEXT NOT NULL, changelog TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, file TEXT NOT NULL, min_supported_code INTEGER NOT NULL DEFAULT 0,
        uploaded_by TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX mobile_app_releases_code ON mobile_app_releases(version_code);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'mobile-app');
    const latest = () => db.get('SELECT * FROM mobile_app_releases ORDER BY version_code DESC, created_at DESC LIMIT 1');
    const apkUrl = () => `${app.baseUrl()}/downloads/gohigh.apk`;
    const info = (r = latest()) =>
      r
        ? {
            version_code: Number(r.version_code),
            version_name: r.version_name,
            apk_url: apkUrl(),
            sha256: r.sha256,
            size: Number(r.size),
            changelog: r.changelog,
            min_supported_code: Math.max(Number(r.min_supported_code ?? 0), mobileAppSettings(app).min_supported_code),
            uploaded_at: r.created_at,
            page_url: `${app.baseUrl()}/android`,
          }
        : null;
    app.services.mobileAppInfo = () => info();

    /**
     * The upload's body is read raw (up to 200 MB) – only for a signed-in admin or an agency
     * write key, checked here before the bytes are read (and again by the normal auth).
     */
    const uploader = (req: any, cookies: Record<string, string>) => mayUploadRaw(app, req, cookies);
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'PUT' && path === '/api/mobile/app' && uploader(req, cookies) ? MAX_APK : prevLimit?.(method, path, req, cookies);

    router.put('/api/mobile/app', 'admin', (ctx: Ctx) => {
      if (ctx.via === 'app') throw new HttpError(403, 'Hochladen nur im Browser oder mit einem Agentur-Schlüssel');
      const buf = ctx.rawBuffer;
      if (!buf?.length) throw bad('APK fehlt (Datei als Rohdaten im Body, content-type: application/vnd.android.package-archive)');
      // An APK is a ZIP archive.
      if (buf.length < 1024 || buf.readUInt32LE(0) !== 0x04034b50) throw bad('Das ist keine APK-Datei');
      const code = Math.round(num(ctx.req.headers['x-version-code'], 0));
      if (!(code >= 1 && code <= 2_100_000_000)) throw bad('x-version-code fehlt (ganze Zahl ≥ 1)');
      const name = str(ctx.req.headers['x-version-name'], 'x-version-name', { required: true, max: 50 });
      let changelog = '';
      try {
        changelog = decodeURIComponent(String(ctx.req.headers['x-changelog'] ?? '').replace(/\+/g, ' ')).trim().slice(0, 5000);
      } catch {
        throw bad('x-changelog bitte URL-kodiert senden');
      }
      const cur = latest();
      if (cur && code < Number(cur.version_code)) throw bad(`Versionscode ${code} ist älter als die aktuelle Version (${cur.version_code})`);
      const minCode = Math.max(0, Math.round(num(ctx.req.headers['x-min-supported-code'], 0)));
      mkdirSync(dir, { recursive: true });
      const file = `gohigh-${code}-${id(8)}.apk`;
      writeFileSync(join(dir, file), buf);
      const row = {
        id: id(),
        version_code: code,
        version_name: name,
        changelog,
        sha256: createHash('sha256').update(buf).digest('hex'),
        size: buf.length,
        file,
        min_supported_code: Math.min(minCode, code),
        uploaded_by: ctx.user?.id ?? null,
        created_at: now(),
      };
      db.tx(() => {
        // The same version code again replaces that build.
        for (const old of db.all('SELECT id, file FROM mobile_app_releases WHERE version_code = ?', code)) {
          rmSync(join(dir, old.file), { force: true });
          db.run('DELETE FROM mobile_app_releases WHERE id = ?', old.id);
        }
        db.insert('mobile_app_releases', row);
        // Only the newest few files stay on disk; older rows remain as history.
        for (const old of db.all(`SELECT id, file FROM mobile_app_releases WHERE file != '' ORDER BY version_code DESC, created_at DESC LIMIT -1 OFFSET ${KEEP_FILES}`)) {
          rmSync(join(dir, old.file), { force: true });
          db.run(`UPDATE mobile_app_releases SET file = '' WHERE id = ?`, old.id);
        }
      });
      return { ...info(row)!, id: row.id, name: `App ${name} (${code})` };
    });

    router.get('/api/mobile/app', 'public', () => {
      const i = info();
      if (!i) throw notFound('Noch keine App hochgeladen');
      return i;
    });
    router.get('/api/mobile/app/releases', 'admin', () =>
      db.all('SELECT id, version_code, version_name, changelog, sha256, size, min_supported_code, created_at, file != \'\' AS available FROM mobile_app_releases ORDER BY version_code DESC, created_at DESC LIMIT 50'),
    );

    router.get('/downloads/gohigh.apk', 'public', () => {
      const r = latest();
      const path = r?.file ? join(dir, r.file) : '';
      if (!r || !path || !existsSync(path)) throw notFound('Noch keine App hochgeladen');
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': APK_TYPE,
          'content-disposition': 'attachment; filename="gohigh.apk"',
          'content-length': String(statSync(path).size),
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'x-apk-sha256': r.sha256,
          'x-apk-version': `${r.version_name} (${r.version_code})`,
        },
        body: readFileSync(path),
      };
    });

    router.get('/.well-known/assetlinks.json', 'public', () => ({
      __raw: true,
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
      body: JSON.stringify(assetLinks(app)),
    }));

    router.get('/android', 'public', async () => {
      const b = getBranding(app);
      const r = info();
      const page = `${app.baseUrl()}/android`;
      const qr = await QRCode.toString(page, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } });
      const mb = r ? (r.size / 1024 / 1024).toFixed(1).replace('.', ',') : '';
      const logo = /^https?:\/\//.test(b.logo_url) ? `<img src="${escapeHtml(b.logo_url)}" alt="" style="max-height:44px;max-width:160px;border-radius:8px">` : `<span class="mark">${escapeHtml(b.name.slice(0, 1).toUpperCase())}</span>`;
      const body = `<div class="wrap">
  <div class="card">
    <div class="head">${logo}<div><h1>${escapeHtml(b.name)} fürs Handy</h1><p class="muted" style="margin:0">Die App für Android – Posteingang, Aufgaben, Termine, Deals und Zahlen aller Projekte.</p></div></div>
    ${
      r
        ? `<div class="grid">
      <div>
        <p><a class="btn big" href="/downloads/gohigh.apk" download>App herunterladen</a></p>
        <p class="muted small">Version ${escapeHtml(r.version_name)} (${r.version_code}) · ${mb} MB · ${escapeHtml(new Date(r.uploaded_at).toLocaleDateString('de-DE'))}</p>
        ${r.changelog ? `<h2>Neu in dieser Version</h2><p class="pre">${escapeHtml(r.changelog)}</p>` : ''}
      </div>
      <div class="qr" aria-label="QR-Code zu dieser Seite">${qr}<p class="muted small">Mit der Handy-Kamera scannen</p></div>
    </div>`
        : `<p class="ok">Die App ist noch nicht verfügbar – schau bald wieder vorbei.</p>`
    }
    <h2>So installierst du die App</h2>
    <ol>
      <li>Diese Seite auf dem Android-Handy öffnen (QR-Code scannen) und <b>App herunterladen</b> tippen.</li>
      <li>Die geladene Datei <code>gohigh.apk</code> öffnen. Fragt Android nach, für den Browser <b>„Apps aus dieser Quelle zulassen“</b> einschalten und zurück.</li>
      <li><b>Installieren</b> tippen. Warnt Google Play Protect, über „Weitere Details“ → „Trotzdem installieren“ bestätigen – die App kommt direkt von uns, nicht aus dem Play Store.</li>
      <li>App öffnen und mit deinen gewohnten Zugangsdaten anmelden. Abmelden oder ein verlorenes Handy sperren: im Browser unter <b>Einstellungen → Mein Konto → Geräte (App)</b>.</li>
    </ol>
    <p class="muted small">Updates meldet die App selbst. ${r ? `Prüfsumme (SHA-256): <code class="sum">${escapeHtml(r.sha256)}</code>` : ''}</p>
  </div>
</div>`;
      const res = html(
        publicPage({
          title: `${b.name} – App für Android`,
          description: `${b.name} als App für Android herunterladen`,
          color: b.color,
          body,
          head: `<style>
.head{display:flex;gap:14px;align-items:center;margin-bottom:18px}.mark{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--brand);color:#fff;font-weight:700;font-size:22px;flex:none}
.grid{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}.grid>div{flex:1 1 240px}.qr{text-align:center;max-width:220px}.qr svg{width:180px;height:180px;display:block;margin:0 auto}
.btn.big{font-size:18px;padding:14px 26px}.small{font-size:13px}.pre{white-space:pre-line}ol{padding-left:20px}li{margin:6px 0}code{background:#f3f4f6;padding:1px 5px;border-radius:5px}.sum{word-break:break-all;font-size:12px}
</style>`,
        }),
      );
      res.headers['content-security-policy'] = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      res.headers['cache-control'] = 'no-cache';
      return res;
    });

    // --- agency settings: App Links certificate, package, minimum version ----------------
    const settingsOut = () => {
      const s = mobileAppSettings(app);
      return { ...s, effective_cert_sha256: certFingerprints(app), effective_package_name: androidPackage(app), env_cert: !!process.env.PGHL_ANDROID_CERT_SHA256, latest: info() };
    };
    router.get('/api/agency/mobile-app', 'admin', settingsOut);
    router.put('/api/agency/mobile-app', 'admin', (ctx) => {
      const cur = mobileAppSettings(app);
      const b = ctx.body ?? {};
      if (b.cert_sha256 !== undefined) {
        const parts = String(b.cert_sha256 ?? '').split(/[\s,;]+/).filter(Boolean);
        const list = parts.map(normalizeFingerprint);
        if (list.some((f) => !f)) throw bad('Zertifikat-Fingerabdruck: 32 Bytes SHA-256 als Hex, z. B. AB:CD:EF:…');
        cur.cert_sha256 = list.join(',');
      }
      if (b.package_name !== undefined) {
        const p = String(b.package_name ?? '').trim();
        if (p && !PACKAGE_RE.test(p)) throw bad('Paketname ungültig (z. B. de.deinefirma.crm)');
        cur.package_name = p;
      }
      if (b.min_supported_code !== undefined) cur.min_supported_code = Math.max(0, Math.round(num(b.min_supported_code, 0)));
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'mobile_app', JSON.stringify(cur));
      return settingsOut();
    });
  },
};
