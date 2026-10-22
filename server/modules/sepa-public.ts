import type { App, LocationRow, Module } from '../core/app.js';
import { HttpError, html, redirect, type Ctx, type RawResult } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { auditLog, limiter } from '../services/creator-kit.js';
import { metaOf } from '../services/consent.js';
import { sendToContact } from '../services/messaging.js';
import { creditorOf, settingsOf, signOnline, type MandateRow } from '../services/sepa-mandates.js';
import { mandateText, maskIban, textHash } from '../services/sepa-model.js';

/**
 * The public page of an online SEPA mandate: `/sepa/m/<token>` (random token per mandate, nothing else is reachable with it).
 * Shows the mandate text, takes holder, IBAN, optional BIC and address, and a tick; stores the proof the consent ledger uses
 * as well (time, IP network, browser fingerprint – services/consent.ts `metaOf`) plus the SHA-256 of the exact text agreed to.
 * Server-rendered, no script, not indexed.
 */

const CSP = "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

function shell(loc: LocationRow | undefined, title: string, inner: string, status = 200): RawResult {
  const color = String(loc?.settings?.branding?.color ?? '');
  const head = loc ? (loc.logo_url && /^https?:\/\//i.test(loc.logo_url) ? `<img src="${escapeHtml(loc.logo_url)}" alt="" style="max-height:44px;margin-bottom:12px">` : `<p class="muted" style="margin:0 0 6px">${escapeHtml(loc.name)}</p>`) : '';
  const style = `<style>.mandate{background:#f9fafb;border:1px solid var(--line);border-radius:10px;padding:16px;font-size:14px;margin:14px 0}.mandate p{margin:0 0 10px}.mandate p:last-child{margin:0}.small{font-size:12px}.check{min-height:44px}.check input{min-width:22px;min-height:22px}</style>`;
  const r = html(publicPage({ title, head: style, color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined, body: `<div class="wrap" style="max-width:620px"><div class="card">${head}${inner}</div></div>` }), status);
  r.headers['cache-control'] = 'no-store';
  r.headers['referrer-policy'] = 'no-referrer';
  r.headers['x-robots-tag'] = 'noindex, nofollow';
  r.headers['content-security-policy'] = CSP;
  return r;
}

const para = (text: string) => text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

export const sepaPublicModule: Module = {
  name: 'sepa-public',
  register(app: App) {
    const { db, router } = app;
    const tooMany = limiter(30, 10 * 60_000);

    const find = (t: string): MandateRow | undefined => (TOKEN.test(t) ? db.get<MandateRow>('SELECT * FROM sepa_mandates WHERE capture_token = ?', t) : undefined);
    const textOf = (m: MandateRow) => {
      const s = settingsOf(app, m.location_id);
      const cr = creditorOf(app, m.location_id, s);
      return mandateText({ creditor_name: cr.name, creditor_address: cr.address, creditor_id: cr.creditor_id, reference: m.reference, scheme: m.scheme, kind: m.kind, prenotify_days: s.prenotify_days });
    };

    const done = (loc: LocationRow | undefined, m: MandateRow) =>
      shell(loc, 'Mandat erteilt', `<h1>Danke – Mandat erteilt</h1><p>Dein SEPA-Lastschriftmandat für <strong>${escapeHtml(creditorOf(app, m.location_id).name)}</strong> ist gespeichert.</p>
<p class="muted">Mandatsreferenz: <strong>${escapeHtml(m.reference)}</strong><br>Konto: ${escapeHtml(maskIban(m.iban))}${m.signed_at ? `<br>Erteilt am: ${escapeHtml(m.signed_at.split('-').reverse().join('.'))}` : ''}</p>
<p class="muted small">Vor jedem Einzug bekommst du eine Vorabankündigung mit Betrag und Datum. Eine Kopie des Mandats haben wir dir per E-Mail geschickt, sofern eine Adresse hinterlegt ist.</p>`);

    const gone = (loc: LocationRow | undefined, title: string, text: string, status = 410) => shell(loc, title, `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(text)}</p>`, status);

    const form = (ctx: Ctx, m: MandateRow, loc: LocationRow, error = '', v: Record<string, string> = {}): RawResult => {
      const text = textOf(m);
      const c = m.contact_id ? db.get<any>('SELECT first_name, last_name, company, address, postal_code, city, country FROM contacts WHERE id = ?', m.contact_id) : undefined;
      const val = (k: string, fallback = '') => escapeHtml(v[k] ?? fallback);
      const field = (name: string, label: string, opts: { value?: string; required?: boolean; max?: number; auto?: string; hint?: string } = {}) =>
        `<label for="f-${name}">${escapeHtml(label)}${opts.required ? '' : ' <span class="muted">(optional)</span>'}</label><input id="f-${name}" name="${name}" value="${val(name, opts.value)}"${opts.required ? ' required' : ''} maxlength="${opts.max ?? 70}"${opts.auto ? ` autocomplete="${opts.auto}"` : ''} spellcheck="false">${opts.hint ? `<small class="muted">${escapeHtml(opts.hint)}</small>` : ''}`;
      const inner = `<h1>SEPA-Lastschriftmandat</h1>
<p class="muted">${escapeHtml(creditorOf(app, m.location_id).name || loc.name)} bittet dich um ein ${m.scheme === 'B2B' ? 'SEPA-Firmenlastschrift-Mandat' : 'SEPA-Lastschriftmandat'}. Lies den Text, trag dein Konto ein und bestätige unten.</p>
<div class="mandate">${para(text)}</div>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/sepa/m/${escapeHtml(encodeURIComponent(ctx.params.token))}">
<input type="hidden" name="text_hash" value="${escapeHtml(textHash(text))}">
${field('holder', 'Kontoinhaber', { value: m.holder, required: true, auto: 'name' })}
${field('iban', 'IBAN', { required: true, max: 42, auto: 'off', hint: 'z. B. DE89 3704 0044 0532 0130 00' })}
${field('bic', 'BIC', { max: 11, auto: 'off', hint: 'nur für Konten außerhalb des EWR nötig (z. B. Schweiz, Großbritannien)' })}
${field('street', 'Straße und Hausnummer', { value: c?.address ?? '', auto: 'street-address' })}
<div class="row"><div>${field('postal_code', 'PLZ', { value: c?.postal_code ?? '', max: 16, auto: 'postal-code' })}</div><div>${field('city', 'Ort', { value: c?.city ?? '', max: 35, auto: 'address-level2' })}</div><div>${field('country', 'Land (Kürzel)', { value: /^[A-Z]{2}$/i.test(c?.country ?? '') ? String(c.country).toUpperCase() : 'DE', max: 2, auto: 'country' })}</div></div>
${field('signed_place', 'Ort der Unterschrift', { value: c?.city ?? '', max: 60 })}
<label class="check" style="margin-top:16px"><input type="checkbox" name="agree" value="1" required> <span>Ich erteile dieses SEPA-Lastschriftmandat. Ich bin berechtigt, über das Konto zu verfügen, und meine Angaben stimmen.</span></label>
<p style="margin-top:16px"><button type="submit" style="width:100%;min-height:48px">Mandat verbindlich erteilen</button></p>
</form>
<p class="muted small">Als Nachweis speichern wir den Zeitpunkt, das IP-Netz (nicht die volle Adresse), einen Fingerabdruck des Browsers und eine Prüfsumme dieses Textes. Der Link gilt nur für dieses Mandat.</p>`;
      return shell(loc, 'SEPA-Lastschriftmandat', inner, error ? 400 : 200);
    };

    /** What the token may show: the form (pending), the confirmation (signed) or why it does not work any more. */
    const state = (m: MandateRow | undefined): { loc?: LocationRow; page?: RawResult } => {
      if (!m) return { page: gone(undefined, 'Link ungültig', 'Dieser Link ist nicht gültig.', 404) };
      const loc = app.location(m.location_id);
      if (!loc) return { page: gone(undefined, 'Link ungültig', 'Dieser Link ist nicht gültig.', 404) };
      if (m.status === 'active' || m.status === 'used' || m.status === 'final') return { loc, page: done(loc, m) };
      if (m.status !== 'pending') return { loc, page: gone(loc, 'Nicht mehr gültig', 'Dieses Mandat wurde zurückgezogen. Es ist nichts weiter zu tun.') };
      if (!m.capture_expires_at || m.capture_expires_at <= new Date().toISOString()) return { loc, page: gone(loc, 'Link abgelaufen', `Der Link ist abgelaufen. Bitte frag bei ${loc.name} nach einem neuen.`) };
      return { loc };
    };

    router.get('/sepa/m/:token', 'public', (ctx) => {
      const m = find(ctx.params.token);
      const s = state(m);
      return s.page ?? form(ctx, m!, s.loc!);
    });

    router.post('/sepa/m/:token', 'public', async (ctx) => {
      if (tooMany(ctx.ip || 'x')) return gone(undefined, 'Zu viele Versuche', 'Bitte warte ein paar Minuten und versuch es dann noch einmal.', 429);
      const m = find(ctx.params.token);
      const s = state(m);
      if (s.page) return s.page;
      const b = (ctx.body ?? {}) as Record<string, string>;
      const v = Object.fromEntries(['holder', 'iban', 'bic', 'street', 'postal_code', 'city', 'country', 'signed_place'].map((k) => [k, String(b[k] ?? '').slice(0, 100)]));
      if (b.agree !== '1' && (b.agree as unknown) !== true) return form(ctx, m!, s.loc!, 'Bitte bestätige das Mandat mit dem Häkchen.', v);
      if (String(b.text_hash ?? '') !== textHash(textOf(m!))) return form(ctx, m!, s.loc!, 'Der Mandatstext wurde inzwischen geändert – bitte lies ihn noch einmal und bestätige dann.', v);
      let signed: MandateRow;
      try {
        signed = signOnline(app, m!, v, { ...metaOf(ctx), url: `${app.baseUrl()}/sepa/m` });
      } catch (e) {
        if (e instanceof HttpError && e.status === 400) return form(ctx, m!, s.loc!, e.message, v);
        if (e instanceof HttpError && e.status === 409) return redirect(`/sepa/m/${encodeURIComponent(ctx.params.token)}`, 303);
        throw e;
      }
      auditLog(app, undefined, signed.location_id, 'sepa.mandate_signed', `SEPA-Mandat ${signed.reference} online erteilt (${maskIban(signed.iban)})`, signed.id, 'Kontoinhaber');
      if (signed.contact_id) {
        const c = db.get<{ first_name: string; email: string }>('SELECT first_name, email FROM contacts WHERE id = ?', signed.contact_id);
        if (c?.email) {
          const cr = creditorOf(app, signed.location_id);
          const body = `Hallo${c.first_name ? ` ${c.first_name}` : ''},\n\nvielen Dank – dein SEPA-Lastschriftmandat für ${cr.name} ist erteilt.\n\nMandatsreferenz: ${signed.reference}\nGläubiger-ID: ${cr.creditor_id}\nKonto: ${maskIban(signed.iban)}\n\nDer Text, dem du zugestimmt hast:\n\n${signed.text}\n\nViele Grüße\n${s.loc!.name}`;
          await sendToContact(app, signed.location_id, { contactId: signed.contact_id, channel: 'email', subject: `Dein SEPA-Lastschriftmandat ${signed.reference}`, body, source: 'SEPA-Mandat', ignoreDnd: true, purpose: 'transactional' }).catch((e) => console.error('[sepa] Bestätigung', (e as Error).message));
        }
      }
      return redirect(`/sepa/m/${encodeURIComponent(ctx.params.token)}`, 303);
    });
  },
};
