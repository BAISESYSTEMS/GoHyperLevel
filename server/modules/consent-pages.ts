import type { App, LocationRow, Module } from '../core/app.js';
import { bad, html, redirect, type Ctx, type RawResult } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml, render } from '../core/template.js';
import { now, safeEqual } from '../core/util.js';
import { getContact, logActivity, type Contact } from '../services/contacts.js';
import { CHANNEL_LABEL, PURPOSE_LABEL, STATUS_LABEL, deriveChannel, prefToken, verifyDoi, type ConsentChannel, type ConsentPurpose } from '../services/consent-model.js';
import { confirmDoi, eventsOf, getDoi, grantConsent, mailVars, metaOf, prefsUrl, revokeConsent, settingsOf } from '../services/consent.js';

/**
 * The public pages of the consent ledger: the Double-Opt-in confirmation (a page with a button – the link itself never confirms,
 * mail scanners open links) and the preference centre every marketing mail links to (per channel and purpose in or out, "alle
 * abbestellen"). Both stand on signed links, show as little as possible and are not indexed.
 */

const CSP = "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

function shell(loc: LocationRow, title: string, inner: string, status = 200): RawResult {
  const color = String(loc.settings?.branding?.color ?? '');
  const head = loc.logo_url && /^https?:\/\//i.test(loc.logo_url) ? `<img src="${escapeHtml(loc.logo_url)}" alt="" style="max-height:44px;margin-bottom:12px">` : `<p class="muted" style="margin:0 0 6px">${escapeHtml(loc.name)}</p>`;
  const r = html(publicPage({ title, color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined, body: `<div class="wrap" style="max-width:560px"><div class="card">${head}${inner}</div></div>` }), status);
  r.headers['cache-control'] = 'no-store';
  r.headers['referrer-policy'] = 'no-referrer';
  r.headers['x-robots-tag'] = 'noindex, nofollow';
  r.headers['content-security-policy'] = CSP;
  return r;
}

const plain = (title: string, text: string, status = 200): RawResult =>
  ((r) => ((r.headers['cache-control'] = 'no-store'), (r.headers['x-robots-tag'] = 'noindex'), (r.headers['content-security-policy'] = CSP), r))(html(publicPage({ title, body: `<div class="wrap"><div class="card"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(text)}</p></div></div>` }), status));

const PHRASE: Record<string, string> = {
  newsletter: 'den Newsletter',
  marketing: 'Angebote und Neuigkeiten',
  webinar: 'Hinweise zu Webinaren',
  community: 'Nachrichten aus der Community',
};

export const consentPagesModule: Module = {
  name: 'consent-pages',
  register(app: App) {
    const { db, router } = app;

    // --- Double-Opt-in --------------------------------------------------------------------------------------------------
    const doiOf = (token: string) => {
      const v = verifyDoi(app.config.secret, token);
      const d = v ? getDoi(app, v.id) : undefined;
      return v && d ? { v, d } : undefined;
    };
    const pageVars = (d: NonNullable<ReturnType<typeof getDoi>>) => {
      const c = getContact(app, d.location_id, d.contact_id);
      return c ? mailVars(app, d, c) : undefined;
    };

    router.get('/consent/confirm/:token', 'public', (ctx) => {
      const f = doiOf(ctx.params.token);
      if (!f) return plain('Link ungültig', 'Dieser Bestätigungslink ist nicht gültig.', 404);
      const { d, v } = f;
      const loc = app.location(d.location_id)!;
      const s = settingsOf(app, d.location_id).doi.page;
      const vars = pageVars(d) ?? { location: { name: loc.name }, purpose_text: 'Nachrichten' };
      if (d.status === 'confirmed') return shell(loc, s.success_title, `<h1>${escapeHtml(render(s.success_title, vars))}</h1><p>${escapeHtml(render(s.success_text, vars))}</p>`);
      if (d.status === 'cancelled') return shell(loc, 'Nicht mehr gültig', '<h1>Nicht mehr gültig</h1><p class="muted">Diese Anfrage wurde zurückgezogen. Es ist keine Bestätigung nötig.</p>', 410);
      if (v.expired || d.status === 'expired' || Date.parse(d.expires_at) <= Date.now()) return shell(loc, s.expired_title, `<h1>${escapeHtml(render(s.expired_title, vars))}</h1><p class="muted">${escapeHtml(render(s.expired_text, vars))}</p>`, 410);
      return shell(loc, s.title, `<h1>${escapeHtml(render(s.title, vars))}</h1><p>${escapeHtml(render(s.text, vars))}</p>
<form method="post" action="/consent/confirm/${escapeHtml(encodeURIComponent(ctx.params.token))}" style="margin-top:18px"><button type="submit" style="width:100%">${escapeHtml(render(s.button, vars))}</button></form>
<p class="muted" style="font-size:12px;margin-bottom:0">Du hast dich nicht angemeldet? Dann schließe dieses Fenster – ohne deine Bestätigung passiert nichts.</p>`);
    });

    router.post('/consent/confirm/:token', 'public', (ctx) => {
      const f = doiOf(ctx.params.token);
      if (!f) return plain('Link ungültig', 'Dieser Bestätigungslink ist nicht gültig.', 404);
      const loc = app.location(f.d.location_id)!;
      const s = settingsOf(app, f.d.location_id).doi.page;
      const vars = pageVars(f.d) ?? { location: { name: loc.name }, purpose_text: 'Nachrichten' };
      if (f.v.expired) return shell(loc, s.expired_title, `<h1>${escapeHtml(render(s.expired_title, vars))}</h1><p class="muted">${escapeHtml(render(s.expired_text, vars))}</p>`, 410);
      const r = confirmDoi(app, f.d.id, metaOf(ctx));
      if (!r.ok) {
        return r.reason === 'expired'
          ? shell(loc, s.expired_title, `<h1>${escapeHtml(render(s.expired_title, vars))}</h1><p class="muted">${escapeHtml(render(s.expired_text, vars))}</p>`, 410)
          : shell(loc, 'Nicht mehr gültig', '<h1>Nicht mehr gültig</h1><p class="muted">Diese Anfrage wurde zurückgezogen. Es ist keine Bestätigung nötig.</p>', 410);
      }
      if (s.redirect_url && !r.already) return redirect(s.redirect_url, 303);
      return shell(loc, s.success_title, `<h1>${escapeHtml(render(s.success_title, vars))}</h1><p>${escapeHtml(render(s.success_text, vars))}</p>`);
    });

    // --- preference centre ----------------------------------------------------------------------------------------------
    const lookup = (ctx: Ctx): { c: Contact; loc: LocationRow } | undefined => {
      const row = db.get<{ id: string; location_id: string }>('SELECT id, location_id FROM contacts WHERE id = ?', ctx.params.id);
      if (!row || !safeEqual(prefToken(app.config.secret, row.id), ctx.params.token)) return undefined;
      const c = getContact(app, row.location_id, row.id);
      const loc = app.location(row.location_id);
      return c && loc ? { c, loc } : undefined;
    };

    /** The rows the page offers: advertising purposes of e-mail (always), SMS and WhatsApp (when there is a number), plus whatever the person already has. */
    const rows = (c: Contact): [ConsentChannel, ConsentPurpose][] => {
      const out: [ConsentChannel, ConsentPurpose][] = [];
      const events = eventsOf(app, c.id);
      const has = (ch: string, p: string) => events.some((e) => e.channel === ch && (e.purpose === p || e.purpose === '*') && e.action !== 'legacy');
      if (c.email) for (const p of ['newsletter', 'marketing', 'webinar', 'community'] as const) if (p === 'newsletter' || p === 'marketing' || has('email', p)) out.push(['email', p]);
      if (c.phone) for (const ch of ['sms', 'whatsapp'] as const) out.push([ch, 'marketing']);
      return out;
    };
    const maskMail = (e: string) => e.replace(/^(.).*?(@.)(.*?)(\.[^.]+)$/, (_m, a, b, _mid, tld) => `${a}•••${b}•••${tld}`);

    const prefPage = (ctx: Ctx, c: Contact, loc: LocationRow, note = ''): RawResult => {
      const events = eventsOf(app, c.id);
      const list = rows(c);
      const base = `/consent/p/${encodeURIComponent(c.id)}/${encodeURIComponent(ctx.params.token)}`;
      const body = list
        .map(([ch, p]) => {
          const st = deriveChannel(events, ch, { dnd: !!c.dnd }).purposes[p];
          const on = st.status === 'confirmed';
          const hint = st.status === 'pending' ? ' <span class="muted">(Bestätigung per E-Mail noch offen)</span>' : '';
          return `<label class="check" style="margin:10px 0"><input type="checkbox" name="p__${ch}__${p}" value="1"${on || st.status === 'pending' ? ' checked' : ''}> <span><strong>${escapeHtml(PURPOSE_LABEL[p])}</strong> per ${escapeHtml(CHANNEL_LABEL[ch])}${hint}</span></label>`;
        })
        .join('');
      const inner = `<h1>Deine Einstellungen</h1>
<p class="muted">${escapeHtml(c.first_name ? `Hallo ${c.first_name}, hier` : 'Hier')} legst du fest, was du von ${escapeHtml(loc.name)} bekommst${c.email ? ` (${escapeHtml(maskMail(c.email))})` : ''}. Du kannst deine Einwilligung jederzeit mit Wirkung für die Zukunft ändern oder widerrufen.</p>
${note ? `<p class="ok">${escapeHtml(note)}</p>` : ''}
${c.dnd ? '<p class="muted"><strong>Aktuell bekommst du von uns keine Werbung</strong> (abgemeldet). Wenn du etwas wieder aktivierst, schicken wir dir wieder Nachrichten.</p>' : ''}
<form method="post" action="${escapeHtml(base)}">
${body || '<p class="muted">Es gibt nichts einzustellen – zu deinem Kontakt sind keine Kanäle gespeichert.</p>'}
<div class="row" style="margin-top:18px"><button type="submit" name="do" value="save">Speichern</button><button type="submit" name="do" value="none" class="btn secondary" style="background:#fff;color:#111827;border:1px solid #e5e7eb">Alles abbestellen</button></div>
</form>
<p class="muted" style="font-size:12px;margin-bottom:0">Service-Nachrichten zu deinen Aufträgen und Terminen (Rechnung, Terminbestätigung) bekommst du weiterhin – sie sind keine Werbung.</p>`;
      return shell(loc, 'Deine Einstellungen', inner);
    };

    router.get('/consent/p/:id/:token', 'public', (ctx) => {
      const f = lookup(ctx);
      if (!f) return plain('Link ungültig', 'Dieser Link ist nicht gültig.', 404);
      return prefPage(ctx, f.c, f.loc, ctx.query.get('saved') === '1' ? 'Gespeichert.' : ctx.query.get('none') === '1' ? 'Du bekommst keine Werbung mehr von uns.' : '');
    });

    router.post('/consent/p/:id/:token', 'public', (ctx) => {
      const f = lookup(ctx);
      if (!f) return plain('Link ungültig', 'Dieser Link ist nicht gültig.', 404);
      const { c, loc } = f;
      const back = `/consent/p/${encodeURIComponent(c.id)}/${encodeURIComponent(ctx.params.token)}`;
      const meta = metaOf(ctx);
      const source = { kind: 'preferences', label: 'Einstellungsseite in einer E-Mail' };
      if (ctx.body?.do === 'none') {
        db.run('UPDATE contacts SET dnd = 1, updated_at = ? WHERE id = ?', now(), c.id);
        revokeConsent(app, { locationId: loc.id, contactId: c.id, channel: 'all', source, meta, actor: 'contact' });
        logActivity(app, loc.id, c.id, 'contact.unsubscribed', 'Über die Einstellungsseite von allem abgemeldet');
        app.events.emit(loc.id, 'contact.unsubscribed', { contactId: c.id });
        return redirect(`${back}?none=1`, 303);
      }
      const events = eventsOf(app, c.id);
      const offered = rows(c);
      if (!offered.length) throw bad('Nichts zu speichern');
      for (const [ch, p] of offered) {
        const want = ctx.body?.[`p__${ch}__${p}`] === '1';
        const cur = deriveChannel(events, ch, { dnd: false }).purposes[p].status;
        if (want && cur !== 'confirmed' && cur !== 'pending') {
          // The link comes from a mail to this person: that is enough proof of the address, no second mail.
          const text = `Ich möchte ${loc.name} per ${CHANNEL_LABEL[ch]} ${PHRASE[p] ?? PURPOSE_LABEL[p]} schicken lassen.`;
          grantConsent(app, { locationId: loc.id, contactId: c.id, channel: ch, purposes: [p], source, text: { key: `preferences:${ch}:${p}`, text }, proofUrl: `${app.baseUrl()}/consent/p`, meta, actor: 'contact', clearDnd: true });
        } else if (!want && (cur === 'confirmed' || cur === 'pending')) {
          revokeConsent(app, { locationId: loc.id, contactId: c.id, channel: ch, purposes: [p], source, meta, actor: 'contact' });
        }
      }
      return redirect(`${back}?saved=1`, 303);
    });

    // The page after the unsubscribe link, with the way back (contacts module asks for it).
    app.services.consent.unsubscribedPage = (contactId: string): RawResult | undefined => {
      const row = db.get<{ id: string; location_id: string }>('SELECT id, location_id FROM contacts WHERE id = ?', contactId);
      const loc = row ? app.location(row.location_id) : undefined;
      if (!row || !loc) return undefined;
      return shell(loc, 'Abgemeldet', `<h1>Abgemeldet</h1><p class="muted">Du bekommst von uns keine Nachrichten mehr.</p><p><a class="btn secondary" href="/consent/p/${escapeHtml(encodeURIComponent(row.id))}/${prefToken(app.config.secret, row.id)}">Doch etwas behalten oder wieder anmelden</a></p>`);
    };

    /** Link for the footer of marketing mails ('' when the sub-account turned it off). */
    app.services.consent.footerPrefsUrl = (locationId: string, contactId: string): string => (settingsOf(app, locationId).footer_link ? prefsUrl(app, contactId) : '');
    void STATUS_LABEL;
  },
};
