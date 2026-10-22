import { escapeHtml as h } from '../core/template.js';
import type { PlanKey } from './cloud.js';

/**
 * Cloud waitlist mode, the pure parts: when the mode is on, the texts of the waitlist form (German and English, shared by the
 * landing page, /cloud and /start), the check of a submission and the form's HTML. The module (modules/cloud-waitlist.ts) stores,
 * forwards, rate-limits and gates the signup routes; docs/cloud.md#waitlist-mode.
 *
 * The mode: `PGHL_CLOUD_WAITLIST=1` switches it on, `=0` off; unset, it is on whenever the cloud mode runs without billing (no Stripe
 * key) – an instance that cannot charge must not look like it sells.
 */

export type WlLang = 'de' | 'en';
export type WlPlan = PlanKey;
export const WL_PLANS: WlPlan[] = ['solo', 'team', 'agency'];
/** The source the forms path passes on (`source` field of the HQ form) and the built-in list stores. */
export const WAITLIST_SOURCE = 'Cloud-Warteliste';
/** The section id every waitlist link scrolls to. */
export const WAITLIST_ANCHOR = 'warteliste';
/** The public endpoint the form posts to. */
export const WAITLIST_ACTION = '/api/public/cloud-waitlist';

export type WlReason = 'env' | 'no_billing';
/** Why the waitlist mode is on (null = off): the explicit switch, or a cloud mode without billing. */
export function waitlistReason(o: { env?: string; cloud: boolean; billing: boolean }): WlReason | null {
  const v = String(o.env ?? '').trim();
  if (v === '1') return 'env';
  if (v === '0') return null;
  return o.cloud && !o.billing ? 'no_billing' : null;
}
export const waitlistMode = (o: { env?: string; cloud: boolean; billing: boolean }) => waitlistReason(o) !== null;

export type WlError = 'email' | 'consent' | 'name' | 'stale' | 'rate' | 'closed' | 'error';
export type WlState = 'ok' | 'doi' | WlError;
export const WL_STATES: WlState[] = ['ok', 'doi', 'email', 'consent', 'name', 'stale', 'rate', 'closed', 'error'];
export const isWlState = (v: unknown): v is WlState => WL_STATES.includes(v as WlState);
/** HTTP status of each answer (JSON callers). */
export const WL_STATUS: Record<WlState, number> = { ok: 200, doi: 200, email: 400, consent: 400, name: 400, stale: 400, rate: 429, closed: 404, error: 502 };

export interface WaitlistText {
  h2: string;
  lead: string;
  selfLead: string;
  name: string;
  firstName: string;
  email: string;
  plan: string;
  planAny: string;
  plans: Record<WlPlan, string>;
  consent: string;
  privacyPrefix: string;
  privacy: string;
  submit: string;
  note: string;
  ok: string;
  doi: string;
  errors: Record<WlError, string>;
  soon: string;
  planned: string;
  join: string;
  selfCta: string;
  hp: string;
  /** The /start page in waitlist mode. */
  page: { title: string; h1: string; lead: string; sideH: string; side: string; login: string; account: string };
  /** A signup route refused in waitlist mode. */
  refused: string;
}

export const WL_TEXT: Record<WlLang, WaitlistText> = {
  de: {
    h2: 'Cloud: auf die Warteliste',
    lead: 'Die gehostete {b} Cloud ist in Vorbereitung. Noch kann niemand ein Konto anlegen, Zahlungsdaten eingeben oder etwas bezahlen. Trag dich ein – wir melden uns, sobald sie startet.',
    selfLead: 'Du willst nicht warten? Selbst gehostet ist {b} schon heute kostenlos, mit allen Funktionen.',
    name: 'Name (optional)',
    firstName: 'Vorname',
    email: 'E-Mail',
    plan: 'Welcher Tarif interessiert dich? (optional)',
    planAny: 'Noch unsicher',
    plans: { solo: 'Cloud Solo', team: 'Cloud Team & Company', agency: 'Cloud Agentur' },
    consent: 'Ja, informiert mich per E-Mail, sobald die Cloud startet. Gespeichert werden nur die Angaben aus diesem Formular; austragen kann ich mich jederzeit.',
    privacyPrefix: 'Mehr dazu in der',
    privacy: 'Datenschutzerklärung',
    submit: 'Auf die Warteliste',
    note: 'Kein Newsletter, keine Werbung – nur eine Nachricht zum Start. Diese Seite setzt keine Cookies.',
    ok: 'Danke! Wir melden uns, sobald die Cloud startet.',
    doi: 'Bitte bestätige noch deine E-Mail-Adresse über den Link in der E-Mail, die wir dir gerade geschickt haben.',
    errors: {
      email: 'Bitte gib eine gültige E-Mail-Adresse an.',
      consent: 'Bitte setz den Haken bei der Einwilligung – ohne ihn dürfen wir dich nicht benachrichtigen.',
      name: 'Bitte gib deinen Vornamen an.',
      stale: 'Das ging zu schnell oder die Seite ist veraltet – bitte noch einmal absenden.',
      rate: 'Zu viele Versuche von hier – bitte versuche es später noch einmal.',
      closed: 'Die Warteliste ist gerade nicht aktiv.',
      error: 'Das hat nicht geklappt – bitte versuche es später noch einmal.',
    },
    soon: 'Bald verfügbar',
    planned: 'voraussichtlich',
    join: 'Auf die Warteliste',
    selfCta: 'Kostenlos selbst hosten',
    hp: 'Bitte leer lassen',
    page: {
      title: 'Warteliste',
      h1: 'Die Cloud startet bald',
      lead: 'Wir bereiten die gehostete {b} Cloud gerade vor. Konten können noch nicht angelegt werden, und es wird nichts berechnet. Trag dich auf die Warteliste ein – wir melden uns, sobald sie startet.',
      sideH: 'Heute schon loslegen',
      side: 'Selbst gehostet ist {b} kostenlos: alle Funktionen, dein Server, deine Daten (Open Source, AGPL-3.0).',
      login: 'Schon ein Konto?',
      account: 'Zur Anmeldung',
    },
    refused: 'Die Cloud ist noch nicht verfügbar: Neue Konten, Sub-Accounts und Zahlungen sind gesperrt. Trag dich auf die Warteliste ein – oder hoste {b} kostenlos selbst.',
  },
  en: {
    h2: 'Cloud: join the waitlist',
    lead: 'The hosted {b} cloud is being prepared. Nobody can create an account, enter payment details or pay for it yet. Join the list – we will let you know as soon as it launches.',
    selfLead: "Don't want to wait? Self-hosted, {b} is free today, with every feature.",
    name: 'Name (optional)',
    firstName: 'First name',
    email: 'E-mail',
    plan: 'Which plan interests you? (optional)',
    planAny: 'Not sure yet',
    plans: { solo: 'Cloud Solo', team: 'Cloud Team & Company', agency: 'Cloud Agency' },
    consent: 'Yes, e-mail me as soon as the cloud launches. Only the details in this form are stored; I can unsubscribe at any time.',
    privacyPrefix: 'More in the',
    privacy: 'privacy policy',
    submit: 'Join the waitlist',
    note: 'No newsletter, no marketing – just one message at launch. This page sets no cookies.',
    ok: "Thanks! We'll be in touch as soon as the cloud launches.",
    doi: 'Please confirm your e-mail address with the link in the e-mail we just sent you.',
    errors: {
      email: 'Please enter a valid e-mail address.',
      consent: 'Please tick the consent box – without it we may not notify you.',
      name: 'Please enter your first name.',
      stale: 'That was too fast or the page is out of date – please send it again.',
      rate: 'Too many attempts from here – please try again later.',
      closed: 'The waitlist is not active right now.',
      error: 'That did not work – please try again later.',
    },
    soon: 'Coming soon',
    planned: 'planned',
    join: 'Join the waitlist',
    selfCta: 'Self-host for free',
    hp: 'Leave this empty',
    page: {
      title: 'Waitlist',
      h1: 'The cloud is coming soon',
      lead: 'We are preparing the hosted {b} cloud. Accounts cannot be created yet, and nothing is charged. Join the waitlist – we will let you know as soon as it launches.',
      sideH: 'Get going today',
      side: 'Self-hosted, {b} is free: every feature, your server, your data (open source, AGPL-3.0).',
      login: 'Already have an account?',
      account: 'Sign in',
    },
    refused: 'The cloud is not available yet: new accounts, sub-accounts and payments are blocked. Join the waitlist – or self-host {b} for free.',
  },
};

/** The texts with the product name filled in. */
export function wlText(lang: WlLang, brand: string): WaitlistText {
  const fill = (v: unknown): unknown =>
    typeof v === 'string' ? v.replace(/\{b\}/g, brand) : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
  return fill(WL_TEXT[lang]) as WaitlistText;
}

export const wlLang = (v: unknown): WlLang => (v === 'en' ? 'en' : 'de');
export const wlPlan = (v: unknown): WlPlan | '' => (WL_PLANS.includes(v as WlPlan) ? (v as WlPlan) : '');

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const yes = (v: unknown) => v === true || v === 1 || ['1', 'on', 'true', 'yes', 'ja'].includes(String(v ?? '').trim().toLowerCase());
const clean = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export interface WaitlistEntry {
  email: string;
  name: string;
  plan: WlPlan | '';
  lang: WlLang;
}

/** A submission (JSON or form fields) → the entry, or what is wrong with it. `needName`: the receiving form wants a first name. */
export function parseWaitlist(body: Record<string, unknown>, o: { needName?: boolean } = {}): { ok: true; entry: WaitlistEntry } | { ok: false; error: WlError } {
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 254);
  if (email.length > 200 || !EMAIL.test(email)) return { ok: false, error: 'email' };
  const name = clean(body.name ?? body.first_name, 120);
  if (o.needName && !name) return { ok: false, error: 'name' };
  if (!yes(body.consent)) return { ok: false, error: 'consent' };
  return { ok: true, entry: { email, name, plan: wlPlan(body.plan), lang: wlLang(body.lang) } };
}

/** A honeypot field was filled (bots): answer like a success, store nothing. */
export const isBot = (body: Record<string, unknown>) => !!String(body.website ?? '').trim() || !!String(body._hp ?? '').trim();

/** Pages the form may send the visitor back to (no open redirect): the landing pages and the cloud pages. */
export const WL_BACK = ['/', '/de', '/cloud', '/start'] as const;
export const safeBack = (v: unknown): string => (WL_BACK as readonly string[]).includes(String(v ?? '')) ? String(v) : '/';
/** Where a form post lands afterwards: the page it came from, with the result, scrolled to the form. */
export function backUrl(back: string, state: WlState, lang: WlLang): string {
  const page = safeBack(back);
  const q = new URLSearchParams({ wl: state });
  if (lang === 'en' && (page === '/start' || page === '/cloud')) q.set('lang', 'en');
  return `${page}?${q}#${WAITLIST_ANCHOR}`;
}

/** The consent text as the person saw it (stored with the entry as proof). */
export function consentText(t: WaitlistText, privacyUrl: string, label = t.consent): string {
  return `${label}${privacyUrl ? ` ${t.privacyPrefix} ${t.privacy}: ${privacyUrl}` : ''}`.slice(0, 1000);
}

/** Everything the form needs, as the module builds it for a page. */
export interface WaitlistView {
  lang: WlLang;
  brand: string;
  /** The page to come back to after a form post (one of WL_BACK). */
  back: string;
  /** Time token (the form may not come back faster than a person fills it). */
  token: string;
  /** Preselected plan. */
  plan: WlPlan | '';
  /** Privacy policy link next to the consent ('' = none configured). */
  privacyUrl: string;
  /** The receiving form's own consent text (forms path); empty = the built-in text. */
  consentLabel: string;
  /** The receiving form wants a first name (forms path). */
  needName: boolean;
  /** Entries go to a form with Double-Opt-in (the success text asks to confirm). */
  doi: boolean;
  /** Result of the last post (?wl=…), shown above or instead of the form. */
  state?: WlState;
}

/** Class names of the page the form sits on (the landing page and the cloud pages have their own styles). */
export interface WlClasses {
  form: string;
  row: string;
  label: string;
  input: string;
  check: string;
  button: string;
  note: string;
  ok: string;
  err: string;
  hp: string;
}

/** The form (or, after a successful post, the thank-you note). Works without any script; the browser checks the required fields. */
export function waitlistFormHtml(v: WaitlistView, c: WlClasses, idp = 'wl'): string {
  const t = wlText(v.lang, v.brand);
  if (v.state === 'ok' || v.state === 'doi') return `<div class="${c.ok}" role="status"><p style="margin:0">${h(t.ok)}</p>${v.state === 'doi' ? `<p style="margin:8px 0 0;font-weight:400">${h(t.doi)}</p>` : ''}</div>`;
  const err = v.state ? `<div class="${c.err}" role="alert">${h(t.errors[v.state])}</div>` : '';
  const privacy = v.privacyUrl ? ` ${h(t.privacyPrefix)} <a href="${h(v.privacyUrl)}" target="_blank" rel="noopener">${h(t.privacy)}</a>.` : '';
  const plans = [`<option value="">${h(t.planAny)}</option>`, ...WL_PLANS.map((p) => `<option value="${p}"${v.plan === p ? ' selected' : ''}>${h(t.plans[p])}</option>`)].join('');
  return `<form class="${c.form}" method="post" action="${WAITLIST_ACTION}" autocomplete="on">${err}
<input type="hidden" name="lang" value="${v.lang}"><input type="hidden" name="back" value="${h(safeBack(v.back))}"><input type="hidden" name="wt" value="${h(v.token)}">
<div class="${c.row}"><div><label class="${c.label}" for="${idp}-name">${h(v.needName ? t.firstName : t.name)}</label><input class="${c.input}" id="${idp}-name" name="name" type="text" maxlength="120" autocomplete="${v.needName ? 'given-name' : 'name'}"${v.needName ? ' required' : ''}></div>
<div><label class="${c.label}" for="${idp}-email">${h(t.email)}</label><input class="${c.input}" id="${idp}-email" name="email" type="email" maxlength="200" autocomplete="email" required></div></div>
<label class="${c.label}" for="${idp}-plan">${h(t.plan)}</label><select class="${c.input}" id="${idp}-plan" name="plan">${plans}</select>
<div class="${c.hp}"><label for="${idp}-website">${h(t.hp)}</label><input id="${idp}-website" name="website" tabindex="-1" autocomplete="off"></div>
<label class="${c.check}"><input type="checkbox" name="consent" value="1" required><span>${h(v.consentLabel || t.consent)}${privacy}</span></label>
<button class="${c.button}" type="submit">${h(t.submit)}</button>
${v.consentLabel ? '' : `<p class="${c.note}">${h(t.note)}</p>`}</form>`;
}
