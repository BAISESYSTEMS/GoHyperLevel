import type { Module } from '../core/app.js';
import { HttpError, clampLimit, notFound, type Ctx } from '../core/http.js';
import { canConfigure, denyUnless, permits, resolve, scopeClause } from '../services/record-access.js';
import { getQuote, type QuoteRow } from '../services/quote-engine.js';
import { APPROVER_LABEL, APPROVER_ROLES, approvalOut, approvalState, approvalWithQuote, approversOf, assertSendable, decide, holdsRole, requestApproval, ruleOf, saveRule, withdraw, type Actor, type ApprovalRow } from '../services/quote-approval.js';
import { registerTriggers } from '../services/wfx-kit.js';

/**
 * Internal approval of quotes (docs/sales.md#internal-approval). The rule per sub-account, requests, approve/reject with a comment,
 * an audit line and a notification for each step – and the gate in the send path (`app.services.quoteSendGates`, run by sendQuote
 * in services/quote-engine.ts for every caller: web, app, API key, MCP, workflows). Routes under /api/quote-approvals (area
 * Opportunities); the rule is a sub-account setting.
 */

const MIGRATION = `
CREATE TABLE quote_approval_rules (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
CREATE TABLE quote_approvals (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quote_id TEXT NOT NULL REFERENCES deal_quotes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', fingerprint TEXT NOT NULL, net_cents INTEGER NOT NULL DEFAULT 0, discount_percent REAL NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]', requested_by TEXT, request_comment TEXT NOT NULL DEFAULT '',
  decided_by TEXT, decision_comment TEXT NOT NULL DEFAULT '', requested_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX quote_approvals_quote ON quote_approvals(quote_id, requested_at);
CREATE INDEX quote_approvals_loc ON quote_approvals(location_id, status, requested_at);
`;

/** A real person behind the request (not a key), signed in through the web or the app – only people decide. */
function person(ctx: Ctx): Actor | null {
  const u = ctx.user;
  if (!u || String(u.id).startsWith('key:')) return null;
  return { id: u.id, name: u.name || u.email, role: u.role, permissions: u.permissions };
}

export const quoteApprovalsModule: Module = {
  name: 'quote-approvals',
  migrations: [['001-init', MIGRATION]],
  register(app) {
    const { db, router } = app;
    app.services.quoteSendGates = [...(app.services.quoteSendGates ?? []), (loc: string, q: QuoteRow) => assertSendable(app, loc, q)];

    /** The quote of a request, if the person may see its deal (record access: a quote follows its deal). */
    const mustQuote = (ctx: Ctx, qid: string): QuoteRow => {
      const q = getQuote(app, ctx.locationId, qid);
      if (!q) throw notFound('Angebot nicht gefunden');
      denyUnless(permits(app, resolve(app, ctx), 'deals', q.deal_id));
      return q;
    };
    const mustApproval = (ctx: Ctx) => {
      const { a, q } = approvalWithQuote(app, ctx.locationId, ctx.params.id);
      denyUnless(permits(app, resolve(app, ctx), 'deals', q.deal_id));
      return { a, q };
    };
    const decider = (ctx: Ctx): Actor => {
      const p = person(ctx);
      if (!p || (ctx.via !== 'session' && ctx.via !== 'app')) throw new HttpError(403, 'Genehmigen und Ablehnen geht nur angemeldet in HyperLevel (Web oder App) – nicht über API-Schlüssel oder KI-Werkzeuge');
      return p;
    };
    const isManager = (ctx: Ctx) => !ctx.user || ctx.user.role === 'admin' || !ctx.user.permissions || ctx.user.permissions.includes('settings');

    // --- the rule -------------------------------------------------------------------------------------------------------------------
    router.get('/api/quote-approvals/settings', 'location', (ctx) => {
      const rule = ruleOf(app, ctx.locationId);
      const teams = db.all<{ id: string; name: string }>('SELECT id, name FROM sales_teams WHERE location_id = ? ORDER BY name', ctx.locationId);
      return { rule, roles: APPROVER_ROLES.map((r) => ({ value: r, label: APPROVER_LABEL[r] })), teams, approvers: approversOf(app, ctx.locationId, rule).length, can_configure: !!person(ctx) && canConfigure(app, ctx) };
    });
    router.put('/api/quote-approvals/settings', 'location', (ctx) => {
      // Keys and AI tools could otherwise switch the rule off and send: only a signed-in person with the settings area changes it.
      if (!person(ctx) || (ctx.via !== 'session' && ctx.via !== 'app') || !canConfigure(app, ctx)) throw new HttpError(403, 'Die Genehmigungsregel ändern nur Admins und die Leitung (Einstellungen), angemeldet in HyperLevel');
      const before = ruleOf(app, ctx.locationId);
      const rule = saveRule(app, ctx.locationId, ctx.body ?? {});
      app.services.audit?.({ ctx, action: 'quote.approval.rule', entityId: ctx.locationId, summary: `Genehmigungsregel ${rule.enabled ? 'an' : 'aus'} (vorher ${before.enabled ? 'an' : 'aus'}): Betrag ${rule.min_net_cents ?? '–'} ct, Rabatt ${rule.max_discount_percent ?? '–'} %, Rolle ${rule.approver_role}` });
      return { rule, approvers: approversOf(app, ctx.locationId, rule).length };
    });

    // --- requests -------------------------------------------------------------------------------------------------------------------
    router.get('/api/quote-approvals', 'location', (ctx) => {
      const where = ['a.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const status = ctx.query.get('status');
      if (status && ['pending', 'approved', 'rejected', 'withdrawn'].includes(status)) (where.push('a.status = ?'), params.push(status));
      const scope = scopeClause(resolve(app, ctx), 'deals', 'o');
      if (scope) (where.push(scope.sql), params.push(...scope.params));
      const rows = db.all<ApprovalRow & { title: string; deal_name: string; quote_status: string }>(
        `SELECT a.*, q.title, q.status AS quote_status, o.name AS deal_name FROM quote_approvals a JOIN deal_quotes q ON q.id = a.quote_id JOIN opportunities o ON o.id = q.deal_id WHERE ${where.join(' AND ')} ORDER BY a.requested_at DESC LIMIT ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 100, 500),
      );
      const me = person(ctx);
      const rule = ruleOf(app, ctx.locationId);
      const approver = !!me && holdsRole(app, ctx.locationId, rule, me);
      return rows.map((r) => {
        const q = getQuote(app, ctx.locationId, r.quote_id)!;
        const out = approvalOut(app, r, q);
        return { ...out, quote: { id: q.id, title: q.title, status: q.status, deal_name: r.deal_name }, may_decide: approver && out.status === 'pending' && !out.stale && q.status === 'draft' && (rule.self_approve || me!.id !== out.requested_by) };
      });
    });
    router.get('/api/quote-approvals/quotes/:quoteId', 'location', (ctx) => approvalState(app, ctx.locationId, mustQuote(ctx, ctx.params.quoteId), person(ctx)));
    router.post('/api/quote-approvals/quotes/:quoteId/request', 'location', (ctx) => {
      const q = mustQuote(ctx, ctx.params.quoteId);
      requestApproval(app, ctx.locationId, q, String(ctx.body?.comment ?? ''), person(ctx));
      return approvalState(app, ctx.locationId, getQuote(app, ctx.locationId, q.id)!, person(ctx));
    });
    router.post('/api/quote-approvals/:id/approve', 'location', (ctx) => {
      const actor = decider(ctx);
      mustApproval(ctx);
      return decide(app, ctx.locationId, ctx.params.id, 'approved', String(ctx.body?.comment ?? ''), actor);
    });
    router.post('/api/quote-approvals/:id/reject', 'location', (ctx) => {
      const actor = decider(ctx);
      mustApproval(ctx);
      return decide(app, ctx.locationId, ctx.params.id, 'rejected', String(ctx.body?.comment ?? ''), actor);
    });
    router.post('/api/quote-approvals/:id/withdraw', 'location', (ctx) => {
      mustApproval(ctx);
      return withdraw(app, ctx.locationId, ctx.params.id, person(ctx), isManager(ctx));
    });

    registerTriggers(
      app,
      (
        [
          ['quote.approval_requested', 'Angebot: Genehmigung angefragt', 'Für ein Angebot über der Betrags- oder Rabattgrenze wird die interne Genehmigung angefragt.'],
          ['quote.approval_decided', 'Angebot: Genehmigung entschieden', 'Ein Angebot wurde intern genehmigt oder abgelehnt ({{event.approval.status}}: approved / rejected).'],
        ] as const
      ).map(([type, label, summary]) => ({
        type,
        label,
        category: 'sales',
        summary,
        doc: '{{event.quote.title}}, {{event.quote.deal_id}}, {{event.approval.reasons}} bzw. {{event.approval.status}} und {{event.approval.comment}}. Startet für den Kontakt des Angebots.',
        fields: [],
        sample: { contactId: 'c1', quote: { id: 'q1', title: 'Webseite', deal_id: 'd1' }, approval: { id: 'a1', status: 'approved', reasons: ['Rabatt 20 % über 15 %'], comment: 'Passt' } },
        keywords: 'angebot genehmigung freigabe rabatt intern vier augen',
      })),
    );
  },
};
