import { createHash } from 'node:crypto';
import type { Account, Batch, CountRow, PartKey, RReference, RTagRec, SourceDef, SourceField, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { cell, type Json } from './umzug-flow.js';
import { counter } from './umzug-lib.js';

/**
 * ManyChat (Page API, https://api.manychat.com, header `Authorization: Bearer <page id>:<token>`). The API cannot list subscribers –
 * only look one up by id, name or field – so the contacts come from the export file (the generic reader, with the opt-in columns of
 * the export written into the consent ledger). The API gives what the file does not: the account's tags (created, so they exist
 * before the contacts arrive), and – as a reference list in the wiki – flows, tags, custom fields and bot field names, which
 * is what you need to rebuild the automations. Bot field values are never read into the list (they often hold secrets).
 */

const BASE = 'https://api.manychat.com';

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'ManyChat',
    base: BASE,
    headers: () => ({ authorization: `Bearer ${creds.api_token ?? ''}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? 120,
    errorText: (b) => (typeof b?.message === 'string' ? b.message : typeof b?.details?.messages?.[0]?.message === 'string' ? b.details.messages[0].message : undefined),
  });

/** ManyChat wraps every answer in `{ status, data }`; a body with status "error" is an error even with HTTP 200. */
async function call(h: VendorHttp, path: string): Promise<any> {
  const j = await h.get(path);
  if (j?.status && j.status !== 'success') throw new UmzugError(400, `ManyChat: ${String(j.message ?? j.status).slice(0, 200)}`, path);
  return j?.data;
}
const list = (d: any): Json[] => (Array.isArray(d) ? d : []);

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const count = counter(counts);
  if (parts.includes('contacts')) {
    await count('contacts', 'tags', 'Tags', async () => list(await call(h, '/fb/page/getTags')).length);
    counts.push({ part: 'contacts', key: 'subscribers', label: 'Kontakte', total: null, error: 'Die ManyChat-Schnittstelle nennt keine Kontaktliste – die Kontakte kommen über die Export-Datei (Tab „Export-Datei hochladen“)' });
  }
  if (parts.includes('reference')) {
    await count('reference', 'flows', 'Flows', async () => list((await call(h, '/fb/page/getFlows'))?.flows).length);
    await count('reference', 'fields', 'Eigene Felder', async () => list(await call(h, '/fb/page/getCustomFields')).length);
  }
  return { counts, fields, warnings: ['ManyChat kann Kontakte nicht über die Schnittstelle auflisten (nur einzeln nachschlagen). Exportiere sie in ManyChat als Datei und lade sie bei „Export-Datei hochladen“ hoch – dort bekommen sie Tags, Felder und die Einwilligung aus den Opt-in-Spalten.'] };
}

const TYPE: Record<string, string> = { text: 'Text', number: 'Zahl', date: 'Datum', datetime: 'Datum und Uhrzeit', boolean: 'Ja/Nein', array: 'Liste' };

const steps = (): StepDef[] => [
  {
    id: 'tags',
    label: 'Tags',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      const tags = list(await call(ctx.http, '/fb/page/getTags'));
      yield { records: tags.filter((t) => t.name).map((t): RTagRec => ({ kind: 'tag', name: String(t.name) })), cursor: undefined };
    },
  },
  {
    id: 'reference',
    label: 'Flows, Tags und Felder → Referenzliste',
    part: 'reference',
    async *run(ctx): AsyncGenerator<Batch> {
      const flowsData: Json = (await call(ctx.http, '/fb/page/getFlows')) ?? {};
      const flows = list(flowsData.flows);
      const folders = new Map(list(flowsData.folders).map((f) => [String(f.id), String(f.name ?? f.id)]));
      const tags = list(await call(ctx.http, '/fb/page/getTags'));
      const fields = list(await call(ctx.http, '/fb/page/getCustomFields'));
      const bot = list(await call(ctx.http, '/fb/page/getBotFields').catch(() => []));
      const body = [
        '# ManyChat-Konto: Flows, Tags und Felder',
        '',
        `Stand: ${new Date().toISOString().slice(0, 10)}. Diese Liste ist eine **Gedächtnisstütze** zum Nachbauen: ManyChats Schnittstelle liefert die Namen der Flows, nicht ihren Inhalt (Nachrichten, Bedingungen, Schaltflächen). Bau jeden Flow, den du brauchst, in HyperLevel als Workflow oder Chat-Ablauf nach, und prüfe vor dem Kündigen, dass nichts fehlt.`,
        '',
        `## Flows (${flows.length})`,
        '',
        ...(flows.length ? ['| Flow | Ordner | Kennung |', '| --- | --- | --- |', ...flows.map((f) => `| ${cell(f.name) || '–'} | ${cell(folders.get(String(f.folder_id))) || '–'} | ${cell(f.ns) || '–'} |`)] : ['_Keine Flows._']),
        '',
        `## Tags (${tags.length})`,
        '',
        tags.length ? tags.map((t) => `- ${cell(t.name)}`).join('\n') : '_Keine Tags._',
        '',
        `## Eigene Felder (${fields.length})`,
        '',
        ...(fields.length ? ['| Feld | Typ | Beschreibung |', '| --- | --- | --- |', ...fields.map((f) => `| ${cell(f.name)} | ${cell(TYPE[String(f.type)] ?? f.type) || '–'} | ${cell(f.description) || '–'} |`)] : ['_Keine eigenen Felder._']),
        '',
        `## Bot-Felder (${bot.length})`,
        '',
        bot.length ? `Nur die Namen – die Werte gehören nicht in eine Liste (sie enthalten oft Schlüssel oder Zugangsdaten):\n\n${bot.map((f) => `- ${cell(f.name)} (${cell(TYPE[String(f.type)] ?? f.type) || '–'})`).join('\n')}` : '_Keine Bot-Felder._',
      ].join('\n');
      if (flows.length) ctx.warn(`Flows: ${flows.length} Flow${flows.length === 1 ? '' : 's'} als Referenzliste im Wiki (Bereich „Umzug“) – ihren Inhalt liefert ManyChat nicht, nachbauen musst du sie selbst.`);
      yield { records: [{ kind: 'reference', ext: 'account', title: 'ManyChat-Konto: Flows, Tags und Felder', body } satisfies RReference], cursor: undefined };
    },
  },
];

export const MANYCHAT: SourceDef = {
  key: 'manychat',
  label: 'ManyChat',
  tagline: 'Kontakte aus der Export-Datei mit Kanälen, Tags und Feldern – dazu Tags und die Flow-Liste über die Schnittstelle',
  credentials: [{ key: 'api_token', label: 'API-Schlüssel', secret: true, placeholder: '123456789:abcdef…', hint: 'ManyChat → Einstellungen → „API“ → „Generate Your API Key“ (Pro-Tarif)' }],
  howto: [
    'In ManyChat links unten auf „Settings“ → „API“ → „Generate Your API Key“ (die Schnittstelle gehört zum Pro-Tarif). Den Schlüssel – er beginnt mit der Seiten-Nummer, einem Doppelpunkt und dem Token – hier einfügen.',
    'Die Schnittstelle kann Kontakte nicht auflisten. Exportiere sie deshalb in ManyChat als Datei (Contacts → „Export“ bzw. im Bulk-Menü) und lade die Datei bei „Export-Datei hochladen“ hoch: Namen, E-Mail, Telefon, Tags, eigene Felder und die Opt-in-Spalten kommen mit.',
    'Mit dem Schlüssel legt HyperLevel die Tags an und schreibt eine Referenzliste deiner Flows ins Wiki. Gelesen wird nur – in ManyChat ändert sich nichts.',
  ],
  limits: [
    'Kontakte über die Schnittstelle (ManyChat bietet keine Liste – nimm die Export-Datei)',
    'Der Inhalt der Flows (Nachrichten, Bedingungen, Schaltflächen) – nur Namen und Ordner kommen als Referenzliste ins Wiki',
    'Gesprächsverlauf, Live-Chat-Nachrichten und Broadcast-Statistiken',
    'Kanal-Verbindungen (Instagram, WhatsApp, Messenger, Telegram) und Vorlagen – die richtest du in HyperLevel neu ein; die Kanal-Kennungen eines Kontakts (z. B. Instagram-ID) gelten nur bei ManyChat',
    'Bot-Feld-Werte (sie stehen aus Sicherheitsgründen nicht in der Liste)',
  ],
  parts: [
    { key: 'contacts', label: 'Tags des Kontos anlegen', on: true, note: 'Die Kontakte selbst kommen über die Export-Datei.' },
    { key: 'reference', label: 'Flows, Tags und Felder → Referenzliste im Wiki', on: true, note: 'Namen, Ordner und Typen als Gedächtnisstütze zum Nachbauen.' },
  ],
  exports: [
    { key: 'contacts', label: 'Kontakte-Export (CSV)', accept: ['.csv'], describe: 'ManyChat → Contacts → Export (CSV). Aus den Spalten „Opt-in E-Mail“ / „Opt-in Telefon“ wird die Einwilligung im Nachweis; „Subscribed“ = nein bekommt „Nicht stören“.', part: 'contacts' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const d = (await call(h, '/fb/page/getInfo')) ?? {};
    const id = String(d.id ?? '');
    return { account: /^\d{3,25}$/.test(id) ? `page-${id}` : `key-${createHash('sha256').update(String(creds.api_token ?? '')).digest('hex').slice(0, 10)}`, label: String(d.name ?? 'ManyChat-Seite').slice(0, 120), meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};
