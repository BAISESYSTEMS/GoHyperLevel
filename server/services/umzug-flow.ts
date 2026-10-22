import type { RWorkflow } from './umzug-core.js';
import { clip } from './umzug-text.js';

/**
 * Small helpers the newer importers share for turning another tool's automation into a workflow DRAFT: a note step that carries the
 * original (nothing is lost silently), delays, and the common trigger/step vocabulary. The writer always saves these as drafts
 * labelled "bitte prüfen" and puts a note with the warnings in front (umzug-write.ts, workflow).
 */

export type Json = Record<string, any>;

export const noteStep = (vendor: string, what: string, original: unknown): Json => ({ type: 'add_note', body: `Nicht übernommen (${vendor}: ${what}). Original: ${clip(JSON.stringify(original), 3000)}` });

/** "5 minute(s)" / "2 hours" / "3 days" / "1 week" → a wait step (never zero). */
export function waitFor(value: unknown, unit: unknown): Json {
  const n = Math.max(1, Math.round(Number(value) || 1));
  const u = String(unit ?? 'day').toLowerCase();
  if (/^min/.test(u)) return { type: 'wait', amount: n, unit: 'minutes' };
  if (/^h/.test(u)) return { type: 'wait', amount: n, unit: 'hours' };
  if (/^w/.test(u)) return { type: 'wait', amount: n * 7, unit: 'days' };
  if (/^mo/.test(u)) return { type: 'wait', amount: n * 30, unit: 'days' };
  return { type: 'wait', amount: n, unit: 'days' };
}

/** A mail step; body falls back to a placeholder text that says where to take the content from. */
export function mailStep(vendor: string, subject: string, html: string | undefined | null, convert: (s: string) => string = (s) => s): { step: Json; missing: boolean } {
  const body = html ? convert(html) : `[Inhalt der E-Mail „${clip(subject, 80)}“ aus ${vendor} einfügen]`;
  return { step: { type: 'send_email', subject: convert(subject), body, isHtml: /<[a-z][\s\S]*>/i.test(body) }, missing: !html };
}

/** First defined value of several candidate keys (vendors are not consistent about names). */
export function arg(o: Json | undefined, ...keys: string[]): any {
  if (!o) return undefined;
  for (const k of keys) {
    const v = k.split('.').reduce<any>((a, p) => (a === undefined || a === null ? undefined : a[p]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function draft(ext: string, name: string, trigger: { type: string; config?: Json }, steps: Json[], warnings: string[]): RWorkflow {
  return { kind: 'workflow', ext, name: clip(name, 160) || 'Automation', trigger: { type: trigger.type, config: trigger.config ?? {} }, steps, warnings: [...new Set(warnings)] };
}

/** Markdown table cell: pipes and line breaks would break the table. */
export const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
