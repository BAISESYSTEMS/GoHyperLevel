import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/**
 * Bookkeeping that only prevents a trigger from firing twice is kept as long as the trigger can still see the record – not for
 * ever (one row per contact, workflow and year for the date triggers; per message, appointment, invoice and form for the scans).
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => t?.close());

const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

describe('trigger bookkeeping', () => {
  it('forgets the runs of date triggers after a year', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Geburtstag', trigger: { type: 'date.reached', config: { field: 'date_of_birth' } }, steps: [] })).data.id as string;
    const c = (await t.api.post('/api/contacts', { email: 'geb@example.com', date_of_birth: '1990-02-03' })).data.id as string;
    const fire = (occ: string, at: string) => t.app.db.run('INSERT INTO date_trigger_fires (workflow_id, contact_id, occurrence, created_at) VALUES (?, ?, ?, ?)', wf, c, occ, at);
    fire('2024-02-03', ago(600));
    fire('2025-02-03', ago(250));
    await t.app.tick();
    expect(t.app.db.all('SELECT occurrence FROM date_trigger_fires WHERE workflow_id = ?', wf)).toEqual([{ occurrence: '2025-02-03' }]);
  });

  it('forgets the "already fired" marks of the scan triggers once the scan can no longer see the record', async () => {
    const mark = (kind: string, key: string, days: number) => t.app.db.run('INSERT INTO wfx_fired (kind, key, at) VALUES (?, ?, ?)', kind, key, ago(days));
    mark('conversation.unanswered', 'wf:old', 30);
    mark('conversation.unanswered', 'wf:new', 2);
    mark('form.abandoned', 'wf:old', 30);
    mark('invoice.overdue', 'wf:old', 200);
    mark('invoice.overdue', 'wf:new', 100);
    mark('appointment.starts_soon', 'wf:old', 500);
    mark('date-seen', 'wf', 900); // the date scan's own position stays
    await t.app.services.wfxRunScans(new Date());
    expect(t.app.db.all('SELECT kind, key FROM wfx_fired ORDER BY kind, key')).toEqual([
      { kind: 'conversation.unanswered', key: 'wf:new' },
      { kind: 'date-seen', key: 'wf' },
      { kind: 'invoice.overdue', key: 'wf:new' },
    ]);
  });
});

describe('affiliate clicks', () => {
  it('keep the visitor id and the address hash only as long as they are needed to tell a repeated click (two days)', async () => {
    const program = (await t.api.post('/api/affiliates/programs', { name: 'Partner' })).data.id as string;
    const aff = (await t.api.post('/api/affiliates', { program_id: program, name: 'Pia', email: 'pia@example.com' })).data.id as string;
    const click = (id: string, days: number) => t.app.db.insert('affiliate_clicks', { id, location_id: t.api.location, affiliate_id: aff, visitor_id: `v-${id}`, ip_hash: `h-${id}`, landing: 'https://example.com/', referrer: '', counted: 1, reason: '', created_at: ago(days) });
    click('alt', 5);
    click('neu', 0.5);
    // The clean-up runs once an hour (the tick of the first test counted): two hours later.
    pinClock(new Date(Date.now() + 2 * 3600_000).toISOString());
    try {
      await t.app.tick();
    } finally {
      unpinClock();
    }
    expect(t.app.db.all('SELECT id, visitor_id, ip_hash, counted FROM affiliate_clicks ORDER BY id')).toEqual([
      { id: 'alt', visitor_id: '', ip_hash: '', counted: 1 },
      { id: 'neu', visitor_id: 'v-neu', ip_hash: 'h-neu', counted: 1 },
    ]);
  });
});

describe('web hook samples', () => {
  it('REST hook samples and inbound request bodies of a hook that went quiet go after 30 days', async () => {
    const loc = t.api.location;
    const wf = (await t.api.post('/api/workflows', { name: 'Eingang', trigger: { type: 'webhook.received', config: {} }, steps: [] })).data.id as string;
    const sample = (id: string, days: number) => t.app.db.run('INSERT INTO rest_hook_samples (location_id, event, event_id, payload, created_at) VALUES (?, ?, ?, ?, ?)', loc, 'contact.created', id, '{"contact":{"email":"x@example.com"}}', ago(days));
    const capture = (id: string, days: number) => t.app.db.insert('inbound_webhook_captures', { id, workflow_id: wf, payload: '{"email":"x@example.com"}', signed: 0, created_at: ago(days) });
    sample('zz_sample_alt', 40);
    sample('zz_sample_neu', 3);
    capture('cap_alt', 40);
    capture('cap_neu', 3);
    // Both clean-ups run once an hour: later than the ticks of the tests before.
    pinClock(new Date(Date.now() + 5 * 3600_000).toISOString());
    try {
      await t.app.tick();
    } finally {
      unpinClock();
    }
    expect(t.app.db.all(`SELECT event_id FROM rest_hook_samples WHERE event_id LIKE 'zz_sample_%'`)).toEqual([{ event_id: 'zz_sample_neu' }]);
    expect(t.app.db.all('SELECT id FROM inbound_webhook_captures WHERE workflow_id = ?', wf)).toEqual([{ id: 'cap_neu' }]);
  });
});
