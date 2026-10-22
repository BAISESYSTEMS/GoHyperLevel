import type { Module } from '../core/app.js';
import { bad, clampLimit, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { getOpportunity } from '../services/opportunities.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Gesprächsnotizen am Deal (docs/sales.md): die Zusammenfassung eines Gesprächs oder Meetings hängt am Deal und am Kontakt. Ein Mensch
 * schreibt sie in den Deal; die Anruf-Auswertung (KI-Zusammenfassung, Transkript) liefert sie über den Dienst
 *
 *   app.services.attachCallSummary(locationId, { contactId, dealId?, summary, … })
 *
 * ohne etwas über Deals zu wissen: Der Dienst findet den passenden Deal (offener Deal des Kontakts), legt die Notiz an, schreibt einen
 * Eintrag in den Verlauf des Kontakts und – auf Wunsch – Aufgaben aus den Folgeschritten. Doppelte Lieferung (gleiche `externalId`)
 * ändert nichts.
 */

export interface CallSummaryInput {
  contactId: string;
  /** The deal the summary belongs to; without it the contact's open deal (the most recently changed one) is used, if there is one. */
  dealId?: string | null;
  summary: string;
  title?: string;
  /** What the producer calls the call (its id): a second delivery of the same one changes nothing. */
  externalId?: string;
  /** Who delivers it ("Anrufauswertung", "Zoom" …). */
  source?: string;
  durationSec?: number;
  /** ISO time of the call; default now. */
  at?: string;
  transcriptUrl?: string;
  /** Follow-ups the summary found; with `createTasks` they become tasks of the deal's owner. */
  actionItems?: string[];
  createTasks?: boolean;
  userId?: string | null;
}

export interface CallSummaryResult {
  id: string;
  dealId: string | null;
  noteId: string | null;
  taskIds: string[];
  duplicate: boolean;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_deal_meeting_note',
    title: 'Gesprächsnotiz an einen Deal hängen',
    description:
      'Hängt die Zusammenfassung eines Gesprächs oder Meetings an einen Deal und den Kontakt (mit Verlaufseintrag). Ohne deal_id nimmt es den offenen Deal des Kontakts. action_items + create_tasks=true legt Aufgaben für den Zuständigen an. Gleiche external_id = kein zweites Mal.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        contact_id: { type: 'string' },
        deal_id: { type: 'string' },
        summary: { type: 'string' },
        title: { type: 'string' },
        external_id: { type: 'string' },
        source: { type: 'string' },
        duration_sec: { type: 'number' },
        action_items: { type: 'array', items: { type: 'string' } },
        create_tasks: { type: 'boolean' },
      },
      required: ['contact_id', 'summary'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => call.api('POST', '/api/meeting-notes', { location: a.location_id, body: { contact_id: a.contact_id, deal_id: a.deal_id, summary: a.summary, title: a.title, external_id: a.external_id, source: a.source, duration_sec: a.duration_sec, action_items: a.action_items, create_tasks: a.create_tasks } }),
  },
];

const TRIGGERS: TriggerMeta[] = [
  {
    type: 'meeting_note.added',
    label: 'Gesprächsnotiz angelegt',
    category: 'sales',
    summary: 'Die Zusammenfassung eines Gesprächs wird an einen Deal gehängt (von Hand oder durch die Anruf-Auswertung).',
    doc: '{{event.note.summary}}, {{event.note.title}}, {{event.note.action_items}} und {{event.dealId}} sind verfügbar. Typisch: Folgeaufgabe, Nachricht an den Zuständigen oder Deal-Phase ändern.',
    fields: [],
    sample: { dealId: 'd1', note: { id: 'n1', title: 'Erstgespräch', summary: 'Interesse am Paket Plus, Angebot bis Freitag.', action_items: ['Angebot senden'], source: 'Anrufauswertung' } },
    keywords: 'gespräch notiz zusammenfassung anruf meeting deal call summary',
  },
];

export const meetingNotesModule: Module = {
  name: 'meeting-notes',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE deal_meeting_notes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        deal_id TEXT REFERENCES opportunities(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL, action_items TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '',
        external_id TEXT, duration_sec INTEGER, transcript_url TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL,
        note_id TEXT, created_by TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX deal_meeting_notes_deal ON deal_meeting_notes(deal_id, occurred_at);
      CREATE INDEX deal_meeting_notes_contact ON deal_meeting_notes(contact_id, occurred_at);
      CREATE UNIQUE INDEX deal_meeting_notes_external ON deal_meeting_notes(location_id, source, external_id) WHERE external_id IS NOT NULL;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, TRIGGERS);

    /** The deal a summary belongs to when nobody said: the contact's most recently changed open deal. */
    const dealOf = (loc: string, contactId: string): string | null =>
      db.get<{ id: string }>(`SELECT id FROM opportunities WHERE location_id = ? AND contact_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1`, loc, contactId)?.id ?? null;

    const out = (r: any) => ({ ...r, action_items: JSON.parse(r.action_items || '[]') });

    function attach(loc: string, input: CallSummaryInput): CallSummaryResult {
      const contact = getContact(app, loc, String(input.contactId ?? ''));
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const summary = String(input.summary ?? '').trim().slice(0, 20_000);
      if (!summary) throw bad('Die Zusammenfassung fehlt');
      const source = String(input.source ?? '').trim().slice(0, 60);
      const external = input.externalId ? String(input.externalId).slice(0, 200) : null;
      if (external) {
        const dup = db.get<{ id: string; deal_id: string | null; note_id: string | null }>('SELECT id, deal_id, note_id FROM deal_meeting_notes WHERE location_id = ? AND source = ? AND external_id = ?', loc, source, external);
        if (dup) return { id: dup.id, dealId: dup.deal_id, noteId: dup.note_id, taskIds: [], duplicate: true };
      }
      let dealId: string | null = null;
      if (input.dealId) {
        const deal = getOpportunity(app, loc, String(input.dealId)) as { id: string; contact_id: string } | undefined;
        if (!deal) throw notFound('Deal nicht gefunden');
        if (deal.contact_id !== contact.id) throw bad('Der Deal gehört zu einem anderen Kontakt');
        dealId = deal.id;
      } else dealId = dealOf(loc, contact.id);
      const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : now();
      const items = (Array.isArray(input.actionItems) ? input.actionItems : []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 20);
      const title = String(input.title ?? '').trim().slice(0, 200) || 'Gesprächsnotiz';
      const minutes = input.durationSec && input.durationSec > 0 ? Math.max(1, Math.round(input.durationSec / 60)) : 0;
      const row = {
        id: id(),
        location_id: loc,
        deal_id: dealId,
        contact_id: contact.id,
        title,
        summary,
        action_items: items,
        source,
        external_id: external,
        duration_sec: input.durationSec && input.durationSec > 0 ? Math.round(input.durationSec) : null,
        transcript_url: /^https:\/\//i.test(String(input.transcriptUrl ?? '')) ? String(input.transcriptUrl).slice(0, 1000) : '',
        occurred_at: at,
        note_id: null as string | null,
        created_by: input.userId ?? null,
        created_at: now(),
      };
      const taskIds: string[] = [];
      db.tx(() => {
        // The contact's note shows up on the contact page like any other note; the deal's list shows the same text.
        const noteId = id();
        db.insert('notes', { id: noteId, location_id: loc, contact_id: contact.id, body: `${title}${minutes ? ` (${minutes} Min.)` : ''}\n\n${summary}${items.length ? `\n\nFolgeschritte:\n${items.map((x) => `- ${x}`).join('\n')}` : ''}`, user_id: input.userId ?? null, created_at: at });
        row.note_id = noteId;
        db.insert('deal_meeting_notes', row);
        if (input.createTasks && items.length) {
          const owner = dealId ? (db.get<{ assigned_to: string | null }>('SELECT assigned_to FROM opportunities WHERE id = ?', dealId)?.assigned_to ?? contact.assigned_to ?? null) : (contact.assigned_to ?? null);
          for (const item of items) {
            const tid = id();
            db.insert('tasks', { id: tid, location_id: loc, contact_id: contact.id, title: item, description: `Aus der Gesprächsnotiz „${title}“`, due_at: null, done: 0, assigned_to: owner, created_at: now() });
            taskIds.push(tid);
          }
        }
      });
      logActivity(app, loc, contact.id, 'call.summary', `${title}: ${summary.replace(/\s+/g, ' ').slice(0, 140)}`, { meeting_note_id: row.id, deal_id: dealId, source, duration_sec: row.duration_sec });
      app.events.emit(loc, 'meeting_note.added', { contactId: contact.id, dealId, note: { id: row.id, title, summary: summary.slice(0, 2000), action_items: items, source, duration_sec: row.duration_sec } });
      return { id: row.id, dealId, noteId: row.note_id, taskIds, duplicate: false };
    }

    // The hook other modules call (call intelligence, meeting recorders): no HTTP, no deal knowledge needed.
    app.services.attachCallSummary = (loc: string, input: CallSummaryInput): CallSummaryResult => attach(loc, input);

    router.get('/api/opportunities/:id/meeting-notes', 'location', (ctx) => {
      if (!getOpportunity(app, ctx.locationId, ctx.params.id)) throw notFound('Deal nicht gefunden');
      return db.all('SELECT * FROM deal_meeting_notes WHERE location_id = ? AND deal_id = ? ORDER BY occurred_at DESC LIMIT ?', ctx.locationId, ctx.params.id, clampLimit(ctx.query.get('limit'), 50, 200)).map(out);
    });

    /** From the deal's page (a person types it) or from outside (a key, the MCP tool). */
    router.post('/api/meeting-notes', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const r = attach(ctx.locationId, {
        contactId: str(b.contact_id, 'Kontakt', { required: true, max: 64 }),
        dealId: b.deal_id ? String(b.deal_id) : null,
        summary: str(b.summary, 'Zusammenfassung', { required: true, max: 20_000 }),
        title: str(b.title, 'Titel', { max: 200 }),
        externalId: b.external_id ? String(b.external_id) : undefined,
        source: ctx.viaApiKey ? str(b.source, 'Quelle', { max: 60 }) || 'API' : str(b.source, 'Quelle', { max: 60 }),
        durationSec: b.duration_sec === undefined ? undefined : Number(b.duration_sec),
        at: b.at ? String(b.at) : undefined,
        transcriptUrl: b.transcript_url ? String(b.transcript_url) : undefined,
        actionItems: Array.isArray(b.action_items) ? b.action_items : [],
        createTasks: b.create_tasks === true,
        userId: ctx.user?.id ?? null,
      });
      return { ...r, note: out(db.get('SELECT * FROM deal_meeting_notes WHERE id = ?', r.id)) };
    });

    router.delete('/api/meeting-notes/:id', 'location', (ctx) => {
      const n = db.get<{ id: string; note_id: string | null; deal_id: string | null }>('SELECT id, note_id, deal_id FROM deal_meeting_notes WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!n) throw notFound('Notiz nicht gefunden');
      db.tx(() => {
        db.run('DELETE FROM deal_meeting_notes WHERE id = ?', n.id);
        if (n.note_id) db.run('DELETE FROM notes WHERE id = ? AND location_id = ?', n.note_id, ctx.locationId);
      });
      return { ok: true };
    });
  },
};
