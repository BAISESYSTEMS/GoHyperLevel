import type { App } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { ymdInTz } from '../core/time.js';
import { id, now, token } from '../core/util.js';
import { getContact, logActivity } from './contacts.js';
import { sellerOf } from './invoice-flow.js';
import {
  DEFAULT_SETTINGS,
  KIND_LABELS,
  NON_EEA,
  SCHEME_LABELS,
  SEQ_LABELS,
  STATUS_LABELS,
  checkBic,
  cleanSettings,
  creditorIdCheck,
  effectiveStatus,
  expiresOn,
  ibanInfo,
  isKind,
  isScheme,
  isYmd,
  makeRef,
  mandateText,
  maskIban,
  nextSeq,
  normalizeBic,
  refCheck,
  textHash,
  type MandateKind,
  type MandateStatus,
  type Scheme,
  type SepaSettings,
} from './sepa-model.js';

/**
 * The database side of SEPA mandates (docs/sepa.md): settings per sub-account, the creditor data, paper and online mandates
 * (pending → active with proof), revoke / suspend / reactivate, the 36-month expiry and what the API shows of a mandate.
 */

export const todayOf = (app: App, loc: string) => ymdInTz(new Date(), app.location(loc)?.timezone || 'Europe/Berlin');
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// --- settings ---------------------------------------------------------------------------------------------------------------

export function settingsOf(app: App, loc: string): SepaSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM sepa_settings WHERE location_id = ?', loc);
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return cleanSettings(JSON.parse(row.data), DEFAULT_SETTINGS);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(app: App, loc: string, patch: Record<string, any>): SepaSettings {
  let next: SepaSettings;
  try {
    next = cleanSettings(patch ?? {}, settingsOf(app, loc));
  } catch (e) {
    throw bad((e as Error).message);
  }
  app.db.run('INSERT INTO sepa_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', loc, JSON.stringify(next), now());
  return next;
}

export interface Creditor {
  name: string;
  address: string;
  creditor_id: string;
  iban: string;
  bic: string;
  /** What keeps the sub-account from collecting (German, for the page). */
  problems: string[];
}

/** Who collects: the SEPA settings, falling back to sender and bank of the invoice settings. */
export function creditorOf(app: App, loc: string, s: SepaSettings = settingsOf(app, loc)): Creditor {
  const { seller, bank } = sellerOf(app, loc);
  const iban = s.iban || bank.iban;
  const out: Creditor = {
    name: s.creditor_name || seller.name,
    address: [seller.street, [seller.postal_code, seller.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    creditor_id: s.creditor_id,
    iban,
    bic: s.iban ? s.bic : s.bic || bank.bic,
    problems: [],
  };
  if (!out.creditor_id) out.problems.push('Gläubiger-ID fehlt (SEPA → Einstellungen)');
  else if (!creditorIdCheck(out.creditor_id).valid) out.problems.push('Die Gläubiger-ID ist ungültig');
  const i = ibanInfo(iban);
  if (!i.ok) out.problems.push(iban ? `Empfänger-Konto: ${i.reason}` : 'Empfänger-IBAN fehlt (SEPA → Einstellungen oder Rechnungs-Einstellungen)');
  if (!out.name) out.problems.push('Name des Zahlungsempfängers fehlt');
  return out;
}

// --- mandates ---------------------------------------------------------------------------------------------------------------------

export interface MandateRow {
  id: string;
  location_id: string;
  contact_id: string | null;
  reference: string;
  scheme: Scheme;
  kind: MandateKind;
  status: MandateStatus;
  holder: string;
  iban: string;
  bic: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  signed_at: string | null;
  signed_place: string;
  source: string;
  capture_token: string | null;
  capture_expires_at: string | null;
  text: string;
  text_hash: string;
  proof: string;
  final_next: number;
  first_used_at: string | null;
  last_used_at: string | null;
  ended_at: string | null;
  end_reason: string;
  note: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const getMandate = (app: App, loc: string, mandateId: string): MandateRow | undefined =>
  app.db.get<MandateRow>('SELECT * FROM sepa_mandates WHERE id = ? AND location_id = ?', mandateId, loc);

export function mustMandate(app: App, loc: string, mandateId: string): MandateRow {
  const m = getMandate(app, loc, mandateId);
  if (!m) throw notFound('Mandat nicht gefunden');
  return m;
}

/** Whether a collection under this mandate went to the bank and was not returned (decides FRST vs RCUR). */
export const mandateUsed = (app: App, mandateId: string): boolean => !!app.db.get(`SELECT 1 AS x FROM sepa_items WHERE mandate_id = ? AND status IN ('submitted', 'paid') LIMIT 1`, mandateId);

export const captureUrl = (app: App, t: string) => `${app.baseUrl()}/sepa/m/${encodeURIComponent(t)}`;

export function mandateOut(app: App, m: MandateRow, opts: { today?: string; full?: boolean; used?: boolean; contact?: { first_name?: string; last_name?: string; company?: string; email?: string } | null } = {}) {
  const today = opts.today ?? todayOf(app, m.location_id);
  const status = effectiveStatus(m, today);
  const seq = nextSeq(m, opts.used ?? mandateUsed(app, m.id));
  const c = opts.contact !== undefined ? opts.contact : m.contact_id ? getContact(app, m.location_id, m.contact_id) : null;
  const live = m.status === 'pending' && !!m.capture_token && !!m.capture_expires_at && m.capture_expires_at > now();
  let proof: Record<string, unknown> = {};
  try {
    proof = JSON.parse(m.proof || '{}');
  } catch {
    proof = {};
  }
  return {
    id: m.id,
    contact_id: m.contact_id,
    contact: c ? { id: m.contact_id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || c.email || 'Kontakt', company: c.company ?? '', email: c.email ?? '' } : null,
    reference: m.reference,
    scheme: m.scheme,
    scheme_label: SCHEME_LABELS[m.scheme] ?? m.scheme,
    kind: m.kind,
    kind_label: KIND_LABELS[m.kind] ?? m.kind,
    status,
    status_label: STATUS_LABELS[status] ?? status,
    holder: m.holder,
    iban: opts.full ? m.iban : maskIban(m.iban),
    iban_masked: maskIban(m.iban),
    bic: m.bic,
    ...(opts.full ? { street: m.street, postal_code: m.postal_code, city: m.city, country: m.country } : {}),
    signed_at: m.signed_at,
    signed_place: m.signed_place,
    source: m.source,
    next_seq: status === 'active' ? seq : null,
    next_seq_label: status === 'active' ? SEQ_LABELS[seq] : '',
    final_next: !!m.final_next,
    first_used_at: m.first_used_at,
    last_used_at: m.last_used_at,
    expires_on: m.status === 'active' || m.status === 'expired' ? expiresOn(m) : null,
    ended_at: m.ended_at,
    end_reason: m.end_reason,
    note: m.note,
    capture_url: live ? captureUrl(app, m.capture_token!) : '',
    capture_expires_at: m.status === 'pending' ? m.capture_expires_at : null,
    ...(opts.full ? { text: m.text, text_hash: m.text_hash, proof } : {}),
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

/** The next free reference "M-2026-000001" (counter per sub-account, skips taken ones). */
export function nextReference(app: App, loc: string, s: SepaSettings = settingsOf(app, loc)): string {
  const year = todayOf(app, loc).slice(0, 4);
  return app.db.tx(() => {
    app.db.run(`INSERT INTO sepa_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO NOTHING`, loc, JSON.stringify(s), now());
    for (let i = 0; i < 1000; i++) {
      app.db.run('UPDATE sepa_settings SET ref_seq = ref_seq + 1 WHERE location_id = ?', loc);
      const seq = app.db.get<{ ref_seq: number }>('SELECT ref_seq FROM sepa_settings WHERE location_id = ?', loc)!.ref_seq;
      const ref = makeRef(s.mandate_prefix, year, seq);
      if (!app.db.get('SELECT 1 AS x FROM sepa_mandates WHERE location_id = ? AND reference = ?', loc, ref)) return ref;
    }
    throw new HttpError(409, 'Keine freie Mandatsreferenz gefunden – bitte eine eigene angeben');
  });
}

function takeReference(app: App, loc: string, raw: unknown, s: SepaSettings): string {
  if (raw === undefined || raw === null || String(raw).trim() === '') return nextReference(app, loc, s);
  const r = refCheck(raw);
  if (!r.valid) throw bad(r.reason!);
  if (app.db.get('SELECT 1 AS x FROM sepa_mandates WHERE location_id = ? AND reference = ?', loc, r.ref)) throw new HttpError(409, `Die Mandatsreferenz ${r.ref} ist schon vergeben`);
  return r.ref;
}

export interface AccountInput {
  holder?: unknown;
  iban?: unknown;
  bic?: unknown;
  street?: unknown;
  postal_code?: unknown;
  city?: unknown;
  country?: unknown;
}

/** Holder, IBAN, optional BIC and address of the debtor – validated (BIC and town/country are mandatory outside the EEA). */
export function cleanAccount(i: AccountInput): { holder: string; iban: string; bic: string; street: string; postal_code: string; city: string; country: string } {
  const holder = clip(i.holder, 70);
  if (!holder) throw bad('Bitte den Namen des Kontoinhabers angeben');
  const info = ibanInfo(i.iban);
  if (!info.ok) throw bad(info.reason!);
  const bic = normalizeBic(i.bic);
  if (bic && !checkBic(bic)) throw bad('Die BIC ist ungültig (8 oder 11 Zeichen)');
  if (info.bicRequired && !bic) throw bad(`Für Konten aus ${info.country} ist die BIC Pflicht`);
  const country = String(i.country ?? '').trim().toUpperCase().slice(0, 2) || (NON_EEA.includes(info.country) ? info.country : '');
  const city = clip(i.city, 35);
  if (info.bicRequired && (!city || !country)) throw bad(`Für Konten aus ${info.country} sind Ort und Land des Kontoinhabers Pflicht`);
  if (country && !/^[A-Z]{2}$/.test(country)) throw bad('Land: zweistelliger Ländercode (z. B. DE)');
  return { holder, iban: info.iban, bic, street: clip(i.street, 70), postal_code: clip(i.postal_code, 16), city, country };
}

function contactOrFail(app: App, loc: string, contactId: unknown) {
  const c = typeof contactId === 'string' && contactId ? getContact(app, loc, contactId) : undefined;
  if (!c) throw bad('Bitte einen Kontakt wählen');
  return c;
}

const textFor = (app: App, loc: string, s: SepaSettings, ref: string, scheme: Scheme, kind: MandateKind) => {
  const cr = creditorOf(app, loc, s);
  return mandateText({ creditor_name: cr.name, creditor_address: cr.address, creditor_id: cr.creditor_id || '(Gläubiger-ID folgt)', reference: ref, scheme, kind, prenotify_days: s.prenotify_days });
};

/** A mandate signed on paper (or imported): active at once. */
export function createMandate(app: App, loc: string, body: Record<string, any>, userId: string | null): MandateRow {
  const s = settingsOf(app, loc);
  const c = contactOrFail(app, loc, body.contact_id);
  const scheme: Scheme = body.scheme === undefined ? s.default_scheme : isScheme(body.scheme) ? body.scheme : (() => { throw bad('Lastschriftart: CORE oder B2B'); })();
  const kind: MandateKind = body.kind === undefined ? 'RCUR' : isKind(body.kind) ? body.kind : (() => { throw bad('Mandatsart: RCUR (wiederkehrend) oder OOFF (einmalig)'); })();
  const acc = cleanAccount(body);
  if (!isYmd(body.signed_at)) throw bad('Bitte das Datum der Unterschrift angeben (JJJJ-MM-TT)');
  if (body.signed_at > todayOf(app, loc)) throw bad('Das Datum der Unterschrift liegt in der Zukunft');
  const ref = takeReference(app, loc, body.reference, s);
  const text = textFor(app, loc, s, ref, scheme, kind);
  const t = now();
  const row = {
    id: id(),
    location_id: loc,
    contact_id: c.id,
    reference: ref,
    scheme,
    kind,
    status: 'active',
    ...acc,
    signed_at: body.signed_at,
    signed_place: clip(body.signed_place, 60),
    source: body.source === 'import' ? 'import' : 'paper',
    text,
    text_hash: textHash(text),
    proof: JSON.stringify({ method: body.source === 'import' ? 'import' : 'paper', recorded_at: t, recorded_by: userId }),
    note: clip(body.note, 500),
    created_by: userId,
    created_at: t,
    updated_at: t,
  };
  app.db.insert('sepa_mandates', row);
  logActivity(app, loc, c.id, 'sepa.mandate', `SEPA-Mandat ${ref} erfasst (${SCHEME_LABELS[scheme]}, ${KIND_LABELS[kind].toLowerCase()})`);
  app.events.emit(loc, 'sepa.mandate_signed', { contactId: c.id, mandate: { id: row.id, reference: ref, scheme, kind, source: row.source } });
  return mustMandate(app, loc, row.id);
}

/** An online mandate: a pending row with a link the person opens to enter the account and agree (modules/sepa-public.ts). */
export function requestMandate(app: App, loc: string, body: Record<string, any>, userId: string | null): MandateRow {
  const s = settingsOf(app, loc);
  const cr = creditorOf(app, loc, s);
  if (!cr.creditor_id) throw bad('Für ein Online-Mandat zuerst die Gläubiger-ID eintragen (SEPA → Einstellungen)');
  const c = contactOrFail(app, loc, body.contact_id);
  const scheme: Scheme = body.scheme === undefined ? s.default_scheme : isScheme(body.scheme) ? body.scheme : (() => { throw bad('Lastschriftart: CORE oder B2B'); })();
  const kind: MandateKind = body.kind === undefined ? 'RCUR' : isKind(body.kind) ? body.kind : (() => { throw bad('Mandatsart: RCUR oder OOFF'); })();
  const ref = takeReference(app, loc, body.reference, s);
  const t = now();
  const row = {
    id: id(),
    location_id: loc,
    contact_id: c.id,
    reference: ref,
    scheme,
    kind,
    status: 'pending',
    holder: clip(scheme === 'B2B' && c.company ? c.company : [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company, 70),
    source: 'online',
    capture_token: token(24),
    capture_expires_at: new Date(Date.now() + s.capture_days * 864e5).toISOString(),
    note: clip(body.note, 500),
    created_by: userId,
    created_at: t,
    updated_at: t,
  };
  app.db.insert('sepa_mandates', row);
  logActivity(app, loc, c.id, 'sepa.mandate', `Online-SEPA-Mandat ${ref} angefordert`);
  return mustMandate(app, loc, row.id);
}

/** A new link for a pending mandate (the old one stops working). */
export function renewLink(app: App, loc: string, mandateId: string): MandateRow {
  const m = mustMandate(app, loc, mandateId);
  if (m.status !== 'pending') throw new HttpError(409, 'Nur für Mandate, die noch auf die Unterschrift warten');
  const s = settingsOf(app, loc);
  app.db.run('UPDATE sepa_mandates SET capture_token = ?, capture_expires_at = ?, updated_at = ? WHERE id = ?', token(24), new Date(Date.now() + s.capture_days * 864e5).toISOString(), now(), m.id);
  return mustMandate(app, loc, m.id);
}

export interface SignInput extends AccountInput {
  signed_place?: unknown;
}

/** The person agreed on the public page: account, text and proof (time, IP network, browser fingerprint, SHA-256 of the text). */
export function signOnline(app: App, m: MandateRow, input: SignInput, proof: { ip_net: string; ua_digest: string; url: string }): MandateRow {
  if (m.status !== 'pending') throw new HttpError(409, 'Dieses Mandat wurde schon erteilt oder ist nicht mehr gültig');
  const loc = m.location_id;
  const s = settingsOf(app, loc);
  const acc = cleanAccount(input);
  const text = textFor(app, loc, s, m.reference, m.scheme, m.kind);
  const hash = textHash(text);
  const t = now();
  const changed = app.db.run(
    `UPDATE sepa_mandates SET status = 'active', holder = ?, iban = ?, bic = ?, street = ?, postal_code = ?, city = ?, country = ?, signed_at = ?, signed_place = ?,
       text = ?, text_hash = ?, proof = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    acc.holder, acc.iban, acc.bic, acc.street, acc.postal_code, acc.city, acc.country, todayOf(app, loc), clip(input.signed_place, 60),
    text, hash, JSON.stringify({ method: 'online', signed_at: t, ip_net: proof.ip_net, ua_digest: proof.ua_digest, text_hash: hash, page: proof.url }), t, m.id,
  ).changes;
  if (!changed) throw new HttpError(409, 'Dieses Mandat wurde schon erteilt');
  const out = mustMandate(app, loc, m.id);
  if (out.contact_id) logActivity(app, loc, out.contact_id, 'sepa.mandate', `SEPA-Mandat ${out.reference} online erteilt (${maskIban(out.iban)})`);
  app.events.emit(loc, 'sepa.mandate_signed', { contactId: out.contact_id, mandate: { id: out.id, reference: out.reference, scheme: out.scheme, kind: out.kind, source: 'online' } });
  return out;
}

/** Changes that do not touch what was agreed: note, "next collection is the last", and – before the first use – holder/BIC. */
export function patchMandate(app: App, loc: string, mandateId: string, body: Record<string, any>): MandateRow {
  const m = mustMandate(app, loc, mandateId);
  const patch: Record<string, any> = { updated_at: now() };
  if (body.note !== undefined) patch.note = clip(body.note, 500);
  if (body.final_next !== undefined) {
    if (m.kind === 'OOFF') throw bad('Ein Einmal-Mandat hat keine Folgelastschriften');
    patch.final_next = body.final_next ? 1 : 0;
  }
  if (body.holder !== undefined || body.bic !== undefined) {
    if (mandateUsed(app, m.id)) throw new HttpError(409, 'Nach dem ersten Einzug lassen sich Kontodaten nicht mehr ändern – bitte ein neues Mandat erfassen');
    if (m.status === 'pending') throw new HttpError(409, 'Die Kontodaten trägt der Kontoinhaber über den Link ein');
    const acc = cleanAccount({ holder: body.holder ?? m.holder, iban: m.iban, bic: body.bic ?? m.bic, street: m.street, postal_code: m.postal_code, city: m.city, country: m.country });
    patch.holder = acc.holder;
    patch.bic = acc.bic;
  }
  app.db.update('sepa_mandates', m.id, patch, loc);
  return mustMandate(app, loc, m.id);
}

export function endMandate(app: App, loc: string, mandateId: string, status: 'revoked' | 'suspended', reason: string): MandateRow {
  const m = mustMandate(app, loc, mandateId);
  if (status === 'suspended' && m.status !== 'active') return m;
  if (['revoked', 'used', 'final'].includes(m.status) && status === 'revoked') throw new HttpError(409, 'Dieses Mandat ist schon beendet');
  const t = now();
  app.db.run(`UPDATE sepa_mandates SET status = ?, ended_at = ?, end_reason = ?, capture_token = CASE WHEN ? = 'revoked' THEN NULL ELSE capture_token END, updated_at = ? WHERE id = ?`, status, t, clip(reason, 300), status, t, m.id);
  if (m.contact_id) logActivity(app, loc, m.contact_id, 'sepa.mandate', `SEPA-Mandat ${m.reference} ${status === 'revoked' ? 'widerrufen' : 'gesperrt'}${reason ? `: ${clip(reason, 120)}` : ''}`);
  return mustMandate(app, loc, m.id);
}

export function reactivateMandate(app: App, loc: string, mandateId: string): MandateRow {
  const m = mustMandate(app, loc, mandateId);
  if (m.status !== 'suspended') throw new HttpError(409, 'Nur gesperrte Mandate lassen sich wieder freigeben');
  if (effectiveStatus({ ...m, status: 'active' }, todayOf(app, loc)) === 'expired') throw new HttpError(409, 'Das Mandat ist abgelaufen (36 Monate ohne Einzug) – bitte ein neues erfassen');
  app.db.run(`UPDATE sepa_mandates SET status = 'active', ended_at = NULL, end_reason = '', updated_at = ? WHERE id = ?`, now(), m.id);
  return mustMandate(app, loc, m.id);
}

/** Marks active mandates as expired once 36 months passed without a collection (one statement for all sub-accounts). */
export function expireSweep(app: App, todayUtc: string): number {
  const cutoff = (() => {
    const [y, mo, d] = todayUtc.split('-').map(Number);
    return new Date(Date.UTC(y - 3, mo - 1, d)).toISOString().slice(0, 10);
  })();
  return app.db.run(
    `UPDATE sepa_mandates SET status = 'expired', ended_at = ?, end_reason = '36 Monate ohne Einzug', updated_at = ? WHERE status = 'active' AND substr(COALESCE(last_used_at, signed_at), 1, 10) <= ?`,
    now(), now(), cutoff,
  ).changes;
}
