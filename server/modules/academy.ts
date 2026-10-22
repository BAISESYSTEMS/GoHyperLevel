import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { id, now, sha256, token } from '../core/util.js';
import { createLocation } from './core.js';

/**
 * Akademie: guided in-app tours. The tours themselves live in the web app (web/src/tour/*);
 * the server keeps each user's progress (step, furthest step, done), the tour that was running
 * when the page was left (so a reload resumes it) and the agency's practice sub-account
 * ("Übungs-Firma") with demo data, so nobody practises on real customers.
 */

const TOUR_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const SANDBOX_NAME = 'Übungs-Firma (Akademie)';

function tourId(v: unknown): string {
  const s = String(v ?? '');
  if (!TOUR_ID.test(s)) throw bad('Unbekannte Tour');
  return s;
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field} ungültig`);
  return n;
}

function progressOut(r: any) {
  return { step: r.step, max_step: r.max_step, total: r.total, done: !!r.done, started_at: r.started_at, updated_at: r.updated_at, completed_at: r.completed_at ?? null };
}

/** The practice sub-account, if it (still) exists. */
export function sandboxOf(app: App): { id: string; name: string } | null {
  const row = app.db.get<{ value: string }>(`SELECT value FROM academy_meta WHERE key = 'sandbox'`);
  if (!row) return null;
  const loc = app.db.get<{ id: string; name: string }>('SELECT id, name FROM locations WHERE id = ?', row.value);
  if (!loc) {
    app.db.run(`DELETE FROM academy_meta WHERE key = 'sandbox'`);
    return null;
  }
  return loc;
}

/** Docs a member (client login) may read; the agency reads all of docs/ (they include server details). */
const MEMBER_DOCS = ['academy', 'handbuch', 'app', 'ios-web-app', 'email-builder', 'email-marketing', 'growth', 'ai-assistant', 'meta-channels', 'stripe', 'helpdesk', 'reports', 'objects', 'integrations', 'genmedia', 'canvas', 'backoffice', 'mailbox-sync', 'wiki', 'team-chat', 'werkstatt', 'README'];

/** The repository's docs folder: next to the working directory (Docker, Hostinger) or the source. */
function docsDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(process.cwd(), 'docs'), resolve(here, '../../docs'), resolve(here, '../../../docs')];
  return candidates.find((d) => existsSync(join(d, 'academy.md')) || existsSync(join(d, 'api.md')));
}

function docFile(name: string): string | undefined {
  const dir = docsDir();
  if (!dir || !/^[A-Za-z0-9-]{1,60}$/.test(name)) return undefined;
  // The UI is German: prefer the German README (README.de.md) next to the English one.
  const readme = [resolve(dir, '..', 'README.de.md'), resolve(dir, '..', 'README.md')].find((f) => existsSync(f)) ?? resolve(dir, '..', 'README.md');
  const file = name === 'README' ? readme : join(dir, `${name}.md`);
  return existsSync(file) ? file : undefined;
}

const day = (offset: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

/**
 * Fills the practice sub-account through its own REST API (in-process, with a throw-away API key),
 * so the demo data always matches what the real screens create. Every part is optional: one failing
 * call never stops the rest. Nothing leaves the server – e-mail and SMS stay on "nur speichern".
 */
export async function seedSandbox(app: App, locationId: string): Promise<number> {
  const key = `pghl_${token(24)}`;
  const keyId = id();
  app.db.insert('api_keys', { id: keyId, location_id: locationId, name: 'Akademie (Demo-Daten)', key_hash: sha256(key), prefix: key.slice(0, 10), created_at: now() });
  let ok = 0;
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    try {
      const r = await fetch(app.selfUrl + path, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return undefined;
      ok++;
      return await r.json().catch(() => ({}));
    } catch {
      return undefined;
    }
  };
  try {
    await call('PUT', '/api/project', { status: 'idee', category: 'Übung', tagline: 'Spielwiese der Akademie – keine echten Kunden, alles darf ausprobiert werden.', description: 'Diese Firma hat die Akademie angelegt. Alle Kontakte, Deals und Rechnungen sind erfunden (…@example.com). E-Mails und SMS werden hier nur gespeichert, nie verschickt. Du kannst sie in der Akademie jederzeit wieder löschen.' });
    const people = [
      ['Anna', 'Beispiel', 'Bäckerei Beispiel', ['Neukunde', 'VIP'], 'Website'],
      ['Ben', 'Muster', 'Muster & Söhne GmbH', ['Interessent'], 'Empfehlung'],
      ['Clara', 'Probe', 'Probe Design', ['Interessent'], 'Google'],
      ['David', 'Test', '', ['Neukunde'], 'Instagram'],
      ['Eva', 'Demo', 'Demo Immobilien', ['Interessent', 'Newsletter'], 'Formular'],
      ['Felix', 'Übung', 'Übung Handwerk', ['Newsletter'], 'Messe'],
      ['Greta', 'Fiktiv', 'Fiktiv Coaching', ['VIP'], 'Empfehlung'],
      ['Hannes', 'Platzhalter', '', ['Interessent'], 'Live-Chat'],
    ] as const;
    const contacts: any[] = [];
    for (const [i, [first, last, company, tags, source]] of people.entries()) {
      const c = await call('POST', '/api/contacts', {
        first_name: first,
        last_name: last,
        email: `${first.toLowerCase().replace('ü', 'ue')}.${last.toLowerCase().replace('ü', 'ue')}@example.com`,
        phone: `+49 151 0000 00${String(i + 10)}`,
        company,
        tags: [...tags],
        source,
      });
      if (c?.id) contacts.push(c);
    }
    const [anna, ben, clara, david, eva] = contacts;
    if (anna) await call('POST', `/api/contacts/${anna.id}/notes`, { body: 'Möchte im Frühjahr eine neue Website. Ruft am liebsten vormittags an. (Übungsnotiz)' });

    const pipelines = await call('GET', '/api/pipelines');
    const pipe = Array.isArray(pipelines) ? pipelines[0] : undefined;
    if (pipe) {
      const deals = [
        [ben, 'Website-Relaunch', 480000, 1],
        [clara, 'Logo + Visitenkarten', 90000, 2],
        [eva, 'Social-Media-Betreuung (12 Monate)', 360000, 3],
        [anna, 'Online-Shop', 650000, 0],
      ] as const;
      for (const [c, name, cents, stage] of deals) {
        if (!c) continue;
        await call('POST', '/api/opportunities', { contact_id: c.id, pipeline_id: pipe.id, stage_id: pipe.stages[Math.min(stage, pipe.stages.length - 1)]?.id, name, value: cents / 100 });
      }
    }
    await call('POST', '/api/tasks', { title: 'Angebot an Ben Muster schicken', contact_id: ben?.id, due_at: day(-1) });
    await call('POST', '/api/tasks', { title: 'Clara wegen Logo-Entwürfen anrufen', contact_id: clara?.id, due_at: day(0, 15) });
    await call('POST', '/api/tasks', { title: 'Newsletter für nächsten Monat vorbereiten', due_at: day(6) });

    const cal = await call('POST', '/api/calendars', { name: 'Erstgespräch (Übung)', duration: 30, description: 'Kostenloses Kennenlernen – 30 Minuten per Telefon oder Video.' });
    if (cal?.id && anna) await call('POST', '/api/appointments', { calendar_id: cal.id, contact_id: anna.id, start: day(2, 10), notes: 'Übungstermin', force: true });

    await call('POST', '/api/forms', { name: 'Kontaktformular (Übung)' });
    await call('POST', '/api/funnels', { name: 'Übungs-Website', kind: 'website' });

    const product = await call('POST', '/api/products', { name: 'Beratungspaket', description: '3 Stunden Beratung inkl. Protokoll', price_cents: 49000, tax_rate: 19 });
    await call('POST', '/api/products', { name: 'Website-Check', description: 'Kurzer Check von Technik, Texten und SEO', price_cents: 9900, tax_rate: 19 });
    if (ben) await call('POST', '/api/invoices', { contact_id: ben.id, title: 'Beratung (Übung)', items: [{ name: product?.name ?? 'Beratungspaket', qty: 1, price_cents: 49000, tax_rate: 19 }] });

    await call('POST', '/api/courses', { title: 'Kundenschulung (Übung)' });
    await call('POST', '/api/community/groups', { name: 'Übungs-Community', description: 'Zum Ausprobieren – hier schreibt niemand Echtes.' });
    await call('POST', '/api/contracts', { kind: 'template', title: 'Dienstleistungsvertrag (Übung)', content: '# Dienstleistungsvertrag\n\nZwischen {{location.name}} und {{contact.first_name}} {{contact.last_name}}.\n\n## Leistung\nBeratung wie besprochen.\n\nOrt, Datum: ________________' });
    await call('POST', '/api/campaigns', { name: 'Newsletter Herbst (Übung)', channel: 'email', subject: 'Neuigkeiten aus der Übungs-Firma', body: 'Hallo {{contact.first_name|du}},\n\nhier sind unsere Neuigkeiten …', filter: { tags: ['Newsletter'] } });
    await call('POST', '/api/workflows', { name: 'Willkommens-Strecke (Übung)', trigger: { type: 'contact.tag_added', config: { tag: 'Neukunde' } }, steps: [] });
    if (david) await call('POST', '/api/messages', { contact_id: david.id, channel: 'email', subject: 'Willkommen!', body: 'Hallo David, schön, dass du da bist. (Übungsnachricht – wird nicht verschickt.)' });

    // Service: two tickets and a help article (the companies come from the contacts' „Firma“ field).
    if (anna) await call('POST', '/api/tickets', { subject: 'Rechnung nicht angekommen (Übung)', description: 'Hallo, die letzte Rechnung ist bei mir nicht angekommen. Können Sie sie noch einmal schicken?', contact_id: anna.id, priority: 'hoch' });
    if (clara) await call('POST', '/api/tickets', { subject: 'Frage zu den Logo-Entwürfen (Übung)', description: 'Kann ich die Entwürfe auch als PDF bekommen?', contact_id: clara.id });
    const kbCat = await call('POST', '/api/kb/categories', { name: 'Erste Schritte (Übung)', description: 'Antworten auf die häufigsten Fragen.' });
    await call('POST', '/api/kb/articles', {
      title: 'So buchst du einen Termin (Übung)',
      category_id: kbCat?.id,
      status: 'published',
      tags: ['Termin', 'Buchung'],
      body: '## Termin buchen\n\n1. Öffne unsere Buchungsseite.\n2. Wähle einen freien Termin.\n3. Trag Name und E-Mail ein – fertig.\n\n> Du bekommst sofort eine Bestätigung per E-Mail.',
    });

    // Companies, custom objects & lead scoring.
    await call('POST', '/api/association-labels', { a_type: 'contact', b_type: 'company', name: 'Entscheider' });
    await call('POST', '/api/association-labels', { a_type: 'contact', b_type: 'company', name: 'Rechnungsempfänger' });
    const projects = await call('POST', '/api/object-types', {
      singular: 'Projekt',
      plural: 'Projekte',
      description: 'Kundenprojekte (Übung)',
      properties: [
        { label: 'Status', type: 'select', options: ['Angebot', 'Läuft', 'Fertig'] },
        { label: 'Budget', type: 'number' },
      ],
    });
    if (projects?.key) {
      if (ben) await call('POST', `/api/objects/${projects.key}/records`, { properties: { name: 'Website-Relaunch Muster', status: 'Läuft', budget: 4800 }, associations: [{ type: 'contact', id: ben.id }] });
      if (eva) await call('POST', `/api/objects/${projects.key}/records`, { properties: { name: 'Social Media Demo Immobilien', status: 'Angebot', budget: 3600 }, associations: [{ type: 'contact', id: eva.id }] });
    }
    await call('POST', '/api/lead-scoring/models', {
      name: 'Lead-Score (Übung)',
      rules: [
        { kind: 'property', field: 'tag', op: 'has', value: 'VIP', points: 40 },
        { kind: 'property', field: 'tag', op: 'has', value: 'Interessent', points: 20 },
        { kind: 'property', field: 'source', op: 'equals', value: 'Empfehlung', points: 20 },
        { kind: 'event', event: 'form.submitted', points: 10, max_points: 30 },
        { kind: 'event', event: 'email.clicked', points: 5, max_points: 25 },
        { kind: 'event', event: 'appointment.booked', points: 25 },
        { kind: 'property', field: 'email', op: 'contains', value: 'gmail', points: -5 },
      ],
      decay: { percent: 10, days: 30 },
      max_score: 100,
    });
  } finally {
    app.db.run('DELETE FROM api_keys WHERE id = ?', keyId);
  }
  return ok;
}

export const academyModule: Module = {
  name: 'academy',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE academy_progress (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tour_id TEXT NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        max_step INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (user_id, tour_id)
      );
      CREATE TABLE academy_state (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        tour_id TEXT,
        step INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE academy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `,
    ],
    [
      // „Service & Support“ became chapter 10 of the journey; the later chapters moved up by one.
      '002-journey-service-chapter',
      `
      UPDATE academy_progress SET tour_id = 'journey-14-checklist' WHERE tour_id = 'journey-13-checklist';
      UPDATE academy_progress SET tour_id = 'journey-13-operations' WHERE tour_id = 'journey-12-operations';
      UPDATE academy_progress SET tour_id = 'journey-12-settings' WHERE tour_id = 'journey-11-settings';
      UPDATE academy_progress SET tour_id = 'journey-11-ai' WHERE tour_id = 'journey-10-ai';
      UPDATE academy_state SET tour_id = 'journey-14-checklist' WHERE tour_id = 'journey-13-checklist';
      UPDATE academy_state SET tour_id = 'journey-13-operations' WHERE tour_id = 'journey-12-operations';
      UPDATE academy_state SET tour_id = 'journey-12-settings' WHERE tour_id = 'journey-11-settings';
      UPDATE academy_state SET tour_id = 'journey-11-ai' WHERE tour_id = 'journey-10-ai';
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const user = (ctx: Ctx) => {
      if (!ctx.user) throw new HttpError(401, 'Nicht angemeldet');
      return ctx.user;
    };
    const overview = (ctx: Ctx) => {
      const u = user(ctx);
      const tours: Record<string, ReturnType<typeof progressOut>> = {};
      for (const r of db.all('SELECT * FROM academy_progress WHERE user_id = ?', u.id)) tours[r.tour_id] = progressOut(r);
      const st = db.get('SELECT tour_id, step FROM academy_state WHERE user_id = ?', u.id);
      const sb = sandboxOf(app);
      const mine = sb && (u.role === 'admin' || u.locations.includes(sb.id)) ? sb : null;
      return { tours, active: st?.tour_id ? { tour: st.tour_id, step: st.step } : null, sandbox: mine, can_sandbox: u.role === 'admin' };
    };

    router.get('/api/academy', 'user', overview);

    /** Saves where the user is in a tour; `active` marks it as the one running (resumed after a reload). */
    router.put('/api/academy/tours/:id', 'user', (ctx) => {
      const u = user(ctx);
      const tid = tourId(ctx.params.id);
      const b = ctx.body ?? {};
      const total = int(b.total, 'Schrittzahl', 1, 999);
      const step = int(b.step ?? 0, 'Schritt', 0, total);
      const done = b.done === true;
      const cur = db.get('SELECT * FROM academy_progress WHERE user_id = ? AND tour_id = ?', u.id, tid);
      const t = now();
      if (!cur) {
        if (db.get<{ n: number }>('SELECT COUNT(*) n FROM academy_progress WHERE user_id = ?', u.id)!.n >= 500) throw bad('Zu viele Touren');
        db.insert('academy_progress', { user_id: u.id, tour_id: tid, step, max_step: step, total, done: done ? 1 : 0, started_at: t, updated_at: t, completed_at: done ? t : null });
      } else {
        db.run(
          'UPDATE academy_progress SET step = ?, max_step = ?, total = ?, done = ?, updated_at = ?, completed_at = ? WHERE user_id = ? AND tour_id = ?',
          step,
          Math.max(cur.max_step, step),
          total,
          cur.done || done ? 1 : 0,
          t,
          cur.completed_at ?? (done ? t : null),
          u.id,
          tid,
        );
      }
      if (b.active === true && !done) db.run('INSERT INTO academy_state (user_id, tour_id, step, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET tour_id = excluded.tour_id, step = excluded.step, updated_at = excluded.updated_at', u.id, tid, step, t);
      else if (b.active === false || done) db.run('UPDATE academy_state SET tour_id = NULL, updated_at = ? WHERE user_id = ? AND tour_id = ?', t, u.id, tid);
      return progressOut(db.get('SELECT * FROM academy_progress WHERE user_id = ? AND tour_id = ?', u.id, tid));
    });

    /** Start a tour over (forget its progress). */
    router.delete('/api/academy/tours/:id', 'user', (ctx) => {
      const u = user(ctx);
      const tid = tourId(ctx.params.id);
      db.run('DELETE FROM academy_progress WHERE user_id = ? AND tour_id = ?', u.id, tid);
      db.run('UPDATE academy_state SET tour_id = NULL, updated_at = ? WHERE user_id = ? AND tour_id = ?', now(), u.id, tid);
      return { ok: true };
    });

    /** No tour running any more (closed with ✕ / Esc). */
    router.delete('/api/academy/active', 'user', (ctx) => {
      db.run('UPDATE academy_state SET tour_id = NULL, updated_at = ? WHERE user_id = ?', now(), user(ctx).id);
      return { ok: true };
    });

    /** Documentation inside the app (linked at the end of every tour). */
    router.get('/api/academy/docs', 'user', (ctx) => {
      const dir = docsDir();
      const names = dir ? ['README', ...readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))] : [];
      return names.filter((n) => user(ctx).role === 'admin' || MEMBER_DOCS.includes(n)).filter((n) => docFile(n));
    });
    router.get('/api/academy/docs/:name', 'user', (ctx) => {
      const name = ctx.params.name;
      if (user(ctx).role !== 'admin' && !MEMBER_DOCS.includes(name)) throw new HttpError(403, 'Diese Anleitung ist nur für die Agentur');
      const file = docFile(name);
      if (!file) throw notFound('Anleitung nicht gefunden');
      const markdown = readFileSync(file, 'utf8');
      return { name, title: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name, markdown };
    });

    router.post('/api/academy/sandbox', 'admin', async (ctx) => {
      const have = sandboxOf(app);
      if (have) return { ...have, created: false };
      const loc = createLocation(db, SANDBOX_NAME, 'Europe/Berlin', { email: 'uebung@example.com', website: '' });
      db.run('INSERT INTO academy_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'sandbox', loc.id);
      const seeded = ctx.body?.demo === false ? 0 : await seedSandbox(app, loc.id);
      return { id: loc.id, name: loc.name, created: true, seeded };
    });

    router.delete('/api/academy/sandbox', 'admin', () => {
      const sb = sandboxOf(app);
      if (!sb) throw notFound('Keine Übungs-Firma vorhanden');
      db.run('DELETE FROM locations WHERE id = ?', sb.id);
      db.run(`DELETE FROM academy_meta WHERE key = 'sandbox'`);
      return { ok: true };
    });
  },
};
