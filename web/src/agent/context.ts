import { useEffect, useState } from 'react';
import { api } from '../api';

/** What the user is looking at – sent with every message (the agent's `ui_context` tool reads it). */
export interface UiContext {
  route: string;
  label?: string;
  entity?: { type: string; id: string; label?: string } | null;
  /** Focus mode: the page the companion was opened from ("das hier" = its record). */
  from?: string;
}

const PAGE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  reports: 'Berichte',
  project: 'Projekt',
  conversations: 'Konversationen',
  calls: 'Anrufe',
  calendars: 'Kalender',
  contacts: 'Kontakte',
  companies: 'Firmen',
  objects: 'Objekte',
  opportunities: 'Opportunities',
  tasks: 'Aufgaben',
  canvas: 'Canvas',
  wiki: 'Wiki',
  office: 'Office',
  'team-chat': 'Team-Chat',
  tickets: 'Tickets',
  'help-center': 'Wissensdatenbank',
  surveys: 'Umfragen',
  campaigns: 'Kampagnen',
  workflows: 'Automationen',
  social: 'Social Planner',
  'video-studio': 'Video-Studio',
  funnels: 'Funnels & Websites',
  forms: 'Formulare',
  courses: 'Kurse',
  community: 'Community',
  invoices: 'Rechnungen',
  contracts: 'Verträge',
  products: 'Produkte',
  affiliates: 'Affiliates',
  reviews: 'Bewertungen',
  accounting: 'Buchhaltung',
  inventory: 'Lager & Einkauf',
  personal: 'Personal',
  settings: 'Einstellungen',
  agency: 'Agentur',
  agents: 'KI-Agenten',
  academy: 'Akademie',
  apps: 'Apps',
  focus: 'Fokus-Modus',
};

// Record pages whose second segment is an id (server/services/agent-context.ts resolves them; tabs come back without a record).
const WITH_ENTITY = new Set(['contacts', 'companies', 'conversations', 'tickets', 'invoices', 'canvas', 'wiki', 'forms', 'funnels', 'workflows', 'courses', 'campaigns', 'contracts', 'webinars']);

/** The Arbeitsfläche (web/src/xr/Workspace.tsx) names the page of the panel the person works in; null = the address bar. */
export const contextRoute: { override: (() => string | null) | null } = { override: null };

/** Route (without /app/) + query of the current page. */
export function currentRoute(): string {
  const o = contextRoute.override?.();
  if (o) return o;
  const path = location.pathname.replace(/^\/app\/?/, '');
  const q = new URLSearchParams(location.search);
  // The inbox keeps the open conversation in ?c=
  if (path === 'conversations' && q.get('c')) return `conversations/${q.get('c')}`;
  return path;
}

/** The context chip: page label plus the open record (resolved with the user's rights). */
export function useUiContext(route: string, enabled: boolean): UiContext {
  const [ctx, setCtx] = useState<UiContext>({ route });
  useEffect(() => {
    const [page, id] = route.split('/');
    const base: UiContext = { route, label: PAGE_LABELS[page] ?? page, entity: null };
    setCtx(base);
    if (!enabled || !id || !WITH_ENTITY.has(page)) return;
    let alive = true;
    api
      .get(`/api/agent/context?route=${encodeURIComponent(route)}`)
      .then((r) => alive && r?.entity && setCtx({ ...base, label: r.label ?? base.label, entity: r.entity }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [route, enabled]);
  return ctx;
}
