import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc, type DayKey } from '../core/time.js';
import { id, now } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Evergreen-Kategorien für Social Posts – docs/social-planner.md#evergreen-queues. A queue (category, e.g. "Tipps", "Kundenstimmen")
 * holds reusable posts and a weekly plan of slots (Mo 09:00, Do 18:30 …) for its channels. At each slot the post that was used
 * least (then the oldest) goes out through the social planner; with "wiederverwenden" the queue starts over when all were used,
 * without it the queue pauses when it is empty. Each run is logged; a failure (planner not connected …) pauses nothing but is shown.
 */

const DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export interface Slot {
  day: DayKey;
  time: string;
}

/** Valid, sorted, de-duplicated slots (at most 28 a week). */
export function cleanSlots(v: unknown): Slot[] {
  const seen = new Set<string>();
  const out: Slot[] = [];
  for (const s of Array.isArray(v) ? v : []) {
    const day = String((s as any)?.day ?? '') as DayKey;
    const time = String((s as any)?.time ?? '');
    if (!DAYS.includes(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || seen.has(`${day}${time}`)) continue;
    seen.add(`${day}${time}`);
    out.push({ day, time });
  }
  return out.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.time.localeCompare(b.time)).slice(0, 28);
}

/** The next slot strictly after `after` in the zone `tz`, or null without slots. */
export function nextSlot(slots: Slot[], after: Date, tz: string): Date | null {
  if (!slots.length) return null;
  const today = ymdInTz(after, tz);
  for (let i = 0; i <= 7; i++) {
    const ymd = addDaysYmd(today, i);
    const day = weekdayKey(ymd);
    const hits = slots
      .filter((s) => s.day === day)
      .map((s) => zonedToUtc(ymd, s.time, tz))
      .filter((d) => d.getTime() > after.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    if (hits.length) return hits[0];
  }
  return null;
}

export const socialQueuesModule: Module = {
  name: 'social-queues',
  migrations: [
    [
      '001-init',
      `CREATE TABLE social_queues (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, integration_ids TEXT NOT NULL DEFAULT '[]', slots TEXT NOT NULL DEFAULT '[]',
        recycle INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 0, next_at TEXT, last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX social_queues_due ON social_queues(active, next_at);
      CREATE TABLE social_queue_items (
        id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES social_queues(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        content TEXT NOT NULL, upload_ids TEXT NOT NULL DEFAULT '[]', used_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX social_queue_items_queue ON social_queue_items(queue_id, used_count, created_at);
      CREATE TABLE social_queue_runs (
        id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES social_queues(id) ON DELETE CASCADE,
        item_id TEXT, ok INTEGER NOT NULL, message TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
      );
      CREATE INDEX social_queue_runs_queue ON social_queue_runs(queue_id, at);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';
    const queueOr404 = (ctx: Ctx) => {
      const q = parseJson(db.get('SELECT * FROM social_queues WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['integration_ids', 'slots']);
      if (!q) throw notFound('Kategorie nicht gefunden');
      return q;
    };
    const itemsOf = (qid: string) => parseRows(db.all('SELECT * FROM social_queue_items WHERE queue_id = ? ORDER BY used_count, created_at', qid), ['upload_ids']);
    const full = (q: any) => ({
      ...q,
      active: !!q.active,
      recycle: !!q.recycle,
      items: itemsOf(q.id),
      runs: db.all('SELECT * FROM social_queue_runs WHERE queue_id = ? ORDER BY at DESC LIMIT 10', q.id),
    });
    const plan = (q: any, after = new Date()) => (q.active ? nextSlot(cleanSlots(q.slots), after, tzOf(q.location_id))?.toISOString() ?? null : null);

    router.get('/api/social-queues', 'location', (ctx) => parseRows(db.all('SELECT * FROM social_queues WHERE location_id = ? ORDER BY name', ctx.locationId), ['integration_ids', 'slots']).map(full));
    router.post('/api/social-queues', 'location', (ctx) => {
      const q = {
        id: id(),
        location_id: ctx.locationId,
        name: str(ctx.body?.name, 'Name', { required: true, max: 80 }),
        integration_ids: Array.isArray(ctx.body?.integration_ids) ? ctx.body.integration_ids.map(String).slice(0, 20) : [],
        slots: cleanSlots(ctx.body?.slots),
        recycle: ctx.body?.recycle === false ? 0 : 1,
        active: 0,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('social_queues', q);
      return full(parseJson(db.get('SELECT * FROM social_queues WHERE id = ?', q.id), ['integration_ids', 'slots']));
    });
    router.patch('/api/social-queues/:id', 'location', (ctx) => {
      const q = queueOr404(ctx);
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (Array.isArray(ctx.body?.integration_ids)) patch.integration_ids = ctx.body.integration_ids.map(String).slice(0, 20);
      if (ctx.body?.slots !== undefined) patch.slots = cleanSlots(ctx.body.slots);
      if (ctx.body?.recycle !== undefined) patch.recycle = ctx.body.recycle ? 1 : 0;
      if (ctx.body?.active !== undefined) patch.active = ctx.body.active ? 1 : 0;
      const next = { ...q, ...patch };
      if (patch.active && !(next.integration_ids as string[]).length) throw bad('Erst Kanäle wählen');
      if (patch.active && !cleanSlots(next.slots).length) throw bad('Erst Zeiten im Wochenplan festlegen');
      if (patch.active && !itemsOf(q.id).length) throw bad('Erst Posts in die Kategorie legen');
      patch.next_at = plan(next);
      if (patch.active) patch.last_error = '';
      db.update('social_queues', q.id, patch);
      return full(parseJson(db.get('SELECT * FROM social_queues WHERE id = ?', q.id), ['integration_ids', 'slots']));
    });
    router.delete('/api/social-queues/:id', 'location', (ctx) => {
      db.run('DELETE FROM social_queues WHERE id = ? AND location_id = ?', queueOr404(ctx).id, ctx.locationId);
      return { ok: true };
    });
    router.post('/api/social-queues/:id/items', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const q = queueOr404(ctx);
      const list: any[] = Array.isArray(ctx.body?.items) ? ctx.body.items : [ctx.body ?? {}];
      if (itemsOf(q.id).length + list.length > 500) throw bad('Höchstens 500 Posts je Kategorie');
      for (const it of list) db.insert('social_queue_items', { id: id(), queue_id: q.id, location_id: ctx.locationId, content: str(it?.content, 'Text', { required: true, max: 63_000 }), upload_ids: Array.isArray(it?.upload_ids) ? it.upload_ids.map(String).slice(0, 4) : [], created_at: now() });
      return full(q);
    });
    router.patch('/api/social-queues/:id/items/:item', 'location', (ctx) => {
      const q = queueOr404(ctx);
      const content = str(ctx.body?.content, 'Text', { required: true, max: 63_000 });
      if (!db.run('UPDATE social_queue_items SET content = ? WHERE id = ? AND queue_id = ?', content, ctx.params.item, q.id).changes) throw notFound('Post nicht gefunden');
      return full(q);
    });
    router.delete('/api/social-queues/:id/items/:item', 'location', (ctx) => {
      const q = queueOr404(ctx);
      db.run('DELETE FROM social_queue_items WHERE id = ? AND queue_id = ?', ctx.params.item, q.id);
      return full(q);
    });
    /** The next slots with the post each would use – what the team sees before switching a queue on. */
    router.get('/api/social-queues/:id/preview', 'location', (ctx) => {
      const q = queueOr404(ctx);
      const items = itemsOf(q.id);
      const slots = cleanSlots(q.slots);
      const out: { at: string; item_id: string | null; content: string }[] = [];
      let at = new Date();
      const used = new Map(items.map((i) => [i.id, i.used_count as number]));
      for (let n = 0; n < 8; n++) {
        const next = nextSlot(slots, at, tzOf(q.location_id));
        if (!next) break;
        const pool = [...items].sort((a, b) => (used.get(a.id)! - used.get(b.id)!) || String(a.created_at).localeCompare(String(b.created_at)));
        const pick = q.recycle || (pool[0] && used.get(pool[0].id) === 0) ? pool[0] : undefined;
        out.push({ at: next.toISOString(), item_id: pick?.id ?? null, content: pick ? String(pick.content).slice(0, 140) : '' });
        if (pick) used.set(pick.id, used.get(pick.id)! + 1);
        at = next;
      }
      return out;
    });

    /** Posts the next item of a queue now (the scheduler at a slot, or "Jetzt posten"). */
    async function runQueue(q: any, manual = false): Promise<{ ok: boolean; message: string; item_id?: string }> {
      const items = itemsOf(q.id);
      const pick = items.find((i) => q.recycle || i.used_count === 0);
      const at = new Date();
      if (!pick) {
        db.run("UPDATE social_queues SET active = 0, next_at = NULL, last_error = ?, updated_at = ? WHERE id = ?", 'Alle Posts verwendet – Kategorie pausiert', now(), q.id);
        db.insert('social_queue_runs', { id: id(), queue_id: q.id, item_id: null, ok: 0, message: 'Keine unbenutzten Posts mehr', at: now() });
        return { ok: false, message: 'Keine unbenutzten Posts mehr' };
      }
      let ok = true;
      let message = 'Gepostet';
      try {
        if (!app.services.socialPost) throw new Error('Social Planner nicht verfügbar');
        await app.services.socialPost(q.location_id, { integrationIds: q.integration_ids, content: pick.content, type: 'now', uploadIds: pick.upload_ids, source: `Evergreen: ${q.name}` });
        db.run('UPDATE social_queue_items SET used_count = used_count + 1, last_used_at = ? WHERE id = ?', now(), pick.id);
      } catch (e) {
        ok = false;
        message = String((e as Error).message).slice(0, 300);
      }
      db.insert('social_queue_runs', { id: id(), queue_id: q.id, item_id: pick.id, ok: ok ? 1 : 0, message, at: now() });
      db.run('DELETE FROM social_queue_runs WHERE queue_id = ? AND id NOT IN (SELECT id FROM social_queue_runs WHERE queue_id = ? ORDER BY at DESC LIMIT 50)', q.id, q.id);
      if (!manual) db.run('UPDATE social_queues SET next_at = ?, last_error = ?, updated_at = ? WHERE id = ?', plan(q, at), ok ? '' : message, now(), q.id);
      else db.run('UPDATE social_queues SET last_error = ?, updated_at = ? WHERE id = ?', ok ? '' : message, now(), q.id);
      return { ok, message, item_id: pick.id };
    }
    router.post('/api/social-queues/:id/run', 'location', async (ctx) => {
      const q = queueOr404(ctx);
      if (!itemsOf(q.id).length) throw bad('Die Kategorie hat keine Posts');
      if (!(q.integration_ids as string[]).length) throw bad('Erst Kanäle wählen');
      const r = await runQueue(q, true);
      return { ...r, queue: full(parseJson(db.get('SELECT * FROM social_queues WHERE id = ?', q.id), ['integration_ids', 'slots'])) };
    });

    // The scheduler: due queues, a few per tick.
    let busy = false;
    app.onTick(async () => {
      if (busy) return;
      busy = true;
      try {
        const due = parseRows(db.all('SELECT * FROM social_queues WHERE active = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 10', now()), ['integration_ids', 'slots']);
        for (const q of due) await runQueue(q);
      } finally {
        busy = false;
      }
    });
    app.services.socialQueues = { run: (queueId: string) => {
      const q = parseJson(db.get('SELECT * FROM social_queues WHERE id = ?', queueId), ['integration_ids', 'slots']);
      return q ? runQueue(q) : undefined;
    } };

    // --- MCP ---------------------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_social_queues',
        title: 'Evergreen-Kategorien anzeigen',
        description: 'Listet die Evergreen-Kategorien (Warteschlangen wiederverwendbarer Social-Posts) mit Wochenplan, Kanälen, Posts, nächstem Termin und letzten Läufen.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call, a) => call.api('GET', '/api/social-queues', { location: a.location_id }),
      },
      {
        name: 'ghl_social_queue_add',
        title: 'Posts in eine Evergreen-Kategorie legen',
        description: 'Fügt einer Evergreen-Kategorie einen oder mehrere wiederverwendbare Posts hinzu (Texte). Die Kategorie postet sie zu ihren Wochenplan-Zeiten.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, queue_id: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } }, required: ['location_id', 'queue_id', 'items'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: (call, a) => call.api('POST', `/api/social-queues/${encodeURIComponent(a.queue_id)}/items`, { location: a.location_id, body: { items: a.items } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
