import { createHash } from 'node:crypto';
import type { Account, Batch, CountRow, PartKey, RContact, RCourse, REnrollment, RLesson, RModule, RProduct, SourceDef, SourceField, StepCtx, StepDef } from './umzug-core.js';
import { UmzugError, VendorHttp } from './umzug-http.js';
import { stripHtml, toIso } from './umzug-text.js';

/**
 * Teachable (public API v1, https://developers.teachable.com/v1, header `apiKey`): students → contacts,
 * courses with sections and lectures (text, video links, file hints) → courses, enrolments with progress,
 * pricing plans → products. Video files are not copied – only links the API gives (Teachable hosts them).
 */

const BASE = 'https://developers.teachable.com/v1';
const PER = 100;

const http = (creds: Record<string, string>, _meta: Record<string, string>, deps: { fetch?: any; sleep?: any; pauseMs?: number }) =>
  new VendorHttp({ vendor: 'Teachable', base: BASE, headers: () => ({ apikey: creds.api_key ?? '' }), fetch: deps.fetch, sleep: deps.sleep, pauseMs: deps.pauseMs ?? 250, errorText: (b) => b?.error ?? b?.message });

/** page/per pagination; `meta.number_of_pages` or a full page decides if there is more. */
async function* pages(h: VendorHttp, path: string, key: string, ctx: StepCtx, start = 1, query: Record<string, unknown> = {}): AsyncGenerator<{ items: any[]; next: number | undefined; total: number }> {
  for (let page = start; ; page++) {
    if (ctx.cancelled()) return;
    const j = await h.get(path, { page, per: PER, ...query });
    const items: any[] = j[key] ?? [];
    const pagesTotal = Number(j.meta?.number_of_pages ?? 0);
    const next = items.length && (pagesTotal ? page < pagesTotal : items.length === PER) ? page + 1 : undefined;
    yield { items, next, total: Number(j.meta?.total ?? 0) };
    if (next === undefined) return;
  }
}
async function everything(h: VendorHttp, path: string, key: string, ctx: StepCtx, query: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for await (const pg of pages(h, path, key, ctx, 1, query)) out.push(...pg.items);
  return out;
}
const stub = (h: VendorHttp, parts: PartKey[]): StepCtx => ({ http: h, creds: {}, meta: {}, cursor: undefined, cancelled: () => false, warn: () => undefined, limit: Infinity, options: { merge: 'fill' }, parts });

async function describe(h: VendorHttp, parts: PartKey[]) {
  const counts: CountRow[] = [];
  const fields: SourceField[] = [];
  const total = async (part: PartKey, key: string, label: string, path: string, k: string) => {
    try {
      const j = await h.get(path, { page: 1, per: 1 });
      counts.push({ part, key, label, total: Number(j.meta?.total ?? (j[k] ?? []).length) });
    } catch (e) {
      counts.push({ part, key, label, total: null, error: (e as Error).message });
      if (e instanceof UmzugError && e.fatal) throw e;
    }
  };
  if (parts.includes('contacts')) {
    await total('contacts', 'users', 'Teilnehmer', '/users', 'users');
    fields.push({ ref: 'email', label: 'E-Mail', type: 'email', std: 'email', group: 'standard' }, { ref: 'first_name', label: 'Vorname', type: 'text', std: 'first_name', group: 'standard' }, { ref: 'last_name', label: 'Nachname', type: 'text', std: 'last_name', group: 'standard' }, { ref: 'role', label: 'Rolle', type: 'text', preset: '', group: 'custom' }, { ref: 'src', label: 'Anmelde-Quelle', type: 'text', std: 'source', group: 'standard' });
  }
  if (parts.includes('courses')) await total('courses', 'courses', 'Kurse', '/courses', 'courses');
  if (parts.includes('products')) await total('products', 'pricing_plans', 'Preispläne', '/pricing_plans', 'pricing_plans');
  if (parts.includes('students')) counts.push({ part: 'students', key: 'enrollments', label: 'Einschreibungen (je Kurs gezählt)', total: null });
  return { counts, fields, warnings: [] as string[] };
}

const nameParts = (n: unknown) => {
  const p = String(n ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: p[0], last: p.length > 1 ? p.slice(1).join(' ') : undefined };
};

/** Text, video link and downloads of one lecture → lesson fields. */
export function lectureLesson(l: any, attachments: any[]): RLesson {
  const parts: string[] = [];
  let video: string | undefined;
  for (const a of attachments) {
    const kind = String(a.kind ?? a.type ?? '').toLowerCase();
    const url = a.url ?? a.file_url ?? a.embed_url;
    if (/video/.test(kind) && !video && typeof url === 'string' && /^https?:\/\//i.test(url)) video = url;
    else if (/text|rich|html/.test(kind)) parts.push(String(a.text ?? a.body ?? a.content ?? ''));
    else if (/pdf|file|image|audio|download|code/.test(kind) && typeof url === 'string') parts.push(`[${a.name ?? 'Datei'}](${url})`);
    else if (/quiz/.test(kind)) parts.push(`*Quiz „${a.name ?? 'Quiz'}“ – in Teachable angelegt, Fragen bitte neu erstellen.*`);
    else if (/video/.test(kind)) parts.push(`*Video „${a.name ?? 'Video'}“ liegt bei Teachable – Link bitte ergänzen.*`);
  }
  return { ext: `l:${l.id}`, title: String(l.name ?? `Lektion ${l.id}`), video_url: video, body: parts.filter(Boolean).join('\n\n'), published: l.is_published !== false };
}

const steps = (): StepDef[] => [
  {
    id: 'contacts',
    label: 'Teilnehmer',
    part: 'contacts',
    async *run(ctx): AsyncGenerator<Batch> {
      for await (const pg of pages(ctx.http, '/users', 'users', ctx, Number(ctx.cursor ?? 1))) {
        const records: RContact[] = pg.items.map((u) => {
          const n = nameParts(u.name);
          return { kind: 'contact', ext: `u:${u.id}`, values: { email: u.email, first_name: n.first, last_name: n.last, role: u.role, src: u.src ? `Teachable (${u.src})` : undefined }, created_at: toIso(u.created_at ?? u.signed_up_at), consent: 'unknown' };
        });
        yield { records, cursor: pg.next, total: pg.total };
      }
    },
  },
  {
    id: 'courses',
    label: 'Kurse und Lektionen',
    part: 'courses',
    async *run(ctx): AsyncGenerator<Batch> {
      const list = await everything(ctx.http, '/courses', 'courses', ctx);
      for (let i = Number(ctx.cursor ?? 0); i < list.length; i++) {
        const c = list[i];
        const detail = (await ctx.http.get(`/courses/${c.id}`)).course ?? c;
        const modules: RModule[] = [];
        for (const s of detail.lecture_sections ?? []) {
          const lessons: RLesson[] = [];
          for (const l of s.lectures ?? []) {
            let attachments: any[] = [];
            let lecture: any = l;
            try {
              lecture = (await ctx.http.get(`/courses/${c.id}/lectures/${l.id}`)).lecture ?? l;
              attachments = lecture.attachments ?? [];
            } catch (e) {
              if (!(e instanceof UmzugError && e.skippable)) throw e;
              ctx.warn(`Lektion ${l.id} in „${c.name}“ nicht lesbar: ${e.message}`);
            }
            lessons.push(lectureLesson({ ...l, ...lecture }, attachments));
          }
          modules.push({ ext: `s:${s.id}`, title: String(s.name ?? `Abschnitt ${s.id}`), lessons });
        }
        const rec: RCourse = { kind: 'course', ext: `c:${c.id}`, title: String(detail.name ?? c.name ?? `Kurs ${c.id}`), description: stripHtml([detail.heading, detail.description].filter(Boolean).join('\n\n')), cover: detail.image_url ?? c.image_url, modules };
        yield { records: [rec], cursor: i + 1 < list.length ? i + 1 : undefined, total: list.length };
      }
    },
  },
  {
    id: 'pricing',
    label: 'Preispläne → Produkte',
    part: 'products',
    async *run(ctx): AsyncGenerator<Batch> {
      const plans = await everything(ctx.http, '/pricing_plans', 'pricing_plans', ctx);
      const records: RProduct[] = plans.map((p) => {
        const type = String(p.billing_type ?? p.plan_type ?? p.type ?? '');
        const recurring = /subscription|recurring/i.test(type);
        if (/payment_?plan|installment/i.test(type)) ctx.warn(`Preisplan „${p.name}“ ist ein Zahlungsplan – als Einmalpreis übernommen, Raten bitte prüfen`);
        return { kind: 'product', ext: `pp:${p.id}`, name: String(p.name ?? `Preisplan ${p.id}`), price_cents: Math.round(Number(p.price ?? 0)), currency: p.currency ? String(p.currency).toUpperCase() : undefined, recurring: recurring ? { interval: /year|annual/i.test(String(p.interval ?? p.billing_interval ?? '')) ? 'year' : 'month' } : undefined, description: p.course_id ? `Gehört zu Teachable-Kurs ${p.course_id}` : '' };
      });
      yield { records, cursor: undefined };
    },
  },
  {
    id: 'enrollments',
    label: 'Einschreibungen und Fortschritt',
    part: 'students',
    async *run(ctx): AsyncGenerator<Batch> {
      const list = await everything(ctx.http, '/courses', 'courses', ctx);
      const cur = (ctx.cursor ?? { ci: 0, page: 1 }) as { ci: number; page: number };
      let approx = false;
      for (let ci = cur.ci; ci < list.length; ci++) {
        const c = list[ci];
        // Lessons in order, for progress: done lessons are the first n by the student's percentage when only that is known.
        const detail = (await ctx.http.get(`/courses/${c.id}`)).course ?? c;
        const lectureIds: string[] = (detail.lecture_sections ?? []).flatMap((s: any) => (s.lectures ?? []).map((l: any) => `l:${l.id}`));
        for await (const pg of pages(ctx.http, `/courses/${c.id}/enrollments`, 'enrollments', ctx, ci === cur.ci ? cur.page : 1)) {
          const records: REnrollment[] = pg.items.map((e) => {
            const pct = Math.max(0, Math.min(100, Number(e.percent_complete ?? 0)));
            const n = Math.floor((pct / 100) * lectureIds.length);
            if (n > 0 && pct < 100) approx = true;
            return { kind: 'enrollment', ext: `${c.id}:${e.user_id}`, course: `c:${c.id}`, contact: `u:${e.user_id}`, enrolled_at: toIso(e.enrolled_at), completed_at: toIso(e.completed_at), lessons_done: pct >= 100 || e.completed_at ? lectureIds : lectureIds.slice(0, n) };
          });
          yield { records, cursor: pg.next ? { ci, page: pg.next } : ci + 1 < list.length ? { ci: ci + 1, page: 1 } : undefined, total: pg.total };
        }
      }
      if (approx) ctx.warn('Fortschritt: Teachable nennt den Fortschritt in Prozent – HyperLevel zählt erledigte Lektionen; es wurden die ersten n Lektionen als erledigt markiert (Näherung).');
    },
  },
];

export const TEACHABLE: SourceDef = {
  key: 'teachable',
  label: 'Teachable',
  tagline: 'Teilnehmer, Kurse mit Abschnitten und Lektionen, Preispläne, Einschreibungen mit Fortschritt',
  credentials: [
    { key: 'api_key', label: 'API-Schlüssel', secret: true, hint: 'Teachable → Einstellungen → „Public API“ (Pro-Tarif oder höher)' },
    { key: 'school', label: 'Schul-Adresse (optional)', optional: true, placeholder: 'meineschule.teachable.com', hint: 'Damit bleibt die Zuordnung bestehen, falls du den Schlüssel später wechselst.' },
  ],
  howto: ['In Teachable: Einstellungen → „Public API“ (steht im Pro-Tarif und höher zur Verfügung).', 'Den API-Schlüssel erzeugen und hier einfügen.', 'Videos selbst liegen bei Teachable und werden nicht kopiert – übernommen werden Texte, Links und Hinweise auf Dateien und Quiz.'],
  limits: ['Videodateien (liegen bei Teachable – übernommen werden nur Links und Hinweise)','Quizze, Zertifikate und Kommentare','Kurs-Design und Seiten','Zahlungen und laufende Abos'],
  parts: [
    { key: 'contacts', label: 'Teilnehmer → Kontakte', on: true },
    { key: 'courses', label: 'Kurse mit Abschnitten und Lektionen (als Entwurf)', on: true, note: 'Texte und Videolinks, soweit die API sie liefert. Videodateien werden nicht kopiert.' },
    { key: 'products', label: 'Preispläne → Produkte', on: true },
    { key: 'students', label: 'Einschreibungen mit Fortschritt', on: true, note: 'Der Fortschritt kommt als Prozentwert – daraus werden die ersten Lektionen als erledigt markiert (Näherung).' },
  ],
  exports: [
    { key: 'contacts', label: 'Teilnehmer-Export (CSV)', accept: ['.csv'], describe: 'Users → Export.', part: 'contacts' },
    { key: 'courses', label: 'Kursstruktur (CSV/JSON)', accept: ['.csv', '.json'], describe: 'Wenn du die API nicht nutzen kannst: Kursaufbau als Datei (course, module, lesson, video_url, text).', part: 'courses' },
    { key: 'students', label: 'Einschreibungen (CSV)', accept: ['.csv'], describe: 'Pro Kurs: Students → Export (E-Mail, Datum, Fortschritt).', part: 'students' },
  ],
  http,
  async connect(creds, deps): Promise<Account> {
    const h = http(creds, {}, deps);
    await h.get('/courses', { page: 1, per: 1 });
    const key = String(creds.school ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const account = /^[a-z0-9.-]{3,80}$/.test(key) ? key : `key-${createHash('sha256').update(String(creds.api_key ?? '')).digest('hex').slice(0, 10)}`;
    return { account, label: key || 'Teachable-Schule', meta: {} };
  },
  describe: (h, parts) => describe(h, parts),
  steps: (parts) => steps().filter((s) => parts.includes(s.part)),
};

void stub;
