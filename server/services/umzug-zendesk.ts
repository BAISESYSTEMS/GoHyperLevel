import type { Account, Batch, CountRow, FieldType, PartKey, RArticle, RCompany, RContact, RKbCategory, RTicket, RTicketComment, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, nameParts, stubCtx } from './umzug-lib.js';
import type { Json } from './umzug-flow.js';
import { stripHtml, toIso } from './umzug-text.js';

/**
 * Zendesk Support and Guide (REST API v2, https://<subdomain>.zendesk.com/api/v2, Basic auth `<e-mail>/token:<API token>`): end users →
 * contacts, organizations → companies, tickets with every comment → helpdesk tickets (imported without SLA timers, mails or workflow
 * events), help-center articles → knowledge-base DRAFTS. Cursor pagination (`page[size]` + `page[after]`, `meta.has_more`).
 * Zendesk knows no marketing consent: imported people are marked "no advertising consent" in the ledger.
 */

const PAGE = 100;
/** A dry run reads the comments of this many tickets only (each one is a call). */
const DRY_COMMENTS = 40;

export function zendeskBase(sub: unknown): string {
  const s = String(sub ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.zendesk\.com.*$/, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(s)) throw new UmzugError(400, 'Die Zendesk-Subdomain sieht ungültig aus – nur der Teil vor „.zendesk.com“, z. B. meinefirma');
  return `https://${s}.zendesk.com/api/v2`;
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Zendesk',
    base: zendeskBase(creds.subdomain),
    headers: () => ({ authorization: `Basic ${Buffer.from(`${creds.email ?? ''}/token:${creds.api_token ?? ''}`).toString('base64')}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 300,
    errorText: (b) => (typeof b?.error === 'string' ? b.error : typeof b?.error?.message === 'string' ? b.error.message : typeof b?.description === 'string' ? b.description : undefined),
  });

interface Pg {
  json: any;
  items: any[];
  next: string | undefined;
}
async function* pages(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}, after?: string): AsyncGenerator<Pg> {
  let cur = after;
  for (;;) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { 'page[size]': PAGE, ...query, ...(cur ? { 'page[after]': cur } : {}) });
    const items: any[] = Array.isArray(j?.[key]) ? j[key] : [];
    const next = j?.meta?.has_more && j?.meta?.after_cursor ? String(j.meta.after_cursor) : undefined;
    yield { json: j, items, next };
    if (!next) return;
    cur = next;
  }
}
async function everything(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of pages(h, path, key, ctx, query)) out.push(...pg.items);
  return out;
}

const ufType = (t: string): FieldType => (t === 'integer' || t === 'decimal' ? 'number' : t === 'date' ? 'date' : t === 'checkbox' ? 'checkbox' : t === 'dropdown' || t === 'tagger' ? 'select' : t === 'textarea' ? 'textarea' : 'text');

const countOf = async (h: VendorHttp, path: string) => Number((await h.get(path))?.count?.value ?? 0);

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const warnings: string[] = [];
  const s = stubCtx(h, parts);
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'users', 'Nutzer (alle Rollen; importiert werden die Kunden)', () => countOf(h, '/users/count.json'));
    fields.push(
      { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
      { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
      { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
      { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
      { ref: 'org_name', label: 'Organisation', type: 'text', std: 'company', group: 'standard' },
      { ref: 'tags', label: 'Tags', type: 'text', preset: 'tag', group: 'custom' },
      { ref: 'notes', label: 'Notizen', type: 'textarea', preset: 'note', group: 'custom' },
      { ref: 'details', label: 'Details', type: 'textarea', preset: 'note', group: 'custom' },
      { ref: 'time_zone', label: 'Zeitzone', type: 'text', preset: '', group: 'custom' },
      { ref: 'locale', label: 'Sprache', type: 'text', preset: '', group: 'custom' },
    );
    try {
      for (const f of await everything(h, '/user_fields.json', 'user_fields', s)) if (f.active !== false && f.key) fields.push({ ref: `uf:${f.key}`, label: String(f.title ?? f.key), type: ufType(String(f.type)), group: 'custom', options: Array.isArray(f.custom_field_options) ? f.custom_field_options.map((o: Json) => String(o.name)) : undefined });
    } catch (e) {
      if (!(e instanceof UmzugError && e.skippable)) throw e;
      warnings.push(`Eigene Nutzerfelder nicht lesbar: ${e.message}`);
    }
  }
  if (parts.includes('companies')) await count('companies', 'organizations', 'Organisationen', () => countOf(h, '/organizations/count.json'));
  if (parts.includes('tickets')) {
    await count('tickets', 'tickets', 'Tickets (mit allen Kommentaren)', () => countOf(h, '/tickets/count.json'));
    warnings.push('Zu jedem Ticket liest HyperLevel die Kommentare einzeln – das braucht bei vielen Tickets Zeit (Zendesk erlaubt je nach Tarif 200 bis 700 Anfragen pro Minute). Der Probelauf liest nur die ersten Tickets.');
  }
  if (parts.includes('articles')) await count('articles', 'articles', 'Hilfe-Artikel', async () => Number((await h.get('/help_center/articles.json', { per_page: 1 }))?.count ?? 0));
  return { counts, fields, warnings };
}

const NOPE = { basis: 'none' as const, method: 'Support-Kontakt (Zendesk kennt keine Werbeeinwilligung)', channel: 'email' as const };

export function zendeskContact(u: Json, orgNames: Map<string, string>): RContact {
  const n = nameParts(u.name);
  const values: Record<string, unknown> = { email: u.email, first_name: n.first, last_name: n.last, phone: u.phone ?? u.shared_phone_number, org_name: u.organization_id ? orgNames.get(String(u.organization_id)) : undefined, notes: u.notes, details: u.details, time_zone: u.time_zone, locale: u.locale, tags: Array.isArray(u.tags) ? u.tags : [] };
  for (const [k, v] of Object.entries((u.user_fields ?? {}) as Json)) if (v !== null && v !== undefined && v !== '') values[`uf:${k}`] = v;
  return { kind: 'contact', ext: `u:${u.id}`, values, consent: 'unknown', created_at: toIso(u.created_at), org: u.organization_id ? `o:${u.organization_id}` : undefined, org_name: u.organization_id ? orgNames.get(String(u.organization_id)) : undefined, proof: u.email ? [NOPE] : undefined };
}

const STATUS_TEXT: Record<string, string> = { new: 'neu', open: 'offen', pending: 'wartet auf Kunde', hold: 'zurückgestellt', solved: 'gelöst', closed: 'geschlossen' };

const steps = (): StepDef[] => [
  {
    id: 'organizations',
    label: 'Organisationen',
    part: 'companies',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/organizations.json', 'organizations', ctx, {}, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const records: RCompany[] = pg.items.map((o) => ({ kind: 'company', ext: `o:${o.id}`, name: String(o.name ?? `Organisation ${o.id}`), domain: Array.isArray(o.domain_names) ? o.domain_names[0] : undefined, website: Array.isArray(o.domain_names) && o.domain_names[0] ? `https://${o.domain_names[0]}` : undefined }));
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'contacts',
    label: 'Kunden',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const orgNames = new Map<string, string>();
      for (const o of await everything(ctx.http, '/organizations.json', 'organizations', ctx).catch(() => [])) orgNames.set(String(o.id), String(o.name ?? ''));
      for await (const pg of pages(ctx.http, '/users.json', 'users', ctx, { role: 'end-user' }, ctx.cursor ? String(ctx.cursor) : undefined)) {
        yield { records: pg.items.filter((u) => u.role === 'end-user' || !u.role).map((u) => zendeskContact(u, orgNames)), cursor: pg.next };
      }
    },
  },
  {
    id: 'tickets',
    label: 'Tickets mit Kommentaren',
    part: 'tickets',
    async *run(ctx): AsyncGenerator<Batch> {
      let budget = ctx.limit < Infinity ? DRY_COMMENTS : Infinity;
      for await (const pg of pages(ctx.http, '/tickets.json', 'tickets', ctx, { include: 'users', sort: 'id' }, ctx.cursor ? String(ctx.cursor) : undefined)) {
        const people = new Map<string, Json>((Array.isArray(pg.json?.users) ? pg.json.users : []).map((u: Json) => [String(u.id), u]));
        const records: RTicket[] = [];
        for (const t of pg.items) {
          const requester = people.get(String(t.requester_id));
          const assignee = t.assignee_id ? people.get(String(t.assignee_id)) : undefined;
          const comments: RTicketComment[] = [];
          const description = String(t.description ?? '');
          if (budget > 0) {
            budget--;
            const seen = new Set<string>();
            for await (const cp of pages(ctx.http, `/tickets/${t.id}/comments.json`, 'comments', ctx, { include: 'users' })) {
              const authors = new Map<string, Json>((Array.isArray(cp.json?.users) ? cp.json.users : []).map((u: Json) => [String(u.id), u]));
              for (const c of cp.items) {
                if (seen.has(String(c.id))) continue;
                seen.add(String(c.id));
                const author = authors.get(String(c.author_id)) ?? people.get(String(c.author_id));
                const body = String(c.plain_body ?? (c.html_body ? stripHtml(c.html_body) : (c.body ?? ''))).trim();
                // The first comment is the description the ticket already carries.
                if (!comments.length && body && body === description.trim()) continue;
                const files = (Array.isArray(c.attachments) ? c.attachments : []).map((a: Json) => String(a.file_name ?? 'Datei'));
                comments.push({ ext: `c:${c.id}`, from: author && author.role !== 'end-user' ? 'agent' : 'customer', internal: c.public === false, author: author?.name ? String(author.name) : undefined, body: files.length ? `${body}\n\nAnhänge (liegen bei Zendesk): ${files.join(', ')}` : body, at: toIso(c.created_at) });
              }
            }
          }
          const meta = [`Aus Zendesk übernommen (Ticket #${t.id})`, assignee?.name ? `Bearbeiter dort: ${assignee.name}` : '', t.type ? `Art: ${t.type}` : '', t.via?.channel ? `Kanal: ${t.via.channel}` : '', STATUS_TEXT[String(t.status)] ? `Status dort: ${STATUS_TEXT[String(t.status)]}` : ''].filter(Boolean).join(' · ');
          comments.unshift({ ext: 'meta', from: 'agent', internal: true, body: meta, at: toIso(t.created_at) });
          records.push({
            kind: 'ticket',
            ext: `t:${t.id}`,
            subject: String(t.subject || description.split('\n')[0] || `Ticket ${t.id}`).slice(0, 300),
            description,
            // "hold" alone says nothing to the stage mapping; "on hold" means waiting.
            status: t.status === 'hold' ? 'on hold' : String(t.status ?? ''),
            priority: t.priority ?? undefined,
            contact: t.requester_id ? `u:${t.requester_id}` : undefined,
            // A requester who is an agent (an internal ticket) does not become a contact.
            contact_hint: requester?.email && requester.role === 'end-user' ? { name: requester.name, email: requester.email } : undefined,
            tags: Array.isArray(t.tags) ? t.tags : [],
            channel: t.via?.channel === 'email' ? 'email' : t.via?.channel === 'sms' ? 'sms' : t.via?.channel === 'chat' ? 'chat' : undefined,
            created_at: toIso(t.created_at),
            comments,
          });
        }
        yield { records, cursor: pg.next };
      }
    },
  },
  {
    id: 'articles',
    label: 'Hilfe-Artikel (Entwürfe)',
    part: 'articles',
    async *run(ctx): AsyncGenerator<Batch> {
      const cats = new Map<string, Json>((await everything(ctx.http, '/help_center/categories.json', 'categories', ctx)).map((c) => [String(c.id), c]));
      const sections = await everything(ctx.http, '/help_center/sections.json', 'sections', ctx);
      const perCat = new Map<string, number>();
      for (const s of sections) perCat.set(String(s.category_id), (perCat.get(String(s.category_id)) ?? 0) + 1);
      const first = !ctx.cursor;
      if (first) {
        const records: RKbCategory[] = sections.map((s) => {
          const cat = cats.get(String(s.category_id));
          const name = cat && (perCat.get(String(s.category_id)) ?? 0) > 1 ? `${cat.name} › ${s.name}` : String(cat?.name ?? s.name);
          return { kind: 'kb_category', ext: `s:${s.id}`, name, description: stripHtml(s.description ?? '') };
        });
        yield { records, cursor: { after: '' } };
      }
      const start = (ctx.cursor as { after?: string } | undefined)?.after || undefined;
      for await (const pg of pages(ctx.http, '/help_center/articles.json', 'articles', ctx, {}, start)) {
        const records: RArticle[] = pg.items.map((a) => ({ kind: 'article', ext: `a:${a.id}`, title: String(a.title ?? `Artikel ${a.id}`), html: String(a.body ?? ''), category: a.section_id ? `s:${a.section_id}` : undefined, tags: Array.isArray(a.label_names) ? a.label_names : [], created_at: toIso(a.created_at) }));
        for (const a of pg.items) if (/(src|href)="https?:\/\/[^"]*(zdassets|zendesk)\.com/i.test(String(a.body ?? ''))) ctx.warn(`Artikel „${String(a.title).slice(0, 60)}“: Bilder oder Anhänge liegen noch bei Zendesk – vor dem Kündigen herunterladen und neu einfügen`);
        yield { records, cursor: pg.next ? { after: pg.next } : undefined };
      }
    },
  },
];

export const ZENDESK: SourceDef = {
  key: 'zendesk',
  label: 'Zendesk',
  tagline: 'Tickets mit allen Kommentaren, Kunden und Organisationen, Hilfe-Artikel',
  credentials: [
    { key: 'subdomain', label: 'Subdomain', placeholder: 'meinefirma', hint: 'Der Teil vor .zendesk.com' },
    { key: 'email', label: 'E-Mail des Admins', placeholder: 'admin@meinefirma.de', hint: 'Der Zugang gehört einem Admin – der API-Token wird für diesen Nutzer ausgestellt' },
    { key: 'api_token', label: 'API-Token', secret: true, hint: 'Zendesk → Admin-Center → Apps und Integrationen → APIs → Zendesk-API → „Token-Zugriff aktivieren“ → „API-Token hinzufügen“' },
  ],
  howto: [
    'Im Zendesk Admin-Center: Apps und Integrationen → APIs → „Zendesk-API“. Dort „Token-Zugriff aktivieren“ einschalten und „API-Token hinzufügen“.',
    'Subdomain (der Teil vor .zendesk.com), die E-Mail des Admins und den Token hier eintragen. Der Token sieht, was dieser Admin sieht.',
    'Nach dem Umzug den Token in Zendesk wieder deaktivieren. Gelesen wird nur – in Zendesk ändert HyperLevel nichts.',
  ],
  limits: [
    'Anhänge und Bilder (die Dateien bleiben bei Zendesk – Namen stehen im Ticket, Artikel verlinken noch dorthin)',
    'Makros, Trigger, Automationen, Ansichten, SLA-Richtlinien und Berichte – baue sie in HyperLevel als Textbausteine, Workflows und SLAs neu',
    'Agenten und Gruppen (Teammitglieder legst du in HyperLevel selbst an – der Bearbeiter steht als Notiz im Ticket)',
    'Zufriedenheitsbewertungen, Talk-Anrufe und Chat-Protokolle außerhalb von Tickets',
    'Mehrsprachige Artikel-Übersetzungen (es kommen die Artikel, die die Hilfe-Center-Schnittstelle liefert) – alle Artikel landen als Entwurf',
  ],
  parts: [
    { key: 'contacts', label: 'Kunden → Kontakte', on: true, note: 'Zendesk kennt keine Werbeeinwilligung: im Einwilligungs-Nachweis steht „keine Werbeeinwilligung“ – Werbung geht erst nach einer neuen Einwilligung. Service-Nachrichten sind nicht betroffen.' },
    { key: 'companies', label: 'Organisationen → Firmen', on: true },
    { key: 'tickets', label: 'Tickets mit Kommentaren', on: true, note: 'Ohne SLA-Fristen, ohne E-Mails und ohne Workflow-Auslöser; Kunden- und Team-Antworten und interne Notizen stehen mit Zeitpunkt im Verlauf.' },
    { key: 'articles', label: 'Hilfe-Artikel → Wissensdatenbank (als Entwurf)', on: true, note: 'Alle Artikel kommen als Entwurf – prüfe Bilder und Links, bevor du sie veröffentlichst.' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/users/me.json');
    const u = j?.user ?? {};
    if (u.role === 'end-user') throw new UmzugError(403, 'Zendesk: Dieser Zugang gehört einem Kunden, nicht einem Agenten oder Admin');
    return { account: zendeskBase(creds.subdomain).replace(/^https:\/\//, '').replace(/\.zendesk\.com.*$/, ''), label: `${String(creds.subdomain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.zendesk\.com.*$/, '')}.zendesk.com`, meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
