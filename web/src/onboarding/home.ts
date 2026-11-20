/**
 * Where /app opens for an admin. With clients to look after it is the agency overview (all projects); with a single
 * company of their own – a self-hosted business, right after the first start – it is that company's dashboard, and the
 * agency stays one click away in the menu. The academy's practice company (server/modules/academy.ts SANDBOX_NAME) is
 * not a company of your own and does not count.
 */

const PRACTICE = 'Übungs-Firma (Akademie)';

export function adminHome(locations: readonly { name?: string | null }[]): 'agency' | 'dashboard' {
  return locations.filter((l) => l.name !== PRACTICE).length === 1 ? 'dashboard' : 'agency';
}

