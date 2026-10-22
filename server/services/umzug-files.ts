import { createHash } from 'node:crypto';
import { slugify } from '../core/util.js';
import { NO_LEDGER_SOURCES, guessStd, SOURCE_LABELS, type Batch, type Consent, type ConsentProof, type CountRow, type FieldType, type PartKey, type RContact, type RCourse, type RDeal, type REnrollment, type RPipeline, type RTemplate, type SourceField, type SourceKey, type StepDef } from './umzug-core.js';
import { looksLikeZip, readZip } from './umzug-zip.js';
import { cleanHtml, stripHtml, toCents, toIso } from './umzug-text.js';

/**
 * Export files instead of an API: CSV (comma, semicolon or tab), JSON, HTML and ZIP archives of those.
 * A file is read into tables; the tables of one kind (contacts, deals, courses, students, templates) are
 * turned into the same normalised records the API sources produce, using the vendor's column naming where
 * we know it (Mailchimp's status per file, Pipedrive's "Person - Email - Work" …) and sensible guesses
 * where we do not.
 */

export type FileKind = 'contacts' | 'deals' | 'courses' | 'students' | 'templates';
export const FILE_KINDS: { key: FileKind; label: string; part: PartKey; accept: string[]; describe: string }[] = [
  { key: 'contacts', label: 'Kontakte (CSV)', part: 'contacts', accept: ['.csv', '.tsv', '.txt', '.json', '.zip'], describe: 'Export deiner Kontakte/Abonnenten/Personen – eine oder mehrere CSV-Dateien, auch als ZIP.' },
  { key: 'deals', label: 'Deals (CSV)', part: 'deals', accept: ['.csv', '.tsv', '.txt', '.json'], describe: 'Export deiner Deals bzw. Opportunities mit Pipeline, Stufe, Wert und Person.' },
  { key: 'courses', label: 'Kursaufbau (CSV oder JSON)', part: 'courses', accept: ['.csv', '.json'], describe: 'Kursstruktur: Spalten course, module, lesson, video_url, text – oder JSON mit courses → modules → lessons.' },
  { key: 'students', label: 'Teilnehmer und Zugänge (CSV)', part: 'students', accept: ['.csv', '.tsv', '.txt'], describe: 'Wer hat welchen Kurs: E-Mail, Kurs, Datum, optional Fortschritt.' },
  { key: 'templates', label: 'E-Mail-Vorlagen (HTML)', part: 'templates', accept: ['.html', '.htm', '.zip'], describe: 'HTML-Dateien deiner Vorlagen oder Broadcasts, auch als ZIP.' },
];
export const isFileKind = (v: unknown): v is FileKind => FILE_KINDS.some((k) => k.key === v);

export interface Table {
  name: string;
  header: string[];
  rows: string[][];
  /** JSON files: the parsed document (courses keep their nesting). */
  json?: unknown;
}

export const MAX_ROWS = 1_000_000;

// --- reading ---------------------------------------------------------------------------------------------

function delimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let n = -1;
  for (const d of [',', ';', '\t']) {
    const c = first.split(d).length - 1;
    if (c > n) {
      best = d;
      n = c;
    }
  }
  return best;
}

export function parseDelimited(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const delim = delimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const push = () => {
    row.push(field);
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) push();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      push();
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) throw new Error(`Mehr als ${MAX_ROWS.toLocaleString('de-DE')} Zeilen – bitte die Datei teilen`);
    } else field += ch;
  }
  push();
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const flat = (o: any, prefix = '', out: Record<string, string> = {}, depth = 0): Record<string, string> => {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) out[key] = v.every((x) => x === null || typeof x !== 'object') ? v.map(String).join(', ') : JSON.stringify(v).slice(0, 2000);
    else if (typeof v === 'object') {
      if (depth < 2) flat(v, key, out, depth + 1);
      else out[key] = JSON.stringify(v).slice(0, 2000);
    } else out[key] = String(v);
  }
  return out;
};

function jsonTable(name: string, text: string): Table {
  let doc: any;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error(`„${name}“ ist kein gültiges JSON`);
  }
  const list: any[] = Array.isArray(doc) ? doc : (Object.values(doc ?? {}).find((v) => Array.isArray(v)) as any[]) ?? [];
  const objs = list.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(0, MAX_ROWS);
  const cols: string[] = [];
  const rows = objs.map((o) => flat(o));
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k) && cols.length < 200) cols.push(k);
  return { name, header: cols, rows: rows.map((r) => cols.map((c) => r[c] ?? '')), json: doc };
}

/** UTF-8, or Windows-1252 when the bytes are not valid UTF-8 (Excel's "CSV (Trennzeichen-getrennt)" in German installs). */
export function decodeText(buf: Buffer): string {
  const text = buf.toString('utf8');
  return text.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(buf) : text;
}

/** Reads an upload into tables; ZIP archives are opened (one level). Throws German messages. */
export function parseUpload(name: string, buf: Buffer, depth = 0): Table[] {
  const lower = name.toLowerCase();
  if (looksLikeZip(buf) || lower.endsWith('.zip')) {
    if (depth > 0) throw new Error('Verschachtelte ZIP-Archive werden nicht unterstützt');
    const tables = readZip(buf).flatMap((e) => (/\.(csv|tsv|txt|json|html?)$/i.test(e.name) ? parseUpload(e.name, e.data, depth + 1) : []));
    if (!tables.length) throw new Error('Im Archiv liegt keine CSV-, JSON- oder HTML-Datei');
    return tables;
  }
  if (/\.xlsx?$/i.test(lower)) throw new Error('Excel-Dateien kann ich nicht lesen – bitte in Excel „Speichern unter → CSV UTF-8“ wählen');
  if (/\.html?$/i.test(lower)) return [{ name, header: ['name', 'html'], rows: [[name.replace(/\.[^.]+$/, ''), decodeText(buf)]] }];
  const text = decodeText(buf);
  if (lower.endsWith('.json') || /^\s*[[{]/.test(text.slice(0, 50))) return [jsonTable(name, text)];
  if (text.includes('\u0000')) throw new Error('Das sieht nach einer Binärdatei aus – erwartet wird CSV, JSON, HTML oder ZIP');
  const rows = parseDelimited(text);
  if (rows.length < 1) throw new Error(`„${name}“ ist leer`);
  const header = rows[0].map((h) => h.trim());
  return [{ name, header, rows: rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')) }];
}

/** What the wizard shows about an uploaded table: size and columns (no rows: the database never keeps people's data from a file). */
export function tableInfo(t: Table) {
  return { name: t.name, columns: t.header.length, rows: t.rows.length, header: t.header.slice(0, 60) };
}

export function guessKind(tables: Table[]): FileKind {
  const h = tables.flatMap((t) => t.header.map((x) => x.toLowerCase()));
  const has = (re: RegExp) => h.some((x) => re.test(x));
  if (tables.every((t) => t.header.join() === 'name,html')) return 'templates';
  if (tables.some((t) => t.json && Array.isArray((t.json as any)?.courses))) return 'courses';
  if (has(/^(module|modul)$/) && has(/^(lesson|lektion|lecture)$/)) return 'courses';
  if (has(/stage|stufe|pipeline|deal/) && has(/value|amount|wert|title|name/) && !has(/^(email|e-?mail)/)) return 'deals';
  if (has(/stage|stufe|pipeline/) && has(/(deal|opportunity).*(title|name)|^(deal|opportunity)$/)) return 'deals';
  if (has(/^(course|kurs|product|produkt)/) && has(/e-?mail/) && !has(/^(tags?)$/)) return 'students';
  return 'contacts';
}

export interface LoadedFile {
  id: string;
  name: string;
  kind: FileKind;
  tables: Table[];
}

// --- contact tables ----------------------------------------------------------------------------------------

const RE = {
  tags: /^(tags?|labels?|schlagw(ö|oe)rter|segments?|lists?|listen|groups?|gruppen)$/i,
  status: /^(status|state|subscription ?status|email ?status|e-?mail ?status|subscribed|opt-?in ?status|abo-?status|marketing ?status)$/i,
  id: /^(id|contact ?id|person ?id|leid|euid|subscriber ?id|user ?id|record ?id|kontakt-?id)$/i,
  created: /^(created( at| on| date)?|date ?(added|created)|sign-?up( date| at)?|signed ?up( at)?|optin_time|confirm_time|added( at| on)?|subscribed at|erstellt( am)?|registriert)$/i,
  name: /^(name|full ?name|contact ?name|vor-? und nachname)$/i,
  skip: /^(latitude|longitude|gmtoff|dstoff|timezone|cc|region|leid|euid|optin_ip|confirm_ip|member_rating|last_changed|unsub_.*|clean_.*|notes?|last ?(sign|log)-?in.*|last ?activity.*|ip.*)$/i,
};

export function consentOf(v: string): Consent | undefined {
  const s = v.trim().toLowerCase();
  if (!s) return undefined;
  if (/bounce|cleaned|invalid|unzustellbar|hard ?bounce/.test(s)) return 'bounced';
  if (/complain|spam/.test(s)) return 'complained';
  if (/unsub|abgemeldet|opted ?out|opt-?out|cancel|nonmarketable|do ?not|inactive|abbestellt|^(no|nein|false|0)$/.test(s)) return 'unsubscribed';
  if (/pending|unconfirmed|unbest|double|awaiting/.test(s)) return 'pending';
  if (/archived|deleted|gelöscht|blocked|gesperrt/.test(s)) return 'blocked';
  if (/subscribed|active|aktiv|abonniert|opted ?in|opt-?in|marketable|^(yes|ja|true|1)$/.test(s)) return 'ok';
  return undefined;
}

/** Mailchimp splits its export into one file per status; the file name says which. */
function statusFromName(name: string): Consent | undefined {
  const n = name.toLowerCase();
  if (/unsubscribed/.test(n)) return 'unsubscribed';
  if (/cleaned/.test(n)) return 'bounced';
  if (/non[_-]?subscribed|pending/.test(n)) return 'pending';
  if (/subscribed/.test(n)) return 'ok';
  return undefined;
}

const headHead = (h: string) =>
  h
    .trim()
    .replace(/^(person|deal|organization|organisation|contact|subscriber)\s*[-–:]\s*/i, '')
    .replace(/\s*[-–]\s*(work|home|other|mobile|arbeit|privat|büro)$/i, '');

const typeOf = (h: string): FieldType => {
  const s = h.toLowerCase();
  if (/phone|telefon|mobil|handy/.test(s)) return 'phone';
  if (/e-?mail/.test(s)) return 'email';
  if (/birth|geburt|date|datum|_time$|\bam$/.test(s)) return 'date';
  if (/website|url|link|webseite/.test(s)) return 'url';
  if (/count|anzahl|number|amount|betrag|score|rating/.test(s)) return 'number';
  return 'text';
};

interface ContactCols {
  header: string[];
  email: number;
  id: number;
  tags: number[];
  status: number;
  created: number;
  name: number;
  first: number;
  last: number;
  /** Source field list for the mapping (incl. virtual first/last name from a combined name). */
  fields: SourceField[];
  refs: string[];
  splitName: boolean;
}

/** Roles of a contact table's columns; refs are the header texts (made unique). */
export function contactCols(header: string[], rows: string[][]): ContactCols {
  const refs: string[] = [];
  const seen = new Map<string, number>();
  for (const h of header) {
    const base = h || 'Spalte';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    refs.push(n > 1 ? `${base} #${n}` : base);
  }
  const find = (re: RegExp) => header.findIndex((h) => re.test(headHead(h)));
  const stdIdx = (t: string) => header.findIndex((h) => guessStd(headHead(h)) === t);
  const email = stdIdx('email');
  const first = stdIdx('first_name');
  const last = stdIdx('last_name');
  const name = first < 0 && last < 0 ? find(RE.name) : -1;
  const tags = header.map((h, i) => (RE.tags.test(headHead(h)) ? i : -1)).filter((i) => i >= 0);
  const status = find(RE.status);
  const created = find(RE.created);
  const id = find(RE.id);
  const sample = (i: number) => rows.map((r) => r[i]?.trim()).filter(Boolean).slice(0, 3) as string[];
  const fields: SourceField[] = header.map((h, i) => {
    const std = guessStd(headHead(h));
    const f: SourceField = { ref: refs[i], label: h || `Spalte ${i + 1}`, type: typeOf(h), sample: sample(i), group: std ? 'standard' : 'custom' };
    if (std && i !== name) f.std = std;
    if (tags.includes(i)) f.preset = 'tag';
    else if (i === name || RE.status.test(headHead(h)) || RE.created.test(headHead(h)) || RE.id.test(headHead(h)) || RE.skip.test(headHead(h))) f.preset = '';
    return f;
  });
  if (name >= 0) {
    fields.push({ ref: '__first', label: `Vorname (aus „${header[name]}“)`, type: 'text', std: 'first_name', sample: sample(name).map((v) => v.split(/\s+/)[0]), group: 'standard' });
    fields.push({ ref: '__last', label: `Nachname (aus „${header[name]}“)`, type: 'text', std: 'last_name', sample: sample(name).map((v) => v.split(/\s+/).slice(1).join(' ')).filter(Boolean), group: 'standard' });
  }
  return { header, email, id, tags, status, created, name, first, last, fields, refs, splitName: name >= 0 };
}

/** Ids in the id map never hold an e-mail address (it is personal data the erasure would have to chase): a hash stands for it. */
export const emailExt = (email: string) => `e:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 20)}`;

const OPT_MAIL = /^(opt-?in[ _-]?e-?mail|e-?mail[ _-]?opt-?in|optin_email)$/i;
const OPT_SMS = /^(opt-?in[ _-]?(phone|sms|whatsapp|telefon|handy)|(phone|sms|whatsapp|telefon)[ _-]?opt-?in|optin_phone)$/i;

const emailOk = (s: string) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s);

export function contactRecord(cols: ContactCols, row: string[], tableName: string, n: number, source: SourceKey): RContact | undefined {
  const get = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
  const email = get(cols.email).toLowerCase();
  const values: Record<string, unknown> = {};
  cols.header.forEach((_h, i) => {
    const v = (row[i] ?? '').trim();
    if (v) values[cols.refs[i]] = v;
  });
  if (cols.splitName) {
    const parts = get(cols.name).split(/\s+/).filter(Boolean);
    if (parts.length) {
      values.__first = parts[0];
      if (parts.length > 1) values.__last = parts.slice(1).join(' ');
    }
  }
  const idv = get(cols.id);
  const ext = emailOk(email) ? emailExt(email) : idv ? `id:${idv}` : `row:${slugify(tableName)}:${n}`;
  let consent: Consent | undefined = cols.status >= 0 ? consentOf(get(cols.status)) : undefined;
  const byFile = statusFromName(tableName);
  if (!consent && byFile && source === 'mailchimp') consent = byFile;
  const hasCol = (re: RegExp) => cols.header.findIndex((h) => re.test(h));
  if (!consent && source === 'mailchimp') {
    if (hasCol(/^UNSUB_TIME$/i) >= 0 && get(hasCol(/^UNSUB_TIME$/i))) consent = 'unsubscribed';
    else if (hasCol(/^CLEAN_TIME$/i) >= 0 && get(hasCol(/^CLEAN_TIME$/i))) consent = 'bounced';
  }
  const rec: RContact = { kind: 'contact', ext, values, created_at: cols.created >= 0 ? toIso(get(cols.created)) : undefined };
  if (consent) {
    rec.consent = consent;
    rec.native_status = cols.status >= 0 ? get(cols.status) : (byFile ? tableName.replace(/\.[^.]+$/, '') : undefined);
  }
  // Newer sources also tell the consent ledger: a file proves nothing but "was on the list" (legacy) or the withdrawal –
  // unless it has opt-in columns of its own (ManyChat: "Opt-in E-Mail", "Opt-in Telefon"), which are the person's explicit yes or no.
  if (!NO_LEDGER_SOURCES.has(source)) {
    const proofs: ConsentProof[] = [];
    const optCol = (re: RegExp) => cols.header.findIndex((h) => re.test(h.trim()));
    const yes = (i: number) => (i < 0 ? undefined : /^(yes|ja|true|1|y|x)$/i.test(get(i)) ? true : /^(no|nein|false|0|n)$/i.test(get(i)) ? false : undefined);
    const optMail = yes(optCol(OPT_MAIL));
    const optSms = yes(optCol(OPT_SMS));
    if (emailOk(email)) {
      if (consent && consent !== 'ok' && consent !== 'pending' && consent !== 'unknown') proofs.push({ basis: 'revoked', at: undefined });
      else if (consent === 'pending' || consent === 'unknown') {
        /* nothing to say */
      } else if (optMail === true) proofs.push({ basis: 'confirmed', method: 'Opt-in-Spalte der Export-Datei', at: rec.created_at });
      else if (optMail === false) proofs.push({ basis: 'none', method: 'Opt-in-Spalte der Export-Datei: nein' });
      else proofs.push({ basis: 'legacy', method: 'Export-Datei', at: rec.created_at });
    }
    if (optSms === true) proofs.push({ channel: 'sms', basis: 'confirmed', method: 'Opt-in-Spalte der Export-Datei', at: rec.created_at });
    else if (optSms === false) proofs.push({ channel: 'sms', basis: 'none', method: 'Opt-in-Spalte der Export-Datei: nein' });
    if (proofs.length) rec.proof = proofs;
  }
  if (!emailOk(email) && !Object.keys(values).length) return undefined;
  return rec;
}

/** Contact fields of all contact tables (same header = same field). */
export function fileContactFields(tables: Table[]): SourceField[] {
  const out = new Map<string, SourceField>();
  for (const t of tables) {
    for (const f of contactCols(t.header, t.rows.slice(0, 200)).fields) if (!out.has(f.ref)) out.set(f.ref, f);
  }
  return [...out.values()];
}

// --- deals -----------------------------------------------------------------------------------------------------

const DEAL = {
  title: /^(title|name|deal ?(title|name)?|opportunity( title| name)?|titel|bezeichnung)$/i,
  value: /^(value|amount|revenue|wert|betrag|deal ?value|projected_revenue.*)$/i,
  stage: /^(stage|deal ?stage|stufe|phase|pipeline ?stage)$/i,
  pipeline: /^(pipeline|deal ?pipeline|group)$/i,
  status: /^(status|deal ?status)$/i,
  email: /^(e-?mail.*|contact ?e-?mail|person ?e-?mail.*)$/i,
  person: /^(person|contact( name)?|contact|kontakt|name of person)$/i,
  org: /^(organi[sz]ation|company|account|firma)$/i,
  created: /^(created( at| on| date)?|add time|deal created|erstellt|date ?created)$/i,
  id: /^(id|deal ?id)$/i,
};

export function dealRecords(tables: Table[]): { pipelines: RPipeline[]; deals: RDeal[] } {
  const pipes = new Map<string, RPipeline>();
  const deals: RDeal[] = [];
  let n = 0;
  for (const t of tables) {
    const find = (re: RegExp) => t.header.findIndex((h) => re.test(headHead(h)) || re.test(h.trim()));
    const c = { title: find(DEAL.title), value: find(DEAL.value), stage: find(DEAL.stage), pipeline: find(DEAL.pipeline), status: find(DEAL.status), email: find(DEAL.email), person: find(DEAL.person), org: find(DEAL.org), created: find(DEAL.created), id: find(DEAL.id) };
    for (const row of t.rows) {
      n++;
      const get = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
      const title = get(c.title);
      if (!title) continue;
      const pName = get(c.pipeline) || 'Importierte Pipeline';
      const pExt = slugify(pName);
      const p = pipes.get(pExt) ?? { kind: 'pipeline' as const, ext: pExt, name: pName, stages: [] };
      pipes.set(pExt, p);
      const sName = get(c.stage) || 'Neu';
      const sExt = slugify(sName);
      if (!p.stages.some((s) => s.ext === sExt)) p.stages.push({ ext: sExt, name: sName });
      const st = get(c.status).toLowerCase();
      const status: 'open' | 'won' | 'lost' = /won|gewonnen/.test(st) || /^(closed ?won|gewonnen)/i.test(sName) ? 'won' : /lost|verloren/.test(st) || /^(closed ?lost|verloren)/i.test(sName) ? 'lost' : 'open';
      const email = get(c.email).toLowerCase();
      const person = get(c.person);
      deals.push({
        kind: 'deal',
        ext: get(c.id) ? `id:${get(c.id)}` : `row:${n}`,
        name: title,
        value: Math.round(toCents(get(c.value)) / 100),
        pipeline: pExt,
        stage: sExt,
        status,
        created_at: toIso(get(c.created)),
        contact: emailOk(email) ? emailExt(email) : undefined,
        contact_hint: emailOk(email) || person ? { name: person || undefined, email: emailOk(email) ? email : undefined } : undefined,
      });
    }
  }
  return { pipelines: [...pipes.values()], deals };
}

// --- courses and students ------------------------------------------------------------------------------------------

export function courseRecords(tables: Table[]): RCourse[] {
  const out = new Map<string, RCourse>();
  for (const t of tables) {
    const j: any = t.json;
    const docs: any[] = Array.isArray(j?.courses) ? j.courses : Array.isArray(j) && j.some((c: any) => Array.isArray(c?.modules)) ? j : [];
    docs.forEach((c, ci) => {
      const title = String(c.title ?? c.name ?? `Kurs ${ci + 1}`);
      const ext = slugify(title);
      out.set(ext, {
        kind: 'course',
        ext,
        title,
        description: stripHtml(c.description ?? ''),
        cover: c.cover ?? c.image_url ?? c.cover_image,
        modules: (c.modules ?? c.sections ?? []).map((m: any, mi: number) => ({
          ext: `m${mi + 1}-${slugify(String(m.title ?? m.name ?? ''))}`,
          title: String(m.title ?? m.name ?? `Modul ${mi + 1}`),
          lessons: (m.lessons ?? m.lectures ?? []).map((l: any, li: number) => ({ ext: `l${li + 1}-${slugify(String(l.title ?? l.name ?? ''))}`, title: String(l.title ?? l.name ?? `Lektion ${li + 1}`), video_url: l.video_url ?? l.video ?? undefined, body: l.body ?? l.text ?? l.content ?? '', duration_min: Number(l.duration_min ?? l.duration) || 0 })),
        })),
      });
    });
    if (docs.length) continue;
    const find = (re: RegExp) => t.header.findIndex((h) => re.test(h.trim()));
    const c = { course: find(/^(course|kurs|product|produkt)( title| name| titel)?$/i), module: find(/^(module|modul|section|abschnitt)( title| name| titel)?$/i), lesson: find(/^(lesson|lektion|lecture|video)( title| name| titel)?$/i), video: find(/^(video|video[_ ]?url|url|link)$/i), text: find(/^(text|body|content|inhalt|description|beschreibung)$/i), dur: find(/^(duration|dauer)([_ ]?min.*)?$/i) };
    for (const row of t.rows) {
      const get = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
      const lesson = get(c.lesson);
      const title = get(c.course) || 'Importierter Kurs';
      if (!lesson && !get(c.module)) continue;
      const ext = slugify(title);
      const course = out.get(ext) ?? { kind: 'course' as const, ext, title, modules: [] };
      out.set(ext, course);
      const mTitle = get(c.module) || 'Modul 1';
      const mExt = slugify(mTitle);
      let m = course.modules.find((x) => x.ext === mExt);
      if (!m) course.modules.push((m = { ext: mExt, title: mTitle, lessons: [] }));
      if (lesson) m.lessons.push({ ext: `${m.lessons.length + 1}-${slugify(lesson)}`, title: lesson, video_url: /^https?:\/\//i.test(get(c.video)) ? get(c.video) : undefined, body: get(c.text), duration_min: Number(get(c.dur)) || 0 });
    }
  }
  return [...out.values()];
}

export function studentRecords(tables: Table[]): REnrollment[] {
  const out: REnrollment[] = [];
  for (const t of tables) {
    const find = (re: RegExp) => t.header.findIndex((h) => re.test(headHead(h)));
    const c = { email: find(/^e-?mail.*/i), name: find(RE.name), course: find(/^(course|kurs|product|produkt)( title| name)?$/i), at: find(/^(enrolled( at| on| date)?|date ?enrolled|created( at)?|eingeschrieben( am)?|signed ?up|datum)$/i), done: find(/^(completed( at| on)?|abgeschlossen( am)?|completion ?date)$/i) };
    t.rows.forEach((row, i) => {
      const get = (k: number) => (k >= 0 ? (row[k] ?? '').trim() : '');
      const email = get(c.email).toLowerCase();
      if (!emailOk(email)) return;
      const course = slugify(get(c.course) || 'Importierter Kurs');
      out.push({ kind: 'enrollment', ext: `${course}:${emailExt(email)}`, course, contact: emailExt(email), email, name: get(c.name) || undefined, enrolled_at: toIso(get(c.at)), completed_at: toIso(get(c.done)) });
      void i;
    });
  }
  return out;
}

export function templateRecords(tables: Table[]): RTemplate[] {
  const out: RTemplate[] = [];
  for (const t of tables) {
    const ni = t.header.indexOf('name');
    const hi = t.header.indexOf('html');
    if (ni < 0 || hi < 0) continue;
    for (const row of t.rows) {
      const html = cleanHtml(row[hi] ?? '');
      const subject = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
      out.push({ kind: 'template', ext: slugify(row[ni] || 'vorlage'), name: row[ni] || 'Vorlage', subject: subject ? stripHtml(subject).slice(0, 300) : undefined, html });
    }
  }
  return out;
}

// --- steps and counts ----------------------------------------------------------------------------------------------------

const PAGE = 200;
const tablesOf = (files: LoadedFile[], kind: FileKind) => files.filter((f) => f.kind === kind).flatMap((f) => f.tables);

export function fileCounts(files: LoadedFile[]): CountRow[] {
  const out: CountRow[] = [];
  const contacts = tablesOf(files, 'contacts');
  if (contacts.length) out.push({ part: 'contacts', key: 'contacts', label: 'Kontakte', total: contacts.reduce((n, t) => n + t.rows.length, 0) });
  const deals = tablesOf(files, 'deals');
  if (deals.length) {
    const { pipelines, deals: d } = dealRecords(deals);
    out.push({ part: 'deals', key: 'pipelines', label: 'Pipelines', total: pipelines.length }, { part: 'deals', key: 'deals', label: 'Deals', total: d.length });
  }
  const courses = tablesOf(files, 'courses');
  if (courses.length) {
    const cs = courseRecords(courses);
    out.push({ part: 'courses', key: 'courses', label: 'Kurse', total: cs.length }, { part: 'courses', key: 'lessons', label: 'Lektionen', total: cs.reduce((n, c) => n + c.modules.reduce((m, x) => m + x.lessons.length, 0), 0) });
  }
  const students = tablesOf(files, 'students');
  if (students.length) out.push({ part: 'students', key: 'students', label: 'Zugänge', total: studentRecords(students).length });
  const templates = tablesOf(files, 'templates');
  if (templates.length) out.push({ part: 'templates', key: 'templates', label: 'E-Mail-Vorlagen', total: templateRecords(templates).length });
  return out;
}

export function fileParts(files: LoadedFile[]): PartKey[] {
  return [...new Set(files.map((f) => FILE_KINDS.find((k) => k.key === f.kind)!.part))];
}

/** Steps for the uploaded files (pages of 200 rows; the cursor is the row offset). */
export function fileSteps(source: SourceKey, files: LoadedFile[], parts: PartKey[]): StepDef[] {
  const steps: StepDef[] = [];
  const contactTables = tablesOf(files, 'contacts');
  if (parts.includes('contacts') && contactTables.length) {
    steps.push({
      id: 'contacts',
      label: 'Kontakte',
      part: 'contacts',
      async *run(ctx) {
        const all = contactTables.flatMap((t) => {
          const cols = contactCols(t.header, t.rows);
          return t.rows.map((row, i) => ({ cols, row, name: t.name, n: i + 1 }));
        });
        for (let at = Number(ctx.cursor ?? 0); at < all.length; at += PAGE) {
          const slice = all.slice(at, at + PAGE);
          const records = slice.map((x) => contactRecord(x.cols, x.row, x.name, x.n, source)).filter((r): r is RContact => !!r);
          yield { records, cursor: at + PAGE < all.length ? at + PAGE : undefined, total: all.length } satisfies Batch;
        }
      },
    });
  }
  const dealTables = tablesOf(files, 'deals');
  if (parts.includes('deals') && dealTables.length) {
    steps.push({
      id: 'deals',
      label: 'Pipelines und Deals',
      part: 'deals',
      async *run(ctx) {
        const { pipelines, deals } = dealRecords(dealTables);
        const cur = (ctx.cursor ?? {}) as { at?: number };
        if (cur.at === undefined) yield { records: pipelines, cursor: { at: 0 } };
        for (let i = cur.at ?? 0; i < deals.length; i += PAGE) yield { records: deals.slice(i, i + PAGE), cursor: i + PAGE < deals.length ? { at: i + PAGE } : undefined, total: deals.length };
      },
    });
  }
  const courseTables = tablesOf(files, 'courses');
  if (parts.includes('courses') && courseTables.length) {
    steps.push({
      id: 'courses',
      label: 'Kurse und Lektionen',
      part: 'courses',
      async *run() {
        const courses = courseRecords(courseTables);
        for (const c of courses) yield { records: [c], cursor: undefined };
      },
    });
  }
  const studentTables = tablesOf(files, 'students');
  if (parts.includes('students') && studentTables.length) {
    steps.push({
      id: 'students',
      label: 'Teilnehmer und Zugänge',
      part: 'students',
      async *run(ctx) {
        const list = studentRecords(studentTables);
        for (let at = Number(ctx.cursor ?? 0); at < list.length; at += PAGE) yield { records: list.slice(at, at + PAGE), cursor: at + PAGE < list.length ? at + PAGE : undefined, total: list.length };
      },
    });
  }
  const templateTables = tablesOf(files, 'templates');
  if (parts.includes('templates') && templateTables.length) {
    steps.push({
      id: 'templates',
      label: 'E-Mail-Vorlagen',
      part: 'templates',
      async *run() {
        yield { records: templateRecords(templateTables), cursor: undefined };
      },
    });
  }
  return steps;
}

/** One line for the wizard: what we think the file is. */
export function detectLabel(source: SourceKey, tables: Table[], kind: FileKind): string {
  const h = tables.flatMap((t) => t.header).join('|');
  if (source === 'mailchimp' && kind === 'contacts' && /LEID|OPTIN_TIME|MEMBER_RATING/i.test(h)) return 'Mailchimp-Audience-Export erkannt';
  if (source === 'pipedrive' && /(person|deal) - /i.test(h)) return 'Pipedrive-Export erkannt';
  return `${SOURCE_LABELS[source]}: ${FILE_KINDS.find((k) => k.key === kind)!.label}`;
}
