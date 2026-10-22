import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/**
 * Security wave 10 (booking): guest invitations of public bookings (modules/booking-guests.ts) are no spam relay and do not hand out
 * the booker's manage link; save progress on forms (modules/form-drafts.ts) keeps answers on the device only when the visitor asks.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
const mails: any[] = [];
const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]));
let cal: any;
let slots: string[] = [];
let n = 0;

const book = (guests: string[], extra: Record<string, unknown> = {}) =>
  t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: slots[n++], first_name: 'Ute', email: `ute${n}@example.com`, consent: true, guests, ...extra });
const tokenOf = (apptId: string) => t.app.db.get<{ manage_token: string }>('SELECT manage_token FROM appointments WHERE id = ?', apptId)!.manage_token;
/** Lets the invitation delay pass for the given guest rows and runs the background jobs. */
const due = async (where = '1 = 1') => {
  t.app.db.run(`UPDATE appointment_guests SET created_at = ? WHERE ${where}`, new Date(Date.now() - 3600_000).toISOString());
  await t.app.tick();
};

beforeAll(async () => {
  pinClock('2026-11-02T06:00:00Z'); // Monday, 07:00 in Berlin
  t = await startTestApp();
  await t.setup();
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture' } } });
  cal = (await t.api.post('/api/calendars', { name: 'Paarberatung', duration: 60, interval: 60, min_notice: 0, max_days: 30, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0, meeting_location: 'Praxis Süd' } })).data;
  const put = await t.api.put(`/api/team-calendars/${cal.id}`, { config: { guests_max: 2 } });
  expect(put.status, JSON.stringify(put.data)).toBe(200);
  for (const day of ['2026-11-05', '2026-11-06']) slots.push(...((await t.api.get(`/api/public/team-calendars/${cal.slug}/slots?from=${day}&days=1`)).data.days[0].slots as string[]));
  expect(slots.length).toBeGreaterThanOrEqual(12);
});
afterAll(async () => {
  await t.close();
  unpinClock();
});

describe('guest invitations', () => {
  it('carry no text of the person booking and never the booker’s manage token', async () => {
    const r = await book(['gast1@example.com'], { first_name: 'Billig Pillen auf spam.example', last_name: 'JETZT KLICKEN' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await t.app.events.flush();
    await due();
    const m = mails.find((x) => x.to === 'gast1@example.com');
    expect(m).toBeTruthy();
    const all = JSON.stringify(m);
    expect(all).not.toContain('spam.example');
    expect(all).not.toContain('JETZT');
    expect(all).not.toContain(tokenOf(r.data.id));
    expect(m.text).toContain('Paarberatung');
    expect(m.text).toContain('Praxis Süd');
    // The calendar file travels with the mail instead of a link that carries the manage token.
    expect(m.attachments?.[0]?.filename).toBe('termin.ics');
    expect(m.attachments[0].content).toContain('BEGIN:VCALENDAR');
    expect(m.attachments[0].content).toContain(`UID:${r.data.id}@private-ghl`);
  });

  it('wait a short delay and go out only while the appointment stands', async () => {
    const r = await book(['gast2@example.com']);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await t.app.events.flush();
    await t.app.tick();
    expect(mails.filter((x) => x.to === 'gast2@example.com')).toHaveLength(0);
    await due(`email = 'gast2@example.com'`);
    expect(mails.filter((x) => x.to === 'gast2@example.com')).toHaveLength(1);
    expect((await t.api.get(`/api/appointments/${r.data.id}/guests`)).data[0].invited_at).toBeTruthy();
  });

  it('are never sent for a booking that is cancelled right away', async () => {
    const r = await book(['gast3@example.com']);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await t.app.events.flush();
    expect((await t.api.post(`/api/public/team-calendars/manage/${tokenOf(r.data.id)}/cancel`, {})).status).toBe(200);
    await t.app.events.flush();
    await due(`email = 'gast3@example.com'`);
    expect(mails.filter((x) => x.to === 'gast3@example.com')).toHaveLength(0);
    expect((await t.api.get(`/api/appointments/${r.data.id}/guests`)).data[0].invited_at).toBeNull();
  });

  it('are limited per IP on the public booking page', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6 && !statuses.includes(429); i++) statuses.push((await book([`ip${i}a@example.com`, `ip${i}b@example.com`])).status);
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(200);
    const added = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM appointment_guests')!.n;
    expect(added).toBeLessThanOrEqual(10);
    // Without guests the visitor can still book.
    expect((await book([])).status).toBe(200);
  });

  it('are limited per sub-account and hour; the rest wait', async () => {
    const appt = t.app.db.get<{ id: string }>(`SELECT a.id FROM appointments a JOIN appointment_guests g ON g.appointment_id = a.id WHERE g.email = 'gast2@example.com'`)!;
    for (let i = 0; i < 60; i++) t.app.db.run('INSERT INTO appointment_guests (id, location_id, appointment_id, email, created_at) VALUES (?, ?, ?, ?, ?)', `bulk${i}`, t.api.location, appt.id, `bulk${i}@example.com`, new Date().toISOString());
    await due(`email LIKE 'bulk%'`);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM appointment_guests WHERE location_id = ? AND invited_at > ?', t.api.location, hourAgo)!.n).toBe(50);
    await t.app.tick();
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM appointment_guests WHERE location_id = ? AND invited_at > ?', t.api.location, hourAgo)!.n).toBe(50);
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM appointment_guests WHERE email LIKE 'bulk%' AND invited_at IS NULL`)!.n).toBeGreaterThan(0);
  });
});

describe('save progress on forms', () => {
  let formId = '';
  const pub = (method: string, path: string, body?: unknown) => t.api.raw(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    const f = await t.api.post('/api/forms', {
      name: 'Anfrage',
      fields: [
        { id: 'n', label: 'Name', type: 'text', name: 'first_name', required: true },
        { id: 'e', label: 'E-Mail', type: 'email', name: 'email', required: true },
        { id: 'd', label: 'Ich stimme der Datenschutzerklärung zu', type: 'consent', name: 'datenschutz' },
      ],
      settings: { save_progress: true },
    });
    expect(f.status, JSON.stringify(f.data)).toBe(200);
    formId = f.data.id;
    const cur = (await t.api.get(`/api/forms/${formId}`)).data;
    if (cur.settings?.save_progress !== true) await t.api.patch(`/api/forms/${formId}`, { settings: { ...cur.settings, save_progress: true } });
  });

  /** Runs the form's save-progress script against a tiny stand-in for the browser. */
  async function runScript(store: Map<string, string>, elements: any[]) {
    const page = await (await t.api.raw(`/f/${formId}`)).text();
    const script = page.split('<script>').pop()!.split('</script>')[0];
    const listeners: Record<string, (() => void)[]> = {};
    const created: any[] = [];
    const mk = (tag: string): any => {
      const q: Record<string, any> = {};
      const el: any = { tag, style: {}, children: [], hidden: false, textContent: '', innerHTML: '', setAttribute() {}, appendChild: (c: any) => el.children.push(c), querySelector: (s: string) => (q[s] ??= mk(s)), q };
      created.push(el);
      return el;
    };
    const form = { elements, parentNode: { insertBefore() {} }, nextSibling: null, addEventListener: (ev: string, fn: () => void) => (listeners[ev] ??= []).push(fn), querySelector: () => null };
    const document = { getElementById: (x: string) => (x === `pf_${formId}` ? form : null), createElement: mk };
    const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) };
    const run = new Function('document', 'localStorage', 'location', 'fetch', 'setTimeout', 'clearTimeout', 'Event', 'window', 'URLSearchParams', script);
    run(document, localStorage, { search: '', pathname: `/f/${formId}` }, () => Promise.resolve({ ok: false, json: async () => ({}) }), (fn: () => void) => (fn(), 0), () => undefined, class {}, {}, URLSearchParams);
    return { input: () => (listeners.input ?? []).forEach((fn) => fn()), details: created.find((e) => e.tag === 'details') };
  }
  const fields = () => [
    { name: 'first_name', type: 'text', value: '', dispatchEvent() {} },
    { name: 'email', type: 'email', value: '', dispatchEvent() {} },
    { name: 'datenschutz', type: 'checkbox', value: 'ja', checked: false, dispatchEvent() {} },
  ];

  it('does not keep answers on the device while the visitor types', async () => {
    const store = new Map<string, string>();
    const els = fields();
    const s = await runScript(store, els);
    els[0].value = 'Erste Person';
    s.input();
    expect([...store.keys()].filter((k) => k.startsWith('pghl_draft_'))).toEqual([]);
  });

  it('does not refill answers a former visitor left on the device without asking', async () => {
    const store = new Map([[`pghl_draft_${formId}`, JSON.stringify({ at: Date.now(), v: { first_name: 'Vorgänger', datenschutz: ['ja'] } })]]);
    const els = fields();
    await runScript(store, els);
    expect(els[0].value).toBe('');
    expect(els[2].checked).toBe(false);
    expect(store.has(`pghl_draft_${formId}`)).toBe(false);
  });

  it('keeps answers on the device after the visitor asks, but never the consent box', async () => {
    const store = new Map<string, string>();
    const els = fields();
    const s = await runScript(store, els);
    els[0].value = 'Ina';
    els[2].checked = true;
    s.input();
    const keep = s.details.q['button[data-act=device]'];
    expect(typeof keep.onclick).toBe('function');
    keep.onclick();
    const saved = JSON.parse(store.get(`pghl_draft_${formId}`)!);
    expect(saved.v).toEqual({ first_name: 'Ina' });
    const again = fields();
    await runScript(store, again);
    expect(again[0].value).toBe('Ina');
    expect(again[2].checked).toBe(false);
  });

  it('never stores consent (or other sensitive fields) in an e-mail draft', async () => {
    const r = await pub('POST', `/api/public/forms/${formId}/draft`, { email: 'ina@example.com', data: { first_name: 'Ina', datenschutz: 'ja' } });
    expect(r.status, await r.clone().text()).toBe(200);
    const row = t.app.db.get<any>(`SELECT data FROM form_drafts WHERE email = 'ina@example.com'`);
    expect(JSON.parse(row.data)).toEqual({ first_name: 'Ina' });
  });
});
