import type { Account, Batch, CountRow, PartKey, RContact, RForm, RSubmission, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import type { Json } from './umzug-flow.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { counter, nameParts, seg, stubCtx } from './umzug-lib.js';
import { clip, toIso } from './umzug-text.js';

/**
 * Typeform (REST API, https://api.typeform.com or api.eu.typeform.com, a personal access token): forms → forms in HyperLevel (saved as drafts
 * "bitte prüfen"), every completed response → an answer sheet with the form's submissions, the people who answered → contacts when they
 * left an e-mail address (optional; Typeform knows no advertising consent, so the consent ledger says "no advertising consent").
 * Typeform allows two requests a second per account. Logic jumps, themes and welcome / thank-you screens do not move.
 */

const PAGE = 1000;

export function typeformBase(dc: unknown): string {
  const v = String(dc ?? '').trim().toLowerCase();
  if (!v || v === 'us' || v === 'com') return 'https://api.typeform.com';
  if (v === 'eu') return 'https://api.eu.typeform.com';
  throw new UmzugError(400, 'Typeform: Das Rechenzentrum ist „us“ (Standard) oder „eu“');
}

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({
    vendor: 'Typeform',
    base: typeformBase(creds.data_center),
    headers: () => ({ authorization: `Bearer ${String(creds.token ?? '').trim()}` }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    // two requests a second
    pauseMs: deps.pauseMs ?? 520,
    errorText: (b) => (typeof b?.description === 'string' ? b.description : typeof b?.message === 'string' ? b.message : undefined),
  });

// --- forms ------------------------------------------------------------------------------------------------------

const recall = (s: unknown) => String(s ?? '').replace(/\{\{[^}]*\}\}/g, '…').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

/** Questions in reading order; groups, contact-info and address blocks are opened up. */
export function flatFields(fields: unknown, depth = 0): Json[] {
  const out: Json[] = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (['group', 'contact_info', 'address'].includes(String(f?.type)) && depth < 4) out.push(...flatFields(f.properties?.fields, depth + 1));
    else if (f) out.push(f);
  }
  return out;
}

export function typeformField(f: Json): NonNullable<RForm['fields']>[number] | undefined {
  const label = recall(f.title) || 'Frage';
  const required = !!f.validations?.required;
  const choices = (): string[] => (Array.isArray(f.properties?.choices) ? f.properties.choices.map((c: Json) => String(c.label ?? '')).filter(Boolean) : []);
  switch (f.type) {
    case 'short_text':
    case 'website':
      return { label, type: 'text', required };
    case 'long_text':
      return { label, type: 'textarea', required };
    case 'email':
      return { label, type: 'email', required };
    case 'phone_number':
      return { label, type: 'phone', required };
    case 'number':
    case 'rating':
    case 'opinion_scale':
    case 'nps':
      return { label, type: 'number', required };
    case 'yes_no':
      return { label, type: 'radio', required, options: ['Ja', 'Nein'] };
    case 'legal':
      return { label, type: 'checkbox', required };
    case 'multiple_choice':
    case 'picture_choice':
      return { label, type: f.properties?.allow_multiple_selection ? 'checkbox' : 'radio', required, options: choices() };
    case 'dropdown':
      return { label, type: 'select', required, options: choices() };
    case 'date':
      return { label, type: 'date', required };
    case 'file_upload':
    case 'matrix':
    case 'ranking':
      return { label: `${label} (${f.type === 'file_upload' ? 'Datei-Upload bei Typeform' : f.type === 'matrix' ? 'Matrix-Frage' : 'Rangfolge'}: bitte ersetzen)`, type: 'text', required: false };
    default:
      // statement, payment, … carry no answer
      return undefined;
  }
}

export function typeformForm(def: Json): RForm {
  const fields = flatFields(def.fields).map(typeformField).filter((x): x is NonNullable<ReturnType<typeof typeformField>> => !!x);
  const skipped = flatFields(def.fields).filter((f) => !typeformField(f)).length;
  const logic = Array.isArray(def.logic) && def.logic.length;
  return {
    kind: 'form',
    ext: `f:${def.id}`,
    name: String(def.title ?? `Formular ${def.id}`),
    fields,
    note: ['Aus Typeform – bitte prüfen', logic ? 'Typeform-Logik (Sprünge) wurde nicht übernommen' : '', skipped ? `${skipped} Blöcke ohne Antwort (Erklärungen, Zahlung) fehlen` : ''].filter(Boolean).join(' · '),
  };
}

async function* pagedForms(h: VendorHttp, ctx: StepCtx): AsyncGenerator<Json[]> {
  for (let page = 1; page <= 200; page++) {
    if (ctx.cancelled()) return;
    const j = await h.get('/forms', { page, page_size: 200 });
    const items: Json[] = Array.isArray(j?.items) ? j.items : [];
    if (!items.length) return;
    yield items;
    if (page >= Number(j?.page_count ?? 1)) return;
  }
}

// --- responses --------------------------------------------------------------------------------------------------

/** One answer as text (a list for several choices). */
export function answerText(a: Json): string | string[] | undefined {
  switch (a?.type) {
    case 'text':
      return a.text;
    case 'email':
      return a.email;
    case 'phone_number':
      return a.phone_number;
    case 'url':
      return a.url;
    case 'number':
      return a.number === undefined ? undefined : String(a.number);
    case 'boolean':
      return a.boolean === undefined ? undefined : a.boolean ? 'Ja' : 'Nein';
    case 'date':
      return a.date ? String(a.date).slice(0, 10) : undefined;
    case 'choice':
      return a.choice?.label ?? a.choice?.other;
    case 'choices': {
      const list = [...(Array.isArray(a.choices?.labels) ? a.choices.labels : []), ...(a.choices?.other ? [a.choices.other] : [])].map(String);
      return list.length ? list : undefined;
    }
    case 'file_url':
      return a.file_url ? `Datei bei Typeform: ${a.file_url}` : undefined;
    case 'payment':
      return a.payment ? `${a.payment.amount ?? ''} ${a.payment.currency ?? ''}`.trim() : undefined;
    default:
      return undefined;
  }
}

export function typeformResponse(r: Json, def: Json, wantContact: boolean): { submission: RSubmission; contact?: RContact } {
  const titles = new Map<string, string>(flatFields(def.fields).map((f) => [String(f.id), recall(f.title) || 'Frage']));
  const answers: Record<string, string | string[]> = {};
  let email: string | undefined;
  let phone: string | undefined;
  let name: string | undefined;
  for (const a of Array.isArray(r.answers) ? r.answers : []) {
    const q = titles.get(String(a.field?.id)) ?? recall(a.field?.ref) ?? 'Frage';
    const v = answerText(a);
    if (v === undefined || v === '') continue;
    let key = q;
    for (let i = 2; key in answers; i++) key = `${q} (${i})`;
    answers[key] = v;
    if (a.type === 'email' && !email) email = String(a.email).trim();
    else if (a.type === 'phone_number' && !phone) phone = String(a.phone_number);
    else if (a.type === 'text' && !name && /name|heiß|heiss/i.test(q) && !/firma|company|unternehm|nutzer|user|benutzer/i.test(q)) name = String(a.text);
  }
  for (const [k, v] of Object.entries((r.hidden ?? {}) as Record<string, unknown>)) if (v !== undefined && v !== null && v !== '') answers[`Verstecktes Feld: ${k}`] = String(v);
  const meta: Record<string, string> = {};
  for (const k of ['referer', 'platform', 'browser']) if (r.metadata?.[k]) meta[k] = clip(r.metadata[k], 300);
  const form = `f:${def.id}`;
  const contactExt = email ? `e:${email.toLowerCase()}` : undefined;
  const submission: RSubmission = { kind: 'submission', ext: `r:${r.token ?? r.response_id}`, form, answers, contact: contactExt, contact_hint: email ? { email, name } : undefined, at: toIso(r.submitted_at ?? r.landed_at), meta };
  if (!wantContact || !email) return { submission };
  const n = nameParts(name);
  return {
    submission,
    contact: {
      kind: 'contact',
      ext: contactExt!,
      values: { email, first_name: n.first, last_name: n.last, phone },
      consent: 'unknown',
      created_at: toIso(r.submitted_at ?? r.landed_at),
      proof: [{ basis: 'none', method: `Antwort im Typeform-Formular „${clip(def.title, 80)}“ (Typeform kennt keine Werbeeinwilligung)`, channel: 'email' }],
    },
  };
}

// --- steps ------------------------------------------------------------------------------------------------------

const steps = (parts: PartKey[]): StepDef[] => {
  const out: StepDef[] = [];
  if (parts.includes('forms'))
    out.push({
      id: 'forms',
      label: 'Formulare',
      part: 'forms',
      async *run(ctx): AsyncGenerator<Batch> {
        for await (const items of pagedForms(ctx.http, ctx)) {
          const records: RForm[] = [];
          for (const f of items) {
            const def = await ctx.http.get(`/forms/${seg(f.id)}`);
            records.push(typeformForm(def));
          }
          yield { records };
        }
      },
    });
  if (parts.includes('submissions') || parts.includes('contacts'))
    out.push({
      id: 'responses',
      label: 'Antworten',
      part: parts.includes('submissions') ? 'submissions' : 'contacts',
      async *run(ctx): AsyncGenerator<Batch> {
        const wantSubmissions = ctx.parts.includes('submissions');
        const wantContacts = ctx.parts.includes('contacts');
        const resume = ctx.cursor as { form?: string; after?: string; done?: boolean } | undefined;
        let skipping = !!resume?.form;
        const seen = new Set<string>();
        for await (const items of pagedForms(ctx.http, ctx)) {
          for (const f of items) {
            let after: string | undefined;
            if (skipping) {
              if (String(f.id) !== resume!.form) continue;
              skipping = false;
              if (resume!.done) continue;
              after = resume!.after;
            }
            const def = await ctx.http.get(`/forms/${seg(f.id)}`);
            for (;;) {
              if (ctx.cancelled()) return;
              const j = await ctx.http.get(`/forms/${seg(f.id)}/responses`, { page_size: PAGE, response_type: 'completed', sort: 'submitted_at,asc', ...(after ? { after } : {}) });
              const list: Json[] = Array.isArray(j?.items) ? j.items : [];
              const records: (RSubmission | RContact)[] = [];
              for (const r of list) {
                const x = typeformResponse(r, def, wantContacts);
                if (x.contact && !seen.has(x.contact.ext)) (seen.add(x.contact.ext), records.push(x.contact));
                if (wantSubmissions) records.push(x.submission);
              }
              after = list.length ? String(list[list.length - 1].token) : undefined;
              yield { records, cursor: after && list.length >= 1 ? { form: String(f.id), after } : { form: String(f.id), done: true }, total: undefined };
              if (!list.length) break;
            }
          }
        }
      },
    });
  return out;
};

// --- describe ---------------------------------------------------------------------------------------------------

const CONTACT_FIELDS: SourceField[] = [
  { ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' },
  { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' },
  { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' },
  { ref: 'phone', label: 'Telefon', type: 'phone', std: 'phone', group: 'standard' },
];

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const warnings: string[] = [];
  const count = counter(counts);
  const s = stubCtx(h, parts);
  const forms: Json[] = [];
  const ensure = async () => {
    if (forms.length) return;
    for await (const items of pagedForms(h, s)) forms.push(...items);
  };
  if (parts.includes('forms')) await count('forms', 'forms', 'Formulare', async () => (await ensure(), forms.length));
  if (parts.includes('submissions') || parts.includes('contacts')) {
    await count(parts.includes('submissions') ? 'submissions' : 'contacts', 'responses', 'Abgeschickte Antworten', async () => {
      await ensure();
      let n = 0;
      for (const f of forms.slice(0, 60)) n += Number((await h.get(`/forms/${seg(f.id)}/responses`, { page_size: 1, response_type: 'completed' }))?.total_items ?? 0);
      return { n, capped: forms.length > 60 };
    });
    warnings.push('Sehr junge Antworten (etwa die letzten 30 Minuten) liefert Typeform erst später aus – bei Bedarf den Umzug später noch einmal laufen lassen, schon Übernommenes wird nicht doppelt angelegt.');
  }
  return { counts, fields: parts.includes('contacts') ? CONTACT_FIELDS : [], warnings };
}

export const TYPEFORM: SourceDef = {
  key: 'typeform',
  label: 'Typeform',
  tagline: 'Formulare und alle abgeschickten Antworten, Absender als Kontakte',
  credentials: [
    { key: 'token', label: 'Persönlicher Zugangs-Token', secret: true, placeholder: 'tfp_…', hint: 'Typeform → Konto → „Persönliche Tokens“ → „Neuen Token erzeugen“ mit den Rechten „Forms: Read“ und „Responses: Read“' },
    { key: 'data_center', label: 'Rechenzentrum (optional)', optional: true, placeholder: 'us oder eu', hint: '„eu“, wenn dein Konto im EU-Rechenzentrum liegt (Adresse admin.eu.typeform.com), sonst leer lassen' },
  ],
  howto: [
    'In Typeform oben rechts auf dein Profilbild → „Konto“ → „Persönliche Tokens“ → „Token erzeugen“. Rechte: „Forms: Read“ und „Responses: Read“ reichen.',
    'Den Token hier einfügen (bei einem Konto im EU-Rechenzentrum zusätzlich „eu“ eintragen). HyperLevel liest nur und ändert bei Typeform nichts.',
    'Nach dem Umzug den Token bei Typeform löschen.',
  ],
  limits: [
    'Logik (Sprünge), Designs, Willkommens- und Dankeseiten, Berechnungen und Bewertungen – die Fragen und ihre Reihenfolge kommen mit',
    'Datei-Uploads (die Dateien bleiben bei Typeform, der Verweis steht in der Antwort), Zahlungen und Matrix- oder Rangfolge-Fragen (werden Textfelder)',
    'Unvollständige Antworten (abgebrochene Formulare), Webhooks, Integrationen und Auswertungen',
    'Typeform kennt keine Werbeeinwilligung: wer geantwortet hat, ist im Einwilligungs-Nachweis „ohne Werbeeinwilligung“ vermerkt',
  ],
  parts: [
    { key: 'forms', label: 'Formulare → Formulare (bitte prüfen)', on: true, note: 'Fragen mit Typ, Pflichtangabe und Auswahlmöglichkeiten; am Ende kommt eine Einwilligungs-Checkbox dazu. Jedes Formular heißt „… (aus Typeform, bitte prüfen)“.' },
    { key: 'submissions', label: 'Antworten → Antworten der Formulare', on: true, note: 'Mit Datum und den Fragen als Spalten; ohne Benachrichtigung, ohne Workflow. Dafür braucht es den Teil „Formulare“ (jetzt oder aus einem früheren Umzug).' },
    { key: 'contacts', label: 'Absender mit E-Mail → Kontakte', on: false, note: 'Typeform kennt keine Werbeeinwilligung: die Kontakte sind im Einwilligungs-Nachweis „ohne Werbeeinwilligung“ vermerkt – Newsletter erst nach einer neuen Einwilligung. Ohne diesen Teil werden Antworten nur Bestehenden Kontakten (gleiche E-Mail) zugeordnet.' },
  ],
  exports: [],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    const me = await h.get('/me');
    if (!me?.user_id && !me?.email) throw new UmzugError(401, 'Typeform: Zugangsdaten ungültig oder abgelaufen');
    return { account: `tf-${me.user_id ?? String(me.email).toLowerCase()}`, label: `${me.alias ?? me.email ?? 'Typeform'}${typeformBase(creds.data_center).includes('.eu.') ? ' (EU)' : ''}`, meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps(parts),
};
