import type { Bp, Cell } from '../../../server/services/boards-layout';

/** The shapes of the Living Boards API (docs/living-boards.md). Mirrors the server; the browser never imports server code that needs Node. */

export type Tone = 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple';
export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'bool' | 'url' | 'multi' | 'list' | 'json';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  placeholder?: string;
  options?: [string, string][];
  optionsFrom?: string;
  dependsOn?: string;
  default?: unknown;
  min?: number;
  max?: number;
  maxLength?: number;
  showIf?: { key: string; in: string[] };
  item?: FieldDef[];
  maxItems?: number;
  hidden?: boolean;
  local?: boolean;
  cosmetic?: boolean;
}

export interface WidgetType {
  type: string;
  label: string;
  description: string;
  icon: string;
  category: string;
  category_label: string;
  keywords: string[];
  access: string;
  access_label: string;
  size: { w: number; h: number; minW: number; minH: number; maxW: number; maxH: number };
  risk: 'normal' | 'high';
  fields: FieldDef[];
  source: string;
}
export interface Catalogue {
  widgets: WidgetType[];
  categories: { key: string; label: string }[];
  limits: { widgets: number; ops: number };
}

export interface Widget {
  id: string;
  type: string;
  title: string;
  config: Record<string, any>;
  layout: { lg: Cell; md?: Cell; sm?: Cell };
}
export interface Spec {
  v: 1;
  widgets: Widget[];
  custom?: { md?: boolean; sm?: boolean };
}
export interface BoardState {
  name: string;
  icon: string;
  accent: string;
  spec: Spec;
}
export interface Viewer {
  user_id: string | null;
  name: string;
}
export interface BoardItem {
  id: string;
  name: string;
  icon: string;
  accent: string;
  scope: 'personal' | 'shared';
  team_access: 'view' | 'edit';
  owner_id: string | null;
  owner_name: string;
  mine: boolean;
  access: 'owner' | 'edit' | 'view';
  version: number;
  template_key: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  home: boolean;
  viewers: Viewer[];
  widgets: number;
  preview?: { type: string; x: number; y: number; w: number; h: number }[];
}
export interface BoardFull extends BoardItem {
  spec: Spec;
  can_undo: boolean;
  can_redo: boolean;
}

export type ActionKind = 'workflow' | 'form' | 'page' | 'task' | 'contact';
export interface ActionView {
  id: string;
  label: string;
  icon?: string;
  kind: ActionKind;
  target: string;
  enabled: boolean;
  why?: string;
  href?: string;
}
export interface ListRow {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  at?: string;
  badge?: { text: string; tone?: Tone };
  url?: string;
  check?: { task_id: string; done: boolean };
}
export type NumberFormat = 'number' | 'money' | 'percent' | 'days' | 'minutes';
export type View = { title?: string } & (
  | { kind: 'number'; value: string | number | null; label?: string; format?: NumberFormat; delta?: number | null; hint?: string; url?: string; tone?: Tone }
  | { kind: 'numbers'; items: { label: string; value: string | number | null; format?: NumberFormat; tone?: Tone }[]; url?: string; hint?: string }
  | { kind: 'report'; viz: string; result: any; url?: string }
  | { kind: 'list'; rows: ListRow[]; total?: number; empty?: string; url?: string }
  | { kind: 'table'; columns: { key: string; label: string; align?: 'right' }[]; rows: Record<string, string | number | null>[]; total?: number; empty?: string; url?: string }
  | { kind: 'kanban'; columns: { id: string; title: string; count: number; sum?: number; cards: { id: string; title: string; subtitle?: string; meta?: string; url?: string }[] }[]; url?: string; empty?: string }
  | { kind: 'agenda'; days: { date: string; label: string; items: { id: string; time: string; title: string; subtitle?: string; url?: string; tone?: Tone }[] }[]; empty?: string; url?: string }
  | { kind: 'markdown'; text: string; url?: string }
  | { kind: 'embed'; url: string }
  | { kind: 'actions'; actions: ActionView[] }
  | { kind: 'frame'; plugin_id: string; entry: string }
  | { kind: 'message'; text: string; tone?: Tone; action?: { label: string; url: string } }
  | { kind: 'locked'; reason: string }
);
export interface WidgetData {
  view: View;
  ms: number;
}

export interface Change {
  kind: 'add' | 'remove' | 'move' | 'resize' | 'configure' | 'rename' | 'theme';
  widget_id?: string;
  text: string;
}
export type Risk = 'low' | 'normal' | 'high';
export interface Proposal {
  id: string;
  status: 'pending' | 'applied' | 'rejected' | 'expired';
  prompt: string;
  message: string;
  risk: Risk;
  base_version: number;
  expires_at: string;
  via: string;
  unsupported: { need: string; reason: string }[];
  changes?: Change[];
  summary?: string;
  after?: BoardState;
}
export interface ComposeResult {
  ok: boolean;
  applied?: boolean;
  proposal: Proposal | null;
  message: string;
  unsupported?: { need: string; reason: string }[];
  errors?: string[];
  board?: BoardFull;
  version?: number;
}

export interface VersionItem {
  n: number;
  parent_n: number | null;
  kind: string;
  summary: string;
  prompt: string;
  actor: string;
  via: string;
  at: string;
  current: boolean;
  widgets: number;
}

export interface TemplateItem {
  id: string;
  name: string;
  description: string;
  category: string;
  category_label: string;
  icon: string;
  accent: string;
  scope: 'location' | 'marketplace';
  version: number;
  installs: number;
  widgets: number;
  preview: { type: string; x: number; y: number; w: number; h: number }[];
  author: string;
  mine: boolean;
  can_manage: boolean;
  published_at: string | null;
  updated_at: string;
  items?: { type: string; title: string }[];
  review?: TemplateReview;
}
export interface TemplateReview {
  verdict: 'ok' | 'warn' | 'fail';
  checks: { level: 'ok' | 'warn' | 'fail'; text: string }[];
  needs: { key: string; label: string }[];
  areas: string[];
  hosts: string[];
  actions: boolean;
  widgets: number;
}
export interface Starter {
  key: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  widgets: number;
  preview: { type: string; x: number; y: number; w: number; h: number }[];
}

export type { Bp, Cell };
