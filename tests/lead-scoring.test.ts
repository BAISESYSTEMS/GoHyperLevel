import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { applyDecay, cleanModel, eventPoints, labelFor, scoreFrom, ScoreError } from '../server/services/lead-scoring.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const flush = () => t.app.events.flush();
const db = () => t.app.db;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

describe('scoring math (pure)', () => {
  let n = 0;
  const mk = () => `r${++n}`;
  it('validates models', () => {
    expect(() => cleanModel({ rules: [{ kind: 'property', field: 'source', op: 'equals', value: 'x', points: 0 }] }, mk)).toThrow(/nicht 0/);
    expect(() => cleanModel({ rules: [{ kind: 'property', field: 'drop table', op: 'equals', value: 'x', points: 5 }] }, mk)).toThrow(/unbekanntes Feld/);
    expect(() => cleanModel({ rules: [{ kind: 'event', event: 'mind.read', points: 5 }] }, mk)).toThrow(/unbekannte Aktivität/);
    expect(() => cleanModel({ rules: [{ kind: 'property', field: 'city', op: 'equals', points: 5 }] }, mk)).toThrow(/Wert fehlt/);
    expect(() => cleanModel({ thresholds: [{ label: 'A', min: 1 }, { label: 'a', min: 2 }] }, mk)).toThrow(ScoreError);
    const m = cleanModel({ rules: [{ kind: 'event', event: 'email.opened', points: 2, max_points: '10', within_days: 30 }, { kind: 'property', field: 'company.custom.tier', value: 'A', points: 5 }], thresholds: [{ label: 'SQL', min: 80 }, { label: 'MQL', min: 50 }], decay: { percent: 10, days: 30 }, max_score: 100 }, mk);
    expect(m.rules[0]).toMatchObject({ max_points: 10, within_days: 30 });
    expect(m.rules[1]).toMatchObject({ op: 'equals' });
    expect(m.thresholds.map((x) => x.label)).toEqual(['MQL', 'SQL']);
  });
  it('caps, decays and labels', () => {
    expect(eventPoints({ points: 5 }, 4)).toBe(20);
    expect(eventPoints({ points: 5, max_points: 15 }, 4)).toBe(15);
    expect(eventPoints({ points: -5, max_points: 8 }, 4)).toBe(-8);
    const day = 864e5;
    expect(applyDecay(100, { percent: 10, days: 30 }, new Date(Date.now() - 65 * day).toISOString())).toBeCloseTo(81);
    expect(applyDecay(100, { percent: 10, days: 30 }, new Date(Date.now() - 10 * day).toISOString())).toBe(100);
    expect(applyDecay(-20, { percent: 50, days: 1 }, new Date(Date.now() - 10 * day).toISOString())).toBe(-20);
    expect(labelFor(79, [{ label: 'MQL', min: 50 }, { label: 'SQL', min: 80 }])).toBe('MQL');
    expect(labelFor(10, [{ label: 'MQL', min: 50 }])).toBe('');
    const model = { rules: [{ id: 'a', kind: 'property' as const, label: 'Fit', points: 60 }, { id: 'b', kind: 'event' as const, label: 'Opens', event: 'email.opened' as const, points: 30, max_points: 50 }], thresholds: [{ label: 'MQL', min: 50 }], decay: { percent: 50, days: 30 }, max_score: 100 };
    const r = scoreFrom(model, { a: true }, { b: 3 }, new Date(Date.now() - 31 * day).toISOString());
    expect(r).toMatchObject({ score: 55, label: 'MQL' });
    expect(r.breakdown.map((x) => [x.rule, x.points])).toEqual([['a', 60], ['b', 50], ['decay', -55]]);
    expect(scoreFrom({ ...model, decay: { percent: 0, days: 30 } }, { a: true }, { b: 3 }, null)).toMatchObject({ score: 100 });
    expect(scoreFrom({ ...model, rules: [{ id: 'n', kind: 'property', label: 'Freemail', points: -20 }] }, { n: true }, {}, null).score).toBe(0);
  });
});

describe('lead scoring in a sub-account', () => {
  let model: any;
  let anna: any;
  let ben: any;
  let form: any;
  const scoreOf = async (cid: string) => (await t.api.get(`/api/lead-scoring/contacts/${cid}`)).data.scores[0];

  it('scores properties, tags, company properties and engagement', async () => {
    await t.api.post('/api/custom-fields', { label: 'Budget', key: 'budget', type: 'number' });
    const co = (await t.api.post('/api/companies', { name: 'Softwerk', domain: 'softwerk.de', industry: 'Software' })).data;
    anna = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@softwerk.de', source: 'Website', custom: { budget: '5000' } })).data;
    ben = (await t.api.post('/api/contacts', { first_name: 'Ben', email: 'ben@gmail.com', source: 'Messe' })).data;
    await flush();
    expect(co.id).toBeTruthy();
    form = (await t.api.post('/api/forms', { name: 'Anfrage' })).data;
    const r = await t.api.post('/api/lead-scoring/models', {
      name: 'Vertrieb',
      rules: [
        { kind: 'property', field: 'source', op: 'equals', value: 'website', points: 10 },
        { kind: 'property', field: 'custom.budget', op: 'gt', value: '1000', points: 20 },
        { kind: 'property', field: 'tag', op: 'has', value: 'vip', points: 15 },
        { kind: 'property', field: 'company.industry', op: 'equals', value: 'Software', points: 10, label: 'Zielbranche' },
        { kind: 'property', field: 'email', op: 'contains', value: 'gmail', points: -10 },
        { kind: 'event', event: 'form.submitted', points: 5, max_points: 15 },
        { kind: 'event', event: 'appointment.booked', points: 25 },
      ],
      thresholds: [{ label: 'MQL', min: 50 }, { label: 'SQL', min: 80 }],
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    model = r.data;
    expect(model).toMatchObject({ is_primary: true, active: true });
    expect(model.stats.scored).toBe(2);
    const a = await scoreOf(anna.id);
    expect(a).toMatchObject({ score: 40, label: '' });
    expect(a.breakdown.map((b: any) => b.label)).toEqual(expect.arrayContaining(['Zielbranche']));
    expect((await scoreOf(ben.id)).score).toBe(0);
    expect((await t.api.post('/api/lead-scoring/models', { rules: [{ kind: 'property', field: 'x;y', value: 1, points: 1 }] })).status).toBe(400);
  });

  it('updates on events, caps per rule, reaches thresholds and starts workflows', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'MQL', trigger: { type: 'lead_score.threshold_reached', config: { model_id: model.id, threshold: 'MQL' } }, steps: [{ type: 'add_tag', tags: ['mql'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const wfSql = (await t.api.post('/api/workflows', { name: 'SQL', trigger: { type: 'lead_score.threshold_reached', config: { threshold: 'SQL' } }, steps: [{ type: 'add_tag', tags: ['sql'] }] })).data;
    await t.api.patch(`/api/workflows/${wfSql.id}`, { status: 'active' });
    const wfDown = (await t.api.post('/api/workflows', { name: 'Runter', trigger: { type: 'lead_score.changed', config: { direction: 'down' } }, steps: [{ type: 'add_tag', tags: ['abgekühlt'] }] })).data;
    await t.api.patch(`/api/workflows/${wfDown.id}`, { status: 'active' });

    for (let i = 0; i < 4; i++) {
      await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ first_name: 'Anna', email: 'anna@softwerk.de', consent: 'ja' }) });
    }
    await flush();
    const a = await scoreOf(anna.id);
    expect(a.score).toBe(55); // 40 + forms capped at 15
    expect(a.label).toBe('MQL');
    expect(a.breakdown.find((b: any) => b.count === 4)).toMatchObject({ points: 15 });
    await flush();
    let c = (await t.api.get(`/api/contacts/${anna.id}`)).data;
    expect(c.tags).toContain('mql');
    expect(c.tags).not.toContain('sql');

    await t.api.post(`/api/contacts/${anna.id}/tags`, { add: ['vip'] });
    await flush();
    expect((await scoreOf(anna.id)).score).toBe(70);
    // Booking jumps over SQL.
    const cal = (await t.api.post('/api/calendars', { name: 'Beratung' })).data;
    db().run(`INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, start_at, end_at, status, manage_token, created_at) VALUES ('ap1', ?, ?, ?, 'Termin', ?, ?, 'confirmed', 'tok-ap1', ?)`, t.api.location, cal.id, anna.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    t.app.events.emit(t.api.location, 'appointment.booked', { contactId: anna.id });
    await flush();
    await flush();
    expect((await scoreOf(anna.id))).toMatchObject({ score: 95, label: 'SQL' });
    c = (await t.api.get(`/api/contacts/${anna.id}`)).data;
    expect(c.tags).toEqual(expect.arrayContaining(['mql', 'vip', 'sql']));

    // Losing the tag lowers the score: "changed (down)" fires, no new threshold event.
    await t.api.post(`/api/contacts/${anna.id}/tags`, { remove: ['vip'] });
    await flush();
    await flush();
    expect((await scoreOf(anna.id)).score).toBe(80);
    expect((await t.api.get(`/api/contacts/${anna.id}`)).data.tags).toContain('abgekühlt');

    const hist = (await t.api.get(`/api/lead-scoring/contacts/${anna.id}`)).data.history;
    expect(hist[0]).toMatchObject({ score: 80, previous: 95, reason: 'Tag entfernt' });
    expect(hist.map((h: any) => h.score)).toEqual(expect.arrayContaining([40, 55, 70, 95, 80]));
  });

  it('filters and sorts contact lists by score, list column endpoint', async () => {
    const names = async (qs: string) => (await t.api.get(`/api/contacts?${qs}`)).data.contacts.map((c: any) => c.first_name);
    expect(await names('score_min=50')).toEqual(['Anna']);
    expect(await names('score_label=SQL')).toEqual(['Anna']);
    expect(await names('score_label=MQL')).toEqual(['Anna']);
    expect((await names('sort=score'))[0]).toBe('Anna');
    expect(await names('score_max=0')).toContain('Ben');
    const sl = (await t.api.post('/api/smart-lists', { name: 'Heiße Leads', filter: { score_label: 'SQL' } })).data;
    expect(sl.filter.score_label).toBe('SQL');
    const map = (await t.api.get(`/api/lead-scoring/scores?ids=${anna.id},${ben.id}`)).data;
    expect(map[anna.id]).toEqual({ score: 80, label: 'SQL' });
    expect(map[ben.id].score).toBe(0);
  });

  it('decays inactive leads in the nightly run and rescored on rule changes', async () => {
    const r = await t.api.patch(`/api/lead-scoring/models/${model.id}`, { decay: { percent: 50, days: 30 } });
    expect(r.status).toBe(200);
    expect((await scoreOf(anna.id)).score).toBe(80);
    // Everything happened 40 days ago → one period → half.
    const old = new Date(Date.now() - 40 * 864e5).toISOString();
    for (const table of ['form_submissions', 'appointments', 'attribution_touches']) db().run(`UPDATE ${table} SET created_at = ? WHERE contact_id = ?`, old, anna.id);
    db().run('UPDATE contacts SET last_activity_at = ?, created_at = ? WHERE id = ?', old, old, anna.id);
    expect(t.app.services.leadScoringNightly(true)).toBe(true);
    const a = await scoreOf(anna.id);
    expect(a.score).toBe(40);
    expect(a.breakdown.at(-1)).toMatchObject({ rule: 'decay', points: -40 });
    expect(a.label).toBe('');
    // Time windows: only forms of the last 30 days count.
    await t.api.patch(`/api/lead-scoring/models/${model.id}`, { decay: { percent: 0, days: 30 }, rules: model.rules.map((x: any) => (x.event === 'form.submitted' ? { ...x, within_days: 30 } : x)) });
    expect((await scoreOf(anna.id)).score).toBe(65);
  });

  it('several models, the primary one drives lists; MCP, snapshot and permissions', async () => {
    const m2 = (await t.api.post('/api/lead-scoring/models', { name: 'Newsletter', rules: [{ kind: 'event', event: 'email.opened', points: 3 }] })).data;
    expect(m2.is_primary).toBe(false);
    expect((await t.api.get(`/api/lead-scoring/contacts/${anna.id}`)).data.scores.map((s: any) => s.model_name)).toEqual(['Vertrieb', 'Newsletter']);

    const key = (await t.api.post('/api/agency/api-keys', { name: 'mcp', scope: 'read' })).data.key;
    const res = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_lead_score', arguments: { location_id: t.api.location, email: 'anna@softwerk.de' } } }) });
    const out = JSON.parse((await res.json()).result.content[0].text);
    expect(out.scores[0]).toMatchObject({ model_name: 'Vertrieb', score: 65 });
    expect(out.history.length).toBeGreaterThan(3);

    const snap = (await t.api.post('/api/snapshots', { location_id: t.api.location, name: 'Scoring' })).data;
    const r = (await t.api.post('/api/agency/clients', { name: 'Scoring-Kunde', snapshot_id: snap.id })).data;
    expect(r.created.lead_score_models).toBe(2);
    const copied = db().all('SELECT name, is_primary, rules FROM lead_score_models WHERE location_id = ? ORDER BY name', r.location.id);
    expect(copied.map((x) => [x.name, x.is_primary])).toEqual([['Newsletter', 0], ['Vertrieb', 1]]);
    expect(JSON.parse(copied[1].rules)).toHaveLength(7);

    await t.api.post('/api/users', { email: 'sales@example.com', password: 'geheim123', name: 'Sales', role: 'member', locations: [t.api.location], permissions: ['contacts'] });
    const login = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sales@example.com', password: 'geheim123' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const h = { cookie, 'x-pghl': '1', 'x-location-id': t.api.location, 'content-type': 'application/json' };
    expect((await t.api.raw(`/api/lead-scoring/contacts/${anna.id}`, { headers: h })).status).toBe(200);
    expect((await t.api.raw('/api/lead-scoring/models', { headers: h })).status).toBe(200);
    expect((await t.api.raw('/api/lead-scoring/models', { method: 'POST', headers: h, body: JSON.stringify({ name: 'X' }) })).status).toBe(403);
    expect((await t.api.raw(`/api/lead-scoring/models/${m2.id}`, { method: 'DELETE', headers: h })).status).toBe(403);
  });
});
