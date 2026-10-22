/**
 * Living Boards: the few constants the browser needs as well as the server (no imports, so the web app can use it).
 */

export const LIMITS = {
  widgets: 40,
  boardsPerLocation: 200,
  personalPerUser: 60,
  name: 80,
  title: 80,
  note: 8000,
  specBytes: 256 * 1024,
  versionsPerBoard: 300,
  ops: 25,
  prompt: 1000,
  proposalMinutes: 30,
};

/** Accent colours by name (the agent says "blau", the picker shows swatches). */
export const ACCENTS: Record<string, string> = { blau: '#2563eb', grün: '#16a34a', violett: '#7c3aed', orange: '#ea580c', rot: '#dc2626', türkis: '#0891b2', rosa: '#db2777', grau: '#64748b' };

export const accentName = (hex: string) => Object.entries(ACCENTS).find(([, v]) => v === hex)?.[0] ?? hex;

/** Icons a board can have (keys of the web app's icon map). */
export const BOARD_ICONS = ['boards', 'dashboard', 'project', 'tasks', 'deal', 'contacts', 'ticket', 'calendars', 'sparkles', 'heart', 'trophy', 'goal', 'social', 'products', 'invoices', 'conversations', 'campaigns', 'bot', 'gauge', 'star', 'funnels', 'calculator', 'company', 'courses', 'inbox', 'kanban', 'wiki', 'flag', 'attribution', 'house'] as const;
