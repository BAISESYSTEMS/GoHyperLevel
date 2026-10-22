import type { Module } from '../core/app.js';
import { HttpError, bad, html, notFound, str, text, type Ctx } from '../core/http.js';
import { escapeHtml, render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { verifyVisitor } from '../services/attribution.js';
import { finishOutbound, getAccount, recordOutbound, saveAccount, type ChannelAccount } from '../services/channel-kit.js';
import { getContact } from '../services/contacts.js';
import { fromB64u, generateVapidKeys, isPushEndpoint, sendWebPush, type VapidKeys } from '../services/webpush.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * Browser push to contacts: visitors of funnel pages can allow notifications (a small bell button;
 * funnel pages are sandboxed, so the opt-in runs in a popup on the app's own domain). The
 * subscription is linked to the contact through the attribution visitor id – right away or once the
 * visitor fills in a form. Workflow action „Push an Kontakt“ and channel `push` (API/MCP) send.
 * Own VAPID keys (private half sealed), delivery via services/webpush.ts.
 */

const CH = 'push';
const DEFAULTS = { button: 'Benachrichtigungen', title: 'Keine Neuigkeit verpassen', text: 'Wir schicken dir eine kurze Mitteilung, wenn es etwas Neues gibt. Abbestellen geht jederzeit in den Browser-Einstellungen.' };

export interface ContactPushInput {
  contactId: string;
  title?: string;
  body: string;
  url?: string;
  userId?: string | null;
  source?: string;
}

const SUBSCRIBE_JS = `(function(){
  var b=document.body, btn=document.getElementById('go'), st=document.getElementById('st');
  var loc=b.dataset.loc, key=b.dataset.key, attr=b.dataset.attr||'';
  function say(t,ok){st.textContent=t;st.className=ok?'ok':'';}
  function k(s){s=s.replace(/-/g,'+').replace(/_/g,'/');var r=atob(s+'==='.slice((s.length+3)%4)),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){btn.disabled=true;say('Dieser Browser unterstützt keine Benachrichtigungen (auf dem iPhone: erst „Zum Home-Bildschirm“).');return;}
  btn.onclick=function(){
    btn.disabled=true;say('Einen Moment …');
    navigator.serviceWorker.register('/push/'+loc+'/sw.js',{scope:'/push/'+loc+'/'}).then(function(reg){
      return Notification.requestPermission().then(function(p){
        if(p!=='granted')throw new Error('Benachrichtigungen wurden nicht erlaubt.');
        return reg.pushManager.getSubscription().then(function(s){return s||reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:k(key)});});
      });
    }).then(function(sub){
      return fetch('/api/public/push/'+loc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subscription:sub.toJSON(),attr:attr})});
    }).then(function(r){if(!r.ok)throw new Error('Speichern fehlgeschlagen ('+r.status+')');say('Fertig – du bekommst jetzt Benachrichtigungen. Du kannst dieses Fenster schließen.',true);setTimeout(function(){try{window.close();}catch(e){}},2500);})
    .catch(function(e){btn.disabled=false;say(e&&e.message?e.message:'Hat nicht geklappt.');});
  };
})();`;

const SW_JS = `self.addEventListener('push',function(e){var d={};try{d=e.data?e.data.json():{};}catch(x){d={body:e.data&&e.data.text()};}
e.waitUntil(self.registration.showNotification(d.title||'Neuigkeit',{body:d.body||'',icon:d.icon||undefined,tag:d.tag||undefined,data:{url:d.url||''}}));});
self.addEventListener('notificationclick',function(e){e.notification.close();var u=e.notification.data&&e.notification.data.url;if(u&&/^https:\\/\\//.test(u))e.waitUntil(clients.openWindow(u));});`;

export const contactPushModule: Module = {
  name: 'contact-push',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE contact_push_keys (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE contact_push_subs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, visitor_id TEXT NOT NULL DEFAULT '',
        endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT NOT NULL DEFAULT '', fails INTEGER NOT NULL DEFAULT 0,
        UNIQUE (location_id, endpoint)
      );
      CREATE INDEX contact_push_subs_contact ON contact_push_subs(contact_id);
      CREATE INDEX contact_push_subs_visitor ON contact_push_subs(location_id, visitor_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- VAPID keys: own pair for contacts (separate from the team's push), private half sealed ---
    let keys: VapidKeys;
    const row = db.get('SELECT * FROM contact_push_keys WHERE id = 1');
    if (row) keys = { publicKey: row.public_key, privateKey: openSecret(app, row.private_key) };
    else {
      keys = generateVapidKeys();
      db.run('INSERT INTO contact_push_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)', keys.publicKey, sealSecret(app, keys.privateKey), now());
    }
    const subject = () => {
      const admin = db.get(`SELECT email FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`);
      return process.env.PGHL_PUSH_CONTACT || (admin?.email ? `mailto:${admin.email}` : app.baseUrl().startsWith('https://') ? app.baseUrl() : 'mailto:push@example.com');
    };
    const conf = (a: ChannelAccount | undefined) => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(a?.config ?? {}).filter(([, v]) => typeof v === 'string' && v)) });
    const on = (a: ChannelAccount | undefined): a is ChannelAccount => !!a?.enabled;

    // --- settings ----------------------------------------------------------------------------
    const out = (loc: string) => {
      const a = getAccount(app, loc, CH);
      const c = conf(a);
      const n = db.get<{ all: number; linked: number }>('SELECT COUNT(*) AS "all", COUNT(contact_id) AS linked FROM contact_push_subs WHERE location_id = ?', loc)!;
      return { enabled: on(a), button: c.button, title: c.title, text: c.text, subscribers: n.all, linked: n.linked, subscribe_url: `${app.baseUrl()}/push/${loc}/subscribe` };
    };
    router.get('/api/settings/channels/push', 'location', (ctx) => out(ctx.locationId));
    router.put('/api/settings/channels/push', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const config: Record<string, string> = {};
      if (b.button !== undefined) config.button = str(b.button, 'Button-Text', { max: 40 });
      if (b.title !== undefined) config.title = str(b.title, 'Überschrift', { max: 80 });
      if (b.text !== undefined) config.text = str(b.text, 'Text', { max: 400 });
      saveAccount(app, ctx.locationId, CH, { config, enabled: b.enabled === undefined ? undefined : !!b.enabled });
      return out(ctx.locationId);
    });

    // --- public opt-in (popup on the app's own domain) ------------------------------------------
    const pushHeaders = { 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' };
    router.get('/push/:loc/subscribe', 'public', (ctx) => {
      const loc = app.location(ctx.params.loc);
      const a = loc ? getAccount(app, loc.id, CH) : undefined;
      if (!loc || !on(a)) return html('<!doctype html><meta charset="utf-8"><title>Nicht verfügbar</title><p style="font-family:system-ui;padding:24px">Benachrichtigungen sind hier nicht eingerichtet.</p>', 404);
      const c = conf(a);
      const attr = String(ctx.query.get('a') ?? '').slice(0, 200).replace(/[^\w.-]/g, '');
      const color = /^#[0-9a-f]{3,8}$/i.test(String(loc.settings?.branding?.color ?? '')) ? loc.settings.branding.color : '#2563eb';
      const r = html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f6f8;color:#1f2937;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.card{background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.08);padding:28px;max-width:420px;width:100%;text-align:center}
h1{font-size:20px;margin:8px 0}p{color:#4b5563;line-height:1.5}button{background:${color};color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:16px;font-weight:600;cursor:pointer;width:100%}
button:disabled{opacity:.6}#st{min-height:1.5em;margin-top:14px;font-size:14px;color:#b91c1c}#st.ok{color:#15803d}.bell{font-size:34px}
@media (prefers-color-scheme:dark){body{background:#111318;color:#e5e7eb}.card{background:#1b1e25}p{color:#9ca3af}}</style></head>
<body data-loc="${escapeHtml(loc.id)}" data-key="${escapeHtml(keys.publicKey)}" data-attr="${escapeHtml(attr)}"><main class="card"><div class="bell" aria-hidden="true">🔔</div><h1>${escapeHtml(c.title)}</h1><p>${escapeHtml(c.text)}</p>
<button id="go" type="button">Benachrichtigungen erlauben</button><div id="st" role="status"></div><p style="font-size:12px;margin-top:18px">${escapeHtml(loc.name)}</p></main>
<script src="/push/${escapeHtml(loc.id)}/subscribe.js"></script></body></html>`);
      Object.assign(r.headers, pushHeaders);
      return r;
    });
    router.get('/push/:loc/subscribe.js', 'public', () => {
      const r = text(SUBSCRIBE_JS, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=3600';
      return r;
    });
    router.get('/push/:loc/sw.js', 'public', () => {
      const r = text(SW_JS, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'no-cache';
      return r;
    });

    /** The browser's subscription; the visitor token (attribution) links it to the contact. */
    router.post('/api/public/push/:loc', 'public', (ctx) => {
      const loc = app.location(ctx.params.loc);
      if (!loc || !on(getAccount(app, loc.id, CH))) throw notFound();
      const s = ctx.body?.subscription ?? {};
      const endpoint = str(s.endpoint, 'endpoint', { required: true, max: 1000 });
      const p256dh = str(s.keys?.p256dh, 'p256dh', { required: true, max: 200 });
      const auth = str(s.keys?.auth, 'auth', { required: true, max: 100 });
      if (!isPushEndpoint(endpoint)) throw bad('Unbekannter Push-Dienst');
      const pk = fromB64u(p256dh);
      if (pk.length !== 65 || pk[0] !== 4 || fromB64u(auth).length < 16) throw bad('Ungültige Schlüssel');
      const vid = verifyVisitor(app.config.secret, ctx.body?.attr);
      let contactId: string | null = null;
      if (vid) {
        try {
          contactId = db.get('SELECT contact_id FROM attribution_visitors WHERE location_id = ? AND visitor_id = ?', loc.id, vid)?.contact_id ?? null;
        } catch {
          contactId = null; // attribution module missing
        }
      }
      if (db.get<{ n: number }>('SELECT COUNT(*) n FROM contact_push_subs WHERE location_id = ?', loc.id)!.n > 100_000) throw new HttpError(429, 'Zu viele Anmeldungen');
      db.run(
        `INSERT INTO contact_push_subs (id, location_id, contact_id, visitor_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, visitor_id = CASE WHEN excluded.visitor_id != '' THEN excluded.visitor_id ELSE contact_push_subs.visitor_id END,
           contact_id = COALESCE(excluded.contact_id, contact_push_subs.contact_id), fails = 0, last_error = ''`,
        id(), loc.id, contactId, vid, endpoint, p256dh, auth, String(ctx.req.headers['user-agent'] ?? '').slice(0, 200), now(),
      );
      return { ok: true, linked: !!contactId };
    });
    router.post('/api/public/push/:loc/unsubscribe', 'public', (ctx) => {
      db.run('DELETE FROM contact_push_subs WHERE location_id = ? AND endpoint = ?', ctx.params.loc, str(ctx.body?.endpoint, 'endpoint', { required: true, max: 1000 }));
      return { ok: true };
    });

    // A visitor who allowed push and later fills in a form becomes reachable as that contact.
    app.services.attributionHooks = [
      ...(app.services.attributionHooks ?? []),
      { onLink: (x: { locationId: string; contactId: string; visitorId: string }) => x.visitorId && db.run('UPDATE contact_push_subs SET contact_id = ? WHERE location_id = ? AND visitor_id = ? AND contact_id IS NULL', x.contactId, x.locationId, x.visitorId) },
    ];

    // The bell on funnel pages (sandboxed: the popup escapes the sandbox; the visitor token rides along).
    app.services.pageVisit = [
      ...(app.services.pageVisit ?? []),
      (_ctx: Ctx, funnel: any, _page: any, page: string) => {
        const a = getAccount(app, funnel.location_id, CH);
        if (!on(a)) return page;
        const c = conf(a);
        const href = `${app.baseUrl()}/push/${funnel.location_id}/subscribe`;
        const bell = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" class="pghl-push" onclick="if(window.pghlAttr&&this.href.indexOf('?a=')<0)this.href+='?a='+encodeURIComponent(window.pghlAttr)" style="position:fixed;left:16px;bottom:16px;z-index:9998;background:#111827;color:#fff;border-radius:99px;padding:9px 14px;font:600 13px system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25)">🔔 ${escapeHtml(c.button)}</a>`;
        return page.includes('</body>') ? page.replace('</body>', `${bell}</body>`) : page + bell;
      },
    ];

    // --- sending ------------------------------------------------------------------------------
    const devicesOf = (loc: string, contactId: string) => db.all('SELECT * FROM contact_push_subs WHERE location_id = ? AND contact_id = ?', loc, contactId);
    const pushToContact = async (loc: string, input: ContactPushInput) => {
      const c = getContact(app, loc, input.contactId);
      if (!c) throw notFound('Kontakt nicht gefunden');
      const subs = devicesOf(loc, c.id);
      if (!subs.length) throw bad('Kontakt hat keine Benachrichtigungen erlaubt');
      const title = String(input.title || app.location(loc)?.name || 'Neuigkeit').trim().slice(0, 80);
      const body = String(input.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!body) throw bad('Nachricht fehlt');
      const url = String(input.url ?? '').trim();
      if (url && !/^https:\/\/\S{3,1000}$/.test(url)) throw bad('Link muss mit https:// beginnen');
      const rec = recordOutbound(app, loc, c, CH, body, { subject: title, userId: input.userId, source: input.source });
      const payload = JSON.stringify({ title, body, url, tag: `c${rec.id.slice(0, 8)}` });
      let sent = 0;
      let lastError = '';
      for (const s of subs) {
        const r = await sendWebPush(s as any, payload, keys, subject(), { urgency: 'normal' });
        if (r.gone) db.run('DELETE FROM contact_push_subs WHERE id = ?', s.id);
        else if (r.error) {
          lastError = r.error;
          db.run('UPDATE contact_push_subs SET last_error = ?, fails = fails + 1 WHERE id = ?', r.error.slice(0, 300), s.id);
        } else {
          sent++;
          db.run(`UPDATE contact_push_subs SET last_ok_at = ?, last_error = '', fails = 0 WHERE id = ?`, now(), s.id);
        }
      }
      if (!sent) return finishOutbound(app, rec, { ok: false, error: lastError ? `Push fehlgeschlagen: ${lastError}` : 'Kein Gerät erreichbar (Benachrichtigungen abbestellt)' });
      return { ...finishOutbound(app, rec, { ok: true, activity: `Push gesendet (${sent} ${sent === 1 ? 'Gerät' : 'Geräte'})` }), devices: sent };
    };
    app.services.contactPush = pushToContact;

    // For modules that push without an inbox entry (community: messages, mentions, broadcasts) and for the member app that
    // subscribes a device of a known contact: the public key for the browser, a sender (returns how many devices got it) and the
    // subscription itself with the same checks as the public route.
    app.services.contactPushRaw = {
      publicKey: keys.publicKey,
      async send(loc: string, contactId: string, p: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
        let sent = 0;
        const payload = JSON.stringify({ title: String(p.title).slice(0, 80), body: String(p.body).slice(0, 300), url: p.url ?? '', tag: p.tag ?? '' });
        for (const s of devicesOf(loc, contactId)) {
          const r = await sendWebPush(s as any, payload, keys, subject(), { urgency: 'normal' });
          if (r.gone) db.run('DELETE FROM contact_push_subs WHERE id = ?', s.id);
          else if (r.error) db.run('UPDATE contact_push_subs SET last_error = ?, fails = fails + 1 WHERE id = ?', r.error.slice(0, 300), s.id);
          else {
            sent++;
            db.run(`UPDATE contact_push_subs SET last_ok_at = ?, last_error = '', fails = 0 WHERE id = ?`, now(), s.id);
          }
        }
        return sent;
      },
      devices: (loc: string, contactId: string): number => devicesOf(loc, contactId).length,
      subscribe(loc: string, contactId: string, s: any, userAgent = '') {
        const endpoint = str(s?.endpoint, 'endpoint', { required: true, max: 1000 });
        const p256dh = str(s?.keys?.p256dh, 'p256dh', { required: true, max: 200 });
        const auth = str(s?.keys?.auth, 'auth', { required: true, max: 100 });
        if (!isPushEndpoint(endpoint)) throw bad('Unbekannter Push-Dienst');
        const pk = fromB64u(p256dh);
        if (pk.length !== 65 || pk[0] !== 4 || fromB64u(auth).length < 16) throw bad('Ungültige Schlüssel');
        if (db.get<{ n: number }>('SELECT COUNT(*) n FROM contact_push_subs WHERE location_id = ?', loc)!.n > 100_000) throw new HttpError(429, 'Zu viele Anmeldungen');
        db.run(
          `INSERT INTO contact_push_subs (id, location_id, contact_id, visitor_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)
           ON CONFLICT(location_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, contact_id = excluded.contact_id, fails = 0, last_error = ''`,
          id(), loc, contactId, endpoint, p256dh, auth, String(userAgent).slice(0, 200), now(),
        );
      },
      unsubscribe: (loc: string, contactId: string, endpoint: string) => db.run('DELETE FROM contact_push_subs WHERE location_id = ? AND contact_id = ? AND endpoint = ?', loc, contactId, String(endpoint).slice(0, 1000)).changes > 0,
    };

    app.services.messageChannels = {
      ...(app.services.messageChannels ?? {}),
      push: (ctx: Ctx) =>
        pushToContact(ctx.locationId, {
          contactId: str(ctx.body?.contact_id, 'Kontakt', { required: true }),
          title: str(ctx.body?.subject, 'Titel', { max: 80 }) || undefined,
          body: str(ctx.body?.body, 'Nachricht', { required: true, max: 1000 }),
          url: str(ctx.body?.url, 'Link', { max: 1000 }) || undefined,
          userId: ctx.user?.id,
          source: typeof ctx.body?.source === 'string' ? ctx.body.source.slice(0, 60) : undefined,
        }),
    };
    app.services.channelStatus = {
      ...(app.services.channelStatus ?? {}),
      push: (loc: string, c: { id: string }) => {
        const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM contact_push_subs WHERE location_id = ? AND contact_id = ?', loc, c.id)!.n;
        return { configured: n > 0 || on(getAccount(app, loc, CH)), reachable: n > 0, devices: n, reason: n ? undefined : 'Kontakt hat keine Benachrichtigungen erlaubt', limit: 300 };
      },
    };

    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      {
        entry: { key: 'contact_push', name: 'Web-Push an Kontakte', category: 'Marketing', icon: 'push', scope: 'location', setup: { location: 'settings/more-channels' }, description: 'Besucher von Funnels erlauben Browser-Benachrichtigungen; Workflow-Aktion „Push an Kontakt“.', credentials: 'Keine – nur einschalten unter Einstellungen → Weitere Kanäle (eigene VAPID-Schlüssel).', docs: 'docs/channels.md#web-push-to-contacts' },
        location: (_ctx: Ctx, loc: string) => {
          if (!on(getAccount(app, loc, CH))) return { status: 'info', detail: 'Aus' };
          const n = db.get<{ all: number; linked: number }>('SELECT COUNT(*) AS "all", COUNT(contact_id) AS linked FROM contact_push_subs WHERE location_id = ?', loc)!;
          return { status: 'ok', detail: `${n.all} Anmeldungen, ${n.linked} mit Kontakt` };
        },
      },
    ];

    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      push_contact: async (run: any, step: any, vars: Record<string, any>) => {
        const t = (s: unknown) => render(String(s ?? ''), vars);
        const r: any = await pushToContact(run.location_id, { contactId: run.contact_id, title: t(step.title) || undefined, body: t(step.body), url: t(step.url).trim() || undefined, source: 'Workflow' });
        if (r.status === 'failed') throw new Error(r.error);
        return `Push an ${r.devices} ${r.devices === 1 ? 'Gerät' : 'Geräte'}`;
      },
    };
  },
};
