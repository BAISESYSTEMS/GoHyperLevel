import type { Account, Batch, Consent, CountRow, PartKey, RContact, RForm, RMembership, RTagRec, RTemplate, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { mapSequence } from './umzug-automation.js';
import { toIso } from './umzug-text.js';

/**
 * Kit (formerly ConvertKit), API v4 at https://api.kit.com/v4: subscribers with state (→ DND + tag), tags and
 * the people behind them, custom fields, forms → form drafts, sequences → workflow drafts (the API does not
 * deliver the e-mails of a sequence – the draft says so), broadcasts → e-mail templates (their HTML).
 */

const PAGE = 500;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({ vendor: 'Kit', base: 'https://api.kit.com/v4', headers: () => ({ 'x-kit-api-key': creds.api_key ?? '' }), fetch: deps.fetch, sleep: deps.sleep, pauseMs: deps.pauseMs ?? 250, errorText: (b) => (Array.isArray(b?.errors) ? b.errors.join(', ') : b?.error) });

/** Cursor pagination: per_page + after=<end_cursor>. */
async function* cursorPages(h: VendorHttp, path: string, key: string, query: Record<string, unknown>, ctx: StepCtx, after?: string): AsyncGenerator<{ items: any[]; next: string | undefined }> {
  let cur = after;
  for (;;) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { per_page: PAGE, ...query, ...(cur ? { after: cur } : {}) });
    const items: any[] = j[key] ?? [];
    const next = j.pagination?.has_next_page && j.pagination?.end_cursor ? String(j.pagination.end_cursor) : undefined;
    yield { items, next };
    if (!next) return;
    cur = next;
  }
}

async function everything(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of cursorPages(h, path, key, query, ctx)) out.push(...pg.items);
  return out;
}

const CONSENT: Record<string, Consent> = { active: 'ok', inactive: 'unsubscribed', cancelled: 'unsubscribed', bounced: 'bounced', complained: 'complained' };

/** Custom-field values may be keyed by key, label or name – we accept all three. */
const fieldRefs = (defs: any[]) => defs.map((d) => ({ ref: `cf:${d.key ?? d.name}`, names: [d.key, d.label, d.name].filter(Boolean).map(String) }));

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const stub: StepCtx = { http: h, creds: {}, meta: {}, cursor: undefined, cancelled: () => false, warn: () => undefined, limit: Infinity, options: { merge: 'fill' }, parts };
  const count = async (part: PartKey, key: string, label: string, fn: () => Promise<number>) => {
    try {
      counts.push({ part, key, label, total: await fn() });
    } catch (e) {
      counts.push({ part, key, label, total: null, error: (e as Error).message });
      if (e instanceof UmzugError && e.fatal) throw e;
    }
  };
  // Kit's list calls have no total: counting walks the pages with the biggest page size (fine for the preview).
  const countAll = async (path: string, key: string, query: Record<string, unknown> = {}) => {
    let n = 0;
    for await (const pg of cursorPages(h, path, key, query, stub)) n += pg.items.length;
    return n;
  };
  if (parts.includes('contacts')) {
    await count('contacts', 'subscribers', 'Abonnenten', () => countAll('/subscribers', 'subscribers', { status: 'all' }));
    await count('contacts', 'tags', 'Tags', () => countAll('/tags', 'tags'));
    fields.push({ ref: 'email_address', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' }, { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' });
    try {
      for (const d of await everything(h, '/custom_fields', 'custom_fields', stub)) {
        const std = /^last[_ ]?name$/i.test(String(d.key ?? d.label)) ? 'last_name' : /^(phone|telefon)/i.test(String(d.key ?? d.label)) ? 'phone' : /^(company|firma)$/i.test(String(d.key ?? d.label)) ? 'company' : undefined;
        fields.push({ ref: `cf:${d.key ?? d.name}`, label: String(d.label ?? d.key ?? d.name), type: 'text', std, group: std ? 'standard' : 'custom' });
      }
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Eigene Felder nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('forms')) await count('forms', 'forms', 'Formulare', () => countAll('/forms', 'forms'));
  if (parts.includes('automations')) await count('automations', 'sequences', 'Sequenzen', () => countAll('/sequences', 'sequences'));
  if (parts.includes('templates')) await count('templates', 'broadcasts', 'Broadcasts', () => countAll('/broadcasts', 'broadcasts'));
  return { counts, fields, warnings };
}

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = await everything(ctx.http, '/tags', 'tags', ctx);
      yield { records: tags.map((t): RTagRec => ({ kind: 'tag', name: String(t.name) })), cursor: undefined };
    },
  },
  {
    id: 'contacts',
    label: 'Abonnenten',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const defs = fieldRefs(await everything(ctx.http, '/custom_fields', 'custom_fields', ctx).catch(() => []));
      for await (const pg of cursorPages(ctx.http, '/subscribers', 'subscribers', { status: 'all' }, ctx, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RContact[] = pg.items.map((s) => {
          const values: Record<string, unknown> = { email_address: s.email_address, first_name: s.first_name };
          for (const d of defs) {
            const v = d.names.map((n) => (s.fields ?? {})[n]).find((x) => x !== undefined && x !== null && x !== '');
            if (v !== undefined) values[d.ref] = v;
          }
          const state = String(s.state ?? 'active');
          return { kind: 'contact', ext: `s:${s.id}`, values, consent: CONSENT[state] ?? 'unknown', native_status: state, created_at: toIso(s.created_at) };
        });
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'tag_members',
    label: 'Tags zuordnen',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = await everything(ctx.http, '/tags', 'tags', ctx);
      const cur = (ctx.cursor ?? { ti: 0 }) as { ti: number; after?: string };
      for (let ti = cur.ti; ti < tags.length; ti++) {
        const t = tags[ti];
        for await (const pg of cursorPages(ctx.http, `/tags/${t.id}/subscribers`, 'subscribers', { status: 'all' }, ctx, ti === cur.ti ? cur.after : undefined)) {
          const records: RMembership[] = pg.items.map((s) => ({ kind: 'membership', contact: `s:${s.id}`, tags: [String(t.name)] }));
          yield { records, cursor: pg.next ? { ti, after: pg.next } : ti + 1 < tags.length ? { ti: ti + 1 } : undefined };
        }
      }
    },
  },
  {
    id: 'forms',
    label: 'Formulare (Entwürfe)',
    part: 'forms',
    async *run(ctx): AsyncGenerator<Batch> {
      const forms = await everything(ctx.http, '/forms', 'forms', ctx);
      const records: RForm[] = forms.map((f) => ({ kind: 'form', ext: `f:${f.id}`, name: String(f.name ?? `Formular ${f.id}`), note: `Kit-${f.type === 'hosted' ? 'Landing Page' : 'Formular'}${f.archived ? ' (archiviert)' : ''}: Aufbau und Design liefert die API nicht – nur Name und Standardfelder (Vorname, E-Mail)` }));
      if (forms.length) ctx.warn('Kit-Formulare: übernommen wurden Name und Standardfelder; Design, eingebettete Skripte und Landing-Pages musst du neu bauen.');
      yield { records, cursor: undefined };
    },
  },
  {
    id: 'sequences',
    label: 'Sequenzen (Entwürfe)',
    part: 'automations',
    async *run(ctx): AsyncGenerator<Batch> {
      const seqs = await everything(ctx.http, '/sequences', 'sequences', ctx);
      yield { records: seqs.map((s) => mapSequence('kit', { id: s.id, name: String(s.name ?? `Sequenz ${s.id}`), hold: !!s.hold })), cursor: undefined };
    },
  },
  {
    id: 'broadcasts',
    label: 'Broadcasts → Vorlagen',
    part: 'templates',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of cursorPages(ctx.http, '/broadcasts', 'broadcasts', {}, ctx, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RTemplate[] = pg.items.map((b) => ({ kind: 'template', ext: `b:${b.id}`, name: String(b.subject ?? b.description ?? `Broadcast ${b.id}`), subject: String(b.subject ?? ''), html: String(b.content ?? '') }));
        yield { records, cursor: pg.next };
      }
    },
  },
];

export const KIT: SourceDef = {
  key: 'kit',
  label: 'Kit (ConvertKit)',
  tagline: 'Abonnenten mit Tags und Feldern, Formulare, Sequenzen und Broadcasts',
  credentials: [{ key: 'api_key', label: 'API-Schlüssel (v4)', secret: true, hint: 'Kit → Einstellungen → Developer → „API Keys“ → „Add a new API Key“' }],
  howto: ['In Kit oben rechts auf dein Profil → „Settings“ → „Developer“.', 'Bei „API Keys“ einen neuen Schlüssel anlegen und hier einfügen (v4-Schlüssel, nicht der alte „API Secret“).', 'Nach dem Umzug kannst du den Schlüssel dort wieder löschen.'],
  limits: ['Der Inhalt der Sequenz-E-Mails (die API liefert ihn nicht)','Landing Pages, Formular-Design und Commerce-Produkte','Visual Automations','Bedingungsbasierte Segmente'],
  parts: [
    { key: 'contacts', label: 'Abonnenten, Tags und Felder', on: true, note: 'Abgemeldete, Bounces und Spam-Beschwerden werden zu „Nicht stören“ plus Tag.' },
    { key: 'forms', label: 'Formulare → Formular-Entwürfe', on: true, note: 'Nur Name und Standardfelder – Design und Landing Pages stellt die API nicht bereit.' },
    { key: 'automations', label: 'Sequenzen → Workflow-Entwürfe (bitte prüfen)', on: false, note: 'Die E-Mails einer Sequenz liefert die API nicht: der Entwurf enthält einen Hinweis zum Nachbauen.' },
    { key: 'templates', label: 'Broadcasts → E-Mail-Vorlagen', on: true, note: 'Mit dem HTML des gesendeten Broadcasts.' },
  ],
  exports: [{ key: 'contacts', label: 'Abonnenten-Export (CSV)', accept: ['.csv'], describe: 'Subscribers → Export. Die Spalte „State“ bestimmt, wer „Nicht stören“ bekommt.', part: 'contacts' }],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/account');
    const a = j.account ?? {};
    return { account: String(a.id ?? a.name ?? j.user?.email ?? 'kit').toLowerCase(), label: String(a.name ?? a.primary_email_address ?? j.user?.email ?? 'Kit'), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
