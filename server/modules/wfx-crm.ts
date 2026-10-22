import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { render } from '../core/template.js';
import { id as newId, now, token } from '../core/util.js';
import { addTags, getContact, logActivity, removeTags } from '../services/contacts.js';
import { deliverSms, notifyTeam, sendToContact } from '../services/messaging.js';
import { AUTO_LOST_REASON, createOpportunity, updateOpportunity } from '../services/opportunities.js';
import { joinGroup } from '../services/community-actions.js';
import { contactVars } from '../services/contacts.js';
import { addToDate, fromWall, parseDate, parseNumber, wallClock } from '../services/formatters.js';
import { evalConditions, type ActionOutcome } from '../services/workflow-engine.js';
import { preview, requireText, rowsOf, text, tzOf, type ActionDef, type FieldDef } from '../services/wfx-kit.js';
import { bookAppointment, type CalendarRow } from './calendars.js';
import { createInvoice, sendInvoice } from './payments.js';
import { ensureFinal } from '../services/invoice-flow.js';

/**
 * CRM and business steps in their own module: update deal/task/appointment, DND per channel, tags with conditions,
 * assigning users (round robin with weights), internal notifications, invoices and payment links, contracts from a
 * template, community membership, social drafts and custom events. Everything goes through the same helpers the
 * regular screens use, so activity entries and events behave the same.
 */

const CONDITIONS: FieldDef[] = [
  { key: 'conditions', label: 'Bedingungen', type: 'conditions' },
  { key: 'expression', label: 'Oder Ausdruck', type: 'code', placeholder: 'contact.custom.budget > 1000' },
];
const gate = (step: any, vars: Record<string, any>) => evalConditions({ id: step.id, type: step.type, conditions: step.conditions, match: step.match, expression: step.expression }, vars);

/** Users who work in a sub-account: members assigned to it, plus admins when nobody else is. */
export function teamOf(app: App, locationId: string): { id: string; name: string; email: string; role: string }[] {
  const all = app.db.all<any>('SELECT id, name, email, role, locations FROM users ORDER BY created_at');
  const members = all.filter((u) => u.role !== 'admin' && JSON.parse(u.locations || '[]').includes(locationId));
  return (members.length ? members : all.filter((u) => u.role === 'admin')).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
}

/** Smooth weighted round robin (the algorithm nginx uses): picks the next of `candidates` and remembers the state. */
export function nextWeighted(app: App, locationId: string, key: string, candidates: { id: string; weight: number }[]): string | null {
  const list = candidates.filter((c) => c.weight > 0);
  if (!list.length) return null;
  const db = app.db;
  const total = list.reduce((a, c) => a + c.weight, 0);
  let best: { id: string; cur: number } | null = null;
  db.tx(() => {
    for (const c of list) {
      const row = db.get<{ current: number }>('SELECT current FROM wfx_rr WHERE location_id = ? AND key = ? AND user_id = ?', locationId, key, c.id);
      const cur = (row?.current ?? 0) + c.weight;
      db.run('INSERT INTO wfx_rr (location_id, key, user_id, current) VALUES (?, ?, ?, ?) ON CONFLICT(location_id, key, user_id) DO UPDATE SET current = excluded.current', locationId, key, c.id, cur);
      if (!best || cur > best.cur) best = { id: c.id, cur };
    }
    if (best) db.run('UPDATE wfx_rr SET current = current - ? WHERE location_id = ? AND key = ? AND user_id = ?', total, locationId, key, best.id);
  });
  return (best as { id: string } | null)?.id ?? null;
}

export function crmActions(app: App): ActionDef[] {
  const db = app.db;
  const defs: ActionDef[] = [];
  const add = (d: ActionDef) => defs.push(d);
  const userMap = (loc: string) => new Map(teamOf(app, loc).map((u) => [u.id, u]));

  /** When something should happen "in X minutes/…" or "at <date>" – shared by appointment steps. */
  const whenFields = (prefix = ''): FieldDef[] => [
    { key: `${prefix}when`, label: 'Zeitpunkt', type: 'select', options: [['in', 'In … ab jetzt'], ['at', 'Zu einem Datum']], default: 'in' },
    { key: `${prefix}amount`, label: 'Menge', type: 'number', default: 1, showIf: { field: `${prefix}when`, in: ['in'] } },
    { key: `${prefix}unit`, label: 'Einheit', type: 'select', options: [['hours', 'Stunden'], ['days', 'Tage'], ['weeks', 'Wochen'], ['business_days', 'Werktage']], default: 'days', showIf: { field: `${prefix}when`, in: ['in'] } },
    { key: `${prefix}date`, label: 'Datum / Zeit', type: 'text', placeholder: '{{var.slot}}  ·  2026-12-01 14:00', showIf: { field: `${prefix}when`, in: ['at'] } },
    { key: `${prefix}time`, label: 'Uhrzeit (HH:mm)', type: 'time', default: '10:00', help: 'Wird auf den berechneten Tag gesetzt (Zeitzone des Sub-Accounts).' },
  ];
  const whenDate = (run: any, step: any, vars: Record<string, any>, prefix = ''): Date => {
    const tz = tzOf(app, run.location_id);
    let d: Date | null;
    if (step[`${prefix}when`] === 'at') {
      d = parseDate(text(step[`${prefix}date`], vars), tz);
      if (!d) throw new Error('Datum/Zeit ist ungültig');
    } else {
      d = addToDate(new Date(), Number(step[`${prefix}amount`] ?? 1) || 0, String(step[`${prefix}unit`] ?? 'days'), tz);
    }
    const time = String(step[`${prefix}time`] ?? '');
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      const w = wallClock(d, tz);
      const [h, m] = time.split(':').map(Number);
      d = fromWall({ ...w, h, mi: m, s: 0 }, tz);
    }
    return d;
  };

  // --- deal ---------------------------------------------------------------------------------------
  add({
    meta: {
      type: 'update_opportunity',
      label: 'Deal ändern',
      category: 'sales',
      icon: 'deal',
      summary: 'Ändert Name, Wert, Stufe, Status oder Besitzer des Deals eines Kontakts.',
      doc: 'Findet den neuesten offenen Deal des Kontakts (optional in einer Pipeline) oder nimmt eine Deal-ID (z. B. {{var.deal.id}} nach „Deal suchen“). Der Wert kann gesetzt, erhöht oder mit einem Faktor multipliziert werden. Stufen- und Statuswechsel lösen die üblichen Auslöser aus.',
      keywords: 'deal opportunity update ändern wert stage',
      fields: [
        { key: 'source', label: 'Welcher Deal', type: 'select', options: [['current', 'Neuester offener Deal des Kontakts'], ['id', 'Deal-ID']], default: 'current' },
        { key: 'deal_id', label: 'Deal-ID', type: 'text', placeholder: '{{var.deal.id}}', showIf: { field: 'source', in: ['id'] } },
        { key: 'pipeline_id', label: 'Pipeline', type: 'pipeline' },
        { key: 'stage_id', label: 'Neue Stufe', type: 'stage' },
        { key: 'status', label: 'Neuer Status', type: 'select', options: [['', 'unverändert'], ['open', 'Offen'], ['won', 'Gewonnen'], ['lost', 'Verloren'], ['abandoned', 'Aufgegeben']] },
        { key: 'lost_reason', label: 'Verlustgrund', type: 'text', placeholder: 'Preis zu hoch', showIf: { field: 'status', in: ['lost'] } },
        { key: 'name', label: 'Neuer Name', type: 'text' },
        { key: 'value', label: 'Wert', type: 'text', placeholder: '{{var.summe}}' },
        { key: 'currency', label: 'Währung', type: 'text', placeholder: 'EUR' },
        { key: 'expected_close_date', label: 'Erwarteter Abschluss (JJJJ-MM-TT)', type: 'text', placeholder: '{{var.abschluss}}' },
        { key: 'value_mode', label: 'Wert', type: 'select', options: [['set', 'setzen'], ['add', 'um diesen Betrag erhöhen'], ['multiply', 'mit diesem Faktor multiplizieren']], default: 'set' },
        { key: 'assigned_to', label: 'Besitzer', type: 'user' },
        { key: 'if_missing', label: 'Wenn kein Deal da ist', type: 'select', options: [['continue', 'Weiter'], ['error', 'Fehler'], ['create', 'Deal anlegen']], default: 'continue' },
      ],
      sample: { source: 'current', value: '{{var.summe}}', value_mode: 'set' },
    },
    run: (run, step, vars) => {
      const loc = run.location_id;
      let opp: any;
      if (step.source === 'id') opp = db.get('SELECT * FROM opportunities WHERE id = ? AND location_id = ?', text(step.deal_id, vars).trim(), loc);
      else {
        opp = db.get(`SELECT * FROM opportunities WHERE contact_id = ? AND location_id = ? AND status = 'open' ${step.pipeline_id ? 'AND pipeline_id = ?' : ''} ORDER BY updated_at DESC LIMIT 1`, run.contact_id, loc, ...(step.pipeline_id ? [step.pipeline_id] : []));
      }
      const patch: Record<string, any> = {};
      if (step.name) patch.name = text(step.name, vars);
      if (step.status) patch.status = step.status;
      // A lost deal needs a reason: the step's own, otherwise one that says "automation".
      if (step.status === 'lost') patch.lost_reason = text(step.lost_reason, vars).trim() || AUTO_LOST_REASON;
      if (step.currency) patch.currency = text(step.currency, vars).trim();
      if (step.expected_close_date) patch.expected_close_date = text(step.expected_close_date, vars).trim();
      if (step.assigned_to) patch.assigned_to = step.assigned_to;
      if (step.stage_id) patch.stage_id = step.stage_id;
      // A cleared field (null, as the editor saves it) means "leave the value alone".
      if (step.value !== undefined && step.value !== null && String(step.value).trim() !== '') {
        const n = parseNumber(text(step.value, vars));
        if (Number.isNaN(n)) throw new Error(text(step.value, vars).trim() ? `Wert „${preview(text(step.value, vars), 30)}“ ist keine Zahl` : 'Wert ist leer');
        patch.value = step.value_mode === 'add' ? Number(opp?.value ?? 0) + n : step.value_mode === 'multiply' ? Number(opp?.value ?? 0) * n : n;
      }
      if (!opp) {
        if (step.if_missing === 'create' && step.pipeline_id) {
          const o = createOpportunity(app, loc, { pipeline_id: step.pipeline_id, stage_id: step.stage_id, contact_id: run.contact_id, name: patch.name, value: patch.value, status: patch.status, lost_reason: patch.lost_reason, currency: patch.currency, expected_close_date: patch.expected_close_date, assigned_to: patch.assigned_to, source: 'Workflow' });
          return { result: `Deal angelegt: ${o.name}`, vars: { deal_id: o.id }, output: o };
        }
        if (step.if_missing === 'error') throw new Error('Kein Deal gefunden');
        return { result: 'Kein Deal gefunden – übersprungen' };
      }
      if (!Object.keys(patch).length) return { result: 'Keine Änderung angegeben' };
      const next = updateOpportunity(app, loc, opp.id, patch);
      return { result: `Deal „${next.name}“ geändert: ${Object.keys(patch).join(', ')}`, vars: { deal_id: next.id }, output: next };
    },
  });

  // --- task ---------------------------------------------------------------------------------------
  add({
    meta: {
      type: 'update_task',
      label: 'Aufgabe ändern / abhaken',
      category: 'crm',
      icon: 'todo',
      summary: 'Hakt Aufgaben des Kontakts ab, öffnet sie wieder oder ändert Titel, Frist, Zuständigen.',
      doc: 'Wählt Aufgaben des Kontakts: alle offenen, nur solche, deren Titel einen Text enthält, oder eine bestimmte Aufgaben-ID. Abhaken löst den Auslöser „Aufgabe erledigt“ aus.',
      keywords: 'task aufgabe erledigen complete update frist',
      fields: [
        { key: 'match', label: 'Welche Aufgaben', type: 'select', options: [['open', 'Alle offenen des Kontakts'], ['title', 'Titel enthält …'], ['id', 'Aufgaben-ID']], default: 'open' },
        { key: 'title_contains', label: 'Titel enthält', type: 'text', showIf: { field: 'match', in: ['title'] } },
        { key: 'task_id', label: 'Aufgaben-ID', type: 'text', showIf: { field: 'match', in: ['id'] } },
        { key: 'action', label: 'Aktion', type: 'select', options: [['complete', 'Abhaken'], ['reopen', 'Wieder öffnen'], ['update', 'Ändern']], default: 'complete' },
        { key: 'new_title', label: 'Neuer Titel', type: 'text', showIf: { field: 'action', in: ['update'] } },
        { key: 'due_in_days', label: 'Neue Frist in Tagen', type: 'number', showIf: { field: 'action', in: ['update'] } },
        { key: 'assigned_to', label: 'Zuständig', type: 'user', showIf: { field: 'action', in: ['update'] } },
      ],
      sample: { match: 'title', title_contains: 'Angebot', action: 'complete' },
    },
    run: (run, step, vars) => {
      const loc = run.location_id;
      let tasks: any[];
      if (step.match === 'id') tasks = db.all('SELECT * FROM tasks WHERE id = ? AND location_id = ?', text(step.task_id, vars).trim(), loc);
      else {
        tasks = db.all('SELECT * FROM tasks WHERE contact_id = ? AND location_id = ? ORDER BY created_at DESC LIMIT 200', run.contact_id, loc);
        if (step.match === 'title') tasks = tasks.filter((t) => String(t.title).toLowerCase().includes(text(step.title_contains, vars).toLowerCase()));
        if (step.action !== 'reopen') tasks = tasks.filter((t) => !t.done);
        else tasks = tasks.filter((t) => t.done);
      }
      if (!tasks.length) return { result: 'Keine passende Aufgabe' };
      let n = 0;
      for (const t of tasks) {
        const patch: Record<string, any> = {};
        if (step.action === 'complete') (patch.done = 1), (patch.completed_at = now());
        else if (step.action === 'reopen') (patch.done = 0), (patch.completed_at = null);
        else {
          if (step.new_title) patch.title = text(step.new_title, vars).slice(0, 300);
          if (step.due_in_days !== undefined && step.due_in_days !== '') patch.due_at = new Date(Date.now() + Number(step.due_in_days) * 864e5).toISOString();
          if (step.assigned_to) patch.assigned_to = step.assigned_to;
        }
        if (!Object.keys(patch).length) continue;
        db.update('tasks', t.id, patch, loc);
        n++;
        if (step.action === 'complete') app.events.emit(loc, 'task.completed', { contactId: t.contact_id ?? undefined, task: { ...t, ...patch }, viaWorkflow: run.workflow_id, wfDepth: Number(run.event?.wfDepth ?? 0) + 1 });
      }
      return { result: `${n} Aufgabe${n === 1 ? '' : 'n'} ${step.action === 'complete' ? 'abgehakt' : step.action === 'reopen' ? 'geöffnet' : 'geändert'}` };
    },
  });

  // --- appointments -------------------------------------------------------------------------------
  add({
    meta: {
      type: 'create_appointment',
      label: 'Termin anlegen',
      category: 'sales',
      icon: 'calendars',
      summary: 'Bucht einen Termin für den Kontakt in einem Kalender.',
      doc: 'Zeitpunkt: in X Stunden/Tagen/Werktagen oder zu einem Datum (z. B. {{var.slot}}), mit Uhrzeit in der Zeitzone des Sub-Accounts. Die Dauer kommt vom Kalender. Ohne „Verfügbarkeit prüfen“ wird der Termin auch außerhalb der Buchungszeiten gesetzt. Bestätigungs-Mail und Tags des Kalenders greifen wie bei einer normalen Buchung; {{var.appointment_id}} merkt sich den Termin.',
      keywords: 'termin appointment buchen calendar kalender',
      fields: [
        { key: 'calendar_id', label: 'Kalender', type: 'calendar', required: true },
        ...whenFields(),
        { key: 'notes', label: 'Notizen', type: 'textarea' },
        { key: 'check', label: 'Verfügbarkeit prüfen (sonst immer buchen)', type: 'bool' },
      ],
      provides: ['var.appointment_id'],
      sample: { when: 'in', amount: 2, unit: 'business_days', time: '10:00' },
    },
    run: (run, step, vars) => {
      const cal = parseJson(db.get<any>('SELECT * FROM calendars WHERE id = ? AND location_id = ?', step.calendar_id, run.location_id), ['availability', 'settings']) as CalendarRow | undefined;
      if (!cal) throw new Error('Kalender nicht gefunden');
      const start = whenDate(run, step, vars);
      const appt = bookAppointment(app, cal, { start: start.toISOString(), contact: { id: run.contact_id }, notes: text(step.notes, vars), source: 'Workflow', skipCheck: !step.check });
      return { result: `Termin gebucht: ${start.toISOString()}`, vars: { appointment_id: appt.id }, output: { id: appt.id, start_at: appt.start_at } };
    },
  });

  add({
    meta: {
      type: 'update_appointment',
      label: 'Termin ändern / absagen',
      category: 'sales',
      icon: 'calendars',
      summary: 'Sagt den nächsten Termin des Kontakts ab, bestätigt, markiert ihn oder verschiebt ihn.',
      doc: 'Wählt den nächsten anstehenden (oder letzten) Termin des Kontakts bzw. eine Termin-ID. Absagen, Bestätigen, „erschienen“, „nicht erschienen“ oder Verschieben. Verschieben löst den Auslöser „Termin verschoben“ aus, die anderen „Terminstatus geändert“.',
      keywords: 'termin appointment absagen cancel verschieben reschedule noshow',
      fields: [
        { key: 'which', label: 'Welcher Termin', type: 'select', options: [['next', 'Nächster anstehender'], ['last', 'Letzter'], ['id', 'Termin-ID']], default: 'next' },
        { key: 'appointment_id', label: 'Termin-ID', type: 'text', placeholder: '{{var.appointment_id}}', showIf: { field: 'which', in: ['id'] } },
        { key: 'action', label: 'Aktion', type: 'select', options: [['cancelled', 'Absagen'], ['confirmed', 'Bestätigen'], ['showed', 'Als erschienen markieren'], ['noshow', 'Als nicht erschienen markieren'], ['reschedule', 'Verschieben']], default: 'cancelled' },
        ...whenFields('new_').map((f) => ({ ...f, showIf: { field: 'action', in: ['reschedule'] } })),
      ],
      sample: { which: 'next', action: 'cancelled' },
    },
    run: (run, step, vars) => {
      const loc = run.location_id;
      let a: any;
      if (step.which === 'id') a = db.get('SELECT * FROM appointments WHERE id = ? AND location_id = ?', text(step.appointment_id, vars).trim(), loc);
      else if (step.which === 'last') a = db.get(`SELECT * FROM appointments WHERE contact_id = ? AND location_id = ? AND status != 'blocked' ORDER BY start_at DESC LIMIT 1`, run.contact_id, loc);
      else a = db.get(`SELECT * FROM appointments WHERE contact_id = ? AND location_id = ? AND status = 'confirmed' AND start_at >= ? ORDER BY start_at LIMIT 1`, run.contact_id, loc, now());
      if (!a) return { result: 'Kein passender Termin' };
      const action = String(step.action ?? 'cancelled');
      if (action === 'reschedule') {
        const start = whenDate(run, step, vars, 'new_');
        const dur = Date.parse(a.end_at) - Date.parse(a.start_at);
        db.update('appointments', a.id, { start_at: start.toISOString(), end_at: new Date(start.getTime() + dur).toISOString(), reminder_sent: 0 });
        const next = db.get<any>('SELECT * FROM appointments WHERE id = ?', a.id)!;
        logActivity(app, loc, a.contact_id, 'appointment.rescheduled', `Termin verschoben auf ${start.toISOString()}`);
        app.events.emit(loc, 'appointment.rescheduled', { contactId: a.contact_id, appointment: next, previousStart: a.start_at, calendarId: a.calendar_id, viaWorkflow: run.workflow_id, wfDepth: Number(run.event?.wfDepth ?? 0) + 1 });
        return { result: `Termin verschoben auf ${start.toISOString()}`, output: next };
      }
      if (!['cancelled', 'confirmed', 'showed', 'noshow'].includes(action)) throw new Error('Unbekannte Aktion');
      if (a.status === action) return { result: `Termin ist schon „${action}“` };
      db.update('appointments', a.id, { status: action });
      logActivity(app, loc, a.contact_id, 'appointment.status_changed', `Termin: ${action}`);
      app.events.emit(loc, 'appointment.status_changed', { contactId: a.contact_id, appointment: { ...a, status: action }, status: action, calendarId: a.calendar_id, viaWorkflow: run.workflow_id, wfDepth: Number(run.event?.wfDepth ?? 0) + 1 });
      return { result: `Termin: ${action}` };
    },
  });

  // --- DND per channel ----------------------------------------------------------------------------
  const DND_CHANNELS: [string, string][] = [['all', 'Alle Kanäle'], ['email', 'E-Mail'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['call', 'Anrufe'], ['chat', 'Live-Chat']];
  add({
    meta: {
      type: 'update_dnd',
      label: 'DND je Kanal',
      category: 'crm',
      icon: 'dnd',
      summary: 'Schaltet „Nicht stören“ für einzelne Kanäle oder alle ein oder aus.',
      doc: '„Alle Kanäle“ setzt das allgemeine „Nicht stören“ des Kontakts. Einzelne Kanäle (E-Mail, SMS, WhatsApp) werden beim Senden aus Workflows, Kampagnen und dem Postfach beachtet; Anrufe merkt sich der Kontakt im Protokoll. Eine ausdrückliche Nachricht von Hand kann DND überstimmen.',
      keywords: 'dnd nicht stören opt out abmelden',
      fields: [
        { key: 'value', label: 'Aktion', type: 'select', options: [['on', 'Nicht stören einschalten'], ['off', 'Nicht stören ausschalten']], default: 'on' },
        { key: 'channels', label: 'Kanäle', type: 'tags', default: ['all'], help: 'Komma-getrennt: all, email, sms, whatsapp, call, chat' },
      ],
      sample: { value: 'on', channels: ['sms', 'whatsapp'] },
    },
    run: (run, step) => {
      const on = step.value !== 'off';
      const chosen: string[] = (Array.isArray(step.channels) && step.channels.length ? step.channels : ['all']).map((c: unknown) => String(c).trim().toLowerCase()).filter((c: string) => DND_CHANNELS.some((d) => d[0] === c));
      if (!chosen.length) throw new Error('Kein gültiger Kanal (all, email, sms, whatsapp, call, chat)');
      for (const ch of chosen) {
        if (ch === 'all') {
          db.update('contacts', run.contact_id, { dnd: on ? 1 : 0, updated_at: now() }, run.location_id);
          if (!on) db.run('DELETE FROM wfx_dnd WHERE contact_id = ?', run.contact_id);
        } else if (on) db.run('INSERT OR REPLACE INTO wfx_dnd (contact_id, channel, at) VALUES (?, ?, ?)', run.contact_id, ch, now());
        else db.run('DELETE FROM wfx_dnd WHERE contact_id = ? AND channel = ?', run.contact_id, ch);
      }
      logActivity(app, run.location_id, run.contact_id, 'dnd.changed', `Nicht stören ${on ? 'an' : 'aus'}: ${chosen.join(', ')}`);
      return { result: `Nicht stören ${on ? 'an' : 'aus'} (${chosen.join(', ')})` };
    },
  });

  // --- tags with conditions -----------------------------------------------------------------------
  add({
    meta: {
      type: 'tag_if',
      label: 'Tags je nach Bedingung',
      category: 'crm',
      icon: 'tag',
      summary: 'Setzt oder entfernt Tags nur, wenn eine Bedingung zutrifft – sonst andere Tags.',
      doc: 'Trifft die Bedingung zu, werden „Hinzufügen“ und „Entfernen“ ausgeführt, sonst „Sonst hinzufügen“ und „Sonst entfernen“. Spart ein Wenn/Sonst für Segmentierungen wie „Budget über 1000 → vip, sonst standard“.',
      keywords: 'tag segment bedingung conditional',
      fields: [
        ...CONDITIONS,
        { key: 'add', label: 'Hinzufügen', type: 'tags' },
        { key: 'remove', label: 'Entfernen', type: 'tags' },
        { key: 'else_add', label: 'Sonst hinzufügen', type: 'tags' },
        { key: 'else_remove', label: 'Sonst entfernen', type: 'tags' },
      ],
      sample: { expression: 'number(contact.custom.budget) > 1000', add: ['vip'], else_add: ['standard'] },
    },
    run: (run, step, vars) => {
      const ok = !((Array.isArray(step.conditions) && step.conditions.length) || String(step.expression ?? '').trim()) ? true : gate(step, vars);
      const addT = (ok ? step.add : step.else_add) ?? [];
      const rem = (ok ? step.remove : step.else_remove) ?? [];
      const clean = (l: unknown[]) => l.map((t) => text(t, vars).trim()).filter(Boolean);
      if (clean(addT).length) addTags(app, run.location_id, run.contact_id, clean(addT));
      if (clean(rem).length) removeTags(app, run.location_id, run.contact_id, clean(rem));
      return { result: `${ok ? 'Bedingung erfüllt' : 'Bedingung nicht erfüllt'}: +${clean(addT).join(', ') || '–'} −${clean(rem).join(', ') || '–'}` };
    },
  });

  // --- assign user (round robin with weights) -----------------------------------------------------
  add({
    meta: {
      type: 'assign_user',
      label: 'Nutzer zuweisen (Round-Robin)',
      category: 'crm',
      icon: 'contact',
      summary: 'Weist Kontakt und/oder Deal reihum (gewichtet) einem Teammitglied zu.',
      doc: 'Ohne Auswahl sind alle Teammitglieder des Sub-Accounts dabei, jedes mit Gewicht 1. Gewichte steuern den Anteil (2 = doppelt so oft). Die Verteilung merkt sich ihren Stand je Schritt – so bekommt jeder fair seinen Anteil, auch über Neustarts. {{var.assigned_user.name}} enthält den Gewählten.',
      keywords: 'round robin zuweisen assign owner besitzer verteilen',
      fields: [
        { key: 'rows', label: 'Teammitglieder und Gewichte (leer = alle, Gewicht 1)', type: 'rows', addLabel: '+ Mitglied', rows: [{ key: 'user_id', label: 'Nutzer', type: 'user' }, { key: 'weight', label: 'Gewicht', type: 'number', default: 1 }] },
        { key: 'target', label: 'Zuweisen an', type: 'select', options: [['contact', 'Kontakt'], ['opportunity', 'Offenen Deal des Kontakts'], ['both', 'Kontakt und Deal']], default: 'contact' },
        { key: 'skip_if_assigned', label: 'Nicht ändern, wenn schon jemand zugewiesen ist', type: 'bool' },
        { key: 'task_notify', label: 'Dem Gewählten eine Push-Meldung schicken', type: 'bool' },
      ],
      provides: ['var.assigned_user'],
      sample: { target: 'both' },
    },
    run: async (run, step, vars) => {
      const loc = run.location_id;
      const team = userMap(loc);
      const rows = rowsOf<{ user_id: string; weight: number }>(step.rows, ['user_id']);
      const cands = (rows.length ? rows.map((r) => ({ id: String(r.user_id), weight: Math.max(0, Number(r.weight ?? 1)) })) : [...team.keys()].map((id) => ({ id, weight: 1 }))).filter((c) => team.has(c.id) || db.get('SELECT 1 FROM users WHERE id = ?', c.id));
      if (!cands.length) throw new Error('Kein Teammitglied zum Zuweisen');
      const contact = getContact(app, loc, run.contact_id);
      if (step.skip_if_assigned && contact?.assigned_to) return { result: 'Schon zugewiesen – nicht geändert' };
      const uid = nextWeighted(app, loc, `${run.workflow_id}:${step.id}`, cands);
      if (!uid) throw new Error('Alle Gewichte sind 0');
      const user = db.get<any>('SELECT id, name, email FROM users WHERE id = ?', uid)!;
      const target = String(step.target ?? 'contact');
      if (target === 'contact' || target === 'both') db.update('contacts', run.contact_id, { assigned_to: uid, updated_at: now() }, loc);
      if (target === 'opportunity' || target === 'both') db.run(`UPDATE opportunities SET assigned_to = ?, updated_at = ? WHERE contact_id = ? AND location_id = ? AND status = 'open'`, uid, now(), run.contact_id, loc);
      logActivity(app, loc, run.contact_id, 'assigned', `Zugewiesen an ${user.name}`);
      if (step.task_notify) void Promise.resolve(app.services.pushNotify?.({ userIds: [uid], kind: 'tasks', title: 'Neu zugewiesen', body: String(vars.contact?.name ?? ''), url: `/app/contacts/${run.contact_id}`, tag: `assign-${run.contact_id}` })).catch(() => {});
      return { result: `Zugewiesen an ${user.name}`, vars: { assigned_user: { id: user.id, name: user.name, email: user.email } }, output: { id: user.id, name: user.name } };
    },
  });

  // --- remove from all workflows ------------------------------------------------------------------
  add({
    meta: {
      type: 'remove_all_workflows',
      label: 'Aus allen Workflows entfernen',
      category: 'flow',
      icon: 'stop',
      summary: 'Stoppt alle laufenden und wartenden Workflows des Kontakts.',
      doc: 'Praktisch bei „hat gekauft“, „hat sich abgemeldet“ oder „Termin gebucht“: alle anderen Nachfass-Strecken enden sofort. Der aktuelle Workflow bleibt standardmäßig unberührt.',
      keywords: 'stop alle workflows entfernen abmelden',
      fields: [{ key: 'keep_current', label: 'Diesen Workflow weiterlaufen lassen', type: 'bool', default: true }],
      sample: { keep_current: true },
    },
    run: (run, step) => {
      const keep = step.keep_current !== false;
      const r = db.run(`UPDATE workflow_runs SET status = 'stopped', updated_at = ? WHERE contact_id = ? AND location_id = ? AND status IN ('active','waiting') ${keep ? 'AND id != ?' : ''}`, now(), run.contact_id, run.location_id, ...(keep ? [run.id] : []));
      return { result: `${r.changes} Durchlauf${r.changes === 1 ? '' : 'läufe'} gestoppt` };
    },
  });

  // --- internal notification ----------------------------------------------------------------------
  add({
    meta: {
      type: 'notify_user',
      label: 'Interne Benachrichtigung',
      category: 'messaging',
      icon: 'notify',
      summary: 'Meldet dem Team (App, Push, E-Mail, SMS) – z. B. dem Zuständigen des Kontakts.',
      doc: 'Empfänger: der Zuständige des Kontakts (sonst alle), bestimmte Mitarbeiter oder das ganze Team. Kanäle: Handy-App-Meldung, Web-Push, E-Mail an die Mitarbeiter und SMS an feste Nummern. Titel und Text mit Platzhaltern; die Meldung verlinkt auf den Kontakt.',
      keywords: 'intern notification benachrichtigung team mitarbeiter push sms mail',
      fields: [
        { key: 'recipients', label: 'Empfänger', type: 'select', options: [['owner', 'Zuständiger des Kontakts (sonst alle)'], ['users', 'Bestimmte Mitarbeiter'], ['all', 'Ganzes Team']], default: 'owner' },
        { key: 'user_ids', label: 'Mitarbeiter', type: 'users', showIf: { field: 'recipients', in: ['users'] } },
        { key: 'channels', label: 'Kanäle', type: 'tags', default: ['app', 'push'], help: 'app, push, email, sms' },
        { key: 'sms_to', label: 'SMS an Nummern (komma-getrennt)', type: 'text', showIf: { field: 'channels', in: ['sms'] } },
        { key: 'title', label: 'Titel', type: 'text', default: 'Neuer Lead: {{contact.name}}' },
        { key: 'body', label: 'Text', type: 'textarea', default: '{{contact.name}} ({{contact.email}})' },
      ],
      sample: { recipients: 'owner', channels: ['app', 'push', 'email'], title: 'Neuer Lead: {{contact.name}}', body: '{{contact.email}}' },
    },
    run: async (run, step, vars) => {
      const loc = run.location_id;
      const title = text(step.title, vars).slice(0, 120) || 'Benachrichtigung';
      const body = text(step.body, vars);
      const channels: string[] = (Array.isArray(step.channels) && step.channels.length ? step.channels : ['app']).map((c: unknown) => String(c).trim().toLowerCase());
      const team = userMap(loc);
      let ids: string[];
      if (step.recipients === 'users') ids = (Array.isArray(step.user_ids) ? step.user_ids : []).map(String).filter((u: string) => team.has(u));
      else if (step.recipients === 'all') ids = [...team.keys()];
      else {
        const owner = getContact(app, loc, run.contact_id)?.assigned_to;
        ids = owner && db.get('SELECT 1 FROM users WHERE id = ?', owner) ? [owner] : [...team.keys()];
      }
      const done: string[] = [];
      const link = `/app/contacts/${run.contact_id}`;
      if (channels.includes('app') && ids.length) {
        let n = 0;
        for (const u of ids) n += Number(app.services.mobileFeed?.({ locationId: loc, type: 'workflow', area: '', userId: u, title, body, link, ref: `wf:${run.id}:${step.id}:${u}` }) ?? 0);
        done.push(`App (${n})`);
      }
      if (channels.includes('push') && ids.length) {
        const r = await Promise.resolve(app.services.pushNotify?.({ userIds: ids, kind: 'tasks', title, body, url: link, tag: `wf-${run.id}` })).catch(() => undefined);
        done.push(`Push (${r?.sent ?? 0})`);
      }
      if (channels.includes('email')) {
        const emails = ids.map((u) => team.get(u)?.email ?? db.get<any>('SELECT email FROM users WHERE id = ?', u)?.email).filter(Boolean);
        for (const e of emails.length ? emails : [undefined]) await notifyTeam(app, loc, title, `${body}\n\n${app.baseUrl()}${link}`, e);
        done.push(`E-Mail (${emails.length || 1})`);
      }
      if (channels.includes('sms')) {
        const numbers = text(step.sms_to, vars).split(/[,;\s]+/).filter(Boolean);
        const l = app.location(loc);
        let sent = 0;
        for (const n of numbers.slice(0, 5)) {
          try {
            await deliverSms(l!, n, `${title}: ${body}`.slice(0, 480));
            sent++;
          } catch (e) {
            throw new Error(`SMS an ${n}: ${(e as Error).message}`);
          }
        }
        done.push(`SMS (${sent})`);
      }
      return { result: done.length ? `Gemeldet über ${done.join(', ')}` : 'Niemand zu benachrichtigen', output: { users: ids.length, channels: done } };
    },
  });

  // --- custom event -------------------------------------------------------------------------------
  add({
    meta: {
      type: 'emit_event',
      label: 'Eigenes Ereignis auslösen',
      category: 'flow',
      icon: 'trigger',
      summary: 'Löst ein eigenes Ereignis aus, auf das andere Workflows mit „Eigenes Ereignis“ hören.',
      doc: 'Name (z. B. „onboarding_fertig“) und optionale Daten als JSON. Andere Workflows mit dem Auslöser „Eigenes Ereignis“ starten für diesen Kontakt – so lassen sich Strecken verketten und teilen. Ketten sind auf 4 Stufen begrenzt, ein Workflow startet sich nicht selbst.',
      keywords: 'event ereignis custom webhook trigger verketten',
      fields: [
        { key: 'name', label: 'Name des Ereignisses', type: 'text', placeholder: 'onboarding_fertig', required: true },
        { key: 'data', label: 'Daten (JSON, optional)', type: 'code', placeholder: '{"plan": "{{var.plan}}"}' },
      ],
      sample: { name: 'onboarding_fertig', data: '{"plan":"pro"}' },
    },
    run: (run, step, vars) => {
      const name = requireText(text(step.name, vars), 'Name').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 60);
      let data: Record<string, unknown> = {};
      const raw = text(step.data, vars).trim();
      if (raw) {
        try {
          const j = JSON.parse(raw);
          if (j && typeof j === 'object' && !Array.isArray(j)) data = j;
          else throw new Error('x');
        } catch {
          throw new Error('Die Daten sind kein gültiges JSON-Objekt');
        }
      }
      app.events.emit(run.location_id, 'event.custom', { ...data, name, data, contactId: run.contact_id, viaWorkflow: run.workflow_id, wfDepth: Number(run.event?.wfDepth ?? 0) + 1 });
      return { result: `Ereignis „${name}“ ausgelöst`, output: { name, data } };
    },
  });

  // --- invoices & payment links -------------------------------------------------------------------
  const euro = (v: unknown, vars: Record<string, any>) => {
    const n = parseNumber(text(v, vars));
    if (Number.isNaN(n)) throw new Error(text(v, vars).trim() ? `„${preview(text(v, vars), 30)}“ ist keine Zahl` : 'Betrag fehlt');
    return Math.round(n * 100);
  };
  const invoiceUrl = (inv: any) => `${app.baseUrl()}/i/${inv.public_token}`;
  add({
    meta: {
      type: 'invoice_create',
      label: 'Rechnung / Angebot erstellen',
      category: 'payments',
      icon: 'invoices',
      summary: 'Erstellt eine Rechnung oder ein Angebot für den Kontakt und schickt es auf Wunsch gleich.',
      doc: 'Positionen mit Name, Menge, Preis (netto, €) und Steuersatz (leer = Standard des Sub-Accounts). Die Rechnungsnummer kommt aus dem Zähler der Rechnungen. Mit „Senden“ geht ein Link per E-Mail oder SMS raus; online bezahlen lässt sich mit Stripe. Danach gibt es {{var.invoice_url}}, {{var.invoice_number}} und {{var.invoice_id}}.',
      keywords: 'rechnung invoice angebot estimate zahlung senden',
      fields: [
        { key: 'kind', label: 'Art', type: 'select', options: [['invoice', 'Rechnung'], ['estimate', 'Angebot']], default: 'invoice' },
        { key: 'title', label: 'Titel', type: 'text', placeholder: 'Beratung {{contact.company}}' },
        { key: 'rows', label: 'Positionen', type: 'rows', addLabel: '+ Position', rows: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'qty', label: 'Menge', type: 'number', default: 1 }, { key: 'price', label: 'Preis netto (€)', type: 'text' }, { key: 'tax', label: 'Steuer %', type: 'text' }] },
        { key: 'due_days', label: 'Zahlungsziel (Tage)', type: 'number' },
        { key: 'send', label: 'Gleich senden', type: 'bool', default: true },
        { key: 'channel', label: 'Kanal', type: 'select', options: [['email', 'E-Mail'], ['sms', 'SMS']], default: 'email', showIf: { field: 'send', in: ['true'] } },
        { key: 'subject', label: 'Betreff (optional)', type: 'text' },
        { key: 'message', label: 'Nachricht (optional)', type: 'textarea', help: '{{invoice.url}}, {{invoice.number}}, {{invoice.total}} sind verfügbar.' },
      ],
      provides: ['var.invoice_url', 'var.invoice_number', 'var.invoice_id'],
      sample: { kind: 'invoice', title: 'Beratung', rows: [{ name: 'Erstberatung', qty: 1, price: '149', tax: '19' }], send: true },
    },
    run: async (run, step, vars) => {
      const loc = run.location_id;
      const items = rowsOf<any>(step.rows, ['name']).map((r) => ({ name: text(r.name, vars), qty: Number(text(r.qty ?? 1, vars)) || 1, price_cents: euro(r.price ?? 0, vars), ...(r.tax !== undefined && String(r.tax).trim() !== '' ? { tax_rate: Number(parseNumber(text(r.tax, vars))) } : {}) }));
      if (!items.length) throw new Error('Mindestens eine Position angeben');
      const issued = now();
      let inv: any = createInvoice(app, loc, { kind: step.kind === 'estimate' ? 'estimate' : 'invoice', contact_id: run.contact_id, title: text(step.title, vars), items, due_at: step.due_days ? new Date(Date.now() + Number(step.due_days) * 864e5).toISOString() : undefined, issued_at: issued });
      // Sending finalises the invoice (it gets its number then), so the outcome is read afterwards.
      if (step.send !== false) inv = await sendInvoice(app, loc, inv, { channel: step.channel, subject: step.subject ? text(step.subject, vars) : undefined, body: step.message ? text(step.message, vars) : undefined });
      const out: ActionOutcome = { result: `${inv.kind === 'estimate' ? 'Angebot' : 'Rechnung'}${inv.number ? ` ${inv.number}` : ''} erstellt${step.send !== false ? ' und gesendet' : ''}`, vars: { invoice_url: invoiceUrl(inv), invoice_number: inv.number, invoice_id: inv.id }, output: { id: inv.id, number: inv.number, total_cents: inv.total_cents } };
      return out;
    },
  });

  add({
    meta: {
      type: 'payment_link',
      label: 'Zahlungslink erstellen',
      category: 'payments',
      icon: 'card',
      summary: 'Erzeugt einen Link zum Bezahlen (Produkt-Kaufseite oder Rechnung über einen Betrag).',
      doc: '„Produkt“ nimmt die Kaufseite eines Produkts (/buy/…) oder dessen externen Zahlungslink. „Betrag“ erstellt eine Rechnung über den Betrag; ihr Link zeigt „Jetzt bezahlen“, sobald Stripe eingerichtet ist. Der Link steht in {{var.payment_url}}; mit „Senden“ geht er gleich als Nachricht an den Kontakt.',
      keywords: 'payment link zahlungslink stripe bezahlen checkout',
      fields: [
        { key: 'mode', label: 'Art', type: 'select', options: [['amount', 'Betrag (Rechnung)'], ['product', 'Produkt']], default: 'amount' },
        { key: 'product_id', label: 'Produkt', type: 'product', showIf: { field: 'mode', in: ['product'] } },
        { key: 'title', label: 'Bezeichnung', type: 'text', placeholder: 'Anzahlung', showIf: { field: 'mode', in: ['amount'] } },
        { key: 'amount', label: 'Betrag brutto (€)', type: 'text', showIf: { field: 'mode', in: ['amount'] } },
        { key: 'send', label: 'Link gleich per Nachricht senden', type: 'bool' },
        { key: 'channel', label: 'Kanal', type: 'select', options: [['email', 'E-Mail'], ['sms', 'SMS']], default: 'email', showIf: { field: 'send', in: ['true'] } },
        { key: 'message', label: 'Nachricht', type: 'textarea', default: 'Hallo {{contact.first_name|}},\n\nhier kannst du bequem bezahlen: {{var.payment_url}}\n\n{{location.name}}', showIf: { field: 'send', in: ['true'] } },
      ],
      provides: ['var.payment_url'],
      sample: { mode: 'amount', title: 'Anzahlung', amount: '250' },
    },
    run: async (run, step, vars) => {
      const loc = run.location_id;
      let url: string;
      const out: ActionOutcome = { result: '' };
      if (step.mode === 'product') {
        const p = db.get<any>('SELECT * FROM products WHERE (id = ? OR id = ?) AND location_id = ?', text(step.product_id, vars).trim(), String(step.product_id ?? ''), loc);
        if (!p) throw new Error('Produkt nicht gefunden');
        url = p.payment_link || `${app.baseUrl()}/buy/${encodeURIComponent(p.id)}`;
      } else {
        const gross = euro(step.amount, vars);
        if (gross <= 0) throw new Error('Betrag muss größer als 0 sein');
        const settings = app.location(loc)?.settings.invoices ?? {};
        const rate = settings.small_business ? 0 : Number(settings.tax_rate ?? 19);
        const draft = createInvoice(app, loc, { kind: 'invoice', contact_id: run.contact_id, title: text(step.title, vars) || 'Zahlung', items: [{ name: text(step.title, vars) || 'Zahlung', qty: 1, price_cents: Math.round(gross / (1 + rate / 100)), tax_rate: rate }] });
        // The customer sees this invoice: it is finalised now (number, freeze).
        const inv = ensureFinal(app, loc, draft.id);
        url = invoiceUrl(inv);
        out.vars = { payment_url: url, invoice_id: inv.id, invoice_number: inv.number };
        app.db.run(`UPDATE invoices SET sent_at = ? WHERE id = ?`, now(), inv.id);
      }
      out.vars = { ...(out.vars ?? {}), payment_url: url };
      if (step.send) {
        const vv = { ...vars, var: { ...(vars.var ?? {}), payment_url: url } };
        const m = await sendToContact(app, loc, { contactId: run.contact_id, channel: step.channel === 'sms' ? 'sms' : 'email', subject: 'Zahlungslink', body: render(String(step.message ?? 'Hier kannst du bezahlen: {{var.payment_url}}'), vv), source: 'Zahlungslink' });
        if (m.status === 'failed') throw new Error(m.error);
      }
      out.result = `Zahlungslink erstellt${step.send ? ' und gesendet' : ''}`;
      out.output = { url };
      return out;
    },
  });

  // --- contract from template ---------------------------------------------------------------------
  add({
    meta: {
      type: 'contract_send',
      label: 'Vertrag aus Vorlage erstellen',
      category: 'payments',
      icon: 'contracts',
      summary: 'Erzeugt aus einer Vertragsvorlage ein Dokument für den Kontakt und schickt es zur Unterschrift.',
      doc: 'Die Vorlage (Verträge → Vorlagen) wird mit den Platzhaltern des Kontakts gefüllt ({{contact.name}}, {{contact.company}}, {{var.…}}) und als neuer Vertrag angelegt. Mit „Senden“ bekommt der Kontakt den Link zum Lesen und Unterschreiben; ohne Senden bleibt es ein Entwurf (z. B. zum Prüfen). {{var.contract_url}} enthält den Link.',
      keywords: 'vertrag contract dokument document vorlage template unterschrift sign',
      fields: [
        { key: 'template_id', label: 'Vorlage', type: 'contract_template', help: 'Vertragsvorlagen unter Verträge → Vorlagen.', required: true },
        { key: 'title', label: 'Titel (leer = Titel der Vorlage)', type: 'text' },
        { key: 'send', label: 'Zur Unterschrift senden', type: 'bool', default: true },
        { key: 'channel', label: 'Kanal', type: 'select', options: [['email', 'E-Mail'], ['sms', 'SMS']], default: 'email', showIf: { field: 'send', in: ['true'] } },
      ],
      provides: ['var.contract_url', 'var.contract_id'],
      sample: { template_id: '', send: true },
    },
    run: async (run, step, vars) => {
      const loc = run.location_id;
      const tpl = db.get<any>(`SELECT * FROM contracts WHERE id = ? AND location_id = ? AND kind = 'template'`, String(step.template_id ?? ''), loc);
      if (!tpl) throw new Error('Vertragsvorlage nicht gefunden');
      const contact = getContact(app, loc, run.contact_id)!;
      const url = (c: any) => `${app.baseUrl()}/s/${c.public_token}`;
      const row = { id: newId(), location_id: loc, kind: 'contract', contact_id: contact.id, title: text(step.title || tpl.title, vars).slice(0, 200), content: render(tpl.content, vars), status: 'draft', public_token: token(24), created_at: now(), updated_at: now() };
      db.insert('contracts', row);
      const out: ActionOutcome = { result: `Vertrag „${row.title}“ angelegt`, vars: { contract_url: url(row), contract_id: row.id }, output: { id: row.id, url: url(row) } };
      if (step.send !== false) {
        db.update('contracts', row.id, { status: 'sent', sent_at: now(), updated_at: now() });
        const v = { contact: contactVars(contact), location: app.location(loc), contract: { title: row.title, url: url(row) } };
        const m = await sendToContact(app, loc, { contactId: contact.id, channel: step.channel === 'sms' ? 'sms' : 'email', subject: render('Bitte unterschreiben: {{contract.title}}', v), body: render('Hallo {{contact.first_name|}},\n\nhier ist der Vertrag „{{contract.title}}“ zum Lesen und Unterschreiben:\n{{contract.url}}\n\nViele Grüße\n{{location.name}}', v), source: 'Vertrag' });
        if (m.status === 'failed') throw new Error(m.error);
        logActivity(app, loc, contact.id, 'contract.sent', `Vertrag „${row.title}“ gesendet`);
        out.result += ' und gesendet';
      }
      return out;
    },
  });

  // --- community ----------------------------------------------------------------------------------
  const group = (loc: string, gid: unknown) => db.get<any>('SELECT * FROM community_groups WHERE id = ? AND location_id = ?', String(gid ?? ''), loc);
  add({
    meta: {
      type: 'community_join',
      label: 'In Community aufnehmen',
      category: 'content',
      icon: 'community',
      summary: 'Nimmt den Kontakt in eine Community-Gruppe auf.',
      doc: 'Der Kontakt wird Mitglied (Auslöser „Mitglied ist Gruppe beigetreten“). Ob er die Gruppe sehen darf, bestimmt der Zugang der Gruppe (Tag oder Kurs). Bei Gruppen mit „Beitritt über die Community-Seite“ entsteht eine kostenlose Mitgliedschaft in der gewählten Stufe (leer = erste aktive Stufe) samt Willkommens-Automation.',
      keywords: 'community gruppe mitglied aufnehmen stufe einladen',
      fields: [{ key: 'group_id', label: 'Gruppe', type: 'group', required: true }, { key: 'tier', label: 'Stufe (Name oder ID, nur bei Beitritt)', type: 'text', placeholder: 'leer = erste aktive Stufe' }],
      sample: { group_id: '', tier: '' },
    },
    run: (run, step) => {
      const g = group(run.location_id, step.group_id);
      if (!g) throw new Error('Community-Gruppe nicht gefunden');
      const contact = getContact(app, run.location_id, run.contact_id)!;
      // Groups that let people in by joining (page, tiers, payments) take a real membership.
      const kit = app.services.communityMembers;
      if (kit?.joinMode(g)) return { result: `${g.name}: ${kit.add(g, contact, String(step.tier ?? '').trim())}` };
      const joined = joinGroup(app, g, contact);
      return { result: joined ? `Aufgenommen in „${g.name}“` : `Schon Mitglied in „${g.name}“` };
    },
  });
  add({
    meta: {
      type: 'community_leave',
      label: 'Aus Community entfernen',
      category: 'content',
      icon: 'community',
      summary: 'Entfernt den Kontakt aus einer Community-Gruppe.',
      doc: 'Beiträge und Punkte bleiben erhalten; der Kontakt sieht die Gruppe nicht mehr, bis er erneut aufgenommen wird. Bei Gruppen mit Beitritt wird die Mitgliedschaft beendet (Auslöser „Mitglied hat die Community verlassen“).',
      keywords: 'community gruppe entfernen austritt',
      fields: [{ key: 'group_id', label: 'Gruppe', type: 'group', required: true }],
      sample: { group_id: '' },
    },
    run: (run, step) => {
      const g = group(run.location_id, step.group_id);
      if (!g) throw new Error('Community-Gruppe nicht gefunden');
      const kit = app.services.communityMembers;
      if (kit?.joinMode(g)) return { result: kit.remove(g, { id: run.contact_id }) };
      const r = db.run('DELETE FROM community_members WHERE group_id = ? AND contact_id = ? AND location_id = ?', g.id, run.contact_id, run.location_id);
      return { result: r.changes ? `Entfernt aus „${g.name}“` : `Nicht Mitglied in „${g.name}“` };
    },
  });

  // --- social draft -------------------------------------------------------------------------------
  add({
    meta: {
      type: 'social_draft',
      label: 'Social-Post-Entwurf (mit KI)',
      category: 'content',
      icon: 'social',
      summary: 'Legt einen Post-Entwurf im Social Planner an – Text selbst oder von der KI geschrieben.',
      doc: 'Mit „KI schreibt“ formuliert der KI-Assistent den Text aus deinem Prompt (z. B. „Danke-Post für die 5-Sterne-Bewertung von {{contact.first_name}}: {{event.comment}}“). Der Entwurf landet zur Freigabe in Postiz und wird nicht veröffentlicht. Braucht verbundene Kanäle im Social Planner; die KI zählt aufs Monatslimit.',
      keywords: 'social post entwurf draft instagram linkedin ki',
      fields: [
        { key: 'channels', label: 'Kanäle', type: 'social_channels' },
        { key: 'mode', label: 'Text', type: 'select', options: [['text', 'Selbst schreiben'], ['ai', 'KI schreibt']], default: 'text' },
        { key: 'body', label: 'Text', type: 'textarea', showIf: { field: 'mode', in: ['text'] } },
        { key: 'prompt', label: 'Prompt für die KI', type: 'textarea', showIf: { field: 'mode', in: ['ai'] } },
      ],
      sample: { mode: 'ai', prompt: 'Schreibe einen kurzen Danke-Post für diese Bewertung: {{event.comment}}' },
    },
    run: async (run, step, vars) => {
      if (!app.services.socialPost) throw new Error('Der Social Planner ist nicht verfügbar');
      let body = text(step.body, vars).trim();
      if (step.mode === 'ai') {
        if (!app.services.aiRun) throw new Error('Der KI-Assistent ist nicht verfügbar');
        const prompt = requireText(text(step.prompt, vars), 'Prompt');
        const r = await app.services.aiRun({ locationId: run.location_id, purpose: 'workflow', user: `Schreibe einen Social-Media-Beitrag auf Deutsch. Nur den fertigen Text, ohne Erklärungen.\n\n${prompt}`, maxTokens: 700, contactId: run.contact_id });
        body = String(r.text ?? '').trim();
      }
      if (!body) throw new Error('Kein Text für den Post');
      const post = await app.services.socialPost(run.location_id, { integrationIds: Array.isArray(step.channels) ? step.channels : [], content: body, type: 'draft', source: 'Workflow' });
      return { result: `Entwurf angelegt: ${preview(body, 60)}`, output: { id: post?.id, content: body } };
    },
  });

  return defs;
}
