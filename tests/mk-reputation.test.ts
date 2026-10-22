import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { id as newId } from '../server/core/util.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString();

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(async () => t.close());

const campaign = async (tag: string) => (await t.api.post('/api/campaigns', { name: `Kampagne ${tag}`, subject: `Betreff ${tag}`, body: 'Hallo', filter: { tags: [tag] } })).data;

/** Messages of a finished campaign written straight into the tables (fast, any status): one contact per row. */
function seedSent(campaignId: string, rows: { email: string; status: string; opened?: boolean; at?: string }[]) {
  t.app.db.tx(() => {
    for (const r of rows) {
      const cid = newId();
      const mid = newId();
      const at = r.at ?? new Date().toISOString();
      t.app.db.insert('contacts', { id: cid, location_id: loc, email: r.email, first_name: 'x', created_at: at, updated_at: at });
      t.app.db.insert('conversations', { id: `cv-${cid}`, location_id: loc, contact_id: cid, unread: 0, last_message_at: at, created_at: at });
      t.app.db.insert('messages', { id: mid, location_id: loc, conversation_id: `cv-${cid}`, contact_id: cid, channel: 'email', direction: 'out', subject: 's', body: 'b', status: r.status, error: '', source: 'Kampagne: seed', created_at: at, opened_at: r.opened ? at : null });
      t.app.db.insert('campaign_recipients', { campaign_id: campaignId, contact_id: cid, status: 'sent', message_id: mid, sent_at: at, variant: '' });
    }
  });
}

describe('reputation dashboard', () => {
  let campA = '';
  let campB = '';
  it('shows the rates per campaign, recipient domain and week, with warnings', async () => {
    campA = (await campaign('repA')).id;
    campB = (await campaign('repB')).id;
    // Distinct send dates, so "newest first" has one right answer (B's mails went out 10 days ago, A's 2 days ago).
    t.app.db.run(`UPDATE campaigns SET status = 'sent', sent_at = ? WHERE id = ?`, iso(2), campA);
    t.app.db.run(`UPDATE campaigns SET status = 'sent', sent_at = ? WHERE id = ?`, iso(10), campB);
    // Campaign A: healthy (1000 sent at gmail/gmx, 5 bounces, 1 complaint). Campaign B: trouble (300 sent, 30 bounces, 3 complaints).
    seedSent(campA, [
      ...Array.from({ length: 600 }, (_, i) => ({ email: `a${i}@gmail.com`, status: i < 3 ? 'bounced' : 'delivered', opened: i % 3 === 0 })),
      ...Array.from({ length: 400 }, (_, i) => ({ email: `a${i}@gmx.de`, status: i === 0 ? 'complained' : i < 3 ? 'bounced' : 'sent', opened: i % 4 === 0 })),
    ]);
    seedSent(campB, Array.from({ length: 300 }, (_, i) => ({ email: `b${i}@web.de`, status: i < 30 ? 'bounced' : i < 33 ? 'complained' : 'sent', at: iso(10) })));
    // Mails that never left (failed) do not count at all.
    seedSent(campA, [{ email: 'weg@gmail.com', status: 'failed' }]);
    // Unsubscribes after a mail count for the campaign of the last mail the contact got.
    const unsub = t.app.db.all<{ contact_id: string }>(`SELECT r.contact_id FROM campaign_recipients r WHERE r.campaign_id = ? LIMIT 8`, campB);
    for (const u of unsub) t.app.db.insert('activities', { id: newId(), location_id: loc, contact_id: u.contact_id, type: 'contact.unsubscribed', summary: 'x', data: {}, created_at: iso(9) });
    // An unsubscribe weeks after the mail belongs to no campaign.
    const late = t.app.db.get<{ contact_id: string }>(`SELECT contact_id FROM campaign_recipients WHERE campaign_id = ? LIMIT 1 OFFSET 20`, campB)!;
    t.app.db.insert('activities', { id: newId(), location_id: loc, contact_id: late.contact_id, type: 'contact.unsubscribed', summary: 'x', data: {}, created_at: iso(1) });

    const r = (await t.api.get('/api/deliverability/reputation?days=90')).data;
    expect(r.days).toBe(90);
    expect(r.totals).toMatchObject({ sent: 1300, bounced: 35, complained: 4, unsubscribed: 8 });
    expect(r.totals.level).toBe('critical'); // 4 complaints in 1300 mails = 0.31 %, just over the Gmail/Yahoo limit
    const a = r.by_campaign.find((c: any) => c.campaign_id === campA);
    const b = r.by_campaign.find((c: any) => c.campaign_id === campB);
    expect(a).toMatchObject({ sent: 1000, bounced: 5, complained: 1, level: 'warn' });
    expect(a.issues.map((i: any) => i.metric)).toEqual(['complaint']); // 0.1 % = warn, 0.5 % bounce is fine
    expect(b).toMatchObject({ sent: 300, bounced: 30, complained: 3, unsubscribed: 8, level: 'critical' });
    expect(b.issues.map((i: any) => i.metric).sort()).toEqual(['bounce', 'complaint', 'unsubscribe']);
    expect(r.by_campaign[0].campaign_id).toBe(campA); // newest first
    const dom = Object.fromEntries(r.by_domain.map((d: any) => [d.label, d]));
    expect(dom['gmail.com']).toMatchObject({ sent: 600, bounced: 3 });
    expect(dom['gmx.de']).toMatchObject({ sent: 400, bounced: 2, complained: 1 });
    expect(dom['web.de']).toMatchObject({ sent: 300, bounced: 30, level: 'critical' });
    expect(r.by_domain[0].label).toBe('gmail.com'); // biggest first
    // two weeks: the mails of 10 days ago and of 2 days ago (unless they fall into one calendar week)
    expect(r.by_week.reduce((n: number, w: any) => n + w.sent, 0)).toBe(1300);
    expect(r.by_week.length).toBeGreaterThanOrEqual(1);
    expect(r.warnings[0].level).toBe('critical');
    expect(r.warnings.map((w: any) => w.text).join('\n')).toContain('Kampagne „Kampagne repB“');
    expect(r.warnings.map((w: any) => w.text).join('\n')).toContain('Empfänger bei web.de');
    for (const w of r.warnings) expect(w.tip.length).toBeGreaterThan(20);
    expect(r.thresholds.complaint).toMatchObject({ warn: 0.001, critical: 0.003 });
  });

  it('a short window leaves out older campaigns', async () => {
    const r = (await t.api.get('/api/deliverability/reputation?days=7')).data;
    expect(r.days).toBe(7);
    expect(r.by_campaign.map((c: any) => c.campaign_id)).toEqual([campA]);
    expect(r.totals.sent).toBe(1000);
    expect((await t.api.get('/api/deliverability/reputation?days=1')).data.days).toBe(7);
  });

  it('shows the verdict on the campaign page', async () => {
    const c = (await t.api.get(`/api/campaigns/${campA}`)).data;
    expect(c.reputation.level).toBe('warn');
    expect(c.reputation.text).toContain('Spam-Beschwerden');
  });

  it('other sub-accounts see nothing of it', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
    t.api.setLocation(other);
    const r = (await t.api.get('/api/deliverability/reputation')).data;
    expect(r.totals.sent).toBe(0);
    expect(r.by_campaign).toEqual([]);
    expect(r.totals.level).toBe('few');
    t.api.setLocation(loc);
  });
});

describe('reputation and the warm-up plan', () => {
  it('halves the cap when the reputation is critical', async () => {
    await t.api.post('/api/deliverability/warmup', { plan: 'standard' });
    const camp = await campaign('trouble');
    // 200 mails with 2 % complaints in the last days – far above the limit.
    seedSent(camp.id, Array.from({ length: 200 }, (_, i) => ({ email: `tr${i}@gmail.com`, status: i < 4 ? 'complained' : 'sent' })));
    const s = (await t.api.get('/api/deliverability/warmup')).data.state;
    expect(s).toMatchObject({ reduced: true, cap: 25 });
    await t.api.del('/api/deliverability/warmup');
  });
});
