import type { WidgetData } from '../boards/types';

/** The answer of POST /api/focus/ask (server/modules/focus.ts). Mirrors the server; the browser never imports server code that needs Node. */

export interface FocusTile {
  id: string;
  type: string;
  title: string;
  config: Record<string, unknown>;
  /** default size of the widget type in the 12-column grid */
  w: number;
  h: number;
  /** where the numbers come from: area and period, the page to check them on, what exactly is counted */
  source: { label: string; url: string; hint: string };
  data?: WidgetData;
}

export interface FocusAnswer {
  say: string;
  source: 'ai' | 'rules';
  /** why the rules answered: rules = asked for, off = no AI here, limit = hourly limit, error / invalid = the model failed */
  note: 'rules' | 'off' | 'limit' | 'error' | 'invalid' | null;
  /** the person asked for something to be done – Fokus never does it, the HyperLevel Agent can */
  action: string | null;
  tiles: FocusTile[];
  at: string;
}

export interface FocusStatus {
  ai: boolean;
  reason: string | null;
  hourly: number;
  used: number;
  can_save: boolean;
}

export interface HistoryItem {
  q: string;
  at: number;
  answer?: FocusAnswer;
}
