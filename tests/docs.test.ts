import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error – plain .mjs script without type declarations
import { anchorsOf, checkEnv, checkLinks, checkOrphans, checkReadmeIndex, checkWords, linksOf, markdownFiles, proseOf, slug } from '../scripts/check-docs.mjs';
import { syncWorkflowLists, type Catalog } from '../scripts/gen-docs';
import { SOURCE_LABELS } from '../server/services/umzug-core';
import { THEME_IDS } from '../server/services/appearance-model';
import { JOURNEY, MODULE_TOURS } from '../web/src/tour/catalog';
import { startTestApp } from './helpers';

/**
 * The documentation is part of the product, so it is tested like code: links, anchors, pages, environment variables,
 * the lists and numbers the READMEs promise, the changelog's shape and the wording of the German pages. The same
 * rules run as `npm run docs:check` (scripts/check-docs.mjs); `npm run docs:gen` fixes what can be generated.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A throw-away tree of files, for the checker's own tests. */
function tree(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-check-'));
  tmp.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { dir, files: Object.keys(files).filter((f) => f.endsWith('.md')) };
}

describe('documentation checker', () => {
  it('makes anchors the way GitHub does (and the academy does)', () => {
    const a = anchorsOf('# Titel\n\n## Blog & Kurse\n\n## A/B-Tests, Order-Bumps & Upsells\n\n## Über `PGHL_X` uns\n\n## Zweimal\n\n## Zweimal\n\n<a id="alt-id"></a>\n\n```\n## nicht in Code\n```\n');
    expect([...a].sort()).toEqual(['ab-tests-order-bumps--upsells', 'alt-id', 'blog--kurse', 'titel', 'zweimal', 'zweimal-1', 'über-pghl_x-uns'].sort());
    expect(slug('KI-Anbieter: Anthropic oder OpenAI')).toBe('ki-anbieter-anthropic-oder-openai');
  });

  it('reads links and images, but not code, mail or web addresses', () => {
    const md = ['[a](x.md) ![img](a.png "t") <img src="b.png"> <a href="#top">t</a>', '`[no](code.md)`', '```', '[no](fenced.md)', '```', '[web](https://example.com/x.md) [mail](mailto:a@b.c) [tpl]({{x}})'].join('\n');
    expect(linksOf(md).map((l: { target: string }) => l.target)).toEqual(['x.md', 'a.png', 'b.png', '#top']);
    expect(proseOf('a `x` b\n```\ncode\n```\nc')).toBe('a `` b\n\n\n\nc');
  });

  it('finds broken files, broken anchors and links that leave the repository', () => {
    const t = tree({
      'README.md': '[ok](docs/a.md) [anchor](docs/a.md#da) [badanchor](docs/a.md#nope) [file](docs/missing.md) [img](docs/x.png) [out](../secret.md) [self](#top) [selfbad](#nirgends) [app](/app/contacts)\n\n# Top\n',
      'docs/a.md': '# A\n\n## Da\n',
    });
    const found = checkLinks(t.dir, t.files).map((f: { rule: string; match: string }) => `${f.rule}: ${f.match}`);
    expect(found.sort()).toEqual(
      [
        'anchor not found in target page: docs/a.md#nope',
        'anchor not found in target page: #nirgends',
        'link leaves the repository: ../secret.md',
        'link target does not exist: docs/missing.md',
        'link target does not exist: docs/x.png',
      ].sort(),
    );
  });

  it('finds docs pages nobody links, except export-ignored notes, and pages the README misses', () => {
    const t = tree({
      '.gitattributes': 'docs/internal.md export-ignore\n',
      'README.md': '[a](docs/a.md)\n',
      'docs/a.md': '# A\n[b](b.md)\n',
      'docs/b.md': '# B\n',
      'docs/orphan.md': '# O\n',
      'docs/internal.md': '# Intern\n',
    });
    expect(checkOrphans(t.dir, t.files).map((f: { match: string }) => f.match)).toEqual(['docs/orphan.md']);
    expect(checkReadmeIndex(t.dir, t.files).map((f: { match: string }) => f.match).sort()).toEqual(['docs/b.md', 'docs/orphan.md']);
  });

  it('flags leftovers but not code or the changelog', () => {
    const t = tree({ 'a.md': 'Text\nTODO: fix\nlorem ipsum\n`TODO` in code is fine\n```\nTODO\n```\nProjekt Private GHL\n', 'CHANGELOG.md': 'TODO\n' });
    expect(checkWords(t.dir, t.files).map((f: { rule: string }) => f.rule)).toEqual(['TODO / FIXME', 'lorem ipsum', 'private project name']);
  });
});

describe('the repository documentation', () => {
  it('every relative link and anchor resolves', () => {
    expect(checkLinks()).toEqual([]);
  });

  it('every docs page is linked, and README.md is the index of them all', () => {
    expect(checkOrphans()).toEqual([]);
    expect(checkReadmeIndex()).toEqual([]);
  });

  it('every PGHL_* variable the server reads is in .env.example and docs/self-hosting.md, and none of them is dead', () => {
    expect(checkEnv()).toEqual([]);
  });

  it('has no TODO, lorem ipsum, placeholder text or private project names', () => {
    expect(checkWords()).toEqual([]);
  });

  it('the changelog is well-formed: newest first, [Unreleased] on top, one heading per kind in a version', () => {
    const lines = read('CHANGELOG.md').split('\n');
    const versions = lines.map((l, i) => ({ l, i })).filter((x) => x.l.startsWith('## '));
    expect(versions[0].l).toBe('## [Unreleased]');
    const nums: number[] = [];
    versions.slice(1).forEach(({ l }) => {
      const m = l.match(/^## \[(\d+)\.(\d+)\.(\d+)\]( – \d{4}-\d{2}-\d{2})?$/);
      expect(m, `Version heading: ${l}`).toBeTruthy();
      nums.push(Number(m![1]) * 1e6 + Number(m![2]) * 1e3 + Number(m![3]));
    });
    expect(nums, 'versions run from newest to oldest, each once').toEqual([...nums].sort((a, b) => b - a));
    expect(new Set(nums).size).toBe(nums.length);
    const KINDS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
    const problems: string[] = [];
    versions.forEach(({ l, i }, k) => {
      const end = k + 1 < versions.length ? versions[k + 1].i : lines.length;
      const heads = lines.slice(i + 1, end).filter((x) => x.startsWith('### ')).map((x) => x.slice(4).trim());
      for (const h of new Set(heads.filter((x, n) => heads.indexOf(x) !== n))) problems.push(`${l}: "### ${h}" appears more than once`);
      // the first versions (0.0.19 and older) and the odd extra heading ("Not included", "Performance") predate this rule; only the usual kinds are ordered
      const order = heads.filter((h) => KINDS.includes(h)).map((h) => KINDS.indexOf(h));
      if (nums[k - 1] >= 21 && order.some((o, n) => n && o < order[n - 1])) problems.push(`${l}: headings are not in the order ${KINDS.join(', ')}`);
    });
    expect(problems).toEqual([]);
  });

  it('[Unreleased] only holds bullets under the usual headings', () => {
    const lines = read('CHANGELOG.md').split('\n');
    const from = lines.indexOf('## [Unreleased]') + 1;
    const to = lines.findIndex((l, i) => i >= from && l.startsWith('## '));
    const body = lines.slice(from, to).filter((l) => l.trim());
    for (const l of body) expect(/^(### (Added|Changed|Deprecated|Removed|Fixed|Security)$|\s*- |\s{2,}\S)/.test(l), `[Unreleased]: ${l.slice(0, 80)}`).toBe(true);
  });

  it('the READMEs name every importer of the Umzug assistant', () => {
    const labels = Object.values(SOURCE_LABELS).map((l) => l.replace(/\s*\(.*\)$/, ''));
    for (const file of ['README.md', 'README.de.md']) {
      const row = read(file)
        .split('\n')
        .find((l) => /^\| (Switching over|Umzug) /.test(l));
      expect(row, `${file}: the Umzug row`).toBeTruthy();
      for (const label of labels) expect(row, `${file}: ${label}`).toContain(label);
    }
  });

  it('the numbers about the Akademie are real (chapters exactly, tours never more than exist)', () => {
    const claims = (file: string, re: RegExp) => [...read(file).matchAll(re)].map((m) => Number(m[1]));
    for (const file of ['README.de.md', 'docs/academy.md', 'docs/handbuch.md']) for (const n of claims(file, /\b(\d+) Kapitel\b/g)) expect(n, `${file}: Kapitel`).toBe(JOURNEY.length);
    for (const file of ['README.de.md', 'docs/academy.md']) for (const n of claims(file, /\b(\d+)\+? Modul-Touren\b/g)) expect(n, `${file}: Modul-Touren`).toBeLessThanOrEqual(MODULE_TOURS.length);
  });

  it('the appearance and Android numbers are real', () => {
    const widgets = readdirSync(join(ROOT, 'android/app/src/main/res/xml')).filter((f) => /appwidget-provider/.test(readFileSync(join(ROOT, 'android/app/src/main/res/xml', f), 'utf8'))).length;
    for (const file of ['README.md', 'README.de.md']) {
      for (const m of read(file).matchAll(/\b(\d+) (?:themes|Themes)\b/g)) expect(Number(m[1]), `${file}: themes`).toBeLessThanOrEqual(THEME_IDS.length);
      for (const m of read(file).matchAll(/\b(\d+) (?:home-screen widgets|Home-Screen-Widgets|widgets)\b/gi)) expect(Number(m[1]), `${file}: widgets`).toBeLessThanOrEqual(widgets);
    }
  });
});

describe('what the running app has, against what the docs say', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());

  const allDocs = () => [...markdownFiles().filter((f: string) => /^docs\/[^/]+\.md$/.test(f)), 'README.md', 'README.de.md'].map(read).join('\n');

  it('the MCP tool count in the READMEs, docs/ai-tools.md and package.json is real', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'docs', scope: 'read' })).data.key;
    const res = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools: string[] = ((await res.json()) as any).result.tools.map((x: any) => x.name);
    expect(tools.length).toBeGreaterThan(200);
    const claimed = (text: string) => [...text.matchAll(/\b(\d{2,4})\+? (?:MCP[- ])?(?:tools|Werkzeuge[n]?)\b/g)].map((m) => Number(m[1]));
    const claims = [
      ...claimed(read('README.md')),
      ...claimed(read('README.de.md')),
      ...claimed(read('docs/ai-tools.md')),
      ...claimed(JSON.parse(read('package.json')).description),
    ];
    expect(claims.length, 'the READMEs say how many MCP tools there are').toBeGreaterThan(3);
    for (const n of claims) expect(n, 'a number the docs promise').toBeLessThanOrEqual(tools.length);
    // …and it is not stale by more than a fifth either
    for (const n of [...claimed(read('README.md')), ...claimed(read('README.de.md'))].filter((n) => n >= 100)) expect(n, 'README number is far below the real count – update it').toBeGreaterThan(tools.length * 0.8);
  });

  it('every route family under /api/ is named in some documentation page', () => {
    const routes = (t.app.router as any).routes as { pattern: string }[];
    const families = new Set(routes.map((r) => r.pattern.match(/^\/api\/([a-z0-9][a-z0-9-]*)/)?.[1]).filter(Boolean) as string[]);
    expect(families.size).toBeGreaterThan(150);
    const docs = allDocs();
    const missing = [...families].filter((f) => !new RegExp(`/api/${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(docs));
    expect(missing, `Routen unter /api/<x>, die in keiner Seite von docs/ oder in den READMEs vorkommen – in docs/api.md oder auf der Seite des Bereichs ergänzen`).toEqual([]);
  });

  it('every sub-resource of a route family is named on a page that names the family (/api/x/<sub>)', () => {
    const routes = (t.app.router as any).routes as { pattern: string }[];
    const pages = [...markdownFiles().filter((f: string) => /^docs\/[^/]+\.md$/.test(f)), 'README.md', 'README.de.md'].map((f: string) => [f, read(f)] as const);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const missing = new Set<string>();
    const familyText = new Map<string, string>();
    for (const r of routes) {
      const segs = r.pattern.split('/').filter(Boolean);
      if (segs[0] !== 'api' || !segs[1] || segs[1].startsWith(':')) continue;
      const sub = segs.slice(2).find((x) => !x.startsWith(':'));
      if (!sub) continue;
      const text = familyText.get(segs[1]) ?? familyText.set(segs[1], pages.filter(([, body]) => body.includes(`/api/${segs[1]}`)).map(([, body]) => body).join('\n')).get(segs[1])!;
      if (!new RegExp(`(?<![A-Za-z0-9_-])${esc(sub)}(?![A-Za-z0-9_-])`).test(text)) missing.add(`/api/${segs[1]}/${sub}`);
    }
    expect([...missing].sort(), 'Teilressourcen, die auf keiner Seite stehen, die ihren Bereich beschreibt – dort ergänzen').toEqual([]);
  });

  it('every workflow action and trigger type is listed in docs/workflow-actions.md (npm run docs:gen adds the missing rows)', async () => {
    const catalog = (await t.api.get('/api/workflow-catalog')).data as Catalog;
    const page = read('docs/workflow-actions.md');
    const synced = syncWorkflowLists(page, catalog);
    const list = (text: string) => new Set([...text.matchAll(/^\| .*? \| `([^`]+)` \|/gm)].map((m) => m[1]));
    const have = list(page);
    const missing = [...list(synced)].filter((x) => !have.has(x));
    const stale = [...have].filter((x) => !list(synced).has(x));
    expect({ missing, stale }, 'run: npm run docs:gen').toEqual({ missing: [], stale: [] });
    expect(synced).toBe(page);
  });
});

/** The pages written in German – their wording stays German, with one spelling of the product terms. */
const GERMAN_PAGES = [
  'README.de.md',
  'docs/academy.md',
  'docs/ai-assistant.md',
  'docs/android-app.md',
  'docs/app.md',
  'docs/bug-reports.md',
  'docs/collaboration.md',
  'docs/email-builder.md',
  'docs/email-marketing.md',
  'docs/growth.md',
  'docs/handbuch.md',
  'docs/helpdesk.md',
  'docs/integrations.md',
  'docs/meta-channels.md',
  'docs/objects.md',
  'docs/reports.md',
  'docs/saas.md',
  'docs/self-hosting.md',
  'docs/sites.md',
  'docs/stripe.md',
  'docs/todoist.md',
  'docs/video-studio.md',
];

describe('German pages', () => {
  const DE = /\b(und|der|die|das|nicht|mit|für|ein|eine|einen|ist|sind|wird|werden|auf|oder|dem|den|des|zu|von|im|bei|auch|nur|wie|wenn|aus|nach|kann|dass|sich|alle|jede[rsmn]?|deine[nrms]?|dein|über|je|pro|ohne|beim|zum|zur|dazu|dann|statt|sowie)\b/gi;
  const EN = /\b(the|and|with|for|is|are|of|to|in|on|that|this|your|you|can|it|as|by|from|not|or|an|be|when|which|only|also|all|each|every|per|but|if|at|no|its|into|than|then|their|they|will|has|have|does|do)\b/gi;

  it('have no paragraphs, bullets or table rows written in English', () => {
    const found: string[] = [];
    for (const file of GERMAN_PAGES) {
      proseOf(read(file)).split('\n').forEach((line, i) => {
        const plain = line.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '');
        const de = (plain.match(DE) ?? []).length;
        const en = (plain.match(EN) ?? []).length;
        if (en >= 8 && en > de * 2) found.push(`${file}:${i + 1}: ${plain.trim().slice(0, 90)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('write Sub-Account, Kunden-Login, Mitgliederbereich and Wissensdatenbank the one way the app does', () => {
    const wrong = /\b(Subaccounts?|Sub Accounts?|Sub-Konten|Sub-Konto|Subkonto|Subkonten|Unterkonto|Unterkonten|Unter-Accounts?|Work-Flows?|Kundenlogins?|Kunden Logins?|Mitglieder-Bereich|Wissens-Datenbank)\b|\bSub-accounts?\b/;
    const found: string[] = [];
    for (const file of GERMAN_PAGES) {
      proseOf(read(file)).split('\n').forEach((line, i) => {
        const m = line.match(wrong);
        if (m) found.push(`${file}:${i + 1}: ${m[0]}`);
      });
    }
    expect(found).toEqual([]);
  });
});
