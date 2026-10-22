import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { KEY, WHSEC, cloudKit, createStripe } from './cloud-fakes.js';
import { eraseTenant, logCloudEvent } from '../server/modules/cloud.js';

/** Cloud lifecycle → the operator's HQ sub-account (modules/cloud-hq-bridge.ts, docs/cloud.md#cloud--hq-crm-bridge). */

const stripe = createStripe();
let t: Awaited<ReturnType<typeof startTestApp>>;
const mails: any[] = [];
let hq = '';

beforeAll(async () => {
  stripe.install();
  t = await startTestApp({ cloudMode: true });
  await t.setup();
  t.app.services.cloudMailer = async (_loc: any, mail: any) => (mails.push(mail), { status: 'logged' });
  t.app.services.cloudFormMinMs = 0;
  await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC });
  // The operator's own HQ, set up with the template.
  hq = (await t.api.post('/api/locations', { name: 'HQ' })).data.id;
  const r = await t.api.post('/api/snapshot-templates/saas-hq/apply', { location_id: hq });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
});
afterAll(async () => {
  delete process.env.PGHL_HQ_LOCATION;
  stripe.uninstall();
  await t.close();
});

const { createCustomer } = cloudKit(() => t, stripe, mails);
const db = () => t.app.db;
const hqContact = (tid: string) => {
  const l = db().get('SELECT * FROM cloud_hq_links WHERE tenant_id = ?', tid);
  return l ? { link: l, contact: db().get('SELECT * FROM contacts WHERE id = ?', l.contact_id), opp: db().get('SELECT * FROM opportunities WHERE id = ?', l.opportunity_id) } : null;
};
const stageName = (opp: any) => JSON.parse(db().get('SELECT stages FROM pipelines WHERE id = ?', opp.pipeline_id).stages).find((s: any) => s.id === opp.stage_id).name;

describe('cloud → HQ bridge', () => {
  it('does nothing without PGHL_HQ_LOCATION', async () => {
    delete process.env.PGHL_HQ_LOCATION;
    const c = await createCustomer({ company: 'Ohne Brücke GmbH', email: 'ohne@example.com' });
    expect(hqContact(c.tenantId)).toBeNull();
  });

  it('refuses a customer sub-account as HQ', async () => {
    const c = await createCustomer({ company: 'Fremd GmbH', email: 'fremd@example.com' });
    process.env.PGHL_HQ_LOCATION = c.loc;
    logCloudEvent(t.app, c.tenantId, 'plan_changed', 'x');
    expect(hqContact(c.tenantId)).toBeNull();
  });

  it('follows a tenant from signup to erasure', async () => {
    process.env.PGHL_HQ_LOCATION = hq;
    const c = await createCustomer({ company: 'Muster Software GmbH', email: 'mia@muster.example', plan: 'solo' });
    // signup with a trial → contact + opportunity in „Testphase“
    let h = hqContact(c.tenantId)!;
    expect(h.contact).toMatchObject({ location_id: hq, email: 'mia@muster.example', company: 'Muster Software GmbH', first_name: 'Mia', last_name: 'Muster', source: 'Cloud-Anmeldung' });
    expect(JSON.parse(h.contact.tags)).toContain('status:testphase');
    const custom = JSON.parse(h.contact.custom);
    expect(custom).toMatchObject({ plan: 'Solo', intervall: 'Monatlich', cloud_konto: c.tenantId, quelle: 'Cloud-Anmeldung', mrr: 0 });
    expect(custom.testphase_ende).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stageName(h.opp)).toBe('Testphase');
    expect(h.opp.value).toBeGreaterThan(0);
    // no other personal data travels
    expect(h.contact.phone).toBe('');

    // trial converts → Kunde with MRR
    db().run(`UPDATE saas_subscriptions SET status = 'active', trial_end = NULL WHERE location_id = ?`, c.loc);
    logCloudEvent(t.app, c.tenantId, 'trial_converted', 'Cloud Solo');
    h = hqContact(c.tenantId)!;
    expect(stageName(h.opp)).toBe('Kunde');
    expect(JSON.parse(h.contact.tags)).toEqual(expect.arrayContaining(['status:kunde']));
    expect(JSON.parse(h.contact.tags)).not.toContain('status:testphase');
    expect(JSON.parse(h.contact.custom).mrr).toBe(h.opp.value);

    // dunning → tag, recovered → tag gone
    logCloudEvent(t.app, c.tenantId, 'payment_failed', 'Rechnung 1');
    expect(JSON.parse(hqContact(c.tenantId)!.contact.tags)).toContain('zahlung:offen');
    logCloudEvent(t.app, c.tenantId, 'payment_recovered', 'Rechnung 1');
    expect(JSON.parse(hqContact(c.tenantId)!.contact.tags)).not.toContain('zahlung:offen');

    // cancelled → Gekündigt, same contact and opportunity (no duplicates)
    db().run(`UPDATE saas_subscriptions SET status = 'canceled' WHERE location_id = ?`, c.loc);
    db().run(`UPDATE cloud_tenants SET cancel_reason = 'price' WHERE id = ?`, c.tenantId);
    logCloudEvent(t.app, c.tenantId, 'canceled', '');
    h = hqContact(c.tenantId)!;
    expect(stageName(h.opp)).toBe('Gekündigt / Rückgewinnung');
    expect(JSON.parse(h.contact.tags)).toContain('status:gekuendigt');
    expect(JSON.parse(h.contact.custom)).toMatchObject({ kuendigungsgrund: 'price', mrr: 0 });
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE location_id = ? AND email = ?', hq, 'mia@muster.example')!.n).toBe(1);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM opportunities WHERE location_id = ? AND contact_id = ?', hq, h.contact.id)!.n).toBe(1);
    expect(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'cloud.lifecycle'`, h.contact.id)!.n).toBeGreaterThanOrEqual(4);

    // GDPR: the account is erased → the HQ contact is anonymised, the numbers stay
    const tenant = db().get('SELECT * FROM cloud_tenants WHERE id = ?', c.tenantId);
    await eraseTenant(t.app, tenant, 'Test');
    h = hqContact(c.tenantId)!;
    expect(h.contact).toMatchObject({ email: '', company: '', last_name: '', phone: '' });
    expect(h.contact.first_name).toMatch(/^Gelöschtes Cloud-Konto/);
    expect(JSON.stringify(h.contact)).not.toMatch(/Muster|mia@/);
    expect(JSON.parse(h.contact.custom)).toMatchObject({ plan: 'Solo', cloud_konto: c.tenantId });
    expect(h.opp.name).toMatch(/^Gelöschtes Cloud-Konto/);
    expect(stageName(h.opp)).toBe('Gekündigt / Rückgewinnung');
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM activities WHERE contact_id = ?', h.contact.id)!.n).toBe(0);
  });
});
