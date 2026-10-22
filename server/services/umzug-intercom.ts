import type { Account, Batch, Consent, ConsentProof, CountRow, FieldType, PartKey, RArticle, RCompany, RContact, RConversation, RKbCategory, RMessage, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, nameParts } from './umzug-lib.js';
import type { Json } from './umzug-flow.js';
import { stripHtml, toIso } from './umzug-text.js';

/**
 * Intercom (REST API, https://api.intercom.io – EU and AU have their own hosts – `Authorization: Bearer <access token>`, versioned by header):
 * contacts (users and leads) with custom attributes, tags and company → contacts, companies, conversations with all their parts →
 * inbox history (stored only: nothing is sent), internal notes → notes, help-center articles → knowledge-base DRAFTS.
 * Pages: `per_page` + `starting_after` (contacts, conversations) or `page` (companies, articles). The API token is created in the
 * developer hub for your workspace; only the three regional hosts are ever called.
 */

const VERSION = '2.11';
const HOSTS: Record<string, string> = { us: 'https://api.intercom.io', eu: 'https://api.eu.intercom.io', au: 'https://api.au.intercom.io' };
const DRY_CONVERSATIONS = 40;

export function intercomBase(region: unknown): string {
  const r = String(region ?? '').trim().toLowerCase() || 'us';
  const base = HOSTS[r];
  if (!base) throw new UmzugError(400, 'Die Region ist „us“, „eu“ oder „au“ – so steht es im Intercom-Konto (Einstellungen → Workspace → Daten-Hosting)');
  return base;
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Intercom',
    base: intercomBase(creds.region),
    headers: () => ({ authorization: `Bearer ${creds.access_token ?? ''}`, 'intercom-version': VERSION }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 120,
    // 429: Intercom sends X-RateLimit-Reset as a Unix time.
    retryHeaders: ['retry-after', 'x-ratelimit-reset'],
    errorText: (b) => (Array.isArray(b?.errors) ? (b.errors[0]?.message ?? b.errors[0]?.code) : undefined),
  });

interface Pg {
  items: any[];
  next: unknown;
  total: number;
}
/** `starting_after` cursor pages. */
async function* cursorPages(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}, after?: string): AsyncGenerator<Pg> {
  let cur = after;
  for (;;) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { per_page: 150, ...query, ...(cur ? { starting_after: cur } : {}) });
    const items: any[] = Array.isArray(j?.[key]) ? j[key] : [];
    const next = j?.pages?.next?.starting_after ? String(j.pages.next.starting_after) : undefined;
    yield { items, next, total: Number(j?.total_count ?? 0) };
    if (!next) return;
    cur = next;
  }
}
/** `page` pages (companies, articles). */
async function* numberPages(h: VendorHttp, path: string, ctx: StepCtx, query: Record<string, unknown> = {}, start = 1, size = 50): AsyncGenerator<Pg> {
  for (let page = start; ; page++) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { per_page: size, page, ...query });
    const items: any[] = Array.isArray(j?.data) ? j.data : [];
    const totalPages = Number(j?.pages?.total_pages ?? 0);
    const next = items.length && page < totalPages ? page + 1 : undefined;
    yield { items, next, total: Number(j?.total_count ?? 0) };
    if (next === undefined) return;
  }
}
const totalOf = async (h: VendorHttp, path: string) => Number((await h.get(path, { per_page: 1 }))?.total_count ?? 0);

const attrType = (t: string): FieldType => (t === 'integer' || t === 'float' ? 'number' : t === 'boolean' ? 'checkbox' : t === 'date' || t === 'datetime' ? 'date' : 'text');

/** Which of Intercom's flags says what about e-mail: unsubscribed, hard bounce and spam complaint withdraw; everything else is "was mailable". */
export function intercomConsent(c: Json): { consent: Consent; native?: string; proof: ConsentProof[] } {
  if (!c.email) return { consent: 'unknown', proof: [] };
  if (c.marked_email_as_spam) return { consent: 'complained', native: 'marked_email_as_spam', proof: [{ basis: 'revoked', reason: 'Spam-Beschwerde', at: toIso(c.updated_at) }] };
  if (c.has_hard_bounced) return { consent: 'bounced', native: 'has_hard_bounced', proof: [{ basis: 'revoked', reason: 'E-Mail unzustellbar (Hard Bounce)', at: toIso(c.updated_at) }] };
  if (c.unsubscribed_from_emails) return { consent: 'unsubscribed', native: 'unsubscribed_from_emails', proof: [{ basis: 'revoked', reason: 'hat sich von E-Mails abgemeldet', at: toIso(c.updated_at) }] };
  return { consent: 'ok', proof: [{ basis: 'legacy', at: toIso(c.signed_up_at ?? c.created_at), method: c.role === 'lead' ? 'Lead in Intercom' : 'Nutzer in Intercom' }] };
}

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'contacts', 'Kontakte (Nutzer und Leads)', () => totalOf(h, '/contacts'));
    await count('contacts', 'tags', 'Tags', async () => (((await h.get('/tags'))?.data ?? []) as unknown[]).length);
    fields.push(
      { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
      { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
      { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
      { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
      { ref: 'city', label: 'Ort', type: 'text', std: 'city', group: 'standard' },
      { ref: 'country', label: 'Land', type: 'text', std: 'country', group: 'standard' },
      { ref: 'org_name', label: 'Unternehmen', type: 'text', std: 'company', group: 'standard' },
      { ref: 'external_id', label: 'Externe ID (Nutzer-ID aus deiner App)', type: 'text', preset: '', group: 'custom' },
      { ref: 'language', label: 'Sprache', type: 'text', preset: '', group: 'custom' },
      { ref: 'signed_up_at', label: 'Angemeldet am', type: 'date', preset: '', group: 'custom' },
      { ref: 'last_seen_at', label: 'Zuletzt gesehen', type: 'date', preset: '', group: 'custom' },
    );
    try {
      for (const a of (await h.get('/data_attributes', { model: 'contact' }))?.data ?? []) if (a.custom && !a.archived) fields.push({ ref: `ca:${a.name}`, label: String(a.label ?? a.name), type: attrType(String(a.data_type)), group: 'custom', options: Array.isArray(a.options) && a.options.length ? a.options.map(String) : undefined });
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Eigene Attribute nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('companies')) await count('companies', 'companies', 'Unternehmen', () => totalOf(h, '/companies'));
  if (parts.includes('conversations')) {
    await count('conversations', 'conversations', 'Gespräche (mit allen Nachrichten)', () => totalOf(h, '/conversations'));
    warnings.push('Zu jedem Gespräch liest HyperLevel die Nachrichten einzeln (eine Anfrage je Gespräch); Intercom erlaubt viele Anfragen pro Minute, bei Tausenden Gesprächen dauert es trotzdem. Der Probelauf liest nur die ersten.');
  }
  if (parts.includes('articles')) await count('articles', 'articles', 'Hilfe-Artikel', () => totalOf(h, '/articles'));
  return { counts, fields, warnings };
}

const text = (html: unknown) => stripHtml(String(html ?? '')).trim();

const steps = (): StepDef[] => [
  {
    id: 'companies',
    label: 'Unternehmen',
    part: 'companies',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of numberPages(ctx.http, '/companies', ctx, {}, Number(ctx.cursor ?? 1), 50)) {
        const records: RCompany[] = pg.items.map((c) => ({ kind: 'company', ext: `co:${c.id}`, name: String(c.name ?? `Unternehmen ${c.company_id ?? c.id}`), website: c.website || undefined, industry: c.industry || undefined }));
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tagNames = new Map<string, string>(((await ctx.http.get('/tags').catch(() => ({})))?.data ?? []).map((t: Json) => [String(t.id), String(t.name)]));
      // A contact carries only its companies' ids: the names are read first (up to 10,000 – the limit of the list call).
      const companyNames = new Map<string, string>();
      for await (const pg of numberPages(ctx.http, '/companies', ctx, {}, 1, 50)) for (const c of pg.items) companyNames.set(String(c.id), String(c.name ?? ''));
      for await (const pg of cursorPages(ctx.http, '/contacts', 'data', ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RContact[] = pg.items.map((c) => {
          const n = nameParts(c.name);
          const loc: Json = c.location ?? {};
          const org = Array.isArray(c.companies?.data) ? c.companies.data[0] : undefined;
          const values: Record<string, unknown> = { email: c.email, first_name: n.first, last_name: n.last, phone: c.phone, city: loc.city, country: loc.country, external_id: c.external_id, language: c.language_override, signed_up_at: toIso(c.signed_up_at)?.slice(0, 10), last_seen_at: toIso(c.last_seen_at)?.slice(0, 10), org_name: org?.id ? companyNames.get(String(org.id)) : undefined };
          for (const [k, v] of Object.entries((c.custom_attributes ?? {}) as Json)) if (v !== null && v !== undefined && v !== '') values[`ca:${k}`] = v;
          const tags = (Array.isArray(c.tags?.data) ? c.tags.data : []).map((t: Json) => tagNames.get(String(t.id))).filter((x: string | undefined): x is string => !!x);
          if (c.role === 'lead') tags.push('Intercom: Lead');
          const x = intercomConsent(c);
          return { kind: 'contact', ext: `c:${c.id}`, values, tags, consent: x.consent, native_status: x.native, created_at: toIso(c.created_at), org: org?.id ? `co:${org.id}` : undefined, org_name: org?.id ? companyNames.get(String(org.id)) : undefined, proof: x.proof.length ? x.proof : undefined };
        });
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'conversations',
    label: 'Gespräche → Postfach-Verlauf',
    part: 'conversations',
    async *run(ctx): AsyncGenerator<Batch> {
      let budget = ctx.limit < Infinity ? DRY_CONVERSATIONS : Infinity;
      for await (const pg of cursorPages(ctx.http, '/conversations', 'conversations', ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RConversation[] = [];
        for (const cv of pg.items) {
          const messages: RMessage[] = [];
          const contactRef: Json = Array.isArray(cv.contacts?.contacts) ? cv.contacts.contacts[0] : undefined;
          const src: Json = cv.source ?? {};
          const email = src.author?.type === 'admin' || src.author?.type === 'bot' ? undefined : src.author?.email;
          const subject = String(src.subject ?? cv.title ?? '').trim();
          const first = text(src.body);
          if (first) messages.push({ ext: 'src', from: src.author?.type === 'admin' || src.author?.type === 'bot' ? 'agent' : 'customer', author: src.author?.name ?? undefined, body: first, at: toIso(cv.created_at) });
          if (budget > 0) {
            budget--;
            const full: Json = await ctx.http.get(`/conversations/${cv.id}`);
            for (const part of Array.isArray(full?.conversation_parts?.conversation_parts) ? full.conversation_parts.conversation_parts : []) {
              const body = text(part.body);
              const kind = String(part.part_type ?? '');
              if (!body || !/^(comment|note|message|email)$/.test(kind)) continue;
              const a: Json = part.author ?? {};
              messages.push({ ext: `p:${part.id}`, from: a.type === 'admin' || a.type === 'bot' ? 'agent' : 'customer', internal: kind === 'note', author: a.name ?? undefined, body, at: toIso(part.created_at) });
            }
          }
          if (!messages.length) continue;
          records.push({ kind: 'conversation', ext: `cv:${cv.id}`, contact: contactRef?.id ? `c:${contactRef.id}` : undefined, contact_hint: email ? { email: String(email), name: src.author?.name } : undefined, subject: subject || undefined, channel: src.type === 'email' || src.delivered_as === 'email' ? 'email' : 'chat', messages });
        }
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'articles',
    label: 'Hilfe-Artikel (Entwürfe)',
    part: 'articles',
    async *run(ctx): AsyncGenerator<Batch> {
      const cur = (ctx.cursor ?? { phase: 'collections' }) as { phase: 'collections' | 'articles'; page?: number };
      let collections: Json[] = [];
      try {
        for await (const pg of numberPages(ctx.http, '/help_center/collections', ctx, {}, 1, 50)) collections.push(...pg.items);
      } catch (e) {
        if (!(e instanceof UmzugError && e.skippable)) throw e;
        collections = [];
      }
      const byId = new Map(collections.map((c) => [String(c.id), c]));
      const nameOf = (c: Json): string => {
        const parent = c.parent_id ? byId.get(String(c.parent_id)) : undefined;
        return parent ? `${nameOf(parent)} › ${c.name}` : String(c.name ?? `Sammlung ${c.id}`);
      };
      if (cur.phase === 'collections') {
        const records: RKbCategory[] = collections.map((c) => ({ kind: 'kb_category', ext: `col:${c.id}`, name: nameOf(c), description: text(c.description) }));
        yield { records, cursor: { phase: 'articles', page: 1 } };
      }
      for await (const pg of numberPages(ctx.http, '/articles', ctx, {}, cur.phase === 'articles' ? Number(cur.page ?? 1) : 1, 50)) {
        const records: RArticle[] = pg.items.map((a) => ({ kind: 'article', ext: `a:${a.id}`, title: String(a.title ?? `Artikel ${a.id}`), html: String(a.body ?? ''), category: a.parent_id && byId.has(String(a.parent_id)) ? `col:${a.parent_id}` : undefined, created_at: toIso(a.created_at) }));
        for (const a of pg.items) if (/(src|href)="https?:\/\/[^"]*intercom(cdn|-attachments|assets)/i.test(String(a.body ?? ''))) ctx.warn(`Artikel „${String(a.title).slice(0, 60)}“: Bilder oder Anhänge liegen noch bei Intercom – vor dem Kündigen herunterladen und neu einfügen`);
        yield { records, cursor: pg.next ? { phase: 'articles', page: pg.next } : undefined, total: pg.total };
      }
    },
  },
];

export const INTERCOM: SourceDef = {
  key: 'intercom',
  label: 'Intercom',
  tagline: 'Kontakte (Nutzer und Leads), Unternehmen, Gespräche als Postfach-Verlauf, Hilfe-Artikel',
  credentials: [
    { key: 'access_token', label: 'Zugriffs-Token', secret: true, hint: 'Intercom → Einstellungen → Integrationen → Developer Hub → Apps → neue App → Authentifizierung → Zugriffs-Token' },
    { key: 'region', label: 'Region (optional)', optional: true, placeholder: 'us, eu oder au', hint: 'Wo dein Workspace liegt: us (Standard), eu oder au – steht unter Einstellungen → Workspace → Daten-Hosting' },
  ],
  howto: [
    'In Intercom: Einstellungen (Zahnrad) → Integrationen → „Developer Hub“ → „Neue App“ (intern). Unter „Authentifizierung“ den Zugriffs-Token kopieren; die App braucht Leserechte für Kontakte, Unternehmen, Gespräche, Tags und Hilfe-Center.',
    'Den Token hier einfügen. Liegt dein Workspace in der EU oder in Australien, trage „eu“ bzw. „au“ als Region ein (sonst „us“).',
    'Nach dem Umzug löschst du die App im Developer Hub. Gelesen wird nur – in Intercom ändert HyperLevel nichts.',
  ],
  limits: [
    'Anhänge und Bilder in Gesprächen und Artikeln (die Dateien bleiben bei Intercom)',
    'Segmente, Kampagnen, Nachrichten-Serien, Produkt-Touren, Bots und Workflows (nachbauen in HyperLevel)',
    'Notizen an Kontakten (nur Notizen aus Gesprächen kommen mit) und Ereignisse/Aktivitäten der App',
    'Helpdesk-Funktionen wie Tickets und SLAs (Gespräche kommen als Verlauf ins Postfach, nicht als Tickets)',
    'Übersetzungen von Artikeln und die Reihenfolge der Sammlungen',
  ],
  parts: [
    { key: 'contacts', label: 'Kontakte, Attribute und Tags', on: true, note: 'Abgemeldete, Hard-Bounces und Spam-Beschwerden werden zu „Nicht stören“ plus Tag; wer in Intercom erreichbar war, kommt als Altbestand in den Einwilligungs-Nachweis (kein eigener Beleg). Leads bekommen das Tag „Intercom: Lead“.' },
    { key: 'companies', label: 'Unternehmen → Firmen', on: true },
    { key: 'conversations', label: 'Gespräche → Verlauf im Postfach', on: true, note: 'Nachrichten werden nur gespeichert – nichts wird versendet oder als ungelesen markiert. Interne Notizen werden Notizen am Kontakt.' },
    { key: 'articles', label: 'Hilfe-Artikel → Wissensdatenbank (als Entwurf)', on: true, note: 'Alle Artikel kommen als Entwurf – prüfe Bilder und Links vor dem Veröffentlichen.' },
  ],
  exports: [{ key: 'contacts', label: 'Kontakte-Export (CSV)', accept: ['.csv'], describe: 'Kontakte → Daten exportieren (CSV). Ohne API kommen weder Gespräche noch Artikel mit.', part: 'contacts' }],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const me = await h.get('/me');
    const app: Json = me?.app ?? {};
    const code = String(app.id_code ?? '').toLowerCase();
    return { account: /^[a-z0-9]{3,20}$/.test(code) ? `app-${code}` : `app-${String(me?.id ?? 'workspace')}`.slice(0, 40), label: String(app.name ?? me?.name ?? 'Intercom-Workspace').slice(0, 120), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
