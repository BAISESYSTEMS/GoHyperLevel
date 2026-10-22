import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/** Leistungsmenü: services → person → time → details on one public page (modules/service-menu.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
const ids: Record<string, string> = {};
const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]));
const pub = (path: string, body?: unknown) =>
  t.api.raw(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

beforeAll(async () => {
  pinClock('2026-11-02T06:00:00Z'); // Monday, 07:00 in Berlin
  t = await startTestApp();
  await t.setup();
  for (const [key, name] of [
    ['anna', 'Anna Schnitt'],
    ['ben', 'Ben Bart'],
  ] as const)
    ids[key] = (await t.api.post('/api/users', { email: `${key}@example.com`, password: `passwort-${key}1`, name, locations: [t.api.location], permissions: ['calendars'] })).data.id;
  const mk = async (name: string, duration: number, extra: Record<string, any> = {}) =>
    (await t.api.post('/api/calendars', { name, description: `${name} – mit Beratung`, duration, interval: 60, min_notice: 0, max_days: 30, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0 }, ...extra })).data;
  const cut = await mk('Haarschnitt', 45);
  ids.cut = cut.id;
  const r = await t.api.put(`/api/team-calendars/${cut.id}`, { config: { kind: 'round_robin', questions: [{ id: 'len', label: 'Haarlänge', type: 'choice', required: true, options: ['kurz', 'lang'] }] }, members: [{ user_id: ids.anna }, { user_id: ids.ben }] });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  ids.color = (await mk('Färben', 90)).id;
  ids.off = (await mk('Inaktiv', 30)).id;
  t.app.db.run('UPDATE calendars SET active = 0 WHERE id = ?', ids.off);
  ids.other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
});
afterAll(async () => {
  await t.close();
  unpinClock();
});

describe('service menu', () => {
  let slug = '';
  it('creates a menu with categories of calendars and validates them', async () => {
    expect((await t.api.post('/api/service-menus', { name: 'Salon' , categories: [{ name: 'X', calendar_ids: ['gibtsnicht'] }] })).status).toBe(400);
    expect((await t.api.post('/api/service-menus', { name: 'Salon', slug: 'Ungültig!' })).status).toBe(400);
    const r = await t.api.post('/api/service-menus', {
      name: 'Salon Schön',
      intro: 'Wähle deine Leistung.',
      categories: [
        { name: 'Schneiden', calendar_ids: [ids.cut, ids.off] },
        { name: 'Farbe', calendar_ids: [ids.color] },
      ],
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ slug: 'salon-schoen', staff_choice: true, active: true });
    expect(r.data.url).toMatch(/\/book\/s\/salon-schoen$/);
    slug = r.data.slug;
    ids.menu = r.data.id;
    // A second menu with the same name gets a free short name; a taken one is refused.
    expect((await t.api.post('/api/service-menus', { name: 'Salon Schön' })).data.slug).toBe('salon-schoen-2');
    expect((await t.api.patch(`/api/service-menus/${ids.menu}`, { slug: 'salon-schoen-2' })).status).toBe(409);
    expect((await t.api.get('/api/service-menus')).data).toHaveLength(2);
  });

  it('shows the active services with team, duration and questions', async () => {
    const m = await pub(`/api/public/service-menus/${slug}`);
    expect(m.status).toBe(200);
    expect(m.data.categories.map((c: any) => [c.name, c.services.map((s: any) => s.name)])).toEqual([
      ['Schneiden', ['Haarschnitt']],
      ['Farbe', ['Färben']],
    ]);
    const cut = m.data.categories[0].services[0];
    expect(cut).toMatchObject({ duration: 45, kind: 'round_robin', price_cents: 0 });
    expect(cut.team.map((p: any) => p.name)).toEqual(['Anna Schnitt', 'Ben Bart']);
    expect(cut.questions[0]).toMatchObject({ label: 'Haarlänge', type: 'choice', required: true });
    ids.q = cut.questions[0].id;
    const page = await (await t.api.raw(`/book/s/${slug}`)).text();
    expect(page).toContain('Salon Schön');
    expect(page).toContain('/api/public/service-menus/');
    expect((await t.api.raw('/book/s/gibtsnicht')).status).toBe(404);
  });

  it('books a chosen person; slots of that person only; unknown people and services are refused', async () => {
    const all = (await pub(`/api/public/service-menus/${slug}/slots?calendar_id=${ids.cut}&from=2026-11-03&days=1`)).data;
    const start = all.days[0].slots[0];
    expect(start).toBe('2026-11-03T08:00:00.000Z'); // 09:00 in Berlin
    const ok = await pub(`/api/public/service-menus/${slug}/book`, { calendar_id: ids.cut, host_id: ids.ben, start, first_name: 'Erika', email: 'erika@example.com', consent: true, answers: { [ids.q]: 'kurz' } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data).toMatchObject({ status: 'confirmed', hosts: ['Ben Bart'] });
    const appt = t.app.db.get<any>(`SELECT * FROM appointments WHERE calendar_id = ? AND start_at = ?`, ids.cut, start);
    expect(appt).toMatchObject({ assignee_id: ids.ben, source: 'Leistungsmenü' });
    // Ben is busy at 09:00 now – his slots skip it, Anna's still have it.
    const benSlots = (await pub(`/api/public/service-menus/${slug}/slots?calendar_id=${ids.cut}&host_id=${ids.ben}&from=2026-11-03&days=1`)).data.days[0].slots;
    const annaSlots = (await pub(`/api/public/service-menus/${slug}/slots?calendar_id=${ids.cut}&host_id=${ids.anna}&from=2026-11-03&days=1`)).data.days[0].slots;
    expect(benSlots).not.toContain(start);
    expect(annaSlots).toContain(start);
    // Required question, consent, foreign person, a calendar outside the menu.
    expect((await pub(`/api/public/service-menus/${slug}/book`, { calendar_id: ids.cut, start: annaSlots[1], first_name: 'E', email: 'e2@example.com', consent: true })).status).toBe(400);
    expect((await pub(`/api/public/service-menus/${slug}/book`, { calendar_id: ids.cut, start: annaSlots[1], first_name: 'E', email: 'e2@example.com', answers: { [ids.q]: 'lang' } })).status).toBe(400);
    expect((await pub(`/api/public/service-menus/${slug}/slots?calendar_id=${ids.cut}&host_id=fremd`)).status).toBe(400);
    expect((await pub(`/api/public/service-menus/${slug}/slots?calendar_id=${ids.off}`)).status).toBe(404);
    // A plain (single) calendar books too.
    const color = (await pub(`/api/public/service-menus/${slug}/slots?calendar_id=${ids.color}&from=2026-11-04&days=1`)).data.days[0].slots[0];
    const c = await pub(`/api/public/service-menus/${slug}/book`, { calendar_id: ids.color, start: color, first_name: 'Frida', email: 'frida@example.com', consent: true });
    expect(c.data.status, JSON.stringify(c.data)).toBe('confirmed');
  });

  it('switching off the staff choice ignores no person silently – it refuses one', async () => {
    await t.api.patch(`/api/service-menus/${ids.menu}`, { staff_choice: false });
    const m = await pub(`/api/public/service-menus/${slug}`);
    expect(m.data.categories[0].services[0].team).toEqual([]);
    expect((await pub(`/api/public/service-menus/${slug}/slots?calendar_id=${ids.cut}&host_id=${ids.anna}`)).status).toBe(400);
    await t.api.patch(`/api/service-menus/${ids.menu}`, { active: false });
    expect((await pub(`/api/public/service-menus/${slug}`)).status).toBe(404);
  });

  it('stays inside the sub-account and has MCP tools', async () => {
    t.api.setLocation(ids.other);
    expect((await t.api.get(`/api/service-menus/${ids.menu}`)).status).toBe(404);
    expect((await t.api.post('/api/service-menus', { name: 'Fremd', categories: [{ name: 'X', calendar_ids: [ids.cut] }] })).status).toBe(400);
    const names = (t.app.services.mcpTools as any[]).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_service_menus', 'ghl_service_menu_save']));
  });
});

describe('conditional booking questions', () => {
  it('keeps a condition only on an earlier choice/yes-no question and checks answers server-side', async () => {
    const { checkConditions, cleanQuestion, validateAnswers } = await import('../server/services/teamcal-model.js');
    const qs = checkConditions([
      cleanQuestion({ id: 'kind', label: 'Neukunde?', type: 'choice', options: ['Ja, neu', 'Nein'], required: true }),
      cleanQuestion({ id: 'source', label: 'Wie hast du uns gefunden?', type: 'text', required: true, show_if: { id: 'kind', values: ['Ja, neu'] } }),
      cleanQuestion({ id: 'park', label: 'Parkplatz nötig', type: 'checkbox' }),
      cleanQuestion({ id: 'plate', label: 'Kennzeichen', type: 'text', required: true, show_if: { id: 'park', values: ['Ja'] } }),
    ]);
    expect(qs[1].show_if).toEqual({ id: 'kind', values: ['Ja, neu'] });
    // Not asked: neither required nor stored, even if something was sent.
    expect(validateAnswers(qs, { kind: 'Nein', source: 'Google', park: false, plate: 'B-XY 1' }).map((a) => a.id)).toEqual(['kind', 'park']);
    // Asked: required.
    expect(() => validateAnswers(qs, { kind: 'Ja, neu', park: false })).toThrow('Wie hast du uns gefunden?');
    expect(() => validateAnswers(qs, { kind: 'Nein', park: true })).toThrow('Kennzeichen');
    expect(validateAnswers(qs, { kind: 'Ja, neu', source: 'Empfehlung', park: true, plate: 'B-XY 1' }).map((a) => a.value)).toEqual(['Ja, neu', 'Empfehlung', 'Ja', 'B-XY 1']);
    // A condition on a later or a text question, or with an unknown answer, is refused.
    expect(() => checkConditions([cleanQuestion({ id: 'aaaa', label: 'A', type: 'text', show_if: { id: 'bbbb', values: ['x'] } }), cleanQuestion({ id: 'bbbb', label: 'B', type: 'choice', options: ['x', 'y'] })])).toThrow('frühere');
    expect(() => checkConditions([cleanQuestion({ id: 'aaaa', label: 'A', type: 'text' }), cleanQuestion({ id: 'bbbb', label: 'B', type: 'text', show_if: { id: 'aaaa', values: ['x'] } })])).toThrow('frühere');
    expect(() => checkConditions([cleanQuestion({ id: 'aaaa', label: 'A', type: 'choice', options: ['x', 'y'] }), cleanQuestion({ id: 'bbbb', label: 'B', type: 'text', show_if: { id: 'aaaa', values: ['z'] } })])).toThrow('nicht gibt');
  });

  it('the booking page and the public booking follow the condition', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Erstberatung', duration: 30, interval: 60, min_notice: 0, max_days: 30, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0 } })).data;
    const put = await t.api.put(`/api/team-calendars/${cal.id}`, {
      config: {
        questions: [
          { id: 'kind', label: 'Neukunde?', type: 'choice', options: ['Ja', 'Nein'], required: true },
          { id: 'source', label: 'Wie hast du uns gefunden?', type: 'text', required: true, show_if: { id: 'kind', values: ['Ja'] } },
        ],
      },
    });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect((await t.api.put(`/api/team-calendars/${cal.id}`, { config: { questions: [{ id: 'aaaa', label: 'A', type: 'text', show_if: { id: 'zzzz', values: ['x'] } }] } })).status).toBe(400);
    const html = await (await t.api.raw(`/book/${cal.slug}`)).text();
    expect(html).toContain('refreshQ');
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1] ?? html.split('<script>').pop()!.split('</script>')[0];
    expect(() => new Function(script)).not.toThrow();
    const slots = (await t.api.get(`/api/public/team-calendars/${cal.slug}/slots?from=2026-11-04&days=1`)).data.days[0].slots;
    const base = { first_name: 'Rita', consent: true };
    expect((await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { ...base, email: 'rita@example.com', start: slots[0], answers: { kind: 'Ja' } })).data.error).toContain('Wie hast du uns gefunden?');
    const ok = await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { ...base, email: 'rita2@example.com', start: slots[1], answers: { kind: 'Nein', source: 'soll nicht gespeichert werden' } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const appt = t.app.db.get<any>('SELECT answers FROM appointments WHERE calendar_id = ? AND start_at = ?', cal.id, slots[1]);
    expect(JSON.parse(appt.answers).map((a: any) => a.id)).toEqual(['kind']);
  });
});

describe('guests per booking', () => {
  it('lets visitors add guests up to the limit, invites them, and refuses guests where none are allowed', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Paarberatung', duration: 60, interval: 60, min_notice: 0, max_days: 30, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0, meeting_location: 'Praxis Süd' } })).data;
    const slots = async () => (await t.api.get(`/api/public/team-calendars/${cal.slug}/slots?from=2026-11-05&days=1`)).data.days[0].slots as string[];
    // Plain calendar without guests: a guest list is refused.
    await t.api.put(`/api/team-calendars/${cal.id}`, { config: { policy_text: 'Absage bis 24 Std.' } });
    const s0 = await slots();
    expect((await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: s0[0], first_name: 'Ute', email: 'ute@example.com', consent: true, guests: ['gast@example.com'] })).data.error).toContain('keine Gäste');
    // Two guests allowed.
    const put = await t.api.put(`/api/team-calendars/${cal.id}`, { config: { guests_max: 2 } });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect((await t.api.get(`/api/team-calendars/${cal.id}`)).data.config.guests_max).toBe(2);
    const page = await (await t.api.raw(`/book/${cal.slug}`)).text();
    expect(page).toContain('id="f-guests"');
    expect(page).toContain('Bis zu 2 Personen');
    expect((await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: s0[0], first_name: 'Ute', email: 'ute@example.com', consent: true, guests: ['a@example.com', 'b@example.com', 'c@example.com'] })).data.error).toContain('Höchstens 2');
    expect((await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: s0[0], first_name: 'Ute', email: 'ute@example.com', consent: true, guests: ['kaputt'] })).status).toBe(400);
    const ok = await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: s0[0], first_name: 'Ute', email: 'ute@example.com', consent: true, guests: ['Partner@Example.com', 'ute@example.com', 'partner@example.com'] });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    await t.app.events.flush();
    // Invitations go out after a short delay while the appointment stands (modules/booking-guests.ts).
    t.app.db.run('UPDATE appointment_guests SET created_at = ? WHERE appointment_id = ?', new Date(Date.now() - 3600_000).toISOString(), ok.data.id);
    await t.app.tick();
    const guests = (await t.api.get(`/api/appointments/${ok.data.id}/guests`)).data;
    expect(guests.map((g: any) => g.email)).toEqual(['partner@example.com']);
    expect(guests[0].invited_at).toBeTruthy();
    const list = (await t.api.get('/api/appointments')).data;
    expect((Array.isArray(list) ? list : list.appointments ?? []).find((a: any) => a.id === ok.data.id)?.guests).toEqual(['partner@example.com']);
    // DSGVO: the guest's rows go with a contact of that address.
    const gc = (await t.api.post('/api/contacts', { first_name: 'Partner', email: 'partner@example.com' })).data.id;
    expect((await t.api.get(`/api/contacts/${gc}/privacy-export`)).data.data['appointment_guests (E-Mail)']).toHaveLength(1);
    await t.api.post(`/api/contacts/${gc}/erase`, { confirm: gc });
    expect(t.app.db.get('SELECT 1 AS x FROM appointment_guests WHERE email = ?', 'partner@example.com')).toBeUndefined();
  });
});

describe('several meeting lengths in one calendar', () => {
  it('offers the lengths, books with the chosen one, keeps it when moved, refuses others', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Coaching flexibel', duration: 30, interval: 30, min_notice: 0, max_days: 30, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0 } })).data;
    expect((await t.api.put(`/api/team-calendars/${cal.id}`, { config: { durations: ['90', 60, 60, 'x'] } })).status).toBe(200);
    expect((await t.api.get(`/api/team-calendars/${cal.id}`)).data.config.durations).toEqual([60, 90]);
    expect((await t.api.put(`/api/team-calendars/${cal.id}`, { config: { payment: { mode: 'full', amount_cents: 5000 } } })).status).toBe(400);
    const html = await (await t.api.raw(`/book/${cal.slug}`)).text();
    expect(html).toContain('30 / 60 / 90 Minuten');
    expect(html).toContain('name="duration" value="90"');
    const day = async (d?: number) => (await t.api.get(`/api/public/team-calendars/${cal.slug}/slots?from=2026-11-06&days=1${d ? `&duration=${d}` : ''}`)).data.days[0].slots as string[];
    const s30 = await day();
    const s90 = await day(90);
    expect(s30.at(-1)).toBe('2026-11-06T15:30:00.000Z'); // 16:30 Berlin, ends 17:00
    expect(s90.at(-1)).toBe('2026-11-06T14:30:00.000Z'); // 15:30 Berlin, ends 17:00
    expect((await t.api.get(`/api/public/team-calendars/${cal.slug}/slots?from=2026-11-06&days=1&duration=45`)).status).toBe(400);
    const b = await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: s90[0], duration: 90, first_name: 'Dora', email: 'dora@example.com', consent: true });
    expect(b.status, JSON.stringify(b.data)).toBe(200);
    const row = t.app.db.get<any>('SELECT * FROM appointments WHERE id = ?', b.data.id);
    expect((Date.parse(row.end_at) - Date.parse(row.start_at)) / 60_000).toBe(90);
    // Moved by the customer: still 90 minutes.
    const moved = await t.api.post(`/api/public/team-calendars/manage/${row.manage_token}/reschedule`, { start: '2026-11-06T12:00:00.000Z' });
    expect(moved.status, JSON.stringify(moved.data)).toBe(200);
    const after = t.app.db.get<any>('SELECT * FROM appointments WHERE id = ?', b.data.id);
    expect(after.end_at).toBe('2026-11-06T13:30:00.000Z');
    expect((await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: s30[0], duration: 45, first_name: 'Dora', email: 'dora2@example.com', consent: true })).status).toBe(400);
  });
});

describe('several appointments in one booking', () => {
  it('books all chosen times or none, within the limit', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Paket 3 Sitzungen', duration: 60, interval: 60, min_notice: 0, max_days: 30, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0 } })).data;
    const many = (body: Record<string, unknown>) => t.api.post(`/api/public/team-calendars/${cal.slug}/book-many`, { first_name: 'Mona', email: 'mona@example.com', consent: true, ...body });
    expect((await many({ starts: ['2026-11-09T08:00:00Z', '2026-11-10T08:00:00Z'] })).data.error).toContain('nur eine Zeit');
    expect((await t.api.put(`/api/team-calendars/${cal.id}`, { config: { multi_max: 3 } })).status).toBe(200);
    expect(await (await t.api.raw(`/book/${cal.slug}`)).text()).toContain('Weitere Zeit hinzufügen');
    expect((await many({ starts: ['2026-11-09T08:00:00Z'] })).status).toBe(400);
    expect((await many({ starts: ['2026-11-09T08:00:00Z', '2026-11-10T08:00:00Z', '2026-11-11T08:00:00Z', '2026-11-12T08:00:00Z'] })).data.error).toContain('Höchstens 3');
    expect((await many({ starts: ['2026-11-09T08:00:00Z', '2026-11-09T08:30:00Z'] })).data.error).toContain('überschneiden');
    const ok = await many({ starts: ['2026-11-10T08:00:00Z', '2026-11-09T08:00:00Z'] });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.appointments.map((a: any) => a.start_at)).toEqual(['2026-11-09T08:00:00.000Z', '2026-11-10T08:00:00.000Z']);
    // One time is taken now: nothing is booked, the first one is rolled back.
    const before = t.app.db.get<any>(`SELECT COUNT(*) AS n FROM appointments WHERE calendar_id = ? AND status = 'confirmed'`, cal.id).n;
    const bad = await many({ email: 'nico@example.com', first_name: 'Nico', starts: ['2026-11-11T08:00:00Z', '2026-11-10T08:00:00Z'] });
    expect(bad.status).toBe(409);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM appointments WHERE calendar_id = ? AND status = 'confirmed'`, cal.id).n).toBe(before);
    expect(t.app.db.get<any>(`SELECT status FROM appointments WHERE calendar_id = ? AND start_at = '2026-11-11T08:00:00.000Z'`, cal.id)?.status ?? 'cancelled').toBe('cancelled');
    expect((await t.api.put(`/api/team-calendars/${cal.id}`, { config: { payment: { mode: 'full', amount_cents: 5000 } } })).status).toBe(400);
  });
});
