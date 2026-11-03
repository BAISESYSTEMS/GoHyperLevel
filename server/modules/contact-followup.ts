import type { Module } from '../core/app.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { zonedToUtc } from '../core/time.js';
import { now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * "Wiedervorlage am": a contact is put aside until a date and comes back by itself – the contact-level twin of
 * snoozing a conversation in the team inbox. Lists hide waiting contacts with ?follow_up=hide (the contact list
 * does so by default), ?follow_up=waiting shows them, ?follow_up=due those whose date has come.
 *
 * When the date comes: event `contact.follow_up_due` (workflow trigger) and an entry in the agents' feed
 * (modules/agent-events.ts). A reply from the contact brings it back at once.
 */

const ENC = encodeURIComponent;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface FollowUp {
  contact_id: string;
  location_id: string;
  due_at: string;
  note: string;
  set_by: string | null;
  set_by_name: string;
  created_at: string;
  notified_at: string | null;
}

const out = (r: FollowUp | undefined) => (r ? { contact_id: r.contact_id, due_at: r.due_at, note: r.note, set_by: r.set_by_name || null, created_at: r.created_at, due: r.due_at <= now() } : null);

const TRIGGER: TriggerMeta = {
  type: 'contact.follow_up_due',
  label: 'Wiedervorlage fällig',
  category: 'contact',
  summary: 'Ein zurückgestellter Kontakt ist wieder da: sein Wiedervorlage-Datum ist erreicht oder er hat geantwortet.',
  doc: 'Feuert einmal je Wiedervorlage, sobald das Datum erreicht ist (oder der Kontakt vorher schreibt). {{event.note}} ist der Grund der Wiedervorlage, {{event.due_at}} der Zeitpunkt.',
  fields: [],
  sample: { note: 'Angebot nachfassen', due_at: '2026-11-20T08:00:00.000Z' },
};

const TOOLS: Tool[] = [
  {
    name: 'ghl_follow_ups',
    title: 'Wiedervorlagen',
    description:
      'Kontakte auf Wiedervorlage: state=due (Datum erreicht – jetzt bearbeiten), waiting (noch zurückgestellt) oder all. Setzen/aufheben: ghl_update_contact mit follow_up_at (Datum YYYY-MM-DD oder Zeitpunkt, null hebt auf) und follow_up_note.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, state: { type: 'string', enum: ['due', 'waiting', 'all'] } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/follow-ups?state=${ENC(a.state ?? 'due')}`, { location: a.location_id }),
  },
];

export const contactFollowupModule: Module = {
  name: 'contact-followup',
  migrations: [
    [
      '001-contact-followups',
      `CREATE TABLE contact_followups (
        contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        due_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', set_by TEXT, set_by_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, notified_at TEXT
      );
      CREATE INDEX contact_followups_due ON contact_followups(location_id, due_at);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, [TRIGGER]);

    const contactOf = (ctx: Ctx) => {
      const c = getContact(app, ctx.locationId!, ctx.params.id);
      if (!c) throw notFound('Kontakt nicht gefunden');
      return c;
    };
    /** A day ("2026-11-20") means the start of that day in the sub-account's time zone. */
    const dueOf = (ctx: Ctx, v: unknown): string => {
      const s = str(v, 'Datum', { required: true, max: 40 });
      const tz = app.location(ctx.locationId!)?.timezone || 'Europe/Berlin';
      const d = DAY.test(s) ? zonedToUtc(s, '00:00', tz) : new Date(s);
      if (Number.isNaN(d.getTime())) throw bad('Datum: YYYY-MM-DD oder ISO-Zeitpunkt');
      if (d.getTime() > Date.now() + 5 * 365 * 86_400_000) throw bad('Wiedervorlage höchstens 5 Jahre im Voraus');
      return d.toISOString();
    };
    const get = (contactId: string) => db.get<FollowUp>('SELECT * FROM contact_followups WHERE contact_id = ?', contactId);

    // No follow-up: due_at null (a bare null would answer {ok: true}).
    router.get('/api/contacts/:id/follow-up', 'location', (ctx) => {
      const id = contactOf(ctx).id;
      return out(get(id)) ?? { contact_id: id, due_at: null };
    });
    router.put('/api/contacts/:id/follow-up', 'location', (ctx) => {
      const c = contactOf(ctx);
      const b = ctx.body ?? {};
      const row: FollowUp = {
        contact_id: c.id,
        location_id: ctx.locationId!,
        due_at: dueOf(ctx, b.at ?? b.due_at),
        note: str(b.note, 'Notiz', { max: 500 }) ?? '',
        set_by: ctx.user?.id ?? null,
        set_by_name: (ctx.user?.name ?? (ctx.viaApiKey ? 'API' : '')).slice(0, 200),
        created_at: now(),
        notified_at: null,
      };
      db.run('DELETE FROM contact_followups WHERE contact_id = ?', c.id);
      db.insert('contact_followups', row);
      return { ...out(row), name: [c.first_name, c.last_name].filter(Boolean).join(' ') };
    });
    router.delete('/api/contacts/:id/follow-up', 'location', (ctx) => {
      db.run('DELETE FROM contact_followups WHERE contact_id = ?', contactOf(ctx).id);
      return { ok: true };
    });
    router.get('/api/follow-ups', 'location', (ctx) => {
      const state = ctx.query.get('state') ?? 'due';
      if (!['due', 'waiting', 'all'].includes(state)) throw bad('state: due, waiting oder all');
      const cond = state === 'due' ? 'AND f.due_at <= ?' : state === 'waiting' ? 'AND f.due_at > ?' : 'AND ? IS NOT NULL';
      return db
        .all<FollowUp & { first_name: string; last_name: string; email: string; phone: string }>(
          `SELECT f.*, c.first_name, c.last_name, c.email, c.phone FROM contact_followups f JOIN contacts c ON c.id = f.contact_id
           WHERE f.location_id = ? ${cond} ORDER BY f.due_at LIMIT 500`,
          ctx.locationId,
          now(),
        )
        .map((r) => ({ ...out(r), name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.phone }));
    });

    // Contact lists (and smart lists, exports): ?follow_up=hide | waiting | due.
    app.services.contactFilters = [
      ...(app.services.contactFilters ?? []),
      (f: any) => {
        const v = String(f?.query?.get?.('follow_up') ?? f?.extra?.follow_up ?? '').trim();
        const exists = 'EXISTS (SELECT 1 FROM contact_followups fu WHERE fu.contact_id = contacts.id AND fu.due_at';
        if (v === 'hide') return { sql: `NOT ${exists} > ?)`, params: [now()] };
        if (v === 'waiting') return { sql: `${exists} > ?)`, params: [now()] };
        if (v === 'due') return { sql: `${exists} <= ?)`, params: [now()] };
        return undefined;
      },
    ];

    // A reply from the contact ends the waiting: the contact is back at once (and announced like any due one).
    app.events.on('message.inbound', (e) => {
      const id = e.data.contactId;
      if (id) db.run('UPDATE contact_followups SET due_at = ? WHERE contact_id = ? AND location_id = ? AND due_at > ?', now(), id, e.locationId, now());
    });

    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 60_000 && app.config.tickMs !== 0) return;
      last = Date.now();
      const due = db.all<FollowUp>('SELECT * FROM contact_followups WHERE notified_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 200', now());
      for (const f of due) {
        db.run('UPDATE contact_followups SET notified_at = ? WHERE contact_id = ?', now(), f.contact_id);
        const contact = getContact(app, f.location_id, f.contact_id);
        if (!contact) continue;
        app.events.emit(f.location_id, 'contact.follow_up_due', { contactId: f.contact_id, contact, note: f.note, due_at: f.due_at });
        app.services.recordAgentEvent?.(f.location_id, {
          type: 'contact.follow_up',
          area: 'contacts',
          data: { contact_id: f.contact_id, contact_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || '', due_at: f.due_at, note: f.note, set_by: f.set_by_name || null },
        });
      }
    });
  },
};
