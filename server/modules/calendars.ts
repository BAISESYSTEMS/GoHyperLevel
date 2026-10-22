import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, html, notFound, num, str, text } from '../core/http.js';
import { jsonForScript, messagePage, noscriptNotice, publicPage } from '../core/page.js';
import { escapeHtml, render } from '../core/template.js';
import { addDaysYmd, formatInTz, isValidTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { id, now, slugify, token } from '../core/util.js';
import { addTags, contactVars, getContact, logActivity, upsertContact } from '../services/contacts.js';
import { notifyTeam, sendToContact } from '../services/messaging.js';
import { createOpportunity } from '../services/opportunities.js';
import { limitBlocks, normalizeBookingSettings, todayOf, windowsFor } from '../services/booking-rules.js';

export type Availability = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', [string, string][]>>;

export interface CalendarRow {
  id: string;
  location_id: string;
  name: string;
  slug: string;
  description: string;
  duration: number;
  interval: number;
  buffer: number;
  min_notice: number;
  max_days: number;
  availability: Availability;
  timezone: string;
  color: string;
  active: number;
  settings: Record<string, any>;
}

const DEFAULT_AVAILABILITY: Availability = {
  mon: [['09:00', '17:00']],
  tue: [['09:00', '17:00']],
  wed: [['09:00', '17:00']],
  thu: [['09:00', '17:00']],
  fri: [['09:00', '15:00']],
};

export const DEFAULT_SETTINGS = {
  confirmation_email: true,
  confirmation_subject: 'Termin bestätigt: {{calendar.name}}',
  confirmation_body:
    'Hallo {{contact.first_name|du}},\n\ndein Termin „{{calendar.name}}“ am {{appointment.start_text}} ist bestätigt.\n{{calendar.meeting_location}}\n\nTermin verwalten oder absagen: {{appointment.manage_url}}\n\nBis bald!\n{{location.name}}',
  reminder_hours: 24,
  reminder_subject: 'Erinnerung: {{calendar.name}} am {{appointment.start_text}}',
  reminder_body: 'Hallo {{contact.first_name|du}},\n\nkurze Erinnerung an deinen Termin am {{appointment.start_text}}.\n{{calendar.meeting_location}}\n\nAbsagen oder verschieben: {{appointment.manage_url}}',
  notify_team: true,
  meeting_location: '',
  tags: [] as string[],
  pipeline_id: '',
  stage_id: '',
  redirect_url: '',
  ask_phone: true,
  ask_notes: true,
};

/** Free start times on a day (YYYY-MM-DD in the calendar's zone), as ISO instants. Pure, for tests. */
export function computeSlots(
  cal: Pick<CalendarRow, 'duration' | 'interval' | 'buffer' | 'min_notice' | 'max_days' | 'availability' | 'timezone'> & { settings?: Record<string, any> },
  ymd: string,
  busy: { start_at: string; end_at: string }[],
  at: Date = new Date(),
): string[] {
  const today = ymdInTz(at, cal.timezone);
  if (ymd < today || ymd > addDaysYmd(today, cal.max_days)) return [];
  // Date-specific hours (holidays, extra hours) replace the weekly hours of that day.
  const windows = windowsFor(cal, ymd);
  const earliest = at.getTime() + cal.min_notice * 3600_000;
  const dur = cal.duration * 60_000;
  const step = (cal.interval || cal.duration) * 60_000;
  const buf = cal.buffer * 60_000;
  const taken = busy.map((b) => [new Date(b.start_at).getTime() - buf, new Date(b.end_at).getTime() + buf]);
  const out: string[] = [];
  for (const [from, to] of windows) {
    const end = zonedToUtc(ymd, to, cal.timezone).getTime();
    for (let t = zonedToUtc(ymd, from, cal.timezone).getTime(); t + dur <= end; t += step) {
      if (t < earliest) continue;
      if (taken.some(([s, e]) => t < e && t + dur > s)) continue;
      out.push(new Date(t).toISOString());
    }
  }
  return out;
}

function cleanAvailability(input: any): Availability {
  const out: Availability = {};
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const) {
    const list = Array.isArray(input?.[day]) ? input[day] : [];
    const ok = list.filter((w: any) => Array.isArray(w) && /^\d\d:\d\d$/.test(w[0]) && /^\d\d:\d\d$/.test(w[1]) && w[0] < w[1]);
    if (ok.length) out[day] = ok.map((w: any) => [w[0], w[1]]);
  }
  return out;
}

export function getCalendarBySlug(app: App, slug: string): CalendarRow | undefined {
  return parseJson(app.db.get<CalendarRow>('SELECT * FROM calendars WHERE slug = ? AND active = 1', slug), ['availability', 'settings']);
}

/** Taken times around a day: the calendar's appointments (and shared ones) plus outside calendars. */
export function busyFor(app: App, cal: CalendarRow, ymd: string, except?: string) {
  // A day window wide enough for any zone, with a margin for buffers.
  const from = new Date(zonedToUtc(ymd, '00:00', cal.timezone).getTime() - 864e5).toISOString();
  const to = new Date(zonedToUtc(ymd, '23:59', cal.timezone).getTime() + 864e5).toISOString();
  // Busy across the whole team's calendars that share the same owner? GHL "round robin" aside, we block per calendar
  // and also for calendars that opted into shared availability (settings.shared_group).
  const group = cal.settings.shared_group;
  const own = app.db.all(
    `SELECT start_at, end_at FROM appointments
     WHERE status NOT IN ('cancelled') AND end_at > ? AND start_at < ?
     AND (calendar_id = ? ${group ? `OR calendar_id IN (SELECT id FROM calendars WHERE location_id = ? AND json_extract(settings, '$.shared_group') = ?)` : ''})`,
    from,
    to,
    cal.id,
    ...(group ? [cal.location_id, group] : []),
  ) as { start_at: string; end_at: string }[];
  // Busy times from connected outside calendars (Google, Outlook via iCal), if that module is on.
  const external: { start_at: string; end_at: string }[] = app.services.externalBusy?.(cal, from, to) ?? [];
  // A reached limit per day or week takes the whole day off the offer (`except` = an appointment that is being moved).
  return [...own, ...external, ...limitBlocks(app, cal, ymd, except)];
}

export function apptVars(app: App, appt: any, cal: CalendarRow) {
  const loc = app.location(cal.location_id)!;
  return {
    appointment: {
      ...appt,
      start_text: formatInTz(appt.start_at, cal.timezone) + ` (${cal.timezone})`,
      manage_url: `${app.baseUrl()}/book/manage/${appt.manage_token}`,
      // Team calendars (modules/teamcal*.ts): who hosts, and the video link made for this appointment.
      ...(app.services.teamcalVars?.(appt) ?? {}),
    },
    calendar: { ...cal, meeting_location: appt.meeting_url ? `Ort/Link: ${appt.meeting_url}` : cal.settings.meeting_location ? `Ort/Link: ${cal.settings.meeting_location}` : '' },
    location: loc,
  };
}

export interface BookInput {
  start: string;
  contact: Record<string, any>;
  notes?: string;
  source?: string;
  /** The booker typed the contact details (booking page, AI phone agent): they never change a stored e-mail or phone (services/contacts.ts). */
  publicInput?: boolean;
  skipCheck?: boolean;
  meta?: Record<string, string>;
  /** Columns of team calendars (assignee_id, host_ids, answers, payment …): part of the row, so they reach the events and templates. */
  extra?: Record<string, any>;
  /** Set only by the team calendars' own booking flow (payment done, questions answered, host chosen). */
  teamcal?: { checked?: boolean; paid?: boolean; hostId?: string; answers?: boolean };
}

/** Writes the appointment (slot check, contact, tags, opportunity); `finish()` sends the confirmation and fires appointment.booked. */
export function beginBooking(app: App, cal: CalendarRow, input: BookInput) {
  const start = new Date(input.start);
  if (Number.isNaN(start.getTime())) throw bad('Ungültige Startzeit');
  const ymd = ymdInTz(start, cal.timezone);
  // --- team calendars (modules/teamcal*.ts): hosts, capacity, payment and question rules; they check the slot themselves
  const prep = app.services.teamcalPrepare?.(cal, input, start) as { extra: Record<string, any>; checked: boolean } | undefined;
  if (!prep?.checked && !input.skipCheck && !computeSlots(cal, ymd, busyFor(app, cal, ymd)).includes(start.toISOString())) {
    throw new HttpError(409, 'Dieser Termin ist leider nicht mehr frei');
  }
  const { contact } = upsertContact(app, cal.location_id, input.contact, { source: `Kalender: ${cal.name}`, publicInput: input.publicInput });
  const appt = {
    id: id(),
    location_id: cal.location_id,
    calendar_id: cal.id,
    contact_id: contact.id,
    title: `${cal.name} – ${[contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email}`,
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + cal.duration * 60_000).toISOString(),
    status: 'confirmed',
    notes: str(input.notes, 'Notizen', { max: 5000 }),
    source: input.source ?? 'Buchungsseite',
    manage_token: token(18),
    reminder_sent: 0,
    created_at: now(),
    ...(prep?.extra ?? {}),
    ...(input.extra ?? {}),
  };
  app.db.insert('appointments', appt);
  logActivity(app, cal.location_id, contact.id, 'appointment.booked', `Termin gebucht: ${formatInTz(appt.start_at, cal.timezone)}`);
  if (cal.settings.tags?.length) addTags(app, cal.location_id, contact.id, cal.settings.tags);
  if (cal.settings.pipeline_id) {
    try {
      createOpportunity(app, cal.location_id, { pipeline_id: cal.settings.pipeline_id, stage_id: cal.settings.stage_id, contact_id: contact.id, source: `Kalender: ${cal.name}` });
    } catch (e) {
      console.warn('[calendars] opportunity:', (e as Error).message);
    }
  }
  const finish = () => {
    // Read again: a team calendar may have added the video link since the row was written.
    const row = app.db.get('SELECT * FROM appointments WHERE id = ?', appt.id) ?? appt;
    const vars = { contact: contactVars(getContact(app, cal.location_id, contact.id)), ...apptVars(app, row, cal) };
    if (cal.settings.confirmation_email) {
      void sendToContact(app, cal.location_id, {
        contactId: contact.id,
        channel: 'email',
        subject: render(cal.settings.confirmation_subject, vars),
        body: render(cal.settings.confirmation_body, vars),
        source: 'Terminbestätigung',
        ignoreDnd: true,
      });
    }
    if (cal.settings.notify_team) {
      void notifyTeam(app, cal.location_id, `Neuer Termin: ${appt.title}`, `${appt.title}\n${vars.appointment.start_text}\nE-Mail: ${contact.email}\nTelefon: ${contact.phone}\nNotizen: ${appt.notes}`);
    }
    // meta: attribution passed through from the booking page (e.g. the A/B test visitor `ab`).
    app.events.emit(cal.location_id, 'appointment.booked', { contactId: contact.id, appointment: { ...row, ...(app.services.teamcalPayload?.(row) ?? {}) }, calendarId: cal.id, meta: input.meta ?? {} });
    return row;
  };
  return { appt, finish };
}

export function bookAppointment(app: App, cal: CalendarRow, input: BookInput) {
  const b = beginBooking(app, cal, input);
  b.finish();
  return b.appt;
}

function icsFor(appt: any, cal: CalendarRow, locName: string) {
  const fmt = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HyperLevel//DE',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // The UID suffix is the project's first name; kept stable so calendars that imported it don't duplicate events.
    `UID:${appt.id}@private-ghl`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(appt.start_at)}`,
    `DTEND:${fmt(appt.end_at)}`,
    `SUMMARY:${esc(`${cal.name} (${locName})`)}`,
    appt.meeting_url || cal.settings.meeting_location ? `LOCATION:${esc(appt.meeting_url || cal.settings.meeting_location)}` : '',
    `STATUS:${appt.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function bookingPage(app: App, cal: CalendarRow, embed: boolean) {
  const loc = app.location(cal.location_id)!;
  const s = cal.settings;
  const body = `
<div class="wrap">
  <div class="card">
    <p class="muted" style="margin:0 0 4px">${escapeHtml(loc.name)}</p>
    <h1>${escapeHtml(cal.name)}</h1>
    <p class="muted">⏱ ${cal.duration} Minuten${s.meeting_location ? ` · 📍 ${escapeHtml(s.meeting_location)}` : ''}</p>
    ${cal.description ? `<p>${escapeHtml(cal.description).replace(/\n/g, '<br>')}</p>` : ''}
    ${noscriptNotice('einen Termin zu buchen')}
    <div id="step1">
      <div class="days" id="days"></div>
      <div class="slots" id="slots" aria-live="polite"><p class="muted">Lade freie Termine…</p></div>
      <div class="row" style="margin-top:12px"><button class="btn secondary" id="prev" type="button">← Früher</button><button class="btn secondary" id="next" type="button">Später →</button></div>
      <p class="muted" style="font-size:13px">Zeiten in deiner Zeitzone: <span id="tz"></span></p>
    </div>
    <form id="step2" hidden>
      <p><strong id="chosen"></strong> <a href="#" id="back">ändern</a></p>
      <div class="row"><div><label for="bk-first">Vorname *</label><input id="bk-first" name="first_name" required autocomplete="given-name"></div><div><label for="bk-last">Nachname</label><input id="bk-last" name="last_name" autocomplete="family-name"></div></div>
      <label for="bk-email">E-Mail *</label><input id="bk-email" name="email" type="email" required autocomplete="email">
      ${s.ask_phone ? '<label for="bk-phone">Telefon</label><input id="bk-phone" name="phone" type="tel" autocomplete="tel">' : ''}
      ${s.ask_notes ? '<label for="bk-notes">Worum geht es?</label><textarea id="bk-notes" name="notes"></textarea>' : ''}
      <label class="check"><input type="checkbox" required> Ich bin einverstanden, dass meine Angaben zur Terminvereinbarung gespeichert werden.</label>
      <div style="margin-top:16px"><button type="submit">Termin buchen</button></div>
      <div class="error" id="err" role="alert"></div>
    </form>
    <div id="done" hidden class="ok" role="status"></div>
  </div>
</div>
<style>
.days { display:flex; gap:8px; overflow-x:auto; padding:8px 0; }
.day { flex:0 0 auto; border:1px solid var(--line); border-radius:10px; padding:8px 12px; background:#fff; color:var(--text); cursor:pointer; text-align:center; font-weight:500; }
.day.on { border-color:var(--brand); background:var(--brand); color:#fff; } .day.none { opacity:.7; border-style:dashed; }
.slots { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:8px; margin-top:12px; }
.slot { background:#fff; color:var(--brand); border:1px solid var(--brand); padding:10px; border-radius:9px; font-weight:600; }
.slot:hover { background:var(--brand); color:#fff; }
</style>
<script>
const CFG = ${jsonForScript({ slug: cal.slug, redirect: s.redirect_url || '' })};
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; document.getElementById('tz').textContent = tz;
// Days are YYYY-MM-DD and moved in UTC: local setDate() on a UTC midnight lands on the day before across a DST change in Europe.
const shiftDay = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const localToday = () => { const n = new Date(); return new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
let from = localToday(), days = [], sel = null, chosen = null;
const $ = (id) => document.getElementById(id);
async function load() {
  $('slots').innerHTML = '<p class="muted">Lade freie Termine…</p>';
  const r = await fetch('/api/public/calendars/' + CFG.slug + '/slots?from=' + from + '&days=7');
  const j = await r.json(); days = j.days || [];
  sel = days.find(d => d.slots.length) || days[0]; draw();
}
function draw() {
  $('days').innerHTML = '';
  for (const d of days) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'day' + (d === sel ? ' on' : '') + (d.slots.length ? '' : ' none');
    const dt = new Date(d.date + 'T12:00:00');
    b.innerHTML = dt.toLocaleDateString('de-DE', { weekday: 'short' }) + '<br>' + dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    b.setAttribute('aria-pressed', String(d === sel));
    b.setAttribute('aria-label', dt.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) + (d.slots.length ? '' : ' – keine freien Zeiten'));
    b.onclick = () => { sel = d; draw(); }; $('days').appendChild(b);
  }
  $('slots').innerHTML = sel && sel.slots.length ? '' : '<p class="muted">Keine freien Zeiten an diesem Tag.</p>';
  for (const s of (sel ? sel.slots : [])) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'slot';
    b.textContent = new Date(s).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    b.onclick = () => { chosen = s; $('chosen').textContent = new Date(s).toLocaleString('de-DE', { weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit' }) + ' Uhr'; $('step1').hidden = true; $('step2').hidden = false; };
    $('slots').appendChild(b);
  }
}
$('prev').onclick = () => { const p = shiftDay(from, -7), t = localToday(); from = p < t ? t : p; load(); };
$('next').onclick = () => { from = shiftDay(from, 7); load(); };
$('back').onclick = (e) => { e.preventDefault(); $('step2').hidden = true; $('step1').hidden = false; };
$('step2').onsubmit = async (e) => {
  e.preventDefault(); const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; $('err').textContent = '';
  const data = Object.fromEntries(new FormData(e.target)); data.start = chosen; data.timezone = tz;
  const ab = new URLSearchParams(location.search).get('ab'); if (ab) data._ab = ab;
  const q = new URLSearchParams(location.search); q.forEach((v, k) => { if (/^(utm_[a-z]+|gclid|fbclid|ref)$/.test(k)) data['_' + k] = v; }); if (q.get('_a')) data._attr = q.get('_a');
  data._page = (window.top === window ? location.href : document.referrer) || '';
  const r = await fetch('/api/public/calendars/' + CFG.slug + '/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const j = await r.json(); btn.disabled = false;
  if (!r.ok) { $('err').textContent = j.error || 'Fehler'; if (r.status === 409) { $('step2').hidden = true; $('step1').hidden = false; load(); } return; }
  if (CFG.redirect) { location.href = CFG.redirect; return; }
  $('step2').hidden = true; $('done').hidden = false;
  $('done').innerHTML = '<strong>Termin gebucht! ✅</strong><br>' + $('chosen').textContent + '<br>Eine Bestätigung kommt per E-Mail. <a href="' + j.icsUrl + '">In Kalender eintragen</a>';
};
load();
</script>`;
  return publicPage({ title: `${cal.name} – ${loc.name}`, body, color: cal.color, embed });
}

export const calendarsModule: Module = {
  name: 'calendars',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE calendars (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 30, interval INTEGER NOT NULL DEFAULT 30, buffer INTEGER NOT NULL DEFAULT 0,
        min_notice INTEGER NOT NULL DEFAULT 4, max_days INTEGER NOT NULL DEFAULT 60,
        availability TEXT NOT NULL DEFAULT '{}', timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
        color TEXT NOT NULL DEFAULT '#2563eb', active INTEGER NOT NULL DEFAULT 1,
        settings TEXT NOT NULL DEFAULT '{}', external_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed', notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
        manage_token TEXT NOT NULL UNIQUE, reminder_sent INTEGER NOT NULL DEFAULT 0, external_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX appointments_time ON appointments(calendar_id, start_at);
      `,
    ],
    // Which reminder / follow-up / no-show message went out for which start time ({id: start_at}, services/booking-messages.ts).
    ['002-reminders-sent', `ALTER TABLE appointments ADD COLUMN reminders_sent TEXT NOT NULL DEFAULT '{}';`],
  ],
  register(app) {
    const { db, router } = app;
    const getCal = (locationId: string, cid: string) =>
      parseJson(db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ? AND location_id = ?', cid, locationId), ['availability', 'settings']);

    const uniqueSlug = (base: string, except?: string) => {
      let slug = slugify(base);
      for (let i = 2; db.get('SELECT id FROM calendars WHERE slug = ? AND id != ?', slug, except ?? ''); i++) slug = `${slugify(base)}-${i}`;
      return slug;
    };

    router.get('/api/calendars', 'location', (ctx) =>
      parseRows(db.all('SELECT * FROM calendars WHERE location_id = ? ORDER BY name', ctx.locationId), ['availability', 'settings']).map((c) => ({ ...c, url: `${app.baseUrl()}/book/${c.slug}` })),
    );
    router.post('/api/calendars', 'location', (ctx) => {
      const b = ctx.body;
      const name = str(b.name, 'Name', { required: true, max: 120 });
      const tz = b.timezone || app.location(ctx.locationId)!.timezone;
      if (!isValidTz(tz)) throw bad('Unbekannte Zeitzone');
      const row = {
        id: id(),
        location_id: ctx.locationId,
        name,
        slug: uniqueSlug(b.slug || name),
        description: str(b.description, 'Beschreibung', { max: 5000 }),
        duration: Math.max(5, num(b.duration, 30)),
        interval: Math.max(5, num(b.interval, num(b.duration, 30))),
        buffer: Math.max(0, num(b.buffer, 0)),
        min_notice: Math.max(0, num(b.min_notice, 4)),
        max_days: Math.max(1, num(b.max_days, 60)),
        availability: b.availability ? cleanAvailability(b.availability) : DEFAULT_AVAILABILITY,
        timezone: tz,
        color: /^#[0-9a-f]{6}$/i.test(b.color ?? '') ? b.color : '#2563eb',
        active: 1,
        settings: normalizeBookingSettings({ ...DEFAULT_SETTINGS, ...(b.settings ?? {}) }, {}, todayOf({ timezone: tz })),
        created_at: now(),
      };
      db.insert('calendars', row);
      return { ...row, url: `${app.baseUrl()}/book/${row.slug}` };
    });
    router.patch('/api/calendars/:id', 'location', (ctx) => {
      const cal = getCal(ctx.locationId, ctx.params.id);
      if (!cal) throw notFound();
      const b = ctx.body;
      const patch: Record<string, any> = {};
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true });
      if (b.slug !== undefined) patch.slug = uniqueSlug(b.slug, cal.id);
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 5000 });
      for (const k of ['duration', 'interval', 'buffer', 'min_notice', 'max_days'] as const) if (b[k] !== undefined) patch[k] = Math.max(k === 'buffer' || k === 'min_notice' ? 0 : 1, num(b[k]));
      if (b.availability !== undefined) patch.availability = cleanAvailability(b.availability);
      if (b.timezone !== undefined) {
        if (!isValidTz(b.timezone)) throw bad('Unbekannte Zeitzone');
        patch.timezone = b.timezone;
      }
      if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) patch.color = b.color;
      if (b.active !== undefined) patch.active = b.active ? 1 : 0;
      if (b.settings) patch.settings = normalizeBookingSettings({ ...cal.settings, ...b.settings }, cal.settings, todayOf({ timezone: patch.timezone ?? cal.timezone }));
      db.update('calendars', cal.id, patch);
      const out = getCal(ctx.locationId, cal.id)!;
      return { ...out, url: `${app.baseUrl()}/book/${out.slug}` };
    });
    router.delete('/api/calendars/:id', 'location', (ctx) => {
      db.run('DELETE FROM calendars WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    router.get('/api/appointments', 'location', (ctx) => {
      const from = ctx.query.get('from') || new Date(Date.now() - 7 * 864e5).toISOString();
      const to = ctx.query.get('to') || new Date(Date.now() + 60 * 864e5).toISOString();
      const where = ['a.location_id = ?', 'a.start_at < ?', 'a.end_at > ?'];
      const params: any[] = [ctx.locationId, to, from];
      if (ctx.query.get('calendar_id')) {
        where.push('a.calendar_id = ?');
        params.push(ctx.query.get('calendar_id'));
      }
      if (ctx.query.get('contact_id')) {
        where.push('a.contact_id = ?');
        params.push(ctx.query.get('contact_id'));
      }
      const rows = db.all(
        `SELECT a.*, c.first_name, c.last_name, c.email, c.phone, k.name AS calendar_name, k.color AS calendar_color
         FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id JOIN calendars k ON k.id = a.calendar_id
         WHERE ${where.join(' AND ')} ORDER BY a.start_at`,
        ...params,
      );
      // Team calendars add the host's name, the video link and the payment state (modules/teamcal.ts).
      return app.services.appointmentRows ? app.services.appointmentRows(rows) : rows;
    });
    // Times come as `start`/`end` (the app) or under the record's own names `start_at`/`end_at` (what GET returns and the
    // OpenAPI description documents) – both work, on create and on change.
    const startOf = (b: any) => b.start || b.start_at;
    const endOf = (b: any) => b.end || b.end_at;
    router.post('/api/appointments', 'location', (ctx) => {
      const cal = getCal(ctx.locationId, String(ctx.body.calendar_id ?? ''));
      if (!cal) throw bad('Kalender fehlt');
      if (ctx.body.blocked) {
        const row = {
          id: id(),
          location_id: ctx.locationId,
          calendar_id: cal.id,
          contact_id: null,
          title: str(ctx.body.title, 'Titel') || 'Blockiert',
          start_at: new Date(startOf(ctx.body)).toISOString(),
          end_at: new Date(endOf(ctx.body)).toISOString(),
          status: 'blocked',
          notes: '',
          source: 'manuell',
          manage_token: token(18),
          created_at: now(),
        };
        db.insert('appointments', row);
        return row;
      }
      const contact = ctx.body.contact_id ? getContact(app, ctx.locationId, ctx.body.contact_id) : ctx.body.contact;
      if (!contact) throw bad('Kontakt fehlt');
      return bookAppointment(app, cal, { start: startOf(ctx.body), contact: ctx.body.contact_id ? { id: ctx.body.contact_id } : contact, notes: ctx.body.notes, source: 'manuell', skipCheck: !!ctx.body.force });
    });
    router.patch('/api/appointments/:id', 'location', (ctx) => {
      const a = db.get('SELECT * FROM appointments WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!a) throw notFound();
      const patch: Record<string, any> = {};
      if (ctx.body.status !== undefined) {
        if (!['confirmed', 'cancelled', 'showed', 'noshow', 'blocked'].includes(ctx.body.status)) throw bad('Unbekannter Status');
        patch.status = ctx.body.status;
      }
      const startIn = startOf(ctx.body);
      const endIn = endOf(ctx.body);
      if (startIn || endIn) {
        // A new start keeps the length unless an end comes along; an end alone changes only the end.
        const start = new Date(startIn || a.start_at);
        const end = endIn ? new Date(endIn) : new Date(start.getTime() + (new Date(a.end_at).getTime() - new Date(a.start_at).getTime()));
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw bad('Ungültige Zeit');
        if (end <= start) throw bad('Das Ende muss nach dem Beginn liegen');
        patch.start_at = start.toISOString();
        patch.end_at = end.toISOString();
        if (startIn) patch.reminder_sent = 0;
      }
      if (ctx.body.notes !== undefined) patch.notes = str(ctx.body.notes, 'Notizen', { max: 5000 });
      if (ctx.body.title !== undefined) patch.title = str(ctx.body.title, 'Titel', { max: 300 });
      db.update('appointments', a.id, patch);
      const next = db.get('SELECT * FROM appointments WHERE id = ?', a.id)!;
      if (patch.status && patch.status !== a.status) {
        if (a.contact_id) logActivity(app, ctx.locationId, a.contact_id, 'appointment.status_changed', `Termin: ${patch.status}`);
        app.events.emit(ctx.locationId, 'appointment.status_changed', { contactId: a.contact_id, appointment: next, status: patch.status, calendarId: a.calendar_id });
      }
      if (patch.start_at && patch.start_at !== a.start_at && a.contact_id) {
        if (a.contact_id) logActivity(app, ctx.locationId, a.contact_id, 'appointment.rescheduled', 'Termin verschoben');
        app.events.emit(ctx.locationId, 'appointment.rescheduled', { contactId: a.contact_id, appointment: next, previousStart: a.start_at, calendarId: a.calendar_id });
      }
      return next;
    });
    router.delete('/api/appointments/:id', 'location', (ctx) => {
      db.run('DELETE FROM appointments WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- public booking -----------------------------------------------------
    router.get('/book/:slug', 'public', (ctx) => {
      const cal = getCalendarBySlug(app, ctx.params.slug);
      if (!cal) return html(messagePage('Nicht gefunden', 'Diesen Kalender gibt es nicht (mehr).'), 404);
      // Team calendars (questions, payment, several hosts …) render their own server-side page.
      const team = app.services.teamcalPage?.(cal, ctx.query.get('embed') === '1', ctx) as string | undefined;
      return html(team ?? bookingPage(app, cal, ctx.query.get('embed') === '1'));
    });
    router.get('/api/public/calendars/:slug/slots', 'public', (ctx) => {
      const cal = getCalendarBySlug(app, ctx.params.slug);
      if (!cal) throw notFound();
      const today = ymdInTz(new Date(), cal.timezone);
      let from = /^\d{4}-\d\d-\d\d$/.test(ctx.query.get('from') ?? '') ? ctx.query.get('from')! : today;
      if (from < today) from = today;
      const days = Math.min(Math.max(num(ctx.query.get('days'), 7), 1), 31);
      const out = [];
      for (let i = 0; i < days; i++) {
        const d = addDaysYmd(from, i);
        // Team calendars know their members' times (round robin: any member free, collective: all, group: seats left).
        out.push({ date: d, slots: (app.services.teamcalSlots?.(cal, d) as string[] | undefined) ?? computeSlots(cal, d, busyFor(app, cal, d)) });
      }
      return { timezone: cal.timezone, duration: cal.duration, days: out };
    });
    router.post('/api/public/calendars/:slug/book', 'public', (ctx) => {
      const cal = getCalendarBySlug(app, ctx.params.slug);
      if (!cal) throw notFound();
      const b = ctx.body;
      if (!b.email) throw bad('E-Mail fehlt');
      const appt = bookAppointment(app, cal, {
        start: b.start,
        // `name` (one field, as the OpenAPI description offers it) is split like on every contact create.
        contact: { first_name: b.first_name, last_name: b.last_name, name: b.name, email: b.email, phone: b.phone },
        publicInput: true,
        notes: b.notes,
        meta: typeof b._ab === 'string' && /^[A-Za-z0-9]{8,40}$/.test(b._ab) ? { ab: b._ab } : undefined,
      });
      app.services.attribution?.capture(ctx, cal.location_id, appt.contact_id, 'booking', { attr: b._attr, page: b._page, params: b });
      return { id: appt.id, start_at: appt.start_at, manageUrl: `${app.baseUrl()}/book/manage/${appt.manage_token}`, icsUrl: `/book/ics/${appt.manage_token}` };
    });
    router.get('/book/ics/:token', 'public', (ctx) => {
      const a = db.get('SELECT * FROM appointments WHERE manage_token = ?', ctx.params.token);
      if (!a) throw notFound();
      const cal = parseJson(db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ?', a.calendar_id)!, ['availability', 'settings']);
      const r = text(icsFor(a, cal, app.location(a.location_id)!.name), 'text/calendar; charset=utf-8');
      r.headers['content-disposition'] = 'attachment; filename="termin.ics"';
      return r;
    });
    router.get('/book/manage/:token', 'public', (ctx) => {
      const a = db.get('SELECT * FROM appointments WHERE manage_token = ?', ctx.params.token);
      if (!a) return html(messagePage('Nicht gefunden', 'Diesen Termin gibt es nicht.'), 404);
      const cal = parseJson(db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ?', a.calendar_id)!, ['availability', 'settings']);
      // Cancel and reschedule with the calendar's rules (modules/teamcal-public.ts).
      const manage = app.services.teamcalManagePage?.(a, cal, ctx) as string | undefined;
      if (manage) return html(manage);
      const cancelled = a.status === 'cancelled';
      const body = `<div class="wrap"><div class="card">
        <h1>${escapeHtml(cal.name)}</h1>
        <p>${escapeHtml(formatInTz(a.start_at, cal.timezone))} (${escapeHtml(cal.timezone)})</p>
        <p>Status: <strong>${cancelled ? 'abgesagt' : 'bestätigt'}</strong></p>
        ${cancelled ? `<a class="btn" href="/book/${escapeHtml(cal.slug)}">Neuen Termin buchen</a>` : `${noscriptNotice('den Termin abzusagen')}<div class="row"><a class="btn secondary" href="/book/ics/${escapeHtml(a.manage_token)}">In Kalender eintragen</a><button id="cancel" class="btn">Termin absagen</button></div>`}
        <p id="msg" class="muted"></p></div></div>
        <script>const b=document.getElementById('cancel'); if (b) b.onclick=async()=>{ if(!confirm('Termin wirklich absagen?'))return; const r=await fetch('/api/public/appointments/${escapeHtml(a.manage_token)}/cancel',{method:'POST'}); if(r.ok) location.reload(); else document.getElementById('msg').textContent='Absagen ging nicht.'; };</script>`;
      return html(publicPage({ title: 'Termin verwalten', body, color: cal.color }));
    });
    router.post('/api/public/appointments/:token/cancel', 'public', (ctx) => {
      const a = db.get('SELECT * FROM appointments WHERE manage_token = ?', ctx.params.token);
      if (!a) throw notFound();
      // Cancel rules, refund and notices of the team calendars (they also take the plain cancel link).
      const handled = app.services.teamcalCancel?.(a, ctx);
      if (handled) return handled;
      if (a.status !== 'cancelled') {
        db.run(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`, a.id);
        if (a.contact_id) logActivity(app, a.location_id, a.contact_id, 'appointment.status_changed', 'Termin vom Kontakt abgesagt');
        app.events.emit(a.location_id, 'appointment.status_changed', { contactId: a.contact_id, appointment: { ...a, status: 'cancelled' }, status: 'cancelled', calendarId: a.calendar_id });
        void notifyTeam(app, a.location_id, `Termin abgesagt: ${a.title}`, `${a.title} wurde vom Kontakt abgesagt.`);
      }
      return { ok: true };
    });

    // --- reminders ------------------------------------------------------------
    app.onTick(async () => {
      const due = db.all(
        `SELECT a.* FROM appointments a JOIN calendars k ON k.id = a.calendar_id
         WHERE a.status = 'confirmed' AND a.reminder_sent = 0 AND a.contact_id IS NOT NULL AND a.start_at > ?
         AND COALESCE(json_extract(k.settings, '$.reminder_hours'), 0) > 0
         AND json_extract(k.settings, '$.reminders') IS NULL
         AND a.start_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || json_extract(k.settings, '$.reminder_hours') || ' hours')
         AND a.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')`,
        new Date().toISOString(),
      );
      for (const row of due) {
        // Claimed as it is now: sending the reminders before it took a while – an appointment cancelled or moved meanwhile gets none.
        if (!db.run(`UPDATE appointments SET reminder_sent = 1 WHERE id = ? AND status = 'confirmed' AND reminder_sent = 0 AND start_at = ?`, row.id, row.start_at).changes) continue;
        const a = db.get<any>('SELECT * FROM appointments WHERE id = ?', row.id)!;
        const cal = parseJson(db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ?', a.calendar_id)!, ['availability', 'settings']);
        const vars = { contact: contactVars(getContact(app, a.location_id, a.contact_id)), ...apptVars(app, a, cal) };
        await sendToContact(app, a.location_id, {
          contactId: a.contact_id,
          channel: 'email',
          subject: render(cal.settings.reminder_subject || DEFAULT_SETTINGS.reminder_subject, vars),
          body: render(cal.settings.reminder_body || DEFAULT_SETTINGS.reminder_body, vars),
          source: 'Terminerinnerung',
          ignoreDnd: true,
        });
      }
    });
  },
};
