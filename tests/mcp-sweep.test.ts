import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { seedDemo } from '../server/services/demo-seed.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { normalizeArgs } from '../server/modules/mcp.js';

/**
 * Sweep over every MCP tool through the real endpoint (second bug sweep), driven by `tools/list` so a new tool is covered the day it is
 * added. On the demo data each tool is called with its minimal documented arguments, without arguments, with each argument in the wrong
 * type and with arguments that are not an object; then with ids of another sub-account, and with a key for one sub-account pointed at
 * another one. Expected: never a crash (500, JavaScript error text), JSON-RPC errors in German, read-only tools change nothing, writes
 * land in the audit log, nothing of the other sub-account comes back.
 */

const CRASH = /TypeError|ReferenceError|SyntaxError|RangeError|Cannot read|is not a function|is not iterable|\bundefined\b|\[object |Unexpected token|SQLITE|no such column|Unknown named parameter|\(500\)|Interner Fehler/;
/** Rows a read may write: the key's "last used" stamp and the audit log of exports. */
const READ_NOISE = new Set(['agency_api_keys', 'api_keys', 'audit_log']);
/** Read-only tools with a documented side effect: the first look at the planning board creates the "Allgemein" project once; the
 *  mail-domain check keeps its result in the list of domains (its description says so). */
const READ_WRITES: Record<string, string[]> = { ghl_pm_list_projects: ['pm_projects', 'pm_statuses', 'tasks'], ghl_mail_domain_check: ['mail_domains'] };

type T = Awaited<ReturnType<typeof startTestApp>>;
let t: T;
let A = '';
let B = '';
let agencyKey = '';
let readKey = '';
let locKey = '';
let tools: any[] = [];
const serverErrors: string[] = [];

const TABLE: Record<string, string> = {
  contact_id: 'contacts', board_id: 'canvas_boards', task_id: 'tasks', invoice_id: 'invoices', conversation_id: 'conversations', deal_id: 'opportunities',
  opportunity_id: 'opportunities', pipeline_id: 'pipelines', funnel_id: 'funnels', course_id: 'courses', workflow_id: 'workflows', calendar_id: 'calendars',
  review_id: 'google_reviews', project_id: 'pm_projects', webinar_id: 'webinars', sequence_id: 'sequences', quote_id: 'deal_quotes', dashboard_id: 'report_dashboards',
  group_id: 'community_groups', page_id: 'wiki_pages', ticket: 'tickets', campaign_id: 'campaigns', company_id: 'companies', product_id: 'products',
};
const rowOf = (name: string, loc: string): any => {
  const tb = TABLE[name];
  if (!tb) return undefined;
  try {
    return t.app.db.get(`SELECT * FROM ${tb} WHERE location_id = ? ORDER BY rowid LIMIT 1`, loc);
  } catch {
    return undefined;
  }
};
/** A plausible value for an argument: a real id of the demo data, the first enum value, or something of the right type. */
const sample = (name: string, s: any, loc = A): unknown => {
  if (name === 'location_id') return loc;
  const row = rowOf(name, loc);
  if (row) return row.id;
  if (s?.enum) return s.enum[0];
  const type = Array.isArray(s?.type) ? s.type[0] : s?.type;
  if (type === 'integer' || type === 'number') return s.minimum ?? 1;
  if (type === 'boolean') return false;
  if (type === 'array') return s.items?.type === 'object' ? [{}] : ['Sweep'];
  if (type === 'object') return {};
  if (/email/.test(name)) return 'mcp-sweep@example.com';
  if (/url/.test(name)) return 'https://example.com/x';
  if (/date|start|^from$|^to$|due|until|_at$/.test(name)) return '2026-11-02';
  if (name.endsWith('_id') || name === 'id') return 'unbekannt-id';
  return 'Sweep';
};
const wrong = (s: any): unknown => {
  const type = Array.isArray(s?.type) ? s.type[0] : s?.type;
  return type === 'string' ? { x: 1 } : type === 'integer' || type === 'number' ? 'abc' : type === 'boolean' ? 'vielleicht' : type === 'array' ? 'x' : type === 'object' ? 'x' : { x: 1 };
};
const minimal = (tool: any, loc = A) => Object.fromEntries((tool.inputSchema.required ?? []).map((k: string) => [k, sample(k, tool.inputSchema.properties?.[k], loc)]));

async function rpc(key: string, method: string, params: unknown) {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const raw = await r.text();
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    j = { raw };
  }
  const text: string = j.error ? `RPC ${j.error.code} ${j.error.message}` : (j.result?.content?.[0]?.text ?? '');
  return { status: r.status, j, text, ok: !!j.result && !j.result.isError };
}
const call = (name: string, args: unknown, key = agencyKey) => rpc(key, 'tools/call', { name, arguments: args });
/** What is wrong with an answer: a transport problem, an internal JSON-RPC error or a crash in the text. */
const problem = (r: Awaited<ReturnType<typeof rpc>>) =>
  r.status !== 200 ? `HTTP ${r.status}` : r.j.error && ![-32600, -32601, -32602].includes(r.j.error.code) ? `RPC-Code ${r.j.error.code}` : CRASH.test(r.text) ? r.text.slice(0, 200) : '';

/** Tables written since the last reset (temporary triggers on every table). */
function trackChanges() {
  const db = t.app.db;
  db.raw.exec('CREATE TEMP TABLE IF NOT EXISTS _sweep_changes (tbl TEXT)');
  for (const { name } of db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`))
    for (const ev of ['INSERT', 'UPDATE', 'DELETE'])
      try {
        db.raw.exec(`CREATE TEMP TRIGGER IF NOT EXISTS "_sweep_${name}_${ev}" AFTER ${ev} ON main."${name}" BEGIN INSERT INTO _sweep_changes VALUES ('${name}'); END`);
      } catch {
        /* virtual tables */
      }
  return {
    reset: () => db.raw.exec('DELETE FROM _sweep_changes'),
    tables: () => db.all<{ tbl: string }>('SELECT DISTINCT tbl FROM _sweep_changes').map((r) => r.tbl),
  };
}

beforeAll(async () => {
  installOutboundGuard();
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void serverErrors.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ').slice(0, 300)));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  t = await startTestApp();
  await t.setup();
  const seed = await seedDemo(t.app, {});
  [A, B] = [seed.locations[0].id, seed.locations[1].id];
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Sweep' })).data.key;
  readKey = (await t.api.post('/api/agency/api-keys', { name: 'Sweep lesen', scope: 'read' })).data.key;
  t.api.setLocation(A);
  locKey = (await t.api.post('/api/api-keys', { name: 'Sweep A' })).data.key;
  tools = (await rpc(agencyKey, 'tools/list', {})).j.result.tools;
  // read-only tools first, destructive ones last: the later calls still find the demo data
  tools.sort((a, b) => Number(!!b.annotations.readOnlyHint) - Number(!!a.annotations.readOnlyHint) || Number(!!a.annotations.destructiveHint) - Number(!!b.annotations.destructiveHint));
}, 120_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  uninstallOutboundGuard();
});

describe('MCP sweep over every tool', () => {
  it('lists the whole catalogue', () => {
    expect(tools.length).toBeGreaterThanOrEqual(240);
    for (const tool of tools) {
      expect(tool.inputSchema?.type, tool.name).toBe('object');
      for (const r of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties?.[r], `${tool.name}: ${r} ist Pflicht, fehlt aber im Schema`).toBeTruthy();
    }
  });

  it('answers minimal, missing, wrongly typed and non-object arguments without a crash; reads change nothing and writes are audited', async () => {
    const changes = trackChanges();
    const found: string[] = [];
    for (const tool of tools) {
      const props = tool.inputSchema.properties ?? {};
      const args = minimal(tool);
      changes.reset();
      const audit0 = Number(t.app.db.get('SELECT COUNT(*) n FROM audit_log')!.n);
      const e0 = serverErrors.length;
      const r = await call(tool.name, args);
      if (problem(r)) found.push(`${tool.name} minimal: ${problem(r)}`);
      const written = changes.tables().filter((x) => !READ_NOISE.has(x));
      if (tool.annotations.readOnlyHint) {
        const extra = written.filter((x) => !(READ_WRITES[tool.name] ?? []).includes(x));
        if (extra.length) found.push(`${tool.name} ist nur lesend, schreibt aber: ${extra.join(', ')}`);
      } else if (r.ok && written.length) {
        const audited = Number(t.app.db.get(`SELECT COUNT(*) n FROM audit_log WHERE via = 'mcp'`)!.n) > 0 && Number(t.app.db.get('SELECT COUNT(*) n FROM audit_log')!.n) > audit0;
        if (!audited) found.push(`${tool.name} schreibt (${written.join(', ')}) ohne Protokolleintrag`);
      }
      if (serverErrors.slice(e0).some((x) => x.startsWith('[request'))) found.push(`${tool.name} minimal: Serverfehler ${serverErrors.slice(e0).join(' | ')}`);

      const empty = await call(tool.name, {});
      if (problem(empty)) found.push(`${tool.name} ohne Argumente: ${problem(empty)}`);
      if ((tool.inputSchema.required ?? []).length && !(empty.j.error?.code === -32602 && /Fehlende Parameter/.test(empty.j.error.message))) found.push(`${tool.name} ohne Pflichtargumente: ${empty.text.slice(0, 120)}`);
      for (const [k, s] of Object.entries(props)) {
        const w = await call(tool.name, { ...args, [k]: wrong(s) });
        if (problem(w)) found.push(`${tool.name} ${k} falscher Typ: ${problem(w)}`);
        else if (!w.j.error && w.ok && (s as any).type !== undefined && k !== 'location_id') found.push(`${tool.name} ${k} falscher Typ wurde angenommen`);
      }
      for (const bad of ['x', [1, 2], 5]) {
        const n = await call(tool.name, bad);
        if (n.j.error?.code !== -32602) found.push(`${tool.name} Argumente ${JSON.stringify(bad)}: ${n.text.slice(0, 120)}`);
      }
    }
    expect(found).toEqual([]);
  }, 600_000);

  it('never hands out records of another sub-account', async () => {
    const leaks: string[] = [];
    for (const tool of tools) {
      const props = tool.inputSchema.properties ?? {};
      const idProps = Object.keys(props).filter((k) => TABLE[k]);
      if (!idProps.length || !('location_id' in props)) continue;
      const args: Record<string, unknown> = { ...minimal(tool), location_id: A };
      const marks: string[] = [];
      for (const k of idProps) {
        const row = rowOf(k, B);
        if (!row) continue;
        args[k] = row.id;
        marks.push(row.id);
        for (const c of ['email', 'name', 'title', 'subject', 'number']) if (typeof row[c] === 'string' && row[c].length >= 6) marks.push(row[c]);
      }
      if (!marks.length) continue;
      const r = await call(tool.name, args);
      if (problem(r)) leaks.push(`${tool.name}: ${problem(r)}`);
      const seen = marks.filter((m) => r.text.includes(m));
      if (r.ok && seen.length) leaks.push(`${tool.name} gibt Daten aus ${B} zurück: ${seen.join(', ')}`);
    }
    expect(leaks).toEqual([]);
  }, 300_000);

  it('a key for one sub-account cannot be pointed at another one', async () => {
    const open: string[] = [];
    for (const tool of tools) {
      if (!('location_id' in (tool.inputSchema.properties ?? {}))) continue;
      const r = await call(tool.name, { ...minimal(tool, B), location_id: B }, locKey);
      if (r.j.error?.message?.startsWith('Unbekanntes Tool')) continue; // agency-only tools are not offered
      if (r.ok || !/\(403\): Dieser Schlüssel gilt nur für einen Sub-Account/.test(r.text)) open.push(`${tool.name}: ${r.text.slice(0, 120)}`);
    }
    expect(open).toEqual([]);
  }, 300_000);
});

describe('MCP regressions (second bug sweep)', () => {
  it('converts near-miss argument types and refuses wrong ones in German', () => {
    const tool = { name: 'x', inputSchema: { properties: { s: { type: 'string' }, n: { type: 'integer' }, b: { type: 'boolean' }, l: { type: 'array' }, o: { type: 'object' } } } };
    expect(normalizeArgs(tool, { s: 12, n: '5', b: 'false', l: '["a","b"]', o: '{"k":1}', extra: [1] })).toEqual({ s: '12', n: 5, b: false, l: ['a', 'b'], o: { k: 1 }, extra: [1] });
    expect(normalizeArgs(tool, undefined)).toEqual({});
    expect(() => normalizeArgs(tool, { l: 'x' })).toThrow('Parameter „l“ muss eine Liste sein');
    expect(() => normalizeArgs(tool, { o: [1] })).toThrow('Parameter „o“ muss ein Objekt sein');
    expect(() => normalizeArgs(tool, { n: 'abc' })).toThrow('Parameter „n“ muss eine ganze Zahl sein');
    expect(() => normalizeArgs(tool, { s: { a: 1 } })).toThrow('Parameter „s“ muss Text sein');
    expect(() => normalizeArgs(tool, { b: 'vielleicht' })).toThrow('true oder false');
    expect(() => normalizeArgs(tool, 'x')).toThrow('müssen ein Objekt sein');
  });

  it('JSON-RPC: a call without tool name or with non-object arguments is a -32602 in German', async () => {
    const noName = await rpc(agencyKey, 'tools/call', { arguments: {} });
    expect(noName.j.error).toMatchObject({ code: -32602, message: 'Tool-Name fehlt (params.name)' });
    const list = await call('ghl_search_contacts', [A]);
    expect(list.j.error).toMatchObject({ code: -32602, message: 'Die Argumente für ghl_search_contacts müssen ein Objekt sein' });
  });

  it('a stage given as a number is looked up, not a crash', async () => {
    const opp = rowOf('opportunity_id', A);
    const r = await call('ghl_update_opportunity', { location_id: A, opportunity_id: opp.id, stage: 12345 });
    expect(r.text).toContain('Stufe „12345“ nicht gefunden');
  });

  it('a canvas element the scene cannot use is a 400 (it was a 500), and no half-made board is left', async () => {
    const board = rowOf('board_id', A);
    const r = await call('ghl_canvas_add_elements', { location_id: A, board_id: board.id, elements: [{}] });
    expect(r.text).toBe('Fehler (400): Unbekannter Elementtyp: (leer)');
    t.api.setLocation(A);
    const before = Number(t.app.db.get('SELECT COUNT(*) n FROM canvas_boards WHERE location_id = ?', A)!.n);
    const created = await t.api.post('/api/canvas', { name: 'Kaputt', elements: [{ type: 'gibtsnicht' }] });
    expect(created.status).toBe(400);
    expect(Number(t.app.db.get('SELECT COUNT(*) n FROM canvas_boards WHERE location_id = ?', A)!.n)).toBe(before);
  });

  it('an agency connection without location_id is told what is missing', async () => {
    const r = await call('ghl_quote_list', {});
    expect(r.text).toBe('Fehler (400): location_id fehlt – mit einem Agentur-Zugang bitte location_id angeben (aus ghl_list_projects)');
  });

  it('read-only tools work on a read-only connection, write tools and forged markers do not', async () => {
    const report = await call('ghl_run_report', { location_id: A, source: 'contacts' }, readKey);
    expect(report.ok, report.text).toBe(true);
    const calc = await call('ghl_calc_run', { location_id: A }, readKey);
    expect(calc.text).not.toContain('darf nur lesen');
    const write = await call('ghl_create_task', { location_id: A, title: 'Darf nicht' }, readKey);
    expect(write.text).toContain('darf nur lesen');
    // the marker only counts when the relay itself issued it
    const forged = await t.api.raw('/api/reports/run', { method: 'POST', headers: { authorization: `Bearer ${readKey}`, 'x-location-id': A, 'x-pghl-via': 'mcp', 'x-pghl-read-tool': 'erfunden', 'content-type': 'application/json' }, body: JSON.stringify({ source: 'contacts' }) });
    expect(forged.status).toBe(403);
  });

  it('reading a conversation over MCP or with a key leaves it unread for the team', async () => {
    const conv = t.app.db.get<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? LIMIT 1', A)!;
    t.app.db.run('UPDATE conversations SET unread = 2 WHERE id = ?', conv.id);
    const r = await call('ghl_get_conversation', { location_id: A, conversation_id: conv.id });
    expect(r.ok).toBe(true);
    const keyRead = await t.api.raw(`/api/conversations/${conv.id}/messages`, { headers: { authorization: `Bearer ${locKey}` } });
    expect(keyRead.status).toBe(200);
    expect(t.app.db.get('SELECT unread FROM conversations WHERE id = ?', conv.id)!.unread).toBe(2);
    t.api.setLocation(A);
    await t.api.get(`/api/conversations/${conv.id}/messages`); // a person opens it
    expect(t.app.db.get('SELECT unread FROM conversations WHERE id = ?', conv.id)!.unread).toBe(0);
  });
});

describe('MCP sweep with every argument (contract sweep)', () => {
  /** Every property of the schema filled in (objects with their required fields), so the handlers' optional branches run too. */
  const full = (tool: any) => {
    const fill = (s: any, name = ''): unknown => {
      const type = Array.isArray(s?.type) ? s.type[0] : s?.type;
      if (type === 'object' && s?.properties) return Object.fromEntries(Object.entries<any>(s.properties).filter(([k]) => (s.required ?? []).includes(k)).map(([k, v]) => [k, fill(v, k)]));
      if (type === 'array' && s?.items?.enum) return [s.items.enum[0]];
      if (type === 'array' && s?.items?.type === 'object') return [fill(s.items)];
      return sample(name, s);
    };
    return Object.fromEntries(Object.entries<any>(tool.inputSchema.properties ?? {}).map(([k, s]) => [k, fill(s, k)]));
  };

  it('answers every schema-valid input – all properties, each enum value – without a crash, and reads stay reads', async () => {
    const changes = trackChanges();
    const found: string[] = [];
    for (const tool of tools) {
      const args = full(tool);
      const variants: [string, Record<string, unknown>][] = [['alle Argumente', args]];
      for (const [k, s] of Object.entries<any>(tool.inputSchema.properties ?? {})) for (const v of (s.enum ?? []).slice(1)) variants.push([`${k}=${v}`, { ...args, [k]: v }]);
      let first = '';
      for (const [label, a] of variants) {
        changes.reset();
        const e0 = serverErrors.length;
        const r = await call(tool.name, a);
        if (problem(r)) found.push(`${tool.name} ${label}: ${problem(r)}`);
        if (serverErrors.slice(e0).some((x) => x.startsWith('[request'))) found.push(`${tool.name} ${label}: Serverfehler ${serverErrors.slice(e0).join(' | ')}`);
        if (tool.annotations.readOnlyHint) {
          const extra = changes.tables().filter((x) => !READ_NOISE.has(x) && !(READ_WRITES[tool.name] ?? []).includes(x));
          if (extra.length) found.push(`${tool.name} ${label} ist nur lesend, schreibt aber: ${extra.join(', ')}`);
        }
        // a value the schema offers that the handler then refuses as unknown is drift between schema and REST validation
        if (label === 'alle Argumente') first = r.text;
        else {
          const v = label.slice(label.indexOf('=') + 1);
          if (!r.ok && r.text !== first && r.text.includes(v) && /unbekannt|ungültig|gibt es nicht|nicht (erlaubt|unterstützt)/i.test(r.text)) found.push(`${tool.name}: das Schema bietet ${label} an, der Server lehnt es ab: ${r.text.slice(0, 150)}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 600_000);

  it('annotations say what a tool does: deleting tools are destructive, read-only ones are not', () => {
    const wrong: string[] = [];
    for (const tool of tools) {
      const a = tool.annotations;
      if (a.readOnlyHint && a.destructiveHint) wrong.push(`${tool.name}: nur lesend und zerstörend zugleich`);
      if (/(^|_)(delete|remove|purge|erase)(_|$)/.test(tool.name) && (a.readOnlyHint || !a.destructiveHint)) wrong.push(`${tool.name}: löscht, ist aber nicht als destructiveHint markiert`);
      for (const [k, s] of Object.entries<any>(tool.inputSchema.properties ?? {})) {
        const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
        for (const v of s.enum ?? []) if (types.length && !types.some((ty) => (ty === 'integer' ? Number.isInteger(v) : ty === 'number' ? typeof v === 'number' : typeof v === ty))) wrong.push(`${tool.name}.${k}: enum-Wert ${JSON.stringify(v)} passt nicht zum Typ ${types.join('|')}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
