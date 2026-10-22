import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, num, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { registerActions, registerTriggers, text, type ActionDef, type TriggerMeta } from '../services/wfx-kit.js';
import { issueCodes } from './coupon-codes.js';
import type { Tool } from './mcp.js';

/**
 * Treuepunkte – customer loyalty for buyers (HighLevel "Loyalty", docs/store.md#loyalty-points): every paid invoice (store order,
 * buy link, booking, normal invoice) earns points per euro, lifetime points decide the tier, and points are exchanged for rewards –
 * a single-use discount code (modules/coupon-codes.ts) or a gift card (modules/giftcards.ts). A ledger per contact, workflow triggers
 * (points earned, tier reached) and a step to give or take points, MCP tools for the agent. Off until switched on.
 */

type Tier = { name: string; min_points: number };
type Reward = { id: string; name: string; points: number; kind: 'coupon' | 'gift_card'; product_id?: string; coupon_kind?: 'percent' | 'amount'; value: number };
type Settings = { enabled: boolean; points_per_euro: number; tiers: Tier[]; rewards: Reward[]; notify: boolean };

const DEFAULTS: Settings = {
  enabled: false,
  points_per_euro: 1,
  tiers: [
    { name: 'Bronze', min_points: 0 },
    { name: 'Silber', min_points: 500 },
    { name: 'Gold', min_points: 2000 },
  ],
  rewards: [],
  notify: false,
};

const TRIGGERS: TriggerMeta[] = [
  {
    type: 'loyalty.points_earned',
    label: 'Treuepunkte gutgeschrieben',
    category: 'payments',
    summary: 'Ein Kontakt hat Treuepunkte bekommen – durch eine bezahlte Rechnung, von Hand oder per Workflow.',
    doc: '{{event.points}} (diese Gutschrift), {{event.balance}} (Stand), {{event.lifetime}} (insgesamt gesammelt), {{event.tier}} und {{event.reason}} stehen im Ereignis.',
    fields: [],
    sample: { points: 120, balance: 620, lifetime: 820, tier: 'Silber', reason: 'Rechnung RE-2026-0042' },
    keywords: 'treuepunkte loyalty punkte kundenbindung bonus',
  },
  {
    type: 'loyalty.tier_reached',
    label: 'Treue-Stufe erreicht',
    category: 'payments',
    summary: 'Ein Kontakt hat mit seinen gesammelten Punkten eine neue Stufe erreicht (z. B. Silber oder Gold).',
    doc: '{{event.tier}} (neue Stufe), {{event.previous}} (vorher) und {{event.lifetime}} stehen im Ereignis – z. B. für eine Dankes-Mail mit Einmal-Rabattcode.',
    fields: [{ key: 'tier', label: 'Nur diese Stufe', type: 'text', help: 'Name der Stufe, leer = jede' }],
    sample: { tier: 'Gold', previous: 'Silber', lifetime: 2010 },
    keywords: 'treuestufe level gold silber vip loyalty',
  },
];

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

export const LOYALTY_TOOLS: Tool[] = [
  {
    name: 'ghl_loyalty_contact',
    title: 'Treuepunkte eines Kontakts',
    description: 'Punktestand, insgesamt gesammelte Punkte, Stufe, nächste Stufe, einlösbare Prämien und die letzten Buchungen eines Kontakts im Treueprogramm.',
    inputSchema: obj({ ...LOC, contact_id: { type: 'string' } }, ['location_id', 'contact_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/loyalty/contacts/${encodeURIComponent(a.contact_id)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_loyalty_adjust',
    title: 'Treuepunkte gutschreiben oder abziehen, Prämie einlösen',
    description: 'Schreibt einem Kontakt Punkte gut (positiv) oder zieht welche ab (negativ, nie unter 0) – mit Grund. Mit reward_id statt points löst du eine Prämie ein (Punkte werden abgezogen, es entsteht ein Einmal-Rabattcode oder Gutschein; den Code gibst du weiter).',
    inputSchema: obj({ ...LOC, contact_id: { type: 'string' }, points: { type: 'integer', minimum: -100000, maximum: 100000 }, reason: { type: 'string' }, reward_id: { type: 'string', description: 'Prämie einlösen (aus ghl_loyalty_contact)' } }, ['location_id', 'contact_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) =>
      a.reward_id
        ? call.api('POST', `/api/loyalty/contacts/${encodeURIComponent(a.contact_id)}/redeem`, { location: a.location_id, body: { reward_id: a.reward_id } })
        : call.api('POST', `/api/loyalty/contacts/${encodeURIComponent(a.contact_id)}/adjust`, { location: a.location_id, body: { points: a.points, reason: a.reason } }),
  },
];

export const loyaltyModule: Module = {
  name: 'loyalty',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE loyalty_settings (location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE loyalty_ledger (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, points INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL, ref TEXT, created_by TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX loyalty_ledger_contact ON loyalty_ledger(contact_id, created_at);
      CREATE UNIQUE INDEX loyalty_ledger_ref ON loyalty_ledger(location_id, source, ref) WHERE ref IS NOT NULL;
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    registerTriggers(app, TRIGGERS);
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), 'loyalty.tier_reached': (c: Record<string, any>, d: Record<string, any>) => !c.tier || String(c.tier).toLowerCase() === String(d.tier ?? '').toLowerCase() };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...LOYALTY_TOOLS];

    const settingsOf = (loc: string): Settings => {
      const row = db.get<{ data: string }>('SELECT data FROM loyalty_settings WHERE location_id = ?', loc);
      try {
        return { ...DEFAULTS, ...(row ? JSON.parse(row.data) : {}) };
      } catch {
        return { ...DEFAULTS };
      }
    };
    const sums = (contactId: string) => db.get<{ balance: number; lifetime: number }>('SELECT COALESCE(SUM(points), 0) AS balance, COALESCE(SUM(CASE WHEN points > 0 AND source != ? THEN points ELSE 0 END), 0) AS lifetime FROM loyalty_ledger WHERE contact_id = ?', 'refund', contactId)!;
    const tierOf = (s: Settings, lifetime: number) => [...s.tiers].sort((a, b) => b.min_points - a.min_points).find((t) => lifetime >= t.min_points) ?? null;

    /** One ledger line; fires the triggers. `ref` makes it idempotent (one line per invoice). */
    function book(loc: string, contactId: string, points: number, o: { reason: string; source: string; ref?: string; by?: string | null }) {
      const s = settingsOf(loc);
      const before = sums(contactId);
      if (points < 0 && before.balance + points < 0) throw bad(`Nicht genug Punkte (Stand ${before.balance})`);
      try {
        db.insert('loyalty_ledger', { id: id(), location_id: loc, contact_id: contactId, points, reason: o.reason.slice(0, 200), source: o.source, ref: o.ref ?? null, created_by: o.by ?? null, created_at: now() });
      } catch (e) {
        if (o.ref && /UNIQUE/.test((e as Error).message)) return null;
        throw e;
      }
      const after = sums(contactId);
      const tier = tierOf(s, after.lifetime);
      const prev = tierOf(s, before.lifetime);
      logActivity(app, loc, contactId, 'loyalty.points', `${points > 0 ? '+' : ''}${points} Treuepunkte – ${o.reason}`);
      if (points > 0) app.events.emit(loc, 'loyalty.points_earned', { contactId, points, balance: after.balance, lifetime: after.lifetime, tier: tier?.name ?? '', reason: o.reason });
      if (tier && tier.name !== prev?.name && (prev?.min_points ?? -1) < tier.min_points) app.events.emit(loc, 'loyalty.tier_reached', { contactId, tier: tier.name, previous: prev?.name ?? '', lifetime: after.lifetime });
      return after;
    }

    // --- earning: every paid invoice of a contact --------------------------------------------------------------------------
    app.events.on('invoice.paid', (e) => {
      const inv = e.data.invoice;
      const contactId = e.data.contactId;
      if (!inv?.id || !contactId) return;
      const s = settingsOf(e.locationId);
      if (!s.enabled || inv.kind === 'quote' || inv.kind === 'credit_note') return;
      const points = Math.floor((Number(inv.total_cents) || 0) / 100 * s.points_per_euro);
      if (points <= 0) return;
      try {
        book(e.locationId, contactId, points, { reason: `Rechnung ${inv.number || inv.id}`, source: 'invoice', ref: inv.id });
      } catch (err) {
        console.error('[loyalty]', (err as Error).message);
      }
    });

    // --- routes --------------------------------------------------------------------------------------------------------------
    function cleanSettings(loc: string, b: any): Settings {
      const cur = settingsOf(loc);
      const s: Settings = { ...cur };
      if (b.enabled !== undefined) s.enabled = !!b.enabled;
      if (b.notify !== undefined) s.notify = !!b.notify;
      if (b.points_per_euro !== undefined) {
        const v = num(b.points_per_euro, 1);
        if (!(v > 0) || v > 100) throw bad('Punkte je Euro: mehr als 0 und höchstens 100');
        s.points_per_euro = Math.round(v * 100) / 100;
      }
      if (b.tiers !== undefined) {
        if (!Array.isArray(b.tiers) || b.tiers.length > 10) throw bad('Stufen: höchstens 10');
        s.tiers = b.tiers.map((t: any, i: number) => ({ name: str(t?.name, `Stufe ${i + 1}: Name`, { required: true, max: 40 }), min_points: Math.max(0, Math.round(num(t?.min_points, 0))) })).sort((a: Tier, z: Tier) => a.min_points - z.min_points);
      }
      if (b.rewards !== undefined) {
        if (!Array.isArray(b.rewards) || b.rewards.length > 20) throw bad('Prämien: höchstens 20');
        s.rewards = b.rewards.map((r: any, i: number) => {
          const kind = r?.kind === 'gift_card' ? 'gift_card' : 'coupon';
          const points = Math.round(num(r?.points, 0));
          if (points < 1) throw bad(`Prämie ${i + 1}: Punkte fehlen`);
          const value = Math.round(num(r?.value, 0));
          const out: Reward = { id: typeof r?.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : id(8), name: str(r?.name, `Prämie ${i + 1}: Name`, { required: true, max: 80 }), points, kind, value };
          if (kind === 'coupon') {
            out.product_id = str(r?.product_id, `Prämie ${i + 1}: Produkt`, { required: true, max: 64 });
            const p = db.get<{ recurring: string | null }>('SELECT recurring FROM products WHERE id = ? AND location_id = ?', out.product_id, loc);
            if (!p || p.recurring) throw bad(`Prämie ${i + 1}: Einmal-Produkt nicht gefunden`);
            out.coupon_kind = r?.coupon_kind === 'amount' ? 'amount' : 'percent';
            if (out.coupon_kind === 'percent' && (value < 1 || value > 100)) throw bad(`Prämie ${i + 1}: Rabatt 1 bis 100 %`);
          }
          if ((kind === 'gift_card' || out.coupon_kind === 'amount') && value < 100) throw bad(`Prämie ${i + 1}: Wert mindestens 100 Cent`);
          return out;
        });
      }
      return s;
    }
    router.get('/api/loyalty/settings', 'location', (ctx) => settingsOf(ctx.locationId));
    router.put('/api/loyalty/settings', 'location', (ctx) => {
      const s = cleanSettings(ctx.locationId, ctx.body ?? {});
      db.run('INSERT INTO loyalty_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(s), now());
      return s;
    });
    const contactOr404 = (loc: string, cid: string) => {
      const c = getContact(app, loc, cid);
      if (!c) throw notFound('Kontakt nicht gefunden');
      return c;
    };
    function contactOut(loc: string, cid: string) {
      const s = settingsOf(loc);
      const { balance, lifetime } = sums(cid);
      const tier = tierOf(s, lifetime);
      const next = [...s.tiers].sort((a, b) => a.min_points - b.min_points).find((t) => t.min_points > lifetime) ?? null;
      return {
        enabled: s.enabled,
        balance,
        lifetime,
        tier: tier?.name ?? null,
        next_tier: next ? { name: next.name, missing: next.min_points - lifetime } : null,
        rewards: s.rewards.map((r) => ({ id: r.id, name: r.name, points: r.points, kind: r.kind, available: balance >= r.points })),
        ledger: db.all('SELECT id, points, reason, source, created_at FROM loyalty_ledger WHERE contact_id = ? AND location_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', cid, loc),
      };
    }
    router.get('/api/loyalty/contacts/:id', 'location', (ctx) => {
      contactOr404(ctx.locationId, ctx.params.id);
      return contactOut(ctx.locationId, ctx.params.id);
    });
    router.post('/api/loyalty/contacts/:id/adjust', 'location', (ctx) => {
      contactOr404(ctx.locationId, ctx.params.id);
      const points = Math.round(num(ctx.body?.points, 0));
      if (!points || Math.abs(points) > 100_000) throw bad('Punkte: eine ganze Zahl ungleich 0 (höchstens ±100000)');
      book(ctx.locationId, ctx.params.id, points, { reason: str(ctx.body?.reason, 'Grund', { max: 200 }) || 'Korrektur', source: 'manual', by: ctx.user?.id ?? null });
      return contactOut(ctx.locationId, ctx.params.id);
    });
    router.post('/api/loyalty/contacts/:id/redeem', 'location', (ctx) => {
      const c = contactOr404(ctx.locationId, ctx.params.id);
      const s = settingsOf(ctx.locationId);
      if (!s.enabled) throw bad('Das Treueprogramm ist ausgeschaltet');
      const r = s.rewards.find((x) => x.id === String(ctx.body?.reward_id ?? ''));
      if (!r) throw notFound('Prämie nicht gefunden');
      if (sums(c.id).balance < r.points) throw new HttpError(409, `Nicht genug Punkte – ${r.name} braucht ${r.points}`);
      let code = '';
      db.tx(() => {
        if (r.kind === 'coupon') code = issueCodes(app, ctx.locationId, { productId: r.product_id!, kind: r.coupon_kind ?? 'percent', value: r.value, validDays: 90, prefix: 'TREUE', contactId: c.id, source: 'api' }).codes[0];
        else {
          const svc = app.services.giftCards;
          if (!svc?.issue) throw bad('Gutscheine sind nicht verfügbar');
          code = svc.issue(ctx.locationId, { amount_cents: r.value, contact_id: c.id, source: 'loyalty', note: `Treueprämie: ${r.name}`, by: ctx.user?.id ?? null }).code;
        }
        book(ctx.locationId, c.id, -r.points, { reason: `Prämie: ${r.name}`, source: 'reward', by: ctx.user?.id ?? null });
      });
      return { ...contactOut(ctx.locationId, c.id), redeemed: { reward: r.name, kind: r.kind, code } };
    });
    router.get('/api/loyalty/members', 'location', (ctx) => {
      const s = settingsOf(ctx.locationId);
      const rows = db.all<any>(
        `SELECT l.contact_id, SUM(l.points) AS balance, SUM(CASE WHEN l.points > 0 AND l.source != 'refund' THEN l.points ELSE 0 END) AS lifetime, MAX(l.created_at) AS last_at,
                c.first_name, c.last_name, c.email
         FROM loyalty_ledger l JOIN contacts c ON c.id = l.contact_id WHERE l.location_id = ? GROUP BY l.contact_id ORDER BY lifetime DESC LIMIT 200`,
        ctx.locationId,
      );
      return rows.map((r) => ({ ...r, tier: tierOf(s, r.lifetime)?.name ?? null }));
    });

    // --- workflow step ---------------------------------------------------------------------------------------------------------
    const step: ActionDef = {
      meta: {
        type: 'loyalty_points',
        label: 'Treuepunkte gutschreiben',
        category: 'payments',
        icon: 'gift',
        summary: 'Schreibt dem Kontakt Treuepunkte gut (oder zieht welche ab) – z. B. für eine Bewertung, eine Empfehlung oder den Geburtstag.',
        doc: 'Eine negative Zahl zieht ab (nie unter 0). Das Treueprogramm muss unter Umsatz → Gutscheine → Treuepunkte eingeschaltet sein. {{var.loyalty_balance}} ist danach der neue Stand.',
        fields: [
          { key: 'points', label: 'Punkte', type: 'number', required: true, default: 50 },
          { key: 'reason', label: 'Grund', type: 'text', placeholder: 'Danke für deine Bewertung' },
        ],
        provides: ['var.loyalty_balance'],
        keywords: 'treuepunkte loyalty punkte bonus belohnung kundenbindung',
        sample: { points: 50, reason: 'Bewertung abgegeben' },
      },
      run: (run, s, vars) => {
        if (!run.contact_id) throw new Error('Kein Kontakt im Lauf');
        if (!settingsOf(run.location_id).enabled) throw new Error('Das Treueprogramm ist ausgeschaltet');
        const points = Math.round(Number(text(s.points, vars)));
        if (!Number.isFinite(points) || !points || Math.abs(points) > 100_000) throw new Error('Punkte: eine ganze Zahl ungleich 0');
        const after = book(run.location_id, run.contact_id, points, { reason: text(s.reason, vars).trim() || 'Workflow', source: 'workflow' });
        return { result: `${points > 0 ? '+' : ''}${points} Treuepunkte (Stand ${after?.balance ?? '?'})`, vars: { loyalty_balance: after?.balance ?? 0 } };
      },
    };
    registerActions(app, [step]);
  },
};
