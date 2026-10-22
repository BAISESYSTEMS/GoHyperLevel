import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { HQ_TEMPLATE } from '../server/services/hq-template.js';
import { HQ_MAILS } from '../server/services/hq-template-mails.js';
import { validateSnapshot } from '../server/services/snapshots.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  delete process.env.PGHL_LANDING_LOCATION;
  delete process.env.PGHL_LANDING_FORM;
  await t.close();
});

const db = () => t.app.db;
const count = (sql: string, ...args: any[]) => db().get<{ n: number }>(sql, ...args)!.n;

describe('template data', () => {
  it('is a valid snapshot with German mails in du-tone and consistent references', () => {
    const s = validateSnapshot(structuredClone(HQ_TEMPLATE.snapshot));
    expect(s.pipelines.map((p) => p.name)).toEqual(['Kunden (Cloud)', 'Agentur-Partner', 'Presse & Influencer']);
    expect(s.pipelines[0].stages.map((x) => x.name)).toEqual(['Warteliste', 'Testphase', 'Kunde', 'Gekündigt / Rückgewinnung']);
    expect(s.forms.map((f) => f.name)).toEqual(['Warteliste & Newsletter', 'Demo-Anfrage', 'Support', 'Feature-Wunsch']);
    expect(s.custom_fields.map((f) => f.key)).toEqual(expect.arrayContaining(['plan', 'mrr', 'quelle', 'betrieb']));
    const formIds = new Set(s.forms.map((f) => f.id));
    const pipeIds = new Set(s.pipelines.map((p) => p.id));
    for (const w of s.workflows) {
      if (w.trigger.config?.form_id) expect(formIds.has(w.trigger.config.form_id), w.name).toBe(true);
      for (const st of w.steps) if (st.pipeline_id) expect(pipeIds.has(st.pipeline_id), w.name).toBe(true);
      expect(new Set(w.steps.map((x: any) => x.id)).size, w.name).toBe(w.steps.length);
    }
    for (const m of Object.values(HQ_MAILS)) {
      expect(m.body).toMatch(/\bdu\b|\bdir\b|\bdein/i);
      expect(m.body).not.toMatch(/\bSie\b|\bIhnen\b/);
    }
    // the drip: day 0/1/3/7/12 = waits of 1, 2, 4, 5 days, and a check-in task
    const drip = s.workflows.find((w) => w.id === 'w-trial')!;
    expect(drip.steps.filter((x: any) => x.type === 'wait').map((x: any) => x.amount)).toEqual([1, 2, 4, 5]);
    expect(drip.steps.filter((x: any) => x.type === 'send_email')).toHaveLength(5);
    expect(drip.steps.some((x: any) => x.type === 'create_task')).toBe(true);
  });
});

describe('loading the template into an empty sub-account', () => {
  let hq = '';
  let result: any;

  it('lists the built-in template', async () => {
    hq = (await t.api.post('/api/locations', { name: 'HyperLevel GmbH' })).data.id;
    const list = (await t.api.get(`/api/snapshot-templates?location_id=${hq}`)).data;
    const tpl = list.find((x: any) => x.id === 'saas-hq');
    expect(tpl).toMatchObject({ name: 'Software- & SaaS-Firma (HQ)', applied_at: null });
    expect(tpl.summary).toMatchObject({ pipelines: 3, forms: 4, workflows: 9, products: 3, community_groups: 1, kb_categories: 4, kb_articles: 4, dashboards: 1, routines: 6 });
  });

  it('applies cleanly in one click', async () => {
    const r = await t.api.post('/api/snapshot-templates/saas-hq/apply', { location_id: hq });
    expect(r.status).toBe(200);
    result = r.data;
    expect(result.warnings).toEqual([]);
    expect(result.created).toMatchObject({ pipelines: 3, forms: 4, workflows: 9, templates: Object.keys(HQ_MAILS).length, products: 3, community_groups: 1, kb_categories: 4, kb_articles: 4, routines: 6, helpdesk: true });
    expect(result.created.dashboards).toHaveLength(1);

    // the empty default pipeline made room for the template's three
    expect(db().all('SELECT name FROM pipelines WHERE location_id = ? ORDER BY created_at', hq).map((p) => p.name)).toEqual(['Kunden (Cloud)', 'Agentur-Partner', 'Presse & Influencer']);
    expect(count('SELECT COUNT(*) AS n FROM custom_fields WHERE location_id = ?', hq)).toBe(8);
    expect(count(`SELECT COUNT(*) AS n FROM tags WHERE location_id = ? AND name = 'status:testphase'`, hq)).toBe(1);
    // workflows arrive as drafts and point at the copies
    const flows = db().all('SELECT * FROM workflows WHERE location_id = ?', hq);
    expect(flows.every((w) => w.status === 'draft')).toBe(true);
    const feature = flows.find((w) => w.name.startsWith('Feature-Wunsch'))!;
    const featureForm = db().get(`SELECT id FROM forms WHERE location_id = ? AND name = 'Feature-Wunsch'`, hq)!;
    expect(JSON.parse(feature.trigger).config.form_id).toBe(featureForm.id);
    const lifecycle = db().get(`SELECT id FROM pipelines WHERE location_id = ? AND name = 'Kunden (Cloud)'`, hq)!;
    const trial = flows.find((w) => w.name.startsWith('Testphase: Onboarding'))!;
    expect(JSON.parse(trial.steps).find((s: any) => s.type === 'move_opportunity').pipeline_id).toBe(lifecycle.id);
    // forms: Double-Opt-in on the waitlist, tickets from the support form
    const waitlist = db().get(`SELECT settings FROM forms WHERE location_id = ? AND name = 'Warteliste & Newsletter'`, hq)!;
    expect(JSON.parse(waitlist.settings).consent).toMatchObject({ doi: 'on', purposes: ['newsletter'] });
    const support = db().get(`SELECT settings FROM forms WHERE location_id = ? AND name = 'Support'`, hq)!;
    expect(JSON.parse(support.settings).create_ticket).toBe(true);
    // help center skeleton as drafts, helpdesk categories and auto-reply
    expect(db().all('SELECT title, status FROM kb_articles WHERE location_id = ? ORDER BY title', hq).map((a) => a.status)).toEqual(['draft', 'draft', 'draft', 'draft']);
    const hd = JSON.parse(db().get('SELECT data FROM helpdesk_settings WHERE location_id = ?', hq)!.data);
    expect(hd.categories).toContain('Self-Hosting');
    expect(hd.auto_reply.enabled).toBe(true);
    // community skeleton without posts
    const g = db().get('SELECT id FROM community_groups WHERE location_id = ?', hq)!;
    expect(count('SELECT COUNT(*) AS n FROM community_channels WHERE group_id = ?', g.id)).toBe(8);
    // routines: one project with recurring tasks
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE location_id = ? AND recurrence IS NOT NULL', hq)).toBe(6);
  });

  it('builds a working CEO dashboard with the pipeline filter resolved', async () => {
    const dashId = result.created.dashboards[0];
    const d = db().get('SELECT * FROM report_dashboards WHERE id = ?', dashId)!;
    expect(d.location_id).toBe(hq);
    const widgets = JSON.parse(d.widgets);
    expect(widgets.map((w: any) => w.title)).toEqual(expect.arrayContaining(['MRR', 'ARR', 'Laufende Testphasen', 'Lead → Kunde', 'Kündigungen', 'Leads je Quelle', 'SLA-Quote Support']));
    expect(JSON.stringify(widgets)).not.toContain('pipeline:');
    const data = await t.api.get(`/api/reports/dashboards/${dashId}/data`, { 'x-location-id': hq });
    expect(data.status).toBe(200);
    expect(JSON.stringify(data.data)).not.toMatch(/"error"/);
  });

  it('refuses a second load unless asked again', async () => {
    expect((await t.api.post('/api/snapshot-templates/saas-hq/apply', { location_id: hq })).status).toBe(409);
    expect((await t.api.get(`/api/snapshot-templates?location_id=${hq}`)).data[0].applied_at).toBeTruthy();
    expect((await t.api.post('/api/snapshot-templates/gibtsnicht/apply', { location_id: hq })).status).toBe(404);
  });

  it('runs a workflow once activated: feature wish → roadmap tag', async () => {
    t.api.setLocation(hq);
    const wf = db().get(`SELECT id FROM workflows WHERE location_id = ? AND name LIKE 'Feature-Wunsch%'`, hq)!;
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    const form = db().get(`SELECT id FROM forms WHERE location_id = ? AND name = 'Feature-Wunsch'`, hq)!;
    const r = await t.api.post(`/api/public/forms/${form.id}/submit`, { first_name: 'Mia', email: 'mia@example.com', wunsch: 'Dunkles Theme', consent: true });
    expect(r.data.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    const c = db().get(`SELECT tags FROM contacts WHERE location_id = ? AND email = 'mia@example.com'`, hq)!;
    expect(JSON.parse(c.tags)).toContain('roadmap:wunsch');
  });

  it('is admin-only', async () => {
    const res = await t.api.raw('/api/snapshot-templates', { headers: { 'x-pghl': '1' } });
    expect(res.status).toBe(401);
  });

  describe('landing page waitlist hook', () => {
    it('is off without PGHL_LANDING_LOCATION', async () => {
      delete process.env.PGHL_LANDING_LOCATION;
      expect((await t.api.get('/api/public/landing/waitlist')).data).toEqual({ enabled: false });
      expect((await t.api.post('/api/public/landing/waitlist', { email: 'x@example.com' })).status).toBe(404);
    });

    it('posts into the configured sub-account through the forms module (Double-Opt-in)', async () => {
      process.env.PGHL_LANDING_LOCATION = hq;
      const info = (await t.api.raw('/api/public/landing/waitlist').then((r) => r.json())) as any;
      expect(info.enabled).toBe(true);
      expect(info.fields.map((f: any) => f.name)).toEqual(['first_name', 'email', 'custom.plan', 'source', 'consent']);
      const r = await t.api.raw('/api/public/landing/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Lea', email: 'lea@example.com', plan: 'Solo', consent: true }) });
      expect(r.status).toBe(200);
      const c = db().get(`SELECT * FROM contacts WHERE location_id = ? AND email = 'lea@example.com'`, hq)!;
      expect(c.source).toBe('Landingpage');
      expect(JSON.parse(c.custom).plan).toBe('Solo');
      expect(JSON.parse(c.tags)).toEqual(expect.arrayContaining(['status:warteliste', 'newsletter']));
      // the opt-in waits for the confirmation mail – the welcome sequence starts on consent.confirmed
      expect(count(`SELECT COUNT(*) AS n FROM consent_doi WHERE contact_id = ?`, c.id)).toBe(1);
      // a wrong form id switches the hook off instead of posting elsewhere
      process.env.PGHL_LANDING_FORM = 'gibtsnicht';
      expect((await t.api.get('/api/public/landing/waitlist')).data.enabled).toBe(false);
      delete process.env.PGHL_LANDING_FORM;
    });
  });
});
