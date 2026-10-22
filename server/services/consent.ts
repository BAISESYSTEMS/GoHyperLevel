import type { App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { bad, notFound } from '../core/http.js';
import { sealSettings } from '../core/secrets.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity, contactVars, type Contact } from './contacts.js';
import {
  ACTION_LABEL,
  CHANNELS,
  CHANNEL_LABEL,
  CHANNEL_PURPOSES,
  GATE_PURPOSES,
  PURPOSE_LABEL,
  SOURCE_LABEL,
  cleanConsentSettings,
  deriveAll,
  deStamp,
  deriveChannel,
  gateDecision,
  ipNetwork,
  normText,
  prefToken,
  purposeSentence,
  safeRedirect,
  signDoi,
  textDigest,
  uaHash,
  type ChannelState,
  type ConsentChannel,
  type ConsentSettings,
  type GateResult,
  type LedgerEvent,
  type SendPolicy,
  type Status,
} from './consent-model.js';
import { oneLine, sendToContact } from './messaging.js';

/**
 * The consent ledger on the database: events (what happened, when, where, with which text), versioned consent texts, the
 * Double-Opt-in rows, the send gate and the flows that write them (grant, revoke, reset, confirm, tick). The HTTP routes are
 * in modules/consent.ts (API), consent-doi.ts (public confirmation, capture hooks) and consent-pages.ts (preference centre).
 * Everything is scoped by `locationId`: callers pass the sub-account of the request, a contact of another one is "not found".
 */

export interface Meta {
  ip_net: string;
  ua_digest: string;
}
export interface SourceInfo {
  kind: string;
  id?: string;
  label?: string;
}
export interface EventRow extends LedgerEvent {
  location_id: string;
  contact_id: string;
  source_kind: string;
  source_id: string;
  source_label: string;
  text_id: string | null;
  text_version: number | null;
  text_digest: string;
  ip_net: string;
  ua_digest: string;
  proof_url: string;
  note: string;
  actor: string;
  doi_id: string | null;
}
export interface DoiRow {
  id: string;
  location_id: string;
  contact_id: string;
  channel: ConsentChannel;
  purposes: string[];
  status: 'pending' | 'confirmed' | 'expired' | 'cancelled';
  email: string;
  source_kind: string;
  source_id: string;
  source_label: string;
  text_id: string | null;
  text_version: number | null;
  proof_url: string;
  ip_net: string;
  ua_digest: string;
  requested_at: string;
  expires_at: string;
  mailed_at: string | null;
  mail_attempts: number;
  reminded_at: string | null;
  confirmed_at: string | null;
}

export const metaOf = (ctx?: Pick<Ctx, 'ip' | 'req'>): Meta => ({ ip_net: ipNetwork(ctx?.ip), ua_digest: uaHash(ctx?.req?.headers?.['user-agent']) });
export const NO_META: Meta = { ip_net: '', ua_digest: '' };

const clip = (v: unknown, n: number) => String(v ?? '').slice(0, n);
/** A proof link: http(s) or an absolute path of this app; anything else is dropped. */
export const cleanProofUrl = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^(https?:\/\/[^\s"'<>]{3,480}|\/[^\s"'<>\\]{1,480})$/i.test(s) ? s : '';
};

// --- settings -------------------------------------------------------------------------------------------------------

export const settingsOf = (app: App, locationId: string): ConsentSettings => cleanConsentSettings(app.location(locationId)?.settings.consent);

/** Merges a patch into the stored settings (whatever is not in the patch stays) and returns the cleaned result. */
export function saveSettings(app: App, locationId: string, patch: Record<string, any>): ConsentSettings {
  const loc = app.location(locationId);
  if (!loc) throw notFound();
  const cur = settingsOf(app, locationId);
  const merged: any = { ...cur, ...patch, doi: { ...cur.doi, ...(patch.doi ?? {}), sources: { ...cur.doi.sources, ...(patch.doi?.sources ?? {}) }, page: { ...cur.doi.page, ...(patch.doi?.page ?? {}) } } };
  const next = cleanConsentSettings(merged);
  if (next.policy !== cur.policy) next.policy_changed_at = now();
  else if (cur.policy_changed_at) next.policy_changed_at = cur.policy_changed_at;
  app.db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, consent: next }).value), locationId);
  return next;
}

// --- texts, versioned -------------------------------------------------------------------------------------------------

export interface TextRow {
  id: string;
  location_id: string;
  key: string;
  version: number;
  text: string;
  text_digest: string;
  created_at: string;
}

/** The version of a consent text: the same wording gives back the version it already has, new wording a new version. */
export function ensureText(app: App, locationId: string, key: string, text: string): TextRow {
  const body = String(text ?? '').trim().slice(0, 4000);
  if (!body) throw bad('Text der Einwilligung fehlt');
  const k = clip(key, 120);
  const digest = textDigest(body);
  const last = app.db.get<TextRow>('SELECT * FROM consent_texts WHERE location_id = ? AND key = ? ORDER BY version DESC LIMIT 1', locationId, k);
  if (last && last.text_digest === digest) return last;
  const row: TextRow = { id: id(), location_id: locationId, key: k, version: (last?.version ?? 0) + 1, text: body, text_digest: digest, created_at: now() };
  app.db.insert('consent_texts', row);
  return row;
}

// --- events ----------------------------------------------------------------------------------------------------------

export interface NewEvent {
  locationId: string;
  contactId: string;
  channel: ConsentChannel;
  purpose: string;
  action: LedgerEvent['action'];
  doiRequired?: boolean;
  expiresAt?: string | null;
  source: SourceInfo;
  text?: Pick<TextRow, 'id' | 'version' | 'text_digest'> | null;
  proofUrl?: string;
  note?: string;
  actor?: string;
  meta?: Meta;
  doiId?: string | null;
}

export function insertEvent(app: App, e: NewEvent): EventRow {
  const row: EventRow = {
    id: id(),
    location_id: e.locationId,
    contact_id: e.contactId,
    channel: e.channel,
    purpose: e.purpose,
    action: e.action,
    doi_required: e.doiRequired ? 1 : 0,
    expires_at: e.expiresAt ?? null,
    source_kind: clip(e.source.kind, 30),
    source_id: clip(e.source.id, 80),
    source_label: clip(e.source.label, 200),
    text_id: e.text?.id ?? null,
    text_version: e.text?.version ?? null,
    text_digest: e.text?.text_digest ?? '',
    ip_net: e.meta?.ip_net ?? '',
    ua_digest: e.meta?.ua_digest ?? '',
    proof_url: cleanProofUrl(e.proofUrl),
    note: clip(e.note, 1000),
    actor: clip(e.actor, 80),
    doi_id: e.doiId ?? null,
    created_at: now(),
  };
  app.db.insert('consent_events', row);
  return row;
}

export const eventsOf = (app: App, contactId: string, channel?: string): EventRow[] =>
  app.db.all<EventRow>(`SELECT * FROM consent_events WHERE contact_id = ?${channel ? ' AND channel = ?' : ''} ORDER BY created_at, rowid`, contactId, ...(channel ? [channel] : []));

/** Status of every channel of one contact (the contact must belong to the sub-account). */
export function statusOf(app: App, locationId: string, contactId: string): Record<ConsentChannel, ChannelState> {
  const c = getContact(app, locationId, contactId);
  if (!c) throw notFound('Kontakt nicht gefunden');
  return deriveAll(eventsOf(app, contactId), { dnd: !!c.dnd });
}

const labelOf = (kind: string, label?: string) => (label ? `${SOURCE_LABEL[kind] ?? kind} „${label}“` : (SOURCE_LABEL[kind] ?? kind));
const purposesText = (purposes: string[]) => (purposes.length ? purposes.map((p) => PURPOSE_LABEL[p as keyof typeof PURPOSE_LABEL] ?? p).join(', ') : 'alle Zwecke');

/** Sources where the person acted themselves: their yes (after a "Nicht stören") lifts the DND, the team's note does not. */
const PERSON_SOURCES = new Set(['form', 'funnel', 'webinar', 'community', 'preferences', 'doi', 'checkout', 'api']);

// --- double opt-in rows ----------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 3_600_000;
const parseDoi = (r: any): DoiRow | undefined => (r ? { ...r, purposes: JSON.parse(r.purposes || '[]') } : undefined);
export const getDoi = (app: App, doiId: string): DoiRow | undefined => parseDoi(app.db.get('SELECT * FROM consent_doi WHERE id = ?', doiId));
export const doiOf = (app: App, contactId: string): DoiRow[] => app.db.all('SELECT * FROM consent_doi WHERE contact_id = ? ORDER BY requested_at DESC LIMIT 50', contactId).map((r) => parseDoi(r)!);

/** A request that is still open and covers these purposes (the same person signing up twice gets one mail, not two). */
function openDoi(app: App, contactId: string, channel: string, purposes: string[]): DoiRow | undefined {
  return app.db
    .all('SELECT * FROM consent_doi WHERE contact_id = ? AND channel = ? AND status = ? AND expires_at > ? ORDER BY requested_at DESC', contactId, channel, 'pending', now())
    .map((r) => parseDoi(r)!)
    .find((d) => purposes.every((p) => d.purposes.includes(p)));
}

export interface GrantInput {
  locationId: string;
  contactId: string;
  channel: ConsentChannel;
  purposes: string[];
  source: SourceInfo;
  text?: { key: string; text: string };
  proofUrl?: string;
  note?: string;
  meta?: Meta;
  actor?: string;
  /** Double-Opt-in required: the consent stays "pending" until the person confirms. */
  doi?: boolean;
  /** Lift "Nicht stören" when the consent is confirmed right away (default: when the person acted themselves). */
  clearDnd?: boolean;
}

export interface GrantResult {
  status: Status;
  events: EventRow[];
  doi?: DoiRow;
  /** A confirmation mail will go out (or went out): the request was new, or an old one is being sent again. */
  mailQueued: boolean;
}

const validPurposes = (channel: ConsentChannel, purposes: string[]) => [...new Set(purposes)].filter((p) => (CHANNEL_PURPOSES[channel] as string[]).includes(p));

/**
 * Records "yes". Without Double-Opt-in the consent is confirmed at once (`consent.confirmed` fires); with it a request row and
 * a pending event per purpose are written, the mail goes out from consent-doi (tick) and confirming is a separate step.
 */
export function grantConsent(app: App, i: GrantInput): GrantResult {
  const contact = getContact(app, i.locationId, i.contactId);
  if (!contact) throw notFound('Kontakt nicht gefunden');
  if (!(CHANNELS as readonly string[]).includes(i.channel)) throw bad('Unbekannter Kanal');
  const purposes = validPurposes(i.channel, i.purposes);
  if (!purposes.length) throw bad('Unbekannter Zweck für diesen Kanal');
  if (i.doi && i.channel !== 'email') throw bad('Double-Opt-in gibt es nur für E-Mail');
  if (i.doi && !contact.email) throw bad('Für Double-Opt-in braucht der Kontakt eine E-Mail-Adresse');
  const text = i.text?.text?.trim() ? ensureText(app, i.locationId, i.text.key, i.text.text) : null;
  const base = { locationId: i.locationId, contactId: i.contactId, channel: i.channel, source: i.source, text, proofUrl: i.proofUrl, note: i.note, actor: i.actor ?? '', meta: i.meta ?? NO_META };

  if (i.doi) {
    const open = openDoi(app, contact.id, i.channel, purposes);
    if (open) {
      // Asked again: the same open request; the mail is sent once more only if the last one is older than ten minutes.
      const again = Date.now() - Date.parse(open.mailed_at ?? open.requested_at) > 10 * MINUTE;
      if (again) app.db.run('UPDATE consent_doi SET mailed_at = NULL, mail_attempts = 0 WHERE id = ?', open.id);
      return { status: 'pending', events: [], doi: open, mailQueued: again };
    }
    const settings = settingsOf(app, i.locationId);
    const doi: DoiRow = {
      id: id(),
      location_id: i.locationId,
      contact_id: contact.id,
      channel: i.channel,
      purposes,
      status: 'pending',
      email: contact.email,
      source_kind: clip(i.source.kind, 30),
      source_id: clip(i.source.id, 80),
      source_label: clip(i.source.label, 200),
      text_id: text?.id ?? null,
      text_version: text?.version ?? null,
      proof_url: cleanProofUrl(i.proofUrl),
      ip_net: base.meta.ip_net,
      ua_digest: base.meta.ua_digest,
      requested_at: now(),
      expires_at: new Date(Date.now() + settings.doi.expiry_hours * HOUR).toISOString(),
      mailed_at: null,
      mail_attempts: 0,
      reminded_at: null,
      confirmed_at: null,
    };
    const events: EventRow[] = [];
    app.db.tx(() => {
      app.db.insert('consent_doi', { ...doi, purposes });
      for (const p of purposes) events.push(insertEvent(app, { ...base, purpose: p, action: 'granted', doiRequired: true, expiresAt: doi.expires_at, doiId: doi.id }));
    });
    logActivity(app, i.locationId, contact.id, 'consent.pending', `Einwilligung angefragt (Double-Opt-in): ${CHANNEL_LABEL[i.channel]} · ${purposesText(purposes)} – ${labelOf(i.source.kind, i.source.label)}`, { channel: i.channel, purposes, doi_id: doi.id });
    return { status: 'pending', events, doi, mailQueued: true };
  }

  const events: EventRow[] = [];
  app.db.tx(() => {
    for (const p of purposes) events.push(insertEvent(app, { ...base, purpose: p, action: 'granted' }));
  });
  logActivity(app, i.locationId, contact.id, 'consent.granted', `Einwilligung erteilt: ${CHANNEL_LABEL[i.channel]} · ${purposesText(purposes)} – ${labelOf(i.source.kind, i.source.label)}`, { channel: i.channel, purposes });
  liftDnd(app, contact, i.clearDnd ?? PERSON_SOURCES.has(i.source.kind), i.channel);
  app.events.emit(i.locationId, 'consent.confirmed', { contactId: contact.id, channel: i.channel, purposes, source: i.source.kind, doi: false });
  return { status: 'confirmed', events, mailQueued: false };
}

/** A confirmed yes is newer than the DND: the flag goes (and the timeline says so). Revoked-by-DND would make the yes meaningless. */
function liftDnd(app: App, contact: Contact, on: boolean, channel: ConsentChannel) {
  if (!on || !contact.dnd || channel === 'tracking') return;
  app.db.run('UPDATE contacts SET dnd = 0, updated_at = ? WHERE id = ?', now(), contact.id);
  logActivity(app, contact.location_id, contact.id, 'consent.dnd_lifted', 'Nicht stören aufgehoben (neue Einwilligung der Person)');
}

export interface RevokeInput {
  locationId: string;
  contactId: string;
  /** One channel, or 'all' for every communication channel (e-mail, SMS, WhatsApp, phone). */
  channel: ConsentChannel | 'all';
  /** Purposes, or empty for all of them. */
  purposes?: string[];
  source: SourceInfo;
  meta?: Meta;
  note?: string;
  actor?: string;
}

/** Records "no": events, pending confirmations of that channel are cancelled, timeline entry, `consent.revoked`. */
export function revokeConsent(app: App, i: RevokeInput): EventRow[] {
  const contact = getContact(app, i.locationId, i.contactId);
  if (!contact) throw notFound('Kontakt nicht gefunden');
  const channels: ConsentChannel[] = i.channel === 'all' ? ['email', 'sms', 'whatsapp', 'phone'] : [i.channel];
  const events: EventRow[] = [];
  app.db.tx(() => {
    for (const channel of channels) {
      const purposes = i.purposes?.length ? validPurposes(channel, i.purposes) : ['*'];
      for (const p of purposes) events.push(insertEvent(app, { locationId: i.locationId, contactId: contact.id, channel, purpose: p, action: 'revoked', source: i.source, proofUrl: undefined, note: i.note, actor: i.actor ?? '', meta: i.meta ?? NO_META }));
      // A confirmation that is still open must not bring the consent back after the person said no.
      for (const d of app.db.all<any>('SELECT * FROM consent_doi WHERE contact_id = ? AND channel = ? AND status = ?', contact.id, channel, 'pending').map((r) => parseDoi(r)!)) {
        if (purposes.includes('*') || d.purposes.some((x) => purposes.includes(x))) app.db.run('UPDATE consent_doi SET status = ? WHERE id = ?', 'cancelled', d.id);
      }
    }
  });
  if (events.length) {
    const what = i.purposes?.length ? purposesText(i.purposes) : 'alle Zwecke';
    logActivity(app, i.locationId, contact.id, 'consent.revoked', `Einwilligung widerrufen: ${i.channel === 'all' ? 'alle Kanäle' : CHANNEL_LABEL[i.channel]} · ${what} – ${labelOf(i.source.kind, i.source.label)}`, { channel: i.channel, purposes: i.purposes ?? [] });
    app.events.emit(i.locationId, 'consent.revoked', { contactId: contact.id, channel: i.channel, purposes: i.purposes ?? [], source: i.source.kind });
  }
  return events;
}

/** "Nicht stören" was lifted by hand: the revocations before it no longer count (status back to unknown, without proof). */
export function resetConsent(app: App, locationId: string, contactId: string, source: SourceInfo, o: { actor?: string; note?: string } = {}) {
  const contact = getContact(app, locationId, contactId);
  if (!contact) throw notFound('Kontakt nicht gefunden');
  const channels: ConsentChannel[] = ['email', 'sms', 'whatsapp', 'phone'];
  const events: EventRow[] = [];
  app.db.tx(() => {
    for (const channel of channels) if (app.db.get('SELECT 1 FROM consent_events WHERE contact_id = ? AND channel = ?', contactId, channel)) events.push(insertEvent(app, { locationId, contactId, channel, purpose: '*', action: 'reset', source, actor: o.actor, note: o.note }));
  });
  if (events.length) logActivity(app, locationId, contactId, 'consent.reset', 'Sperre aufgehoben (ohne Nachweis, Status „unbekannt“)');
  return events;
}

// --- confirming ---------------------------------------------------------------------------------------------------------

export type ConfirmResult = { ok: true; doi: DoiRow; already: boolean } | { ok: false; reason: 'invalid' | 'expired' | 'cancelled' };

/** The person confirmed (POST on the signed link): events `confirmed`, row closed, DND lifted, `consent.confirmed`. */
export function confirmDoi(app: App, doiId: string, meta: Meta): ConfirmResult {
  const d = getDoi(app, doiId);
  if (!d) return { ok: false, reason: 'invalid' };
  if (d.status === 'confirmed') return { ok: true, doi: d, already: true };
  if (d.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (d.status === 'expired' || Date.parse(d.expires_at) <= Date.now()) return { ok: false, reason: 'expired' };
  const contact = getContact(app, d.location_id, d.contact_id);
  if (!contact) return { ok: false, reason: 'invalid' };
  const text = d.text_id ? app.db.get<TextRow>('SELECT * FROM consent_texts WHERE id = ?', d.text_id) : undefined;
  const at = now();
  app.db.tx(() => {
    app.db.run('UPDATE consent_doi SET status = ?, confirmed_at = ? WHERE id = ?', 'confirmed', at, d.id);
    for (const p of d.purposes) insertEvent(app, { locationId: d.location_id, contactId: d.contact_id, channel: d.channel, purpose: p, action: 'confirmed', doiRequired: false, source: { kind: 'doi', id: d.id, label: labelOf(d.source_kind, d.source_label) }, text: text ?? null, proofUrl: d.proof_url, meta, note: `Link aus der E-Mail an ${d.email} bestätigt`, actor: 'contact', doiId: d.id });
  });
  logActivity(app, d.location_id, d.contact_id, 'consent.confirmed', `Einwilligung bestätigt (Double-Opt-in): ${CHANNEL_LABEL[d.channel]} · ${purposesText(d.purposes)}`, { channel: d.channel, purposes: d.purposes, doi_id: d.id });
  liftDnd(app, contact, true, d.channel);
  app.events.emit(d.location_id, 'consent.confirmed', { contactId: d.contact_id, channel: d.channel, purposes: d.purposes, source: d.source_kind, doi: true });
  return { ok: true, doi: { ...d, status: 'confirmed', confirmed_at: at }, already: false };
}

// --- the mail ------------------------------------------------------------------------------------------------------------

export const confirmUrl = (app: App, d: DoiRow) => `${app.baseUrl()}/consent/confirm/${signDoi(app.config.secret, d.id, Date.parse(d.expires_at))}`;
export const prefsUrl = (app: App, contactId: string) => `${app.baseUrl()}/consent/p/${contactId}/${prefToken(app.config.secret, contactId)}`;

export function mailVars(app: App, d: DoiRow, contact: Contact) {
  const loc = app.location(d.location_id)!;
  const text = d.text_id ? app.db.get<TextRow>('SELECT text FROM consent_texts WHERE id = ?', d.text_id) : undefined;
  return { contact: contactVars(contact), location: { name: loc.name, email: loc.email ?? '', website: loc.website ?? '' }, confirm_url: confirmUrl(app, d), purpose_text: purposeSentence(d.purposes), expires: deStamp(d.expires_at, loc.timezone, true), consent_text: normText(text?.text ?? purposeSentence(d.purposes)) };
}

/** Sends the confirmation mail (or the reminder); false when it did not go out (retried by the tick, a few times). */
export async function sendDoiMail(app: App, d: DoiRow, reminder = false): Promise<boolean> {
  const contact = getContact(app, d.location_id, d.contact_id);
  if (!contact || !contact.email || d.status !== 'pending') return false;
  const s = settingsOf(app, d.location_id);
  const vars = mailVars(app, d, contact);
  const subject = oneLine(`${reminder ? 'Erinnerung: ' : ''}${render(s.doi.subject, vars)}`).slice(0, 200);
  const body = (reminder ? 'Das ist eine kurze Erinnerung – du hast die Bestätigung noch nicht abgeschlossen.\n\n' : '') + render(s.doi.body, vars);
  // A reply to the person's own sign-up: no gate, no DND check – it is the one mail that asks for the consent. Before that consent
  // nothing is measured (no pixel, no tracked links – § 25 TDDDG) and there is no "Abmelden" (service mail, nothing to unsubscribe from).
  const m = await sendToContact(app, d.location_id, { contactId: contact.id, channel: 'email', subject, body, source: reminder ? 'Double-Opt-in Erinnerung' : 'Double-Opt-in', ignoreDnd: true, purpose: 'transactional', track: false });
  return m.status !== 'failed';
}

/** Takes the "first mail" of a request (only one sender wins), sends it, and gives it back when it did not go out. */
export async function mailDoi(app: App, d: DoiRow): Promise<boolean> {
  if (app.db.run('UPDATE consent_doi SET mailed_at = ?, mail_attempts = mail_attempts + 1 WHERE id = ? AND status = ? AND mailed_at IS NULL', now(), d.id, 'pending').changes === 0) return false;
  let ok = false;
  try {
    ok = await sendDoiMail(app, d);
  } catch (e) {
    console.error('[consent] DOI-Mail:', (e as Error).message);
  }
  if (!ok) app.db.run('UPDATE consent_doi SET mailed_at = NULL WHERE id = ?', d.id);
  return ok;
}

/** Sends the confirmation mail in the background (the request that asked for it does not wait); the tick retries a failed one. */
export function dispatchDoi(app: App, d: DoiRow) {
  void mailDoi(app, d).catch((e) => console.error('[consent] DOI-Mail:', (e as Error).message));
}

/** Mails that are due: first mails not sent yet (a few attempts), reminders, and the expiry of requests nobody confirmed. */
export async function runDoiTick(app: App, limit = 40): Promise<{ sent: number; reminded: number; expired: number }> {
  const out = { sent: 0, reminded: 0, expired: 0 };
  const nowIso = now();
  const cache = new Map<string, ConsentSettings>();
  const cfg = (loc: string) => cache.get(loc) ?? (cache.set(loc, settingsOf(app, loc)), cache.get(loc)!);

  for (const r of app.db.all<any>('SELECT * FROM consent_doi WHERE status = ? AND mailed_at IS NULL AND mail_attempts < 4 AND expires_at > ? ORDER BY requested_at LIMIT ?', 'pending', nowIso, limit)) {
    if (await mailDoi(app, parseDoi(r)!)) out.sent++;
  }

  for (const r of app.db.all<any>('SELECT * FROM consent_doi WHERE status = ? AND mailed_at IS NOT NULL AND reminded_at IS NULL AND expires_at > ? ORDER BY requested_at LIMIT ?', 'pending', nowIso, limit * 5)) {
    const d = parseDoi(r)!;
    const hours = cfg(d.location_id).doi.reminder_hours;
    if (!hours || Date.parse(d.mailed_at!) + hours * HOUR > Date.now()) continue;
    app.db.run('UPDATE consent_doi SET reminded_at = ? WHERE id = ?', now(), d.id);
    try {
      if (await sendDoiMail(app, d, true)) {
        out.reminded++;
        logActivity(app, d.location_id, d.contact_id, 'consent.reminded', `Erinnerung an die Bestätigung gesendet (${CHANNEL_LABEL[d.channel]} · ${purposesText(d.purposes)})`, { doi_id: d.id });
      }
    } catch (e) {
      console.error('[consent] DOI-Erinnerung:', (e as Error).message);
    }
  }

  for (const r of app.db.all<any>('SELECT * FROM consent_doi WHERE status = ? AND expires_at <= ? LIMIT ?', 'pending', nowIso, limit * 5)) {
    const d = parseDoi(r)!;
    app.db.tx(() => {
      app.db.run('UPDATE consent_doi SET status = ? WHERE id = ? AND status = ?', 'expired', d.id, 'pending');
      for (const p of d.purposes) insertEvent(app, { locationId: d.location_id, contactId: d.contact_id, channel: d.channel, purpose: p, action: 'expired', source: { kind: 'system', label: labelOf(d.source_kind, d.source_label) }, doiId: d.id, note: 'Bestätigungslink nicht rechtzeitig angeklickt', actor: 'system' });
    });
    logActivity(app, d.location_id, d.contact_id, 'consent.expired', `Bestätigung abgelaufen (${CHANNEL_LABEL[d.channel]} · ${purposesText(d.purposes)}) – keine Werbung ohne neue Einwilligung`, { doi_id: d.id });
    out.expired++;
  }
  return out;
}

// --- the gate -------------------------------------------------------------------------------------------------------------

export interface GateInput {
  locationId: string;
  contact: Pick<Contact, 'id' | 'dnd'>;
  channel: string;
  /** What the sender says this message is; otherwise bulk sources are advertising and "ignoreDnd" ones service messages. */
  purpose?: string;
  bulk?: boolean;
  ignoreDnd?: boolean;
  messageId?: string;
  source?: string;
}

export interface Verdict extends GateResult {
  purpose: 'marketing' | 'transactional' | 'conversation';
  /** What goes into messages.consent_basis. */
  mark: string;
}

/** May advertising go to this contact on this channel (and what is this message). Pure read: the caller marks the message. */
export function judge(app: App, i: GateInput): Verdict {
  const purpose: Verdict['purpose'] = i.purpose === 'transactional' ? 'transactional' : i.purpose === 'marketing' ? 'marketing' : i.bulk ? 'marketing' : i.ignoreDnd ? 'transactional' : 'conversation';
  if (purpose !== 'marketing') return { allow: true, basis: '', reason: '', purpose, mark: purpose === 'transactional' ? 'exempt' : '' };
  // The sender overrode DND on purpose (test mails to a team member, a person writing by hand).
  if (i.ignoreDnd) return { allow: true, basis: '', reason: '', purpose, mark: 'override' };
  const channel = i.channel as ConsentChannel;
  if (!(['email', 'sms', 'whatsapp'] as string[]).includes(channel)) return { allow: true, basis: '', reason: '', purpose, mark: '' };
  const state = deriveChannel(eventsOf(app, i.contact.id, channel), channel, { dnd: !!i.contact.dnd });
  const r = gateDecision(state, settingsOf(app, i.locationId).policy);
  return { ...r, purpose, mark: r.allow ? r.basis : 'blocked' };
}

/** The hook sendToContact (and the WhatsApp sender) call: marks the message and returns the German reason when it must not go out. */
export function gate(app: App, i: GateInput): { blocked?: string } {
  const v = judge(app, i);
  if (i.messageId) app.db.run('UPDATE messages SET purpose = ?, consent_basis = ? WHERE id = ?', v.purpose, v.mark, i.messageId);
  return v.allow ? {} : { blocked: v.reason };
}

/** For audiences (campaign start, the reachable count): the verdict for a contact as marketing. */
export function allowMarketing(app: App, locationId: string, contact: Pick<Contact, 'id' | 'dnd'>, channel: string): GateResult {
  const v = judge(app, { locationId, contact, channel, bulk: true });
  return { allow: v.allow, basis: v.basis, reason: v.reason };
}

/** The verdicts for a whole audience in one pass (one query for the sub-account's events instead of one per contact). */
export function allowMarketingMany(app: App, locationId: string, contacts: Pick<Contact, 'id' | 'dnd'>[], channel: string): Map<string, GateResult> {
  const out = new Map<string, GateResult>();
  if (!(['email', 'sms', 'whatsapp'] as string[]).includes(channel)) {
    for (const c of contacts) out.set(c.id, { allow: true, basis: '', reason: '' });
    return out;
  }
  const policy = settingsOf(app, locationId).policy;
  const by = new Map<string, LedgerEvent[]>();
  for (const e of app.db.all<LedgerEvent & { contact_id: string }>('SELECT id, contact_id, channel, purpose, action, doi_required, expires_at, created_at FROM consent_events WHERE location_id = ? AND channel = ? ORDER BY created_at, rowid', locationId, channel)) {
    const l = by.get(e.contact_id) ?? [];
    l.push(e);
    by.set(e.contact_id, l);
  }
  for (const c of contacts) out.set(c.id, gateDecision(deriveChannel(by.get(c.id) ?? [], channel as ConsentChannel, { dnd: !!c.dnd }), policy));
  return out;
}

export type { SendPolicy };
export { GATE_PURPOSES, ACTION_LABEL, safeRedirect };
