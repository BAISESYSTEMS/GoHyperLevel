import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers';
import { GROUPS, JOURNEY, MODULE_TOURS, TOURS, badges, composeSteps, journeyStatus, resumeIndex, searchTours, stepVisible, tourById, toursForPath, tourTargets, visibleTours, type Access } from '../web/src/tour/catalog';
import { handbookMarkdown } from '../web/src/tour/handbook';
import { slug } from '../web/src/tour/slug';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Every `data-tour` key that exists in the UI code: literal attributes (`data-tour="x"`, the `tour="x"`
 * prop of Link/Field/Stat), quoted keys inside an expression, and the generated ones – `nav-<route>`
 * for the menu, `tab-<key>` for every Tabs entry, `contact-<field>` style keys built from a list.
 */
function uiTargets() {
  const files = walk(WEB).filter((f) => /\.tsx?$/.test(f) && !f.includes(`${join('tour', 'content')}`));
  const literal = new Set<string>();
  const prefixes: { prefix: string; file: string; src: string }[] = [];
  const tabKeys = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:data-tour|\btour)=["']([\w-]+)["']/g)) literal.add(m[1]);
    for (const m of src.matchAll(/(?:data-tour|\btour)=\{([^}]*)\}/g)) {
      for (const q of m[1].matchAll(/'([\w-]+)'/g)) literal.add(q[1]);
      for (const t of m[1].matchAll(/`([\w-]+)\$\{/g)) prefixes.push({ prefix: t[1], file: f, src });
    }
    // Tabs entries are ['key', label] pairs (the label may be an expression).
    if (/<(Tabs|SettingsTabs|AgencyTabs)\b/.test(src)) for (const m of src.matchAll(/\[\s*'([\w-]+)',\s*\S/g)) tabKeys.add(m[1]);
  }
  const main = readFileSync(join(WEB, 'main.tsx'), 'utf8');
  const navRoutes = new Set([...main.matchAll(/\[\s*'([\w-]+)',\s*'[\w]+',\s*'[^']+',\s*'[^']*'\s*\]/g)].map((m) => m[1]));
  const exists = (target: string) => {
    if (literal.has(target)) return true;
    return prefixes.some(({ prefix, src }) => {
      if (!target.startsWith(prefix)) return false;
      const rest = target.slice(prefix.length);
      if (prefix === 'nav-') return navRoutes.has(rest);
      if (prefix === 'tab-') return tabKeys.has(rest);
      return new RegExp(`['"]${rest}['"]`).test(src);
    });
  };
  return { exists, navRoutes, tabKeys, literal };
}

const ADMIN: Access = { admin: true, can: () => true };
const member = (perms: string[]): Access => ({ admin: false, can: (p) => p === '*' || perms.includes(p) });

describe('tour definitions', () => {
  const ui = uiTargets();

  it('have unique, valid ids and enough content', () => {
    const ids = TOURS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOURS) {
      expect(t.id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
      expect(t.title.length).toBeGreaterThan(1);
      expect(t.summary.length).toBeGreaterThan(10);
      expect(t.learned.length, t.id).toBeGreaterThanOrEqual(2);
      expect(t.docs, `${t.id} braucht einen Link zur Anleitung`).toBeTruthy();
      for (const s of t.steps) {
        expect(s.title.length, `${t.id}: ${s.title}`).toBeGreaterThan(2);
        expect(s.text.length, `${t.id}: ${s.title}`).toBeGreaterThan(20);
        expect(s.text.length, `${t.id}: ${s.title} ist zu lang`).toBeLessThan(420);
      }
    }
    expect(GROUPS.map((g) => g.id)).toEqual(expect.arrayContaining([...new Set(MODULE_TOURS.map((t) => t.group))]));
  });

  it('module tours have 5–15 steps, the journey 14 chained chapters', () => {
    for (const t of MODULE_TOURS) {
      expect(t.steps.length, t.id).toBeGreaterThanOrEqual(5);
      expect(t.steps.length, t.id).toBeLessThanOrEqual(15);
    }
    expect(JOURNEY.map((c) => c.chapter)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    JOURNEY.forEach((c, i) => expect(c.next).toBe(JOURNEY[i + 1]?.id));
    expect(JOURNEY.reduce((s, c) => s + c.minutes, 0)).toBeGreaterThan(120);
  });

  it('every step target exists in the code as a data-tour attribute', () => {
    const missing = tourTargets().filter((t) => !ui.exists(t.target));
    expect(missing, JSON.stringify(missing, null, 1)).toEqual([]);
  });

  it('action steps are complete and routes point at real pages', () => {
    // every page main.tsx renders (`case 'contacts':` …) – also the ones without a menu entry, like properties
    const pages = new Set([...readFileSync(join(WEB, 'main.tsx'), 'utf8').matchAll(/case '([\w-]+)':/g)].map((m) => m[1]));
    expect(pages).toContain('contacts');
    for (const t of TOURS)
      for (const s of t.steps) {
        const where = `${t.id}: ${s.title}`;
        if (s.kind === 'click' || s.kind === 'fill') expect(s.target, where).toBeTruthy();
        if (s.kind === 'navigate') expect(s.to, where).toBeTruthy();
        if (s.kind === 'wait') expect(s.wait?.toast || s.wait?.appear || s.wait?.route, where).toBeTruthy();
        if (s.demo) expect(s.target, where).toBeTruthy();
        for (const r of [s.route, s.to].filter(Boolean) as string[]) {
          const [page, sub] = r.split('/');
          expect(pages.has(page), `${where}: Seite ${r}`).toBe(true);
          if (sub && (page === 'settings' || page === 'agency')) expect(ui.tabKeys.has(sub), `${where}: Reiter ${r}`).toBe(true);
        }
      }
  });

  it('docs links point at existing files and headings', () => {
    for (const t of TOURS) {
      // The academy shows the German README (README.de.md) – the UI is German.
      const file = t.docs!.file === 'README' ? join(ROOT, 'README.de.md') : join(ROOT, 'docs', `${t.docs!.file}.md`);
      expect(existsSync(file), `${t.id}: ${file}`).toBe(true);
      if (t.docs!.anchor) {
        const anchors = [...readFileSync(file, 'utf8').matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => slug(m[1]));
        expect(anchors, `${t.id}: #${t.docs!.anchor}`).toContain(t.docs!.anchor);
      }
    }
  });

  it('docs/handbuch.md is the generated handbook (run the generator after changing the journey)', () => {
    const md = readFileSync(join(ROOT, 'docs/handbuch.md'), 'utf8');
    expect(md).toBe(handbookMarkdown('HyperLevel'));
    for (const c of JOURNEY) expect(md).toContain(`## Kapitel ${c.chapter}: ${c.title}`);
  });
});

describe('who sees which tour', () => {
  it('a client login only sees tours of its areas, never agency tours', () => {
    const client = member(['contacts', 'calendars', 'conversations']);
    const list = visibleTours(client, MODULE_TOURS).map((t) => t.id);
    expect(list).toEqual(expect.arrayContaining(['contacts', 'calendars', 'conversations', 'start-basics', 'account-security']));
    for (const id of ['invoices', 'settings-basics', 'stripe', 'agency-overview', 'saas', 'team', 'workflows', 'mcp']) expect(list).not.toContain(id);
    // agency-only chapters of the journey are hidden; steps inside visible chapters are filtered too
    const chapters = visibleTours(client, JOURNEY).map((t) => t.id);
    expect(chapters).not.toContain('journey-13-operations');
    const access = JOURNEY[0].steps.filter((s) => stepVisible(s, client));
    expect(access.some((s) => s.admin)).toBe(false);
    expect(access.length).toBeLessThan(JOURNEY[0].steps.length);
  });

  it('admins see everything; the „?“ button offers the tours of the page', () => {
    expect(visibleTours(ADMIN)).toHaveLength(TOURS.length);
    expect(toursForPath('settings/telephony', ADMIN).map((t) => t.id)).toEqual(expect.arrayContaining(['telephony', 'voice-ai']));
    expect(toursForPath('contacts/abc123', ADMIN)[0].id).toBe('contacts');
    expect(toursForPath('settings/telephony', member(['contacts']))).toEqual([]);
    expect(searchTours(MODULE_TOURS, 'whatsapp').map((t) => t.id)).toContain('channels');
  });

  it('composes the steps a person walks through', () => {
    const contacts = tourById('contacts')!;
    const admin = composeSteps(contacts, ADMIN);
    // practice intro for the agency, „Geschafft“ card at the end
    expect(admin[0].special).toBe('context');
    expect(admin.at(-1)!.special).toBe('outro');
    expect(composeSteps(contacts, member(['contacts']))[0].special).toBeUndefined();
    // a step without route plays on the page of the step before …
    const search = admin.find((s) => s.target === 'contacts-search')!;
    expect(search.route).toBe('contacts');
    // … but not after a click that changed the screen (the modal is open, no reload of the page)
    const first = admin.find((s) => s.target === 'contact-first_name')!;
    expect(first.route).toBeUndefined();
    // resuming inside the modal goes back to the step that opens it
    const at = admin.indexOf(first);
    expect(admin[resumeIndex(admin, at)].target).toBe('contacts-new');
    expect(resumeIndex(admin, 0)).toBe(0);
    // agency-only steps are dropped for members
    const basics = tourById('start-basics')!;
    expect(composeSteps(basics, member(['dashboard'])).some((s) => s.target === 'nav-agency')).toBe(false);
  });

  it('progress turns into journey status and badges', () => {
    const done = { step: 3, max_step: 3, total: 4, done: true, started_at: '', updated_at: '', completed_at: '' };
    const p = Object.fromEntries(JOURNEY.slice(0, 2).map((c) => [c.id, done]));
    const j = journeyStatus(p, ADMIN);
    expect(j.done).toBe(2);
    expect(j.next?.id).toBe('journey-3-daily');
    const b = badges({ ...p, 'start-basics': done }, ADMIN);
    expect(b.find((x) => x.id === 'first')?.earned).toBe(true);
    expect(b.find((x) => x.id === 'journey')?.earned).toBe(false);
    expect(badges({}, member(['contacts'])).some((x) => x.id === 'agency')).toBe(false);
  });
});

describe('academy API', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());

  it('stores progress per user and resumes the running tour', async () => {
    const empty = await t.api.get('/api/academy');
    expect(empty.data).toMatchObject({ tours: {}, active: null, sandbox: null, can_sandbox: true });

    let r = await t.api.put('/api/academy/tours/contacts', { step: 3, total: 10, active: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ step: 3, max_step: 3, total: 10, done: false });
    r = await t.api.put('/api/academy/tours/contacts', { step: 1, total: 10, active: true });
    expect(r.data.max_step).toBe(3);
    let a = await t.api.get('/api/academy');
    expect(a.data.active).toEqual({ tour: 'contacts', step: 1 });

    r = await t.api.put('/api/academy/tours/contacts', { step: 9, total: 10, done: true });
    expect(r.data).toMatchObject({ done: true, max_step: 9 });
    expect(r.data.completed_at).toBeTruthy();
    a = await t.api.get('/api/academy');
    expect(a.data.active).toBeNull();
    // starting again keeps it done
    r = await t.api.put('/api/academy/tours/contacts', { step: 0, total: 10, active: true });
    expect(r.data.done).toBe(true);
    expect((await t.api.del('/api/academy/active')).status).toBe(200);
    expect((await t.api.get('/api/academy')).data.active).toBeNull();

    expect((await t.api.del('/api/academy/tours/contacts')).status).toBe(200);
    expect((await t.api.get('/api/academy')).data.tours.contacts).toBeUndefined();
  });

  it('validates input', async () => {
    expect((await t.api.put('/api/academy/tours/..%2Fx', { step: 0, total: 3 })).status).toBe(400);
    expect((await t.api.put('/api/academy/tours/Bad_Id', { step: 0, total: 3 })).status).toBe(400);
    expect((await t.api.put('/api/academy/tours/ok-tour', { step: 5, total: 3 })).status).toBe(400);
    expect((await t.api.put('/api/academy/tours/ok-tour', { step: -1, total: 3 })).status).toBe(400);
    expect((await t.api.put('/api/academy/tours/ok-tour', { step: 1 })).status).toBe(400);
    const anon = await fetch(`${t.base}/api/academy`);
    expect(anon.status).toBe(401);
  });

  it('keeps each user’s progress separate and limits sandbox and docs to the agency', async () => {
    await t.api.put('/api/academy/tours/dashboard', { step: 2, total: 8, active: true });
    const u = await t.api.post('/api/users', { email: 'kunde@example.com', name: 'Kundin', password: 'geheim123', role: 'member', locations: [t.api.location], permissions: ['contacts'] });
    expect(u.status).toBe(200);
    const adminCookie = t.api.cookie;
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'kunde@example.com', password: 'geheim123' })).status).toBe(200);
    const mine = await t.api.get('/api/academy');
    expect(mine.data).toMatchObject({ tours: {}, active: null, can_sandbox: false });
    expect((await t.api.post('/api/academy/sandbox', {})).status).toBe(403);
    expect((await t.api.get('/api/academy/docs/self-hosting')).status).toBe(403);
    const hb = await t.api.get('/api/academy/docs/handbuch');
    expect(hb.status).toBe(200);
    expect(hb.data.markdown).toContain('Kapitel 1');
    expect((await t.api.get('/api/academy/docs')).data).not.toContain('self-hosting');
    // back to the admin
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
    expect(t.api.cookie).not.toBe(adminCookie);
    expect((await t.api.get('/api/academy')).data.tours.dashboard.step).toBe(2);
    expect((await t.api.get('/api/academy/docs/self-hosting')).status).toBe(200);
    expect((await t.api.get('/api/academy/docs/README')).data.title).toBeTruthy();
    expect((await t.api.get('/api/academy/docs/..%2F..%2Fpackage')).status).toBe(404);
  });

  it('creates the practice company with demo data and deletes it again', async () => {
    const r = await t.api.post('/api/academy/sandbox', {});
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ name: 'Übungs-Firma (Akademie)', created: true });
    expect(r.data.seeded).toBeGreaterThan(10);
    const id = r.data.id;
    const again = await t.api.post('/api/academy/sandbox', {});
    expect(again.data).toMatchObject({ id, created: false });
    expect((await t.api.get('/api/academy')).data.sandbox).toEqual({ id, name: 'Übungs-Firma (Akademie)' });

    const own = t.api.location;
    t.api.setLocation(id);
    const contacts = await t.api.get('/api/contacts');
    expect(contacts.data.total).toBeGreaterThanOrEqual(8);
    expect(contacts.data.contacts.every((c: any) => c.email.endsWith('@example.com'))).toBe(true);
    expect((await t.api.get('/api/opportunities')).data.length).toBeGreaterThanOrEqual(3);
    expect((await t.api.get('/api/tasks')).data.length).toBeGreaterThanOrEqual(3);
    expect((await t.api.get('/api/invoices')).data.length).toBeGreaterThanOrEqual(1);
    // service, companies, custom objects and lead scoring for the newer tours
    expect((await t.api.get('/api/tickets')).data.total).toBeGreaterThanOrEqual(2);
    expect((await t.api.get('/api/kb/articles')).data.some((a: any) => a.status === 'published')).toBe(true);
    expect((await t.api.get('/api/companies')).data.total).toBeGreaterThanOrEqual(3);
    const objects = (await t.api.get('/api/objects')).data;
    expect(objects.map((o: any) => o.plural)).toContain('Projekte');
    expect((await t.api.get(`/api/objects/${objects.find((o: any) => o.plural === 'Projekte').key}/records`)).data.total).toBe(2);
    const models = (await t.api.get('/api/lead-scoring/models')).data;
    expect(models).toHaveLength(1);
    expect(models[0].stats.scored).toBeGreaterThan(0);
    const loc = await t.api.get('/api/location');
    expect(loc.data.settings.email.provider).toBe('log');
    expect((await t.api.get('/api/api-keys')).data).toEqual([]);
    t.api.setLocation(own);

    expect((await t.api.del('/api/academy/sandbox')).status).toBe(200);
    expect((await t.api.get('/api/academy')).data.sandbox).toBeNull();
    expect((await t.api.get('/api/locations')).data.some((l: any) => l.id === id)).toBe(false);
    expect((await t.api.del('/api/academy/sandbox')).status).toBe(404);
  });
});
