import { ApiError, api } from '../api';
import type { IconName } from '../icons';
import { toastError } from '../ui';

/** What the journal tells the app about a change (server/services/undo-journal.ts → entryOut). */
export interface UndoChange {
  k: string;
  l: string;
  from: string;
  to: string;
}
export interface UndoEntry {
  id: string;
  request_id: string;
  at: string;
  kind: 'change' | 'undo';
  action: string;
  entity: string;
  entity_id: string;
  noun: string;
  label: string;
  actor: string;
  actor_kind: string;
  via: string;
  mine: boolean;
  count: number;
  items?: { id: string; entity: string; entity_id: string; label: string }[];
  changes: UndoChange[];
  notice: string;
  undone_at: string | null;
  undone_by: string | null;
  restorable: boolean;
  reason: string;
  can_undo: boolean;
  is_redo: boolean;
  removes: boolean;
  kids_text: string;
  expires_at: string;
  can_purge?: boolean;
}
export interface ConflictRow {
  field: string;
  label: string;
  entry: string;
  now: string;
  restore: string;
}
export interface UndoConflict {
  id: string;
  label: string;
  message: string;
  diff: ConflictRow[];
  notice?: string;
  single?: boolean;
}
export interface UndoneInfo {
  label: string;
  notices: string[];
  redo_id: string | null;
}

/** Kinds of records, as the filter and the icons know them. */
export const ENTITY: Record<string, { name: string; icon: IconName }> = {
  task: { name: 'Aufgaben', icon: 'tasks' },
  custom_field: { name: 'Eigene Felder', icon: 'edit' },
  contact: { name: 'Kontakte', icon: 'contact' },
  note: { name: 'Notizen', icon: 'note' },
  company: { name: 'Firmen', icon: 'company' },
  deal: { name: 'Deals', icon: 'deal' },
  pipeline: { name: 'Pipelines', icon: 'opportunities' },
  appointment: { name: 'Termine', icon: 'schedule' },
  conversation: { name: 'Konversationen', icon: 'chat' },
  message: { name: 'Entwürfe', icon: 'email' },
  ticket: { name: 'Tickets', icon: 'ticket' },
  product: { name: 'Produkte', icon: 'products' },
  invoice: { name: 'Rechnungsentwürfe', icon: 'invoices' },
  form: { name: 'Formulare', icon: 'forms' },
  funnel: { name: 'Funnels', icon: 'funnels' },
  funnel_page: { name: 'Seiten', icon: 'website' },
  tag: { name: 'Tags', icon: 'tag' },
  workflow: { name: 'Automationen', icon: 'workflows' },
  wiki_page: { name: 'Wiki', icon: 'wiki' },
  canvas: { name: 'Canvas', icon: 'canvas' },
  canvas_content: { name: 'Canvas', icon: 'canvas' },
  contact_merge: { name: 'Zusammenführungen', icon: 'merge' },
  custom_value: { name: 'Custom Values', icon: 'tag' },
  tag_category: { name: 'Tag-Kategorien', icon: 'tag' },
  blocked_contact: { name: 'Blockierte Absender', icon: 'shield' },
  call_script: { name: 'Gesprächsleitfäden', icon: 'doc' },
};
export const entityIcon = (e: string): IconName => ENTITY[e]?.icon ?? 'edit';
/** The filter offers one entry per name (canvas and canvas content share it). */
export const FILTER_TYPES: [string, string][] = Object.entries(ENTITY).filter(([k]) => k !== 'canvas_content').map(([k, v]) => [k, v.name]);

/** Who made the change, when it was not a person in the browser. */
export const ACTOR_BADGE: Record<string, string> = { agent: 'KI-Agent', api_key: 'API-Schlüssel', mcp: 'MCP', agency_key: 'Agentur-Schlüssel', app: 'App' };

const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return 'Heute';
  if (same(d, new Date(now.getTime() - 864e5))) return 'Gestern';
  return dayFmt.format(d);
}
export const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
export const daysLeft = (iso: string, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(iso) - now) / 864e5));

/** A sentence for screen readers (and the toast's live region). */
export const say = (text: string) => window.dispatchEvent(new CustomEvent('pghl:announce', { detail: text }));

/**
 * Takes one change back. Success → `pghl:undone` (the page reloads its data, a toast offers "Wiederholen");
 * a 409 conflict → `pghl:undo-conflict` opens the dialog with the diff; anything else is an error toast.
 */
export async function requestUndo(entry: { id: string; label?: string }, opts: { single?: boolean; force?: boolean } = {}): Promise<boolean> {
  try {
    const r = await api.post<UndoneInfo & { restored: unknown[] }>(`/api/undo/${encodeURIComponent(entry.id)}`, { force: opts.force === true, single: opts.single === true });
    window.dispatchEvent(new CustomEvent('pghl:undone', { detail: { label: r.label, notices: r.notices ?? [], redo_id: r.redo_id } satisfies UndoneInfo }));
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data?.conflict) {
      window.dispatchEvent(new CustomEvent('pghl:undo-conflict', { detail: { id: entry.id, label: entry.label ?? '', message: e.message, diff: e.data.diff ?? [], notice: e.data.notice, single: opts.single } satisfies UndoConflict }));
    } else toastError(e);
    return false;
  }
}
