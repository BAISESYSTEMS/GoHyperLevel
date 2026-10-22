import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';

/**
 * Shared setup of the planner tests: sub-account A (the admin "Chef"), a second sub-account B, and members:
 * Anna (tasks area), Ben (tasks + payments), Nora (calendar only – no access to the planner).
 */
export async function setupPm() {
  const t = await startTestApp();
  const me = await t.setup();
  const A = t.api.location;
  const B = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id as string;
  const mk = async (email: string, name: string, permissions: string[] | null, locations = [A]) => {
    const r = await t.api.post('/api/users', { email, name, password: 'passwort-1', role: 'member', locations, permissions });
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
    return { id: r.data.id as string, email, name };
  };
  const anna = await mk('anna@example.com', 'Anna Beispiel', ['contacts']);
  const ben = await mk('ben@example.com', 'Ben Muster', ['contacts', 'payments']);
  const nora = await mk('nora@example.com', 'Nora Kalender', ['calendars']);
  const login = async (email: string, loc = A) => {
    const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
    const r = await c('POST', '/api/auth/login', { email, password: 'passwort-1' });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.text}`);
    return c;
  };
  const chef = me.user.id as string;
  return { t, me, A, B, chef, anna, ben, nora, login };
}

export type Pm = Awaited<ReturnType<typeof setupPm>>;

/** `2026-10-05` style day relative to today in the test sub-account's zone (Europe/Berlin), for dates that must be "in the future / past". */
export const day = (offset = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 864e5).toISOString().slice(0, 10);
};

/** Runs the event bus dry: every listener queued by earlier writes has finished. */
export const settle = (t: { app: { events: { flush(): Promise<void> } } }) => t.app.events.flush();
