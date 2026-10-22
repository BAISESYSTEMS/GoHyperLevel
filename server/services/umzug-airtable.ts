import type { Account, Batch, CountRow, PartKey, RObjectLink, RObjectProp, RObjectRecord, RObjectType, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, seg, stubCtx } from './umzug-lib.js';
import { clip, toIso } from './umzug-text.js';

/**
 * Airtable (Web API, https://api.airtable.com/v0, a personal access token): every table → a custom object with typed properties (the
 * primary field is the display property), every record → a record, linked records → links between the records. Fields are read by
 * their id, so renamed or duplicate names do no harm. Airtable allows five requests a second per base and answers a 429 with "wait 30
 * seconds": the first retry waits that long. Attachments are not copied (their addresses expire after two hours): the file names are kept.
 */

const API = 'https://api.airtable.com/v0';
const PAGE = 100;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Airtable',
    base: API,
    headers: () => ({ authorization: `Bearer ${String(creds.token ?? '').trim()}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    // five requests a second per base
    pauseMs: deps.pauseMs ?? 230,
    // a 429 locks the base for 30 seconds
    retryBaseMs: 30_000,
    errorText: (b) => (typeof b?.error?.message === 'string' ? b.error.message : typeof b?.error === 'string' ? b.error : undefined),
  });

export const baseId = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const m = /\bapp[A-Za-z0-9]{5,}/.exec(s);
  if (!m) throw new UmzugError(400, 'Airtable: Die Base-ID beginnt mit „app“ und steht in der Adresse deiner Base (airtable.com/appXXXXXXXXXXXXXX/…)');
  return m[0];
};

async function allBases(h: VendorHttp, creds: Record<string, string>): Promise<Json[]> {
  const only = baseId(creds.base_id);
  const out: Json[] = [];
  let offset: string | undefined;
  for (let i = 0; i < 50; i++) {
    const j = await h.get('/meta/bases', offset ? { offset } : {});
    out.push(...(Array.isArray(j?.bases) ? j.bases : []));
    offset = typeof j?.offset === 'string' && j.offset ? j.offset : undefined;
    if (!offset) break;
  }
  const list = out.filter((b) => b.permissionLevel !== 'none' && (!only || b.id === only));
  if (only && !list.length) throw new UmzugError(400, 'Airtable: Diese Base ist mit dem Token nicht erreichbar – beim Token die Base freigeben (Scope „schema.bases:read“ und „data.records:read“)');
  return list;
}

async function tablesOf(h: VendorHttp, base: string): Promise<Json[]> {
  const j = await h.get(`/meta/bases/${seg(base)}/tables`);
  return Array.isArray(j?.tables) ? j.tables : [];
}

// --- fields -----------------------------------------------------------------------------------------------------

type Mapped = { type: RObjectProp['type']; options?: string[] } | 'link' | undefined;

const RESULT_TYPES: Record<string, RObjectProp['type']> = { number: 'number', currency: 'currency', percent: 'number', rating: 'number', date: 'date', dateTime: 'datetime', checkbox: 'checkbox', singleLineText: 'text', multilineText: 'textarea', richText: 'textarea', email: 'text', url: 'text', phoneNumber: 'text', duration: 'text', singleSelect: 'text' };

/** What a field becomes: a property type, "link" (a relation), or nothing (a button). */
export function airtableMap(f: Json): Mapped {
  const choices = (): string[] => (Array.isArray(f.options?.choices) ? f.options.choices.map((c: Json) => String(c.name)).filter(Boolean) : []);
  switch (f.type) {
    case 'singleLineText':
      return { type: 'text' };
    case 'multilineText':
    case 'richText':
      return { type: 'textarea' };
    case 'email':
      return { type: 'email' };
    case 'url':
      return { type: 'url' };
    case 'phoneNumber':
      return { type: 'phone' };
    case 'number':
    case 'percent':
    case 'rating':
    case 'autoNumber':
    case 'count':
      return { type: 'number' };
    case 'currency':
      return { type: 'currency' };
    case 'singleSelect':
      return choices().length ? { type: 'select', options: choices() } : { type: 'text' };
    case 'multipleSelects':
      return choices().length ? { type: 'multiselect', options: choices() } : { type: 'text' };
    case 'checkbox':
      return { type: 'checkbox' };
    case 'date':
      return { type: 'date' };
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return { type: f.options?.result?.type === 'date' ? 'date' : 'datetime' };
    case 'multipleRecordLinks':
      return f.options?.linkedTableId ? 'link' : undefined;
    case 'formula':
    case 'rollup':
    case 'multipleLookupValues': {
      const t = RESULT_TYPES[String(f.options?.result?.type ?? '')];
      // A lookup that returns several values is text (a list); only a single number / date / flag keeps its type.
      return f.type === 'multipleLookupValues' || !t ? { type: 'text' } : { type: t };
    }
    case 'singleCollaborator':
    case 'multipleCollaborators':
    case 'createdBy':
    case 'lastModifiedBy':
    case 'multipleAttachments':
    case 'barcode':
    case 'aiText':
    case 'externalSyncSource':
    case 'duration':
      return { type: 'text' };
    default:
      return undefined;
  }
}

const who = (u: Json): string => String(u?.name ?? u?.email ?? '');

/** One cell as something simple. Linked records are left out (the link step handles them). */
export function airtableValue(f: Json, v: unknown): unknown {
  if (v === undefined || v === null || v === '') return undefined;
  switch (f.type) {
    case 'percent':
      return typeof v === 'number' ? Math.round(v * 100 * 1e8) / 1e8 : undefined;
    case 'duration': {
      const s = Number(v);
      if (!Number.isFinite(s)) return undefined;
      return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    }
    case 'singleCollaborator':
    case 'createdBy':
    case 'lastModifiedBy':
      return who(v as Json) || undefined;
    case 'multipleCollaborators':
      return (Array.isArray(v) ? v : []).map((u) => who(u)).filter(Boolean).join(', ') || undefined;
    case 'multipleSelects':
      return (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x : String((x as Json)?.name ?? ''))).filter(Boolean);
    case 'multipleAttachments':
      return (Array.isArray(v) ? v : []).map((a: Json) => String(a.filename ?? '')).filter(Boolean).join(', ') || undefined;
    case 'barcode':
      return (v as Json)?.text ? String((v as Json).text) : undefined;
    case 'aiText':
      return (v as Json)?.value ? String((v as Json).value) : undefined;
    case 'button':
    case 'multipleRecordLinks':
      return undefined;
    case 'checkbox':
      return v === true ? true : undefined;
    case 'multipleLookupValues':
    case 'rollup':
    case 'formula': {
      if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? who(x as Json) || ((x as Json).filename ? String((x as Json).filename) : '') : String(x))).filter(Boolean).join(', ') || undefined;
      if (typeof v === 'object') return undefined;
      return typeof v === 'number' && f.type !== 'multipleLookupValues' && f.options?.result?.type === 'percent' ? Math.round(v * 100 * 1e8) / 1e8 : v;
    }
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return typeof v === 'string' ? (f.options?.result?.type === 'date' ? v.slice(0, 10) : v) : undefined;
    default:
      return typeof v === 'object' ? undefined : v;
  }
}

export function airtableType(base: Json, table: Json, multi: boolean): { rec: RObjectType; links: { field: string; target: string }[] } {
  const props: RObjectProp[] = [];
  const links: { field: string; target: string }[] = [];
  const primary = String(table.primaryFieldId ?? '');
  for (const f of Array.isArray(table.fields) ? table.fields : []) {
    const m = airtableMap(f);
    if (m === 'link') {
      links.push({ field: String(f.id), target: String(f.options.linkedTableId) });
      continue;
    }
    if (!m) continue;
    const p: RObjectProp = { ext: String(f.id), label: String(f.name), type: m.type, options: m.options, primary: String(f.id) === primary };
    if (p.primary) props.unshift({ ...p, type: 'text', options: undefined });
    else props.push(p);
  }
  const name = String(table.name ?? table.id);
  return {
    rec: { kind: 'object_type', ext: String(table.id), singular: multi ? `${base.name} › ${name}` : name, plural: multi ? `${base.name} › ${name}` : name, description: clip(table.description, 400) || undefined, properties: props },
    links,
  };
}

export function airtableRecord(r: Json, table: Json): RObjectRecord {
  const byId = new Map<string, Json>((Array.isArray(table.fields) ? table.fields : []).map((f: Json) => [String(f.id), f]));
  const values: Record<string, unknown> = {};
  for (const [fid, raw] of Object.entries((r.fields ?? {}) as Record<string, unknown>)) {
    const f = byId.get(fid);
    if (!f) continue;
    const m = airtableMap(f);
    if (!m || m === 'link') continue;
    const v = airtableValue(f, raw);
    if (v !== undefined) values[fid] = v;
  }
  return { kind: 'object_record', ext: `rec:${r.id}`, type: String(table.id), values, created_at: toIso(r.createdTime) };
}

// --- reading ----------------------------------------------------------------------------------------------------

async function* records(h: VendorHttp, base: string, table: string, ctx: StepCtx, start?: string, only?: string[]): AsyncGenerator<{ items: Json[]; next: string | undefined }> {
  let offset = start;
  for (;;) {
    if (ctx.cancelled()) return;
    const fields = (only ?? []).map((f) => `fields%5B%5D=${encodeURIComponent(f)}`).join('&');
    const j = await h.get(`/${seg(base)}/${seg(table)}?pageSize=${PAGE}&returnFieldsByFieldId=true${fields ? `&${fields}` : ''}`, offset ? { offset } : {});
    const next = typeof j?.offset === 'string' && j.offset ? j.offset : undefined;
    yield { items: Array.isArray(j?.records) ? j.records : [], next };
    if (!next) return;
    offset = next;
  }
}

/** Every table of every (chosen) base, in a stable order, with resume support. */
async function* eachTable(h: VendorHttp, ctx: StepCtx): AsyncGenerator<{ base: Json; table: Json; multi: boolean; start?: string }> {
  const resume = ctx.cursor as { table?: string; offset?: string; done?: boolean } | undefined;
  let skipping = !!resume?.table;
  const bases = await allBases(h, ctx.creds);
  for (const base of bases) {
    for (const table of await tablesOf(h, String(base.id))) {
      let start: string | undefined;
      if (skipping) {
        if (String(table.id) !== resume!.table) continue;
        skipping = false;
        if (resume!.done) continue;
        start = resume!.offset;
      }
      yield { base, table, multi: bases.length > 1, start };
    }
  }
}

const steps = (): StepDef[] => [
  {
    id: 'tables',
    label: 'Tabellen → eigene Objekte',
    part: 'objects',
    async *run(ctx): AsyncGenerator<Batch> {
      const bases = await allBases(ctx.http, ctx.creds);
      const out: RObjectType[] = [];
      for (const base of bases) {
        for (const table of await tablesOf(ctx.http, String(base.id))) {
          const t = airtableType(base, table, bases.length > 1);
          out.push(t.rec);
          const skipped = (Array.isArray(table.fields) ? table.fields : []).filter((f: Json) => !airtableMap(f)).map((f: Json) => `${f.name} (${f.type})`);
          if (skipped.length) ctx.warn(`Tabelle „${clip(table.name, 40)}“: Felder ohne Gegenstück (nicht übernommen): ${skipped.slice(0, 6).join(', ')}`);
          if ((Array.isArray(table.fields) ? table.fields : []).some((f: Json) => f.type === 'multipleAttachments')) ctx.warn(`Tabelle „${clip(table.name, 40)}“: Anhänge werden nicht kopiert (die Adressen laufen bei Airtable nach zwei Stunden ab) – nur die Dateinamen kommen mit`);
        }
      }
      if (out.length) yield { records: out };
    },
  },
  {
    id: 'records',
    label: 'Datensätze',
    part: 'objects',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const { base, table, start } of eachTable(ctx.http, ctx)) {
        for await (const pg of records(ctx.http, String(base.id), String(table.id), ctx, start)) {
          yield { records: pg.items.map((r) => airtableRecord(r, table)), cursor: pg.next ? { table: String(table.id), offset: pg.next } : { table: String(table.id), done: true } };
        }
      }
    },
  },
  {
    id: 'links',
    label: 'Verknüpfte Datensätze → Verknüpfungen',
    part: 'objects',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const { base, table, start } of eachTable(ctx.http, ctx)) {
        const fields: Json[] = (Array.isArray(table.fields) ? table.fields : []).filter((f: Json) => airtableMap(f) === 'link');
        if (!fields.length) continue;
        for await (const pg of records(ctx.http, String(base.id), String(table.id), ctx, start, fields.map((f) => String(f.id)))) {
          const out: RObjectLink[] = [];
          for (const r of pg.items) for (const f of fields) for (const to of Array.isArray(r.fields?.[f.id]) ? r.fields[f.id] : []) out.push({ kind: 'object_link', ext: `${r.id}>${to}`, a: `rec:${r.id}`, b: `rec:${typeof to === 'string' ? to : to?.id}` });
          yield { records: out, cursor: pg.next ? { table: String(table.id), offset: pg.next } : { table: String(table.id), done: true } };
        }
      }
    },
  },
];

// --- describe ---------------------------------------------------------------------------------------------------

async function describe(h: VendorHttp, parts: PartKey[], creds: Record<string, string>) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const s = { ...stubCtx(h, parts), creds };
  if (parts.includes('objects')) {
    const bases = await allBases(h, creds);
    if (!bases.length) warnings.push('Der Token sieht keine Base. Beim Erzeugen des Tokens die Bases freigeben (Scopes „schema.bases:read“ und „data.records:read“).');
    await count('objects', 'bases', 'Bases', async () => bases.length);
    const tables: { base: Json; table: Json }[] = [];
    await count('objects', 'tables', 'Tabellen (werden eigene Objekte)', async () => {
      for (const base of bases) for (const table of await tablesOf(h, String(base.id))) tables.push({ base, table });
      return tables.length;
    });
    await count('objects', 'records', 'Datensätze', async () => {
      let n = 0;
      let capped = false;
      let pages = 0;
      for (const { base, table } of tables) {
        for await (const pg of records(h, String(base.id), String(table.id), s, undefined, [String(table.primaryFieldId ?? '')].filter(Boolean))) {
          n += pg.items.length;
          if (++pages >= 60 && pg.next) {
            capped = true;
            break;
          }
        }
        if (capped) break;
      }
      return { n, capped };
    });
    if (tables.length > 50) warnings.push('HyperLevel legt höchstens 50 eigene Objekte an – die übrigen Tabellen werden übersprungen. Mit der Base-ID lässt sich die Auswahl eingrenzen.');
    warnings.push('Airtable erlaubt fünf Anfragen pro Sekunde je Base und sperrt nach einer Überschreitung 30 Sekunden – HyperLevel bremst von selbst und wartet bei Bedarf.');
  }
  return { counts, fields: [] as SourceField[], warnings };
}

export const AIRTABLE: SourceDef = {
  key: 'airtable',
  label: 'Airtable',
  tagline: 'Tabellen als eigene Objekte mit Feldtypen, Datensätzen und Verknüpfungen',
  credentials: [
    { key: 'token', label: 'Persönlicher Zugangs-Token', secret: true, placeholder: 'pat…', hint: 'airtable.com/create/tokens → „Create new token“ → Scopes „data.records:read“ und „schema.bases:read“, die Bases freigeben' },
    { key: 'base_id', label: 'Base-ID (optional)', optional: true, placeholder: 'appXXXXXXXXXXXXXX', hint: 'Nur nötig, wenn du nur eine Base mitnehmen willst – steht in der Adresse deiner Base' },
  ],
  howto: [
    'Bei Airtable unter airtable.com/create/tokens einen neuen persönlichen Token anlegen: Scopes „data.records:read“ und „schema.bases:read“, unter „Access“ die Bases wählen, die mitkommen sollen.',
    'Den Token hier einfügen – HyperLevel liest nur und ändert bei Airtable nichts. Wer nur eine Base mitnehmen will, trägt zusätzlich deren Base-ID ein.',
    'Nach dem Umzug den Token bei Airtable löschen.',
  ],
  limits: [
    'Anhänge: nur die Dateinamen kommen mit (die Adressen laufen bei Airtable nach zwei Stunden ab) – die Dateien selbst vorher herunterladen',
    'Ansichten, Filter, Gruppierungen, Interfaces, Automationen, Formulare und Kommentare',
    'Formeln, Lookups und Rollups: es kommt der aktuelle Wert, nicht die Formel; Schaltflächen und Synchronisationen',
    'Die Reihenfolge der Datensätze und Ansichten; Prozentwerte kommen als Zahl (12,5 für 12,5 %), Dauer als Text',
    'Zusammenarbeit: Personen-Felder kommen als Name (Text), nicht als Teammitglied',
    'Höchstens 50 eigene Objekte je Sub-Account',
  ],
  parts: [{ key: 'objects', label: 'Tabellen → eigene Objekte mit Datensätzen und Verknüpfungen', on: true, note: 'Jede Tabelle wird ein eigenes Objekt; das Primärfeld wird der Name, Auswahlfelder behalten ihre Optionen, verknüpfte Datensätze werden Verknüpfungen.' }],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const me = await h.get('/meta/whoami');
    if (!me?.id) throw new UmzugError(401, 'Airtable: Zugangsdaten ungültig oder abgelaufen');
    const bases = await allBases(h, creds);
    return { account: `at-${me.id}`, label: `${me.email ?? 'Airtable'} (${bases.length} Base${bases.length === 1 ? '' : 's'})`, meta: {} };
  },
  describe: (h, parts, ctx) => describe(h, parts, ctx.creds),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
