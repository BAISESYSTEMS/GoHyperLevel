import type { Account, Batch, Consent, CountRow, FieldType, PartKey, RCompany, RContact, RDeal, RNote, RPipeline, RTask, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { first, stripHtml, toIso } from './umzug-text.js';

/**
 * Pipedrive (API v1): persons with custom fields → contacts, organizations → companies, pipelines and stages,
 * deals, activities → tasks (type becomes part of the title), notes. Token in a header, never in the URL.
 */

const PAGE = 500;

export function pipedriveBase(company?: string): string {
  const c = String(company ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.pipedrive\.com.*$/, '');
  if (!c) return 'https://api.pipedrive.com/v1';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(c)) throw new UmzugError(400, 'Die Pipedrive-Domain sieht ungültig aus – nur der Teil vor „.pipedrive.com“, z. B. meinefirma');
  return `https://${c}.pipedrive.com/api/v1`;
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({ vendor: 'Pipedrive', base: pipedriveBase(creds.company), headers: () => ({ 'x-api-token': creds.api_token ?? '' }), fetch: deps.fetch, sleep: deps.sleep, pauseMs: deps.pauseMs ?? 120, errorText: (b) => b?.error });

async function* pages(h: VendorHttp, path: string, query: Record<string, unknown>, ctx: StepCtx, start = 0): AsyncGenerator<{ items: any[]; next: number | undefined }> {
  for (let at = start; ; ) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { start: at, limit: PAGE, ...query });
    const items: any[] = Array.isArray(j.data) ? j.data : [];
    const pg = j.additional_data?.pagination;
    const next = pg?.more_items_in_collection ? Number(pg.next_start ?? at + PAGE) : undefined;
    yield { items, next };
    if (next === undefined) return;
    at = next;
  }
}
async function everything(h: VendorHttp, path: string, ctx: StepCtx, query: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of pages(h, path, query, ctx)) out.push(...pg.items);
  return out;
}
const stub = (h: VendorHttp, parts: PartKey[]): StepCtx => ({ http: h, creds: {}, meta: {}, cursor: undefined, cancelled: () => false, warn: () => undefined, limit: Infinity, options: { merge: 'fill' }, parts });

const pdType = (t: string): FieldType => (/^(int|double|monetary|float)/.test(t) ? 'number' : /^(date|daterange)/.test(t) ? 'date' : /^(enum|set)/.test(t) ? 'select' : /^phone/.test(t) ? 'phone' : /^text/.test(t) ? 'textarea' : 'text');

const MARKETING: Record<string, Consent> = { unsubscribed: 'unsubscribed', archived: 'blocked', subscribed: 'ok', 'no_consent': 'unknown' };

const countOf = async (h: VendorHttp, ctx: StepCtx, path: string, query: Record<string, unknown> = {}) => {
  let n = 0;
  for await (const pg of pages(h, path, query, ctx)) n += pg.items.length;
  return n;
};

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const s = stub(h, parts);
  const add = async (part: PartKey, key: string, label: string, path: string, query?: Record<string, unknown>) => {
    try {
      counts.push({ part, key, label, total: await countOf(h, s, path, query) });
    } catch (e) {
      counts.push({ part, key, label, total: null, error: (e as Error).message });
      if (e instanceof UmzugError && e.fatal) throw e;
    }
  };
  if (parts.includes('contacts')) {
    await add('contacts', 'persons', 'Personen', '/persons');
    fields.push({ ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' }, { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' }, { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' }, { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' }, { ref: 'org', label: 'Organisation', type: 'text', std: 'company', group: 'standard' }, { ref: 'label', label: 'Label', type: 'text', preset: 'tag', group: 'custom' });
    try {
      for (const f of await everything(h, '/personFields', s)) {
        // Standard fields are covered above; only the account's own fields (edit_flag) become custom fields.
        if (!f.edit_flag) continue;
        fields.push({ ref: `f:${f.key}`, label: String(f.name ?? f.key), type: pdType(String(f.field_type)), group: 'custom', options: (f.options ?? []).map((o: any) => String(o.label)) });
      }
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Eigene Felder nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('companies')) await add('companies', 'organizations', 'Organisationen', '/organizations');
  if (parts.includes('deals')) {
    await add('deals', 'pipelines', 'Pipelines', '/pipelines');
    await add('deals', 'deals', 'Deals', '/deals', { status: 'all_not_deleted' });
  }
  if (parts.includes('tasks')) await add('tasks', 'activities', 'Aktivitäten', '/activities');
  if (parts.includes('notes')) await add('notes', 'notes', 'Notizen', '/notes');
  return { counts, fields, warnings };
}

const primary = (list: any): string | undefined => (Array.isArray(list) ? (first<string>(...[list.find((x) => x.primary)?.value, ...list.map((x) => x.value)]) ?? undefined) : typeof list === 'string' ? list : undefined);
const refId = (v: any): string | undefined => (v === null || v === undefined ? undefined : typeof v === 'object' ? (v.value !== undefined ? String(v.value) : v.id !== undefined ? String(v.id) : undefined) : String(v));

const steps = (): StepDef[] => [
  {
    id: 'organizations',
    label: 'Organisationen',
    part: 'companies',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/organizations', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RCompany[] = pg.items.map((o) => ({ kind: 'company', ext: `o:${o.id}`, name: String(o.name ?? `Organisation ${o.id}`), address: o.address_route ?? o.address, city: o.address_locality, postal_code: o.address_postal_code, country: o.address_country }));
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'contacts',
    label: 'Personen',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      // Option ids of enum/set fields → their labels.
      const defs = await everything(ctx.http, '/personFields', ctx).catch(() => []);
      const labels = new Map<string, Map<string, string>>(defs.filter((d) => d.edit_flag && d.options?.length).map((d) => [String(d.key), new Map((d.options as any[]).map((o) => [String(o.id), String(o.label)]))]));
      const customKeys = defs.filter((d) => d.edit_flag).map((d) => String(d.key));
      const labelOf = new Map<string, string>(((defs.find((d) => d.key === 'label')?.options ?? []) as any[]).map((o) => [String(o.id), String(o.label)]));
      for await (const pg of pages(ctx.http, '/persons', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RContact[] = pg.items.map((p) => {
          const values: Record<string, unknown> = { email: primary(p.email), phone: primary(p.phone), first_name: p.first_name, last_name: p.last_name, org: p.org_id?.name ?? p.org_name, label: [...(Array.isArray(p.label_ids) && p.label_ids.length ? p.label_ids : [p.label])].map((id) => labelOf.get(String(id))).filter(Boolean) };
          if (!values.first_name && !values.last_name && p.name) {
            const n = String(p.name).trim().split(/\s+/);
            values.first_name = n[0];
            values.last_name = n.slice(1).join(' ') || undefined;
          }
          for (const k of customKeys) {
            let v = p[k];
            if (v === null || v === undefined || v === '') continue;
            const map = labels.get(k);
            if (map) v = String(v).split(',').map((x) => map.get(x.trim()) ?? x.trim()).join(', ');
            else if (typeof v === 'object') v = (v as any).formatted_address ?? (v as any).value ?? JSON.stringify(v);
            values[`f:${k}`] = v;
          }
          const ms = String(p.marketing_status ?? '');
          return { kind: 'contact', ext: `p:${p.id}`, values, consent: MARKETING[ms] ?? 'unknown', native_status: ms || undefined, created_at: toIso(p.add_time), org: refId(p.org_id) ? `o:${refId(p.org_id)}` : undefined, org_name: p.org_id?.name };
        });
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'deals',
    label: 'Pipelines und Deals',
    part: 'deals',
    async *run(ctx): AsyncGenerator<Batch> {
      const cur = (ctx.cursor ?? { phase: 'pipes' }) as { phase: 'pipes' | 'deals'; at?: number };
      if (cur.phase === 'pipes') {
        const pipes = await everything(ctx.http, '/pipelines', ctx);
        const stages = await everything(ctx.http, '/stages', ctx);
        const records: RPipeline[] = pipes.map((p) => ({ kind: 'pipeline', ext: `pl:${p.id}`, name: String(p.name ?? `Pipeline ${p.id}`), stages: stages.filter((s) => String(s.pipeline_id) === String(p.id)).sort((a, b) => Number(a.order_nr) - Number(b.order_nr)).map((s) => ({ ext: `st:${s.id}`, name: String(s.name ?? s.id), probability: s.deal_probability !== undefined ? Number(s.deal_probability) : undefined })) }));
        yield { records, cursor: { phase: 'deals', at: 0 } };
      }
      for await (const pg of pages(ctx.http, '/deals', { status: 'all_not_deleted' }, ctx, cur.phase === 'deals' ? Number(cur.at ?? 0) : 0)) {
        const records: RDeal[] = pg.items.map((d) => ({
          kind: 'deal',
          ext: `d:${d.id}`,
          name: String(d.title ?? 'Deal'),
          value: Math.round(Number(d.value ?? 0)),
          currency: d.currency ? String(d.currency) : undefined,
          pipeline: `pl:${d.pipeline_id}`,
          stage: `st:${d.stage_id}`,
          contact: refId(d.person_id) ? `p:${refId(d.person_id)}` : undefined,
          contact_hint: d.person_id && typeof d.person_id === 'object' ? { name: d.person_id.name, email: primary(d.person_id.email) } : undefined,
          org: refId(d.org_id) ? `o:${refId(d.org_id)}` : undefined,
          status: d.status === 'won' ? 'won' : d.status === 'lost' ? 'lost' : 'open',
          created_at: toIso(d.add_time),
        }));
        yield { records, cursor: pg.next !== undefined ? { phase: 'deals', at: pg.next } : undefined };
      }
    },
  },
  {
    id: 'activities',
    label: 'Aktivitäten → Aufgaben',
    part: 'tasks',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/activities', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RTask[] = pg.items.map((a) => ({
          kind: 'task',
          ext: `a:${a.id}`,
          contact: refId(a.person_id) ? `p:${refId(a.person_id)}` : undefined,
          deal: refId(a.deal_id) ? `d:${refId(a.deal_id)}` : undefined,
          title: String(a.subject ?? a.type ?? 'Aufgabe'),
          description: stripHtml(a.note ?? ''),
          due_at: a.due_date ? toIso(`${a.due_date} ${a.due_time || '00:00'}`) : undefined,
          done: a.done === true || a.done === 1 || a.done === '1',
          completed_at: toIso(a.marked_as_done_time),
          type: a.type,
        }));
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'notes',
    label: 'Notizen',
    part: 'notes',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/notes', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RNote[] = pg.items.map((n) => ({ kind: 'note', ext: `n:${n.id}`, contact: refId(n.person_id) ? `p:${refId(n.person_id)}` : undefined, deal: refId(n.deal_id) ? `d:${refId(n.deal_id)}` : undefined, body: stripHtml(n.content ?? ''), at: toIso(n.add_time) }));
        yield { records, cursor: pg.next };
      }
    },
  },
];

export const PIPEDRIVE: SourceDef = {
  key: 'pipedrive',
  label: 'Pipedrive',
  tagline: 'Personen mit eigenen Feldern, Organisationen, Pipelines, Deals, Aktivitäten, Notizen',
  credentials: [
    { key: 'api_token', label: 'API-Token', secret: true, hint: 'Pipedrive → Persönliche Einstellungen → „API“' },
    { key: 'company', label: 'Firmen-Domain (optional)', optional: true, placeholder: 'meinefirma', hint: 'Der Teil vor .pipedrive.com – nötig, wenn dein Konto eine eigene Domain hat.' },
  ],
  howto: ['In Pipedrive oben rechts auf dein Profil → „Persönliche Einstellungen“ → Reiter „API“.', 'Den persönlichen API-Token kopieren und hier einfügen. Er sieht alles, was du siehst – nutze am besten das Konto eines Admins.', 'Nach dem Umzug kannst du den Token dort neu erzeugen; der alte ist dann ungültig.'],
  limits: ['E-Mails (Mail-Sync) und Anhänge','Automationen, Leads-Inbox und Projekte','Eigene Deal-Felder und Produkte'],
  parts: [
    { key: 'contacts', label: 'Personen und eigene Felder', on: true, note: 'Pipedrive-Labels werden zu Tags; „unsubscribed“ im Marketing-Status wird zu „Nicht stören“.' },
    { key: 'companies', label: 'Organisationen → Firmen', on: true },
    { key: 'deals', label: 'Pipelines und Deals', on: true },
    { key: 'tasks', label: 'Aktivitäten → Aufgaben', on: true, note: 'Die Art (Anruf, Meeting …) steht vor dem Titel.' },
    { key: 'notes', label: 'Notizen', on: true },
  ],
  exports: [
    { key: 'contacts', label: 'Personen-Export (CSV)', accept: ['.csv'], describe: 'Kontakte → Personen → Exportieren (CSV).', part: 'contacts' },
    { key: 'deals', label: 'Deals-Export (CSV)', accept: ['.csv'], describe: 'Deals → Exportieren (Titel, Wert, Phase, Pipeline, Person).', part: 'deals' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/users/me');
    const d = j.data ?? {};
    return { account: String(d.company_domain ?? d.company_id ?? 'pipedrive').toLowerCase(), label: String(d.company_name ?? d.name ?? 'Pipedrive'), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
