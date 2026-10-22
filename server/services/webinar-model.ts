import { createHmac } from 'node:crypto';
import { bad } from '../core/http.js';
import { id as newId, safeEqual, slugify } from '../core/util.js';
import { DEFAULT_SCHEDULE, ScheduleError, cleanSchedule, type Schedule } from './webinar-schedule.js';
import { NO_VIDEO, VideoError, cleanVideo, type VideoSource } from './webinar-video.js';

/**
 * The webinar object: what is stored, its defaults and the validation of everything the editor, the API and the MCP tools
 * send. Pure (no database). The honest-labelling rules live here: the room always says what it is, and the wording can be
 * changed but never into "live".
 */

export interface PollDef {
  id: string;
  at_s: number;
  question: string;
  options: string[];
  multiple: boolean;
  show_results: boolean;
}
export interface ScriptedMessage {
  id: string;
  at_s: number;
  name: string;
  text: string;
}
export interface ReminderDef {
  /** Stable name (24h, 1h, 15m, start, …) – the key under which a sent reminder is remembered. */
  key: string;
  /** Minutes before the start; 0 = at the start. */
  offset_min: number;
  email: boolean;
  sms: boolean;
  subject: string;
  body: string;
  sms_text: string;
}
export type OfferTarget = { type: 'product'; product_id: string } | { type: 'form'; form_id: string } | { type: 'url'; url: string };
export interface OfferDef {
  enabled: boolean;
  at_s: number;
  title: string;
  text: string;
  button_text: string;
  target: OfferTarget;
  /** Seconds the offer stays open after it appeared (0 = no deadline). The deadline is real: afterwards the button no longer works. */
  countdown_s: number;
  show_in_replay: boolean;
}

export interface WebinarSettings {
  registration: {
    headline: string;
    button_text: string;
    consent_text: string;
    ask_phone: boolean;
    phone_required: boolean;
    sms_consent_text: string;
    thanks_text: string;
    /** After registering go here instead of the thank-you page (https). */
    redirect_url: string;
    tags: string[];
    /** Forms of this sub-account that register their senders for the next session. */
    form_ids: string[];
    notify_team: boolean;
  };
  room: {
    label: string;
    replay_label: string;
    waiting_text: string;
    ended_text: string;
    /** A counter of the people really in the room right now. Off by default. */
    show_counter: boolean;
    /** Attendees can send questions to the team (they land in Konversationen). */
    questions: boolean;
    /** Chat messages that appear at a time (always marked as automatic). Off by default. */
    scripted_enabled: boolean;
    scripted: ScriptedMessage[];
    polls: PollDef[];
  };
  offer: OfferDef;
  reminders: { items: ReminderDef[]; confirmation_subject: string; confirmation_body: string };
  replay: { enabled: boolean; hours: number };
  tags: { attended: string[]; missed: string[]; cta: string[]; purchased: string[]; replay: string[] };
}

export interface WebinarInput {
  title: string;
  description: string;
  presenter_name: string;
  presenter_photo: string;
  video: VideoSource;
  duration_s: number;
  status: 'draft' | 'published';
  schedule: Schedule;
  settings: WebinarSettings;
}

// --- defaults -------------------------------------------------------------------------------------

export const DEFAULT_LABEL = 'Automatisiertes Webinar';
export const DEFAULT_REPLAY_LABEL = 'Aufzeichnung';
/** Fixed text on every scripted chat message – not editable. */
export const SCRIPTED_LABEL = 'Automatische Nachricht';

export const DEFAULT_CONFIRMATION_SUBJECT = 'Du bist angemeldet: {{webinar.title}}';
export const DEFAULT_CONFIRMATION_BODY = `Hallo {{contact.first_name|du}},

du bist für das Webinar „{{webinar.title}}“ angemeldet.

Termin: {{session.start_text}}

Hier kommst du in den Webinar-Raum:
{{join_url}}

Zum Kalender hinzufügen:
{{ics_url}}

Falls du nicht kannst, sag den Termin hier ab:
{{cancel_url}}

Das ist ein automatisiertes Webinar: Das Video wird zum Termin abgespielt. Fragen, die du im Raum stellst, beantwortet dir unser Team anschließend per E-Mail.

{{location.name}}`;

const REMINDER_BODY = (when: string) => `Hallo {{contact.first_name|du}},

${when} startet das Webinar „{{webinar.title}}“ ({{session.start_text}}).

Hier geht es zum Webinar-Raum:
{{join_url}}

{{location.name}}`;

export const DEFAULT_REMINDERS: ReminderDef[] = [
  { key: '24h', offset_min: 1440, email: true, sms: false, subject: 'Morgen: {{webinar.title}}', body: REMINDER_BODY('Morgen'), sms_text: '{{webinar.title}} startet morgen, {{session.start_text}}. Raum: {{join_url}}' },
  { key: '1h', offset_min: 60, email: true, sms: false, subject: 'In einer Stunde: {{webinar.title}}', body: REMINDER_BODY('In einer Stunde'), sms_text: '{{webinar.title}} startet in einer Stunde. Raum: {{join_url}}' },
  { key: '15m', offset_min: 15, email: true, sms: false, subject: 'In 15 Minuten: {{webinar.title}}', body: REMINDER_BODY('In 15 Minuten'), sms_text: '{{webinar.title}} startet in 15 Minuten. Raum: {{join_url}}' },
  { key: 'start', offset_min: 0, email: true, sms: false, subject: 'Es geht los: {{webinar.title}}', body: REMINDER_BODY('Jetzt'), sms_text: '{{webinar.title}} startet jetzt. Raum: {{join_url}}' },
];

export const DEFAULT_OFFER: OfferDef = { enabled: false, at_s: 0, title: '', text: '', button_text: 'Zum Angebot', target: { type: 'url', url: '' }, countdown_s: 0, show_in_replay: true };

export function defaultSettings(): WebinarSettings {
  return {
    registration: {
      headline: '',
      button_text: 'Kostenlos anmelden',
      consent_text: 'Ich bin einverstanden, dass meine Angaben zur Anmeldung zum Webinar verarbeitet werden und ich Erinnerungen per E-Mail erhalte. Diese Einwilligung kann ich jederzeit widerrufen.',
      ask_phone: false,
      phone_required: false,
      sms_consent_text: 'Ich möchte zusätzlich per SMS an den Termin erinnert werden.',
      thanks_text: 'Danke, du bist angemeldet! Die Bestätigung mit dem Link zum Webinar-Raum ist unterwegs.',
      redirect_url: '',
      tags: ['webinar-angemeldet'],
      form_ids: [],
      notify_team: false,
    },
    room: {
      label: DEFAULT_LABEL,
      replay_label: DEFAULT_REPLAY_LABEL,
      waiting_text: 'Das Webinar startet gleich. Es ist ein automatisiertes Webinar: Das Video wird zum Termin für alle Angemeldeten abgespielt.',
      ended_text: 'Das Webinar ist beendet. Danke fürs Zuschauen!',
      show_counter: false,
      questions: true,
      scripted_enabled: false,
      scripted: [],
      polls: [],
    },
    offer: JSON.parse(JSON.stringify(DEFAULT_OFFER)),
    reminders: { items: JSON.parse(JSON.stringify(DEFAULT_REMINDERS)), confirmation_subject: DEFAULT_CONFIRMATION_SUBJECT, confirmation_body: DEFAULT_CONFIRMATION_BODY },
    replay: { enabled: true, hours: 48 },
    tags: { attended: ['webinar-teilgenommen'], missed: ['webinar-verpasst'], cta: ['webinar-angebot-geklickt'], purchased: ['webinar-gekauft'], replay: ['webinar-replay'] },
  };
}

// --- validation helpers ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const flag = (v: unknown, fallback: boolean) => (v === undefined || v === null ? fallback : v === true || v === 1 || v === 'true');

function text(v: unknown, what: string, max: number, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  const s = String(v).replace(/\r\n/g, '\n').trim();
  if (s.length > max) throw bad(`${what} ist zu lang (höchstens ${max} Zeichen)`);
  return s;
}
function whole(v: unknown, what: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${what}: Zahl von ${min} bis ${max} erwartet`);
  return Math.round(n);
}

/**
 * What the room may call itself. No "live" in any spelling – an automated webinar must not be presented as a live
 * event (UWG § 5, misleading advertising). The check is deliberately blunt: it also catches "Live-Webinar", "Livestream",
 * "in Echtzeit" and "jetzt live".
 */
export const LIVE_CLAIM = /(?:^|[^a-zäöüß])(?:live(?:[\s-]?stream)?|life[\s-]?stream|echtzeit|real[\s-]?time|direkt[\s-]?(?:ü|ue)bertragung|direkt\s+dabei)(?![a-zäöüß])/i;
export function honestText(v: unknown, what: string, max: number, fallback: string): string {
  const s = text(v, what, max, fallback);
  if (!s) return fallback;
  if (LIVE_CLAIM.test(s)) throw bad(`${what}: Ein automatisiertes Webinar darf nicht als „live“ bezeichnet werden (irreführende Werbung, § 5 UWG). Nimm z. B. „Automatisiertes Webinar“ oder „Webinar“.`);
  return s;
}

const tags = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v)) throw bad(`${what}: Liste erwartet`);
  return [...new Set(v.map((t) => String(t).trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
};
const ids = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v)) throw bad(`${what}: Liste erwartet`);
  return [...new Set(v.map((t) => String(t).trim()).filter((t) => /^[A-Za-z0-9_-]{6,40}$/.test(t)))].slice(0, 20);
};

export function cleanUrl(v: unknown, what: string, opts: { required?: boolean } = {}): string {
  const s = String(v ?? '').trim();
  if (!s) {
    if (opts.required) throw bad(`${what} fehlt`);
    return '';
  }
  if (s.length > 2000) throw bad(`${what} ist zu lang`);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${what}: bitte eine vollständige Adresse mit https:// angeben`);
  }
  if (u.protocol !== 'https:') throw bad(`${what}: nur Adressen mit https:// sind erlaubt`);
  if (u.username || u.password) throw bad(`${what}: Zugangsdaten gehören nicht in die Adresse`);
  return u.href;
}

function cleanPolls(v: unknown, durationS: number): PollDef[] {
  if (!Array.isArray(v)) throw bad('Umfragen: Liste erwartet');
  return v.slice(0, 10).map((p, n) => {
    if (!isObj(p)) throw bad(`Umfrage ${n + 1}: Objekt erwartet`);
    const options = (Array.isArray(p.options) ? p.options : []).map((o: unknown) => String(o ?? '').trim().slice(0, 120)).filter(Boolean).slice(0, 8);
    const question = text(p.question, `Umfrage ${n + 1}: Frage`, 200);
    if (!question) throw bad(`Umfrage ${n + 1}: Frage fehlt`);
    if (options.length < 2) throw bad(`Umfrage ${n + 1}: mindestens zwei Antworten nötig`);
    return { id: /^[A-Za-z0-9]{6,16}$/.test(String(p.id ?? '')) ? String(p.id) : newId(8), at_s: whole(p.at_s, `Umfrage ${n + 1}: Zeitpunkt`, 0, durationS > 0 ? durationS : 86_400, 0), question, options, multiple: flag(p.multiple, false), show_results: flag(p.show_results, true) };
  });
}

function cleanScripted(v: unknown, durationS: number): ScriptedMessage[] {
  if (!Array.isArray(v)) throw bad('Automatische Nachrichten: Liste erwartet');
  return v
    .slice(0, 60)
    .map((m, n) => {
      if (!isObj(m)) throw bad(`Nachricht ${n + 1}: Objekt erwartet`);
      const body = text(m.text, `Nachricht ${n + 1}`, 300);
      if (!body) throw bad(`Nachricht ${n + 1}: Text fehlt`);
      return { id: /^[A-Za-z0-9]{6,16}$/.test(String(m.id ?? '')) ? String(m.id) : newId(8), at_s: whole(m.at_s, `Nachricht ${n + 1}: Zeitpunkt`, 0, durationS > 0 ? durationS : 86_400, 0), name: text(m.name, `Nachricht ${n + 1}: Name`, 40, 'Team') || 'Team', text: body };
    })
    .sort((a, b) => a.at_s - b.at_s);
}

function cleanReminders(v: unknown, base: ReminderDef[]): ReminderDef[] {
  if (!Array.isArray(v)) throw bad('Erinnerungen: Liste erwartet');
  const seen = new Set<string>();
  return v.slice(0, 8).map((r, n) => {
    if (!isObj(r)) throw bad(`Erinnerung ${n + 1}: Objekt erwartet`);
    const offset = whole(r.offset_min, `Erinnerung ${n + 1}: Minuten vor dem Start`, 0, 14 * 1440, 60);
    let key = String(r.key ?? '').replace(/[^\w-]/g, '').slice(0, 20) || `r${offset}`;
    while (seen.has(key)) key = `${key}x`;
    seen.add(key);
    const prev = base.find((b) => b.key === key) ?? DEFAULT_REMINDERS.find((b) => b.key === key) ?? DEFAULT_REMINDERS[1];
    return {
      key,
      offset_min: offset,
      email: flag(r.email, true),
      sms: flag(r.sms, false),
      subject: text(r.subject, `Erinnerung ${n + 1}: Betreff`, 200, prev.subject) || prev.subject,
      body: text(r.body, `Erinnerung ${n + 1}: Text`, 5000, prev.body) || prev.body,
      sms_text: text(r.sms_text, `Erinnerung ${n + 1}: SMS-Text`, 320, prev.sms_text) || prev.sms_text,
    };
  });
}

function cleanOffer(v: unknown, base: OfferDef, durationS: number): OfferDef {
  if (v === undefined) return base;
  if (!isObj(v)) throw bad('Angebot: Objekt erwartet');
  const out: OfferDef = JSON.parse(JSON.stringify(base));
  out.enabled = flag(v.enabled, out.enabled);
  if (v.at_s !== undefined) out.at_s = whole(v.at_s, 'Angebot: Zeitpunkt', 0, durationS > 0 ? durationS : 86_400, out.at_s);
  if (v.title !== undefined) out.title = text(v.title, 'Angebot: Titel', 120);
  if (v.text !== undefined) out.text = text(v.text, 'Angebot: Text', 600);
  if (v.button_text !== undefined) out.button_text = text(v.button_text, 'Angebot: Buttontext', 60, 'Zum Angebot') || 'Zum Angebot';
  if (v.countdown_s !== undefined) out.countdown_s = whole(v.countdown_s, 'Angebot: Frist (Sekunden)', 0, 30 * 86_400, 0);
  if (v.show_in_replay !== undefined) out.show_in_replay = flag(v.show_in_replay, true);
  if (v.target !== undefined) {
    if (!isObj(v.target)) throw bad('Angebot: Ziel fehlt');
    const t = v.target;
    if (t.type === 'product') out.target = { type: 'product', product_id: String(t.product_id ?? '').trim().slice(0, 100) };
    else if (t.type === 'form') out.target = { type: 'form', form_id: String(t.form_id ?? '').trim().slice(0, 100) };
    else if (t.type === 'url') out.target = { type: 'url', url: cleanUrl(t.url, 'Angebot: Link') };
    else throw bad('Angebot: Ziel muss ein Produkt, ein Formular oder ein Link sein');
  }
  if (out.enabled) {
    const t = out.target;
    if (t.type === 'product' && !t.product_id) throw bad('Angebot: bitte ein Produkt wählen');
    if (t.type === 'form' && !t.form_id) throw bad('Angebot: bitte ein Formular wählen');
    if (t.type === 'url' && !t.url) throw bad('Angebot: bitte einen Link angeben');
    if (!out.title && !out.text) throw bad('Angebot: Titel oder Text fehlt');
  }
  return out;
}

/** Validates the settings object on top of `base` (what was stored before). Unknown keys are dropped. */
export function cleanSettings(input: unknown, base: WebinarSettings, durationS: number): WebinarSettings {
  if (input === undefined || input === null) return base;
  if (!isObj(input)) throw bad('Einstellungen: Objekt erwartet');
  const out: WebinarSettings = JSON.parse(JSON.stringify(base));
  const d = defaultSettings();
  if (input.registration !== undefined) {
    const r = input.registration;
    if (!isObj(r)) throw bad('Anmeldung: Objekt erwartet');
    const o = out.registration;
    if (r.headline !== undefined) o.headline = honestText(r.headline, 'Überschrift', 160, '');
    if (r.button_text !== undefined) o.button_text = text(r.button_text, 'Buttontext', 60, d.registration.button_text) || d.registration.button_text;
    if (r.consent_text !== undefined) o.consent_text = text(r.consent_text, 'Einwilligungstext', 800, d.registration.consent_text) || d.registration.consent_text;
    if (r.ask_phone !== undefined) o.ask_phone = flag(r.ask_phone, false);
    if (r.phone_required !== undefined) o.phone_required = flag(r.phone_required, false);
    if (r.sms_consent_text !== undefined) o.sms_consent_text = text(r.sms_consent_text, 'SMS-Einwilligung', 400, d.registration.sms_consent_text) || d.registration.sms_consent_text;
    if (r.thanks_text !== undefined) o.thanks_text = text(r.thanks_text, 'Dankestext', 600, d.registration.thanks_text) || d.registration.thanks_text;
    if (r.redirect_url !== undefined) o.redirect_url = cleanUrl(r.redirect_url, 'Weiterleitung');
    if (r.tags !== undefined) o.tags = tags(r.tags, 'Tags bei Anmeldung');
    if (r.form_ids !== undefined) o.form_ids = ids(r.form_ids, 'Formulare');
    if (r.notify_team !== undefined) o.notify_team = flag(r.notify_team, false);
    if (o.phone_required) o.ask_phone = true;
  }
  if (input.room !== undefined) {
    const r = input.room;
    if (!isObj(r)) throw bad('Raum: Objekt erwartet');
    const o = out.room;
    if (r.label !== undefined) o.label = honestText(r.label, 'Bezeichnung des Raums', 60, DEFAULT_LABEL);
    if (r.replay_label !== undefined) o.replay_label = honestText(r.replay_label, 'Bezeichnung der Aufzeichnung', 60, DEFAULT_REPLAY_LABEL);
    if (r.waiting_text !== undefined) o.waiting_text = honestText(r.waiting_text, 'Text im Warteraum', 400, d.room.waiting_text);
    if (r.ended_text !== undefined) o.ended_text = honestText(r.ended_text, 'Text nach dem Ende', 400, d.room.ended_text);
    if (r.show_counter !== undefined) o.show_counter = flag(r.show_counter, false);
    if (r.questions !== undefined) o.questions = flag(r.questions, true);
    if (r.scripted_enabled !== undefined) o.scripted_enabled = flag(r.scripted_enabled, false);
    if (r.scripted !== undefined) o.scripted = cleanScripted(r.scripted, durationS);
    if (r.polls !== undefined) o.polls = cleanPolls(r.polls, durationS);
  }
  if (input.offer !== undefined) out.offer = cleanOffer(input.offer, out.offer, durationS);
  if (input.reminders !== undefined) {
    const r = input.reminders;
    if (!isObj(r)) throw bad('Erinnerungen: Objekt erwartet');
    if (r.items !== undefined) out.reminders.items = cleanReminders(r.items, out.reminders.items);
    if (r.confirmation_subject !== undefined) out.reminders.confirmation_subject = text(r.confirmation_subject, 'Betreff der Bestätigung', 200, DEFAULT_CONFIRMATION_SUBJECT) || DEFAULT_CONFIRMATION_SUBJECT;
    if (r.confirmation_body !== undefined) out.reminders.confirmation_body = text(r.confirmation_body, 'Text der Bestätigung', 5000, DEFAULT_CONFIRMATION_BODY) || DEFAULT_CONFIRMATION_BODY;
  }
  if (input.replay !== undefined) {
    const r = input.replay;
    if (!isObj(r)) throw bad('Aufzeichnung: Objekt erwartet');
    if (r.enabled !== undefined) out.replay.enabled = flag(r.enabled, true);
    if (r.hours !== undefined) out.replay.hours = whole(r.hours, 'Aufzeichnung: Stunden', 1, 24 * 365, 48);
  }
  if (input.tags !== undefined) {
    const r = input.tags;
    if (!isObj(r)) throw bad('Tags: Objekt erwartet');
    for (const k of ['attended', 'missed', 'cta', 'purchased', 'replay'] as const) if (r[k] !== undefined) out.tags[k] = tags(r[k], `Tags (${k})`);
  }
  return out;
}

// --- the webinar --------------------------------------------------------------------------------

/** Wraps the validation errors of the schedule and the video into 400 answers. */
export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ScheduleError || e instanceof VideoError) throw bad(e.message);
    throw e;
  }
}

export function cleanWebinar(input: Record<string, any>, base?: WebinarInput): WebinarInput {
  const b: WebinarInput = base ?? { title: '', description: '', presenter_name: '', presenter_photo: '', video: NO_VIDEO, duration_s: 0, status: 'draft', schedule: DEFAULT_SCHEDULE, settings: defaultSettings() };
  const out: WebinarInput = JSON.parse(JSON.stringify(b));
  if (input.title !== undefined) {
    out.title = text(input.title, 'Titel', 160);
    if (!out.title) throw bad('Titel fehlt');
  }
  if (!out.title) throw bad('Titel fehlt');
  if (input.description !== undefined) out.description = text(input.description, 'Beschreibung', 4000);
  if (input.presenter_name !== undefined) out.presenter_name = text(input.presenter_name, 'Name des Vortragenden', 100);
  if (input.presenter_photo !== undefined) out.presenter_photo = cleanUrl(input.presenter_photo, 'Foto', {});
  if (input.duration_s !== undefined) out.duration_s = whole(input.duration_s, 'Dauer (Sekunden)', 0, 12 * 3600, 0);
  if (input.duration_min !== undefined && input.duration_s === undefined) out.duration_s = whole(Number(input.duration_min) * 60, 'Dauer (Minuten)', 0, 12 * 3600, 0);
  if (input.video !== undefined) out.video = guard(() => cleanVideo(input.video));
  if (input.schedule !== undefined) out.schedule = guard(() => cleanSchedule(input.schedule, out.schedule));
  if (input.settings !== undefined) out.settings = cleanSettings(input.settings, out.settings, out.duration_s);
  if (input.status !== undefined) {
    if (input.status !== 'draft' && input.status !== 'published') throw bad('Status: draft oder published');
    out.status = input.status;
  }
  // Moments in the video must lie inside it, whichever field changed.
  if (out.duration_s > 0) {
    const cut = (n: number) => Math.min(n, out.duration_s);
    out.settings.offer.at_s = cut(out.settings.offer.at_s);
    for (const p of out.settings.room.polls) p.at_s = cut(p.at_s);
    for (const m of out.settings.room.scripted) m.at_s = cut(m.at_s);
  }
  return out;
}

/** What is still missing before a webinar can be published (German sentences); empty = ready. */
export function publishProblems(w: Pick<WebinarInput, 'video' | 'duration_s' | 'schedule' | 'title'>): string[] {
  const out: string[] = [];
  if (w.video.type === 'none') out.push('Eine Videoquelle fehlt');
  if (!(w.duration_s > 0)) out.push('Die Dauer des Videos fehlt');
  const s = w.schedule;
  if (!(s.fixed.enabled || s.dates.length || s.jit.enabled || s.ondemand.enabled)) out.push('Es ist kein Termin eingerichtet (feste Zeiten, Einzeltermine, „Just in time“ oder „Sofort starten“)');
  return out;
}

export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  const root = slugify(base) || 'webinar';
  let slug = root;
  for (let n = 2; taken(slug) || RESERVED.has(slug); n++) slug = `${root}-${n}`.slice(0, 64);
  return slug;
}
/** Paths below /w/ that are not webinars. */
const RESERVED = new Set(['assets', 'static', 'api', '_hls']);

// --- tokens ---------------------------------------------------------------------------------------

const sig = (secret: string, kind: string, ref: string) => createHmac('sha256', secret).update(`webinar:${kind}:${ref}`).digest('base64url').slice(0, 22);

/** The viewer's link token: the registration id and a signature. Cancelling the registration revokes it. */
export const joinToken = (secret: string, registrationId: string) => `${registrationId}.${sig(secret, 'join', registrationId)}`;
export function readJoinToken(secret: string, token: unknown): string | undefined {
  const m = /^([A-Za-z0-9]{8,32})\.([A-Za-z0-9_-]{22})$/.exec(String(token ?? ''));
  return m && safeEqual(m[2], sig(secret, 'join', m[1])) ? m[1] : undefined;
}

/** A preview link for the team: signed for one webinar, valid for a few hours, shows the room at a chosen second. */
export function previewToken(secret: string, webinarId: string, expSec: number, offset: number) {
  return `${expSec}.${offset}.${sig(secret, 'preview', `${webinarId}:${expSec}:${offset}`)}`;
}
export function readPreviewToken(secret: string, webinarId: string, token: unknown, nowMs: number): { offset: number } | undefined {
  const m = /^(\d{9,11})\.(\d{1,6})\.([A-Za-z0-9_-]{22})$/.exec(String(token ?? ''));
  if (!m || Number(m[1]) * 1000 < nowMs) return undefined;
  return safeEqual(m[3], sig(secret, 'preview', `${webinarId}:${m[1]}:${m[2]}`)) ? { offset: Number(m[2]) } : undefined;
}
