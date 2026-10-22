import type { Account, Batch, Consent, CountRow, PartKey, RContact, RCourse, REnrollment, RProduct, RTagRec, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp, networkFetch } from './umzug-http.js';
import { stripHtml, toCents, toIso } from './umzug-text.js';

/**
 * Kajabi (public API v1, JSON:API at https://api.kajabi.com/v1, client-credentials token): contacts with tags
 * and subscription state, products → course shells, offers → products, purchases → course access. The API
 * has no lesson content: the course structure comes from an uploaded outline (see docs/umzug.md).
 */

const BASE = 'https://api.kajabi.com/v1';
const PAGE = 100;
const NO_LESSONS = 'Kajabi liefert Lektionen und Videos nicht über die API – die Kurse sind angelegt, den Aufbau kannst du mit der Kursstruktur-Datei (CSV/JSON) nachladen.';

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) => {
  let token = '';
  let expires = 0;
  return new VendorHttp({
    vendor: 'Kajabi',
    base: BASE,
    headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 150,
    errorText: (b) => b?.errors?.[0]?.detail ?? b?.error_description ?? b?.error,
    prepare: async () => {
      if (token && Date.now() < expires - 30_000) return;
      const f = deps.fetch ?? networkFetch;
      let r;
      try {
        r = await f(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.client_id ?? '', client_secret: creds.client_secret ?? '' }).toString() });
      } catch (e) {
        throw new UmzugError(0, `Kajabi nicht erreichbar: ${(e as Error).message}`);
      }
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new UmzugError(401, 'Kajabi: Client-ID oder Client-Secret ungültig');
      token = String(j.access_token);
      expires = Date.now() + Number(j.expires_in ?? 3600) * 1000;
    },
  });
};

async function* pages(h: VendorHttp, path: string, query: Record<string, unknown>, ctx: StepCtx, start = 1): AsyncGenerator<{ items: any[]; next: number | undefined; total: number; included: any[] }> {
  for (let page = start; ; page++) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { 'page[number]': page, 'page[size]': PAGE, ...query });
    const items: any[] = j.data ?? [];
    const totalPages = Number(j.meta?.total_pages ?? 0);
    const next = items.length && (j.links?.next || page < totalPages) ? page + 1 : undefined;
    yield { items, next, total: Number(j.meta?.total_count ?? 0), included: j.included ?? [] };
    if (next === undefined) return;
  }
}
async function everything(h: VendorHttp, path: string, ctx: StepCtx, query: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of pages(h, path, query, ctx)) out.push(...pg.items);
  return out;
}
const rel = (e: any, name: string): string | undefined => {
  const d = e?.relationships?.[name]?.data;
  return Array.isArray(d) ? (d[0]?.id !== undefined ? String(d[0].id) : undefined) : d?.id !== undefined ? String(d.id) : undefined;
};
const rels = (e: any, name: string): string[] => {
  const d = e?.relationships?.[name]?.data;
  return (Array.isArray(d) ? d : d ? [d] : []).map((x: any) => String(x.id));
};

const stub = (h: VendorHttp, parts: PartKey[]): StepCtx => ({ http: h, creds: {}, meta: {}, cursor: undefined, cancelled: () => false, warn: () => undefined, limit: Infinity, options: { merge: 'fill' }, parts });

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const s = stub(h, parts);
  const total = async (part: PartKey, key: string, label: string, path: string) => {
    try {
      const j = await h.get(path, { 'page[number]': 1, 'page[size]': 1 });
      counts.push({ part, key, label, total: Number(j.meta?.total_count ?? (j.data ?? []).length) });
    } catch (e) {
      counts.push({ part, key, label, total: null, error: (e as Error).message });
      if (e instanceof UmzugError && e.fatal) throw e;
    }
  };
  void s;
  if (parts.includes('contacts')) {
    await total('contacts', 'contacts', 'Kontakte', '/contacts');
    await total('contacts', 'tags', 'Tags', '/tags');
    fields.push(
      { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
      { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
      { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
      { ref: 'phone_number', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
      { ref: 'business_number', label: 'Telefon (geschäftlich)', type: 'phone', group: 'custom' },
      { ref: 'address_line_1', label: 'Straße', type: 'text', std: 'address', group: 'standard' },
      { ref: 'address_city', label: 'Ort', type: 'text', std: 'city', group: 'standard' },
      { ref: 'address_zip', label: 'PLZ', type: 'text', std: 'postal_code', group: 'standard' },
      { ref: 'address_country', label: 'Land', type: 'text', std: 'country', group: 'standard' },
      { ref: 'address_state', label: 'Bundesland', type: 'text', group: 'custom' },
    );
  }
  if (parts.includes('courses')) await total('courses', 'products', 'Produkte (als Kurse)', '/products');
  if (parts.includes('products')) await total('products', 'offers', 'Angebote (Offers)', '/offers');
  if (parts.includes('students')) await total('students', 'purchases', 'Käufe (Zugänge)', '/purchases');
  return { counts, fields, warnings: parts.includes('courses') ? [NO_LESSONS] : [] };
}

const isCourse = (p: any) => !/podcast|community|download|coaching|event|bundle/i.test(String(p.attributes?.product_type_name ?? p.attributes?.product_type ?? ''));

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = await everything(ctx.http, '/tags', ctx);
      yield { records: tags.map((t): RTagRec => ({ kind: 'tag', name: String(t.attributes?.name ?? t.id) })), cursor: undefined };
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tagName = new Map((await everything(ctx.http, '/tags', ctx).catch(() => [])).map((t) => [String(t.id), String(t.attributes?.name ?? t.id)]));
      for await (const pg of pages(ctx.http, '/contacts', { sort: 'created_at' }, ctx, Number(ctx.cursor ?? 1))) {
        const records: RContact[] = pg.items.map((c) => {
          const a = c.attributes ?? {};
          const parts = String(a.name ?? '').trim().split(/\s+/).filter(Boolean);
          const values: Record<string, unknown> = { ...a, first_name: a.first_name ?? parts[0], last_name: a.last_name ?? (parts.length > 1 ? parts.slice(1).join(' ') : undefined) };
          const consent: Consent = a.subscribed === false ? 'unsubscribed' : 'ok';
          return { kind: 'contact', ext: `c:${c.id}`, values, tags: rels(c, 'tags').map((id) => tagName.get(id)).filter((t): t is string => !!t), consent, native_status: a.subscribed === false ? 'unsubscribed' : undefined, created_at: toIso(a.created_at) };
        });
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'courses',
    label: 'Produkte → Kurse',
    part: 'courses',
    async *run(ctx): AsyncGenerator<Batch> {
      const all = await everything(ctx.http, '/products', ctx);
      const skipped = all.filter((p) => !isCourse(p));
      if (skipped.length) ctx.warn(`Kajabi: ${skipped.length} Produkte (${skipped.slice(0, 3).map((p) => p.attributes?.title).join(', ')}) sind keine Kurse und wurden nicht übernommen`);
      ctx.warn(NO_LESSONS);
      const records: RCourse[] = all.filter(isCourse).map((p) => ({ kind: 'course', ext: `p:${p.id}`, title: String(p.attributes?.title ?? `Produkt ${p.id}`), description: stripHtml(p.attributes?.description ?? ''), cover: p.attributes?.thumbnail_url ?? p.attributes?.image_url, modules: [] }));
      yield { records, cursor: undefined };
    },
  },
  {
    id: 'offers',
    label: 'Angebote → Produkte',
    part: 'products',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/offers', {}, ctx, Number(ctx.cursor ?? 1))) {
        const records: RProduct[] = pg.items.map((o) => {
          const a = o.attributes ?? {};
          const recurring = /subscription|recurring/i.test(String(a.payment_type ?? a.offer_type ?? '')) || a.recurring_offer === true;
          const price = a.price_in_cents !== undefined ? Number(a.price_in_cents) : toCents(a.price ?? a.amount);
          return { kind: 'product', ext: `o:${o.id}`, name: String(a.title ?? a.name ?? `Angebot ${o.id}`), description: stripHtml(a.description ?? ''), price_cents: price || 0, currency: a.currency ? String(a.currency).toUpperCase() : undefined, recurring: recurring ? { interval: /year|annual|jähr/i.test(String(a.recurring_interval ?? a.interval ?? '')) ? 'year' : 'month' } : undefined, active: a.archived === true || a.active === false ? false : true };
        });
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'purchases',
    label: 'Käufe → Kurszugänge',
    part: 'students',
    async *run(ctx): AsyncGenerator<Batch> {
      // offer → product, so a purchase of an offer opens the course of its product.
      const productOf = new Map((await everything(ctx.http, '/offers', ctx)).map((o) => [String(o.id), rel(o, 'product') ?? rel(o, 'products')]));
      for await (const pg of pages(ctx.http, '/purchases', {}, ctx, Number(ctx.cursor ?? 1))) {
        const records: REnrollment[] = [];
        for (const p of pg.items) {
          const product = productOf.get(rel(p, 'offer') ?? '') ?? rel(p, 'product');
          const customer = rel(p, 'customer') ?? rel(p, 'contact');
          if (!product || !customer || p.attributes?.deactivated_at) continue;
          records.push({ kind: 'enrollment', ext: `${product}:${customer}`, course: `p:${product}`, contact: `c:${customer}`, enrolled_at: toIso(p.attributes?.created_at) });
        }
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
];

export const KAJABI: SourceDef = {
  key: 'kajabi',
  label: 'Kajabi',
  tagline: 'Kontakte mit Tags, Produkte als Kurse, Angebote, Kurszugänge',
  credentials: [
    { key: 'client_id', label: 'Client-ID', hint: 'Kajabi → Einstellungen → Entwickler (API) → „Create API Key“' },
    { key: 'client_secret', label: 'Client-Secret', secret: true },
  ],
  howto: ['In Kajabi: Einstellungen → „API“ bzw. „Entwickler“ → neuen API-Zugang erstellen (Client-ID und Client-Secret).', 'Beides hier eintragen. Der API-Zugang ist nicht in jedem Kajabi-Tarif enthalten – dann nimm die Export-Dateien (Kontakte, Käufe, Kursstruktur).', 'Kajabi liefert keine Lektionen und Videos über die API: Kurse werden angelegt, der Aufbau kommt aus der Kursstruktur-Datei.'],
  limits: ['Lektionen, Videos und Dateien der Kurse (nicht über die API – dafür die Kursstruktur-Datei)','Community, Podcasts und Coaching-Produkte','Seiten, Funnels und E-Mail-Sequenzen','Laufende Abos bleiben beim Zahlungsanbieter (Stripe/PayPal) – neue Zahlungen musst du in HyperLevel einrichten'],
  parts: [
    { key: 'contacts', label: 'Kontakte und Tags', on: true, note: 'Abgemeldete Kontakte bekommen „Nicht stören“.' },
    { key: 'products', label: 'Angebote → Produkte', on: true },
    { key: 'courses', label: 'Produkte → Kurse (ohne Lektionen)', on: true, note: 'Lektionen und Videos stellt die API nicht bereit – siehe Kursstruktur-Datei.' },
    { key: 'students', label: 'Käufe → Kurszugänge', on: true },
  ],
  exports: [
    { key: 'contacts', label: 'Kontakte-Export (CSV)', accept: ['.csv'], describe: 'Kontakte → Export (Name, E-Mail, Tags, Datum).', part: 'contacts' },
    { key: 'courses', label: 'Kursstruktur (CSV/JSON)', accept: ['.csv', '.json'], describe: 'Eigene Datei mit course, module, lesson, video_url, text – aus Kajabi lässt sich der Aufbau nicht exportieren.', part: 'courses' },
    { key: 'students', label: 'Käufe/Teilnehmer (CSV)', accept: ['.csv'], describe: 'Transaktionen oder Teilnehmerliste mit E-Mail und Produkt.', part: 'students' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/contacts', { 'page[number]': 1, 'page[size]': 1 });
    void j;
    return { account: String(creds.client_id ?? '').slice(0, 24).toLowerCase(), label: `Kajabi (${String(creds.client_id ?? '').slice(0, 6)}…)`, meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
