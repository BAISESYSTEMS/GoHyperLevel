import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { safeEqual } from '../core/util.js';

/**
 * Consent ledger – the pure part (no database, no HTTP): channels, purposes, how the status of a contact is derived from its
 * events, the send-gate decision, the data minimisation of the proof (IP network, user-agent hash), signed Double-Opt-in
 * links and the sanitised settings. modules/consent.ts stores the events, modules/consent-doi.ts runs the confirmation.
 *
 * Status per channel and purpose is derived, never stored: the events are the truth.
 *   unknown   – nothing recorded (or reset / expired / declined), see `legacy`
 *   pending   – consent given but the Double-Opt-in confirmation is outstanding (and not expired)
 *   confirmed – consent given (and confirmed, where Double-Opt-in was required)
 *   revoked   – withdrawn, or the contact has "Nicht stören" (DND = revoked for every communication channel)
 */

export const CHANNELS = ['email', 'sms', 'whatsapp', 'phone', 'tracking'] as const;
export type ConsentChannel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<ConsentChannel, string> = { email: 'E-Mail', sms: 'SMS', whatsapp: 'WhatsApp', phone: 'Telefon', tracking: 'Tracking & Cookies' };

export const PURPOSES = ['newsletter', 'marketing', 'webinar', 'community', 'transactional', 'statistics', 'external_media'] as const;
export type ConsentPurpose = (typeof PURPOSES)[number];
export const PURPOSE_LABEL: Record<ConsentPurpose, string> = {
  newsletter: 'Newsletter',
  marketing: 'Werbung & Angebote',
  webinar: 'Webinar-Hinweise',
  community: 'Community-Nachrichten',
  transactional: 'Service & Vertrag',
  statistics: 'Statistik',
  external_media: 'Externe Medien',
};

/** Which purposes make sense on which channel (the preference centre and the manual form offer exactly these). */
export const CHANNEL_PURPOSES: Record<ConsentChannel, ConsentPurpose[]> = {
  email: ['newsletter', 'marketing', 'webinar', 'community', 'transactional'],
  sms: ['marketing', 'webinar', 'transactional'],
  whatsapp: ['marketing', 'webinar', 'transactional'],
  phone: ['marketing'],
  tracking: ['statistics', 'marketing', 'external_media'],
};

/** What counts as "may I send advertising here" on a channel: any of these confirmed is enough. */
export const GATE_PURPOSES: Record<ConsentChannel, ConsentPurpose[]> = {
  email: ['newsletter', 'marketing'],
  sms: ['marketing'],
  whatsapp: ['marketing'],
  phone: ['marketing'],
  tracking: ['statistics', 'marketing', 'external_media'],
};

export const ACTIONS = ['granted', 'confirmed', 'revoked', 'declined', 'expired', 'reset', 'legacy'] as const;
export type ConsentAction = (typeof ACTIONS)[number];
export const ACTION_LABEL: Record<ConsentAction, string> = {
  granted: 'Einwilligung erteilt',
  confirmed: 'Bestätigt (Double-Opt-in)',
  revoked: 'Widerrufen',
  declined: 'Abgelehnt',
  expired: 'Bestätigung abgelaufen',
  reset: 'Zurückgesetzt',
  legacy: 'Altbestand (ohne Nachweis)',
};

export const SOURCE_KINDS = ['form', 'funnel', 'webinar', 'community', 'import', 'api', 'manual', 'unsubscribe', 'preferences', 'doi', 'checkout', 'cmp', 'system'] as const;
export const SOURCE_LABEL: Record<string, string> = {
  form: 'Formular',
  funnel: 'Funnel',
  webinar: 'Webinar',
  community: 'Community',
  import: 'Import',
  api: 'API',
  manual: 'Manuell',
  unsubscribe: 'Abmeldelink',
  preferences: 'Einstellungsseite',
  doi: 'Bestätigungslink',
  checkout: 'Bestellung',
  cmp: 'Cookie-Banner',
  system: 'System',
};

export type Status = 'unknown' | 'pending' | 'confirmed' | 'revoked';
export const STATUS_LABEL: Record<Status, string> = { unknown: 'Unbekannt', pending: 'Bestätigung offen', confirmed: 'Bestätigt', revoked: 'Widerrufen' };

/** The fields of a stored event that decide the status. */
export interface LedgerEvent {
  id: string;
  channel: string;
  /** A purpose, or '*' (revoke / reset for every purpose of the channel). */
  purpose: string;
  action: ConsentAction;
  doi_required: number;
  expires_at: string | null;
  created_at: string;
}

export interface PurposeState {
  status: Status;
  /** unknown with no history of its own: contacts from before the ledger, imports without proof. */
  legacy: boolean;
  /** Why (German, short): "Bestätigung abgelaufen", "Nicht stören aktiv", … */
  reason: string;
  since: string | null;
  event_id: string | null;
  expires_at: string | null;
}

const blank = (): PurposeState => ({ status: 'unknown', legacy: true, reason: '', since: null, event_id: null, expires_at: null });

/** Status of one channel × purpose from the events (oldest first; ties keep the given order). */
export function derivePurpose(events: LedgerEvent[], channel: string, purpose: string, nowMs = Date.now()): PurposeState {
  let s = blank();
  for (const e of [...events].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))) {
    if (e.channel !== channel || (e.purpose !== purpose && e.purpose !== '*')) continue;
    const at = { since: e.created_at, event_id: e.id };
    switch (e.action) {
      case 'granted':
        s = e.doi_required ? { status: 'pending', legacy: false, reason: 'Double-Opt-in ausstehend', expires_at: e.expires_at, ...at } : { status: 'confirmed', legacy: false, reason: '', expires_at: null, ...at };
        break;
      case 'confirmed':
        s = { status: 'confirmed', legacy: false, reason: '', expires_at: null, ...at };
        break;
      case 'revoked':
        s = { status: 'revoked', legacy: false, reason: 'Widerrufen', expires_at: null, ...at };
        break;
      case 'declined':
        s = { status: 'unknown', legacy: false, reason: 'Abgelehnt', expires_at: null, ...at };
        break;
      case 'expired':
        s = { status: 'unknown', legacy: false, reason: 'Bestätigung abgelaufen', expires_at: null, ...at };
        break;
      case 'reset':
      case 'legacy':
        s = { status: 'unknown', legacy: true, reason: e.action === 'reset' ? 'Zurückgesetzt (ohne Nachweis)' : 'Altbestand (ohne Nachweis)', expires_at: null, ...at };
        break;
    }
  }
  // A pending confirmation that ran out counts as nothing – and is not "legacy": the person never said yes.
  if (s.status === 'pending' && s.expires_at && Date.parse(s.expires_at) <= nowMs) s = { ...s, status: 'unknown', legacy: false, reason: 'Bestätigung abgelaufen', expires_at: null };
  return s;
}

const RANK: Record<Status, number> = { confirmed: 3, pending: 2, revoked: 1, unknown: 0 };

/** The best of several purposes (confirmed beats pending beats revoked beats unknown); legacy only when all of them are. */
export function aggregate(states: PurposeState[]): PurposeState {
  if (!states.length) return blank();
  const best = [...states].sort((a, b) => RANK[b.status] - RANK[a.status] || (b.since ?? '').localeCompare(a.since ?? ''))[0];
  const legacy = best.status === 'unknown' ? states.every((x) => x.legacy) : false;
  return { ...best, legacy };
}

export interface ChannelState extends PurposeState {
  purposes: Record<string, PurposeState>;
}

export interface DeriveOptions {
  /** The contact's "Nicht stören": revoked for every communication channel. */
  dnd?: boolean;
  nowMs?: number;
}

/** Status of one channel: per purpose, and `aggregate` over the purposes that count for advertising. */
export function deriveChannel(events: LedgerEvent[], channel: ConsentChannel, opts: DeriveOptions = {}): ChannelState {
  const nowMs = opts.nowMs ?? Date.now();
  const purposes: Record<string, PurposeState> = {};
  for (const p of CHANNEL_PURPOSES[channel]) purposes[p] = derivePurpose(events, channel, p, nowMs);
  let top = aggregate(GATE_PURPOSES[channel].map((p) => purposes[p] ?? derivePurpose(events, channel, p, nowMs)));
  if (opts.dnd && channel !== 'tracking') {
    top = { status: 'revoked', legacy: false, reason: 'Nicht stören (DND) aktiv', since: top.since, event_id: top.event_id, expires_at: null };
    for (const p of Object.keys(purposes)) if (p !== 'transactional') purposes[p] = { ...purposes[p], status: 'revoked', legacy: false, reason: 'Nicht stören (DND) aktiv', expires_at: null };
  }
  return { ...top, purposes };
}

/** Every channel at once. */
export function deriveAll(events: LedgerEvent[], opts: DeriveOptions = {}): Record<ConsentChannel, ChannelState> {
  return Object.fromEntries(CHANNELS.map((c) => [c, deriveChannel(events, c, opts)])) as Record<ConsentChannel, ChannelState>;
}

export type SendPolicy = 'legacy' | 'confirmed';
export interface GateResult {
  allow: boolean;
  /** Why it was allowed: confirmed consent, or an old contact without proof (policy "legacy"). */
  basis: 'confirmed' | 'legacy' | '';
  /** German reason when blocked. */
  reason: string;
}

/** The send gate: may advertising go to a contact whose channel has this state? */
export function gateDecision(state: Pick<PurposeState, 'status' | 'legacy' | 'reason'>, policy: SendPolicy): GateResult {
  switch (state.status) {
    case 'confirmed':
      return { allow: true, basis: 'confirmed', reason: '' };
    case 'pending':
      return { allow: false, basis: '', reason: 'Einwilligung noch nicht bestätigt (Double-Opt-in ausstehend)' };
    case 'revoked':
      return { allow: false, basis: '', reason: state.reason && state.reason !== 'Widerrufen' ? `Keine Werbung erlaubt: ${state.reason}` : 'Einwilligung widerrufen' };
    default:
      if (state.legacy && policy === 'legacy') return { allow: true, basis: 'legacy', reason: '' };
      if (state.legacy) return { allow: false, basis: '', reason: 'Keine nachgewiesene Einwilligung (nur bestätigte Kontakte)' };
      return { allow: false, basis: '', reason: state.reason === 'Bestätigung abgelaufen' ? 'Bestätigung der Einwilligung abgelaufen' : 'Keine gültige Einwilligung' };
  }
}

// --- proof data, minimised ---------------------------------------------------------------------------------------------

/** The IP network only: /24 for IPv4, /48 for IPv6 (enough as evidence, not enough to identify a person). '' for anything else. */
export function ipNetwork(ip: unknown): string {
  let s = String(ip ?? '').trim();
  if (!s) return '';
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) s = mapped[1];
  s = s.replace(/%.*$/, '');
  const v = isIP(s);
  if (v === 4) {
    const p = s.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (v === 6) {
    const g = expandV6(s);
    return g ? `${g[0]}:${g[1]}:${g[2]}::/48` : '';
  }
  return '';
}

/** The eight 16-bit groups of an IPv6 address as short hex strings; null when it does not parse. */
function expandV6(s: string): string[] | null {
  let addr = s.toLowerCase();
  const tail = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const q = tail[1].split('.').map(Number);
    if (q.some((n) => n > 255)) return null;
    addr = addr.slice(0, -tail[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => x.replace(/^0+(?=.)/, ''));
}

/** A short fingerprint of the browser string – proves "same browser" without keeping the string. */
export function uaHash(ua: unknown): string {
  const s = String(ua ?? '').trim().slice(0, 500);
  return s ? createHash('sha256').update(s).digest('hex').slice(0, 16) : '';
}

const normText = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Fingerprint of a consent text (whitespace-insensitive): the same wording is the same version. */
export function textDigest(text: string): string {
  return createHash('sha256').update(normText(text)).digest('hex').slice(0, 24);
}
export { normText };

// --- signed links --------------------------------------------------------------------------------------------------

/** `<id>.<expiry in seconds, base36>.<signature>` – the Double-Opt-in link; the row in consent_doi is still the authority. */
export function signDoi(secret: string, doiId: string, expiresAtMs: number): string {
  const exp = Math.floor(expiresAtMs / 1000).toString(36);
  return `${doiId}.${exp}.${createHmac('sha256', `${secret}:consent-doi`).update(`${doiId}.${exp}`).digest('base64url').slice(0, 24)}`;
}

/** The DOI id of a valid signature (expired = the signature is fine but the time has run out); null for anything forged. */
export function verifyDoi(secret: string, token: unknown, nowMs = Date.now()): { id: string; expired: boolean } | null {
  const m = String(token ?? '').match(/^([A-Za-z0-9]{8,40})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{24})$/);
  if (!m) return null;
  const want = createHmac('sha256', `${secret}:consent-doi`).update(`${m[1]}.${m[2]}`).digest('base64url').slice(0, 24);
  if (!safeEqual(want, m[3])) return null;
  return { id: m[1], expired: parseInt(m[2], 36) * 1000 <= nowMs };
}

/** The link of the preference centre in the footer of every mail (same idea as the unsubscribe link: a signature over the contact). */
export function prefToken(secret: string, contactId: string): string {
  return createHmac('sha256', `${secret}:consent-prefs`).update(contactId).digest('hex').slice(0, 24);
}

// --- settings --------------------------------------------------------------------------------------------------------

export const DOI_SOURCES = ['form', 'funnel', 'webinar', 'community', 'import', 'api'] as const;
export type DoiSource = (typeof DOI_SOURCES)[number];
export const DOI_SOURCE_LABEL: Record<DoiSource, string> = { form: 'Formulare', funnel: 'Funnels & Websites', webinar: 'Webinar-Anmeldung', community: 'Community-Anmeldung', import: 'Importe', api: 'API' };

export interface ConsentSettings {
  /** legacy: confirmed + contacts from before the ledger; confirmed: only proven consent. */
  policy: SendPolicy;
  doi: {
    sources: Record<DoiSource, boolean>;
    reminder_hours: number;
    expiry_hours: number;
    subject: string;
    body: string;
    page: { title: string; text: string; button: string; success_title: string; success_text: string; expired_title: string; expired_text: string; redirect_url: string };
  };
  /** Link to the preference centre in the footer of the mails. */
  footer_link: boolean;
  /** When the policy was last changed (shown next to the proof). */
  policy_changed_at?: string;
}

export const DEFAULT_DOI_SUBJECT = 'Bitte bestätige deine Anmeldung bei {{location.name}}';
export const DEFAULT_DOI_BODY = `Hallo {{contact.first_name|}},

bitte bestätige mit einem Klick, dass {{location.name}} dir {{purpose_text}} per E-Mail schicken darf:

{{confirm_url}}

Der Link gilt bis {{expires}}. Wenn du dich nicht angemeldet hast, ignoriere diese E-Mail einfach – dann passiert nichts und du bekommst keine weitere Nachricht von uns.

Das hast du angefragt: „{{consent_text}}“`;

export const DEFAULT_CONSENT: ConsentSettings = {
  policy: 'legacy',
  doi: {
    sources: { form: true, funnel: true, webinar: false, community: false, import: false, api: false },
    reminder_hours: 48,
    expiry_hours: 168,
    subject: DEFAULT_DOI_SUBJECT,
    body: DEFAULT_DOI_BODY,
    page: {
      title: 'Anmeldung bestätigen',
      text: 'Ein Klick noch: Bestätige, dass du {{purpose_text}} von {{location.name}} erhalten möchtest.',
      button: 'Ja, Anmeldung bestätigen',
      success_title: 'Danke, das hat geklappt!',
      success_text: 'Deine Anmeldung ist bestätigt. Du kannst sie jederzeit über den Link in jeder E-Mail widerrufen.',
      expired_title: 'Der Link ist abgelaufen',
      expired_text: 'Diese Bestätigung ist nicht mehr gültig. Bitte melde dich noch einmal an.',
      redirect_url: '',
    },
  },
  footer_link: true,
};

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const text = (v: unknown, d: string, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : d);

/** A redirect after confirming: https/http only (or empty). */
export const safeRedirect = (v: unknown) => (/^https?:\/\/[^\s"'<>]{3,500}$/i.test(String(v ?? '').trim()) ? String(v).trim() : '');

/** Stored settings (anything a client could have written) → complete, clamped settings. */
export function cleanConsentSettings(raw: unknown): ConsentSettings {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const d: any = r.doi && typeof r.doi === 'object' ? r.doi : {};
  const p: any = d.page && typeof d.page === 'object' ? d.page : {};
  const D = DEFAULT_CONSENT.doi;
  const sources = { ...D.sources };
  for (const k of DOI_SOURCES) if (d.sources && typeof d.sources[k] === 'boolean') sources[k] = d.sources[k];
  return {
    policy: r.policy === 'confirmed' ? 'confirmed' : 'legacy',
    doi: {
      sources,
      reminder_hours: clampInt(d.reminder_hours, 0, 24 * 30, D.reminder_hours),
      expiry_hours: clampInt(d.expiry_hours, 1, 24 * 90, D.expiry_hours),
      subject: text(d.subject, D.subject, 200),
      body: text(d.body, D.body, 4000),
      page: {
        title: text(p.title, D.page.title, 120),
        text: text(p.text, D.page.text, 600),
        button: text(p.button, D.page.button, 60),
        success_title: text(p.success_title, D.page.success_title, 120),
        success_text: text(p.success_text, D.page.success_text, 600),
        expired_title: text(p.expired_title, D.page.expired_title, 120),
        expired_text: text(p.expired_text, D.page.expired_text, 600),
        redirect_url: safeRedirect(p.redirect_url),
      },
    },
    footer_link: r.footer_link === false ? false : true,
    ...(typeof r.policy_changed_at === 'string' ? { policy_changed_at: r.policy_changed_at.slice(0, 40) } : {}),
  };
}

/** "dir den Newsletter" / "dir Angebote" … for the sentence in the confirmation mail and page. */
export function purposeSentence(purposes: string[]): string {
  const has = (p: string) => purposes.includes(p);
  const parts: string[] = [];
  if (has('newsletter')) parts.push('unseren Newsletter');
  if (has('marketing')) parts.push('Angebote und Neuigkeiten');
  if (has('webinar')) parts.push('Hinweise zum Webinar');
  if (has('community')) parts.push('Nachrichten aus der Community');
  if (!parts.length) parts.push('Nachrichten');
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}` : parts[0];
}

/** German date (and time) in a zone, for mails and the proof. */
export function deStamp(iso: string | number | Date | null | undefined, tz = 'Europe/Berlin', time = false): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: tz }).format(d);
  } catch {
    return d.toISOString().slice(0, time ? 16 : 10).replace('T', ' ');
  }
}
