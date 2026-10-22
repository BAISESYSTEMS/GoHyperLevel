import { smartListById } from '../services/smart-lists.js';
import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, num, str, type Ctx } from '../core/http.js';
import { isValidTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { findContacts, getContact } from '../services/contacts.js';
import { contactScopeClause, maskContactFields, mustConfigure, canConfigure, resolve } from '../services/record-access.js';
import { DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT, enroll, getSequence, meetingBooked, previewStep, replyReceived, senderMailbox, sequenceStats, stopContact, stopEnrollment, taskDone, runDue, type EnrollRow, type SeqRow } from '../services/sequence-engine.js';
import { DEFAULT_SETTINGS, MAX_STEPS, SequenceError, STEP_LABEL, STEP_TYPES, STOP_LABEL, cleanSettings, cleanSteps } from '../services/sequence-model.js';
import { registerActions, registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import { peopleOf } from '../services/team-people.js';
import type { Tool } from './mcp.js';

/**
 * Sequenzen (docs/sales.md): multi-step outreach from a person's own mailbox – e-mails, tasks, calls, LinkedIn – with delays inside
 * business hours, personal fields, A/B variants, a daily limit per person, and an end as soon as the person answers, books a
 * meeting, a deal moves or they unsubscribe. The logic is in services/sequence-model.ts (pure) and sequence-engine.ts.
 */

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SequenceError) throw bad(e.message);
    throw e;
  }
};

const TOKENS = ['{{contact.first_name}}', '{{contact.last_name}}', '{{contact.company}}', '{{contact.custom.<feld>}}', '{{user.first_name}}', '{{user.name}}', '{{sender.email}}', '{{deal.name}}', '{{deal.value}}', '{{location.name}}'];

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects); mit einem Sub-Account-Schlüssel weglassen' } };
const TOOLS: Tool[] = [
  {
    name: 'ghl_sequence_list',
    title: 'Vertriebs-Sequenzen',
    description: 'Listet die Sequenzen eines Sub-Accounts (Name, Status, Modus, Schritte) mit Zahlen: aufgenommen, aktiv, Antworten, Termine. Nur lesen.',
    inputSchema: { type: 'object', properties: { ...LOC }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', '/api/sequences', { location: a.location_id }),
  },
  {
    name: 'ghl_sequence_stats',
    title: 'Sequenz-Auswertung',
    description: 'Zahlen einer Sequenz: aufgenommen/aktiv/beendet (und warum), gesendet, geöffnet (nur echte Personen), Antworten, Termine, je Schritt und je A/B-Variante. Nur lesen.',
    inputSchema: { type: 'object', properties: { ...LOC, sequence_id: { type: 'string' } }, required: ['sequence_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/sequences/${encodeURIComponent(a.sequence_id)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_sequence_enroll',
    title: 'Kontakte in eine Sequenz aufnehmen',
    description: 'Nimmt Kontakte in eine aktive Sequenz auf. Die E-Mails gehen später aus dem Postfach der Person user_id (Pflicht mit einem Schlüssel – sie braucht ein verbundenes Postfach), in deren Sendezeiten und mit Tageslimit. Kontakte ohne E-Mail, mit „Nicht stören“ oder (Modus Werbung) ohne Einwilligung werden übersprungen und genannt.',
    inputSchema: { type: 'object', properties: { ...LOC, sequence_id: { type: 'string' }, contact_ids: { type: 'array', items: { type: 'string' } }, user_id: { type: 'string', description: 'Absender (Person des Sub-Accounts)' }, deal_id: { type: 'string' } }, required: ['sequence_id', 'contact_ids'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', `/api/sequences/${encodeURIComponent(a.sequence_id)}/enroll`, { location: a.location_id, body: { contact_ids: a.contact_ids, user_id: a.user_id, deal_id: a.deal_id } }),
  },
];

const TRIGGERS: TriggerMeta[] = [
  { type: 'sequence.replied', label: 'Antwort auf eine Sequenz', category: 'sales', summary: 'Ein Kontakt antwortet auf eine Mail oder Nachricht einer Vertriebs-Sequenz (die Sequenz endet dann meist von selbst).', doc: '{{event.sequenceId}} und {{event.enrollmentId}} nennen die Sequenz. Typisch: dem Zuständigen eine Aufgabe „Antwort lesen“ geben oder den Deal weiterschieben.', fields: [], sample: { sequenceId: 's1', enrollmentId: 'e1' }, keywords: 'sequenz antwort reply vertrieb outreach' },
  { type: 'sequence.finished', label: 'Sequenz durchlaufen', category: 'sales', summary: 'Ein Kontakt hat alle Schritte einer Vertriebs-Sequenz bekommen, ohne zu antworten.', doc: '{{event.sequenceId}} nennt die Sequenz. Typisch: Kontakt in einen Pflege-Workflow schieben oder den Deal als „keine Rückmeldung“ markieren.', fields: [], sample: { sequenceId: 's1', enrollmentId: 'e1' }, keywords: 'sequenz durchlaufen fertig keine antwort vertrieb' },
  { type: 'sequence.stopped', label: 'Sequenz beendet', category: 'sales', summary: 'Eine Aufnahme in eine Sequenz endet vorzeitig (Antwort, Termin, Deal geändert, Abmeldung, Fehler …).', doc: '{{event.reason}} nennt den Grund: reply, meeting, stage_change, deal_closed, unsubscribed, consent, manual, send_failed, contact_removed oder paused_user.', fields: [], sample: { sequenceId: 's1', enrollmentId: 'e1', reason: 'reply' }, keywords: 'sequenz beendet gestoppt grund vertrieb' },
];

export const sequencesModule: Module = {
  name: 'sequences',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE sequences (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        mode TEXT NOT NULL DEFAULT 'marketing', legal_ack_by TEXT, legal_ack_at TEXT, owner_user_id TEXT,
        steps TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX sequences_loc ON sequences(location_id, status);
      CREATE TABLE sequence_enrollments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        user_id TEXT, deal_id TEXT, status TEXT NOT NULL DEFAULT 'active', stop_reason TEXT NOT NULL DEFAULT '',
        step_index INTEGER NOT NULL DEFAULT 0, next_at TEXT, task_id TEXT, variants TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'manuell', note TEXT NOT NULL DEFAULT '', last_message_id TEXT, failures INTEGER NOT NULL DEFAULT 0,
        enrolled_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE UNIQUE INDEX sequence_enroll_open ON sequence_enrollments(sequence_id, contact_id) WHERE status IN ('active', 'waiting');
      CREATE INDEX sequence_enroll_due ON sequence_enrollments(status, next_at);
      CREATE INDEX sequence_enroll_contact ON sequence_enrollments(location_id, contact_id, status);
      CREATE INDEX sequence_enroll_task ON sequence_enrollments(task_id) WHERE task_id IS NOT NULL;
      CREATE TABLE sequence_events (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        enrollment_id TEXT NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
        contact_id TEXT, user_id TEXT, step_id TEXT, variant_id TEXT, kind TEXT NOT NULL, message_id TEXT,
        detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
      );
      CREATE INDEX sequence_events_seq ON sequence_events(sequence_id, kind, at);
      CREATE INDEX sequence_events_enroll ON sequence_events(enrollment_id, kind);
      CREATE INDEX sequence_events_day ON sequence_events(location_id, user_id, kind, at);
      CREATE TABLE sequence_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        daily_limit INTEGER NOT NULL DEFAULT ${DEFAULT_DAILY_LIMIT}, user_limits TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, TRIGGERS);

    // --- the tick: what is due is sent / created -------------------------------------------------------------------
    app.onTick(async () => void (await runDue(app)));
    app.services.sequences = { runDue: (at?: Date, limit?: number) => runDue(app, at, limit), stopContact: (loc: string, cid: string, reason: any, o?: any) => stopContact(app, loc, cid, reason, o) };

    // --- what ends or moves an enrolment ----------------------------------------------------------------------------
    app.events.on('message.inbound', (e) => {
      const m = e.data?.message ?? {};
      if (!e.data?.contactId || m.channel === 'call') return;
      replyReceived(app, e.locationId, e.data.contactId, { message: m.id ?? null, sinceOnly: typeof m.created_at === 'string' ? m.created_at : undefined, detail: String(m.subject ?? '').slice(0, 120) });
    });
    app.events.on('appointment.booked', (e) => e.data?.contactId && meetingBooked(app, e.locationId, e.data.contactId));
    app.events.on('opportunity.stage_changed', (e) => e.data?.contactId && stopContact(app, e.locationId, e.data.contactId, 'stage_change', { dealId: e.data.opportunity?.id }));
    app.events.on('opportunity.status_changed', (e) => {
      if (e.data?.contactId && (e.data.status === 'won' || e.data.status === 'lost')) stopContact(app, e.locationId, e.data.contactId, 'deal_closed', { dealId: e.data.opportunity?.id });
    });
    app.events.on('contact.unsubscribed', (e) => e.data?.contactId && stopContact(app, e.locationId, e.data.contactId, 'unsubscribed'));
    app.events.on('consent.revoked', (e) => {
      if (e.data?.contactId && (e.data.channel === 'email' || e.data.channel === 'all')) stopContact(app, e.locationId, e.data.contactId, 'unsubscribed', { detail: 'Einwilligung widerrufen' });
    });
    app.events.on('contact.updated', (e) => {
      if (e.data?.contactId && Array.isArray(e.data.changed) && e.data.changed.includes('dnd') && e.data.contact?.dnd) stopContact(app, e.locationId, e.data.contactId, 'unsubscribed', { detail: 'Nicht stören' });
    });
    app.events.on('task.completed', (e) => {
      if (e.data?.task?.id) taskDone(app, e.locationId, e.data.task.id);
    });

    // --- reading --------------------------------------------------------------------------------------------------------
    const out = (s: SeqRow) => ({ ...s, step_labels: Object.fromEntries(STEP_TYPES.map((t) => [t, STEP_LABEL[t]])) });
    const brief = (loc: string, s: SeqRow) => {
      const n = (sql: string, ...p: any[]) => Number(Object.values(db.get(sql, ...p) ?? { n: 0 })[0] ?? 0);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        status: s.status,
        mode: s.mode,
        steps: s.steps.length,
        email_steps: s.steps.filter((x) => x.type === 'email').length,
        enrolled: n('SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_id = ?', s.id),
        active: n(`SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_id = ? AND status IN ('active', 'waiting')`, s.id),
        sent: n(`SELECT COUNT(*) FROM sequence_events WHERE sequence_id = ? AND kind = 'sent'`, s.id),
        replied: n(`SELECT COUNT(DISTINCT enrollment_id) FROM sequence_events WHERE sequence_id = ? AND kind = 'reply'`, s.id),
        meetings: n(`SELECT COUNT(DISTINCT enrollment_id) FROM sequence_events WHERE sequence_id = ? AND kind = 'meeting'`, s.id),
        updated_at: s.updated_at,
      };
    };
    const loadAll = (loc: string): SeqRow[] =>
      db.all<{ id: string }>('SELECT id FROM sequences WHERE location_id = ? ORDER BY updated_at DESC', loc).map((r) => getSequence(app, loc, r.id)!);
    const must = (ctx: Ctx): SeqRow => {
      const s = getSequence(app, ctx.locationId, ctx.params.id);
      if (!s) throw notFound('Sequenz nicht gefunden');
      return s;
    };

    router.get('/api/sequences', 'location', (ctx) => loadAll(ctx.locationId).map((s) => brief(ctx.locationId, s)));
    router.get('/api/sequences/:id', 'location', (ctx) => {
      const s = must(ctx);
      return { ...out(s), stats: sequenceStats(app, ctx.locationId, s), stop_labels: STOP_LABEL, tokens: TOKENS };
    });

    // --- writing -----------------------------------------------------------------------------------------------------------
    const ack = (ctx: Ctx, mode: unknown, current?: SeqRow) => {
      if (mode !== 'individual') return {};
      if (current?.mode === 'individual' && current.legal_ack_at) return {};
      if (ctx.body?.legal_ack !== true) throw bad('„Einzelkorrespondenz“ bitte ausdrücklich bestätigen (legal_ack): Du stellst sicher, dass die Mails persönliche 1:1-Korrespondenz sind und du sie rechtlich verantwortest');
      return { legal_ack_by: ctx.user?.id ?? null, legal_ack_at: now() };
    };
    const tzOk = (tz: string) => isValidTz(tz);

    router.post('/api/sequences', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const mode = b.mode === 'individual' ? 'individual' : 'marketing';
      const row = {
        id: id(),
        location_id: ctx.locationId,
        name: str(b.name, 'Name', { required: true, max: 120 }),
        description: str(b.description, 'Beschreibung', { max: 500 }),
        status: 'draft',
        mode,
        ...ack(ctx, mode),
        owner_user_id: ctx.user?.id ?? null,
        steps: asHttp(() => cleanSteps(b.steps ?? [{ type: 'email', delay_days: 0, subject: '', body: '' }], () => id(8))),
        settings: asHttp(() => cleanSettings(b.settings, tzOk, DEFAULT_SETTINGS)),
        created_at: now(),
        updated_at: now(),
      };
      db.insert('sequences', row);
      return out(getSequence(app, ctx.locationId, row.id)!);
    });

    router.patch('/api/sequences/:id', 'location', (ctx) => {
      const s = must(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 120 });
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 500 });
      if (b.mode !== undefined) {
        patch.mode = b.mode === 'individual' ? 'individual' : 'marketing';
        Object.assign(patch, ack(ctx, patch.mode, s));
      }
      if (b.steps !== undefined) patch.steps = asHttp(() => cleanSteps(b.steps, () => id(8)));
      if (b.settings !== undefined) patch.settings = asHttp(() => cleanSettings(b.settings, tzOk, s.settings));
      if (b.status !== undefined) {
        if (!['draft', 'active', 'paused'].includes(b.status)) throw bad('Status: draft, active oder paused');
        if (b.status === 'active') asHttp(() => cleanSteps(patch.steps ?? s.steps, () => id(8)));
        patch.status = b.status;
      }
      db.update('sequences', s.id, patch, ctx.locationId);
      return out(getSequence(app, ctx.locationId, s.id)!);
    });

    router.delete('/api/sequences/:id', 'location', (ctx) => {
      const s = must(ctx);
      db.run('DELETE FROM sequences WHERE id = ? AND location_id = ?', s.id, ctx.locationId);
      return { ok: true };
    });

    // --- enrolling ------------------------------------------------------------------------------------------------------------
    /** The person whose mailbox sends: the caller; keys name a person. */
    const senderOf = (ctx: Ctx): string => {
      const people = new Set(peopleOf(app, ctx.locationId, '').map((p) => p.id));
      const wanted = typeof ctx.body?.user_id === 'string' && ctx.body.user_id ? ctx.body.user_id : undefined;
      if (wanted) {
        if (!people.has(wanted)) throw bad('Die Person gehört nicht zu diesem Sub-Account');
        if (wanted !== ctx.user?.id && ctx.user?.role !== 'admin' && !ctx.viaApiKey && !canConfigure(app, ctx)) throw new HttpError(403, 'Du kannst Kontakte nur für dich selbst aufnehmen');
        return wanted;
      }
      if (ctx.user && !ctx.viaApiKey) return ctx.user.id;
      throw bad('user_id fehlt: Mit einem Schlüssel muss die Person genannt werden, aus deren Postfach gesendet wird');
    };

    router.post('/api/sequences/:id/enroll', 'location', (ctx) => {
      const s = must(ctx);
      const b = ctx.body ?? {};
      const ids = new Set<string>(Array.isArray(b.contact_ids) ? b.contact_ids.map(String).slice(0, 1000) : []);
      // From a list: a tag or a saved smart list (what the person may open, as everywhere).
      if (b.tag || b.smart_list_id) {
        let tags: string[] = b.tag ? [String(b.tag)] : [];
        let exclude: string[] = [];
        let q = '';
        if (b.smart_list_id) {
          const list = smartListById(app, ctx.locationId, b.smart_list_id, ctx);
          if (!list) throw notFound('Die Liste gibt es nicht');
          const f = list.filter;
          tags = [...tags, ...(Array.isArray(f.tags) ? f.tags : [])];
          exclude = Array.isArray(f.excludeTags) ? f.excludeTags : [];
          q = String(f.q ?? '');
        }
        for (const c of findContacts(app, ctx.locationId, { tags, excludeTags: exclude, q, limit: 1000, noTotal: true, who: ctx }).contacts) ids.add(c.id);
      }
      if (!ids.size) throw bad('Keine Kontakte angegeben (contact_ids, tag oder smart_list_id)');
      const r = enroll(app, s, [...ids], { userId: senderOf(ctx), source: ctx.viaApiKey ? 'API' : String(b.source ?? 'manuell').slice(0, 40), dealId: typeof b.deal_id === 'string' ? b.deal_id : null });
      return { enrolled: r.enrolled.length, skipped: r.skipped, contact_ids: r.enrolled };
    });

    router.get('/api/sequences/:id/enrollments', 'location', (ctx) => {
      const s = must(ctx);
      const where = ['e.sequence_id = ?'];
      const params: any[] = [s.id];
      const status = ctx.query.get('status');
      if (status && ['active', 'waiting', 'finished', 'stopped'].includes(status)) (where.push('e.status = ?'), params.push(status));
      const access = resolve(app, ctx);
      const scope = contactScopeClause(access, 'e.contact_id');
      if (scope) (where.push(scope.sql), params.push(...scope.params));
      return db
        .all(
          `SELECT e.id, e.contact_id, e.user_id, e.status, e.stop_reason, e.step_index, e.next_at, e.note, e.enrolled_at, e.finished_at, e.source, c.first_name, c.last_name, c.email, u.name AS user_name
           FROM sequence_enrollments e JOIN contacts c ON c.id = e.contact_id LEFT JOIN users u ON u.id = e.user_id WHERE ${where.join(' AND ')} ORDER BY e.enrolled_at DESC LIMIT ?`,
          ...params,
          clampLimit(ctx.query.get('limit'), 200, 1000),
        )
        .map((r) => ({ ...maskContactFields(access, r), stop_label: r.stop_reason ? (STOP_LABEL as Record<string, string>)[r.stop_reason] ?? r.stop_reason : '', step_total: s.steps.length }));
    });

    router.post('/api/sequences/:id/preview', 'location', (ctx) => {
      const s = must(ctx);
      const cid = str(ctx.body?.contact_id, 'Kontakt', { required: true, max: 64 });
      const p = previewStep(app, s, String(ctx.body?.step_id ?? ''), cid, ctx.user?.id ?? null, typeof ctx.body?.deal_id === 'string' ? ctx.body.deal_id : null);
      if (!p) throw notFound('Kontakt oder Schritt nicht gefunden');
      return p;
    });

    /** A contact's sequences (the contact page): running and past. */
    router.get('/api/sequence-enrollments', 'location', (ctx) => {
      const cid = str(ctx.query.get('contact_id'), 'Kontakt', { required: true, max: 64 });
      if (!getContact(app, ctx.locationId, cid)) throw notFound('Kontakt nicht gefunden');
      return db
        .all(
          `SELECT e.id, e.sequence_id, e.status, e.stop_reason, e.step_index, e.next_at, e.note, e.enrolled_at, e.finished_at, s.name AS sequence_name, u.name AS user_name,
             (SELECT COUNT(*) FROM sequence_events v WHERE v.enrollment_id = e.id AND v.kind = 'sent') AS sent
           FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id LEFT JOIN users u ON u.id = e.user_id WHERE e.location_id = ? AND e.contact_id = ? ORDER BY e.enrolled_at DESC LIMIT 50`,
          ctx.locationId,
          cid,
        )
        .map((r) => ({ ...r, stop_label: r.stop_reason ? (STOP_LABEL as Record<string, string>)[r.stop_reason] ?? r.stop_reason : '' }));
    });

    router.post('/api/sequence-enrollments/:id/stop', 'location', (ctx) => {
      const row = db.get('SELECT * FROM sequence_enrollments WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId) as EnrollRow | undefined;
      if (!row) throw notFound('Aufnahme nicht gefunden');
      const stopped = stopEnrollment(app, { ...row, variants: {} } as EnrollRow, 'manual', ctx.user ? `von ${ctx.user.name}` : '');
      if (!stopped) throw new HttpError(409, 'Diese Aufnahme ist schon beendet');
      return { ok: true };
    });

    // --- send limits and the person's own view ---------------------------------------------------------------------------------
    router.get('/api/sequence-settings', 'location', (ctx) => {
      const row = db.get<{ daily_limit: number; user_limits: string }>('SELECT daily_limit, user_limits FROM sequence_settings WHERE location_id = ?', ctx.locationId);
      const mb = ctx.user ? senderMailbox(app, ctx.locationId, ctx.user.id, false) : undefined;
      return {
        daily_limit: row?.daily_limit ?? DEFAULT_DAILY_LIMIT,
        user_limits: JSON.parse(row?.user_limits || '{}'),
        max_daily_limit: MAX_DAILY_LIMIT,
        max_steps: MAX_STEPS,
        tokens: TOKENS,
        people: peopleOf(app, ctx.locationId, '').map((p) => ({ id: p.id, name: p.name })),
        my_mailbox: mb ? { connected: true, address: mb.shared_address || mb.address, tracking: !!mb.track_engagement } : { connected: false },
        can_configure: canConfigure(app, ctx),
      };
    });
    router.put('/api/sequence-settings', 'location', (ctx) => {
      mustConfigure(app, ctx);
      const cur = db.get<{ daily_limit: number; user_limits: string }>('SELECT daily_limit, user_limits FROM sequence_settings WHERE location_id = ?', ctx.locationId);
      const limit = ctx.body?.daily_limit === undefined ? (cur?.daily_limit ?? DEFAULT_DAILY_LIMIT) : Math.round(num(ctx.body.daily_limit, NaN));
      if (!Number.isFinite(limit) || limit < 0 || limit > MAX_DAILY_LIMIT) throw bad(`Tageslimit: 0 bis ${MAX_DAILY_LIMIT} E-Mails pro Person`);
      const people = new Set(peopleOf(app, ctx.locationId, '').map((p) => p.id));
      const per: Record<string, number> = cur ? JSON.parse(cur.user_limits || '{}') : {};
      if (ctx.body?.user_limits && typeof ctx.body.user_limits === 'object') {
        for (const [uid, v] of Object.entries<any>(ctx.body.user_limits)) {
          if (!people.has(uid)) throw bad('Eine der Personen gehört nicht zu diesem Sub-Account');
          if (v === null || v === '') delete per[uid];
          else {
            const n = Math.round(Number(v));
            if (!Number.isFinite(n) || n < 0 || n > MAX_DAILY_LIMIT) throw bad(`Tageslimit: 0 bis ${MAX_DAILY_LIMIT} E-Mails pro Person`);
            per[uid] = n;
          }
        }
      }
      db.run(
        `INSERT INTO sequence_settings (location_id, daily_limit, user_limits, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET daily_limit = excluded.daily_limit, user_limits = excluded.user_limits, updated_at = excluded.updated_at`,
        ctx.locationId,
        limit,
        JSON.stringify(per),
        now(),
      );
      return { daily_limit: limit, user_limits: per };
    });

    // --- workflows: "Sequenz starten" -----------------------------------------------------------------------------------------------
    registerActions(app, [
      {
        meta: {
          type: 'sequence_enroll',
          label: 'In Sequenz aufnehmen',
          category: 'sales',
          icon: 'workflows',
          summary: 'Nimmt den Kontakt in eine Vertriebs-Sequenz auf (E-Mails aus dem Postfach der zuständigen Person).',
          doc: 'Sequenz per Name oder ID. Absender ist die Person aus „Absender“, sonst der Zuständige des Kontakts, sonst wer die Sequenz angelegt hat – sie braucht ein verbundenes Postfach. Kontakte ohne E-Mail, mit „Nicht stören“ oder (Modus Werbung) ohne Einwilligung werden übersprungen.',
          keywords: 'sequenz sequence vertrieb outreach cadence',
          fields: [
            { key: 'sequence', label: 'Sequenz (Name oder ID)', type: 'text', required: true },
            { key: 'user_id', label: 'Absender (optional)', type: 'user' },
          ],
          sample: { sequence: 'Neukunden-Folge' },
        },
        run: (run, step) => {
          const ref = String(step.sequence ?? '').trim();
          const row = db.get<{ id: string }>('SELECT id FROM sequences WHERE location_id = ? AND (id = ? OR lower(name) = lower(?)) ORDER BY updated_at DESC LIMIT 1', run.location_id, ref, ref);
          const seq = row && getSequence(app, run.location_id, row.id);
          if (!seq) throw new Error(ref ? `Sequenz „${ref}“ nicht gefunden` : 'Keine Sequenz gewählt');
          const contact = getContact(app, run.location_id, run.contact_id);
          const userId = String(step.user_id || contact?.assigned_to || seq.owner_user_id || '') || null;
          const r = enroll(app, seq, [run.contact_id], { userId, source: 'Workflow' });
          return r.enrolled.length ? `In „${seq.name}“ aufgenommen` : `Nicht aufgenommen: ${r.skipped[0]?.reason ?? 'unbekannt'}`;
        },
      },
    ]);
  },
};
