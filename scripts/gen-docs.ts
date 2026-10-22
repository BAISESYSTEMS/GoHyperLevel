/**
 * Regenerates the parts of the documentation that are derived from the code, so they cannot drift:
 *
 *   npm run docs:gen             # rewrite the files
 *   npm run docs:gen -- --check  # exit 1 when a file is out of date (what tests/docs.test.ts asserts)
 *
 *  - docs/workflow-actions.md   "All actions" and "All triggers": adds the types of GET /api/workflow-catalog that are missing, drops vanished ones
 *  - docs/handbuch.md           the printed Akademie guide (web/src/tour/handbook.ts)
 *
 * Hand-written text and hand-edited cells are never touched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/core/app.js';
import { MODULES } from '../server/modules/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface CatalogEntry {
  type: string;
  label: string;
  category: string;
  provides?: string[];
  fields?: { label: string }[];
}
export interface Catalog {
  categories: { key: string; label: string }[];
  trigger_categories: { key: string; label: string }[];
  actions: CatalogEntry[];
  triggers: CatalogEntry[];
}

const cell = (s: string) => s.replace(/\|/g, '\\|');

const actionRow = (a: CatalogEntry) => `| ${cell(a.label)} | \`${a.type}\` | ${(a.provides ?? []).map((v) => `\`${v}\``).join(' ')} |`;
const triggerRow = (t: CatalogEntry) => `| ${cell(t.label)} | \`${t.type}\` | ${cell((t.fields ?? []).map((f) => f.label).join(', '))} |`;

/** The type a table row of "All actions" / "All triggers" is about: the backticked name in its second cell. */
const rowType = (line: string) => line.match(/^\|[^|]*(?:\\\|[^|]*)*\| `([^`]+)` \|/)?.[1];

/**
 * Brings one "All …" region in line with the catalogue without touching hand-written text: rows of types that no longer
 * exist are dropped, rows of new types are appended to the table of their category (the table and its heading are created
 * when the category is new). Existing rows – including hand-edited cells – stay exactly as they are.
 */
function syncRegion(lines: string[], entries: CatalogEntry[], categories: { key: string; label: string }[], tableHead: string[], row: (e: CatalogEntry) => string): string[] {
  const out = [...lines];
  const known = new Set(entries.map((e) => e.type));
  for (let i = out.length - 1; i >= 0; i--) {
    const t = rowType(out[i]);
    if (t && !known.has(t)) out.splice(i, 1);
  }
  const listed = new Set(out.map(rowType).filter(Boolean));
  for (const cat of categories) {
    const missing = entries.filter((e) => e.category === cat.key && !listed.has(e.type));
    if (!missing.length) continue;
    const heading = out.findIndex((l) => l === `### ${cat.label}`);
    if (heading < 0) {
      while (out.length && out[out.length - 1] === '') out.pop();
      out.push('', `### ${cat.label}`, '', ...tableHead, ...missing.map(row), '');
      continue;
    }
    let last = heading;
    for (let i = heading + 1; i < out.length && !out[i].startsWith('#'); i++) if (out[i].startsWith('|')) last = i;
    out.splice(last + 1, 0, ...missing.map(row));
  }
  return out;
}

/**
 * docs/workflow-actions.md: "All actions" and "All triggers" list every type of the catalogue exactly once. New types are added
 * (with the label and the cells the catalogue knows), vanished ones removed; everything else stays as written.
 */
export function syncWorkflowLists(page: string, c: Catalog): string {
  const lines = page.split('\n');
  const ia = lines.indexOf('## All actions');
  const it = lines.indexOf('## All triggers');
  if (ia < 0 || it < ia) throw new Error('docs/workflow-actions.md needs the headings "## All actions" and "## All triggers"');
  const actions = syncRegion(lines.slice(ia, it), c.actions, c.categories, ['| Action (name in the UI) | Type | Sets |', '| --- | --- | --- |'], actionRow);
  const triggers = syncRegion(lines.slice(it), c.triggers, c.trigger_categories, ['| Trigger (name in the UI) | Type | Settings |', '| --- | --- | --- |'], triggerRow);
  return [...lines.slice(0, ia), ...actions, ...triggers].join('\n');
}

/** Starts a throw-away app on an empty data folder and reads the workflow catalogue over HTTP, like the editor does. */
export async function loadCatalog(): Promise<Catalog> {
  const dir = mkdtempSync(join(tmpdir(), 'pghl-docs-'));
  const instance = createApp({ port: 0, host: '127.0.0.1', dataDir: dir, dbFile: join(dir, 'docs.db'), baseUrl: 'http://localhost', webDir: join(dir, 'web'), behindProxy: false, tickMs: 0, secret: 'docs-secret' } as any, MODULES);
  try {
    const server = await instance.listen();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-pghl': '1' };
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers, body: JSON.stringify({ email: 'docs@example.com', password: 'docs-password-1', name: 'Docs', locationName: 'Docs' }) });
    if (!setup.ok) throw new Error(`setup failed: ${setup.status}`);
    headers.cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];
    const me = (await (await fetch(`${base}/api/me`, { headers })).json()) as { locations: { id: string }[] };
    headers['x-location-id'] = me.locations[0].id;
    const res = await fetch(`${base}/api/workflow-catalog`, { headers });
    if (!res.ok) throw new Error(`catalogue failed: ${res.status}`);
    return (await res.json()) as Catalog;
  } finally {
    await instance.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function handbook(): Promise<string> {
  // web code is not part of the server type-check: load it dynamically (tsx compiles it)
  const mod = (await import(pathToFileURL(join(root, 'web/src/tour/handbook.ts')).href)) as { handbookMarkdown: (brand?: string) => string };
  return mod.handbookMarkdown('HyperLevel');
}

async function main() {
  const check = process.argv.includes('--check');
  const page = join(root, 'docs/workflow-actions.md');
  const hb = join(root, 'docs/handbuch.md');
  const wanted: [string, string][] = [
    [page, syncWorkflowLists(readFileSync(page, 'utf8'), await loadCatalog())],
    [hb, await handbook()],
  ];
  let stale = 0;
  for (const [file, text] of wanted) {
    const current = readFileSync(file, 'utf8');
    if (current === text) continue;
    stale++;
    if (check) console.error(`${file.replace(`${root}/`, '')} is out of date – run: npm run docs:gen`);
    else {
      writeFileSync(file, text);
      console.log(`wrote ${file.replace(`${root}/`, '')}`);
    }
  }
  if (!stale) console.log('generated documentation is up to date');
  process.exit(check && stale ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
