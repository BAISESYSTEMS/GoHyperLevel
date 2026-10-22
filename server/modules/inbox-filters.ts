import type { Module } from '../core/app.js';
import { bad, clampLimit, type Ctx } from '../core/http.js';
import type { Tool } from './mcp.js';

/**
 * Conversations: filters like the contact list and full-text search over every message (docs/team-inbox.md#filters-and-message-search).
 *
 * - `GET /api/conversations` learns `tag` (the contact has it), `pipeline_id` / `stage_id` (the contact has an open deal there) and
 *   `owner` (the contact's owner: a user id, `me` or `none`) through the `conversationFilters` hook.
 * - `GET /api/conversations/search?q=` finds messages by their text (subject and body of every channel) with a highlighted snippet.
 *   The index is an FTS5 table filled by SQL triggers on `messages`, so every way a message gets in or out is covered; without FTS5
 *   it falls back to LIKE. The hits run through the same `conversationFilters` as the list, so record access, spam and mailbox
 *   privacy apply unchanged.
 */

/** Marks around a hit in snippets (control characters – the browser turns them into <mark>). */
const HIT = ['\u0001', '\u0002'] as const;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** FTS5 query from what a person typed: every word must appear, as a prefix ("rech" finds "Rechnung"). */
export function ftsQuery(q: string): string {
  const words = q
    .normalize('NFC')
    .split(/[^\p{L}\p{N}@._-]+/u)
    .map((w) => w.replace(/["*]/g, '').trim())
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.map((w) => `"${w}"*`).join(' ');
}

/** A snippet without HTML (mail bodies) and with the hit marks kept. */
export function cleanSnippet(s: string): string {
  return String(s ?? '')
    .replace(/<[^>\u0001\u0002]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_search_messages',
    title: 'Nachrichten durchsuchen (Volltext)',
    description:
      'Volltextsuche über alle Nachrichten aller Kanäle (E-Mail, SMS, Chat, WhatsApp …) des Sub-Accounts: findet Wörter in Betreff und Text (Wortanfänge genügen), mit Ausschnitt, Kanal, Richtung, Datum, Kontakt und Konversations-ID. Optional nach Kanal, Tag, Pipeline/Stufe oder Zuständigem filtern.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        q: { type: 'string', description: 'Suchwörter' },
        channel: { type: 'string', description: 'email, sms, chat, whatsapp …' },
        tag: { type: 'string' },
        pipeline_id: { type: 'string' },
        stage_id: { type: 'string' },
        owner: { type: 'string', description: 'User-ID, me oder none' },
        limit: { type: 'number' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    untrusted: true,
    run: (call, a) => {
      const s = new URLSearchParams();
      for (const k of ['q', 'channel', 'tag', 'pipeline_id', 'stage_id', 'owner', 'limit']) if (a[k] !== undefined && a[k] !== '') s.set(k, String(a[k]));
      return call.api('GET', `/api/conversations/search?${s}`, { location: a.location_id });
    },
  },
];

export const inboxFiltersModule: Module = {
  name: 'inbox-filters',
  migrations: [['001-indexes', `CREATE INDEX IF NOT EXISTS opportunities_contact_open ON opportunities(contact_id, status, pipeline_id, stage_id)`]],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- the index: FTS5 over subject + body, kept by triggers; `mid` checks that rowids still match (a restored copy) ------------
    // Existing messages are indexed once: small databases right away, large ones in slices on the tick (≤ 50 ms each) –
    // new messages go in through the triggers from the first moment, so the search is complete as soon as the cursor is through.
    let fts = false;
    let backfill: { cursor: number; max: number } | null = null;
    try {
      const had = !!db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'messages_fts'`);
      db.raw.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(mid UNINDEXED, subject, body, tokenize = 'unicode61 remove_diacritics 2');
        CREATE TABLE IF NOT EXISTS messages_fts_state (id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL, max INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts (rowid, mid, subject, body) VALUES (NEW.rowid, NEW.id, NEW.subject, NEW.body);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = OLD.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF subject, body ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = OLD.rowid;
          INSERT INTO messages_fts (rowid, mid, subject, body) VALUES (NEW.rowid, NEW.id, NEW.subject, NEW.body);
        END;
      `);
      // First start with the index, or a database copy whose rowids moved (VACUUM): (re)build from the messages.
      const probe = had ? db.get<{ ok: number }>(`SELECT (SELECT m.id FROM messages m WHERE m.rowid = f.rowid) = f.mid AS ok FROM messages_fts f ORDER BY f.rowid DESC LIMIT 1`) : undefined;
      if (!had || (probe && !probe.ok)) {
        const max = db.get<{ m: number | null }>('SELECT MAX(rowid) AS m FROM messages')!.m ?? 0;
        db.raw.exec('DELETE FROM messages_fts');
        // Rows the triggers add from now on are above `max`; the backfill covers 1..max.
        db.run('INSERT OR REPLACE INTO messages_fts_state (id, cursor, max) VALUES (1, 0, ?)', max);
      }
      const st = db.get<{ cursor: number; max: number }>('SELECT cursor, max FROM messages_fts_state WHERE id = 1');
      if (st && st.cursor < st.max) backfill = { cursor: st.cursor, max: st.max };
      fts = true;
    } catch (e) {
      console.error('[inbox-filters] FTS5 nicht verfügbar – Suche über LIKE', (e as Error).message);
    }
    /** One slice of the backfill (rowid order); true while more is left. */
    const backfillStep = (budgetMs = 40): boolean => {
      if (!backfill) return false;
      const start = performance.now();
      while (backfill.cursor < backfill.max && performance.now() - start < budgetMs) {
        const to = Math.min(backfill.max, backfill.cursor + 500);
        db.run('INSERT OR REPLACE INTO messages_fts (rowid, mid, subject, body) SELECT rowid, id, subject, body FROM messages WHERE rowid > ? AND rowid <= ?', backfill.cursor, to);
        backfill.cursor = to;
        db.run('UPDATE messages_fts_state SET cursor = ? WHERE id = 1', to);
      }
      if (backfill.cursor >= backfill.max) backfill = null;
      return !!backfill;
    };
    // Small databases: done before the first request.
    if (backfill && backfill.max - backfill.cursor <= 20_000) backfillStep(Number.POSITIVE_INFINITY);
    app.onTick(() => void backfillStep());
    app.services.messageSearchBackfill = () => {
      while (backfillStep(Number.POSITIVE_INFINITY));
    };

    // --- filters for the list ---------------------------------------------------------------------------------------------------
    const filter = (ctx: Ctx, where: string[], params: unknown[]) => {
      const tag = ctx.query.get('tag');
      if (tag) (where.push('EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)'), params.push(tag.slice(0, 80)));
      const pipeline = ctx.query.get('pipeline_id');
      const stage = ctx.query.get('stage_id');
      if ((pipeline && ID.test(pipeline)) || (stage && ID.test(stage))) {
        const cond = [`o.contact_id = v.contact_id`, `o.location_id = v.location_id`, `o.status = 'open'`];
        if (pipeline && ID.test(pipeline)) (cond.push('o.pipeline_id = ?'), params.push(pipeline));
        if (stage && ID.test(stage)) (cond.push('o.stage_id = ?'), params.push(stage));
        where.push(`EXISTS (SELECT 1 FROM opportunities o WHERE ${cond.join(' AND ')})`);
      }
      const owner = ctx.query.get('owner');
      if (owner === 'none') where.push('c.assigned_to IS NULL');
      else if (owner === 'me' && ctx.user) (where.push('c.assigned_to = ?'), params.push(ctx.user.id));
      else if (owner && owner !== 'me' && ID.test(owner)) (where.push('c.assigned_to = ?'), params.push(owner));
    };
    app.services.conversationFilters = [...(app.services.conversationFilters ?? []), filter];

    // --- full-text search -----------------------------------------------------------------------------------------------------
    router.get('/api/conversations/search', 'location', (ctx) => {
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 200);
      if (q.length < 2) throw bad('q: mindestens zwei Zeichen');
      const limit = clampLimit(ctx.query.get('limit'), 30, 100);
      const where = ['v.location_id = ?'];
      const params: unknown[] = [ctx.locationId];
      const channel = ctx.query.get('channel');
      if (channel && /^[a-z]{2,20}$/.test(channel)) (where.push('m.channel = ?'), params.push(channel));
      // The list's own filters (record access, spam, mailbox privacy, inbox views, tag/pipeline/owner) – `q` there is ours, not theirs.
      for (const f of (app.services.conversationFilters ?? []) as ((ctx: Ctx, where: string[], params: unknown[]) => void)[]) f(ctx, where, params);
      const match = ftsQuery(q);
      const select = `m.id, m.conversation_id, m.contact_id, m.channel, m.direction, m.subject, m.created_at, c.first_name, c.last_name, c.email, c.phone`;
      let rows: any[] = [];
      if (fts && match) {
        rows = db.all(
          `SELECT ${select}, snippet(messages_fts, -1, ?, ?, '…', 14) AS snippet
           FROM messages_fts f JOIN messages m ON m.rowid = f.rowid AND m.id = f.mid
           JOIN conversations v ON v.id = m.conversation_id JOIN contacts c ON c.id = v.contact_id
           WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`,
          HIT[0],
          HIT[1],
          match,
          ...(params as string[]),
          limit,
        );
      } else {
        const like = `%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
        rows = db
          .all<any>(
            `SELECT ${select}, m.body FROM messages m JOIN conversations v ON v.id = m.conversation_id JOIN contacts c ON c.id = v.contact_id
             WHERE (m.body LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\') AND ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`,
            like,
            like,
            ...(params as string[]),
            limit,
          )
          .map(({ body, ...r }) => {
            const text = cleanSnippet(body);
            const at = text.toLowerCase().indexOf(q.toLowerCase());
            const from = Math.max(0, at - 60);
            return { ...r, snippet: at < 0 ? text.slice(0, 120) : `${from ? '…' : ''}${text.slice(from, at)}${HIT[0]}${text.slice(at, at + q.length)}${HIT[1]}${text.slice(at + q.length, at + q.length + 80)}` };
          });
      }
      // The list's row hooks (record access masks hidden contact fields) see conversation-shaped rows: `id` is the conversation.
      const shaped = rows.map(({ id: messageId, ...r }) => ({ ...r, id: r.conversation_id, message_id: messageId }));
      const hits = ((app.services.conversationRows ?? []) as ((ctx: Ctx, rows: any[]) => any[])[]).reduce((r, f) => f(ctx, r), shaped);
      return {
        fts,
        complete: !backfill,
        hits: hits.map((h: any) => ({
          message_id: h.message_id, conversation_id: h.conversation_id, contact_id: h.contact_id, channel: h.channel, direction: h.direction, subject: h.subject,
          created_at: h.created_at, first_name: h.first_name, last_name: h.last_name, email: h.email, phone: h.phone, snippet: cleanSnippet(h.snippet),
        })),
      };
    });
  },
};
