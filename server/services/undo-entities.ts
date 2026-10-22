import type { App } from '../core/app.js';
import type { Row } from '../core/db.js';
import type { Ctx } from '../core/http.js';
import type { Snapshot } from './undo-core.js';
import type { Journal } from './undo-journal.js';
import { registerVersionedEntities } from './undo-versioned.js';
import { clip, tableEntity, type FieldSpec, type PartSpec } from './undo-table.js';

/**
 * What the journal knows about the main records (docs/undo.md): contacts, companies, tasks (core and
 * planner), deals and pipelines, notes, appointments, conversations, tickets, products, invoice drafts,
 * forms, funnels, tags. Each is a table entity (row + parts + what a delete takes along) plus the routes
 * that change it. Workflows, wiki and canvas use their own version histories (undo-versioned.ts).
 */

const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : ((v as T) ?? fallback);
  } catch {
    return fallback;
  }
};
const fullName = (c: Row | undefined) => (c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Unbekannt' : '');
const lookup = (app: App, sql: string, id: unknown): string => (id ? String(app.db.get<{ n: string }>(sql, id as string)?.n ?? '') || '–' : '–');
const userName = (app: App) => (v: unknown) => lookup(app, 'SELECT name AS n FROM users WHERE id = ?', v);
const contactNameOf = (app: App) => (v: unknown) => (v ? fullName(app.db.get('SELECT first_name, last_name, email, phone FROM contacts WHERE id = ?', v as string)) || '–' : '–');
const count = (what: string) => (v: unknown) => {
  const l = json<unknown[]>(v, []);
  return Array.isArray(l) ? `${l.length} ${what}` : '–';
};
const F = (label: string, fmt?: FieldSpec['fmt']): FieldSpec => ({ label, fmt });

/** Automations that listen for this kind of change and may have sent something already (e-mail, SMS) – that stays sent. */
function automationNotice(app: App, locationId: string, triggers: string[]): string | undefined {
  const rows = app.db.all<{ name: string }>(
    `SELECT name FROM workflows WHERE location_id = ? AND status = 'active' AND json_extract(trigger, '$.type') IN (${triggers.map(() => '?').join(',')}) LIMIT 2`,
    locationId,
    ...triggers,
  );
  if (!rows.length) return undefined;
  return `Die Automation „${clip(rows[0].name, 40)}“${rows.length > 1 ? ' und weitere' : ''} kann darauf reagiert haben (z. B. E-Mail oder SMS) – bereits Gesendetes lässt sich nicht zurückholen; nur die Daten werden zurückgesetzt.`;
}

/** The ids the body lists (bulk routes). */
const bodyIds = (ctx: Ctx): { id: string }[] => (Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String).filter(Boolean).map((id: string) => ({ id })) : []);

export function registerUndoEntities(app: App) {
  const undo = app.services.undo as Journal | undefined;
  if (!undo) return;
  const { db } = app;
  const named = (name: string, entity: ReturnType<typeof tableEntity>) => undo.register(name, entity);

  // --- tasks (the core list and the project planner share the table) -------------------------------------------------
  const PRIORITIES = ['Keine', 'Niedrig', 'Normal', 'Hoch', 'Dringend'];
  const spawnedBy = (taskId: string): string[] =>
    db
      .all<{ data: string }>(`SELECT data FROM pm_activity WHERE task_id = ? AND kind = 'recurred' ORDER BY id DESC LIMIT 5`, taskId)
      .map((r) => String(json<{ next?: string }>(r.data, {}).next ?? ''))
      .filter(Boolean);
  const hasPlanner = !!db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'pm_assignees'`);
  named(
    'task',
    tableEntity(app, {
      noun: 'Aufgabe',
      plural: 'Aufgaben',
      area: 'contacts',
      table: 'tasks',
      title: (r) => String(r.title),
      volatile: ['updated_at'],
      fields: {
        title: F('Titel'),
        description: F('Beschreibung'),
        done: F('Erledigt', 'bool'),
        due_at: F('Fällig am', 'date'),
        start_at: F('Start', 'date'),
        assigned_to: F('Zuständig', userName(app)),
        status_id: F('Status', (v) => lookup(app, 'SELECT name AS n FROM pm_statuses WHERE id = ?', v)),
        priority: F('Priorität', (v) => PRIORITIES[Number(v)] ?? '–'),
        project_id: F('Projekt', (v) => lookup(app, 'SELECT name AS n FROM pm_projects WHERE id = ?', v)),
        contact_id: F('Kontakt', contactNameOf(app)),
        tags: F('Tags', 'tags'),
        estimate_minutes: F('Schätzung (Min.)'),
      },
      parts: (_a, row) =>
        hasPlanner
          ? [
              { name: 'assignees', table: 'pm_assignees', pk: ['task_id', 'user_id'], mode: 'replace', where: { sql: 'task_id = ?', params: [row.id] } },
              { name: 'watchers', table: 'pm_watchers', pk: ['task_id', 'user_id'], mode: 'replace', where: { sql: 'task_id = ?', params: [row.id] } },
            ]
          : [],
      extra: (_a, row) => (row.recurred_at ? { spawned: spawnedBy(String(row.id)) } : undefined),
      verb: (b, a) => {
        if (!a) return 'gelöscht';
        if (b && !b.row.done && a.row.done) return 'erledigt';
        if (b && b.row.done && !a.row.done) return 'wieder geöffnet';
        if (b && b.row.status_id !== a.row.status_id && a.row.status_id) return `→ ${lookup(app, 'SELECT name AS n FROM pm_statuses WHERE id = ?', a.row.status_id)}`;
        return undefined;
      },
      // A recurring task that was completed spawned its next occurrence: take that one back as long as nobody worked on it.
      onRestore: (_a, target, current) => {
        if (!target || !current) return;
        const before = new Set(((target.extra?.spawned as string[] | undefined) ?? []));
        for (const sid of (current.extra?.spawned as string[] | undefined) ?? []) if (!before.has(sid)) db.run('DELETE FROM tasks WHERE id = ? AND location_id = ? AND done = 0', sid, current.row.location_id);
      },
      // Todoist: the change is pushed like any other local change; what comes back from Todoist is never journaled, so nothing loops.
      afterRestore: (ctx, target, current) => {
        const taskId = (target ?? current)?.id;
        if (!taskId) return;
        try {
          if (db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'todoist_links'`)) db.run('UPDATE todoist_links SET local_changed_at = ? WHERE task_id = ?', new Date().toISOString(), taskId);
          const sync = app.services.todoistSync as ((mode: string) => Promise<unknown>) | undefined;
          if (sync && ctx.locationId) void Promise.resolve(sync('push')).catch(() => undefined);
        } catch {
          /* no Todoist module */
        }
      },
    }),
  );
  const taskAction = (b: Snapshot | null, a: Snapshot | null) => (!a ? 'delete' : b && b.row.done !== a.row.done ? 'status' : 'update');
  const taskNotice = (b: Snapshot | null, a: Snapshot | null, ctx: Ctx) => {
    if (b && a && !b.row.done && a.row.done) return automationNotice(app, ctx.locationId, ['task.completed']);
    if (!a && b?.kids?.pm_attachments?.some((r) => r.file)) return 'Hochgeladene Dateien werden beim Löschen entfernt – nur der Anhang-Eintrag kommt zurück.';
    return undefined;
  };
  for (const pattern of ['/api/tasks/:id', '/api/pm/tasks/:id']) {
    undo.track({ method: 'PATCH', pattern, entity: 'task', action: taskAction, notice: taskNotice });
    undo.track({ method: 'DELETE', pattern, entity: 'task', notice: taskNotice });
  }
  undo.track({ method: 'PATCH', pattern: '/api/pm/tasks/:id/dates', entity: 'task', action: 'move' });
  undo.track({ method: 'POST', pattern: '/api/pm/tasks/:id/move', entity: 'task', action: 'move' });
  undo.track({
    method: 'POST',
    pattern: '/api/pm/tasks/bulk',
    entity: 'task',
    targets: bodyIds,
    deep: (ctx) => ctx.body?.action === 'delete',
    action: (b, a) => (!a ? 'delete' : 'bulk'),
    notice: taskNotice,
  });

  // --- contacts ---------------------------------------------------------------------------------------------------------
  named(
    'contact',
    tableEntity(app, {
      noun: 'Kontakt',
      plural: 'Kontakte',
      area: 'contacts',
      table: 'contacts',
      title: (r) => fullName(r),
      volatile: ['updated_at', 'last_activity_at'],
      keep: ['updated_at', 'last_activity_at'],
      fields: {
        first_name: F('Vorname'),
        last_name: F('Nachname'),
        email: F('E-Mail'),
        phone: F('Telefon'),
        company: F('Firma'),
        address: F('Adresse'),
        city: F('Ort'),
        postal_code: F('PLZ'),
        country: F('Land'),
        website: F('Website'),
        source: F('Quelle'),
        tags: F('Tags', 'tags'),
        dnd: F('Nicht stören', 'bool'),
        assigned_to: F('Zuständig', userName(app)),
        custom: F('Eigene Felder', 'json'),
        date_of_birth: F('Geburtstag', 'date'),
      },
      verb: (b, a) => {
        if (!a) return 'gelöscht';
        if (!b) return undefined;
        const was = json<string[]>(b.row.tags, []);
        const is = json<string[]>(a.row.tags, []);
        const added = is.filter((t) => !was.includes(t));
        const removed = was.filter((t) => !is.includes(t));
        const onlyTags = Object.keys(a.row).every((k) => k === 'tags' || k === 'updated_at' || k === 'last_activity_at' || JSON.stringify(a.row[k]) === JSON.stringify(b.row[k]));
        if (onlyTags && (added.length || removed.length)) return [added.length ? `Tag „${clip(added.join(', '), 40)}“ hinzugefügt` : '', removed.length ? `Tag „${clip(removed.join(', '), 40)}“ entfernt` : ''].filter(Boolean).join(', ');
        return undefined;
      },
    }),
  );
  const tagNotice = (b: Snapshot | null, a: Snapshot | null, ctx: Ctx) => (b && a && JSON.stringify(b.row.tags) !== JSON.stringify(a.row.tags) ? automationNotice(app, ctx.locationId, ['contact.tag_added', 'contact.tag_removed']) : undefined);
  undo.track({ method: 'PATCH', pattern: '/api/contacts/:id', entity: 'contact', notice: tagNotice });
  undo.track({ method: 'DELETE', pattern: '/api/contacts/:id', entity: 'contact' });
  undo.track({ method: 'POST', pattern: '/api/contacts/:id/tags', entity: 'contact', action: 'tag', notice: tagNotice });
  undo.track({
    method: 'POST',
    pattern: '/api/contacts/bulk',
    entity: 'contact',
    targets: bodyIds,
    deep: (ctx) => ctx.body?.action === 'delete',
    action: (b, a) => (!a ? 'delete' : 'bulk'),
    notice: tagNotice,
    groupLabel: (ctx, rows) => {
      const n = rows.length;
      const tag = clip(ctx.body?.tag, 40);
      const what = ctx.body?.action === 'add_tag' ? `Tag „${tag}“ hinzugefügt` : ctx.body?.action === 'remove_tag' ? `Tag „${tag}“ entfernt` : ctx.body?.action === 'delete' ? 'gelöscht' : ctx.body?.action === 'dnd' ? 'Nicht-stören geändert' : 'geändert';
      return `${n} ${n === 1 ? 'Kontakt' : 'Kontakte'}: ${what}`;
    },
  });

  named(
    'note',
    tableEntity(app, {
      noun: 'Notiz',
      plural: 'Notizen',
      area: 'contacts',
      table: 'notes',
      title: (r) => clip(r.body, 50),
      fields: { body: F('Text') },
    }),
  );
  undo.track({ method: 'DELETE', pattern: '/api/notes/:id', entity: 'note' });

  // --- companies ---------------------------------------------------------------------------------------------------------------
  const companyParts = (_a: App, row: Row): PartSpec[] => [
    { name: 'associations', table: 'associations', pk: ['id'], mode: 'replace', where: { sql: `location_id = ? AND ((a_type = 'company' AND a_id = ?) OR (b_type = 'company' AND b_id = ?))`, params: [row.location_id, row.id, row.id] } },
    { name: 'notes', table: 'record_notes', pk: ['id'], mode: 'replace', where: { sql: `location_id = ? AND object_key = 'company' AND record_id = ?`, params: [row.location_id, row.id] } },
    { name: 'activities', table: 'record_activities', pk: ['id'], mode: 'replace', where: { sql: `location_id = ? AND object_key = 'company' AND record_id = ?`, params: [row.location_id, row.id] } },
  ];
  named(
    'company',
    tableEntity(app, {
      noun: 'Firma',
      plural: 'Firmen',
      area: 'contacts',
      table: 'companies',
      title: (r) => String(r.name),
      volatile: ['updated_at'],
      contactCol: null,
      parts: db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'associations'`) ? companyParts : undefined,
      fields: { name: F('Name'), domain: F('Domain'), industry: F('Branche'), size: F('Größe'), phone: F('Telefon'), website: F('Website'), address: F('Adresse'), city: F('Ort'), postal_code: F('PLZ'), country: F('Land'), owner_id: F('Verantwortlich', userName(app)), lifecycle_stage: F('Phase'), description: F('Beschreibung'), custom: F('Eigene Felder', 'json') },
    }),
  );
  undo.track({ method: 'PATCH', pattern: '/api/companies/:id', entity: 'company' });
  undo.track({ method: 'DELETE', pattern: '/api/companies/:id', entity: 'company' });
  undo.track({
    method: 'POST',
    pattern: '/api/companies/:id/merge',
    entity: 'company',
    targets: (ctx) => [{ id: ctx.params.id }, { id: String(ctx.body?.from_id ?? '') }],
    deep: true,
    action: (b, a) => (a ? 'merge' : 'delete'),
    groupLabel: (_ctx, rows) => `Firmen zusammengeführt: ${rows.map((r) => r.label.replace(/ (zusammengeführt|gelöscht)$/, '')).join(' + ')}`,
  });

  // --- deals and pipelines ------------------------------------------------------------------------------------------------------------
  const stageName = (pipelineId: unknown, stageId: unknown) => {
    const p = db.get<{ stages: string }>('SELECT stages FROM pipelines WHERE id = ?', pipelineId as string);
    return json<{ id: string; name: string }[]>(p?.stages, []).find((s) => s.id === stageId)?.name ?? '–';
  };
  const STATUS_TEXT: Record<string, string> = { open: 'offen', won: 'gewonnen', lost: 'verloren', abandoned: 'abgebrochen' };
  named(
    'deal',
    tableEntity(app, {
      noun: 'Deal',
      plural: 'Deals',
      area: 'opportunities',
      table: 'opportunities',
      title: (r) => String(r.name),
      // closed_at is set a moment later by the reports module's event listener.
      volatile: ['updated_at', 'closed_at'],
      keep: ['updated_at'],
      fields: {
        name: F('Name'),
        value: F('Wert', 'money'),
        status: F('Status', (v) => STATUS_TEXT[String(v)] ?? String(v)),
        stage_id: F('Stufe', (v, row) => stageName(row.pipeline_id, v)),
        pipeline_id: F('Pipeline', (v) => lookup(app, 'SELECT name AS n FROM pipelines WHERE id = ?', v)),
        assigned_to: F('Zuständig', userName(app)),
        source: F('Quelle'),
        expected_close_date: F('Erwarteter Abschluss'),
        lost_reason: F('Verlustgrund'),
        currency: F('Währung'),
      },
      verb: (b, a) => {
        if (!a) return 'gelöscht';
        if (!b) return undefined;
        if (b.row.stage_id !== a.row.stage_id) return `→ Stufe „${stageName(a.row.pipeline_id, a.row.stage_id)}“`;
        if (b.row.status !== a.row.status) return a.row.status === 'won' ? 'als gewonnen markiert' : a.row.status === 'lost' ? 'als verloren markiert' : a.row.status === 'open' ? 'wieder geöffnet' : 'Status geändert';
        return undefined;
      },
    }),
  );
  const dealAction = (b: Snapshot | null, a: Snapshot | null) => (!a ? 'delete' : b && b.row.stage_id !== a.row.stage_id ? 'move' : b && b.row.status !== a.row.status ? 'status' : 'update');
  const dealNotice = (b: Snapshot | null, a: Snapshot | null, ctx: Ctx) => {
    if (!b || !a) return undefined;
    const t = b.row.stage_id !== a.row.stage_id ? ['opportunity.stage_changed'] : b.row.status !== a.row.status ? ['opportunity.status_changed'] : [];
    return t.length ? automationNotice(app, ctx.locationId, t) : undefined;
  };
  undo.track({ method: 'PATCH', pattern: '/api/opportunities/:id', entity: 'deal', action: dealAction, notice: dealNotice });
  undo.track({ method: 'DELETE', pattern: '/api/opportunities/:id', entity: 'deal' });

  named(
    'pipeline',
    tableEntity(app, {
      noun: 'Pipeline',
      plural: 'Pipelines',
      area: 'opportunities',
      table: 'pipelines',
      title: (r) => String(r.name),
      contactCol: null,
      // Removed stages move their deals to the first stage: remember where every deal was (only when the stages are edited).
      parts: (_a, row, ctx) => (ctx?.body?.stages !== undefined ? [{ name: 'stage_map', table: 'opportunities', pk: ['id'], cols: ['stage_id'], mode: 'patch', fp: false, where: { sql: 'pipeline_id = ?', params: [row.id] } }] : []),
      fields: { name: F('Name'), stages: F('Stufen', (v) => json<{ name: string }[]>(v, []).map((s) => s.name).join(' → ')) },
    }),
  );
  undo.track({ method: 'PATCH', pattern: '/api/pipelines/:id', entity: 'pipeline' });
  undo.track({ method: 'DELETE', pattern: '/api/pipelines/:id', entity: 'pipeline' });

  // --- appointments ------------------------------------------------------------------------------------------------------------------------
  const APPT_STATUS: Record<string, string> = { confirmed: 'bestätigt', cancelled: 'abgesagt', showed: 'erschienen', noshow: 'nicht erschienen', blocked: 'blockiert' };
  named(
    'appointment',
    tableEntity(app, {
      noun: 'Termin',
      plural: 'Termine',
      area: 'calendars',
      table: 'appointments',
      volatile: ['reminder_sent', 'reminders_sent'],
      keep: ['reminder_sent', 'reminders_sent'],
      title: (r) => String(r.title || fullName(db.get('SELECT first_name, last_name, email FROM contacts WHERE id = ?', r.contact_id as string)) || 'Termin'),
      fields: { title: F('Titel'), start_at: F('Beginn', 'datetime'), end_at: F('Ende', 'datetime'), status: F('Status', (v) => APPT_STATUS[String(v)] ?? String(v)), notes: F('Notizen') },
      verb: (b, a) => {
        if (!a) return 'gelöscht';
        if (!b) return undefined;
        if (b.row.status !== a.row.status) return a.row.status === 'cancelled' ? 'abgesagt' : a.row.status === 'showed' ? 'als erschienen markiert' : a.row.status === 'noshow' ? 'als nicht erschienen markiert' : a.row.status === 'confirmed' ? 'bestätigt' : 'Status geändert';
        if (b.row.start_at !== a.row.start_at) return 'verschoben';
        return undefined;
      },
    }),
  );
  undo.track({
    method: 'PATCH',
    pattern: '/api/appointments/:id',
    entity: 'appointment',
    action: (b, a) => (b && a && b.row.status !== a.row.status ? 'status' : b && a && b.row.start_at !== a.row.start_at ? 'move' : 'update'),
    notice: (b, a) => (b && a && a.row.status === 'cancelled' && b.row.status !== 'cancelled' ? `Absage-Benachrichtigungen (E-Mail oder SMS) wurden eventuell schon gesendet – nur der Termin wird wiederhergestellt.` : undefined),
  });
  undo.track({ method: 'DELETE', pattern: '/api/appointments/:id', entity: 'appointment', notice: 'Benachrichtigungen an den Kontakt, die schon unterwegs sind, lassen sich nicht zurückholen.' });

  // --- conversations and drafts ----------------------------------------------------------------------------------------------------------------
  named(
    'conversation',
    tableEntity(app, {
      noun: 'Konversation',
      plural: 'Konversationen',
      area: 'conversations',
      table: 'conversations',
      title: (r) => contactNameOf(app)(r.contact_id),
      volatile: ['last_message', 'last_message_at'],
      keep: ['last_message', 'last_message_at'],
      fields: { starred: F('Markiert', 'bool'), unread: F('Ungelesen', 'bool') },
      verb: (b, a) => (b && a && b.row.starred !== a.row.starred ? (a.row.starred ? 'markiert' : 'Markierung entfernt') : b && a && !b.row.unread && a.row.unread ? 'als ungelesen markiert' : undefined),
    }),
  );
  // Marking as read (the common case) is not worth an entry; stars and "unread" are.
  undo.track({ method: 'PATCH', pattern: '/api/conversations/:id', entity: 'conversation', when: (b, a) => !!b && !!a && (b.row.starred !== a.row.starred || (!b.row.unread && !!a.row.unread)) });
  named(
    'message',
    tableEntity(app, {
      noun: 'Entwurf',
      plural: 'Entwürfe',
      area: 'conversations',
      table: 'messages',
      title: (r) => String(r.subject || clip(r.body, 40) || 'Nachricht'),
      fields: { subject: F('Betreff'), body: F('Text') },
    }),
  );
  // Only drafts can be deleted (the route refuses everything sent), so there is nothing sent to take back.
  undo.track({ method: 'DELETE', pattern: '/api/messages/:id', entity: 'message', when: (b) => !!b && b.row.status === 'draft' });

  // --- tickets -----------------------------------------------------------------------------------------------------------------------------------------
  named(
    'ticket',
    tableEntity(app, {
      noun: 'Ticket',
      plural: 'Tickets',
      area: 'helpdesk',
      table: 'tickets',
      title: (r) => `#${r.number} ${clip(r.subject, 50)}`,
      volatile: ['updated_at', 'last_agent_at', 'last_customer_at', 'sla_first_state', 'sla_resolution_state', 'sla_paused_at', 'first_response_warn_at', 'resolution_warn_at', 'csat_due_at'],
      keep: ['updated_at', 'last_agent_at', 'last_customer_at', 'sla_first_state', 'sla_resolution_state', 'sla_paused_at', 'first_response_warn_at', 'resolution_warn_at', 'csat_due_at', 'csat_sent_at', 'csat_score', 'csat_comment', 'csat_at'],
      fields: { subject: F('Betreff'), status_kind: F('Status'), priority: F('Priorität'), category: F('Kategorie'), owner_id: F('Bearbeiter', userName(app)), due_at: F('Fällig', 'date'), tags: F('Tags', 'tags') },
      verb: (b, a) => (!a ? 'gelöscht' : b && b.row.status_kind !== a.row.status_kind ? (a.row.status_kind === 'closed' ? 'geschlossen' : a.row.status_kind === 'resolved' ? 'als gelöst markiert' : 'Status geändert') : undefined),
    }),
  );
  undo.track({ method: 'PATCH', pattern: '/api/tickets/:id', entity: 'ticket', action: (b, a) => (b && a && b.row.status_kind !== a.row.status_kind ? 'status' : 'update') });
  undo.track({ method: 'DELETE', pattern: '/api/tickets/:id', entity: 'ticket' });
  undo.track({ method: 'POST', pattern: '/api/tickets/bulk', entity: 'ticket', targets: bodyIds, action: (b, a) => (!a ? 'delete' : 'bulk') });

  // --- products, invoice drafts, forms, funnels, tags ----------------------------------------------------------------------------------------------------
  named(
    'product',
    tableEntity(app, {
      noun: 'Produkt',
      plural: 'Produkte',
      area: 'payments',
      table: 'products',
      title: (r) => String(r.name),
      contactCol: null,
      fields: { name: F('Name'), description: F('Beschreibung'), price_cents: F('Preis', 'money'), tax_rate: F('Steuersatz (%)'), active: F('Aktiv', 'bool'), payment_link: F('Zahlungslink') },
    }),
  );
  undo.track({ method: 'PATCH', pattern: '/api/products/:id', entity: 'product' });
  undo.track({ method: 'DELETE', pattern: '/api/products/:id', entity: 'product' });

  named(
    'invoice',
    tableEntity(app, {
      noun: 'Rechnungsentwurf',
      plural: 'Rechnungsentwürfe',
      area: 'payments',
      table: 'invoices',
      title: (r) => String(r.title || r.number || 'Entwurf'),
      volatile: ['updated_at'],
      fields: { title: F('Titel'), items: F('Positionen', count('Positionen')), total_cents: F('Summe', 'money'), notes: F('Notizen'), due_at: F('Fällig am', 'date'), contact_id: F('Kontakt', contactNameOf(app)), payment_link: F('Zahlungslink') },
    }),
  );
  // Drafts only: once an invoice is sent, paid or void it is a record other systems (and the tax office) may have seen.
  const draft = (b: Snapshot | null, a: Snapshot | null) => !!b && b.row.status === 'draft' && (!a || a.row.status === 'draft');
  undo.track({ method: 'PATCH', pattern: '/api/invoices/:id', entity: 'invoice', when: draft });
  undo.track({ method: 'DELETE', pattern: '/api/invoices/:id', entity: 'invoice', when: draft });

  named(
    'form',
    tableEntity(app, {
      noun: 'Formular',
      plural: 'Formulare',
      area: 'forms',
      table: 'forms',
      title: (r) => String(r.name),
      contactCol: null,
      volatile: ['updated_at'],
      fields: { name: F('Name'), fields: F('Felder', count('Felder')), settings: F('Einstellungen', 'json') },
    }),
  );
  undo.track({ method: 'PATCH', pattern: '/api/forms/:id', entity: 'form' });
  undo.track({ method: 'DELETE', pattern: '/api/forms/:id', entity: 'form' });

  named(
    'funnel',
    tableEntity(app, {
      noun: 'Funnel',
      plural: 'Funnels',
      area: 'funnels',
      table: 'funnels',
      title: (r) => String(r.name),
      contactCol: null,
      volatile: ['updated_at'],
      fields: { name: F('Name'), slug: F('Adresse'), domain: F('Domain'), settings: F('Einstellungen', 'json') },
    }),
  );
  named(
    'funnel_page',
    tableEntity(app, {
      noun: 'Seite',
      plural: 'Seiten',
      area: 'funnels',
      table: 'funnel_pages',
      title: (r) => String(r.name),
      contactCol: null,
      volatile: ['updated_at', 'views'],
      fields: { name: F('Name'), slug: F('Adresse'), blocks: F('Inhalt', count('Blöcke')), seo: F('SEO', 'json') },
    }),
  );
  undo.track({ method: 'PATCH', pattern: '/api/funnels/:id', entity: 'funnel' });
  undo.track({ method: 'DELETE', pattern: '/api/funnels/:id', entity: 'funnel', notice: 'Veröffentlichte Seiten waren in der Zwischenzeit nicht erreichbar.' });
  undo.track({ method: 'PATCH', pattern: '/api/funnel-pages/:id', entity: 'funnel_page', coalesceMs: 10 * 60_000 });
  undo.track({ method: 'DELETE', pattern: '/api/funnel-pages/:id', entity: 'funnel_page' });

  // A deleted tag is also taken off every contact: remember who had it.
  named(
    'tag',
    tableEntity(app, {
      noun: 'Tag',
      plural: 'Tags',
      area: 'settings',
      table: 'tags',
      title: (r) => String(r.name),
      contactCol: null,
      fields: { name: F('Name') },
      parts: (_a, row) => [{ name: 'contacts', table: 'contacts', pk: ['id'], cols: ['tags'], mode: 'patch', fp: false, where: { sql: `location_id = ? AND EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`, params: [row.location_id, row.name] } }],
    }),
  );
  undo.track({ method: 'DELETE', pattern: '/api/tags/:id', entity: 'tag' });

  // Workflows, wiki pages and canvas boards: their own version histories.
  registerVersionedEntities(app, undo);
}
