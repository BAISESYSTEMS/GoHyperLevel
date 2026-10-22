import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { contactVars, getContact } from '../services/contacts.js';
import type { SnapshotPart } from '../services/snapshots.js';
import { tableEntity } from '../services/undo-table.js';

/**
 * Call scripts in the dialer (docs/telephony.md#call-scripts): a script is a list of steps – text with placeholders
 * (`{{contact.first_name}}`, `{{location.name}}` …) and answer buttons that jump to another step (branches). A script applies to
 * chosen power-dialer lists or pipelines (or everywhere when none is chosen) and may name a call scorecard. The browser phone
 * and the power dialer show it through the UI slot `call.panel` (web/src/slots.tsx).
 */

interface Step {
  id: string;
  title: string;
  text: string;
  options: { label: string; next: string }[];
}

const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))].slice(0, 100) : []);

/** Steps with ids, at most 50 steps of 4,000 characters and 8 answers each; answers point at existing steps or '' (end). */
export function cleanSteps(input: unknown): Step[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Mindestens ein Schritt');
  const steps = input.slice(0, 50).map((s: any, i: number) => ({
    id: typeof s?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) ? s.id : id(8),
    title: String(s?.title ?? '').trim().slice(0, 120) || `Schritt ${i + 1}`,
    text: String(s?.text ?? '').slice(0, 4000),
    options: Array.isArray(s?.options) ? s.options.slice(0, 8).map((o: any) => ({ label: String(o?.label ?? '').trim().slice(0, 80), next: String(o?.next ?? '') })).filter((o: { label: string }) => o.label) : [],
  }));
  const known = new Set(steps.map((s) => s.id));
  for (const s of steps) for (const o of s.options) if (o.next && !known.has(o.next)) o.next = '';
  return steps;
}

export const callScriptsModule: Module = {
  name: 'call-scripts',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE call_scripts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', dialer_list_ids TEXT NOT NULL DEFAULT '[]', pipeline_ids TEXT NOT NULL DEFAULT '[]',
        scorecard_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX call_scripts_loc ON call_scripts(location_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const JSON_COLS = ['steps', 'dialer_list_ids', 'pipeline_ids'];
    const get = (loc: string, sid: string) => parseJson(db.get('SELECT * FROM call_scripts WHERE id = ? AND location_id = ?', sid, loc), JSON_COLS);
    const asBad = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        throw bad((e as Error).message);
      }
    };
    /** Only references into this sub-account are kept. */
    const own = (table: string, loc: string, list: string[]) => list.filter((x) => db.get(`SELECT 1 AS x FROM ${table} WHERE id = ? AND location_id = ?`, x, loc));
    const fields = (loc: string, b: any, partial: boolean) => {
      const out: Record<string, unknown> = {};
      if (!partial || b.name !== undefined) out.name = str(b.name, 'Name', { required: true, max: 100 });
      if (!partial || b.steps !== undefined) out.steps = asBad(() => cleanSteps(b.steps));
      if (b.dialer_list_ids !== undefined) out.dialer_list_ids = own('dialer_lists', loc, ids(b.dialer_list_ids));
      if (b.pipeline_ids !== undefined) out.pipeline_ids = own('pipelines', loc, ids(b.pipeline_ids));
      if (b.scorecard_id !== undefined) {
        const sc = b.scorecard_id ? String(b.scorecard_id) : null;
        if (sc && !db.get('SELECT 1 AS x FROM call_scorecards WHERE id = ? AND location_id = ?', sc, loc)) throw bad('Scorecard nicht gefunden');
        out.scorecard_id = sc;
      }
      if (b.active !== undefined) out.active = b.active ? 1 : 0;
      return out;
    };

    router.get('/api/call-scripts', 'location', (ctx) => parseRows(db.all('SELECT * FROM call_scripts WHERE location_id = ? ORDER BY name', ctx.locationId), JSON_COLS));
    router.post('/api/call-scripts', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, dialer_list_ids: [], pipeline_ids: [], scorecard_id: null, active: 1, ...fields(ctx.locationId, ctx.body ?? {}, false), created_at: now(), updated_at: now() };
      db.insert('call_scripts', row);
      return get(ctx.locationId, row.id);
    });
    router.patch('/api/call-scripts/:id', 'location', (ctx) => {
      const cur = get(ctx.locationId, ctx.params.id);
      if (!cur) throw notFound('Gesprächsleitfaden nicht gefunden');
      db.update('call_scripts', cur.id, { ...fields(ctx.locationId, ctx.body ?? {}, true), updated_at: now() }, ctx.locationId);
      return get(ctx.locationId, cur.id);
    });
    router.delete('/api/call-scripts/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM call_scripts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Gesprächsleitfaden nicht gefunden');
      return { ok: true };
    });

    /**
     * The script for a call: one of the dialer list, else one of a pipeline the contact has an open deal in, else one without
     * a scope – placeholders filled with the contact. `{script: null}` when none applies.
     */
    router.get('/api/call-scripts/for', 'location', (ctx) => {
      const listId = ctx.query.get('list_id') ?? '';
      const contactId = ctx.query.get('contact_id') ?? '';
      const contact = contactId ? getContact(app, ctx.locationId, contactId) : undefined;
      if (contactId && !contact) throw notFound('Kontakt nicht gefunden');
      const all = parseRows(db.all('SELECT * FROM call_scripts WHERE location_id = ? AND active = 1 ORDER BY updated_at DESC', ctx.locationId), JSON_COLS);
      const pipes = contact ? db.all<{ pipeline_id: string }>(`SELECT DISTINCT pipeline_id FROM opportunities WHERE contact_id = ? AND location_id = ? AND status = 'open'`, contact.id, ctx.locationId).map((r) => r.pipeline_id) : [];
      const pick =
        (listId && all.find((s) => s.dialer_list_ids.includes(listId))) ||
        all.find((s) => s.pipeline_ids.some((p: string) => pipes.includes(p))) ||
        all.find((s) => !s.dialer_list_ids.length && !s.pipeline_ids.length);
      if (!pick) return { script: null, others: all.map((s) => ({ id: s.id, name: s.name })) };
      const loc = app.location(ctx.locationId);
      const vars = { contact: contactVars(contact as any), location: { name: loc?.name ?? '', phone: loc?.phone ?? '', email: loc?.email ?? '' } };
      const scorecard = pick.scorecard_id ? db.get('SELECT id, name FROM call_scorecards WHERE id = ? AND location_id = ?', pick.scorecard_id, ctx.locationId) : null;
      return {
        script: { ...pick, steps: (pick.steps as Step[]).map((s) => ({ ...s, text: render(s.text, vars) })) },
        scorecard: scorecard ?? null,
        others: all.filter((s) => s.id !== pick.id).map((s) => ({ id: s.id, name: s.name })),
      };
    });

    // --- snapshots: scripts are building blocks; pipelines point at the copies, dialer lists and scorecards stay behind -------
    const part: SnapshotPart = {
      key: 'call_scripts',
      export: (_a, loc, only) => (only ? [] : parseRows(db.all('SELECT * FROM call_scripts WHERE location_id = ? ORDER BY name', loc), JSON_COLS).map((s) => ({ name: s.name, steps: s.steps, pipeline_ids: s.pipeline_ids, active: s.active }))),
      apply: (_a, loc, items, c) => {
        let n = 0;
        for (const it of items.slice(0, 200)) {
          let steps: Step[];
          try {
            steps = cleanSteps(it.steps);
          } catch {
            continue;
          }
          const pipelines = ids(it.pipeline_ids).map((p) => c.maps.pipelines?.get(p)).filter(Boolean);
          db.insert('call_scripts', { id: id(), location_id: loc, name: String(it.name ?? 'Leitfaden').slice(0, 100), steps, dialer_list_ids: [], pipeline_ids: pipelines, scorecard_id: null, active: it.active === 0 ? 0 : 1, created_at: now(), updated_at: now() });
          n++;
        }
        c.created.call_scripts = n;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];

    // --- undo ---------------------------------------------------------------------------------------------------------------
    const undo = app.services.undo as { register(type: string, e: unknown): void; track(rule: unknown): void } | undefined;
    if (undo) {
      undo.register('call_script', tableEntity(app, { noun: 'Gesprächsleitfaden', plural: 'Gesprächsleitfäden', area: 'settings', table: 'call_scripts', title: (r) => String(r.name), contactCol: null, volatile: ['updated_at'], fields: { name: { label: 'Name' }, steps: { label: 'Schritte', fmt: 'json' }, active: { label: 'Aktiv' } } }));
      undo.track({ method: 'PATCH', pattern: '/api/call-scripts/:id', entity: 'call_script' });
      undo.track({ method: 'DELETE', pattern: '/api/call-scripts/:id', entity: 'call_script' });
    }
  },
};
