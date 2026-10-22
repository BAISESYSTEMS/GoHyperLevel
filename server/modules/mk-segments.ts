import type { Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { bad, clampLimit, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { contactName } from '../services/contacts.js';
import { CONDITION_TYPES, FIELD_COLUMNS, MAX_DEPTH, MAX_NODES, cleanDefinition, countMembers, describe, getSegment, listMembers, listSegments, memberIds, type Group, type SegmentRow } from '../services/mk-segments.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Behaviour segments (docs/email-marketing.md): the saved definitions with their live count, the catalogue the builder needs, and
 * the membership watcher that starts workflows when a contact enters or leaves a segment. Campaigns use a segment as their
 * audience (`filter.segment_id`, services/campaign-run.ts).
 */

const WATCH_EVERY_MS = 5 * 60_000;
/** Segments looked at per run, and the longest a run may take before it leaves the rest for the next one. */
const WATCH_PER_RUN = 40;
const WATCH_BUDGET_MS = 4000;
const WATCH_BATCH = 1000;

const TRIGGERS: TriggerMeta[] = [
  {
    type: 'segment.entered',
    label: 'Kontakt tritt einem Segment bei',
    category: 'marketing',
    summary: 'Ein Kontakt erfüllt die Bedingungen eines Segments neu (z. B. hat die Mail geklickt, aber nicht gekauft).',
    doc: 'Gilt für Segmente mit „Beitritt und Austritt beobachten“. Die Mitgliedschaft wird alle paar Minuten neu berechnet; wer neu dazukommt, startet den Workflow. Beim Einschalten werden die bisherigen Mitglieder nur gemerkt – sie lösen nichts aus. Segment-ID leer = jedes beobachtete Segment. {{event.segmentName}} nennt das Segment.',
    fields: [{ key: 'segment_id', label: 'Segment-ID', type: 'text', help: 'Aus Kampagnen → Segmente; leer = jedes beobachtete Segment' }],
    sample: { segmentId: 's1', segmentName: 'Interessenten ohne Kauf' },
    keywords: 'segment beitritt eintritt zielgruppe verhalten',
  },
  {
    type: 'segment.left',
    label: 'Kontakt verlässt ein Segment',
    category: 'marketing',
    summary: 'Ein Kontakt erfüllt die Bedingungen eines Segments nicht mehr (z. B. hat gekauft).',
    doc: 'Gegenstück zu „tritt einem Segment bei“ für Segmente mit „Beitritt und Austritt beobachten“. Typisch: eine Warteschleife beenden, sobald jemand nicht mehr zur Zielgruppe gehört.',
    fields: [{ key: 'segment_id', label: 'Segment-ID', type: 'text', help: 'Leer = jedes beobachtete Segment' }],
    sample: { segmentId: 's1', segmentName: 'Interessenten ohne Kauf' },
    keywords: 'segment austritt verlassen zielgruppe',
  },
];

const DEFINITION_HELP =
  `Definition: {type:"group", op:"and"|"or", items:[…]} – Elemente sind Bedingungen oder weitere Gruppen (höchstens ${MAX_DEPTH} Ebenen, ${MAX_NODES} Bedingungen). ` +
  'Bedingungen: {type:"tag", tag, has:true|false} · {type:"field", field:"city"|"custom.key", op:"eq|neq|contains|not_contains|starts|empty|not_empty|gt|lt|gte|lte|before|after", value} · ' +
  '{type:"email", event:"opened|clicked|not_opened|received", campaign_id?, days?} · {type:"page", url_contains, days?} · {type:"purchase", product_id?, bought:true|false, days?} · ' +
  '{type:"form", form_id?, submitted:true|false, days?} · {type:"consent", channel:"email|sms|whatsapp", state:"granted|missing"} · {type:"activity", op:"within|older_than|never", days} · ' +
  '{type:"created", op:"within|older_than", days} · {type:"engagement", state:"active|inactive", days, min_received?} · {type:"email_check", verdict:"ok|risky|invalid|unchecked"} · {type:"dnd", value:true|false} · {type:"segment", segment_id}. ' +
  'Jede Bedingung kann mit negate:true umgekehrt werden.';

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_segments',
    title: 'Segmente',
    description: 'Gespeicherte Verhaltens-Segmente eines Projekts mit Mitgliederzahl und einer Beschreibung in Klartext. Segmente lassen sich als Zielgruppe von Kampagnen (filter.segment_id) und als Auslöser von Workflows (Segment-Beitritt) verwenden.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const list: any[] = await call.api('GET', '/api/segments', { location: a.location_id });
      return list.map((s) => ({ id: s.id, name: s.name, description: s.description, count: s.count, counted_at: s.counted_at, watch: !!s.watch, summary: s.summary }));
    },
  },
  {
    name: 'ghl_segment_count',
    title: 'Segment zählen',
    description: `Zählt live, wie viele Kontakte ein Segment (segment_id) oder eine noch nicht gespeicherte Definition treffen, mit Beispielkontakten. ${DEFINITION_HELP}`,
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, segment_id: { type: 'string' }, definition: { type: 'object' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (a.segment_id) {
        const s = await call.api('GET', `/api/segments/${encodeURIComponent(a.segment_id)}/contacts?limit=10`, { location: a.location_id });
        return { count: s.total, summary: s.summary, sample: s.contacts };
      }
      if (!a.definition) throw new Error('segment_id oder definition angeben');
      return call.api('POST', '/api/segments/count', { location: a.location_id, body: { definition: a.definition } });
    },
  },
  {
    name: 'ghl_save_segment',
    title: 'Segment speichern',
    description: `Legt ein Segment an (ohne id) oder ändert es. watch:true startet Workflows mit dem Auslöser „Segment-Beitritt“ bzw. „-Austritt“. ${DEFINITION_HELP}`,
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, id: { type: 'string', description: 'Segment ändern statt neu anlegen' }, name: { type: 'string' }, description: { type: 'string' }, definition: { type: 'object' }, watch: { type: 'boolean' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const body: Record<string, unknown> = {};
      for (const k of ['name', 'description', 'definition', 'watch']) if (a[k] !== undefined) body[k] = a[k];
      const s = a.id ? await call.api('PATCH', `/api/segments/${encodeURIComponent(a.id)}`, { body, location: a.location_id }) : await call.api('POST', '/api/segments', { body, location: a.location_id });
      return { id: s.id, name: s.name, count: s.count, summary: s.summary };
    },
  },
];

export const mkSegmentsModule: Module = {
  name: 'mk-segments',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE mk_segments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL DEFAULT '{}',
        watch INTEGER NOT NULL DEFAULT 0, watched_at TEXT, count INTEGER, counted_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX mk_segments_loc ON mk_segments(location_id, name);
      CREATE TABLE mk_segment_members (
        segment_id TEXT NOT NULL REFERENCES mk_segments(id) ON DELETE CASCADE, contact_id TEXT NOT NULL,
        PRIMARY KEY (segment_id, contact_id)
      ) WITHOUT ROWID;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, TRIGGERS);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'segment.entered': (c: Record<string, any>, d: Record<string, any>) => !c.segment_id || c.segment_id === d.segmentId,
      'segment.left': (c: Record<string, any>, d: Record<string, any>) => !c.segment_id || c.segment_id === d.segmentId,
    };

    /** Names for the plain-language summary (one lookup per kind, only when the definition mentions it). */
    const summarize = (locationId: string, def: Group): string => {
      const text = JSON.stringify(def);
      const names = (table: string, col = 'name') => {
        const map = new Map(db.all<{ id: string; n: string }>(`SELECT id, ${col} AS n FROM ${table} WHERE location_id = ?`, locationId).map((r) => [r.id, r.n]));
        return (x: string) => map.get(x) ?? x;
      };
      return describe(def, {
        campaign: text.includes('"campaign_id"') ? names('campaigns') : undefined,
        form: text.includes('"form_id"') ? names('forms') : undefined,
        product: text.includes('"product_id"') ? names('products') : undefined,
        segment: text.includes('"segment_id"') ? names('mk_segments') : undefined,
      });
    };
    const out = (s: SegmentRow) => ({ ...s, summary: summarize(s.location_id, s.definition) });

    router.get('/api/segments', 'location', (ctx) => listSegments(app, ctx.locationId).map(out));

    /** What the builder needs to offer: condition types and the things a condition can point at. */
    router.get('/api/segments/meta', 'location', (ctx) => {
      const l = ctx.locationId;
      return {
        types: CONDITION_TYPES,
        fields: FIELD_COLUMNS,
        custom_fields: db.all('SELECT key, label, type FROM custom_fields WHERE location_id = ? ORDER BY position', l),
        campaigns: db.all(`SELECT id, name, channel, status FROM campaigns WHERE location_id = ? AND status IN ('sending', 'sent', 'testing') ORDER BY created_at DESC LIMIT 200`, l),
        forms: db.all('SELECT id, name FROM forms WHERE location_id = ? ORDER BY name', l),
        products: db.all('SELECT id, name FROM products WHERE location_id = ? ORDER BY name', l),
        tags: db.all('SELECT name FROM tags WHERE location_id = ? ORDER BY name', l).map((t) => t.name),
        segments: db.all('SELECT id, name FROM mk_segments WHERE location_id = ? ORDER BY name', l),
        limits: { depth: MAX_DEPTH, nodes: MAX_NODES },
      };
    });

    /** Live count while editing: nothing is saved. */
    router.post('/api/segments/count', 'location', (ctx) => {
      const def = cleanDefinition(ctx.body?.definition);
      const sample = listMembers(app, ctx.locationId, def, { limit: 5 }).map((c) => ({ id: c.id, name: contactName(c), email: c.email }));
      return { count: countMembers(app, ctx.locationId, def), sample, summary: summarize(ctx.locationId, def) };
    });

    router.post('/api/segments', 'location', (ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 120 });
      const def = cleanDefinition(ctx.body?.definition);
      if ((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mk_segments WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= 200) throw bad('Höchstens 200 Segmente');
      const row = { id: id(), location_id: ctx.locationId, name, description: str(ctx.body?.description, 'Beschreibung', { max: 500 }), definition: def, watch: ctx.body?.watch ? 1 : 0, count: countMembers(app, ctx.locationId, def), counted_at: now(), created_at: now(), updated_at: now() };
      db.insert('mk_segments', row);
      return out(getSegment(app, ctx.locationId, row.id)!);
    });
    router.get('/api/segments/:id', 'location', (ctx) => {
      const s = getSegment(app, ctx.locationId, ctx.params.id);
      if (!s) throw notFound();
      return out(s);
    });
    router.patch('/api/segments/:id', 'location', (ctx) => {
      const s = getSegment(app, ctx.locationId, ctx.params.id);
      if (!s) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      if (ctx.body?.description !== undefined) patch.description = str(ctx.body.description, 'Beschreibung', { max: 500 });
      if (ctx.body?.definition !== undefined) {
        const def = cleanDefinition(ctx.body.definition);
        // A segment must not point at itself, directly or through others (checked when it is compiled).
        const text = JSON.stringify(def);
        if (text.includes(`"segment_id":"${s.id}"`)) throw bad('Ein Segment kann sich nicht selbst enthalten');
        patch.definition = def;
        patch.count = countMembers(app, ctx.locationId, def, new Date(), [s.id]);
        patch.counted_at = now();
        // The members of a changed definition are a new baseline for the watcher.
        patch.watched_at = null;
        db.run('DELETE FROM mk_segment_members WHERE segment_id = ?', s.id);
      }
      if (ctx.body?.watch !== undefined) {
        patch.watch = ctx.body.watch ? 1 : 0;
        if (patch.watch !== s.watch) {
          patch.watched_at = null;
          db.run('DELETE FROM mk_segment_members WHERE segment_id = ?', s.id);
        }
      }
      db.update('mk_segments', s.id, patch, ctx.locationId);
      return out(getSegment(app, ctx.locationId, s.id)!);
    });
    router.delete('/api/segments/:id', 'location', (ctx) => {
      const s = getSegment(app, ctx.locationId, ctx.params.id);
      if (!s) return { ok: true };
      const used = db.get<{ name: string }>(`SELECT name FROM campaigns WHERE location_id = ? AND status IN ('draft', 'scheduled', 'sending') AND json_extract(filter, '$.segment_id') = ? LIMIT 1`, ctx.locationId, s.id);
      if (used) throw bad(`Das Segment wird von der Kampagne „${used.name}“ verwendet`);
      const wf = db.get<{ name: string }>(`SELECT name FROM workflows WHERE location_id = ? AND status = 'active' AND json_extract(trigger, '$.config.segment_id') = ? LIMIT 1`, ctx.locationId, s.id);
      if (wf) throw bad(`Das Segment startet den Workflow „${wf.name}“`);
      const inOther = db.get<{ name: string }>(`SELECT name FROM mk_segments WHERE location_id = ? AND id != ? AND definition LIKE ? LIMIT 1`, ctx.locationId, s.id, `%"segment_id":"${s.id}"%`);
      if (inOther) throw bad(`Das Segment ist Teil von „${inOther.name}“`);
      db.run('DELETE FROM mk_segments WHERE id = ? AND location_id = ?', s.id, ctx.locationId);
      return { ok: true };
    });
    /** Members (newest first) with the total; also refreshes the stored count. */
    router.get('/api/segments/:id/contacts', 'location', (ctx) => {
      const s = getSegment(app, ctx.locationId, ctx.params.id);
      if (!s) throw notFound();
      const def = cleanDefinition(s.definition);
      const total = countMembers(app, ctx.locationId, def, new Date(), [s.id]);
      db.run('UPDATE mk_segments SET count = ?, counted_at = ? WHERE id = ?', total, now(), s.id);
      const contacts = listMembers(app, ctx.locationId, def, { limit: clampLimit(ctx.query.get('limit'), 50, 200), offset: Math.max(0, Math.floor(Number(ctx.query.get('offset')) || 0)) });
      return { total, summary: summarize(ctx.locationId, def), contacts: contacts.map((c) => ({ id: c.id, name: contactName(c), email: c.email, phone: c.phone, tags: c.tags })) };
    });
    router.post('/api/segments/:id/count', 'location', (ctx) => {
      const s = getSegment(app, ctx.locationId, ctx.params.id);
      if (!s) throw notFound();
      const count = countMembers(app, ctx.locationId, cleanDefinition(s.definition), new Date(), [s.id]);
      db.run('UPDATE mk_segments SET count = ?, counted_at = ? WHERE id = ?', count, now(), s.id);
      return { count, counted_at: now() };
    });

    // --- watcher: workflows start when somebody enters or leaves ------------------------------------------------------------
    let lastWatch = 0;
    const watch = (s: SegmentRow): { entered: number; left: number } => {
      const ids = new Set(memberIds(app, s.location_id, cleanDefinition(s.definition), [s.id]));
      const current = new Set(db.all<{ contact_id: string }>('SELECT contact_id FROM mk_segment_members WHERE segment_id = ?', s.id).map((r) => r.contact_id));
      if (!s.watched_at) {
        // First run: the members are only remembered, nobody is announced.
        db.tx(() => {
          for (const cid of ids) db.run('INSERT OR IGNORE INTO mk_segment_members (segment_id, contact_id) VALUES (?, ?)', s.id, cid);
          db.run('UPDATE mk_segments SET watched_at = ?, count = ?, counted_at = ? WHERE id = ?', now(), ids.size, now(), s.id);
        });
        return { entered: 0, left: 0 };
      }
      const entered = [...ids].filter((c) => !current.has(c)).slice(0, WATCH_BATCH);
      const left = [...current].filter((c) => !ids.has(c)).slice(0, WATCH_BATCH);
      db.tx(() => {
        for (const cid of entered) db.run('INSERT OR IGNORE INTO mk_segment_members (segment_id, contact_id) VALUES (?, ?)', s.id, cid);
        for (const cid of left) db.run('DELETE FROM mk_segment_members WHERE segment_id = ? AND contact_id = ?', s.id, cid);
        db.run('UPDATE mk_segments SET count = ?, counted_at = ? WHERE id = ?', ids.size, now(), s.id);
      });
      for (const cid of entered) app.events.emit(s.location_id, 'segment.entered', { contactId: cid, segmentId: s.id, segmentName: s.name });
      for (const cid of left) if (db.get('SELECT 1 FROM contacts WHERE id = ? AND location_id = ?', cid, s.location_id)) app.events.emit(s.location_id, 'segment.left', { contactId: cid, segmentId: s.id, segmentName: s.name });
      return { entered: entered.length, left: left.length };
    };
    /** For tests and the "jetzt prüfen" case: runs the watcher over the watched segments at once. */
    /** The watched segments, the one looked at longest ago first – with a fixed order the same 40 would be checked forever and the rest never. */
    const watched = (locationId?: string) =>
      parseRows(db.all(`SELECT * FROM mk_segments WHERE watch = 1${locationId ? ' AND location_id = ?' : ''} ORDER BY COALESCE(counted_at, ''), updated_at LIMIT ${WATCH_PER_RUN}`, ...(locationId ? [locationId] : [])), ['definition']) as SegmentRow[];
    app.services.mkWatchSegments = (locationId?: string) => {
      const rows = watched(locationId);
      let entered = 0;
      let left = 0;
      for (const s of rows) {
        try {
          const r = watch(s);
          entered += r.entered;
          left += r.left;
        } catch (e) {
          console.error('[segments] Beobachtung fehlgeschlagen', s.id, (e as Error).message);
        }
      }
      return { entered, left };
    };
    // In the background one segment at a time with a pause in between (each is a pass over the sub-account's contacts), and
    // for a limited time per run: what is left is next, the least recently looked at first.
    app.onTick(async () => {
      if (Date.now() - lastWatch < WATCH_EVERY_MS) return;
      lastWatch = Date.now();
      const started = Date.now();
      for (const s of watched()) {
        if (Date.now() - started > WATCH_BUDGET_MS) break;
        try {
          watch(s);
        } catch (e) {
          console.error('[segments] Beobachtung fehlgeschlagen', s.id, (e as Error).message);
        }
        await new Promise<void>((r) => setImmediate(r));
      }
    });
  },
};

