import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { id, normalizeEmail, now } from '../core/util.js';
import { addTags, logActivity, upsertContact } from './contacts.js';
import { grantAccess } from './courses.js';
import { cleanGroupAccess } from './community.js';
import { checkLevel, ensureProfile } from './community-actions.js';
import { communityMail, membershipOf, portalCommunityUrl, tiersOf, type Tier } from './community-tiers.js';

/**
 * Moving in: a CSV list of members (name, e-mail, member since, tier, optional points) and, if wanted, posts as Markdown files.
 * Skool has no public API – the member list comes from its own CSV export (see docs/community.md). Everything is checked in a dry
 * run first; nothing is sent, no workflow starts and no points are paid unless the admin switches it on.
 */

export const MAX_ROWS = 5000;
export const MAX_CSV_BYTES = 6 * 1024 * 1024;
export const MAX_POST_FILES = 500;
export const MAX_POST_BYTES = 120_000;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

// --- CSV --------------------------------------------------------------------------------------------------------------------

/** RFC 4180 with quotes, doubled quotes and line breaks inside fields; delimiter , ; or tab; BOM allowed. */
export function parseCsv(input: string): string[][] {
  let text = String(input ?? '');
  if (text.length > MAX_CSV_BYTES) throw bad('Die Datei ist zu groß (höchstens 6 MB)');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => {
    let q = false;
    let n = 0;
    for (const c of first) {
      if (c === '"') q = !q;
      else if (!q && c === ch) n++;
    }
    return n;
  };
  const delim = [',', ';', '\t'].map((d) => ({ d, n: count(d) })).sort((a, b) => b.n - a.n)[0];
  const sep = delim.n ? delim.d : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"', i++);
        else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) (row.push(field), (field = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) throw bad(`Zu viele Zeilen (höchstens ${MAX_ROWS} Mitglieder pro Import)`);
    } else field += c;
  }
  if (quoted) throw bad('Die CSV-Datei ist unvollständig (ein Anführungszeichen wurde nicht geschlossen)');
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

// --- columns ----------------------------------------------------------------------------------------------------------------

export const FIELDS = ['name', 'first_name', 'last_name', 'email', 'joined', 'tier', 'tags', 'points', 'phone'] as const;
export type Field = (typeof FIELDS)[number];

const ALIASES: Record<Field, string[]> = {
  email: ['email', 'e-mail', 'e mail', 'mail', 'emailaddress', 'email address', 'e-mail-adresse', 'emailadresse'],
  first_name: ['firstname', 'first name', 'first_name', 'vorname', 'given name'],
  last_name: ['lastname', 'last name', 'last_name', 'nachname', 'familienname', 'surname', 'family name'],
  name: ['name', 'fullname', 'full name', 'member', 'member name', 'displayname', 'display name', 'mitglied', 'anzeigename'],
  joined: ['joined', 'join date', 'joined date', 'joined at', 'date joined', 'member since', 'membersince', 'created', 'created at', 'registered', 'signup date', 'sign up date', 'beigetreten', 'beitritt', 'mitglied seit', 'beitrittsdatum', 'datum'],
  tier: ['tier', 'plan', 'membership', 'membership level', 'abo', 'stufe', 'mitgliedschaft', 'product'],
  tags: ['tags', 'tag', 'labels'],
  points: ['points', 'punkte', 'score'],
  phone: ['phone', 'telefon', 'mobile', 'handy', 'phone number', 'telefonnummer'],
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_.-]+/g, ' ').trim();

/** Which column holds what (by header name; an explicit `mapping` of field → header name wins). */
export function detectColumns(header: string[], mapping: Partial<Record<Field, string>> = {}): Partial<Record<Field, number>> {
  const h = header.map(norm);
  const out: Partial<Record<Field, number>> = {};
  for (const f of FIELDS) {
    const want = mapping[f];
    if (want) {
      const i = h.indexOf(norm(want));
      if (i < 0) throw bad(`Die Spalte „${want}“ gibt es in der Datei nicht`);
      out[f] = i;
      continue;
    }
    const i = h.findIndex((x, idx) => ALIASES[f].some((a) => norm(a) === x) && !Object.values(out).includes(idx));
    if (i >= 0) out[f] = i;
  }
  return out;
}

const MONTHS: Record<string, number> = { jan: 1, january: 1, januar: 1, feb: 2, february: 2, februar: 2, mar: 3, march: 3, märz: 3, maerz: 3, apr: 4, april: 4, may: 5, mai: 5, jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12, dez: 12, dezember: 12 };

/** A date as an ISO time (noon UTC, so the day is right in every time zone), or null. `order`: for 03/04/2024 – dmy or mdy. */
export function parseDate(raw: string, order: 'auto' | 'dmy' | 'mdy' = 'auto'): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const mk = (y: number, m: number, d: number) => {
    if (y < 1990 || y > new Date().getUTCFullYear() + 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const t = new Date(Date.UTC(y, m - 1, d, 12));
    return t.getUTCMonth() === m - 1 && t.getTime() <= Date.now() + 864e5 ? t.toISOString() : null;
  };
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s.*)?$/.exec(s);
  if (m) return mk(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s.*)?$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const dmy = order === 'dmy' || (order === 'auto' && a > 12);
    return dmy ? mk(y, b, a) : mk(y, a, b);
  }
  m = /^([A-Za-zäöüÄÖÜ]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return mk(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-zäöüÄÖÜ]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return mk(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return mk(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

// --- plan -------------------------------------------------------------------------------------------------------------------

export interface MemberRow {
  line: number;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  joined_at: string | null;
  tier_name: string;
  tags: string[];
  points: number;
  phone: string;
}

export type RowState = 'new' | 'contact_exists' | 'member_exists' | 'invalid' | 'duplicate';

export interface PlanItem extends MemberRow {
  state: RowState;
  reason?: string;
  tier_id: string | null;
  tier_match: 'exact' | 'default' | 'none';
}

export interface MemberPlan {
  access_mode: string;
  warnings: string[];
  columns: Record<string, string>;
  header: string[];
  items: PlanItem[];
  counts: Record<RowState, number> & { total: number };
  tiers: { id: string; name: string }[];
  unmatched_tiers: string[];
}

export interface MemberInput {
  csv?: unknown;
  mapping?: Partial<Record<Field, string>>;
  date_order?: 'auto' | 'dmy' | 'mdy';
  tier_id?: string;
  tier_map?: Record<string, string>;
}

export function planMembers(app: App, g: any, input: MemberInput): MemberPlan {
  const rows = parseCsv(String(input.csv ?? ''));
  if (rows.length < 2) throw bad('Die Datei braucht eine Kopfzeile und mindestens eine Zeile mit einem Mitglied');
  const header = rows[0].map((x) => x.trim());
  const cols = detectColumns(header, input.mapping ?? {});
  if (cols.email === undefined) throw bad('In der Datei fehlt eine E-Mail-Spalte (z. B. „Email“). Die Kopfzeile lautet: ' + header.join(', '));
  const order = input.date_order === 'dmy' || input.date_order === 'mdy' ? input.date_order : 'auto';
  const tiers = tiersOf(app, g.id);
  const byName = new Map(tiers.map((t) => [norm(t.name), t]));
  const defaultTier = input.tier_id ? tiers.find((t) => t.id === input.tier_id) : tiers.find((t) => !t.product_id && !t.annual_product_id) ?? tiers[0];
  if (input.tier_id && !defaultTier) throw bad('Die gewählte Stufe gehört nicht zu dieser Gruppe');
  const map = new Map<string, Tier>();
  for (const [from, to] of Object.entries(input.tier_map ?? {})) {
    const t = tiers.find((x) => x.id === to);
    if (!t) throw bad('Eine zugeordnete Stufe gehört nicht zu dieser Gruppe');
    map.set(norm(from), t);
  }
  const cell = (r: string[], f: Field) => (cols[f] === undefined ? '' : String(r[cols[f]!] ?? '').trim());
  const seen = new Set<string>();
  const unmatched = new Set<string>();
  const items: PlanItem[] = rows.slice(1).map((r, i) => {
    const email = normalizeEmail(cell(r, 'email'));
    const nameCell = cell(r, 'name');
    let first = cell(r, 'first_name');
    let last = cell(r, 'last_name');
    if (!first && !last && nameCell) {
      const [f, ...rest] = nameCell.split(/\s+/);
      first = f ?? '';
      last = rest.join(' ');
    }
    const tierName = cell(r, 'tier');
    const match = tierName ? map.get(norm(tierName)) ?? byName.get(norm(tierName)) : undefined;
    if (tierName && !match) unmatched.add(tierName);
    const item: PlanItem = {
      line: i + 2,
      name: nameCell || [first, last].filter(Boolean).join(' '),
      first_name: first.slice(0, 80),
      last_name: last.slice(0, 80),
      email,
      joined_at: parseDate(cell(r, 'joined'), order),
      tier_name: tierName,
      tags: cell(r, 'tags').split(/[,;|]/).map((x) => x.trim()).filter(Boolean).slice(0, 10),
      points: Math.max(0, Math.min(1_000_000, Math.round(Number(cell(r, 'points').replace(',', '.')) || 0))),
      phone: cell(r, 'phone'),
      state: 'new',
      tier_id: (match ?? defaultTier)?.id ?? null,
      tier_match: match ? 'exact' : defaultTier ? 'default' : 'none',
    };
    if (!EMAIL_RE.test(email) || email.length > 200) return { ...item, state: 'invalid', reason: email ? 'Keine gültige E-Mail-Adresse' : 'E-Mail fehlt' };
    if (seen.has(email)) return { ...item, state: 'duplicate', reason: 'Steht schon weiter oben in der Datei' };
    seen.add(email);
    if (cell(r, 'joined') && !item.joined_at) item.reason = `Datum „${cell(r, 'joined')}“ nicht erkannt – es gilt heute`;
    const c = app.db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', g.location_id, email);
    if (c) {
      const m = membershipOf(app, g.id, c.id);
      if (m && (m.status === 'active' || m.status === 'trialing' || m.status === 'past_due')) return { ...item, state: 'member_exists', reason: 'Ist schon Mitglied' };
      if (app.db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ? AND banned_at IS NOT NULL', g.id, c.id)) return { ...item, state: 'member_exists', reason: 'Ist in dieser Gruppe gesperrt' };
      if (app.db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, c.id)) return { ...item, state: 'member_exists', reason: 'Ist schon in der Gruppe' };
      return { ...item, state: 'contact_exists' };
    }
    return item;
  });
  const counts = { total: items.length, new: 0, contact_exists: 0, member_exists: 0, invalid: 0, duplicate: 0 } as MemberPlan['counts'];
  for (const it of items) counts[it.state]++;
  const mode = cleanGroupAccess(g.access).mode;
  const warnings: string[] = [];
  if (mode !== 'join' && mode !== 'tags') warnings.push('Diese Gruppe lässt Mitglieder über Kurse oder alle Portal-Mitglieder herein. Importierte Personen bekämen keinen Zugang. Stelle den Zugang zuerst auf „Beitritt über die Community-Seite“ um (Community → Beitritt).');
  if (mode === 'tags') warnings.push('Die Gruppe lässt Mitglieder über Tags herein: Die importierten Personen bekommen den ersten Zugangs-Tag.');
  if (!tiers.length && mode === 'join') warnings.push('Es gibt noch keine Stufe – die Personen werden ohne Stufe aufgenommen. Lege unter Beitritt eine Stufe an, wenn du sie zuordnen willst.');
  if (items.some((i) => i.points > 0)) warnings.push('Punkte aus der Datei werden als Startguthaben gutgeschrieben und können Level auslösen.');
  return {
    access_mode: mode,
    warnings,
    columns: Object.fromEntries(Object.entries(cols).map(([f, i]) => [f, header[i as number]])),
    header,
    items,
    counts,
    tiers: tiers.map((t) => ({ id: t.id, name: t.name })),
    unmatched_tiers: [...unmatched],
  };
}

export interface RunOptions {
  trigger_workflows?: boolean;
  send_mail?: boolean;
  grant_tier_access?: boolean;
  import_points?: boolean;
  by?: string;
}

export interface RunResult {
  created: number;
  updated: number;
  skipped: number;
  mails: number;
  points: number;
}

/** Writes the plan. Quiet by default: no event "member joined", no welcome message, no points unless asked. */
export async function runMembers(app: App, g: any, plan: MemberPlan, opts: RunOptions = {}): Promise<RunResult> {
  if (plan.access_mode !== 'join' && plan.access_mode !== 'tags') throw bad('Bitte stelle die Gruppe zuerst auf „Beitritt über die Community-Seite“ um');
  const { db } = app;
  const page = db.get<{ slug: string }>('SELECT slug FROM community_pages WHERE group_id = ?', g.id);
  const slug = page?.slug ?? g.slug;
  const tiers = new Map(tiersOf(app, g.id).map((t) => [t.id, t]));
  const accessTag = plan.access_mode === 'tags' ? cleanGroupAccess(g.access).tags[0] : undefined;
  const res: RunResult = { created: 0, updated: 0, skipped: 0, mails: 0, points: 0 };
  const mailTo: { email: string; first: string }[] = [];
  for (const it of plan.items) {
    if (it.state === 'invalid' || it.state === 'duplicate' || it.state === 'member_exists') {
      res.skipped++;
      continue;
    }
    const tier = it.tier_id ? tiers.get(it.tier_id) : undefined;
    const joined = it.joined_at ?? now();
    const tags = ['community', `community:${slug}`, 'import', ...(accessTag ? [accessTag] : []), ...(tier ? [`stufe:${tier.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, ...tier.tags] : []), ...it.tags];
    const { contact, created } = upsertContact(app, g.location_id, { first_name: it.first_name, last_name: it.last_name, email: it.email, ...(it.phone ? { phone: it.phone } : {}) }, { source: 'Import (Community)', tags, quiet: !opts.trigger_workflows });
    db.tx(() => {
      const cur = membershipOf(app, g.id, contact.id);
      if (!cur) {
        db.insert('community_memberships', { id: id(), location_id: g.location_id, group_id: g.id, contact_id: contact.id, tier_id: tier?.id ?? null, status: 'active', source: 'import', billing: 'free', answers: {}, joined_at: joined, requested_at: joined, approved_at: now(), approved_by: opts.by ?? '', created_at: now(), updated_at: now(), note: 'Import', left_reason: '', coupon_code: '', consent: 0 });
      } else {
        db.update('community_memberships', cur.id, { tier_id: tier?.id ?? cur.tier_id, status: 'active', source: 'import', billing: 'free', joined_at: cur.joined_at && cur.joined_at < joined ? cur.joined_at : joined, approved_at: now(), canceled_at: null, cancel_at: null, past_due_at: null, left_reason: '', updated_at: now() });
      }
      db.run('INSERT OR IGNORE INTO community_members (group_id, contact_id, location_id, joined_at, last_seen_at, level) VALUES (?, ?, ?, ?, NULL, 1)', g.id, contact.id, g.location_id, joined);
    });
    ensureProfile(app, g.location_id, contact);
    if (!created) addTags(app, g.location_id, contact.id, tags);
    if (opts.grant_tier_access !== false) for (const cid of tier?.course_ids ?? []) {
      try {
        grantAccess(app, g.location_id, cid, contact.id, 'community', `tier:${tier!.id}`);
      } catch (e) {
        console.error('[community] import tier course', (e as Error).message);
      }
    }
    if (opts.import_points && it.points > 0 && !db.get(`SELECT 1 FROM community_points WHERE group_id = ? AND contact_id = ? AND reason = 'import'`, g.id, contact.id)) {
      db.insert('community_points', { id: id(), location_id: g.location_id, group_id: g.id, contact_id: contact.id, points: it.points, reason: 'import', target_id: '', actor_id: opts.by ?? '', created_at: now() });
      res.points += it.points;
      checkLevel(app, g, contact.id);
    }
    logActivity(app, g.location_id, contact.id, 'community.imported', `In die Community „${g.name}“ übernommen (Import, Mitglied seit ${joined.slice(0, 10)})`);
    created ? res.created++ : res.updated++;
    // Contacts who asked not to be disturbed (dnd) are moved over like everybody else but get no mail.
    if (opts.send_mail && it.email && !contact.dnd) mailTo.push({ email: it.email, first: it.first_name });
  }
  for (const m of mailTo.slice(0, 2000)) {
    const ok = await communityMail(app, g.location_id, m.email, `Willkommen in der Community „${g.name}“`, [`${m.first ? `Hallo ${m.first}` : 'Hallo'},`, `deine Mitgliedschaft in „${g.name}“ ist umgezogen – du bist schon drin. Melde dich einfach mit dieser E-Mail-Adresse an: du bekommst einen Link per Mail, ein Passwort brauchst du nicht.`], { label: 'Zur Community', url: portalCommunityUrl(app, g) });
    if (ok) res.mails++;
  }
  return res;
}

// --- posts ------------------------------------------------------------------------------------------------------------------

export interface PostFile {
  name: string;
  content: string;
}

export interface PostPlanItem {
  file: string;
  title: string;
  body: string;
  created_at: string;
  channel_id: string;
  channel_name: string;
  author_contact_id: string | null;
  author_name: string;
  pinned: boolean;
  problem?: string;
  warnings: string[];
}

/** Front matter between --- lines: title, date, author (e-mail or name), channel (name or slug), pinned. */
export function parseMarkdownPost(name: string, content: string): { meta: Record<string, string>; body: string } {
  let text = String(content ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const meta: Record<string, string> = {};
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    for (const line of m[1].split('\n')) {
      const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
      if (k) meta[k[1].toLowerCase()] = k[2].replace(/^["']|["']$/g, '').trim();
    }
    text = text.slice(m[0].length);
  }
  void name;
  return { meta, body: text.trim() };
}

export function planPosts(app: App, g: any, input: { files?: unknown; channel_id?: string; keep_dates?: boolean }): PostPlanItem[] {
  const files = Array.isArray(input.files) ? (input.files as PostFile[]) : [];
  if (!files.length) throw bad('Bitte mindestens eine Markdown-Datei angeben');
  if (files.length > MAX_POST_FILES) throw bad(`Zu viele Dateien (höchstens ${MAX_POST_FILES})`);
  const channels = app.db.all<{ id: string; name: string; slug: string; admin_only: number }>('SELECT id, name, slug, admin_only FROM community_channels WHERE group_id = ? ORDER BY position, created_at', g.id);
  const fallback = (input.channel_id && channels.find((c) => c.id === input.channel_id)) || channels.find((c) => !c.admin_only) || channels[0];
  if (input.channel_id && !channels.some((c) => c.id === input.channel_id)) throw bad('Kanal nicht gefunden');
  if (!fallback) throw bad('Die Gruppe hat keinen Kanal');
  const members = new Map(app.db.all<{ email: string; contact_id: string; display_name: string }>(`SELECT k.email, m.contact_id, p.display_name FROM community_members m JOIN contacts k ON k.id = m.contact_id LEFT JOIN community_profiles p ON p.location_id = m.location_id AND p.contact_id = m.contact_id WHERE m.group_id = ? AND m.banned_at IS NULL`, g.id).map((r) => [r.email, r]));
  return files.map((f, i) => {
    const name = String(f?.name ?? `Datei ${i + 1}`).slice(0, 200);
    const out: PostPlanItem = { file: name, title: '', body: '', created_at: now(), channel_id: fallback.id, channel_name: fallback.name, author_contact_id: null, author_name: 'Team', pinned: false, warnings: [] };
    const content = String(f?.content ?? '');
    if (content.length > MAX_POST_BYTES) return { ...out, problem: 'Die Datei ist größer als 120 KB' };
    const { meta, body } = parseMarkdownPost(name, content);
    const h1 = /^#\s+(.+)$/m.exec(body);
    const title = (meta.title || h1?.[1] || name.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ')).trim().slice(0, 160);
    const text = !meta.title && h1 && body.startsWith(h1[0]) ? body.slice(h1[0].length).trim() : body;
    if (!title) return { ...out, problem: 'Es gibt keinen Titel' };
    if (!text) return { ...out, title, problem: 'Der Beitrag hat keinen Text' };
    out.title = title;
    out.body = text.slice(0, 20_000);
    if (text.length > 20_000) out.warnings.push('Der Text wurde auf 20.000 Zeichen gekürzt');
    if (meta.date && input.keep_dates !== false) {
      const d = parseDate(meta.date);
      if (d) out.created_at = d;
      else out.warnings.push(`Datum „${meta.date}“ nicht erkannt – es gilt heute`);
    }
    if (meta.channel) {
      const c = channels.find((x) => norm(x.name) === norm(meta.channel) || x.slug === norm(meta.channel).replace(/ /g, '-'));
      if (c) (out.channel_id = c.id, (out.channel_name = c.name));
      else out.warnings.push(`Kanal „${meta.channel}“ gibt es nicht – der Beitrag kommt nach „${fallback.name}“`);
    }
    if (meta.author) {
      const mem = members.get(normalizeEmail(meta.author));
      if (mem) (out.author_contact_id = mem.contact_id, (out.author_name = mem.display_name || meta.author));
      else out.author_name = meta.author.includes('@') ? 'Team' : meta.author.slice(0, 60);
    }
    out.pinned = /^(1|true|yes|ja)$/i.test(meta.pinned ?? '');
    if (/!\[[^\]]*\]\((?!https?:\/\/)/.test(text)) out.warnings.push('Bilder mit lokalem Pfad werden nicht übernommen');
    return out;
  });
}

/** Posts go in as they are: original date, no notification, no points, no rate limit. */
export function runPosts(app: App, g: any, items: PostPlanItem[]): { created: number; skipped: number } {
  let created = 0;
  let skipped = 0;
  app.db.tx(() => {
    for (const it of items) {
      if (it.problem) {
        skipped++;
        continue;
      }
      // The same file imported twice (same title and text) does not make two posts.
      if (app.db.get(`SELECT 1 FROM community_posts WHERE group_id = ? AND title = ? AND body = ? AND status != 'deleted'`, g.id, it.title, it.body)) {
        skipped++;
        continue;
      }
      app.db.insert('community_posts', {
        id: id(), location_id: g.location_id, group_id: g.id, channel_id: it.channel_id, contact_id: it.author_contact_id, user_id: it.author_contact_id ? null : 'import', author_name: it.author_name,
        title: it.title, body: it.body, images: [], pinned: it.pinned ? 1 : 0, status: 'visible', hidden_reason: '', like_count: 0, comment_count: 0, created_at: it.created_at, updated_at: it.created_at, last_activity_at: it.created_at,
      });
      created++;
    }
  });
  return { created, skipped };
}

// --- export (moving away or backing up) ----------------------------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  // Spreadsheets run text that starts with = + - @ as a formula: a leading apostrophe keeps it text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportMembersCsv(app: App, g: any): string {
  const rows = app.db.all<any>(
    `SELECT k.first_name, k.last_name, k.email, m.joined_at, m.level, m.banned_at, ms.status AS membership, t.name AS tier,
       (SELECT COALESCE(SUM(points), 0) FROM community_points WHERE group_id = m.group_id AND contact_id = m.contact_id) AS points
     FROM community_members m JOIN contacts k ON k.id = m.contact_id LEFT JOIN community_memberships ms ON ms.group_id = m.group_id AND ms.contact_id = m.contact_id
     LEFT JOIN community_tiers t ON t.id = ms.tier_id WHERE m.group_id = ? ORDER BY m.joined_at`,
    g.id,
  );
  const head = ['FirstName', 'LastName', 'Email', 'Joined', 'Tier', 'Level', 'Points', 'Status'];
  const lines = rows.map((r) => [r.first_name, r.last_name, r.email, String(r.joined_at ?? '').slice(0, 10), r.tier ?? '', r.level, r.points, r.banned_at ? 'gesperrt' : r.membership ?? 'Mitglied'].map(csvCell).join(','));
  return `﻿${[head.join(','), ...lines].join('\r\n')}\r\n`;
}

export function exportPostsJson(app: App, g: any) {
  const channels = new Map(app.db.all<{ id: string; name: string }>('SELECT id, name FROM community_channels WHERE group_id = ?', g.id).map((c) => [c.id, c.name]));
  return app.db.all<any>(`SELECT * FROM community_posts WHERE group_id = ? AND status != 'deleted' ORDER BY created_at LIMIT 20000`, g.id).map((p) => ({
    id: p.id,
    title: p.title,
    body: p.body,
    channel: channels.get(p.channel_id) ?? '',
    author: p.author_name,
    created_at: p.created_at,
    pinned: !!p.pinned,
    likes: p.like_count,
    comments: app.db.all<any>(`SELECT author_name, body, created_at FROM community_comments WHERE post_id = ? AND status = 'visible' ORDER BY created_at LIMIT 500`, p.id).map((c) => ({ author: c.author_name, body: c.body, created_at: c.created_at })),
  }));
}
