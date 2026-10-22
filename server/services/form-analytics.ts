import type { FormField } from './form-fields.js';

/**
 * Per-field form analytics: what the form page reports (open, view, answer, submit, leave – no cookies, no address, a random id per page
 * visit), how a report is checked, and how the counts become views, answer rates, time per field, drop-offs and the completion funnel.
 */

export const EVENT_KINDS = ['o', 'v', 'a', 's', 'l'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const MAX_EVENTS_PER_REPORT = 60;
const SESSION = /^[A-Za-z0-9]{8,24}$/;
export const MAX_MS = 300_000;

export interface Report {
  session: string;
  events: { kind: EventKind; field: string; ms: number }[];
}

/** The page's report ({s: session, e: [[kind, fieldId, ms], …]}) → clean events; unknown fields and kinds are dropped, null when it is no report. */
export function cleanReport(body: unknown, fieldIds: Set<string>): Report | null {
  const b = body as { s?: unknown; e?: unknown } | null;
  if (!b || typeof b !== 'object' || !SESSION.test(String(b.s ?? '')) || !Array.isArray(b.e)) return null;
  const events: Report['events'] = [];
  for (const row of b.e.slice(0, MAX_EVENTS_PER_REPORT)) {
    if (!Array.isArray(row)) continue;
    const kind = String(row[0]) as EventKind;
    if (!(EVENT_KINDS as readonly string[]).includes(kind)) continue;
    const field = String(row[1] ?? '');
    if (field && !fieldIds.has(field)) continue;
    if ((kind === 'v' || kind === 'a') && !field) continue;
    const ms = Math.round(Number(row[2]));
    events.push({ kind, field, ms: Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 3_600_000) : 0 });
  }
  return events.length ? { session: String(b.s), events } : null;
}

export interface Aggregates {
  opened: number;
  started: number;
  submitted: number;
  /** Mean time from opening to submitting (ms). */
  avg_submit_ms: number;
  /** field → sessions that saw it / answered it, mean time (ms) of the answers, sessions that left on it. */
  views: Record<string, number>;
  answered: Record<string, number>;
  avg_ms: Record<string, number>;
  dropoffs: Record<string, number>;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export function assemble(fields: FormField[], a: Aggregates) {
  const asked = fields.filter((f) => !['heading', 'page_break', 'hidden'].includes(f.type));
  const rows = asked.map((f, i) => {
    const views = a.views[f.id] ?? 0;
    const answered = a.answered[f.id] ?? 0;
    return {
      id: f.id,
      label: f.label || f.name,
      type: f.type,
      position: i + 1,
      views,
      answered,
      answer_percent: pct(answered, views),
      dropoffs: a.dropoffs[f.id] ?? 0,
      dropoff_percent: pct(a.dropoffs[f.id] ?? 0, views),
      avg_seconds: Math.round(Math.min(a.avg_ms[f.id] ?? 0, MAX_MS)) / 1000,
    };
  });
  const funnel = [
    { step: 'Geöffnet', count: a.opened, percent: a.opened ? 100 : 0 },
    ...(a.started ? [{ step: 'Begonnen', count: a.started, percent: pct(a.started, a.opened) }] : []),
    ...rows.map((r) => ({ step: r.label, field: r.id, count: r.views, percent: pct(r.views, a.opened) })),
    { step: 'Abgeschickt', count: a.submitted, percent: pct(a.submitted, a.opened) },
  ];
  const worst = rows.filter((r) => r.dropoffs > 0).sort((x, y) => y.dropoffs - x.dropoffs)[0];
  const slowest = rows.filter((r) => r.answered >= 3).sort((x, y) => y.avg_seconds - x.avg_seconds)[0];
  return {
    totals: {
      opened: a.opened,
      started: a.started,
      submitted: a.submitted,
      completion_percent: pct(a.submitted, a.opened),
      abandon_percent: a.opened ? 100 - pct(a.submitted, a.opened) : 0,
      avg_submit_seconds: Math.round(a.avg_submit_ms / 1000),
    },
    fields: rows,
    funnel,
    worst_dropoff: worst ? { id: worst.id, label: worst.label, count: worst.dropoffs } : null,
    slowest: slowest ? { id: slowest.id, label: slowest.label, seconds: slowest.avg_seconds } : null,
  };
}
