import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { STARTERS, integrityOf, reviewTemplate, stateFromTemplate, cleanTemplateInput } from '../server/services/boards-templates.js';
import { WidgetRegistry } from '../server/services/boards-widgets.js';
import { DEFAULT_EMBED_HOSTS } from '../server/services/boards-embed.js';
import { registerCoreWidgets } from '../server/services/boards-widgets-core.js';

/** Templates: starters, own templates, publishing in the Marktplatz and installing from it, export and import. Config only. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let member: Call; // member of loc, no admin
let outsider: Call; // admin-less member of the other sub-account
let source: any;
let pipeline: any;
const api = (c: Call, method: string, path: string, body?: unknown, location = loc) => c(method, path, body, { 'x-location-id': location });

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  await t.api.post('/api/users', { email: 'mitglied@example.com', name: 'Mia Mitglied', password: 'passwort-12345', role: 'member', locations: [loc], permissions: ['dashboard'] });
  await t.api.post('/api/users', { email: 'aussen@example.com', name: 'Otto Außen', password: 'passwort-12345', role: 'member', locations: [other], permissions: ['dashboard'] });
  member = client(t.base, { 'x-pghl': '1' });
  await member('POST', '/api/auth/login', { email: 'mitglied@example.com', password: 'passwort-12345' });
  outsider = client(t.base, { 'x-pghl': '1' });
  await outsider('POST', '/api/auth/login', { email: 'aussen@example.com', password: 'passwort-12345' });
  pipeline = (await t.api.post('/api/pipelines', { name: 'Verkauf', stages: [{ name: 'Lead' }] })).data;
  // a board with ids of this sub-account, a note with text and an embedded address
  source = (await t.api.post('/api/boards', { name: 'Mein Vertrieb', scope: 'shared', team_access: 'edit' })).data;
  const r = await t.api.post(`/api/boards/${source.id}/patch`, {
    ops: [
      { op: 'add', type: 'kpi', config: { preset: 'open_pipeline_value' } },
      { op: 'add', type: 'list', config: { entity: 'deals', pipeline_id: pipeline.id, min_value: 5000 }, title: 'Große Deals' },
      { op: 'add', type: 'pipeline', config: { pipeline_id: pipeline.id } },
      { op: 'add', type: 'notes', config: { text: 'Intern: Kunde Müller zahlt spät' }, title: 'Hinweise' },
      { op: 'add', type: 'embed', config: { url: 'https://docs.google.com/spreadsheets/d/1/edit' } },
      { op: 'theme', accent: 'violett' },
    ],
  });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  source = r.data.board;
}, 60_000);
afterAll(() => t.close());

describe('starters', () => {
  it('are config only and every one passes its own review and builds without errors', () => {
    const reg = new WidgetRegistry();
    registerCoreWidgets(reg);
      const env = { app: { services: {}, baseUrl: () => 'http://x' } as any, locationId: 'L' };
    expect(STARTERS.map((s) => s.key)).toEqual(['solo-cockpit', 'vertrieb', 'agentur', 'service', 'projekte']);
    for (const s of STARTERS) {
      const review = reviewTemplate(s, { reg, env, hostOf: () => null });
      expect(review.verdict, `${s.key}: ${review.checks.map((c) => c.text).join(' | ')}`).not.toBe('fail');
      const built = stateFromTemplate(s, { reg, env, strict: true });
      expect(built.errors, s.key).toEqual([]);
      expect(built.state.spec.widgets, s.key).toHaveLength(s.widgets.length);
      // the layout of the starter survives: the same cells
      for (const [i, w] of s.widgets.entries()) expect(built.state.spec.widgets[i].layout.lg, `${s.key} #${i}`).toMatchObject({ x: w.x, y: w.y, w: w.w, h: w.h });
      expect(JSON.stringify(s)).not.toMatch(/<script|javascript:|\bon\w+=/i);
    }
  });

  it('are listed with a preview and installable through the board route', async () => {
    const r = await t.api.get('/api/board-templates');
    expect(r.status).toBe(200);
    expect(r.data.starters).toHaveLength(5);
    expect(r.data.starters[0]).toMatchObject({ key: 'solo-cockpit', name: 'Solo-Cockpit', widgets: 10 });
    expect(r.data.starters[0].preview[0]).toMatchObject({ type: 'kpi', x: 0, y: 0 });
    expect(r.data.categories.map((c: any) => c.key)).toContain('vertrieb');
    expect((await api(member, 'GET', '/api/board-templates?q=service')).data.starters.map((s: any) => s.key)).toEqual(['service']);
  });
});

describe('save as a template, in the sub-account', () => {
  let tpl: any;
  it('takes the board’s config without the ids of this sub-account, and tells what was left out', async () => {
    const check = await t.api.get(`/api/board-templates/check?board_id=${source.id}`);
    expect(check.data.review.verdict).toBe('warn');
    expect(check.data.review.needs.map((n: any) => n.key)).toEqual(expect.arrayContaining(['area:Opportunities', 'host:docs.google.com']));
    expect(check.data.stripped.join(' ')).toContain('Pipeline');
    const r = await t.api.post('/api/board-templates', { board_id: source.id, name: 'Vertriebs-Vorlage', description: 'Pipeline und große Deals', category: 'vertrieb' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    tpl = r.data;
    expect(tpl).toMatchObject({ name: 'Vertriebs-Vorlage', scope: 'location', version: 1, widgets: 5, mine: true, can_manage: true, accent: '#7c3aed' });
    const bundle = (await t.api.get(`/api/board-templates/${tpl.id}/export`)).data;
    expect(JSON.stringify(bundle)).not.toContain(pipeline.id);
    expect(bundle.template.widgets.find((w: any) => w.type === 'list').config).toMatchObject({ entity: 'deals', min_value: 5000 });
    expect(bundle.template.widgets.find((w: any) => w.type === 'list').config.pipeline_id).toBeUndefined();
  });

  it('is shared with the sub-account only: others never see it', async () => {
    expect((await api(member, 'GET', '/api/board-templates')).data.mine.map((x: any) => x.name)).toContain('Vertriebs-Vorlage');
    expect((await api(member, 'GET', `/api/board-templates/${tpl.id}`)).status).toBe(200);
    expect((await api(outsider, 'GET', `/api/board-templates/${tpl.id}`, undefined, other)).status).toBe(404);
    expect((await api(outsider, 'GET', '/api/board-templates', undefined, other)).data.mine).toEqual([]);
    expect((await api(outsider, 'GET', '/api/board-templates', undefined, other)).data.marketplace).toEqual([]);
    expect((await api(outsider, 'POST', `/api/board-templates/${tpl.id}/install`, {}, other)).status).toBe(404);
    expect((await api(outsider, 'GET', `/api/board-templates/${tpl.id}/export`, undefined, other)).status).toBe(404);
    expect((await api(outsider, 'DELETE', `/api/board-templates/${tpl.id}`, undefined, other)).status).toBe(404);
    // and it is not a board starter for the other sub-account either
    expect((await api(outsider, 'POST', '/api/boards', { template: tpl.id }, other)).status).toBe(404);
  });

  it('creates a new board from it, and republishing the same board makes a new version of the template', async () => {
    const made = await api(member, 'POST', `/api/board-templates/${tpl.id}/install`, { name: 'Meine Kopie' });
    expect(made.status, JSON.stringify(made.data)).toBe(200);
    expect(made.data).toMatchObject({ name: 'Meine Kopie', scope: 'personal', widgets: 5, accent: '#7c3aed', template_key: tpl.id });
    expect(made.data.spec.widgets.find((w: any) => w.type === 'list').config.pipeline_id).toBe('');
    const versions = (await api(member, 'GET', `/api/boards/${made.data.id}/versions`)).data.versions;
    expect(versions[0]).toMatchObject({ kind: 'template' });
    const again = await t.api.post('/api/board-templates', { board_id: source.id, name: 'Vertriebs-Vorlage 2', category: 'vertrieb' });
    expect(again.data).toMatchObject({ id: tpl.id, version: 2, name: 'Vertriebs-Vorlage 2' });
    expect((await t.api.get('/api/board-templates')).data.mine.filter((x: any) => x.name.startsWith('Vertriebs')).length).toBe(1);
    // installs are counted for the marketplace; the own-board route takes a saved template of the sub-account too
    const viaBoards = await t.api.post('/api/boards', { template: tpl.id, name: 'Über die Boards-Route' });
    expect(viaBoards.status).toBe(200);
    expect(viaBoards.data.widgets).toBe(5);
  });

  it('is deleted by its author or an admin, not by others', async () => {
    const mine = (await api(member, 'POST', '/api/boards', { name: 'Mias Board' })).data;
    await api(member, 'POST', `/api/boards/${mine.id}/patch`, { ops: [{ op: 'add', type: 'notes', config: { text: 'x' } }] });
    const t2 = (await api(member, 'POST', '/api/board-templates', { board_id: mine.id, name: 'Mias Vorlage' })).data;
    expect(t2.can_manage).toBe(true);
    const another = (await t.api.post('/api/boards', { name: 'Fremd', scope: 'shared', team_access: 'edit' })).data;
    await t.api.post(`/api/boards/${another.id}/patch`, { ops: [{ op: 'add', type: 'notes', config: { text: 'x' } }] });
    const adminsTpl = (await t.api.post('/api/board-templates', { board_id: another.id, name: 'Admin-Vorlage' })).data;
    expect((await api(member, 'DELETE', `/api/board-templates/${adminsTpl.id}`)).status).toBe(403);
    expect((await t.api.del(`/api/board-templates/${t2.id}`)).status).toBe(200);
    expect((await api(member, 'GET', `/api/board-templates/${t2.id}`)).status).toBe(404);
    // an empty board is not a template
    const empty = (await t.api.post('/api/boards', { name: 'Leer' })).data;
    expect((await t.api.post('/api/board-templates', { board_id: empty.id, name: 'Nichts' })).status).toBe(409);
  });
});

describe('Marktplatz: publish and install', () => {
  let tpl: any;
  it('only admins publish, after reading the review and approving it', async () => {
    const body = { board_id: source.id, name: 'Vertrieb für alle', description: 'Pipeline und Deals', category: 'vertrieb', scope: 'marketplace' };
    expect((await api(member, 'POST', '/api/board-templates', body)).status).toBe(403);
    const noApprove = await t.api.post('/api/board-templates', body);
    expect(noApprove.status).toBe(400);
    expect(noApprove.data.error).toMatch(/approve/);
    const noWarn = await t.api.post('/api/board-templates', { ...body, approve: true });
    expect(noWarn.status).toBe(400);
    expect(noWarn.data.error).toMatch(/Hinweise/);
    const ok = await t.api.post('/api/board-templates', { ...body, approve: true, accept_warnings: true });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    tpl = ok.data;
    expect(tpl).toMatchObject({ scope: 'marketplace', published_at: expect.any(String) });
    expect(tpl.review.checks.some((c: any) => /Notiz/.test(c.text))).toBe(true);
  });

  it('shows it to every sub-account and installs it there only with the consent that lists what it reads and shows', async () => {
    const list = await api(outsider, 'GET', '/api/board-templates', undefined, other);
    expect(list.data.marketplace.map((x: any) => x.name)).toContain('Vertrieb für alle');
    const detail = await api(outsider, 'GET', `/api/board-templates/${tpl.id}`, undefined, other);
    expect(detail.data).toMatchObject({ mine: false, can_manage: false });
    expect(detail.data.items.map((i: any) => i.type)).toEqual(expect.arrayContaining(['kpi', 'list', 'embed']));
    const keys = detail.data.review.needs.map((n: any) => n.key);
    expect(keys).toEqual(expect.arrayContaining(['area:Opportunities', 'host:docs.google.com']));
    // without the consent, or with a partial one: refused
    expect((await api(outsider, 'POST', `/api/board-templates/${tpl.id}/install`, {}, other)).status).toBe(400);
    expect((await api(outsider, 'POST', `/api/board-templates/${tpl.id}/install`, { consent: [keys[0]] }, other)).status).toBe(400);
    const done = await api(outsider, 'POST', `/api/board-templates/${tpl.id}/install`, { consent: keys, name: 'Unser Vertrieb' }, other);
    expect(done.status, JSON.stringify(done.data)).toBe(200);
    expect(done.data).toMatchObject({ name: 'Unser Vertrieb', widgets: 5, scope: 'personal' });
    // nothing of the author's sub-account came along
    expect(JSON.stringify(done.data)).not.toContain(pipeline.id);
    expect(JSON.stringify(done.data)).not.toContain(loc);
    expect(t.app.db.get<{ installs: number }>('SELECT installs FROM board_templates WHERE id = ?', tpl.id)!.installs).toBeGreaterThanOrEqual(1);
    // the author's own sub-account needs no consent for its own template
    expect((await t.api.post(`/api/board-templates/${tpl.id}/install`, {})).status).toBe(200);
  });

  it('is refused at install when an embedded address is no longer allowed', async () => {
    // the embed uses docs.google.com (built in), so use a custom host to show the point
    await t.api.put('/api/boards/embed-hosts', { hosts: ['berichte.example.org'] });
    const b = (await t.api.post('/api/boards', { name: 'Mit Einbettung', scope: 'shared', team_access: 'edit' })).data;
    await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'add', type: 'embed', config: { url: 'https://berichte.example.org/x' } }] });
    const pub = await t.api.post('/api/board-templates', { board_id: b.id, name: 'Mit Bericht', scope: 'marketplace', approve: true, accept_warnings: true });
    expect(pub.status, JSON.stringify(pub.data)).toBe(200);
    await t.api.put('/api/boards/embed-hosts', { hosts: [] });
    const keys = (await api(outsider, 'GET', `/api/board-templates/${pub.data.id}`, undefined, other)).data.review.needs.map((n: any) => n.key);
    const r = await api(outsider, 'POST', `/api/board-templates/${pub.data.id}/install`, { consent: keys }, other);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/nicht freigegeben/);
  });

  it('can be taken back; a tampered template is not installed', async () => {
    expect((await api(outsider, 'POST', `/api/board-templates/${tpl.id}/unpublish`, {}, other)).status).toBe(403);
    t.app.db.run("UPDATE board_templates SET widgets = replace(widgets, 'open_pipeline_value', 'mrr') WHERE id = ?", tpl.id);
    const keys = (await api(outsider, 'GET', `/api/board-templates/${tpl.id}`, undefined, other)).data.review.needs.map((n: any) => n.key);
    const tampered = await api(outsider, 'POST', `/api/board-templates/${tpl.id}/install`, { consent: keys }, other);
    expect(tampered.status).toBe(409);
    expect(tampered.data.error).toMatch(/verändert/);
    expect((await t.api.post(`/api/board-templates/${tpl.id}/unpublish`, {})).data.scope).toBe('location');
    expect((await api(outsider, 'GET', `/api/board-templates/${tpl.id}`, undefined, other)).status).toBe(404);
  });
});

describe('export and import', () => {
  it('moves a template between installations as a JSON file; only config comes in', async () => {
    const tpl = (await t.api.post('/api/board-templates', { board_id: source.id, name: 'Zum Mitnehmen' })).data;
    const bundle = (await t.api.get(`/api/board-templates/${tpl.id}/export`)).data;
    expect(bundle).toMatchObject({ format: 'gohigh-board-template', bundle_version: 1, template: { name: 'Zum Mitnehmen' } });
    expect(bundle.integrity).toBe(integrityOf(bundle.template));
    // importing it into another sub-account gives that sub-account its own template
    const imp = await api(outsider, 'POST', '/api/board-templates/import', { bundle }, other);
    expect(imp.status, JSON.stringify(imp.data)).toBe(200);
    expect(imp.data).toMatchObject({ name: 'Zum Mitnehmen', scope: 'location', integrity_ok: true, widgets: 5 });
    expect((await api(outsider, 'GET', '/api/board-templates', undefined, other)).data.mine.map((x: any) => x.name)).toContain('Zum Mitnehmen');
    // a changed file is flagged, a foreign format, unknown widget types and unknown config fields are refused
    const edited = { ...bundle, template: { ...bundle.template, name: 'Zum Mitnehmen (geändert)' } };
    expect((await api(outsider, 'POST', '/api/board-templates/import', { bundle: edited }, other)).data.integrity_ok).toBe(false);
    expect((await api(outsider, 'POST', '/api/board-templates/import', { bundle: { format: 'etwas-anderes' } }, other)).status).toBe(400);
    const ghost = { ...bundle, template: { ...bundle.template, widgets: [{ type: 'trojaner', x: 0, y: 0, w: 3, h: 2, config: {} }] } };
    const g = await api(outsider, 'POST', '/api/board-templates/import', { bundle: ghost }, other);
    expect(g.status).toBe(400);
    expect(g.data.error).toMatch(/gibt es nicht/);
    const sneaky = { ...bundle, template: { ...bundle.template, widgets: [{ type: 'notes', x: 0, y: 0, w: 3, h: 2, config: { text: 'ok', script: '<script>alert(1)</script>' } }] } };
    const s = await api(outsider, 'POST', '/api/board-templates/import', { bundle: sneaky }, other);
    expect(s.status).toBe(400);
    expect(s.data.error).toMatch(/unbekanntes Feld/);
    expect((await api(outsider, 'POST', '/api/board-templates/import', { bundle: { ...bundle, template: { ...bundle.template, widgets: Array.from({ length: 50 }, () => ({ type: 'notes', x: 0, y: 0, w: 3, h: 2, config: {} })) } } }, other)).status).toBe(400);
  });

  it('cleans what comes in as a template', () => {
    expect(cleanTemplateInput({}).errors[0]).toMatch(/widgets fehlt/);
    const r = cleanTemplateInput({ widgets: [{ type: 'KPI!' }, { type: 'kpi', x: '3', y: 1, w: 3, h: 2, title: 'Hallo\u0000 Welt' }] });
    expect(r.errors).toEqual(['Ein Widget hat keinen gültigen Typ']);
    expect(r.widgets).toEqual([{ type: 'kpi', title: 'Hallo Welt', config: {}, x: 3, y: 1, w: 3, h: 2 }]);
  });
});
