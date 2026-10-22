import { createHash } from 'node:crypto';
import type { Account, Batch, Consent, CountRow, FieldType, PartKey, RContact, RMembership, RNote, RSmartList, RTagRec, RTemplate, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { toDay, toIso } from './umzug-text.js';

/**
 * Mailchimp (Marketing API v3, https://<dc>.api.mailchimp.com/3.0): audiences → tags (and a tag per
 * audience), members with merge fields, tags and status (→ DND + tag), static and saved segments → tags +
 * smart lists, HTML templates → e-mail templates, campaign history → notes (optional).
 */

const DC = /^[a-z]{2,4}\d{1,3}$/;
const md5 = (s: string) => createHash('md5').update(s.trim().toLowerCase()).digest('hex');
const PAGE = 1000;

export function mailchimpBase(key: string): string {
  const dc = key.includes('-') ? key.slice(key.lastIndexOf('-') + 1) : '';
  if (!DC.test(dc)) throw new UmzugError(400, 'Der Mailchimp-API-Key endet auf „-us12“ o. ä. (das Rechenzentrum) – bitte den ganzen Schlüssel einfügen');
  return `https://${dc}.api.mailchimp.com/3.0`;
}

const CONSENT: Record<string, Consent> = { subscribed: 'ok', unsubscribed: 'unsubscribed', cleaned: 'bounced', pending: 'pending', transactional: 'blocked', archived: 'blocked' };

const mergeType = (t: string): FieldType => (t === 'number' ? 'number' : t === 'phone' ? 'phone' : t === 'date' || t === 'birthday' ? 'date' : t === 'url' || t === 'imageurl' ? 'url' : t === 'radio' || t === 'dropdown' ? 'select' : 'text');

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Mailchimp',
    base: mailchimpBase(creds.api_key ?? ''),
    headers: () => ({ authorization: `Basic ${Buffer.from(`gohigh:${creds.api_key}`).toString('base64')}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 60,
    errorText: (b) => b?.detail ?? b?.title,
  });

interface List {
  id: string;
  name: string;
  members: number;
}
async function lists(h: VendorHttp): Promise<List[]> {
  const out: List[] = [];
  for (let offset = 0; offset < 100_000; offset += 100) {
    const j = await h.get('/lists', { count: 100, offset, fields: 'lists.id,lists.name,lists.stats.member_count,lists.stats.unsubscribe_count,lists.stats.cleaned_count,total_items' });
    for (const l of j.lists ?? []) out.push({ id: String(l.id), name: String(l.name ?? l.id), members: Number(l.stats?.member_count ?? 0) + Number(l.stats?.unsubscribe_count ?? 0) + Number(l.stats?.cleaned_count ?? 0) });
    if (!(j.lists ?? []).length || out.length >= Number(j.total_items ?? 0)) break;
  }
  return out;
}

const total = async (h: VendorHttp, path: string, query: Record<string, unknown> = {}) => Number((await h.get(path, { count: 1, fields: 'total_items', ...query })).total_items ?? 0);

async function describe(h: VendorHttp, parts: PartKey[]) {
  const ls = await lists(h);
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const fields = new Map<string, SourceField>();
  const add = (f: SourceField) => !fields.has(f.ref) && fields.set(f.ref, f);
  add({ ref: 'member:email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' });
  if (parts.includes('contacts')) {
    counts.push({ part: 'contacts', key: 'lists', label: 'Audiences (Listen)', total: ls.length });
    // Members of all audiences; the same person in two audiences is one contact here.
    counts.push({ part: 'contacts', key: 'members', label: 'Kontakte (je Audience gezählt)', total: ls.reduce((n, l) => n + l.members, 0) });
    for (const l of ls) {
      try {
        const j = await h.get(`/lists/${l.id}/merge-fields`, { count: 1000, fields: 'merge_fields.tag,merge_fields.name,merge_fields.type' });
        for (const m of j.merge_fields ?? []) {
          const tag = String(m.tag);
          if (m.type === 'address') {
            add({ ref: `merge:${tag}.addr1`, label: `${m.name} – Straße`, type: 'text', std: 'address', group: 'standard' });
            add({ ref: `merge:${tag}.addr2`, label: `${m.name} – Zusatz`, type: 'text', group: 'custom' });
            add({ ref: `merge:${tag}.city`, label: `${m.name} – Ort`, type: 'text', std: 'city', group: 'standard' });
            add({ ref: `merge:${tag}.state`, label: `${m.name} – Bundesland`, type: 'text', group: 'custom' });
            add({ ref: `merge:${tag}.zip`, label: `${m.name} – PLZ`, type: 'text', std: 'postal_code', group: 'standard' });
            add({ ref: `merge:${tag}.country`, label: `${m.name} – Land`, type: 'text', std: 'country', group: 'standard' });
          } else {
            const std = tag === 'FNAME' ? 'first_name' : tag === 'LNAME' ? 'last_name' : tag === 'PHONE' ? 'phone' : tag === 'COMPANY' ? 'company' : tag === 'BIRTHDAY' || m.type === 'birthday' ? 'date_of_birth' : undefined;
            add({ ref: `merge:${tag}`, label: String(m.name || tag), type: mergeType(String(m.type)), std, group: std ? 'standard' : 'custom' });
          }
        }
      } catch (e) {
        if (!(e instanceof UmzugError && e.skippable)) throw e;
        warnings.push(`Felder von „${l.name}“ nicht lesbar: ${e.message}`);
      }
    }
    add({ ref: 'member:language', label: 'Sprache', type: 'text', preset: '', group: 'custom' });
    add({ ref: 'member:vip', label: 'VIP', type: 'checkbox', preset: '', group: 'custom' });
  }
  if (parts.includes('segments')) {
    let n = 0;
    for (const l of ls) n += await total(h, `/lists/${l.id}/segments`).catch(() => 0);
    counts.push({ part: 'segments', key: 'segments', label: 'Segmente', total: n });
  }
  if (parts.includes('templates')) counts.push({ part: 'templates', key: 'templates', label: 'E-Mail-Vorlagen', total: await total(h, '/templates', { type: 'user' }).catch(() => null) });
  if (parts.includes('campaigns')) counts.push({ part: 'campaigns', key: 'campaigns', label: 'Gesendete Kampagnen (die letzten 20 als Notizen)', total: await total(h, '/campaigns', { status: 'sent' }).catch(() => null) });
  return { counts, fields: [...fields.values()], warnings };
}

const flatMember = (m: any, listName: string): RContact => {
  const values: Record<string, unknown> = { 'member:email': m.email_address, 'member:language': m.language, 'member:vip': m.vip };
  for (const [tag, v] of Object.entries(m.merge_fields ?? {})) {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) values[`merge:${tag}.${k}`] = x;
    else values[`merge:${tag}`] = tag === 'BIRTHDAY' ? toDay(v) : v;
  }
  const status = String(m.status ?? 'subscribed');
  return {
    kind: 'contact',
    ext: `m:${m.id ?? md5(m.email_address)}`,
    values,
    tags: [`Liste: ${listName}`, ...(m.tags ?? []).map((t: any) => String(t.name))],
    consent: CONSENT[status] ?? 'unknown',
    native_status: status,
    consent_at: toIso(m.timestamp_opt ?? m.timestamp_signup),
    created_at: toIso(m.timestamp_signup ?? m.timestamp_opt),
  };
};

async function* paged(h: VendorHttp, path: string, key: string, query: Record<string, unknown>, ctx: StepCtx, startOffset = 0): AsyncGenerator<{ items: any[]; next: number | undefined; total: number }> {
  for (let offset = startOffset; ; offset += PAGE) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { count: PAGE, offset, ...query });
    const items: any[] = j[key] ?? [];
    const totalItems = Number(j.total_items ?? 0);
    const next = items.length === PAGE && offset + PAGE < totalItems ? offset + PAGE : undefined;
    yield { items, next, total: totalItems };
    if (next === undefined) return;
  }
}

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Tags und Audiences',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const records: RTagRec[] = [];
      for (const l of await lists(ctx.http)) {
        records.push({ kind: 'tag', name: `Liste: ${l.name}` });
        for await (const pg of paged(ctx.http, `/lists/${l.id}/tag-search`, 'tags', {}, ctx)) for (const t of pg.items) records.push({ kind: 'tag', name: String(t.name) });
      }
      yield { records, cursor: undefined };
    },
  },
  {
    id: 'contacts',
    label: 'Kontakte',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const ls = await lists(ctx.http);
      const all = ls.reduce((n, l) => n + l.members, 0);
      const cur = (ctx.cursor ?? { li: 0, off: 0 }) as { li: number; off: number };
      for (let li = cur.li; li < ls.length; li++) {
        const l = ls[li];
        for await (const pg of paged(ctx.http, `/lists/${l.id}/members`, 'members', { fields: 'members.id,members.email_address,members.status,members.merge_fields,members.tags,members.language,members.vip,members.timestamp_signup,members.timestamp_opt,total_items' }, ctx, li === cur.li ? cur.off : 0)) {
          yield { records: pg.items.map((m) => flatMember(m, l.name)), total: all, cursor: pg.next !== undefined ? { li, off: pg.next } : li + 1 < ls.length ? { li: li + 1, off: 0 } : undefined };
        }
      }
    },
  },
  {
    id: 'segments',
    label: 'Segmente',
    part: 'segments',
    async *run(ctx): AsyncGenerator<Batch> {
      const ls = await lists(ctx.http);
      const cur = (ctx.cursor ?? { li: 0, si: 0 }) as { li: number; si: number };
      for (let li = cur.li; li < ls.length; li++) {
        const l = ls[li];
        const segs: any[] = [];
        for await (const pg of paged(ctx.http, `/lists/${l.id}/segments`, 'segments', { fields: 'segments.id,segments.name,segments.type,segments.member_count,total_items' }, ctx)) segs.push(...pg.items);
        for (let si = li === cur.li ? cur.si : 0; si < segs.length; si++) {
          const s = segs[si];
          if (s.type === 'fuzzy') continue;
          const tag = `Segment: ${s.name}`;
          const records: (RMembership | RSmartList | RTagRec)[] = [{ kind: 'tag', name: tag }];
          for await (const pg of paged(ctx.http, `/lists/${l.id}/segments/${s.id}/members`, 'members', { fields: 'members.id,members.email_address,total_items' }, ctx)) for (const m of pg.items) records.push({ kind: 'membership', contact: `m:${m.id ?? md5(m.email_address)}`, tags: [tag] });
          if (s.type === 'saved') ctx.warn(`Segment „${s.name}“ hat Bedingungen in Mailchimp: übernommen als feste Liste der aktuellen Mitglieder (Tag „${tag}“), nicht als dynamische Regel`);
          records.push({ kind: 'smart_list', ext: `s:${l.id}:${s.id}`, name: `${s.name} (${l.name})`, tag });
          yield { records, cursor: si + 1 < segs.length ? { li, si: si + 1 } : li + 1 < ls.length ? { li: li + 1, si: 0 } : undefined };
        }
      }
    },
  },
  {
    id: 'templates',
    label: 'E-Mail-Vorlagen',
    part: 'templates',
    async *run(ctx): AsyncGenerator<Batch> {
      const cur = Number(ctx.cursor ?? 0);
      for await (const pg of paged(ctx.http, '/templates', 'templates', { type: 'user', fields: 'templates.id,templates.name,templates.type,total_items' }, ctx, cur)) {
        const records: RTemplate[] = [];
        for (const t of pg.items) {
          try {
            const c = await ctx.http.get(`/templates/${t.id}/default-content`);
            records.push({ kind: 'template', ext: `t:${t.id}`, name: String(t.name), html: String(c.html ?? ''), subject: '' });
          } catch (e) {
            if (!(e instanceof UmzugError && e.skippable)) throw e;
            ctx.warn(`Vorlage „${t.name}“ nicht lesbar: ${e.message}`);
          }
        }
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'campaigns',
    label: 'Kampagnen-Verlauf',
    part: 'campaigns',
    async *run(ctx): AsyncGenerator<Batch> {
      const j = await ctx.http.get('/campaigns', { count: 20, status: 'sent', sort_field: 'send_time', sort_dir: 'DESC', fields: 'campaigns.id,campaigns.settings.subject_line,campaigns.settings.title,campaigns.send_time' });
      const camps: any[] = j.campaigns ?? [];
      const from = Number(ctx.cursor ?? 0);
      for (let i = from; i < camps.length; i++) {
        const c = camps[i];
        const title = String(c.settings?.title || c.settings?.subject_line || c.id);
        for await (const pg of paged(ctx.http, `/reports/${c.id}/sent-to`, 'sent_to', { fields: 'sent_to.email_address,sent_to.status,sent_to.open_count,total_items' }, ctx)) {
          const notes: RNote[] = pg.items.map((r) => ({
            kind: 'note',
            ext: `c:${c.id}:${md5(r.email_address)}`,
            contact: `m:${md5(r.email_address)}`,
            at: toIso(c.send_time),
            body: `Mailchimp-Kampagne „${title}“${c.settings?.subject_line && c.settings.subject_line !== title ? ` (Betreff: ${c.settings.subject_line})` : ''} erhalten${Number(r.open_count) > 0 ? `, ${r.open_count}× geöffnet` : ''}${/bounce/i.test(String(r.status)) ? ' – unzustellbar' : ''}.`,
          }));
          yield { records: notes, cursor: pg.next === undefined ? (i + 1 < camps.length ? i + 1 : undefined) : i, total: pg.total };
        }
      }
    },
  },
];

export const MAILCHIMP: SourceDef = {
  key: 'mailchimp',
  label: 'Mailchimp',
  tagline: 'Audiences, Kontakte mit Tags und Status, Segmente, Vorlagen',
  credentials: [{ key: 'api_key', label: 'API-Key', secret: true, placeholder: '0123456789abcdef0123456789abcdef-us12', hint: 'Mailchimp → Konto → Extras → API-Keys → „Key erstellen“. Der Teil nach dem Bindestrich (us12) gehört dazu.' }],
  howto: ['In Mailchimp unten links auf dein Profil klicken → „Profile“ → Reiter „Extras“ → „API keys“.', '„Create A Key“ wählen, benennen (z. B. „Umzug“) und den Schlüssel hier einfügen – mit dem Teil hinter dem Bindestrich.', 'Der Key braucht nur Lesezugriff auf Audiences und Vorlagen; nach dem Umzug kannst du ihn in Mailchimp wieder löschen.'],
  limits: ['Berichte und Statistiken (nur optional als Notiz je Kontakt: Kampagne erhalten/geöffnet)','Automationen (Customer Journeys): nicht per API lesbar – in HyperLevel als Workflow neu bauen','Landing Pages, Formulare, Pop-ups und Websites','Dynamische Segmente werden zur festen Liste der aktuellen Mitglieder','Bilder in Vorlagen bleiben bei Mailchimp verlinkt – vor der Kündigung herunterladen und neu hochladen'],
  parts: [
    { key: 'contacts', label: 'Audiences, Kontakte, Tags und Felder', on: true, note: 'Status „abgemeldet“ und „bounced“ werden zu „Nicht stören“ plus Tag; jede Audience wird zum Tag „Liste: …“.' },
    { key: 'segments', label: 'Segmente → Tags und Smart Lists', on: true, note: 'Dynamische Segmente werden zu einer festen Liste der aktuellen Mitglieder.' },
    { key: 'templates', label: 'E-Mail-Vorlagen (HTML)', on: true },
    { key: 'campaigns', label: 'Kampagnen-Verlauf als Notizen (die letzten 20 Kampagnen)', on: false, note: 'Je Kontakt eine Notiz „Kampagne erhalten / geöffnet“. Kann bei großen Listen dauern.' },
  ],
  exports: [
    { key: 'contacts', label: 'Audience-Export (CSV oder ZIP)', accept: ['.csv', '.zip'], describe: 'Audience → Kontakte → Audience exportieren – die ZIP-Datei kannst du direkt hochladen (Abgemeldete und Bounces stehen darin als eigene Dateien).', part: 'contacts' },
    { key: 'templates', label: 'Vorlagen (HTML-Dateien)', accept: ['.html', '.zip'], describe: 'Pro Vorlage „Als HTML exportieren“ und die Dateien hochladen.', part: 'templates' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const j = await h.get('/', { fields: 'account_id,account_name,email,login_id' });
    return { account: String(j.account_id ?? j.login_id ?? mailchimpBase(creds.api_key)), label: String(j.account_name ?? j.email ?? 'Mailchimp'), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};

