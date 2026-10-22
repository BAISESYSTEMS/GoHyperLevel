import type { App } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id as newId, now, sha256 } from '../core/util.js';
import type { TaxMode } from './invoice-model.js';
import { membersWhere, notifyMember } from './member-notify.js';
import { getQuote, type QuoteRow } from './quote-engine.js';
import type { QuoteDoc } from './quote-model.js';
import { lineAmounts, salesTotals } from './sales-lines.js';

/**
 * Internal approval of quotes (docs/sales.md#internal-approval): an optional rule per sub-account – quotes above a net amount or with
 * more than a discount percentage need the approval of someone with a given role before they can be sent. The gate runs inside the
 * send itself (`app.services.quoteSendGates`, called by sendQuote), so no route, key, MCP tool or workflow gets past it. An approval
 * holds for exactly the content it was given for: changing the quote afterwards needs a new one. The customer's page and signature
 * are untouched.
 */

export const APPROVER_ROLES = ['admin', 'leitung', 'finance', 'team_lead'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];
export const APPROVER_LABEL: Record<ApproverRole, string> = {
  admin: 'Agentur-Admins',
  leitung: 'Leitung (Einstellungen)',
  finance: 'Rechnungen & Produkte',
  team_lead: 'Teamleitung eines Vertriebsteams',
};

export interface ApprovalRule {
  enabled: boolean;
  /** Net sum (cents) above which a quote needs approval; null = no amount limit. */
  min_net_cents: number | null;
  /** Discount in percent above which a quote needs approval; null = no discount limit. */
  max_discount_percent: number | null;
  approver_role: ApproverRole;
  /** For `team_lead`: the sales team whose leads approve. */
  team_id: string | null;
  /** Approvers may approve their own quotes (otherwise always a second person). */
  self_approve: boolean;
}

export const DEFAULT_RULE: ApprovalRule = { enabled: false, min_net_cents: null, max_discount_percent: null, approver_role: 'leitung', team_id: null, self_approve: false };

// --- the figures that matter ---------------------------------------------------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The most a customer could end up with: per variant all positions including every optional one – the highest net sum, and the
 * highest discount (of a single position, or of the whole variant including credit lines) in percent.
 */
export function quoteFigures(doc: QuoteDoc, mode: TaxMode = 'standard'): { max_net_cents: number; max_discount_percent: number } {
  const variants = doc.options.length ? doc.options.map((o) => [...doc.items, ...o.items]) : [doc.items];
  let net = 0;
  let disc = 0;
  for (const items of variants) {
    const t = salesTotals(items, mode);
    net = Math.max(net, t.subtotal_cents);
    let positive = 0;
    let credits = 0;
    for (const l of items) {
      const a = lineAmounts(l);
      if (a.list_cents > 0) {
        positive += a.list_cents;
        if (a.discount_cents > 0) disc = Math.max(disc, (a.discount_cents / a.list_cents) * 100);
      } else if (a.net_cents < 0) credits += -a.net_cents;
    }
    if (positive > 0) disc = Math.max(disc, ((t.discount_cents + credits) / positive) * 100);
  }
  return { max_net_cents: net, max_discount_percent: r1(disc) };
}

const eur = (c: number) => `${(c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (n: number) => `${String(r1(n)).replace('.', ',')} %`;

/** Why a quote needs approval under a rule (empty: it does not). */
export function approvalReasons(rule: ApprovalRule, f: { max_net_cents: number; max_discount_percent: number }): string[] {
  if (!rule.enabled) return [];
  const out: string[] = [];
  if (rule.min_net_cents !== null && f.max_net_cents > rule.min_net_cents) out.push(`Netto-Summe ${eur(f.max_net_cents)} über ${eur(rule.min_net_cents)}`);
  if (rule.max_discount_percent !== null && f.max_discount_percent > rule.max_discount_percent) out.push(`Rabatt ${pct(f.max_discount_percent)} über ${pct(rule.max_discount_percent)}`);
  return out;
}

/** The content an approval is given for: everything the customer will see and pay (not the validity date). */
export const fingerprint = (q: Pick<QuoteRow, 'title' | 'intro' | 'terms' | 'doc' | 'tax_mode' | 'currency' | 'payment' | 'deal_on_accept'>): string =>
  sha256(JSON.stringify([q.title, q.intro, q.terms, q.doc, q.tax_mode, q.currency, q.payment, q.deal_on_accept]));

// --- the rule ------------------------------------------------------------------------------------------------------------------------

export function ruleOf(app: App, loc: string): ApprovalRule {
  const r = app.db.get<{ data: string }>('SELECT data FROM quote_approval_rules WHERE location_id = ?', loc);
  if (!r) return { ...DEFAULT_RULE };
  try {
    return { ...DEFAULT_RULE, ...JSON.parse(r.data) };
  } catch {
    return { ...DEFAULT_RULE };
  }
}

export function saveRule(app: App, loc: string, b: any): ApprovalRule {
  const cur = ruleOf(app, loc);
  const next: ApprovalRule = { ...cur };
  if (b.enabled !== undefined) next.enabled = !!b.enabled;
  if (b.min_net_cents !== undefined) {
    const n = b.min_net_cents === null || b.min_net_cents === '' ? null : Math.round(Number(b.min_net_cents));
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100_000_000_00)) throw bad('Betragsgrenze: Cent ab 0');
    next.min_net_cents = n;
  }
  if (b.max_discount_percent !== undefined) {
    const n = b.max_discount_percent === null || b.max_discount_percent === '' ? null : Number(b.max_discount_percent);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100)) throw bad('Rabattgrenze: Prozent zwischen 0 und 100');
    next.max_discount_percent = n === null ? null : r1(n);
  }
  if (b.approver_role !== undefined) {
    if (!(APPROVER_ROLES as readonly string[]).includes(b.approver_role)) throw bad('Rolle: admin, leitung, finance oder team_lead');
    next.approver_role = b.approver_role;
  }
  if (b.team_id !== undefined) next.team_id = b.team_id ? String(b.team_id) : null;
  if (b.self_approve !== undefined) next.self_approve = !!b.self_approve;
  if (next.approver_role === 'team_lead') {
    if (!next.team_id || !app.db.get('SELECT 1 AS x FROM sales_teams WHERE id = ? AND location_id = ?', next.team_id, loc)) throw bad('Vertriebsteam für die Teamleitung wählen');
  } else next.team_id = null;
  if (next.enabled && next.min_net_cents === null && next.max_discount_percent === null) throw bad('Betrags- oder Rabattgrenze angeben');
  app.db.run('INSERT INTO quote_approval_rules (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', loc, JSON.stringify(next), now());
  return next;
}

// --- who approves ----------------------------------------------------------------------------------------------------------------------

interface Person {
  id: string;
  role: string;
  permissions: string[] | null;
}

const hasArea = (u: Person, area: string) => u.role === 'admin' || !u.permissions || u.permissions.includes(area);

/** Does this person hold the approving role (and may work on quotes at all)? */
export function holdsRole(app: App, loc: string, rule: ApprovalRule, u: Person): boolean {
  if (!hasArea(u, 'opportunities')) return false;
  switch (rule.approver_role) {
    case 'admin':
      return u.role === 'admin';
    case 'finance':
      return hasArea(u, 'payments');
    case 'team_lead':
      return !!rule.team_id && !!app.db.get(`SELECT 1 AS x FROM sales_team_members WHERE team_id = ? AND location_id = ? AND user_id = ? AND role = 'lead'`, rule.team_id, loc, u.id);
    default:
      return hasArea(u, 'settings');
  }
}

export const approversOf = (app: App, loc: string, rule: ApprovalRule): string[] => membersWhere(app, loc, (u) => holdsRole(app, loc, rule, u));

// --- approvals -------------------------------------------------------------------------------------------------------------------------

export interface ApprovalRow {
  id: string;
  location_id: string;
  quote_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  fingerprint: string;
  net_cents: number;
  discount_percent: number;
  reasons: string;
  requested_by: string | null;
  request_comment: string;
  decided_by: string | null;
  decision_comment: string;
  requested_at: string;
  decided_at: string | null;
}

const latest = (app: App, loc: string, quoteId: string) => app.db.get<ApprovalRow>('SELECT * FROM quote_approvals WHERE quote_id = ? AND location_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1', quoteId, loc);

const nameOf = (app: App, uid: string | null) => (uid ? (app.db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', uid) ?? null) : null);

export function approvalOut(app: App, a: ApprovalRow, q?: QuoteRow) {
  const fp = q ? fingerprint(q) : null;
  return {
    ...a,
    reasons: JSON.parse(a.reasons || '[]') as string[],
    requested_by_name: nameOf(app, a.requested_by)?.name ?? '',
    decided_by_name: nameOf(app, a.decided_by)?.name ?? '',
    /** The quote was changed after the request or approval: it no longer covers the current content. */
    stale: fp !== null && fp !== a.fingerprint,
  };
}

/** Where a quote stands: needs approval?, why, the current request/approval and whether the viewer may decide. */
export function approvalState(app: App, loc: string, q: QuoteRow, viewer?: Person | null) {
  const rule = ruleOf(app, loc);
  const figures = quoteFigures(q.doc, q.tax_mode);
  const reasons = approvalReasons(rule, figures);
  const cur = latest(app, loc, q.id);
  const out = cur ? approvalOut(app, cur, q) : null;
  const approved = !!out && out.status === 'approved' && !out.stale;
  const history = app.db.all<ApprovalRow>('SELECT * FROM quote_approvals WHERE quote_id = ? AND location_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 20', q.id, loc).map((a) => approvalOut(app, a, q));
  const mayDecide = !!viewer && !!out && out.status === 'pending' && !out.stale && holdsRole(app, loc, rule, viewer) && (rule.self_approve || viewer.id !== out.requested_by);
  return {
    rule: { enabled: rule.enabled, min_net_cents: rule.min_net_cents, max_discount_percent: rule.max_discount_percent, approver_role: rule.approver_role, approver_label: APPROVER_LABEL[rule.approver_role] },
    figures,
    required: reasons.length > 0 && q.status === 'draft',
    reasons,
    approved,
    may_send: q.status !== 'draft' || !reasons.length || approved,
    current: out,
    history,
    may_decide: mayDecide,
  };
}

/**
 * The gate in the send path: a draft that needs approval under the rule goes out only with an approval for exactly its content.
 * Throws 409 with `approval_required` so screens and API clients can tell it apart.
 */
export function assertSendable(app: App, loc: string, q: QuoteRow): void {
  if (q.status !== 'draft') return;
  const rule = ruleOf(app, loc);
  const reasons = approvalReasons(rule, quoteFigures(q.doc, q.tax_mode));
  if (!reasons.length) return;
  const cur = latest(app, loc, q.id);
  if (cur && cur.status === 'approved' && cur.fingerprint === fingerprint(q)) return;
  const why = cur?.status === 'approved' ? 'Das Angebot wurde nach der Genehmigung geändert – bitte neu genehmigen lassen' : cur?.status === 'pending' ? 'Die interne Genehmigung steht noch aus' : 'Dieses Angebot braucht vor dem Senden eine interne Genehmigung';
  app.services.audit?.({ action: 'quote.approval.blocked', actor: 'System', locationId: loc, entityId: q.id, summary: `Senden ohne Genehmigung verhindert: ${reasons.join(', ')}` });
  throw new HttpError(409, `${why} (${reasons.join(', ')})`, { approval_required: true, reasons });
}

export interface Actor {
  id: string;
  name: string;
  role: string;
  permissions: string[] | null;
}

const quoteLink = (q: QuoteRow) => `/app/sales/angebote?quote=${q.id}`;
const label = (q: QuoteRow) => `„${q.title}“`;

export function requestApproval(app: App, loc: string, q: QuoteRow, comment: string, actor: Actor | null) {
  if (q.status !== 'draft') throw new HttpError(409, 'Nur Entwürfe brauchen eine Genehmigung');
  const rule = ruleOf(app, loc);
  const figures = quoteFigures(q.doc, q.tax_mode);
  const reasons = approvalReasons(rule, figures);
  if (!reasons.length) throw bad('Dieses Angebot braucht keine Genehmigung');
  const fp = fingerprint(q);
  const cur = latest(app, loc, q.id);
  if (cur && cur.status === 'pending' && cur.fingerprint === fp) throw new HttpError(409, 'Die Genehmigung ist schon angefragt');
  if (cur && cur.status === 'approved' && cur.fingerprint === fp) throw new HttpError(409, 'Dieses Angebot ist schon genehmigt');
  const approvers = approversOf(app, loc, rule).filter((u) => rule.self_approve || u !== actor?.id);
  if (!approvers.length) throw bad(`Niemand kann genehmigen – es fehlt eine Person mit der Rolle „${APPROVER_LABEL[rule.approver_role]}“`);
  const row: ApprovalRow = {
    id: newId(),
    location_id: loc,
    quote_id: q.id,
    status: 'pending',
    fingerprint: fp,
    net_cents: figures.max_net_cents,
    discount_percent: figures.max_discount_percent,
    reasons: JSON.stringify(reasons),
    requested_by: actor?.id ?? null,
    request_comment: str(comment, 'Kommentar', { max: 1000 }),
    decided_by: null,
    decision_comment: '',
    requested_at: now(),
    decided_at: null,
  };
  app.db.tx(() => {
    // An older open request for other content is replaced by this one.
    app.db.run(`UPDATE quote_approvals SET status = 'withdrawn', decided_at = ? WHERE quote_id = ? AND location_id = ? AND status = 'pending'`, now(), q.id, loc);
    app.db.insert('quote_approvals', row);
  });
  const who = actor?.name ?? 'API-Schlüssel';
  for (const u of approvers) notifyMember(app, { locationId: loc, userId: u, kind: 'approval', title: `Genehmigung angefragt: Angebot ${label(q)}`, body: `${who}: ${reasons.join(', ')}${row.request_comment ? ` – „${row.request_comment}“` : ''}`, link: quoteLink(q), ref: `quote-approval:${row.id}`, area: 'opportunities', push: 'tasks' });
  app.services.audit?.({ action: 'quote.approval.requested', actor: who, userId: actor?.id ?? null, locationId: loc, entityId: q.id, summary: `Genehmigung für Angebot ${label(q)} angefragt: ${reasons.join(', ')}` });
  app.events.emit(loc, 'quote.approval_requested', { contactId: q.contact_id, quote: { id: q.id, title: q.title, deal_id: q.deal_id }, approval: { id: row.id, reasons } });
  return row;
}

const approvalRow = (app: App, loc: string, aid: string): ApprovalRow => {
  const a = app.db.get<ApprovalRow>('SELECT * FROM quote_approvals WHERE id = ? AND location_id = ?', String(aid ?? ''), loc);
  if (!a) throw notFound('Genehmigung nicht gefunden');
  return a;
};

export function approvalWithQuote(app: App, loc: string, aid: string): { a: ApprovalRow; q: QuoteRow } {
  const a = approvalRow(app, loc, aid);
  const q = getQuote(app, loc, a.quote_id);
  if (!q) throw notFound('Angebot nicht gefunden');
  return { a, q };
}

/** Approve or reject: only someone with the role, never the requester (unless the rule allows it), only for the current content. */
export function decide(app: App, loc: string, aid: string, decision: 'approved' | 'rejected', comment: string, actor: Actor) {
  const { a, q } = approvalWithQuote(app, loc, aid);
  const rule = ruleOf(app, loc);
  if (!holdsRole(app, loc, rule, actor)) throw new HttpError(403, `Genehmigen darf nur, wer die Rolle „${APPROVER_LABEL[rule.approver_role]}“ hat`);
  if (!rule.self_approve && a.requested_by === actor.id) throw new HttpError(403, 'Eigene Angebote genehmigt eine zweite Person');
  if (a.status !== 'pending') throw new HttpError(409, 'Diese Anfrage ist schon entschieden');
  if (q.status !== 'draft') throw new HttpError(409, 'Das Angebot ist kein Entwurf mehr');
  if (fingerprint(q) !== a.fingerprint) throw new HttpError(409, 'Das Angebot wurde nach der Anfrage geändert – bitte neu anfragen lassen');
  const note = str(comment, 'Kommentar', { max: 1000 });
  if (decision === 'rejected' && !note) throw bad('Bitte einen Grund für die Ablehnung angeben');
  const done = app.db.run(`UPDATE quote_approvals SET status = ?, decided_by = ?, decision_comment = ?, decided_at = ? WHERE id = ? AND status = 'pending'`, decision, actor.id, note, now(), a.id).changes;
  if (!done) throw new HttpError(409, 'Diese Anfrage ist schon entschieden');
  const verb = decision === 'approved' ? 'genehmigt' : 'abgelehnt';
  if (a.requested_by && a.requested_by !== actor.id) {
    notifyMember(app, { locationId: loc, userId: a.requested_by, kind: 'approval', title: `Angebot ${label(q)} ${verb}`, body: `${actor.name}${note ? `: „${note}“` : ''}`, link: quoteLink(q), ref: `quote-approval-decided:${a.id}`, area: 'opportunities', push: 'tasks' });
  }
  app.services.audit?.({ action: `quote.approval.${decision}`, actor: actor.name, userId: actor.id, locationId: loc, entityId: q.id, summary: `Angebot ${label(q)} ${verb}${note ? `: ${note}` : ''}` });
  app.events.emit(loc, 'quote.approval_decided', { contactId: q.contact_id, quote: { id: q.id, title: q.title, deal_id: q.deal_id }, approval: { id: a.id, status: decision, comment: note } });
  return approvalOut(app, approvalRow(app, loc, a.id), q);
}

export function withdraw(app: App, loc: string, aid: string, actor: Actor | null, manager: boolean) {
  const { a, q } = approvalWithQuote(app, loc, aid);
  if (a.status !== 'pending') throw new HttpError(409, 'Diese Anfrage ist schon entschieden');
  if (!manager && a.requested_by !== actor?.id) throw new HttpError(403, 'Zurückziehen kann nur, wer angefragt hat');
  app.db.run(`UPDATE quote_approvals SET status = 'withdrawn', decided_at = ? WHERE id = ? AND status = 'pending'`, now(), a.id);
  app.services.audit?.({ action: 'quote.approval.withdrawn', actor: actor?.name ?? 'API-Schlüssel', userId: actor?.id ?? null, locationId: loc, entityId: q.id, summary: `Genehmigungsanfrage für Angebot ${label(q)} zurückgezogen` });
  return approvalOut(app, approvalRow(app, loc, a.id), q);
}
