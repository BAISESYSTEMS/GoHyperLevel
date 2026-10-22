import { randomInt } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { bad, notFound, num, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { registerActions, text, type ActionDef } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Single-use discount codes (HighLevel parity, docs/store.md#single-use-discount-codes): generated codes that work
 * once on a product's buy page – from a workflow step (a personal code per contact, e.g. "10 % for your birthday" or a win-back
 * mail), in bulk for a campaign, or by the agent. Each code is a row of the buy page's own code table (buy_coupons with max_uses 1),
 * so redeeming, holding during payment and counting the use are the buy page's (modules/buy-offers.ts); this module only issues
 * them and remembers for whom (`coupon_issues`).
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_BULK = 500;

export interface IssueInput {
  productId: string;
  kind: 'percent' | 'amount';
  value: number;
  validDays?: number | null;
  prefix?: string;
  count?: number;
  contactId?: string | null;
  source: 'workflow' | 'api' | 'mcp';
  workflowId?: string | null;
}

export function issueCodes(app: App, locationId: string, i: IssueInput): { codes: string[]; expires_at: string | null; product: { id: string; name: string } } {
  const { db } = app;
  const p = db.get<any>('SELECT id, name, recurring FROM products WHERE id = ? AND location_id = ?', i.productId, locationId);
  if (!p) throw notFound('Produkt nicht gefunden');
  if (p.recurring) throw bad('Rabattcodes gehen nur für Einmal-Produkte');
  const value = Math.round(i.value);
  if (i.kind === 'percent' && (!(value >= 1) || value > 100)) throw bad('Rabatt: 1 bis 100 %');
  if (i.kind === 'amount' && !(value >= 1)) throw bad('Rabatt: Betrag in Cent fehlt');
  const count = Math.round(i.count ?? 1);
  if (!(count >= 1) || count > MAX_BULK) throw bad(`Anzahl: 1 bis ${MAX_BULK}`);
  const days = i.validDays === null || i.validDays === undefined ? 30 : Math.round(i.validDays);
  if (days < 0 || days > 3650) throw bad('Gültigkeit: 0 (unbegrenzt) bis 3650 Tage');
  const expires = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
  const prefix = String(i.prefix ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  if (i.contactId && !getContact(app, locationId, i.contactId)) throw notFound('Kontakt nicht gefunden');
  const codes: string[] = [];
  db.tx(() => {
    for (let n = 0; n < count; n++) {
      let code = '';
      for (let tries = 0; tries < 20 && (!code || db.get('SELECT 1 FROM buy_coupons WHERE product_id = ? AND code = ?', p.id, code)); tries++)
        code = `${prefix ? `${prefix}-` : ''}${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
      const cid = id();
      db.insert('buy_coupons', { id: cid, location_id: locationId, product_id: p.id, code, kind: i.kind, value, max_uses: 1, expires_at: expires, active: 1, created_at: now() });
      db.insert('coupon_issues', { id: id(), location_id: locationId, coupon_id: cid, contact_id: i.contactId ?? null, source: i.source, workflow_id: i.workflowId ?? null, created_at: now() });
      codes.push(code);
    }
  });
  if (i.contactId) logActivity(app, locationId, i.contactId, 'coupon.issued', `Einmal-Rabattcode ${codes[0]} für „${p.name}“ erstellt`);
  return { codes, expires_at: expires, product: { id: p.id, name: p.name } };
}

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

export const COUPON_TOOLS: Tool[] = [
  {
    name: 'ghl_coupon_create',
    title: 'Einmal-Rabattcodes erzeugen',
    description: `Erzeugt Rabattcodes, die je genau einmal auf der Kaufseite eines Einmal-Produkts gelten (Prozent oder Betrag in Cent, Gültigkeit in Tagen, Standard 30). Mit contact_id ein persönlicher Code für diesen Kontakt, mit count bis ${MAX_BULK} Codes auf einmal (z. B. für eine Aktion). Die Codes gibst du dem Nutzer bzw. dem Kontakt weiter – verschickt wird nichts.`,
    inputSchema: obj(
      {
        ...LOC,
        product_id: { type: 'string', description: 'Produkt-ID (Einmal-Produkt)' },
        kind: { type: 'string', enum: ['percent', 'amount'] },
        value: { type: 'integer', minimum: 1, description: 'Prozent (1–100) oder Betrag in Cent (brutto)' },
        valid_days: { type: 'integer', minimum: 0, maximum: 3650, description: '0 = unbegrenzt, Standard 30' },
        prefix: { type: 'string', description: 'Präfix, z. B. GEBURTSTAG' },
        count: { type: 'integer', minimum: 1, maximum: MAX_BULK },
        contact_id: { type: 'string', description: 'Persönlicher Code für diesen Kontakt' },
      },
      ['location_id', 'product_id', 'kind', 'value'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => {
      const { location_id, ...body } = a;
      return call.api('POST', '/api/coupon-codes', { location: location_id, body: { ...body, source: 'mcp' } });
    },
  },
];

export const couponCodesModule: Module = {
  name: 'coupon-codes',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE coupon_issues (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        coupon_id TEXT NOT NULL REFERENCES buy_coupons(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, source TEXT NOT NULL DEFAULT 'api', workflow_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX coupon_issues_loc ON coupon_issues(location_id, created_at);
      CREATE INDEX coupon_issues_contact ON coupon_issues(contact_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...COUPON_TOOLS];

    router.post('/api/coupon-codes', 'location', (ctx) => {
      const b = ctx.body ?? {};
      return issueCodes(app, ctx.locationId, {
        productId: str(b.product_id, 'Produkt', { required: true, max: 64 }),
        kind: b.kind === 'amount' ? 'amount' : 'percent',
        value: num(b.value, 0),
        validDays: b.valid_days === undefined || b.valid_days === null || b.valid_days === '' ? null : num(b.valid_days, 30),
        prefix: str(b.prefix, 'Präfix', { max: 40 }),
        count: num(b.count, 1),
        contactId: b.contact_id ? String(b.contact_id) : null,
        source: b.source === 'mcp' ? 'mcp' : 'api',
      });
    });
    router.get('/api/coupon-codes', 'location', (ctx) => {
      const product = ctx.query.get('product_id');
      return db.all(
        `SELECT c.id, c.code, c.kind, c.value, c.uses, c.max_uses, c.expires_at, c.active, c.product_id, p.name AS product_name, i.contact_id, i.source, i.workflow_id, i.created_at,
                k.first_name, k.last_name, k.email
         FROM coupon_issues i JOIN buy_coupons c ON c.id = i.coupon_id JOIN products p ON p.id = c.product_id LEFT JOIN contacts k ON k.id = i.contact_id
         WHERE i.location_id = ? ${product ? 'AND c.product_id = ?' : ''} ORDER BY i.created_at DESC LIMIT 1000`,
        ctx.locationId,
        ...(product ? [product] : []),
      ).map((r: any) => ({ ...r, active: !!r.active, used: r.uses >= (r.max_uses ?? 1) }));
    });

    const step: ActionDef = {
      meta: {
        type: 'coupon_create',
        label: 'Einmal-Rabattcode erstellen',
        category: 'payments',
        icon: 'tag',
        summary: 'Erzeugt für den Kontakt einen persönlichen Code, der einmal auf der Kaufseite eines Produkts gilt – {{var.coupon_code}} in den nächsten Schritten.',
        doc: 'Der Code (z. B. GEBURTSTAG-7KQ2M9XA) gilt genau einmal für das gewählte Einmal-Produkt, als Prozent- oder Betragsrabatt, bis zum Ablauf. Danach z. B. „E-Mail senden“ mit {{var.coupon_code}} und {{var.coupon_expires}}. Die Codes stehen unter Produkt → Kaufseite → Rabattcodes und unter /api/coupon-codes.',
        fields: [
          { key: 'product_id', label: 'Produkt', type: 'product', required: true },
          { key: 'kind', label: 'Art', type: 'select', options: [['percent', 'Prozent'], ['amount', 'Betrag (Cent, brutto)']], default: 'percent' },
          { key: 'value', label: 'Rabatt', type: 'number', required: true, default: 10 },
          { key: 'valid_days', label: 'Gültig (Tage, 0 = unbegrenzt)', type: 'number', default: 30 },
          { key: 'prefix', label: 'Präfix (optional)', type: 'text', placeholder: 'GEBURTSTAG' },
        ],
        provides: ['var.coupon_code', 'var.coupon_expires'],
        keywords: 'gutschein rabatt code coupon einmalig persönlich geburtstag rückgewinnung',
        sample: { product_id: '', kind: 'percent', value: 10, valid_days: 30, prefix: 'DANKE' },
      },
      run: (run, s, vars) => {
        if (!run.contact_id) throw new Error('Kein Kontakt im Lauf');
        const r = issueCodes(app, run.location_id, {
          productId: String(s.product_id ?? ''),
          kind: s.kind === 'amount' ? 'amount' : 'percent',
          value: Number(text(s.value, vars)),
          validDays: s.valid_days === undefined || s.valid_days === '' ? null : Number(text(s.valid_days, vars)),
          prefix: text(s.prefix, vars),
          contactId: run.contact_id,
          source: 'workflow',
          workflowId: run.workflow_id,
        });
        const loc = app.location(run.location_id);
        const expires = r.expires_at ? new Date(r.expires_at).toLocaleDateString('de-DE', { timeZone: loc?.timezone || 'Europe/Berlin' }) : '';
        return { result: `Code ${r.codes[0]} für „${r.product.name}“`, vars: { coupon_code: r.codes[0], coupon_expires: expires } };
      },
    };
    registerActions(app, [step]);
  },
};
