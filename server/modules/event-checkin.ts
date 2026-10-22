import type { App, Module } from '../core/app.js';
import { HttpError, bad, html, notFound, str } from '../core/http.js';
import { jsonForScript, messagePage, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { callRoute } from '../services/route-call.js';
import type { Tool } from './mcp.js';
import { renderQr } from './qr.js';

/**
 * Tickets with QR code and check-in for appointments, classes and events (HighLevel "Events/Tickets" parity – the check-in part,
 * docs/booking.md#tickets-and-check-in): every booked appointment has a ticket page `/book/ticket/<manage token>` with a QR code;
 * at the door the team scans it with the phone (the QR opens the ticket page, which checks in when the team is signed in in that
 * browser) or types the code (agent/API), and the appointment
 * is marked "erschienen" through the normal appointment route (events, workflows, reports as usual). A second scan says when it was
 * checked in. Ticket types, quotas and wallet passes are not part of this.
 */

const codeOf = (token: string) => token.slice(0, 10).toUpperCase();

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };

export const CHECKIN_TOOLS: Tool[] = [
  {
    name: 'ghl_appointment_checkin',
    title: 'Teilnehmer einchecken',
    description: 'Checkt einen Termin bzw. Klassen-/Event-Platz per Ticket-Code (vom QR-Code oder dem Ticket des Teilnehmers) ein: Status „erschienen“. Ein zweiter Check-in meldet, wann schon eingecheckt wurde.',
    inputSchema: { type: 'object', properties: { ...LOC, code: { type: 'string', description: 'Ticket-Code (10 Zeichen) oder Ticket-Link' } }, required: ['location_id', 'code'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => call.api('POST', '/api/appointment-checkin', { location: a.location_id, body: { code: a.code } }),
  },
];

export const eventCheckinModule: Module = {
  name: 'event-checkin',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE appointment_checkins (
        appointment_id TEXT PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, checked_in_at TEXT NOT NULL, by_user TEXT
      );
      CREATE INDEX appointment_checkins_loc ON appointment_checkins(location_id, checked_in_at);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...CHECKIN_TOOLS];

    const apptByToken = (tok: string) =>
      db.get<any>(
        `SELECT a.*, c.name AS calendar_name, c.timezone, k.first_name, k.last_name, k.email, ci.checked_in_at
         FROM appointments a JOIN calendars c ON c.id = a.calendar_id LEFT JOIN contacts k ON k.id = a.contact_id LEFT JOIN appointment_checkins ci ON ci.appointment_id = a.id
         WHERE a.manage_token = ?`,
        tok,
      );

    router.get('/book/ticket/:token', 'public', async (ctx) => {
      const a = apptByToken(ctx.params.token);
      if (!a || a.status === 'blocked') return html(messagePage('Nicht gefunden', 'Dieses Ticket gibt es nicht.'), 404);
      const loc = app.location(a.location_id)!;
      const svg = String(await renderQr(`${app.baseUrl()}/book/ticket/${encodeURIComponent(a.manage_token)}`, { format: 'svg', size: 260, margin: 2, ec: 'M', fg: '#111827', bg: '#ffffff' }));
      const who = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '';
      const state = a.status === 'cancelled' ? '<p class="error">Dieser Termin wurde abgesagt.</p>' : a.checked_in_at ? `<p class="muted">Eingecheckt am ${escapeHtml(formatInTz(a.checked_in_at, a.timezone || loc.timezone))} Uhr</p>` : '';
      const body = `<div class="wrap" style="max-width:420px"><div class="card" style="text-align:center">
  <p class="muted" style="margin:0">${escapeHtml(loc.name)}</p>
  <h1 style="margin:6px 0 4px">${escapeHtml(a.calendar_name)}</h1>
  <p style="margin:0 0 12px"><strong>${escapeHtml(formatInTz(a.start_at, a.timezone || loc.timezone))} Uhr</strong></p>
  ${who ? `<p style="margin:0 0 12px">${escapeHtml(who)}</p>` : ''}
  <div style="display:inline-block;background:#fff;padding:8px;border-radius:12px" role="img" aria-label="QR-Code des Tickets">${svg}</div>
  <p style="font-family:ui-monospace,monospace;font-size:20px;letter-spacing:2px;margin:10px 0 4px">${escapeHtml(codeOf(a.manage_token))}</p>
  <p class="muted" style="font-size:13px;margin:0">Zeig diesen Code beim Einlass.</p>
  ${state}
  <p style="margin-top:16px"><a href="/book/manage/${encodeURIComponent(a.manage_token)}">Termin verwalten</a></p>
  ${a.status === 'cancelled' ? '' : `<details style="margin-top:14px;text-align:left"><summary class="muted" style="cursor:pointer;font-size:13px">Für das Team: einchecken</summary><p class="muted" style="font-size:13px">Angemeldet mit dem Team-Konto (im selben Browser) checkst du hier ein.</p><button type="button" id="ci">Einchecken</button><p id="ci-msg" role="status"></p></details>
  <script>(function(){var b=document.getElementById('ci');if(!b)return;b.onclick=function(){var m=document.getElementById('ci-msg');m.textContent='';fetch('/api/appointment-checkin',{method:'POST',headers:{'content-type':'application/json','x-pghl':'1','x-location-id':${jsonForScript(a.location_id)}},body:JSON.stringify({code:${jsonForScript(a.manage_token)}})}).then(function(r){return r.json().then(function(j){if(r.status===401)throw new Error('Bitte zuerst in HyperLevel anmelden.');if(!r.ok)throw new Error(j.error||'Fehler');m.textContent=j.status==='already'?'Schon eingecheckt.':'Eingecheckt ✓ '+(j.name||'')})}).catch(function(e){m.textContent=e.message})}})();</script>`}
</div></div>`;
      return html(publicPage({ title: `Ticket: ${a.calendar_name}`, body, color: loc.settings?.branding?.color || undefined, head: '<meta name="robots" content="noindex">' }));
    });

    router.post('/api/appointment-checkin', 'location', async (ctx) => {
      let raw = str(ctx.body?.code, 'Code', { required: true, max: 300 }).trim();
      const m = raw.match(/(?:code=|\/ticket\/)([A-Za-z0-9_-]+)/);
      if (m) raw = m[1];
      const code = raw.replace(/[^A-Za-z0-9_-]/g, '');
      if (code.length < 10) throw bad('Ticket-Code: mindestens 10 Zeichen');
      const rows = db.all<any>(`SELECT id, manage_token, status FROM appointments WHERE location_id = ? AND upper(substr(manage_token, 1, 10)) = ? LIMIT 2`, ctx.locationId, code.slice(0, 10).toUpperCase());
      const hit = rows.length === 1 ? rows[0] : rows.find((r) => r.manage_token === code);
      if (!hit) throw notFound('Kein Ticket mit diesem Code');
      const a = apptByToken(hit.manage_token);
      const who = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '';
      const out = { appointment_id: a.id, name: who, calendar: a.calendar_name, start_at: a.start_at };
      if (a.status === 'cancelled') throw new HttpError(409, `Abgesagt: ${who || 'dieser Termin'} – ${a.calendar_name}`);
      if (a.checked_in_at) return { ...out, status: 'already', checked_in_at: a.checked_in_at };
      await callRoute(app, ctx, 'PATCH', `/api/appointments/${encodeURIComponent(a.id)}`, { status: 'showed' });
      const at = new Date().toISOString();
      db.run('INSERT OR IGNORE INTO appointment_checkins (appointment_id, location_id, checked_in_at, by_user) VALUES (?, ?, ?, ?)', a.id, ctx.locationId, at, ctx.user?.id ?? null);
      return { ...out, status: 'checked_in', checked_in_at: at };
    });
    router.get('/api/appointment-checkin/summary', 'location', (ctx) => {
      const cal = String(ctx.query.get('calendar_id') ?? '');
      const day = String(ctx.query.get('date') ?? new Date().toISOString().slice(0, 10));
      if (!/^\d{4}-\d\d-\d\d$/.test(day)) throw bad('Datum als JJJJ-MM-TT');
      const rows = db.all<any>(
        `SELECT a.id, a.start_at, a.status, k.first_name, k.last_name, k.email, ci.checked_in_at FROM appointments a LEFT JOIN contacts k ON k.id = a.contact_id LEFT JOIN appointment_checkins ci ON ci.appointment_id = a.id
         WHERE a.location_id = ? AND a.status != 'blocked' AND a.status != 'cancelled' AND substr(a.start_at, 1, 10) = ? ${cal ? 'AND a.calendar_id = ?' : ''} ORDER BY a.start_at LIMIT 1000`,
        ctx.locationId,
        day,
        ...(cal ? [cal] : []),
      );
      return { date: day, total: rows.length, checked_in: rows.filter((r) => r.checked_in_at).length, people: rows.map((r) => ({ appointment_id: r.id, start_at: r.start_at, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '', checked_in_at: r.checked_in_at })) };
    });
  },
};
