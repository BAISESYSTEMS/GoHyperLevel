import { createHmac, timingSafeEqual } from 'node:crypto';
import { bad, num, str } from '../core/http.js';
import { normalizeDomain } from '../core/domains.js';
import { isValidTz } from '../core/time.js';
import { slugify } from '../core/util.js';
import { DAY_KEYS, defaultHours, type BusinessHours, type SlaPolicy } from './helpdesk-sla.js';
import { cleanHealthConfig, defaultHealthConfig, type HealthConfig } from './health-score.js';

/**
 * Pure building blocks of the helpdesk (Service): priorities, sources, ticket pipelines, settings,
 * signed survey links, ticket numbers in subjects, round robin and the knowledge-base search.
 */

export const PRIORITIES = ['niedrig', 'normal', 'hoch', 'dringend'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { niedrig: 'Niedrig', normal: 'Normal', hoch: 'Hoch', dringend: 'Dringend' };
export const isPriority = (v: unknown): v is Priority => PRIORITIES.includes(v as Priority);
export function raisePriority(p: string): Priority {
  const i = PRIORITIES.indexOf(p as Priority);
  return PRIORITIES[Math.min(PRIORITIES.length - 1, Math.max(0, i) + 1)];
}

export const SOURCES = ['E-Mail', 'Chat', 'WhatsApp', 'SMS', 'Formular', 'Portal', 'Telefon', 'manuell', 'API', 'Workflow', 'Import', 'App'] as const;
export const cleanSource = (v: unknown) => (SOURCES.includes(v as any) ? (v as string) : 'manuell');

// --- pipelines --------------------------------------------------------------------------

/** What a stage means for the helpdesk: open work, waiting for the customer, solved or closed. */
export const STAGE_KINDS = ['new', 'open', 'waiting', 'resolved', 'closed'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];
export const OPEN_KINDS: StageKind[] = ['new', 'open', 'waiting'];
export interface Stage {
  id: string;
  name: string;
  kind: StageKind;
  /** The resolution timer stands still in this stage (e.g. "Wartet auf Kunde"). */
  pause_sla?: boolean;
}

export const defaultStages = (): Stage[] => [
  { id: 'neu', name: 'Neu', kind: 'new' },
  { id: 'in_bearbeitung', name: 'In Bearbeitung', kind: 'open' },
  { id: 'wartet', name: 'Wartet auf Kunde', kind: 'waiting', pause_sla: true },
  { id: 'geloest', name: 'Gelöst', kind: 'resolved' },
  { id: 'geschlossen', name: 'Geschlossen', kind: 'closed' },
];

export function cleanStages(input: unknown): Stage[] {
  if (!Array.isArray(input) || !input.length) throw bad('Mindestens eine Stufe');
  if (input.length > 20) throw bad('Höchstens 20 Stufen');
  const seen = new Set<string>();
  const out = input.map((s: any, i: number) => {
    const name = str(s?.name, 'Name der Stufe', { required: true, max: 60 });
    let sid = String(s?.id ?? '').trim() || slugify(name).replace(/-/g, '_').slice(0, 30) || `stufe_${i + 1}`;
    if (!/^[\w-]{1,40}$/.test(sid)) throw bad('Ungültige Stufen-ID');
    while (seen.has(sid)) sid = `${sid}_${i + 1}`;
    seen.add(sid);
    const kind = STAGE_KINDS.includes(s?.kind) ? (s.kind as StageKind) : 'open';
    return { id: sid, name, kind, ...(s?.pause_sla ? { pause_sla: true } : {}) };
  });
  if (!out.some((s) => OPEN_KINDS.includes(s.kind))) throw bad('Mindestens eine offene Stufe');
  if (!out.some((s) => s.kind === 'resolved' || s.kind === 'closed')) throw bad('Mindestens eine Stufe „Gelöst“ oder „Geschlossen“');
  return out;
}

/** A stage by id, name or kind ("neu", "Gelöst", "resolved"). */
export function findStage(stages: Stage[], v: unknown): Stage | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const low = s.toLowerCase();
  return stages.find((x) => x.id === s) ?? stages.find((x) => x.name.toLowerCase() === low) ?? stages.find((x) => x.kind === low);
}

// --- settings -----------------------------------------------------------------------------

export type AssignMode = 'manual' | 'round_robin' | 'category';
export interface HelpdeskSettings {
  categories: string[];
  business_hours: BusinessHours;
  holidays: string[];
  sla: { enabled: boolean; warn_percent: number; policies: Record<Priority, SlaPolicy>; notify_owner: boolean; raise_priority_on_breach: boolean; breach_team_id: string };
  assignment: { mode: AssignMode; default_team_id: string; rules: { category: string; team_id: string; user_id: string }[] };
  email_to_ticket: { mode: 'off' | 'all' | 'rules'; addresses: string[]; keywords: string[]; domains: string[]; include_imported: boolean; priority: Priority; category: string };
  auto_reply: { enabled: boolean; subject: string; body: string };
  csat: { enabled: boolean; delay_min: number; channel: 'auto' | 'email' | 'sms'; subject: string; body: string };
  portal: { enabled: boolean; any_contact: boolean };
  help_center: { enabled: boolean; slug: string; title: string; intro: string; color: string; domain: string; seo_title: string; seo_description: string; contact_text: string };
  health: HealthConfig;
}

const policy = (first: number, resolution: number): SlaPolicy => ({ first_response_min: first, resolution_min: resolution, business_hours: true });

export function defaultHelpdeskSettings(): HelpdeskSettings {
  return {
    categories: ['Allgemein', 'Technik', 'Rechnung', 'Reklamation'],
    business_hours: defaultHours(),
    holidays: [],
    sla: {
      enabled: true,
      warn_percent: 75,
      // Working minutes (business hours): dringend 1 h / 1 Tag, hoch 4 h / 3 Tage, normal 1 Tag / 5 Tage, niedrig 2 / 10 Tage.
      policies: { dringend: policy(60, 480), hoch: policy(240, 1440), normal: policy(480, 2400), niedrig: policy(960, 4800) },
      notify_owner: true,
      raise_priority_on_breach: false,
      breach_team_id: '',
    },
    assignment: { mode: 'manual', default_team_id: '', rules: [] },
    email_to_ticket: { mode: 'off', addresses: [], keywords: [], domains: [], include_imported: false, priority: 'normal', category: '' },
    auto_reply: {
      enabled: false,
      subject: 'Wir haben deine Anfrage erhalten [Ticket #{{ticket.number}}]',
      body: 'Hallo {{contact.first_name|}},\n\ndanke für deine Nachricht. Wir haben dein Anliegen als Ticket #{{ticket.number}} aufgenommen und melden uns so schnell wie möglich.\n\nViele Grüße\n{{location.name}}',
    },
    csat: {
      enabled: true,
      delay_min: 0,
      channel: 'auto',
      subject: 'Wie zufrieden warst du? [Ticket #{{ticket.number}}]',
      body: 'Hallo {{contact.first_name|}},\n\nwir haben dein Anliegen „{{ticket.subject}}“ gelöst. Wie zufrieden warst du mit unserer Hilfe? Ein Klick genügt:\n\n{{csat_link}}\n\nDanke!\n{{location.name}}',
    },
    portal: { enabled: true, any_contact: false },
    help_center: { enabled: false, slug: '', title: '', intro: 'Wie können wir helfen?', color: '', domain: '', seo_title: '', seo_description: '', contact_text: '' },
    health: defaultHealthConfig(),
  };
}

/** Stored settings over the defaults (nested objects merged, unknown keys dropped). */
export function withHelpdeskDefaults(stored: any): HelpdeskSettings {
  const d = defaultHelpdeskSettings();
  const s = stored && typeof stored === 'object' ? stored : {};
  const merge = <T extends object>(base: T, v: any): T => ({ ...base, ...(v && typeof v === 'object' && !Array.isArray(v) ? pick(v, Object.keys(base)) : {}) });
  return {
    categories: Array.isArray(s.categories) ? s.categories : d.categories,
    business_hours: { ...d.business_hours, ...(s.business_hours ?? {}) },
    holidays: Array.isArray(s.holidays) ? s.holidays : [],
    sla: { ...merge(d.sla, s.sla), policies: { ...d.sla.policies, ...(s.sla?.policies ?? {}) } },
    assignment: merge(d.assignment, s.assignment),
    email_to_ticket: merge(d.email_to_ticket, s.email_to_ticket),
    auto_reply: merge(d.auto_reply, s.auto_reply),
    csat: merge(d.csat, s.csat),
    portal: merge(d.portal, s.portal),
    help_center: merge(d.help_center, s.help_center),
    health: { ...merge(d.health, s.health), weights: { ...d.health.weights, ...(s.health?.weights ?? {}) } },
  };
}

function pick(o: any, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const bool = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
function list(v: unknown, label: string, max = 50, len = 120): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,\n]/);
  if (arr.length > max) throw bad(`${label}: höchstens ${max}`);
  return [...new Set(arr.map((x) => String(x ?? '').trim()).filter(Boolean).map((x) => x.slice(0, len)))];
}
function minutes(v: unknown, label: string): number {
  const n = Math.round(num(v, NaN));
  if (!Number.isFinite(n) || n < 0 || n > 525_600) throw bad(`${label}: 0 bis 525600 Minuten`);
  return n;
}

/** Validates a settings patch from the browser/API onto the current settings. */
export function cleanHelpdeskSettings(b: any, cur: HelpdeskSettings): HelpdeskSettings {
  if (!b || typeof b !== 'object') throw bad('Einstellungen fehlen');
  const out: HelpdeskSettings = structuredClone(cur);
  if (b.categories !== undefined) out.categories = list(b.categories, 'Kategorien', 100, 60);
  if (b.business_hours !== undefined) {
    if (!b.business_hours || typeof b.business_hours !== 'object') throw bad('Geschäftszeiten ungültig');
    for (const d of DAY_KEYS) {
      const h = b.business_hours[d];
      if (h === undefined) continue;
      const from = String(h?.from ?? '09:00');
      const to = String(h?.to ?? '17:00');
      if (!HM.test(from) || !HM.test(to)) throw bad('Uhrzeit bitte als HH:MM');
      out.business_hours[d] = { open: bool(h?.open), from, to };
    }
  }
  if (b.holidays !== undefined) {
    const h = list(b.holidays, 'Feiertage', 200, 10);
    if (h.some((x) => !YMD.test(x))) throw bad('Feiertage bitte als JJJJ-MM-TT');
    out.holidays = h.sort();
  }
  if (b.sla && typeof b.sla === 'object') {
    const s = b.sla;
    if (s.enabled !== undefined) out.sla.enabled = bool(s.enabled);
    if (s.warn_percent !== undefined) {
      const v = Math.round(num(s.warn_percent, NaN));
      if (!Number.isFinite(v) || v < 10 || v > 95) throw bad('Warnung bei: 10 bis 95 % der Zeit');
      out.sla.warn_percent = v;
    }
    if (s.policies && typeof s.policies === 'object') {
      for (const p of PRIORITIES) {
        const x = s.policies[p];
        if (!x) continue;
        out.sla.policies[p] = {
          first_response_min: x.first_response_min !== undefined ? minutes(x.first_response_min, 'Erste Antwort') : out.sla.policies[p].first_response_min,
          resolution_min: x.resolution_min !== undefined ? minutes(x.resolution_min, 'Lösung') : out.sla.policies[p].resolution_min,
          business_hours: x.business_hours !== undefined ? bool(x.business_hours) : out.sla.policies[p].business_hours,
        };
      }
    }
    if (s.notify_owner !== undefined) out.sla.notify_owner = bool(s.notify_owner);
    if (s.raise_priority_on_breach !== undefined) out.sla.raise_priority_on_breach = bool(s.raise_priority_on_breach);
    if (s.breach_team_id !== undefined) out.sla.breach_team_id = str(s.breach_team_id, 'Team', { max: 40 });
  }
  if (b.assignment && typeof b.assignment === 'object') {
    const a = b.assignment;
    if (a.mode !== undefined) {
      if (!['manual', 'round_robin', 'category'].includes(a.mode)) throw bad('Unbekannte Zuweisung');
      out.assignment.mode = a.mode;
    }
    if (a.default_team_id !== undefined) out.assignment.default_team_id = str(a.default_team_id, 'Team', { max: 40 });
    if (a.rules !== undefined) {
      if (!Array.isArray(a.rules) || a.rules.length > 100) throw bad('Regeln als Liste (höchstens 100)');
      out.assignment.rules = a.rules
        .map((r: any) => ({ category: str(r?.category, 'Kategorie', { max: 60 }), team_id: str(r?.team_id, 'Team', { max: 40 }), user_id: str(r?.user_id, 'Mitarbeiter', { max: 40 }) }))
        .filter((r: any) => r.category && (r.team_id || r.user_id));
    }
  }
  if (b.email_to_ticket && typeof b.email_to_ticket === 'object') {
    const e = b.email_to_ticket;
    if (e.mode !== undefined) {
      if (!['off', 'all', 'rules'].includes(e.mode)) throw bad('Unbekannter Modus für E-Mail → Ticket');
      out.email_to_ticket.mode = e.mode;
    }
    if (e.addresses !== undefined) {
      const a = list(e.addresses, 'Support-Adressen', 20, 200).map((x) => x.toLowerCase());
      if (a.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw bad('Support-Adresse ungültig');
      out.email_to_ticket.addresses = a;
    }
    if (e.keywords !== undefined) out.email_to_ticket.keywords = list(e.keywords, 'Stichwörter', 50, 60).map((x) => x.toLowerCase());
    if (e.domains !== undefined) out.email_to_ticket.domains = list(e.domains, 'Domains', 50, 120).map((x) => x.toLowerCase().replace(/^@/, ''));
    if (e.include_imported !== undefined) out.email_to_ticket.include_imported = bool(e.include_imported);
    if (e.priority !== undefined) {
      if (!isPriority(e.priority)) throw bad('Unbekannte Priorität');
      out.email_to_ticket.priority = e.priority;
    }
    if (e.category !== undefined) out.email_to_ticket.category = str(e.category, 'Kategorie', { max: 60 });
  }
  if (b.auto_reply && typeof b.auto_reply === 'object') {
    const r = b.auto_reply;
    if (r.enabled !== undefined) out.auto_reply.enabled = bool(r.enabled);
    if (r.subject !== undefined) out.auto_reply.subject = str(r.subject, 'Betreff', { max: 300 });
    if (r.body !== undefined) out.auto_reply.body = str(r.body, 'Text', { max: 10_000 });
  }
  if (b.csat && typeof b.csat === 'object') {
    const c = b.csat;
    if (c.enabled !== undefined) out.csat.enabled = bool(c.enabled);
    if (c.delay_min !== undefined) out.csat.delay_min = Math.min(minutes(c.delay_min, 'Verzögerung'), 43_200);
    if (c.channel !== undefined) {
      if (!['auto', 'email', 'sms'].includes(c.channel)) throw bad('Unbekannter Kanal');
      out.csat.channel = c.channel;
    }
    if (c.subject !== undefined) out.csat.subject = str(c.subject, 'Betreff', { max: 300 });
    if (c.body !== undefined) {
      const body = str(c.body, 'Text', { max: 10_000 });
      if (body && !body.includes('{{csat_link}}')) throw bad('Der Text braucht den Platzhalter {{csat_link}}');
      out.csat.body = body;
    }
  }
  if (b.portal && typeof b.portal === 'object') {
    if (b.portal.enabled !== undefined) out.portal.enabled = bool(b.portal.enabled);
    if (b.portal.any_contact !== undefined) out.portal.any_contact = bool(b.portal.any_contact);
  }
  if (b.help_center && typeof b.help_center === 'object') {
    const h = b.help_center;
    if (h.enabled !== undefined) out.help_center.enabled = bool(h.enabled);
    if (h.slug !== undefined) {
      const raw = str(h.slug, 'Adresse', { max: 60 });
      out.help_center.slug = raw ? slugify(raw) : '';
    }
    for (const [k, label, max] of [['title', 'Titel', 120], ['intro', 'Einleitung', 300], ['seo_title', 'SEO-Titel', 120], ['seo_description', 'SEO-Beschreibung', 300], ['contact_text', 'Kontakt-Hinweis', 500]] as const) {
      if (h[k] !== undefined) out.help_center[k] = str(h[k], label, { max });
    }
    if (h.color !== undefined) {
      const c = str(h.color, 'Farbe', { max: 7 });
      if (c && !HEX.test(c)) throw bad('Farbe als #rrggbb');
      out.help_center.color = c;
    }
    if (h.domain !== undefined) out.help_center.domain = normalizeDomain(h.domain);
  }
  if (b.health !== undefined) out.health = cleanHealthConfig(b.health, out.health);
  return out;
}

export const validTz = (tz: string) => (isValidTz(tz) ? tz : 'Europe/Berlin');

// --- tokens & numbers ----------------------------------------------------------------------

/** Short HMAC over `data` with the app secret (survey links). */
export function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url').slice(0, 22);
}
export function verifySig(secret: string, data: string, sig: string): boolean {
  const want = Buffer.from(sign(secret, data));
  const got = Buffer.from(String(sig ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** "[Ticket #42]" – put into reply subjects so answers find their ticket again. */
export const ticketTag = (n: number) => `[Ticket #${n}]`;
export function parseTicketTag(subject: unknown): number | null {
  const m = String(subject ?? '').match(/\[(?:Ticket|Anfrage)\s*#(\d{1,9})\]/i);
  return m ? Number(m[1]) : null;
}
/** Subject for an outgoing reply: "Re: <subject> [Ticket #n]" (no double prefixes or tags). */
export function replySubject(subject: string, n: number): string {
  const base = String(subject ?? '').replace(/\[(?:Ticket|Anfrage)\s*#\d+\]/gi, '').replace(/\s+/g, ' ').trim();
  const re = /^(re|aw|antw):/i.test(base) ? base : `Re: ${base || 'Deine Anfrage'}`;
  return `${re} ${ticketTag(n)}`;
}

/** Next team member after the last one assigned (round robin); skips people no longer in the team. */
export function nextRoundRobin(members: string[], last: string | null | undefined): string | null {
  if (!members.length) return null;
  const i = last ? members.indexOf(last) : -1;
  return members[(i + 1) % members.length];
}

// --- knowledge-base search -------------------------------------------------------------------

const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'einen', 'ist', 'wie', 'was', 'ich', 'mit', 'für', 'von', 'zu', 'im', 'in', 'an', 'auf', 'den', 'dem', 'des', 'bei', 'kann', 'man', 'mein', 'meine', 'nicht', 'the', 'and', 'how', 'to', 'is', 'es', 'wo', 'wann']);
export function searchTerms(q: string): string[] {
  return [
    ...new Set(
      String(q ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9ß]+/)
        .filter((w) => w.length >= 2 && !STOP.has(w)),
    ),
  ].slice(0, 12);
}
const fold = (s: string) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const count = (hay: string, w: string) => {
  let n = 0;
  for (let i = hay.indexOf(w); i >= 0 && n < 10; i = hay.indexOf(w, i + w.length)) n++;
  return n;
};

/** Relevance of an article for search terms: title counts most, then tags, then the text. 0 = no match. */
export function articleScore(a: { title?: string; body?: string; tags?: string[]; excerpt?: string; [k: string]: any }, terms: string[]): number {
  if (!terms.length) return 0;
  const title = fold(a.title ?? '');
  const tags = fold((a.tags ?? []).join(' '));
  const body = fold(`${a.excerpt ?? ''} ${a.body ?? ''}`);
  let score = 0;
  let hits = 0;
  for (const w of terms) {
    const s = count(title, w) * 6 + count(tags, w) * 4 + Math.min(count(body, w), 5);
    if (s) hits++;
    score += s;
  }
  // Articles that contain every term come first.
  return score ? score + (hits === terms.length ? 10 : 0) : 0;
}

/** First email address in a header value like `"Support" <support@x.de>, other@y.de`. */
export function addresses(v: unknown): string[] {
  return String(v ?? '')
    .split(/[,;]/)
    .map((p) => (p.match(/<([^>]+)>/)?.[1] ?? p).trim().toLowerCase())
    .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}

/** Does an inbound email match the email-to-ticket rule? */
export function emailMatchesRule(rule: HelpdeskSettings['email_to_ticket'], m: { to?: string[]; from: string; subject: string; body?: string }): boolean {
  if (rule.mode === 'off') return false;
  if (rule.mode === 'all') return true;
  const to = (m.to ?? []).map((x) => x.toLowerCase());
  if (rule.addresses.length && to.some((x) => rule.addresses.includes(x))) return true;
  const from = m.from.toLowerCase();
  if (rule.domains.length && rule.domains.some((d) => from.endsWith(`@${d}`) || from.endsWith(`.${d}`))) return true;
  const subject = m.subject.toLowerCase();
  if (rule.keywords.length && rule.keywords.some((k) => subject.includes(k))) return true;
  return false;
}

// --- import mapping (HubSpot & Co.) ------------------------------------------------------------

/** A foreign priority ("HIGH", "medium", "Dringend") → ours. */
export function mapPriority(v: unknown): Priority {
  const s = String(v ?? '').trim().toLowerCase();
  if (isPriority(s)) return s;
  if (/urgent|critical|dringend|kritisch/.test(s)) return 'dringend';
  if (/high|hoch/.test(s)) return 'hoch';
  if (/low|niedrig|gering/.test(s)) return 'niedrig';
  return 'normal';
}

/** A foreign stage label → the best matching stage: same name, else by meaning (new / waiting / closed …). */
export function mapStage(stages: Stage[], label: unknown): Stage {
  const s = String(label ?? '').trim().toLowerCase();
  const byName = s ? stages.find((x) => x.name.toLowerCase() === s || x.id === s) : undefined;
  if (byName) return byName;
  const kind: StageKind =
    /closed|geschlossen|archiv/.test(s) ? 'closed'
    : /resolved|solved|gelöst|geloest|erledigt|done/.test(s) ? 'resolved'
    : /waiting on (contact|customer)|wartet auf (kontakt|kunde|kunden)|pending|on hold/.test(s) ? 'waiting'
    : /\bnew\b|\bneu\b/.test(s) && !/waiting|wartet/.test(s) ? 'new'
    : 'open';
  return stages.find((x) => x.kind === kind) ?? stages.find((x) => x.kind === 'open') ?? stages[0];
}
