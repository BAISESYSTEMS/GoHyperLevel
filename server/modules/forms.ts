import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, html, notFound, str } from '../core/http.js';
import { messagePage, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney, id, now } from '../core/util.js';
import { contentMatches, extFor } from '../core/files.js';
import { CONTACT_FIELDS, logActivity, upsertContact } from '../services/contacts.js';
import { checkContactFields, isProtectedContactKey } from './form-mapping.js';
import { notifyTeam } from '../services/messaging.js';
import { createOpportunity } from '../services/opportunities.js';
import { signToken } from '../services/creator-kit.js';
import { captchaKeys, verifyTurnstile } from '../services/form-captcha.js';
import { cleanAnswer, cleanFields, cleanFormSettings, type FormField } from '../services/form-fields.js';
import { computeValues, formatValue, interpolate, isVisible, pickEnding, reachedFields, varName, type Ending } from '../services/form-logic.js';
import { renderForm, pageStyle, type FormRuntime } from '../services/form-render.js';
import { FONTS, cleanTheme, contrastWarnings, themeOf, themeVars } from '../services/form-themes.js';

export type { FormField };
export { isVisible, renderForm };

const FILE_MAX = 5 * 1024 * 1024;
const SIGNATURE_MAX = 200 * 1024;
const FILE_TYPES = /^(image\/(png|jpeg|gif|webp|heic)|application\/(pdf|zip|msword|vnd\.openxmlformats-officedocument\.[\w.]+|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.oasis\.opendocument\.[\w.]+)|text\/(plain|csv))$/;

export const DEFAULT_FIELDS: FormField[] = [
  { id: 'f1', type: 'text', label: 'Vorname', name: 'first_name', required: true },
  { id: 'f2', type: 'text', label: 'Nachname', name: 'last_name' },
  { id: 'f3', type: 'email', label: 'E-Mail', name: 'email', required: true },
  { id: 'f4', type: 'phone', label: 'Telefon', name: 'phone' },
  { id: 'f5', type: 'textarea', label: 'Nachricht', name: 'message' },
  { id: 'f6', type: 'consent', label: 'Ich stimme der Verarbeitung meiner Daten gemäß Datenschutzerklärung zu.', name: 'consent', required: true },
];

const RESIZE_SCRIPT = `<script>new ResizeObserver(()=>parent.postMessage({pghlHeight:document.documentElement.scrollHeight},'*')).observe(document.body);</script>`;

/** What the page needs beyond the form itself: the captcha's site key, the product behind a payment field, whether abandoned entries are wanted. */
function runtimeOf(app: App, f: { id?: string; location_id: string; fields: FormField[]; settings?: any }): FormRuntime {
  const rt: FormRuntime = {};
  // The page reports half-typed e-mail/phone only while a workflow "Formular abgebrochen" listens (the server stores nothing otherwise).
  // (Looked up when the page is rendered, not each time a form is loaded.)
  if (f.id) Object.defineProperty(rt, 'partial', { enumerable: true, get: () => !!app.services.formAbandonListening?.(f.location_id, f.id) });
  if (f.settings?.captcha?.enabled) {
    const keys = captchaKeys(app, f.location_id);
    if (keys) rt.captcha = { site_key: keys.site_key };
  }
  const pay = f.fields.find((x) => x.type === 'payment' && x.product_id);
  if (pay && app.services.stripeKey?.(f.location_id)) {
    const found = app.services.stripeBuy?.resolveProduct(pay.product_id);
    if (found && found.p.location_id === f.location_id) {
      const gross = app.services.stripeBuy.grossOf(found.p).gross as number;
      rt.products = { [pay.product_id!]: { name: found.p.name, price: `${centsToMoney(gross, found.p.currency)}${found.p.recurring === 'month' ? ' / Monat' : found.p.recurring === 'year' ? ' / Jahr' : ''}` } };
    }
  }
  return rt;
}

export function getForm(app: App, formId: string) {
  const f: any = parseJson(app.db.get('SELECT * FROM forms WHERE id = ?', formId), ['fields', 'settings']);
  // Not part of the stored form (and not serialised): captcha key and product, for the page renderer.
  if (f) Object.defineProperty(f, 'runtime', { value: runtimeOf(app, f), enumerable: false, writable: true, configurable: true });
  return f;
}

const recent = new Map<string, number[]>();
/** Submissions per address and minute (PGHL_FORMS_PER_MINUTE, default 20). */
function rateLimited(ip: string): boolean {
  const t = Date.now();
  const list = (recent.get(ip) ?? []).filter((x) => t - x < 60_000);
  list.push(t);
  recent.set(ip, list);
  return list.length > (Math.max(1, Number(process.env.PGHL_FORMS_PER_MINUTE)) || 20);
}

/** Stored file of an upload: extension from the checked type (older files: from the client's name). */
function storedFile(app: App, row: { id: string; name: string; mime: string }): string {
  const file = join(formFileDir(app), row.id + extFor(row.mime));
  if (existsSync(file)) return file;
  return join(formFileDir(app), row.id + (extname(row.name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin'));
}

function formFileDir(app: App) {
  return join(app.config.dataDir, 'form-files');
}

function saveFormFile(app: App, form: any, submissionId: string, f: FormField, v: any, maxBytes = FILE_MAX): string {
  // A signature arrives as a plain PNG data URL.
  if (typeof v === 'string' && v.startsWith('data:')) v = { name: 'unterschrift.png', data: v };
  const m = String(v?.data ?? '').match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) throw bad(`„${f.label}“: Datei fehlt`);
  if (!FILE_TYPES.test(m[1])) throw bad(`„${f.label}“: Dateityp nicht erlaubt (Bilder, PDF, Office, ZIP, TXT)`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw bad(`„${f.label}“: Datei größer als ${Math.round(maxBytes / 1024 / (maxBytes >= 1024 * 1024 ? 1024 : 1))} ${maxBytes >= 1024 * 1024 ? 'MB' : 'KB'}`);
  // The bytes must match the claimed type (an "image" that is really HTML is refused).
  if (!contentMatches(m[1], buf)) throw bad(`„${f.label}“: Dateiinhalt passt nicht zum Dateityp`);
  const name = String(v.name || 'datei').replace(/[\\/\r\n"]/g, '_').slice(0, 150);
  const row = { id: id(20), location_id: form.location_id, form_id: form.id, submission_id: submissionId, field: f.name, name, mime: m[1], size: buf.length, created_at: now() };
  mkdirSync(formFileDir(app), { recursive: true });
  writeFileSync(join(formFileDir(app), row.id + extFor(row.mime)), buf);
  app.db.insert('form_files', row);
  return `${app.baseUrl()}/api/form-files/${row.id}?locationId=${form.location_id}`;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** What a submission contains once it is checked: nothing has been written yet. */
export interface Plan {
  form: any;
  raw: Record<string, any>;
  reached: FormField[];
  cleaned: Map<string, string | string[]>;
  values: Record<string, number>;
  calculators: Record<string, number>;
  ending?: Ending;
  pay?: FormField;
}

/** Checks a submission against the form: the path through it (jumps, show_if), required fields, the format of every answer. Throws a German message. */
export function planSubmission(form: any, raw: Record<string, any>): Plan {
  const s = form.settings ?? {};
  const fields = form.fields as FormField[];
  const reached = reachedFields(fields, s.mode === 'typeform' ? 'typeform' : 'classic', raw);
  const cleaned = new Map<string, string | string[]>();
  let pay: FormField | undefined;
  for (const f of reached) {
    if (['heading', 'page_break', 'calculator'].includes(f.type)) continue;
    if (f.type === 'payment') {
      pay = f;
      continue;
    }
    const v = raw[f.name];
    if (isEmpty(v)) {
      if (f.required && f.type !== 'hidden') throw bad(`Bitte „${f.label}“ ausfüllen`);
      continue;
    }
    if (f.type === 'file' || f.type === 'signature' || f.type === 'hidden') continue;
    cleaned.set(f.id, cleanAnswer(f, v));
  }
  const { values, calculators } = computeValues(reached, s, raw);
  return { form, raw, reached, cleaned, values, calculators, ending: pickEnding(s.endings, values), pay };
}

const label = (f: FormField) => f.label || f.name;
const asText = (v: string | string[]) => (Array.isArray(v) ? v.join(', ') : v);

/** Writes a checked submission: files, contact, opportunity, the submission itself, notifications and events. */
export function storeSubmission(app: App, plan: Plan, meta: { ip?: string } = {}) {
  const { form, raw, reached, cleaned, values, calculators, ending, pay } = plan;
  const s = form.settings ?? {};
  const subId = id();
  const answers: Record<string, any> = {};
  const contactInput: Record<string, any> = { custom: {} };
  const refused: string[] = [];
  // Files from anonymous visitors count against the sub-account's disk quota (modules/public-upload-quota.ts): 413 before anything is written.
  const incoming = reached.reduce((n, f) => {
    const v = raw[f.name];
    if ((f.type !== 'file' && f.type !== 'signature') || isEmpty(v)) return n;
    const list = f.type === 'file' ? (Array.isArray(v) ? v.slice(0, 5) : [v]) : [Array.isArray(v) ? v[0] : v];
    return n + list.reduce((m: number, x: any) => m + Math.floor((String(typeof x === 'string' ? x : (x?.data ?? '')).replace(/^data:[^,]*,/, '').length * 3) / 4), 0);
  }, 0);
  if (incoming > 0) app.services.publicUploadGate?.(form.location_id, incoming);
  // Fields mapped to a company, deal or custom object (modules/form-mapping.ts): checked now, written once the contact exists.
  app.services.formMapping?.check(form, plan);
  for (const f of reached) {
    if (['heading', 'page_break', 'payment'].includes(f.type)) continue;
    if (f.type === 'calculator') {
      answers[label(f)] = formatValue(calculators[f.id] ?? 0, f.format);
      continue;
    }
    const v = raw[f.name];
    if (isEmpty(v)) continue;
    if (f.type === 'file') {
      answers[label(f)] = (Array.isArray(v) ? v.slice(0, 5) : [v]).map((x) => saveFormFile(app, form, subId, f, x)).join('\n');
      continue;
    }
    if (f.type === 'signature') {
      answers[label(f)] = saveFormFile(app, form, subId, f, Array.isArray(v) ? v[0] : v, SIGNATURE_MAX);
      continue;
    }
    const val = f.type === 'hidden' ? (Array.isArray(v) ? v.map(String) : String(v).slice(0, 10000)) : cleaned.get(f.id)!;
    answers[label(f)] = val;
    // Owner and lead source stay the team's (modules/form-mapping.ts): an older form that maps there skips them and says so.
    if (isProtectedContactKey(f.name)) refused.push(`${label(f)}: Kontakt-Feld „${f.name}“ ist geschützt – nicht übernommen`);
    else if ((CONTACT_FIELDS as readonly string[]).includes(f.name) || f.name === 'name') contactInput[f.name] = asText(val);
    else if (f.name.startsWith('custom.')) contactInput.custom[f.name.slice(7)] = asText(val);
  }
  const utm = Object.fromEntries(Object.entries(raw).filter(([k]) => k.startsWith('_utm_') || k === '_gclid' || k === '_fbclid' || k === '_page' || k === '_ab').map(([k, v]) => [k.slice(1), String(v).slice(0, 500)]));
  // Scoring: the points, the calculators and the ending the score led to.
  const scored = !!(s.variables?.length || s.endings?.length || reached.some((f) => f.points || f.weight || f.type === 'calculator'));
  const shown: Record<string, string> = {};
  if (scored) {
    const hasPoints = s.variables?.some((v: any) => varName(v.name) === 'score') || reached.some((f) => f.points || f.weight);
    if (hasPoints) shown.Punkte = formatValue(values.score ?? 0);
    for (const v of s.variables ?? []) if (varName(v.name) !== 'score') shown[v.name] = formatValue(values[varName(v.name)] ?? 0);
  }
  let payment: Record<string, any> | undefined;
  let payUrl: string | undefined;
  if (pay) {
    const found = pay.product_id && app.services.stripeKey?.(form.location_id) ? app.services.stripeBuy?.resolveProduct(pay.product_id) : undefined;
    if (found && found.p.location_id === form.location_id) {
      const gross = app.services.stripeBuy.grossOf(found.p).gross as number;
      payment = { status: 'pending', product_id: found.p.id, product: found.p.name, amount_cents: gross, currency: found.p.currency };
      answers[label(pay)] = `${found.p.name} – ${centsToMoney(gross, found.p.currency)} (Zahlung offen)`;
    } else answers[label(pay)] = 'Zahlung nicht eingerichtet';
  }
  let contactId: string | null = null;
  let mapped: { dealHandled?: boolean; [k: string]: unknown } | undefined;
  const tags = [...(s.tags ?? []), ...(ending?.tag ? [ending.tag] : [])];
  if (contactInput.email || contactInput.phone || contactInput.first_name || contactInput.name) {
    // Public input: never changes a stored e-mail address or phone number (services/contacts.ts).
    const { contact } = upsertContact(app, form.location_id, contactInput, { source: `Formular: ${form.name}`, tags, publicInput: true });
    contactId = contact.id;
    logActivity(app, form.location_id, contact.id, 'form.submitted', `Formular „${form.name}“ ausgefüllt`, { answers });
    mapped = app.services.formMapping?.apply(form, plan, contact.id);
    if (s.pipeline_id && !mapped?.dealHandled) {
      try {
        createOpportunity(app, form.location_id, { pipeline_id: s.pipeline_id, stage_id: s.stage_id, contact_id: contact.id, source: `Formular: ${form.name}` });
      } catch (e) {
        console.warn('[forms] opportunity:', (e as Error).message);
      }
    }
  }
  const dur = Number(raw._dur);
  const submissionMeta: Record<string, any> = { ...utm, ip: meta.ip ?? '' };
  if (scored) submissionMeta.score = { values: Object.fromEntries(Object.entries(values).filter(([k]) => k === 'score' || (s.variables ?? []).some((v: any) => varName(v.name) === k))), ending: ending?.title ?? '' };
  if (payment) submissionMeta.payment = payment;
  if (mapped || refused.length) {
    const { dealHandled: _d, ...rest } = mapped ?? {};
    const errors = [...refused, ...((rest.errors as string[] | undefined) ?? [])];
    submissionMeta.mapping = { ...rest, ...(errors.length ? { errors } : {}) };
    if (refused.length) console.warn(`[forms] ${form.id}:`, refused.join(' | '));
  }
  if (Number.isFinite(dur) && dur > 0) submissionMeta.duration_ms = Math.min(Math.round(dur), 24 * 3600_000);
  const sub = { id: subId, location_id: form.location_id, form_id: form.id, contact_id: contactId, data: answers, meta: submissionMeta, created_at: now() };
  app.db.insert('form_submissions', sub);
  if (payment) {
    const found = app.services.stripeBuy.resolveProduct(payment.product_id);
    const key = app.services.stripeBuy.linkOf(payment.product_id)?.slug || payment.product_id;
    const token = signToken(app, 'fs', { s: subId, l: form.location_id }, 24 * 3600_000);
    const email = contactInput.email ? `&email=${encodeURIComponent(String(contactInput.email))}` : '';
    payUrl = found ? `${app.baseUrl()}/buy/${encodeURIComponent(key)}?fs=${encodeURIComponent(token)}${email}` : undefined;
  }
  if (s.notify_team !== false) {
    void notifyTeam(app, form.location_id, `Neue Anfrage: ${form.name}`, Object.entries(answers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n'), s.notify_email);
  }
  app.events.emit(form.location_id, 'form.submitted', { contactId, formId: form.id, submission: sub, answers });
  if (scored) app.events.emit(form.location_id, 'form.scored', { contactId, formId: form.id, submissionId: subId, values: submissionMeta.score?.values ?? {}, ending: ending ? { title: ending.title, tag: ending.tag ?? '' } : null });
  const result = ending || s.show_result ? { title: ending?.title || 'Dein Ergebnis', text: interpolate(ending?.text ?? '', values), redirect_url: ending?.redirect_url ?? '', ...(s.show_result && Object.keys(shown).length ? { values: shown } : {}) } : undefined;
  return { ok: true as const, id: sub.id, contactId, ...(result ? { result } : {}), ...(payUrl ? { pay_url: payUrl } : {}) };
}

export function submitForm(app: App, form: any, raw: Record<string, any>, meta: { ip?: string } = {}) {
  if (raw._hp) return { ok: true as const, spam: true as const };
  return storeSubmission(app, planSubmission(form, raw), meta);
}

export const formsModule: Module = {
  name: 'forms',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE forms (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'form', fields TEXT NOT NULL DEFAULT '[]',
        settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE form_submissions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        data TEXT NOT NULL DEFAULT '{}', meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX form_submissions_form ON form_submissions(form_id, created_at);
      `,
    ],
    [
      '002-files',
      `CREATE TABLE form_files (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, form_id TEXT NOT NULL,
        submission_id TEXT NOT NULL, field TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    // Form uploads (up to 5 MB per file) are larger than the 1 MB public default.
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && /^\/api\/public\/forms\/[^/]+\/submit$/.test(p), bytes: 12 * 1024 * 1024 }];
    const { db, router } = app;
    const productOk = (loc: string) => (pid: string) => !!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', pid, loc);
    const withUrls = (f: any) => ({
      ...f,
      url: `${app.baseUrl()}/f/${f.id}`,
      embed: `<iframe src="${app.baseUrl()}/f/${f.id}?embed=1" style="width:100%;border:0;min-height:520px" id="pghl-${f.id}"></iframe><script>addEventListener('message',e=>{if(e.data&&e.data.pghlHeight){document.getElementById('pghl-${f.id}').style.height=e.data.pghlHeight+'px'}})</script>`,
      theme: themeOf(f.settings),
      theme_warnings: contrastWarnings(themeOf(f.settings)),
    });
    const mapInto = (loc: string, settings: Record<string, any>, fields: FormField[], lenient: boolean) => {
      const m = app.services.formMapping?.clean(loc, settings.mapping, fields, { lenient, legacyPipeline: settings.pipeline_id, legacyStage: settings.stage_id });
      if (m) settings.mapping = m;
      else delete settings.mapping;
    };
    const modeOf = (settings: any) => (settings?.mode === 'typeform' ? 'typeform' : 'classic');

    router.get('/api/forms', 'location', (ctx) =>
      parseRows(
        db.all(`SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS submissions FROM forms f WHERE f.location_id = ? ORDER BY f.updated_at DESC`, ctx.locationId),
        ['fields', 'settings'],
      ).map(withUrls),
    );
    router.get('/api/forms/:id', 'location', (ctx) => {
      const f = getForm(app, ctx.params.id);
      if (!f || f.location_id !== ctx.locationId) throw notFound();
      return { ...withUrls(f), capabilities: { captcha: !!captchaKeys(app, f.location_id), stripe: !!app.services.stripeKey?.(f.location_id) } };
    });
    router.post('/api/forms', 'location', (ctx) => {
      const settingsIn = { submit_text: 'Absenden', thank_you: 'Danke! Wir melden uns in Kürze.', tags: [], notify_team: true, ...(ctx.body.settings ?? {}) };
      const fields = ctx.body.fields ? cleanFields(ctx.body.fields, { productOk: productOk(ctx.locationId), mode: modeOf(settingsIn) }) : DEFAULT_FIELDS;
      checkContactFields(fields);
      const settings = cleanFormSettings(settingsIn, fields);
      if (settings.theme !== undefined) settings.theme = cleanTheme(settings.theme);
      if (settings.mapping !== undefined) mapInto(ctx.locationId, settings, fields, false);
      const row = {
        id: id(),
        location_id: ctx.locationId,
        name: str(ctx.body.name, 'Name', { required: true, max: 120 }),
        kind: ctx.body.kind === 'survey' ? 'survey' : 'form',
        fields,
        settings,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('forms', row);
      return withUrls(row);
    });
    router.patch('/api/forms/:id', 'location', (ctx) => {
      const f = getForm(app, ctx.params.id);
      if (!f || f.location_id !== ctx.locationId) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true });
      const mergedSettings = ctx.body.settings ? { ...f.settings, ...ctx.body.settings } : f.settings;
      let fields: FormField[] = f.fields;
      if (ctx.body.fields !== undefined) {
        fields = cleanFields(ctx.body.fields, { productOk: productOk(ctx.locationId), mode: modeOf(mergedSettings) });
        checkContactFields(fields);
        patch.fields = fields;
      } else if (ctx.body.settings?.mode !== undefined && modeOf(mergedSettings) !== modeOf(f.settings)) {
        // Switching the layout changes what a jump can reach: check the existing ones again.
        cleanFields(fields, { mode: modeOf(mergedSettings) });
      }
      if (ctx.body.settings) {
        const cleaned = cleanFormSettings(ctx.body.settings, fields);
        if (cleaned.theme !== undefined) cleaned.theme = cleanTheme(cleaned.theme, f.settings.theme);
        patch.settings = { ...f.settings, ...cleaned };
        if (cleaned.captcha?.enabled && !captchaKeys(app, ctx.locationId)) throw bad('Zuerst Turnstile-Schlüssel eintragen (Formulare → Sicherheit)');
      } else if (patch.fields && (f.settings.variables || f.settings.endings)) {
        cleanFormSettings({ variables: f.settings.variables, endings: f.settings.endings }, fields);
      }
      // Company/deal/object mapping: checked when sent; when only the fields changed, entries of removed fields are dropped.
      const mappingSent = !!ctx.body.settings && 'mapping' in ctx.body.settings;
      if ((patch.settings || patch.fields) && (mappingSent || f.settings.mapping)) {
        patch.settings = { ...(patch.settings ?? f.settings) };
        mapInto(ctx.locationId, patch.settings, fields, !mappingSent);
      }
      db.update('forms', f.id, patch);
      return { ...withUrls(getForm(app, f.id)), capabilities: { captcha: !!captchaKeys(app, f.location_id), stripe: !!app.services.stripeKey?.(f.location_id) } };
    });
    router.delete('/api/forms/:id', 'location', (ctx) => {
      db.run('DELETE FROM forms WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
    router.get('/api/forms/:id/submissions', 'location', (ctx) =>
      parseRows(
        db.all(
          `SELECT s.*, c.first_name, c.last_name, c.email FROM form_submissions s LEFT JOIN contacts c ON c.id = s.contact_id
           WHERE s.form_id = ? AND s.location_id = ? ORDER BY s.created_at DESC LIMIT 1000`,
          ctx.params.id,
          ctx.locationId,
        ),
        ['data', 'meta'],
      ),
    );

    // Uploaded files stay private: only team members of the sub-account can open them.
    router.get('/api/form-files/:id', 'location', (ctx) => {
      const row = db.get('SELECT * FROM form_files WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      const path = row && storedFile(app, row as any);
      if (!row || !path || !existsSync(path)) throw notFound();
      const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(row.mime);
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': row.mime,
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${row.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          'cache-control': 'private, max-age=3600',
        },
        body: readFileSync(path),
      };
    });

    router.get('/f/:id', 'public', (ctx) => {
      const f = getForm(app, ctx.params.id);
      if (!f) return html(messagePage('Nicht gefunden', 'Dieses Formular gibt es nicht.'), 404);
      const embed = ctx.query.get('embed') === '1';
      const s = f.settings ?? {};
      const theme = themeOf(s);
      const tf = s.mode === 'typeform';
      const vars = `${themeVars(theme)};font-family:${FONTS[theme.font]?.stack ?? FONTS.system.stack}`;
      const form = renderForm(f, { standalone: !embed });
      const body = tf
        ? `${form}${embed ? RESIZE_SCRIPT : ''}`
        : `<div class="wrap"><div class="card" style="${escapeHtml(vars)};background:var(--pf-card);color:var(--pf-text);border-radius:var(--pf-radius);border-color:var(--pf-line)">${s.title ? `<h1>${escapeHtml(s.title)}</h1>` : ''}${s.description ? `<p style="color:var(--pf-muted)">${escapeHtml(s.description)}</p>` : ''}${form}</div></div>${embed ? RESIZE_SCRIPT : ''}`;
      const head = `${pageStyle(s)}<style>body{font-family:${FONTS[theme.font]?.stack ?? FONTS.system.stack};color:${theme.text}}</style>`;
      return html(publicPage({ title: s.title || f.name, body, head, color: theme.color, embed }));
    });
    router.post('/api/public/forms/:id/submit', 'public', async (ctx) => {
      if (rateLimited(ctx.ip)) throw new HttpError(429, 'Zu viele Anfragen');
      const f = getForm(app, ctx.params.id);
      if (!f) throw notFound();
      const raw = ctx.body ?? {};
      let res;
      if (raw._hp) res = { ok: true, spam: true };
      else {
        // Check everything first, then the captcha (its token can be used once), then write.
        const plan = planSubmission(f, raw);
        const keys = f.settings?.captcha?.enabled ? captchaKeys(app, f.location_id) : null;
        if (keys) await verifyTurnstile(app, keys.secret, raw._ts, ctx.ip);
        res = storeSubmission(app, plan, { ip: ctx.ip });
      }
      // Where the lead came from (visit token, UTM of the page): attribution module, if present.
      if ('contactId' in res && res.contactId) app.services.attribution?.capture(ctx, f.location_id, res.contactId, 'form', { attr: ctx.body?._attr, page: ctx.body?._page, referrer: ctx.body?._referrer, params: ctx.body });
      // Forms that collect an opt-in (settings.consent): the yes, its text version and proof data go into the consent ledger (modules/consent-capture.ts).
      if ('contactId' in res && res.contactId) app.services.consent?.captureForm?.(ctx, f, res);
      return res;
    });
  },
};
