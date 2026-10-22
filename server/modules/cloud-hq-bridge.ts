import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { now } from '../core/util.js';
import { PLAN_INFO } from '../services/cloud.js';
import { addTags, getContact, logActivity, removeTags, upsertContact } from '../services/contacts.js';
import { LIFECYCLE_PIPELINE, STAGE, TAG } from '../services/hq-template.js';
import { createOpportunity, updateOpportunity } from '../services/opportunities.js';
import { cloudEnabled, tenantPlanKey, tenantSub, type Tenant } from './cloud.js';
import { planById } from './saas.js';

/**
 * Cloud → HQ CRM bridge (dogfooding): the operator runs the cloud business in its own sub-account, set up with the
 * „Software- & SaaS-Firma (HQ)“ template. With `PGHL_CLOUD_MODE=1` and `PGHL_HQ_LOCATION=<sub-account id>`, every tenant
 * lifecycle event (modules/cloud.ts → `app.services.cloudEventTaps`) creates or updates one contact and one opportunity in
 * the pipeline „Kunden (Cloud)“ (Warteliste → Testphase → Kunde → Gekündigt / Rückgewinnung):
 *
 * - stage from the subscription status (trialing → Testphase, active/past_due → Kunde, canceled or an unpaid trial → Gekündigt),
 * - tags status:testphase / status:kunde / status:gekuendigt plus zahlung:offen, kuendigung:vorgemerkt, loeschung:geplant …
 *   (the HQ workflows react to the status tags once they are active),
 * - fields plan, MRR, interval (Abrechnung), source (Quelle) and the cloud account id – nothing else: e-mail, company and the
 *   owner's name are the only personal data copied,
 * - a timeline line per event.
 *
 * GDPR: when a tenant is erased (event `deleted`), the HQ contact is anonymised – personal fields, notes, tasks, messages and
 * timeline go; plan, MRR, dates and the pseudonymous account id stay for the numbers (like the cloud's own tombstone).
 * The HQ sub-account must not be a customer's: a tenant location is refused. See docs/cloud.md#cloud--hq-crm-bridge.
 */

type Rule = { add?: string[]; remove?: string[]; label: string };

const PAY = 'zahlung:offen';
const CANCEL = 'kuendigung:vorgemerkt';
const DELETION = 'loeschung:geplant';
const ENDING = 'testphase:endet-bald';

const RULES: Record<string, Rule> = {
  provisioned: { label: 'Cloud-Konto angelegt' },
  trial_started: { label: 'Testphase gestartet' },
  trial_extended: { remove: [ENDING], label: 'Testphase verlängert' },
  trial_ending: { add: [ENDING], label: 'Testphase endet in wenigen Tagen' },
  trial_expired: { remove: [ENDING], label: 'Testphase ohne Abo abgelaufen' },
  trial_converted: { remove: [ENDING], label: 'Testphase → Abo' },
  subscribed: { remove: [ENDING], label: 'Abo abgeschlossen' },
  plan_changed: { label: 'Tarif gewechselt' },
  payment_failed: { add: [PAY], label: 'Zahlung fehlgeschlagen (Mahnlauf)' },
  read_only: { add: [PAY], label: 'Konto schreibgeschützt (unbezahlt)' },
  payment_recovered: { remove: [PAY], label: 'Zahlung eingegangen' },
  reactivated: { remove: [PAY], label: 'Konto wieder aktiv' },
  cancel_scheduled: { add: [CANCEL], label: 'Kündigung zum Laufzeitende vorgemerkt' },
  cancel_undone: { remove: [CANCEL], label: 'Kündigung zurückgenommen' },
  canceled: { remove: [CANCEL], label: 'Abo beendet' },
  deletion_scheduled: { add: [DELETION], label: 'Löschung des Kontos geplant' },
  deletion_undone: { remove: [DELETION], label: 'Löschung zurückgenommen' },
};

const PLAN_FIELD: Record<string, string> = { solo: 'Solo', team: 'Team & Company', agency: 'Agency' };

/** The operator's HQ sub-account, or null (bridge off). Never a customer's sub-account. */
export function hqLocation(app: App): string | null {
  const loc = (process.env.PGHL_HQ_LOCATION ?? '').trim();
  if (!loc || !cloudEnabled(app) || !app.location(loc)) return null;
  if (app.db.get('SELECT 1 AS x FROM cloud_locations WHERE location_id = ?', loc)) return null;
  return loc;
}

function lifecycle(app: App, loc: string) {
  const p = parseJson(app.db.get('SELECT * FROM pipelines WHERE location_id = ? AND name = ? ORDER BY created_at LIMIT 1', loc, LIFECYCLE_PIPELINE), ['stages']);
  if (!p) return null;
  const stages = p.stages as { id: string; name: string }[];
  const find = (sid: string, name: string) => stages.find((s) => s.id === sid)?.id ?? stages.find((s) => s.name.startsWith(name))?.id ?? stages[0]?.id;
  return { id: p.id as string, trial: find(STAGE.trial, 'Testphase'), customer: find(STAGE.customer, 'Kunde'), churn: find(STAGE.churn, 'Gekündigt') };
}

function link(app: App, tid: string) {
  return app.db.get<{ contact_id: string; opportunity_id: string | null }>('SELECT contact_id, opportunity_id FROM cloud_hq_links WHERE tenant_id = ?', tid);
}

/** What the HQ record should say about a tenant right now. */
function stateOf(app: App, t: Tenant) {
  const sub = tenantSub(app, t);
  const key = tenantPlanKey(app, t);
  const plan = sub ? planById(app, sub.plan_id) : undefined;
  const interval = sub?.interval ?? 'month';
  const monthly = plan ? Math.round(((interval === 'year' ? plan.price_year_cents / 12 : plan.price_month_cents) || 0) / 100) : 0;
  const status = sub?.status ?? 'canceled';
  const phase: 'trial' | 'customer' | 'churn' = status === 'trialing' ? 'trial' : status === 'active' || status === 'past_due' || (status === 'paused' && t.converted_at) ? 'customer' : 'churn';
  return { key, planName: PLAN_INFO[key]?.name ?? key, interval, monthly, paying: status === 'active' || status === 'past_due', phase, trialEnd: sub?.trial_end ?? null };
}

const STATUS_TAG = { trial: TAG.trial, customer: TAG.customer, churn: TAG.churn } as const;

export function syncTenant(app: App, tid: string, type: string, detail = '') {
  const loc = hqLocation(app);
  if (!loc) return;
  if (type === 'deleted') return anonymise(app, loc, tid);
  const rule = RULES[type];
  if (!rule) return;
  const t = app.db.get<Tenant>('SELECT * FROM cloud_tenants WHERE id = ?', tid);
  if (!t || t.deleted_at || t.location_id === loc) return;
  const s = stateOf(app, t);
  const owner = t.owner_user_id ? app.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', t.owner_user_id) : undefined;
  const [first = '', ...rest] = String(owner?.name ?? '').trim().split(/\s+/);
  const custom: Record<string, any> = { plan: PLAN_FIELD[s.key] ?? s.planName, mrr: s.paying ? s.monthly : 0, intervall: s.interval === 'year' ? 'Jährlich' : 'Monatlich', cloud_konto: t.id };
  if (s.trialEnd) custom.testphase_ende = s.trialEnd.slice(0, 10);
  if (type === 'canceled' && t.cancel_reason) custom.kuendigungsgrund = t.cancel_reason;
  const known = link(app, tid);
  const existing = known ? getContact(app, loc, known.contact_id) : undefined;
  // Only fields the HQ needs; the e-mail matches a waitlist contact from the landing page (its source stays).
  const { contact, created } = upsertContact(app, loc, { ...(existing ? { id: existing.id } : {}), email: t.email, company: t.name, ...(first && !existing?.first_name ? { first_name: first, last_name: rest.join(' ') } : {}), custom }, { source: 'Cloud-Anmeldung', quiet: true });
  if (created || !contact.custom?.quelle) app.db.update('contacts', contact.id, { custom: { ...contact.custom, quelle: contact.source === 'Landingpage' ? 'Landingpage' : 'Cloud-Anmeldung' } });
  const statusTag = STATUS_TAG[s.phase];
  removeTags(app, loc, contact.id, [...Object.values(STATUS_TAG).filter((x) => x !== statusTag), TAG.wait, ...(rule.remove ?? [])]);
  addTags(app, loc, contact.id, [statusTag, ...(rule.add ?? [])]);
  const p = lifecycle(app, loc);
  let oppId = known?.opportunity_id ?? null;
  if (p) {
    const stage = p[s.phase];
    const cur = oppId ? app.db.get<{ id: string }>('SELECT id FROM opportunities WHERE id = ? AND location_id = ?', oppId, loc) : undefined;
    if (cur) updateOpportunity(app, loc, cur.id, { pipeline_id: p.id, stage_id: stage, value: s.monthly, name: `${t.name} · ${s.planName}` });
    else oppId = createOpportunity(app, loc, { pipeline_id: p.id, stage_id: stage, contact_id: contact.id, name: `${t.name} · ${s.planName}`, value: s.monthly, source: 'Cloud' }).id;
  }
  logActivity(app, loc, contact.id, 'cloud.lifecycle', `Cloud: ${rule.label} – ${s.planName}, ${s.interval === 'year' ? 'jährlich' : 'monatlich'}${detail && type === 'plan_changed' ? ` (${detail})` : ''}`, { tenant: t.id, event: type });
  app.db.run(
    `INSERT INTO cloud_hq_links (tenant_id, location_id, contact_id, opportunity_id, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET location_id = excluded.location_id, contact_id = excluded.contact_id, opportunity_id = excluded.opportunity_id, updated_at = excluded.updated_at`,
    t.id,
    loc,
    contact.id,
    oppId,
    now(),
  );
}

const PERSONAL_TABLES = ['notes', 'tasks', 'messages', 'conversations', 'activities', 'form_submissions'];

/** The cloud account was erased: the HQ record keeps the numbers, not the person. */
function anonymise(app: App, loc: string, tid: string) {
  const l = link(app, tid);
  if (!l) return;
  const c = getContact(app, loc, l.contact_id);
  if (c) {
    const label = `Gelöschtes Cloud-Konto ${tid.slice(0, 8)}`;
    const keep = ['plan', 'mrr', 'intervall', 'quelle', 'testphase_ende', 'cloud_konto', 'kuendigungsgrund'];
    const custom = Object.fromEntries(Object.entries(c.custom ?? {}).filter(([k]) => keep.includes(k)));
    app.db.update('contacts', c.id, { first_name: label, last_name: '', email: '', phone: '', company: '', address: '', city: '', postal_code: '', country: '', website: '', date_of_birth: null, custom, dnd: 1, updated_at: now() });
    for (const tbl of PERSONAL_TABLES) {
      const cols = app.db.all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, tbl).map((r) => r.name);
      if (cols.includes('contact_id') && cols.includes('location_id')) app.db.run(`DELETE FROM "${tbl}" WHERE contact_id = ? AND location_id = ?`, c.id, loc);
    }
    if (l.opportunity_id) app.db.run('UPDATE opportunities SET name = ? WHERE id = ? AND location_id = ?', label, l.opportunity_id, loc);
  }
  app.db.run('UPDATE cloud_hq_links SET updated_at = ? WHERE tenant_id = ?', now(), tid);
}

export const cloudHqBridgeModule: Module = {
  name: 'cloud-hq-bridge',
  migrations: [
    [
      '001-init',
      `CREATE TABLE cloud_hq_links (
        tenant_id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL, opportunity_id TEXT, updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    app.services.cloudEventTaps = [...(app.services.cloudEventTaps ?? []), (a: App, tid: string, type: string, detail: string) => syncTenant(a, tid, type, detail)];
  },
};
