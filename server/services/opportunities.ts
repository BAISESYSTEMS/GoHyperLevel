import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from './contacts.js';

export const OPP_STATUSES = ['open', 'won', 'lost', 'abandoned'] as const;

/** Reasons offered when a deal is lost, until a pipeline brings its own list (pipelines.lost_reasons). */
export const DEFAULT_LOST_REASONS = ['Preis zu hoch', 'Kein Budget', 'Mitbewerber gewählt', 'Kein Bedarf mehr', 'Keine Rückmeldung', 'Zeitpunkt passt nicht', 'Sonstiges'];
/** Reason of a deal that a workflow, which has no person to ask, marks as lost. */
export const AUTO_LOST_REASON = 'Per Automation';
export const DEAL_CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP'];

export function getPipeline(app: App, locationId: string, pipelineId: string) {
  return parseJson(app.db.get('SELECT * FROM pipelines WHERE id = ? AND location_id = ?', pipelineId, locationId), ['stages', 'lost_reasons']);
}

/** The pipeline's reasons for a lost deal: its own list, or the defaults while it has none. */
export const lostReasonsOf = (pipeline: { lost_reasons?: unknown } | undefined | null): string[] =>
  Array.isArray(pipeline?.lost_reasons) && pipeline!.lost_reasons.length ? (pipeline!.lost_reasons as string[]) : DEFAULT_LOST_REASONS;

/** Trims, drops empty and duplicate entries; at most 20 reasons of up to 80 characters. Empty input = back to the defaults (null). */
export function cleanLostReasons(input: unknown): string[] | null {
  if (input === null || input === undefined) return null;
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split('\n') : null;
  if (!list) throw new Error('Verlustgründe: Liste erwartet');
  const out: string[] = [];
  for (const r of list) {
    const v = String(r ?? '').trim().slice(0, 80);
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > 20) throw new Error('Höchstens 20 Verlustgründe');
  return out.length ? out : null;
}

/** Expected close date as YYYY-MM-DD (or null to clear it). */
export function cleanCloseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw new Error('Erwarteter Abschluss: Datum als JJJJ-MM-TT angeben');
  return s;
}

/** ISO 4217 code in capitals, checked against what the runtime knows; empty = euro. */
export function cleanCurrency(v: unknown): string {
  const c = String(v ?? '').trim().toUpperCase();
  if (!c) return 'EUR';
  try {
    if (!/^[A-Z]{3}$/.test(c)) throw new Error();
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: c });
  } catch {
    throw new Error('Währung: dreistelligen Code wie EUR, USD oder CHF angeben');
  }
  return c;
}

const cleanReason = (v: unknown) => String(v ?? '').trim().slice(0, 200);

export function getOpportunity(app: App, locationId: string, oppId: string) {
  return app.db.get('SELECT * FROM opportunities WHERE id = ? AND location_id = ?', oppId, locationId);
}

export function createOpportunity(
  app: App,
  locationId: string,
  input: {
    pipeline_id: string;
    stage_id?: string;
    contact_id: string;
    name?: string;
    value?: number;
    status?: string;
    assigned_to?: string | null;
    source?: string;
    expected_close_date?: string | null;
    currency?: string;
    lost_reason?: string;
  },
) {
  const p = getPipeline(app, locationId, input.pipeline_id);
  if (!p) throw new Error('Pipeline nicht gefunden');
  const stageId = input.stage_id && p.stages.some((s: any) => s.id === input.stage_id) ? input.stage_id : p.stages[0]?.id;
  const contact = getContact(app, locationId, input.contact_id);
  if (!contact) throw new Error('Kontakt nicht gefunden');
  const status = OPP_STATUSES.includes(input.status as any) ? (input.status as string) : 'open';
  const lostReason = cleanReason(input.lost_reason);
  if (status === 'lost' && !lostReason) throw new Error('Verlustgrund fehlt');
  const opp = {
    id: id(),
    location_id: locationId,
    pipeline_id: p.id,
    stage_id: stageId,
    contact_id: contact.id,
    name: input.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || 'Opportunity',
    value: Math.round(Number(input.value) || 0),
    status,
    assigned_to: input.assigned_to ?? null,
    source: input.source ?? '',
    expected_close_date: cleanCloseDate(input.expected_close_date),
    currency: cleanCurrency(input.currency),
    lost_reason: status === 'lost' ? lostReason : '',
    created_at: now(),
    updated_at: now(),
    stage_changed_at: now(),
  };
  app.db.insert('opportunities', opp);
  const stage = p.stages.find((s: any) => s.id === stageId);
  logActivity(app, locationId, contact.id, 'opportunity.created', `Opportunity „${opp.name}“ in ${p.name} / ${stage?.name ?? ''}`);
  app.events.emit(locationId, 'opportunity.created', { contactId: contact.id, opportunity: opp, pipelineId: p.id, stageId });
  return opp;
}

export function updateOpportunity(app: App, locationId: string, oppId: string, patch: Record<string, any>) {
  const cur = getOpportunity(app, locationId, oppId);
  if (!cur) throw new Error('Opportunity nicht gefunden');
  const next: Record<string, any> = { updated_at: now() };
  for (const k of ['name', 'assigned_to', 'source']) if (patch[k] !== undefined) next[k] = patch[k];
  // A deal with positions keeps the amount they add up to (modules/deal-lines.ts); a workflow's value is ignored then.
  if (patch.value !== undefined && !app.services.dealValueLocked?.(locationId, cur.id)) next.value = Math.round(Number(patch.value) || 0);
  if (patch.expected_close_date !== undefined) next.expected_close_date = cleanCloseDate(patch.expected_close_date);
  if (patch.currency !== undefined) next.currency = cleanCurrency(patch.currency);
  if (patch.pipeline_id !== undefined && patch.pipeline_id !== cur.pipeline_id) {
    const p = getPipeline(app, locationId, patch.pipeline_id);
    if (!p) throw new Error('Pipeline nicht gefunden');
    next.pipeline_id = p.id;
    if (!patch.stage_id) next.stage_id = p.stages[0]?.id;
  }
  if (patch.stage_id !== undefined) {
    const p = getPipeline(app, locationId, next.pipeline_id ?? cur.pipeline_id)!;
    if (!p.stages.some((s: any) => s.id === patch.stage_id)) throw new Error('Stufe gehört nicht zur Pipeline');
    next.stage_id = patch.stage_id;
  }
  if (patch.status !== undefined) {
    if (!OPP_STATUSES.includes(patch.status)) throw new Error('Unbekannter Status');
    next.status = patch.status;
  }
  // Moving a deal to lost always says why (reports group by it); any other status clears the reason again.
  // Deals that were already lost before reasons existed stay editable without one.
  const status = next.status ?? cur.status;
  if (status === 'lost') {
    if (patch.lost_reason !== undefined || cur.status !== 'lost') {
      const reason = cleanReason(patch.lost_reason);
      if (!reason) throw new Error('Verlustgrund fehlt – bitte angeben, warum der Deal verloren ging');
      next.lost_reason = reason;
    }
  } else if (cur.lost_reason) next.lost_reason = '';
  if (next.stage_id && next.stage_id !== cur.stage_id) next.stage_changed_at = now();
  app.db.update('opportunities', cur.id, next);
  const opp = getOpportunity(app, locationId, cur.id)!;
  if (next.stage_id && next.stage_id !== cur.stage_id) {
    const p = getPipeline(app, locationId, opp.pipeline_id)!;
    const stage = p.stages.find((s: any) => s.id === opp.stage_id);
    logActivity(app, locationId, opp.contact_id, 'opportunity.stage_changed', `„${opp.name}“ → ${stage?.name ?? '?'}`);
    app.events.emit(locationId, 'opportunity.stage_changed', { contactId: opp.contact_id, opportunity: opp, fromStageId: cur.stage_id, stageId: opp.stage_id, pipelineId: opp.pipeline_id });
  }
  if (next.status && next.status !== cur.status) {
    logActivity(app, locationId, opp.contact_id, 'opportunity.status_changed', `„${opp.name}“ ist jetzt ${next.status}${next.status === 'lost' && opp.lost_reason ? ` (Grund: ${opp.lost_reason})` : ''}`);
    app.events.emit(locationId, 'opportunity.status_changed', { contactId: opp.contact_id, opportunity: opp, status: next.status, pipelineId: opp.pipeline_id });
  }
  return opp;
}
