import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { toCsv } from '../core/csv.js';
import { isSealed } from '../core/secrets.js';
import { now } from '../core/util.js';
import { buildZip } from './acc-datev.js';

/**
 * A cloud customer's data, as a whole: the export (ZIP with JSON and CSV per table plus the uploaded files) and the
 * hard delete. Both walk the database the same way: every table with a `location_id` is scoped to the customer's
 * sub-accounts, every table that points (foreign key) at a scoped table is scoped through it. Credentials, tokens
 * and hashes never leave in an export. Files are found by the ids the customer's rows mention, so no module has to
 * register its folder. The cloud modules call this, and the deletion of a sub-account (modules/core.ts).
 */

/** Columns whose names say "credential". */
const HIDDEN = /token|secret|hash|password|sealed|api_?key|webhook_key|^pass$|^key$|^inbound_key$/i;
/** Not the customer's content, never: our own bookkeeping, sessions, the user table, search indexes. */
const NEVER = /^(sqlite_|_migrations$|cloud_|sessions$|users$)|_fts/;
/** Left out of the export as well: connection records with tokens, billing bookkeeping, login setup (they are erased, though). */
const NOT_EXPORTED = /^(saas_|auth_|agency_|login_|sso_|oauth_|mobile_devices$|push_subscriptions$)/;
/** Folders under the data directory that hold customers' files. */
const FILE_DIRS = ['uploads', 'form-files', 'community', 'acc-docs', 'assignment-files', 'certificates', 'hr-docs', 'pm-files', 'teamchat-files', 'genmedia', 'umzug', 'video-studio', 'webinar-assets', 'webinars', 'course-videos', 'call-intel', 'call-audio', 'office-files', 'ai-studio'];
/** Copies made from those files (scaled images): deleted with them, never exported. */
const DERIVED_DIRS = ['uploads-opt'];
/**
 * Rows that outlive a deleted sub-account on purpose: deletions still to be sent to an outside service and the login they need
 * (the Cognee datasets of the sub-account are queued by a trigger when its row goes).
 */
const OUTLIVE = new Set(['cognee_deletions', 'cognee_accounts']);
const IDLIKE = /^[A-Za-z0-9_-]{14,64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface Table {
  name: string;
  cols: string[];
}
export interface Scope extends Table {
  where: string;
}

function tables(app: App, forExport: boolean): Table[] {
  return app.db
    .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .filter((t) => !NEVER.test(t.name) && !(forExport && NOT_EXPORTED.test(t.name)))
    .map((t) => ({ name: t.name, cols: app.db.all<{ name: string }>(`PRAGMA table_info("${t.name}")`).map((c) => c.name) }));
}

/** Which rows of which tables belong to these sub-accounts (SQL conditions on the table itself). */
export function tenantScopes(app: App, locationIds: string[], forExport = false): Scope[] {
  if (!locationIds.length || locationIds.some((l) => !SAFE_ID.test(l))) throw new Error('Ungültige Sub-Account-ID');
  const lit = locationIds.map((l) => `'${l}'`).join(', ');
  const all = tables(app, forExport);
  const scope = new Map<string, string>();
  scope.set('locations', `id IN (${lit})`);
  for (const t of all) if (t.name !== 'locations' && t.cols.includes('location_id')) scope.set(t.name, `location_id IN (${lit})`);
  // Child tables without a location column, through their foreign keys (a few levels deep).
  for (let pass = 0; pass < 5; pass++) {
    let grew = false;
    for (const t of all) {
      if (scope.has(t.name)) continue;
      const fks = app.db.all<{ table: string; from: string; to: string | null }>(`PRAGMA foreign_key_list("${t.name}")`);
      const fk = fks.find((f) => scope.has(f.table));
      if (!fk) continue;
      scope.set(t.name, `"${fk.from}" IN (SELECT "${fk.to ?? 'id'}" FROM "${fk.table}" WHERE ${scope.get(fk.table)})`);
      grew = true;
    }
    if (!grew) break;
  }
  return all.filter((t) => scope.has(t.name)).map((t) => ({ ...t, where: scope.get(t.name)! }));
}

/** A cell without credentials: JSON text is parsed, sealed values and credential keys are dropped. */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') {
    if (isSealed(v)) return null;
    if (/^[[{]/.test(v)) {
      try {
        return scrub(JSON.parse(v));
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !HIDDEN.test(k)).map(([k, x]) => [k, scrub(x)]));
  return v;
}
const cleanRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !HIDDEN.test(k)).map(([k, v]) => [k, scrub(v)]));

/** Names of files the rows mention: ids and file names that look generated. */
function fileTokens(app: App, scopes: Scope[], dirs: string[]): Set<string> {
  const out = new Set<string>();
  // Only names that exist in the folders count – a large sub-account has millions of ids and a few hundred files.
  const names = namesIn(app, dirs);
  const take = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 80) return;
    const m = /^([A-Za-z0-9_-]{14,64})(\.[A-Za-z0-9]{1,6})?$/.exec(v);
    if (m && IDLIKE.test(m[1]) && names.has(m[1])) out.add(m[1]);
  };
  if (!names.size) return out;
  for (const s of scopes) {
    // Row by row, not the whole table at once (memory stays flat however big the sub-account is).
    const st = app.db.raw.prepare(`SELECT * FROM "${s.name}" WHERE ${s.where}`);
    const rows = typeof st.iterate === 'function' ? st.iterate() : st.all();
    for (const r of rows as Iterable<Record<string, unknown>>) for (const v of Object.values(r)) take(v);
  }
  return out;
}

/** Every file and folder name (with and without its extension) below these folders. */
function namesIn(app: App, dirs: string[]): Set<string> {
  const out = new Set<string>();
  const visit = (dir: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      out.add(e.name);
      out.add(e.name.replace(/\.[A-Za-z0-9]{1,6}$/, ''));
      if (e.isDirectory()) visit(join(dir, e.name));
    }
  };
  for (const d of dirs) visit(join(app.config.dataDir, d));
  return out;
}

/** Files (relative to the data directory) whose name or folder is one of the tokens. */
function matchingFiles(app: App, tokens: Set<string>, dirs = FILE_DIRS): { rel: string; size: number; top: string }[] {
  const out: { rel: string; size: number; top: string }[] = [];
  const base = (n: string) => n.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const visit = (dir: string, rel: string, topRel: string | null) => {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      const r = `${rel}/${n}`;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      const hit = tokens.has(base(n)) || tokens.has(n);
      const top = topRel ?? (hit ? r : null);
      if (st.isDirectory()) visit(p, r, top);
      else if (top) out.push({ rel: r, size: st.size, top });
    }
  };
  for (const d of dirs) if (existsSync(join(app.config.dataDir, d))) visit(join(app.config.dataDir, d), d, null);
  return out;
}

const MAX_FILES_BYTES = 300 * 1024 * 1024;

export interface ExportInfo {
  zip: Buffer;
  tables: number;
  rows: number;
  files: number;
}

/** The customer's data as a ZIP: manifest, one JSON and one CSV per table, the team list and the uploaded files. */
export function exportTenant(app: App, t: { id: string; name: string }, locationIds: string[]): ExportInfo {
  const scopes = tenantScopes(app, locationIds, true);
  const files: { name: string; data: Buffer }[] = [];
  const manifest: Record<string, number> = {};
  let rows = 0;
  for (const s of scopes) {
    const list = app.db.all(`SELECT * FROM "${s.name}" WHERE ${s.where}`).map(cleanRow);
    if (!list.length) continue;
    manifest[s.name] = list.length;
    rows += list.length;
    files.push({ name: `daten/${s.name}.json`, data: Buffer.from(JSON.stringify(list, null, 2)) });
    const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
    const csv = toCsv([cols, ...list.map((r) => cols.map((c) => (typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : (r[c] as string | number | null | undefined))))]);
    files.push({ name: `csv/${s.name}.csv`, data: Buffer.from(`﻿${csv}`) });
  }
  const team = app.db.all<{ email: string; name: string; role: string; created_at: string }>(
    `SELECT u.email, u.name, m.role, u.created_at FROM cloud_members m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY u.created_at`,
    t.id,
  );
  files.push({ name: 'daten/team.json', data: Buffer.from(JSON.stringify(team, null, 2)) });
  let bytes = 0;
  let skipped = 0;
  let count = 0;
  const seenTop = new Set<string>();
  for (const f of matchingFiles(app, fileTokens(app, scopes, FILE_DIRS))) {
    if (bytes + f.size > MAX_FILES_BYTES) {
      skipped++;
      continue;
    }
    bytes += f.size;
    count++;
    seenTop.add(f.top);
    files.push({ name: `dateien/${f.rel}`, data: readFileSync(join(app.config.dataDir, f.rel)) });
  }
  const readme = [
    `Datenexport von „${t.name}“`,
    `Erstellt am ${now()}`,
    '',
    'daten/   – eine JSON-Datei je Tabelle (Kontakte, Aufgaben, Nachrichten, Rechnungen …), ohne Passwörter, Tokens und Schlüssel',
    'csv/     – dieselben Tabellen als CSV (UTF-8, Excel-tauglich)',
    'dateien/ – hochgeladene Dateien (Bilder, Anhänge, Dokumente)',
    'daten/team.json – die Nutzer deines Kontos',
    skipped ? `\nHinweis: ${skipped} Datei(en) fehlen, weil das Größenlimit des Exports erreicht wurde. Melde dich beim Support für einen Export in Teilen.` : '',
  ].join('\n');
  files.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ exported_at: now(), tenant: t.name, tables: manifest, files: count, skipped_files: skipped }, null, 2)) }, { name: 'LIESMICH.txt', data: Buffer.from(readme) });
  return { zip: buildZip(files), tables: Object.keys(manifest).length, rows, files: count };
}

/**
 * Deletes everything of these sub-accounts: rows (children through their cascades), the sub-accounts themselves and the
 * customers' files. Returns what went. The caller removes users and the tenant's own rows. `keep` names tables whose rows stay
 * (a self-hosted install keeps the media library, which pages of other sub-accounts may show, and its own audit log); their
 * folders are left alone too.
 */
export function eraseLocations(app: App, locationIds: string[], opts: { keep?: string[] } = {}): { rows: number; files: number } {
  const keep = new Set([...OUTLIVE, ...(opts.keep ?? [])]);
  const scopes = tenantScopes(app, locationIds).filter((s) => !keep.has(s.name));
  // Files first: they are found through the rows that are about to go.
  const dirs = [...FILE_DIRS, ...DERIVED_DIRS].filter((d) => !(keep.has('uploads') && (d === 'uploads' || d === 'uploads-opt')));
  const doomed = matchingFiles(app, fileTokens(app, scopes, dirs), dirs);
  let rows = 0;
  app.db.tx(() => {
    app.db.raw.exec('PRAGMA defer_foreign_keys = ON');
    // Search indexes keep a copy of the text, keyed by the source row: drop those entries first.
    for (const [fts, src] of [['wiki_fts', 'wiki_pages'], ['teamchat_fts', 'teamchat_messages']]) {
      const s = scopes.find((x) => x.name === src);
      if (s && app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = ?`, fts)) app.db.run(`DELETE FROM ${fts} WHERE rowid IN (SELECT rowid FROM "${src}" WHERE ${s.where})`);
    }
    const lit = locationIds.map((l) => `'${l}'`).join(', ');
    const domains = app.db.all<{ d: string | null }>(`SELECT json_extract(settings, '$.branding.app_domain') AS d FROM locations WHERE id IN (${lit})`);
    // The sub-accounts go first: the cascades take their children, and the append-only protections of the books (GoBD) step aside only
    // while the sub-account itself is being removed. What has no foreign key to them goes afterwards.
    // Tables whose foreign key to the sub-account only sets it to NULL (agency documents …) would keep the customer's rows: they go first.
    for (const s of scopes.filter((x) => x.name !== 'locations' && x.cols.includes('location_id'))) {
      if (app.db.all<{ table: string; on_delete: string }>(`PRAGMA foreign_key_list("${s.name}")`).some((f) => f.table === 'locations' && /set null/i.test(f.on_delete))) rows += app.db.run(`DELETE FROM "${s.name}" WHERE ${s.where}`).changes;
    }
    // Bookkeeping without a foreign key that points at the customer's tasks.
    const task = scopes.find((x) => x.name === 'tasks');
    if (task && app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'push_task_seen'`)) rows += app.db.run(`DELETE FROM push_task_seen WHERE task_id IN (SELECT id FROM tasks WHERE ${task.where})`).changes;
    rows += app.db.run(`DELETE FROM locations WHERE id IN (${lit})`).changes;
    for (const s of scopes.filter((x) => x.name !== 'locations' && x.cols.includes('location_id'))) rows += app.db.run(`DELETE FROM "${s.name}" WHERE ${s.where}`).changes;
    for (const l of domains) if (l.d) app.db.run('DELETE FROM domains WHERE domain = ?', l.d);
    for (const t of ['saas_events', 'saas_usage_reports', 'saas_usage']) app.db.run(`DELETE FROM ${t} WHERE location_id IN (${lit})`);
  });
  const gone = new Set<string>();
  for (const f of doomed) {
    if (gone.has(f.top)) continue;
    gone.add(f.top);
    try {
      rmSync(join(app.config.dataDir, f.top), { recursive: true, force: true });
    } catch {
      /* best effort: a locked file does not stop the erasure */
    }
  }
  return { rows, files: doomed.length };
}

/** What is left about deleted logins in tables that are not tied to a sub-account (notification log, devices …). */
export function eraseUserRows(app: App, userIds: string[]): number {
  if (!userIds.length || userIds.some((u) => !SAFE_ID.test(u))) return 0;
  const lit = userIds.map((u) => `'${u}'`).join(', ');
  let n = 0;
  for (const t of tables(app, false)) if (t.name !== 'locations' && t.cols.includes('user_id')) n += app.db.run(`DELETE FROM "${t.name}" WHERE user_id IN (${lit})`).changes;
  return n;
}
