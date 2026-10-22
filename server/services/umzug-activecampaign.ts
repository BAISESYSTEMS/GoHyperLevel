import type { Account, Batch, Consent, CountRow, FieldType, PartKey, RCompany, RContact, RDeal, RNote, RPipeline, RTagRec, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { mapAutomation } from './umzug-automation.js';
import { stripHtml, toIso } from './umzug-text.js';

/**
 * ActiveCampaign (API v3, https://<account>.api-us1.com/api/3): contacts with lists, tags and custom fields,
 * accounts (companies), deals with pipelines and stages, notes, and automations as workflow drafts. Links the
 * API returns inside responses are never followed (the key would go wherever they point): paths are built here.
 */

const HOST = /^[a-z0-9][a-z0-9-]{0,62}\.(api-us\d+\.com|activehosted\.com)$/i;
const PAGE = 100;

export function acBase(url: string): { base: string; account: string } {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    throw new UmzugError(400, 'Die ActiveCampaign-Adresse ist ungültig – z. B. https://meinekonto.api-us1.com');
  }
  if (u.protocol !== 'https:' || !HOST.test(u.hostname)) throw new UmzugError(400, 'Die Adresse muss wie https://meinekonto.api-us1.com aussehen (Einstellungen → Entwickler)');
  return { base: `https://${u.hostname.toLowerCase()}/api/3`, account: u.hostname.split('.')[0].toLowerCase() };
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({ vendor: 'ActiveCampaign', base: acBase(creds.url ?? '').base, headers: () => ({ 'api-token': creds.api_key ?? '' }), fetch: deps.fetch, sleep: deps.sleep, pauseMs: deps.pauseMs ?? 220, errorText: (b) => b?.message ?? b?.errors?.[0]?.title });

async function* pages(h: VendorHttp, path: string, key: string, query: Record<string, unknown>, ctx: StepCtx, start = 0): AsyncGenerator<{ items: any[]; next: number | undefined; total: number; json: any }> {
  for (let offset = start; ; offset += PAGE) {
    if (ctx.cancelled()) return;
    const json = await h.get(path, { limit: PAGE, offset, ...query });
    const items: any[] = json[key] ?? [];
    const total = Number(json.meta?.total ?? 0);
    const next = items.length === PAGE && offset + PAGE < total ? offset + PAGE : undefined;
    yield { items, next, total, json };
    if (next === undefined) return;
  }
}

async function all(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of pages(h, path, key, query, ctx)) out.push(...pg.items);
  return out;
}

const fieldType = (t: string): FieldType => (t === 'textarea' ? 'textarea' : t === 'date' || t === 'datetime' ? 'date' : t === 'dropdown' || t === 'radio' || t === 'listbox' ? 'select' : t === 'checkbox' ? 'checkbox' : t === 'currency' || t === 'number' ? 'number' : 'text');

const total = async (h: VendorHttp, path: string, query: Record<string, unknown> = {}) => Number((await h.get(path, { limit: 1, ...query })).meta?.total ?? 0);

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const ok = async (part: PartKey, key: string, label: string, path: string, query?: Record<string, unknown>) => {
    try {
      counts.push({ part, key, label, total: await total(h, path, query) });
    } catch (e) {
      counts.push({ part, key, label, total: null, error: (e as Error).message });
      if (e instanceof UmzugError && e.fatal) throw e;
    }
  };
  if (parts.includes('contacts')) {
    await ok('contacts', 'contacts', 'Kontakte', '/contacts', { status: -1 });
    await ok('contacts', 'tags', 'Tags', '/tags');
    await ok('contacts', 'lists', 'Listen', '/lists');
    fields.push({ ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' }, { ref: 'firstName', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' }, { ref: 'lastName', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' }, { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' });
    try {
      const j = await h.get('/fields', { limit: 100 });
      for (const f of j.fields ?? []) fields.push({ ref: `field:${f.id}`, label: String(f.title ?? f.perstag ?? f.id), type: fieldType(String(f.type)), group: 'custom', options: (j.fieldOptions ?? []).filter((o: any) => String(o.field) === String(f.id)).map((o: any) => String(o.label ?? o.value)) });
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Eigene Felder nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('companies')) await ok('companies', 'accounts', 'Firmen (Accounts)', '/accounts');
  if (parts.includes('deals')) {
    await ok('deals', 'pipelines', 'Deal-Pipelines', '/dealGroups');
    await ok('deals', 'deals', 'Deals', '/deals');
  }
  if (parts.includes('notes')) await ok('notes', 'notes', 'Notizen', '/notes');
  if (parts.includes('automations')) await ok('automations', 'automations', 'Automationen', '/automations');
  return { counts, fields, warnings };
}

const consentOf = (subs: { status: string }[]): { consent: Consent; native?: string } => {
  if (!subs.length) return { consent: 'unknown' };
  if (subs.some((s) => String(s.status) === '1')) return { consent: 'ok' };
  if (subs.every((s) => String(s.status) === '3')) return { consent: 'bounced', native: 'bounced' };
  if (subs.some((s) => String(s.status) === '2')) return { consent: 'unsubscribed', native: 'unsubscribed' };
  if (subs.some((s) => String(s.status) === '0')) return { consent: 'pending', native: 'unconfirmed' };
  return { consent: 'unknown' };
};

const idMap = (list: any[], name: string) => new Map(list.map((x) => [String(x.id), String(x[name])]));

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = await all(ctx.http, '/tags', 'tags', ctx);
      const records: RTagRec[] = tags.map((t) => ({ kind: 'tag', name: String(t.tag) }));
      for (const l of await all(ctx.http, '/lists', 'lists', ctx)) records.push({ kind: 'tag', name: `Liste: ${l.name}` });
      yield { records, cursor: undefined };
    },
  },
  {
    id: 'accounts',
    label: 'Firmen',
    part: 'companies',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/accounts', 'accounts', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RCompany[] = pg.items.map((a) => ({ kind: 'company', ext: `a:${a.id}`, name: String(a.name ?? `Firma ${a.id}`), website: a.accountUrl ? String(a.accountUrl) : undefined, domain: a.accountUrl ? String(a.accountUrl) : undefined }));
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tagName = idMap(await all(ctx.http, '/tags', 'tags', ctx), 'tag');
      const listName = idMap(await all(ctx.http, '/lists', 'lists', ctx), 'name');
      // contact → account, when companies were asked for.
      const orgOf = new Map<string, string>();
      if (ctx.parts.includes('companies')) for (const ac of await all(ctx.http, '/accountContacts', 'accountContacts', ctx)) orgOf.set(String(ac.contact), `a:${ac.account}`);
      for await (const pg of pages(ctx.http, '/contacts', 'contacts', { status: -1, include: 'contactLists,contactTags,fieldValues', 'orders[id]': 'ASC' }, ctx, Number(ctx.cursor ?? 0))) {
        const j = pg.json;
        const group = <T extends { contact: unknown }>(arr: T[] | undefined) => {
          const m = new Map<string, T[]>();
          for (const x of arr ?? []) m.set(String(x.contact), [...(m.get(String(x.contact)) ?? []), x]);
          return m;
        };
        const lists = group<any>(j.contactLists);
        const ctags = group<any>(j.contactTags);
        const fvals = group<any>(j.fieldValues);
        const records: RContact[] = [];
        for (const c of pg.items) {
          const id = String(c.id);
          // Without the sideloaded arrays (older accounts) the three lookups are made per contact.
          if (j.contactTags === undefined) ctags.set(id, (await ctx.http.get(`/contacts/${id}/contactTags`)).contactTags ?? []);
          if (j.contactLists === undefined) lists.set(id, (await ctx.http.get(`/contacts/${id}/contactLists`)).contactLists ?? []);
          if (j.fieldValues === undefined) fvals.set(id, (await ctx.http.get(`/contacts/${id}/fieldValues`)).fieldValues ?? []);
          const subs = lists.get(id) ?? [];
          const { consent, native } = consentOf(subs);
          const values: Record<string, unknown> = { email: c.email, firstName: c.firstName, lastName: c.lastName, phone: c.phone };
          for (const f of fvals.get(id) ?? []) if (f.value !== '' && f.value !== null) values[`field:${f.field}`] = f.value;
          const tags = [...(ctags.get(id) ?? []).map((t) => tagName.get(String(t.tag))).filter((t): t is string => !!t), ...subs.filter((s: any) => String(s.status) === '1').map((s: any) => (listName.get(String(s.list)) ? `Liste: ${listName.get(String(s.list))}` : '')).filter(Boolean), ...subs.filter((s: any) => String(s.status) === '2').map((s: any) => (listName.get(String(s.list)) ? `Abgemeldet von: ${listName.get(String(s.list))}` : '')).filter(Boolean)];
          records.push({ kind: 'contact', ext: `c:${id}`, values, tags, consent, native_status: native, created_at: toIso(c.cdate), org: orgOf.get(id) });
        }
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'deals',
    label: 'Pipelines und Deals',
    part: 'deals',
    async *run(ctx): AsyncGenerator<Batch> {
      const cur = (ctx.cursor ?? { phase: 'pipes' }) as { phase: 'pipes' | 'deals'; off?: number };
      if (cur.phase === 'pipes') {
        const groups = await all(ctx.http, '/dealGroups', 'dealGroups', ctx);
        const stages = await all(ctx.http, '/dealStages', 'dealStages', ctx);
        const records: RPipeline[] = groups.map((g) => ({
          kind: 'pipeline',
          ext: `g:${g.id}`,
          name: String(g.title ?? `Pipeline ${g.id}`),
          stages: stages
            .filter((s) => String(s.group) === String(g.id))
            .sort((a, b) => Number(a.order) - Number(b.order))
            .map((s) => ({ ext: `s:${s.id}`, name: String(s.title ?? s.id) })),
        }));
        yield { records, cursor: { phase: 'deals', off: 0 } };
      }
      for await (const pg of pages(ctx.http, '/deals', 'deals', {}, ctx, cur.phase === 'deals' ? Number(cur.off ?? 0) : 0)) {
        const records: RDeal[] = pg.items.map((d) => ({
          kind: 'deal',
          ext: `d:${d.id}`,
          name: String(d.title ?? 'Deal'),
          value: Math.round(Number(d.value ?? 0) / 100),
          currency: d.currency ? String(d.currency).toUpperCase() : undefined,
          pipeline: `g:${d.group}`,
          stage: `s:${d.stage}`,
          contact: d.contact ? `c:${d.contact}` : undefined,
          org: d.organization ? `a:${d.organization}` : undefined,
          status: String(d.status) === '1' ? 'won' : String(d.status) === '2' ? 'lost' : 'open',
          created_at: toIso(d.cdate),
        }));
        yield { records, cursor: pg.next !== undefined ? { phase: 'deals', off: pg.next } : undefined, total: pg.total };
      }
    },
  },
  {
    id: 'notes',
    label: 'Notizen',
    part: 'notes',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/notes', 'notes', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records: RNote[] = pg.items.map((n) => ({
          kind: 'note',
          ext: `n:${n.id}`,
          contact: /subscriber|contact/i.test(String(n.reltype)) ? `c:${n.relid}` : undefined,
          deal: /deal/i.test(String(n.reltype)) ? `d:${n.relid}` : undefined,
          body: stripHtml(n.note ?? ''),
          at: toIso(n.cdate),
        }));
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'automations',
    label: 'Automationen (Entwürfe)',
    part: 'automations',
    async *run(ctx): AsyncGenerator<Batch> {
      const tagName = idMap(await all(ctx.http, '/tags', 'tags', ctx), 'tag');
      const listName = idMap(await all(ctx.http, '/lists', 'lists', ctx), 'name');
      for await (const pg of pages(ctx.http, '/automations', 'automations', {}, ctx, Number(ctx.cursor ?? 0))) {
        const records = [];
        for (const a of pg.items) {
          let blocks: any[] = [];
          try {
            const j = await ctx.http.get(`/automations/${a.id}/blocks`);
            blocks = j.automationBlocks ?? j.blocks ?? [];
          } catch (e) {
            if (!(e instanceof UmzugError && e.skippable)) throw e;
          }
          records.push(mapAutomation('activecampaign', { id: a.id, name: String(a.name ?? `Automation ${a.id}`), blocks, active: String(a.status) === '1' }, { tag: (id) => tagName.get(String(id)), list: (id) => listName.get(String(id)) }));
        }
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
];

export const ACTIVECAMPAIGN: SourceDef = {
  key: 'activecampaign',
  label: 'ActiveCampaign',
  tagline: 'Kontakte mit Listen, Tags und Feldern, Firmen, Deals, Notizen, Automationen als Entwurf',
  credentials: [
    { key: 'url', label: 'API-URL', placeholder: 'https://meinekonto.api-us1.com', hint: 'ActiveCampaign → Einstellungen → Entwickler → „API-Zugriff“' },
    { key: 'api_key', label: 'API-Schlüssel', secret: true, hint: 'Steht am selben Ort unter „Schlüssel“' },
  ],
  howto: ['In ActiveCampaign unten links auf „Einstellungen“ (Zahnrad) → „Entwickler“.', 'Unter „API-Zugriff“ stehen die URL (…api-us1.com) und der Schlüssel – beides hier eintragen.', 'Der Schlüssel gilt für das ganze Konto; nach dem Umzug kannst du ihn dort neu erzeugen, dann ist der alte ungültig.'],
  limits: ['Kampagnen-Inhalte und -Statistiken, Formulare, Landing Pages und Site-Tracking','Automationen nur als Entwurf: Verzweigungen, Ziele und Bedingungen musst du neu bauen','Eigene Deal-Felder und Deal-Aufgaben','Lead-Scoring-Regeln und bedingungsbasierte Segmente'],
  parts: [
    { key: 'contacts', label: 'Kontakte, Listen, Tags und Felder', on: true, note: 'Listen werden zu Tags „Liste: …“, Abgemeldete zu „Nicht stören“.' },
    { key: 'companies', label: 'Firmen (Accounts)', on: true },
    { key: 'deals', label: 'Deals mit Pipelines und Stufen', on: true },
    { key: 'notes', label: 'Notizen', on: true },
    { key: 'automations', label: 'Automationen → Workflow-Entwürfe (bitte prüfen)', on: false, note: 'Übliche Auslöser und Aktionen werden übersetzt, der Rest wird zur Notiz mit dem Original. Verzweigungen musst du neu bauen.' },
  ],
  exports: [
    { key: 'contacts', label: 'Kontakte-Export (CSV)', accept: ['.csv'], describe: 'Kontakte → Export. Tags und Listen als Spalten werden zu Tags.', part: 'contacts' },
    { key: 'deals', label: 'Deals-Export (CSV)', accept: ['.csv'], describe: 'Deals → Export (Titel, Wert, Phase, Pipeline, Kontakt-E-Mail).', part: 'deals' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const { account } = acBase(creds.url ?? '');
    const h = http(creds, {}, deps);
    const j = await h.get('/users/me');
    return { account, label: String(j.user?.email ?? j.user?.username ?? account), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
