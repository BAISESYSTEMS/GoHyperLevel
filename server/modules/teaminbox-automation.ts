import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { text as renderText, registerActions, registerTriggers, type ActionDef, type FieldDef, type TriggerMeta } from '../services/wfx-kit.js';
import type { ReportField, ReportSource } from '../services/report-engine.js';
import { contactJoin, lookupTable, userLookup } from '../services/report-sources.js';
import { getOrCreateConversation } from '../services/messaging.js';
import { autoAssign } from '../services/teaminbox-assign.js';
import { PRIORITY_LABEL, STATUS_LABEL, isStatus } from '../services/teaminbox-model.js';
import { addNote, getConv, setAssignee, setPriority, setStatus, settingsOf, type Who } from '../services/teaminbox-store.js';

/**
 * Team-Posteingang in the automations and in Berichte:
 * - triggers: conversation.assigned, conversation.status_changed, conversation.sla_breached (emitted by teaminbox-store / -engine);
 * - steps: assign the conversation, set its status (also snooze) and add an internal note;
 * - report sources: conversations per person and status, and the answers (response times, SLA rate, volume per person).
 */

const sample = {
  conversationId: 'v1',
  conversation: { id: 'v1', contact_name: 'Erika Muster', channel: 'email', status: 'open', priority: 'normal', assignee_id: 'u1', assignee_name: 'Anna', last_message: 'Haben Sie morgen Zeit?', url: 'https://example.com/app/conversations/v1' },
};

const USER: FieldDef = { key: 'assignee_id', label: 'Zugewiesen an', type: 'user', help: 'Leer = jede Person' };

export const INBOX_TRIGGERS: TriggerMeta[] = [
  {
    type: 'conversation.assigned',
    label: 'Konversation zugewiesen',
    category: 'messages',
    summary: 'Eine Konversation im Posteingang bekommt eine Bearbeiterin oder einen Bearbeiter – von Hand, per Regel oder reihum.',
    doc: 'Läuft bei jeder neuen Zuweisung (auch beim Aufheben: dann ist {{event.assigneeId}} leer). {{event.conversation.assignee_name}}, {{event.by}} (wer es getan hat) und {{event.via}} (user, rule, workflow …) stehen zur Verfügung. Der Kontakt der Konversation ist der Kontakt des Ablaufs.',
    fields: [USER],
    sample: { ...sample, assigneeId: 'u1', previousAssigneeId: null, teamId: null, by: 'Anna', via: 'user' },
    keywords: 'posteingang inbox zuweisen zugewiesen bearbeiter team konversation round robin',
  },
  {
    type: 'conversation.status_changed',
    label: 'Konversation: Status geändert',
    category: 'messages',
    summary: 'Eine Konversation wird erledigt, wartet auf den Kontakt oder wird wieder geöffnet – auch beim Zurückstellen.',
    doc: 'Läuft, wenn sich Status oder Zurückstellung ändern. {{event.status}} ist open, waiting oder closed, {{event.previous}} der alte Status, {{event.snoozedUntil}} die Zeit, bis zu der zurückgestellt wurde. Beispiel: Bei „Erledigt“ nach zwei Tagen eine Zufriedenheitsumfrage schicken. Nur nach Status filtern, um nicht bei jeder Änderung zu starten.',
    fields: [{ key: 'status', label: 'Neuer Status', type: 'select', options: [['', 'Jeder'], ...(Object.entries(STATUS_LABEL) as [string, string][])] }],
    sample: { ...sample, status: 'closed', previous: 'open', snoozedUntil: null, by: 'Anna', via: 'user', reason: '' },
    keywords: 'posteingang inbox status erledigt geschlossen wartet zurückgestellt snooze konversation',
  },
  {
    type: 'conversation.sla_breached',
    label: 'Antwortfrist im Posteingang überschritten',
    category: 'messages',
    summary: 'Die Antwort auf eine Nachricht ist überfällig (erste Antwort oder weitere Antwort, in Geschäftszeiten).',
    doc: 'Läuft einmal je überfälligem Zeitgeber. {{event.slaKind}} ist first (erste Antwort) oder next (weitere Antwort), {{event.dueAt}} die verpasste Frist. Typisch: der Chefin Bescheid geben, die Priorität anheben oder die Konversation einer anderen Person geben. Braucht eingeschaltete Antwortfristen unter Einstellungen → Team-Posteingang.',
    fields: [{ key: 'sla_kind', label: 'Art der Frist', type: 'select', options: [['', 'Beide'], ['first', 'Erste Antwort'], ['next', 'Weitere Antwort']] }],
    sample: { ...sample, slaKind: 'first', dueAt: '2026-11-05T15:00:00.000Z', assigneeId: 'u1' },
    keywords: 'posteingang inbox sla antwortfrist überfällig überschritten antwortzeit',
  },
];

type Filter = (c: Record<string, any>, d: Record<string, any>) => boolean;

/** The sub-account's person who hears about a workflow change (the step names the author "Workflow"). */
const workflow = (name = 'Workflow'): Who => ({ userId: null, name, via: 'workflow' });

const PRIORITY_OPTIONS = (Object.entries(PRIORITY_LABEL) as [string, string][]).map(([k, v]) => [k, v] as [string, string]);

const date = (key: string, label: string, sql: string): ReportField => ({ key, label, type: 'date', sql });
const flag = (key: string, label: string, sql: string, yes = 'Ja', no = 'Nein'): ReportField => ({ key, label, type: 'boolean', sql: `(CASE WHEN ${sql} THEN 1 ELSE 0 END)`, options: { 1: yes, 0: no } });
const minutesBetween = (from: string, to: string) => `((julianday(${to}) - julianday(${from})) * 1440)`;

const convContact = contactJoin('v.contact_id');
const respContact = contactJoin('r.contact_id');

const CONVERSATIONS: ReportSource = {
  key: 'inbox_conversations',
  label: 'Team-Posteingang: Konversationen',
  description: 'Konversationen mit Bearbeiter, Team, Status, Priorität, Antwortfrist und der Zeit bis zur ersten Antwort – für Volumen je Person.',
  area: 'conversations',
  from: 'conversations v',
  location: 'v.location_id',
  dateField: 'created_at',
  countLabel: 'Anzahl Konversationen',
  joins: convContact.joins,
  fields: [
    date('created_at', 'Begonnen am', 'v.created_at'),
    date('last_message_at', 'Letzte Nachricht', 'v.last_message_at'),
    date('first_response_at', 'Erste Antwort am', 'v.first_response_at'),
    date('closed_at', 'Erledigt am', 'v.closed_at'),
    { key: 'assignee', label: 'Bearbeiter', type: 'string', sql: 'v.assignee_id', lookup: userLookup, empty: 'Nicht zugewiesen' },
    { key: 'team', label: 'Team', type: 'string', sql: 'v.team_id', lookup: lookupTable('helpdesk_teams', 'name'), empty: 'Ohne Team' },
    { key: 'status', label: 'Status', type: 'enum', sql: 'v.inbox_status', options: STATUS_LABEL },
    { key: 'priority', label: 'Priorität', type: 'enum', sql: 'v.priority', options: PRIORITY_LABEL },
    flag('sla_breached', 'Antwortfrist überschritten', `v.sla_state = 'breached'`, 'Überschritten', 'In Ordnung'),
    flag('awaiting', 'Wartet auf unsere Antwort', 'v.awaiting_since IS NOT NULL', 'Wartet', 'Beantwortet'),
    flag('snoozed', 'Zurückgestellt', `v.snoozed_until IS NOT NULL AND v.snoozed_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`),
    { key: 'first_response_min', label: 'Bis zur ersten Antwort (Minuten)', type: 'number', sql: `(CASE WHEN v.first_response_at IS NOT NULL THEN ${minutesBetween('v.created_at', 'v.first_response_at')} END)`, format: 'minutes' },
    ...convContact.fields,
  ],
  calcs: [{ key: 'open_rate', label: 'Anteil offen', sql: `100.0 * SUM(CASE WHEN v.inbox_status != 'closed' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)`, format: 'percent' }],
};

const RESPONSE_MIN = `COALESCE(r.business_min, ${minutesBetween('r.inbound_at', 'r.responded_at')})`;
const RESPONSES: ReportSource = {
  key: 'inbox_responses',
  label: 'Team-Posteingang: Antworten',
  description: 'Jede beantwortete Nachricht mit Antwortzeit (in Geschäftszeiten), Person, Frist und SLA – für Antwortzeiten, Volumen je Person und SLA-Quote.',
  area: 'conversations',
  from: 'inbox_response_log r',
  location: 'r.location_id',
  dateField: 'responded_at',
  countLabel: 'Anzahl Antworten',
  joins: respContact.joins,
  fields: [
    date('responded_at', 'Beantwortet am', 'r.responded_at'),
    date('inbound_at', 'Nachricht eingegangen am', 'r.inbound_at'),
    { key: 'kind', label: 'Art', type: 'enum', sql: 'r.kind', options: { first: 'Erste Antwort', next: 'Weitere Antwort' } },
    { key: 'responder', label: 'Beantwortet von', type: 'string', sql: 'r.responder_id', lookup: userLookup, empty: 'Unbekannt' },
    { key: 'assignee', label: 'Bearbeiter', type: 'string', sql: 'r.assignee_id', lookup: userLookup, empty: 'Nicht zugewiesen' },
    { key: 'outcome', label: 'Ergebnis', type: 'enum', sql: 'r.outcome', options: { replied: 'Beantwortet', closed: 'Ohne Antwort erledigt', auto_closed: 'Automatisch geschlossen' } },
    flag('breached', 'Frist verpasst', 'r.due_at IS NOT NULL AND r.breached = 1', 'Verpasst', 'Eingehalten'),
    { key: 'response_min', label: 'Antwortzeit (Minuten)', type: 'number', sql: RESPONSE_MIN, format: 'minutes' },
    ...respContact.fields,
  ],
  calcs: [
    { key: 'avg_response', label: 'Ø Antwortzeit', sql: `AVG(${RESPONSE_MIN})`, format: 'minutes' },
    { key: 'max_response', label: 'Längste Antwortzeit', sql: `MAX(${RESPONSE_MIN})`, format: 'minutes' },
    { key: 'sla_rate', label: 'SLA-Quote', sql: `100.0 * SUM(CASE WHEN r.due_at IS NOT NULL AND r.breached = 0 THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN r.due_at IS NOT NULL THEN 1 ELSE 0 END), 0)`, format: 'percent' },
  ],
};

export const INBOX_REPORT_SOURCES: ReportSource[] = [CONVERSATIONS, RESPONSES];

const same =
  (key: string, ...paths: string[]): Filter =>
  (c, d) =>
    !c[key] || paths.some((p) => String(p.split('.').reduce((o: any, k) => o?.[k], d) ?? '') === String(c[key]));

export const teamInboxAutomationModule: Module = {
  name: 'teaminbox-automation',
  register(app) {
    registerTriggers(app, INBOX_TRIGGERS);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'conversation.assigned': same('assignee_id', 'assigneeId'),
      'conversation.status_changed': same('status', 'status'),
      'conversation.sla_breached': same('sla_kind', 'slaKind'),
    };
    app.services.reportSources = [...(app.services.reportSources ?? []), ...INBOX_REPORT_SOURCES];

    /** The conversation of the run's contact (created when the contact has none yet), and the steps' author. */
    const convOf = (run: { location_id: string; contact_id: string }) => {
      if (!run.contact_id) throw new Error('Dieser Schritt braucht einen Kontakt');
      const cid = getOrCreateConversation(app, run.location_id, run.contact_id);
      return getConv(app, run.location_id, cid);
    };
    const fail = (e: unknown): never => {
      if (e instanceof HttpError) throw new Error(e.message);
      throw e;
    };

    const assign: ActionDef = {
      meta: {
        type: 'inbox_assign',
        label: 'Konversation zuweisen',
        category: 'messaging',
        icon: 'user',
        summary: 'Weist die Konversation des Kontakts einer Person zu, reihum nach den Regeln des Posteingangs – oder hebt die Zuweisung auf.',
        doc: 'Bestimmte Person: genau diese Person. Reihum: wie bei einer neuen Nachricht (Zuständige am Kontakt, Regeln, Reihum oder geringste Auslastung – Abwesende werden übersprungen); braucht eine automatische Zuweisung unter Einstellungen → Team-Posteingang. Die Person wird nicht extra benachrichtigt, das kann ein Schritt „Interne Benachrichtigung“ tun. Danach steht {{var.inbox_assignee}} (Name) zur Verfügung.',
        fields: [
          { key: 'mode', label: 'Wie', type: 'select', options: [['user', 'Bestimmte Person'], ['auto', 'Reihum nach den Regeln des Posteingangs'], ['none', 'Zuweisung aufheben']], default: 'user' },
          { ...USER, label: 'Person', help: undefined, showIf: { field: 'mode', in: ['user'] } },
        ],
        provides: ['var.inbox_assignee'],
        keywords: 'posteingang inbox zuweisen bearbeiter round robin reihum konversation',
        needs: 'Die Person braucht Zugriff auf die Konversationen des Sub-Accounts',
        sample: { mode: 'auto' },
      },
      run: (run, step) => {
        try {
          const conv = convOf(run);
          const who = workflow();
          let next = conv;
          if (step.mode === 'none') next = setAssignee(app, who, conv, { userId: null, teamId: null, quiet: true });
          else if (step.mode === 'auto') {
            const s = settingsOf(app, run.location_id);
            if (s.assignment.mode === 'manual') throw new Error('Die automatische Zuweisung ist ausgeschaltet (Einstellungen → Team-Posteingang)');
            next = autoAssign(app, conv.id, run.location_id, s, { ...who, via: 'workflow' });
          } else {
            const uid = String(step.assignee_id ?? '').trim();
            if (!uid) throw new Error('Bitte eine Person wählen');
            next = setAssignee(app, who, conv, { userId: uid, quiet: true });
          }
          const name = next.assignee_id ? (app.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', next.assignee_id)?.name ?? '') : '';
          return { result: next.assignee_id ? `Zugewiesen an ${name}` : 'Niemand zugewiesen', vars: { inbox_assignee: name } };
        } catch (e) {
          return fail(e);
        }
      },
    };

    const status: ActionDef = {
      meta: {
        type: 'inbox_set_status',
        label: 'Konversation: Status setzen',
        category: 'messaging',
        icon: 'flag',
        summary: 'Setzt die Konversation des Kontakts auf offen, wartet auf Kontakt oder erledigt – oder stellt sie zurück.',
        doc: 'Beim Zurückstellen verschwindet die Konversation aus den Listen und kommt nach der gewählten Zeit wieder (eine neue Nachricht des Kontakts holt sie sofort zurück). „Erledigt“ beendet auch die laufende Antwortfrist. Zusätzlich kann die Priorität geändert werden.',
        fields: [
          { key: 'status', label: 'Status', type: 'select', options: [...(Object.entries(STATUS_LABEL) as [string, string][]), ['snooze', 'Zurückstellen']], default: 'closed' },
          { key: 'snooze_hours', label: 'Zurückstellen für (Stunden)', type: 'number', default: 24, showIf: { field: 'status', in: ['snooze'] } },
          { key: 'priority', label: 'Priorität setzen', type: 'select', options: [['', 'Nicht ändern'], ...PRIORITY_OPTIONS], default: '' },
        ],
        keywords: 'posteingang inbox status erledigt schließen warten zurückstellen snooze priorität konversation',
        sample: { status: 'closed' },
      },
      run: (run, step) => {
        try {
          let conv = convOf(run);
          const who = workflow();
          const st = String(step.status ?? 'closed');
          if (st === 'snooze') {
            const hours = Math.min(24 * 365, Math.max(1, Number(step.snooze_hours) || 24));
            conv = setStatus(app, who, conv, { snoozeUntil: new Date(Date.now() + hours * 3600_000).toISOString() });
          } else if (isStatus(st)) conv = setStatus(app, who, conv, { status: st, snoozeUntil: null });
          else throw new Error('Unbekannter Status');
          if (step.priority) conv = setPriority(app, who, conv, step.priority);
          return { result: st === 'snooze' ? `Zurückgestellt bis ${conv.snoozed_until}` : `Status: ${STATUS_LABEL[conv.inbox_status]}` };
        } catch (e) {
          return fail(e);
        }
      },
    };
    const note: ActionDef = {
      meta: {
        type: 'inbox_note',
        label: 'Interne Notiz an Konversation',
        category: 'messaging',
        icon: 'note',
        summary: 'Schreibt eine interne Notiz in die Konversation des Kontakts – nur für das Team sichtbar, nie an den Kontakt gesendet.',
        doc: 'Der Text darf Platzhalter enthalten. Mit @Vorname oder @Vor- und Nachname erwähnst du Kolleginnen und Kollegen: Sie werden in der App, per Push und – wenn eingeschaltet – per E-Mail benachrichtigt. Die Notiz steht im Posteingang farbig abgesetzt als „Interne Notiz“.',
        fields: [{ key: 'body', label: 'Notiz', type: 'textarea', required: true, placeholder: '@Anna bitte nachfassen: {{contact.first_name}} hat nach dem Angebot gefragt' }],
        keywords: 'posteingang inbox interne notiz erwähnung mention team kommentar konversation',
        sample: { body: '@Anna bitte nachfassen' },
      },
      run: (run, step, vars) => {
        try {
          const conv = convOf(run);
          const body = renderText(step.body, vars).trim();
          if (!body) throw new Error('Die Notiz ist leer');
          const r = addNote(app, workflow(), conv, body);
          return { result: `Notiz gespeichert${r.mentioned.length ? ` (${r.mentioned.length} erwähnt)` : ''}` };
        } catch (e) {
          return fail(e);
        }
      },
    };
    registerActions(app, [assign, status, note]);
  },
};
