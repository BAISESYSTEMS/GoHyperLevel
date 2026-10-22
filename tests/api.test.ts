import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { GhlClient, importFromGhl, IMPORT_PARTS } from '../server/services/ghl-import.js';
import { processRun } from '../server/services/workflow-engine.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const flush = () => t.app.events.flush();

beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('auth', () => {
  it('runs first setup once and protects the API', async () => {
    expect((await t.api.get('/api/auth/status')).data.needsSetup).toBe(true);
    const me = await t.setup();
    expect(me.user.role).toBe('admin');
    expect(me.locations).toHaveLength(1);
    expect((await t.api.post('/api/auth/setup', { email: 'x@y.de', password: '12345678' })).status).toBe(409);
    // CSRF header is required for cookie-authenticated writes.
    expect((await t.api.post('/api/contacts', { email: 'a@b.de' }, { 'x-pghl': '0' })).status).toBe(403);
    const anon = await t.api.raw('/api/contacts', { headers: { 'x-location-id': t.api.location } });
    expect(anon.status).toBe(401);
  });

  it('logs in and out', async () => {
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'falsch!!' })).status).toBe(401);
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  });
});

describe('contacts', () => {
  it('creates, dedupes by email and merges tags', async () => {
    const a = await t.api.post('/api/contacts', { first_name: 'Anna', email: 'Anna@Example.com', phone: '0176 1111', tags: ['lead'] });
    expect(a.status).toBe(200);
    expect(a.data.email).toBe('anna@example.com');
    expect(a.data.phone).toBe('+491761111');
    const b = await t.api.post('/api/contacts', { email: 'anna@example.com', last_name: 'Muster', tags: ['vip'] });
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.created).toBe(false);
    expect(b.data.tags).toEqual(['lead', 'vip']);
    const list = await t.api.get('/api/contacts?tag=vip');
    expect(list.data.total).toBe(1);
    const detail = await t.api.get(`/api/contacts/${a.data.id}`);
    expect(detail.data.name).toBe('Anna Muster');
    expect(detail.data.activities.length).toBeGreaterThan(0);
  });

  it('imports and exports CSV', async () => {
    const csv = 'Vorname;Nachname;E-Mail;Telefon;Tags\nBen;Bauer;ben@x.de;0170 2;kunde\nCara;;cara@x.de;;\n;;;;\n';
    const r = await t.api.post('/api/contacts/import', { csv, tags: 'import' });
    expect(r.data).toMatchObject({ created: 2, updated: 0, skipped: 0 });
    const ex = await t.api.get('/api/contacts/export.csv?tag=import');
    expect(ex.data).toContain('ben@x.de');
    expect(ex.data).toContain('cara@x.de');
  });

  it('manages notes, tasks, tags and custom fields', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'notes@x.de' })).data;
    expect((await t.api.post(`/api/contacts/${c.id}/notes`, { body: 'Anruf: interessiert' })).status).toBe(200);
    const task = (await t.api.post('/api/tasks', { title: 'Zurückrufen', contact_id: c.id })).data;
    expect((await t.api.patch(`/api/tasks/${task.id}`, { done: true })).data.done).toBe(1);
    const f = await t.api.post('/api/custom-fields', { label: 'Budget', type: 'number' });
    expect(f.data.key).toBe('budget');
    const up = await t.api.patch(`/api/contacts/${c.id}`, { custom: { budget: '5000' }, tags: ['x', 'y'] });
    expect(up.data.custom.budget).toBe('5000');
    expect(up.data.tags).toEqual(['x', 'y']);
    const tags = (await t.api.get('/api/tags')).data;
    const x = tags.find((tg: any) => tg.name === 'x');
    expect(x.count).toBe(1);
    await t.api.del(`/api/tags/${x.id}`);
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.tags).toEqual(['y']);
  });
});

describe('pipelines', () => {
  it('moves opportunities between stages and emits events', async () => {
    const [p] = (await t.api.get('/api/pipelines')).data;
    expect(p.stages.length).toBe(5);
    const o = await t.api.post('/api/opportunities', { pipeline_id: p.id, contact: { email: 'deal@x.de', first_name: 'Deal' }, value: 1500 });
    expect(o.data.stage_id).toBe(p.stages[0].id);
    const moved = await t.api.patch(`/api/opportunities/${o.data.id}`, { stage_id: p.stages[2].id });
    expect(moved.data.stage_id).toBe(p.stages[2].id);
    expect((await t.api.patch(`/api/opportunities/${o.data.id}`, { stage_id: 'nope' })).status).toBe(400);
    const won = await t.api.patch(`/api/opportunities/${o.data.id}`, { status: 'won' });
    expect(won.data.status).toBe('won');
    const dash = await t.api.get('/api/dashboard');
    expect(dash.data.opportunities.won).toBe(1);
  });
});

describe('calendars & booking', () => {
  it('books through the public page, rejects double booking, cancels', async () => {
    const cal = (
      await t.api.post('/api/calendars', {
        name: 'Erstgespräch',
        duration: 30,
        min_notice: 0,
        availability: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]])),
        settings: { reminder_hours: 0 },
      })
    ).data;
    expect(cal.slug).toBe('erstgesprach');
    const page = await t.api.get(`/book/${cal.slug}`);
    expect(page.status).toBe(200);
    expect(page.data).toContain('Erstgespräch');
    const slots = (await t.api.get(`/api/public/calendars/${cal.slug}/slots?days=2`)).data;
    const start = slots.days.flatMap((d: any) => d.slots)[0];
    expect(start).toBeTruthy();
    const book = await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start, first_name: 'Bea', email: 'bea@x.de' });
    expect(book.status).toBe(200);
    expect((await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start, first_name: 'Zweit', email: 'z@x.de' })).status).toBe(409);
    await flush();
    const appts = (await t.api.get('/api/appointments')).data;
    expect(appts).toHaveLength(1);
    // Confirmation email went into Bea's conversation ('log' provider records it).
    const msgs = (await t.api.get(`/api/contacts/${appts[0].contact_id}/messages`)).data;
    expect(msgs[0].subject).toContain('Termin bestätigt');
    const ics = await t.api.get(book.data.icsUrl);
    expect(ics.data).toContain('BEGIN:VEVENT');
    const token = book.data.manageUrl.split('/').pop();
    expect((await t.api.post(`/api/public/appointments/${token}/cancel`)).status).toBe(200);
    expect((await t.api.get('/api/appointments')).data[0].status).toBe('cancelled');
  });
});

describe('forms → workflow automation', () => {
  it('submitting a form creates the lead and runs the workflow with a wait', async () => {
    const form = (await t.api.post('/api/forms', { name: 'Kontakt', settings: { tags: ['website'] } })).data;
    const wf = (await t.api.post('/api/workflows', { recipe: 'new_lead' })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active', trigger: { type: 'form.submitted', config: { form_id: form.id } } });

    const pub = await t.api.get(`/f/${form.id}`);
    expect(pub.data).toContain('pghl-form');
    expect((await t.api.post(`/api/public/forms/${form.id}/submit`, { first_name: 'Lea' })).status).toBe(400);
    const sub = await t.api.post(`/api/public/forms/${form.id}/submit`, { first_name: 'Lea', email: 'lea@x.de', message: 'Hallo', consent: 'ja', _utm_source: 'google' });
    expect(sub.status).toBe(200);
    await flush();

    const lea = (await t.api.get(`/api/contacts/${sub.data.contactId}`)).data;
    expect(lea.tags).toEqual(expect.arrayContaining(['website', 'lead']));
    const msgs = (await t.api.get(`/api/contacts/${lea.id}/messages`)).data;
    expect(msgs.some((m: any) => m.subject.includes('Danke für deine Anfrage, Lea'))).toBe(true);

    const runs = (await t.api.get(`/api/workflows/${wf.id}/runs`)).data;
    expect(runs.runs[0].status).toBe('waiting');
    // Pretend two days passed: the run continues with the goal check and the follow-up.
    t.app.db.run(`UPDATE workflow_runs SET next_run_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), runs.runs[0].id);
    await t.app.tick();
    const after = (await t.api.get(`/api/workflows/${wf.id}/runs`)).data.runs[0];
    expect(after.status).toBe('completed');
    const msgs2 = (await t.api.get(`/api/contacts/${lea.id}/messages`)).data;
    expect(msgs2.some((m: any) => m.subject === 'Kurze Rückfrage')).toBe(true);
    const subs = (await t.api.get(`/api/forms/${form.id}/submissions`)).data;
    expect(subs[0].meta.utm_source).toBe('google');
  });

  it('if/else branches and the goal step', async () => {
    const wf = (
      await t.api.post('/api/workflows', {
        name: 'VIP',
        trigger: { type: 'contact.tag_added', config: { tag: 'check' } },
        steps: [
          { type: 'if', conditions: [{ field: 'tag', op: 'has', value: 'vip' }], then: [{ type: 'add_tag', tags: ['ist-vip'] }], else: [{ type: 'add_tag', tags: ['kein-vip'] }] },
          { type: 'create_task', title: 'Prüfen: {{contact.email}}' },
        ],
      })
    ).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const vip = (await t.api.post('/api/contacts', { email: 'v@x.de', tags: ['vip'] })).data;
    const norm = (await t.api.post('/api/contacts', { email: 'n@x.de' })).data;
    await t.api.post(`/api/contacts/${vip.id}/tags`, { add: ['check'] });
    await t.api.post(`/api/contacts/${norm.id}/tags`, { add: ['check'] });
    await flush();
    expect((await t.api.get(`/api/contacts/${vip.id}`)).data.tags).toContain('ist-vip');
    expect((await t.api.get(`/api/contacts/${norm.id}`)).data.tags).toContain('kein-vip');
    const tasks = (await t.api.get('/api/tasks')).data;
    expect(tasks.some((x: any) => x.title === 'Prüfen: v@x.de')).toBe(true);
  });

  it('webhook trigger and manual enroll', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Hook', trigger: { type: 'webhook' }, steps: [{ type: 'add_tag', tags: ['via-hook'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const url = new URL(wf.webhook_url);
    const r = await t.api.post(url.pathname + url.search, { email: 'hook@x.de', first_name: 'Hook' });
    expect(r.data.enrolled).toBe(true);
    expect((await t.api.get(`/api/contacts/${r.data.contactId}`)).data.tags).toContain('via-hook');
    expect((await t.api.post(`/hooks/workflow/${wf.id}?key=falsch`, {})).status).toBe(404);
    // Runs that were left 'running' are not processed twice.
    expect(await processRun(t.app, 'does-not-exist')).toBeUndefined();
  });
});

describe('conversations', () => {
  it('sends, receives via webhook and honours DND', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'chat@x.de', phone: '+4915112345' })).data;
    const m = await t.api.post('/api/messages', { contact_id: c.id, channel: 'sms', body: 'Hallo!' });
    expect(m.data.status).toBe('logged');
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const u = new URL(urls.sms);
    const inbound = await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'From=%2B4915112345&Body=STOP' });
    expect(inbound.status).toBe(200);
    expect(await inbound.text()).toContain('<Response>');
    const convs = (await t.api.get('/api/conversations')).data;
    const conv = convs.find((x: any) => x.contact_id === c.id);
    expect(conv.unread).toBe(1);
    const thread = (await t.api.get(`/api/conversations/${conv.id}/messages`)).data;
    expect(thread.messages.map((x: any) => x.direction)).toEqual(['out', 'in']);
    expect(thread.contact.dnd).toBe(1);
    const blocked = await t.api.post('/api/messages', { contact_id: c.id, channel: 'sms', body: 'Noch was' });
    expect(blocked.data.status).toBe('failed');
    expect((await t.api.raw(`${u.pathname}?key=falsch`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('unsubscribe link sets DND', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'unsub@x.de' })).data;
    await t.api.post('/api/messages', { contact_id: c.id, channel: 'email', subject: 'Hi', body: 'Text' });
    const { unsubscribeToken } = await import('../server/services/messaging.js');
    const link = `/u/${c.id}/${unsubscribeToken(t.app, c.id)}`;
    // opening the link only asks (link scanners fetch every link of a mail); the button unsubscribes
    expect((await t.api.get(link)).data).toContain('Ja, abmelden');
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.dnd).toBe(0);
    const r = await t.api.raw(link, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' });
    expect(await r.text()).toContain('Abgemeldet');
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.dnd).toBe(1);
    expect((await t.api.get(link)).data).toContain('Abgemeldet');
    expect((await t.api.get(`/u/${c.id}/falsch`)).data).toContain('ungültig');
  });
});

describe('campaigns', () => {
  it('sends to a tag segment, skipping DND', async () => {
    await t.api.post('/api/contacts', { email: 'nl1@x.de', first_name: 'Eins', tags: ['newsletter'] });
    await t.api.post('/api/contacts', { email: 'nl2@x.de', tags: ['newsletter'], dnd: true });
    const c = (await t.api.post('/api/campaigns', { name: 'Herbst', subject: 'Hallo {{contact.first_name|du}}', body: 'Neuigkeiten!', filter: { tags: ['newsletter'] } })).data;
    const aud = await t.api.post(`/api/campaigns/${c.id}/audience`, { filter: { tags: ['newsletter'] } });
    expect(aud.data).toEqual({ total: 2, reachable: 1 });
    const sent = await t.api.post(`/api/campaigns/${c.id}/send`);
    expect(sent.data.recipients).toBe(1);
    expect(sent.data.status).toBe('sent');
    const rec = (await t.api.get(`/api/campaigns/${c.id}/recipients`)).data;
    expect(rec[0].status).toBe('sent');
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { name: 'x' })).status).toBe(400);
  });

  it('schedules for later and sends on tick', async () => {
    const c = (await t.api.post('/api/campaigns', { name: 'Später', subject: 'S', body: 'B', filter: { tags: ['newsletter'] } })).data;
    await t.api.post(`/api/campaigns/${c.id}/send`, { scheduled_at: new Date(Date.now() - 1000).toISOString() });
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data.status).toBe('scheduled');
    await t.app.tick();
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data.status).toBe('sent');
  });
});

describe('payments', () => {
  it('creates, shares and marks invoices paid', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'kunde@x.de', first_name: 'Kunde' })).data;
    await t.api.patch('/api/location', { settings: { invoices: { iban: 'DE02120300000000202051' } } });
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, items: [{ name: 'Beratung', qty: 2, price_cents: 10000 }] })).data;
    // a draft has no number: it is given out (gap-free) when the invoice is finalised
    expect(inv.number).toBe('');
    expect(inv.total_cents).toBe(23800);
    expect((await t.api.get(new URL(inv.url).pathname)).status).toBe(404); // drafts stay private
    const sent = await t.api.post(`/api/invoices/${inv.id}/send`);
    expect(sent.data.status).toBe('sent');
    expect(sent.data.number).toBe('RE-1001');
    const pub = await t.api.get(new URL(inv.url).pathname);
    expect(pub.data).toContain('DE02120300000000202051');
    expect(pub.data).toContain('238,00');
    const paid = await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    expect(paid.data.paid_at).toBeTruthy();
    const next = (await t.api.post('/api/invoices', { contact_id: c.id, items: [{ name: 'X', price_cents: 100 }] })).data;
    expect((await t.api.post(`/api/invoices/${next.id}/finalise`)).data.number).toBe('RE-1002');
    expect((await t.api.del(`/api/invoices/${inv.id}`)).status).toBe(409);
  });

  it('estimates can be accepted publicly', async () => {
    const est = (await t.api.post('/api/invoices', { kind: 'estimate', items: [{ name: 'Paket', price_cents: 50000 }] })).data;
    await t.api.patch(`/api/invoices/${est.id}`, { status: 'sent' });
    const token = new URL(est.url).pathname.split('/').pop();
    expect((await t.api.post(`/api/public/invoices/${token}/accept`)).status).toBe(200);
    expect((await t.api.get(`/api/invoices/${est.id}`)).data.status).toBe('accepted');
  });
});

describe('reputation', () => {
  it('routes happy reviews to the public profile', async () => {
    await t.api.patch('/api/location', { settings: { reviews: { public_url: 'https://g.page/r/test', threshold: 4 } } });
    const c = (await t.api.post('/api/contacts', { email: 'rev@x.de' })).data;
    const req = (await t.api.post('/api/reviews/request', { contact_id: c.id })).data;
    expect((await t.api.get(`/r/${req.token}`)).data).toContain('★'.length ? '☆' : '');
    const r = await t.api.post(`/api/public/reviews/${req.token}`, { rating: 5, comment: 'Super!', public: true });
    expect(r.data.redirect).toBe('https://g.page/r/test');
    expect((await t.api.post(`/api/public/reviews/${req.token}`, { rating: 1 })).status).toBe(409);
    const widget = await t.api.get(`/r/widget/${t.api.location}`);
    expect(widget.data).toContain('Super!');
    expect((await t.api.get('/api/reviews')).data.stats.average).toBe(5);
  });
});

describe('funnels', () => {
  it('renders pages publicly and on a custom domain', async () => {
    const form = (await t.api.post('/api/forms', { name: 'Optin' })).data;
    const f = (await t.api.post('/api/funnels', { name: 'Leitfaden', template: 'leadmagnet' })).data;
    expect(f.pages).toHaveLength(2);
    const optin = f.pages[0];
    const blocks = optin.blocks.map((b: any) => (b.type === 'form' ? { ...b, form_id: form.id } : b));
    await t.api.patch(`/api/funnel-pages/${optin.id}`, { blocks, seo: { title: 'Gratis Leitfaden' } });
    const page = await t.api.get(`/p/${f.slug}`);
    expect(page.data).toContain('<title>Gratis Leitfaden</title>');
    expect(page.headers.get('content-security-policy')).toContain('sandbox');
    expect(page.data).toContain(`pf_${form.id}`);
    expect((await t.api.get(`/p/${f.slug}/danke`)).data).toContain('Danke!');
    await t.api.patch(`/api/funnels/${f.id}`, { domain: 'https://www.meine-seite.de/' });
    // fetch() can't set Host, so ask with plain http.
    const { request } = await import('node:http');
    const body = await new Promise<string>((resolve, reject) => {
      const u = new URL(t.base);
      request({ host: u.hostname, port: u.port, path: '/danke', headers: { host: 'www.meine-seite.de' } }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve(s));
      }).on('error', reject).end();
    });
    expect(body).toContain('Danke!');
    const list = (await t.api.get('/api/funnels')).data;
    expect(list.find((x: any) => x.id === f.id).views).toBe(3);
  });
});

describe('API keys & access', () => {
  it('lets an API key act on its sub-account only', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Zapier' })).data.key;
    const auth = { authorization: `Bearer ${key}` };
    const r = await t.api.raw('/api/contacts', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'api@x.de' }) });
    expect(r.status).toBe(200);
    expect((await r.json()).source).toBe('API');
    expect((await t.api.raw('/api/users', { headers: auth })).status).toBe(403);
    expect((await t.api.raw('/api/contacts', { headers: { authorization: 'Bearer falsch' } })).status).toBe(401);
  });

  it('keeps members out of other sub-accounts', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data;
    await t.api.post('/api/users', { email: 'mitarbeiter@x.de', password: 'passwort1', locations: [t.api.location] });
    const own = t.api.location;
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'mitarbeiter@x.de', password: 'passwort1' });
    expect((await t.api.get('/api/contacts')).status).toBe(200);
    t.api.setLocation(other.id);
    expect((await t.api.get('/api/contacts')).status).toBe(403);
    expect((await t.api.get('/api/users')).status).toBe(403);
    t.api.setLocation(own);
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
  });

  it('downloads a database backup (admin only)', async () => {
    const r = await t.api.raw('/api/admin/backup', { headers: { cookie: '' } });
    expect(r.status).toBe(401);
    const ok = await t.api.get('/api/admin/backup');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-disposition')).toContain('pghl-backup-');
  });

  it('never returns stored secrets', async () => {
    await t.api.patch('/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.x.de', user: 'u', pass: 'supergeheim' } } });
    const l = (await t.api.get('/api/location')).data;
    expect(l.settings.email.pass).toBe('••••••');
    // Saving the masked value back keeps the real one.
    await t.api.patch('/api/location', { settings: { email: { pass: '••••••', host: 'smtp.y.de' } } });
    expect(t.app.location(t.api.location)!.settings.email).toMatchObject({ pass: 'supergeheim', host: 'smtp.y.de' });
    await t.api.patch('/api/location', { settings: { email: { provider: 'log' } } });
  });
});

describe('GHL import', () => {
  it('maps GHL data and is idempotent', async () => {
    const fixtures: Record<string, any> = {
      '/locations/L1/customFields': { customFields: [{ id: 'cf1', name: 'Budget', fieldKey: 'contact.budget', dataType: 'NUMERICAL' }] },
      '/locations/L1/tags': { tags: [{ id: 't', name: 'ghl-tag' }] },
      '/contacts/': { contacts: [{ id: 'g1', firstName: 'Gina', email: 'gina@x.de', tags: ['ghl-tag'], customFields: [{ id: 'cf1', value: 900 }], dateAdded: '2025-01-01T00:00:00.000Z' }], meta: { total: 1 } },
      '/opportunities/pipelines': { pipelines: [{ id: 'p1', name: 'GHL Pipe', stages: [{ id: 's1', name: 'Neu' }, { id: 's2', name: 'Heiß' }] }] },
      '/opportunities/search': { opportunities: [{ id: 'o1', name: 'Gina Deal', monetaryValue: 1200, pipelineId: 'p1', pipelineStageId: 's2', status: 'open', contactId: 'g1' }], meta: {} },
      '/calendars/': { calendars: [{ id: 'c1', name: 'Beratung', slotDuration: 45, openHours: [{ daysOfTheWeek: [1, 2], hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 30 }] }] }] },
      '/calendars/events': { events: [{ id: 'e1', title: 'Termin Gina', startTime: '2030-01-07T09:00:00+01:00', endTime: '2030-01-07T09:45:00+01:00', contactId: 'g1', appointmentStatus: 'confirmed' }] },
    };
    const fakeFetch = (async (url: URL) => {
      const body = fixtures[url.pathname];
      return new Response(JSON.stringify(body ?? { message: 'nope' }), { status: body ? 200 : 404 });
    }) as unknown as typeof fetch;
    const client = new GhlClient('pit-test', fakeFetch, 0);
    const loc = t.api.location;
    const res = await importFromGhl(t.app, loc, client, 'L1', [...IMPORT_PARTS]);
    expect(res.counts).toMatchObject({ custom_fields: 1, tags: 1, contacts: 1, pipelines: 1, opportunities: 1, calendars: 1, appointments: 1 });
    await importFromGhl(t.app, loc, client, 'L1', [...IMPORT_PARTS]);
    const gina = (await t.api.get('/api/contacts?q=gina')).data;
    expect(gina.total).toBe(1);
    expect(gina.contacts[0].custom.budget).toBe(900);
    const pipes = (await t.api.get('/api/pipelines')).data.filter((p: any) => p.name === 'GHL Pipe');
    expect(pipes).toHaveLength(1);
    const opps = (await t.api.get(`/api/opportunities?pipeline_id=${pipes[0].id}`)).data;
    expect(opps).toHaveLength(1);
    expect(opps[0].stage_id).toBe(pipes[0].stages[1].id);
    const cal = (await t.api.get('/api/calendars')).data.find((c: any) => c.name === 'Beratung');
    expect(cal.availability).toEqual({ mon: [['09:00', '12:30']], tue: [['09:00', '12:30']] });
    expect(cal.duration).toBe(45);
  });
});
