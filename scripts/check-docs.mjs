#!/usr/bin/env node
/**
 * Documentation checks (Node built-ins only, no build step):
 *
 *   node scripts/check-docs.mjs          # same as `npm run docs:check`
 *   node scripts/check-docs.mjs --json
 *
 *  - links:    every relative link/image in a tracked Markdown file points at an existing file, and `#anchor`s
 *              match a heading (GitHub's slug rules) or an explicit `<a id="…">` in the target page
 *  - orphans:  every docs/*.md page is linked from the READMEs or another page, and README.md links every page
 *  - env:      every `PGHL_*` variable the server code reads is explained in docs/self-hosting.md or the page of its
 *              feature, and every `PGHL_*` in .env.example is read by the code (no dead settings)
 *  - words:    no TODO / FIXME / lorem ipsum / "coming soon" leftovers in the documentation
 *
 * Exit code 1 when something is found. `tests/docs.test.ts` runs the same functions.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Anchor id of a heading the way GitHub makes it (`## Blog & Kurse` → `blog--kurse`). Same rule as web/src/tour/slug.ts. */
export const slug = (s) =>
  s
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const read = (rel, root = repoRoot) => readFileSync(join(root, rel), 'utf8');

/** Tracked Markdown files (relative, forward slashes). */
export function markdownFiles(root = repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  // a file deleted in the working tree is still listed by git until it is committed
  return out.filter((f) => existsSync(join(root, f)));
}

/** The text of a Markdown file without fenced code blocks and (unless `keepInline`) inline code (links in examples are not links). */
export function proseOf(text, keepInline = false) {
  const lines = text.split(/\r?\n/);
  let fence = null;
  const kept = lines.map((l) => {
    const m = l.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return '';
    }
    if (fence) return '';
    return keepInline ? l : l.replace(/`[^`\n]*`/g, '``');
  });
  return kept.join('\n');
}

/** Heading anchors of a page: headings (GitHub slugs, with -1/-2 for duplicates) and explicit ids / names. */
export function anchorsOf(text) {
  const set = new Set();
  const seen = new Map();
  for (const m of proseOf(text, true).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    // a heading may carry markup: `code`, [link](x), **bold**
    const plain = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, (c) => (c === '_' ? '_' : ''));
    const base = slug(plain);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n ? `${base}-${n}` : base);
  }
  for (const m of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) set.add(m[1]);
  return set;
}

const LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_REF = /\b(?:href|src|srcset)=["']([^"']+)["']/g;

/** Relative link targets of a page: [{ target, line }]. */
export function linksOf(text) {
  const prose = proseOf(text);
  const out = [];
  const lines = prose.split('\n');
  lines.forEach((l, i) => {
    for (const m of l.matchAll(LINK)) out.push({ target: m[1], line: i + 1 });
    for (const m of l.matchAll(HTML_REF)) out.push({ target: m[1].split(/\s+/)[0], line: i + 1 });
  });
  return out.filter(({ target }) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\{\{)/i.test(target) && !target.startsWith('<'));
}

/** Broken relative links and anchors in every tracked Markdown file. */
export function checkLinks(root = repoRoot, files = markdownFiles(root)) {
  const findings = [];
  const anchorCache = new Map();
  const anchorsFor = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(readFileSync(file, 'utf8')));
    return anchorCache.get(file);
  };
  for (const f of files) {
    const dir = dirname(join(root, f));
    for (const { target, line } of linksOf(read(f, root))) {
      const [pathPart, anchorRaw] = target.split('#');
      const anchor = anchorRaw ? decodeURIComponent(anchorRaw) : '';
      const clean = decodeURI(pathPart.split('?')[0]);
      // Links starting with "/" are paths of the running app (e.g. `/app/...`), not files of the repository.
      if (clean.startsWith('/')) continue;
      const file = clean ? resolve(dir, clean) : join(root, f);
      if (!normalize(file).startsWith(resolve(root) + sep) && resolve(file) !== resolve(root)) {
        findings.push({ file: f, line, rule: 'link leaves the repository', match: target });
        continue;
      }
      if (!existsSync(file)) {
        findings.push({ file: f, line, rule: 'link target does not exist', match: target });
        continue;
      }
      if (anchor && statSync(file).isFile() && /\.md$/i.test(file) && !anchorsFor(file).has(anchor) && !anchorsFor(file).has(anchor.toLowerCase())) {
        findings.push({ file: f, line, rule: 'anchor not found in target page', match: target });
      }
    }
  }
  return findings;
}

/** Paths marked `export-ignore` in .gitattributes: internal notes that the public export leaves out (nothing public may link to them). */
export function exportIgnored(root = repoRoot) {
  const file = join(root, '.gitattributes');
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.match(/^(\S+)\s+.*\bexport-ignore\b/)?.[1])
      .filter(Boolean),
  );
}

/** docs/*.md pages (and docs/deploy/*.md) that no other Markdown file links to – except the export-ignored internal notes. */
export function checkOrphans(root = repoRoot, files = markdownFiles(root)) {
  const ignored = exportIgnored(root);
  const pages = files.filter((f) => /^docs\/(?:deploy\/)?[^/]+\.md$/.test(f) && !ignored.has(f));
  const linked = new Set();
  for (const f of files) {
    const dir = dirname(join(root, f));
    for (const { target } of linksOf(read(f, root))) {
      const clean = decodeURI(target.split('#')[0].split('?')[0]);
      if (!clean || clean.startsWith('/')) continue;
      const abs = resolve(dir, clean);
      const rel = relative(root, abs).split(sep).join('/');
      if (rel !== f) linked.add(rel);
    }
  }
  return pages.filter((p) => !linked.has(p)).map((p) => ({ file: p, line: 0, rule: 'page is not linked from any README or docs page', match: p }));
}

/**
 * Every docs page (except the export-ignored notes) is linked from README.md – the README is the index of the documentation.
 * A German version `<page>.de.md` counts as linked when its English page is (the language switcher on top of it leads there).
 */
export function checkReadmeIndex(root = repoRoot, files = markdownFiles(root)) {
  const ignored = exportIgnored(root);
  const linked = new Set();
  const dir = dirname(join(root, 'README.md'));
  for (const { target } of linksOf(read('README.md', root))) {
    const clean = decodeURI(target.split('#')[0].split('?')[0]);
    if (clean && !clean.startsWith('/')) linked.add(relative(root, resolve(dir, clean)).split(sep).join('/'));
  }
  return files
    .filter((f) => /^docs\/(?:deploy\/)?[^/]+\.md$/.test(f) && !ignored.has(f) && f !== 'docs/deploy/README.md' && !f.startsWith('docs/deploy/'))
    .filter((f) => !linked.has(f) && !(f.endsWith('.de.md') && linked.has(f.replace(/\.de\.md$/, '.md'))))
    .map((f) => ({ file: 'README.md', line: 0, rule: 'docs page is not linked from README.md (add it to the Documentation table)', match: f }));
}

function walkSource(root, dirs) {
  const files = execFileSync('git', ['ls-files', '-z', ...dirs], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return files.filter((f) => /\.(?:ts|tsx|mjs|js|sh|ya?ml)$|(?:^|\/)Dockerfile$/.test(f) && existsSync(join(root, f)));
}

/** `PGHL_*` names the code reads, mapped to the files that read them. */
export function envVarsInCode(root = repoRoot) {
  const vars = new Map();
  for (const f of walkSource(root, ['server', 'scripts', 'bridge', 'web/src', 'tests', 'deploy', 'docker-compose.yml', 'Dockerfile', '.github'])) {
    for (const m of read(f, root).matchAll(/\b(PGHL_[A-Z0-9_]+)\b/g)) {
      if (!vars.has(m[1])) vars.set(m[1], new Set());
      vars.get(m[1]).add(f);
    }
  }
  return vars;
}

/**
 * Environment variables: what the server code reads against what the operator is told.
 *  - every `PGHL_*` the server reads must be explained in docs/self-hosting.md and listed (commented is fine) in .env.example
 *  - every `PGHL_*` in .env.example or docs/self-hosting.md must be read by some code (no dead or misspelled settings)
 * Variables only scripts or tests read (screenshot helpers, smoke tests) are not part of the operator's contract.
 */
export function checkEnv(root = repoRoot, files = markdownFiles(root)) {
  const findings = [];
  const code = envVarsInCode(root);
  const example = existsSync(join(root, '.env.example')) ? read('.env.example', root) : '';
  const selfHosting = read('docs/self-hosting.md', root);
  const has = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
  for (const [name, files] of [...code].sort()) {
    if (name.endsWith('_')) continue; // prefix of dynamically built names, e.g. PGHL_GENMEDIA_MAX_<KIND>_MB
    if (![...files].some((f) => /^(?:server|bridge)\//.test(f))) continue;
    const where = [...files].find((f) => f.startsWith('server/')) ?? [...files][0];
    if (!has(selfHosting, name)) findings.push({ file: where, line: 0, rule: 'environment variable is read by the server but missing in docs/self-hosting.md', match: name });
    if (!has(example, name)) findings.push({ file: where, line: 0, rule: 'environment variable is read by the server but missing in .env.example', match: name });
  }
  example.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/^\s*#?\s*(PGHL_[A-Z0-9_]+)\s*=/);
    if (m && !code.has(m[1])) findings.push({ file: '.env.example', line: i + 1, rule: 'variable in .env.example is not read by any code', match: m[1] });
  });
  // any page: a PGHL_* name that no code reads is a typo or a removed setting (ideas in the security review are listed on purpose)
  const IDEAS = new Set(['PGHL_SETUP_TOKEN']);
  for (const f of files) {
    if (f === 'CHANGELOG.md') continue;
    for (const m of read(f, root).matchAll(/\bPGHL_[A-Z0-9_]+\b/g)) {
      if (!code.has(m[0]) && !m[0].endsWith('_') && !IDEAS.has(m[0])) findings.push({ file: f, line: 0, rule: 'a page names an environment variable that no code reads', match: m[0] });
    }
  }
  return [...new Map(findings.map((x) => [`${x.file}|${x.rule}|${x.match}`, x])).values()];
}

const LEFTOVERS = [
  ['TODO / FIXME', /\b(?:TODO|FIXME|XXX)\b/],
  ['lorem ipsum', /lorem ipsum|dolor sit amet/i],
  ['placeholder text', /\bcoming soon\b|\bTBD\b|\bhier folgt\b|\bfolgt noch\b|\bnoch offen: ?\?/i],
  ['private project name', /Private GHL|private-ghl/i],
];

/** Leftovers a reader should never see in the documentation. */
export function checkWords(root = repoRoot, files = markdownFiles(root)) {
  const findings = [];
  const ignored = exportIgnored(root);
  for (const f of files) {
    if (f === 'CHANGELOG.md' || ignored.has(f)) continue; // the changelog quotes old texts; export-ignored notes are internal
    const lines = proseOf(read(f, root)).split('\n');
    lines.forEach((l, i) => {
      for (const [rule, re] of LEFTOVERS) {
        const m = l.match(re);
        if (m) findings.push({ file: f, line: i + 1, rule, match: m[0] });
      }
    });
  }
  return findings;
}

export function checkAll(root = repoRoot) {
  return [...checkLinks(root), ...checkOrphans(root), ...checkReadmeIndex(root), ...checkEnv(root), ...checkWords(root)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkAll();
  if (process.argv.includes('--json')) console.log(JSON.stringify(findings, null, 1));
  else {
    for (const f of findings) console.log(`${f.file}${f.line ? `:${f.line}` : ''}  ${f.rule}: ${f.match}`);
    console.log(findings.length ? `\n${findings.length} documentation problem(s).` : `${markdownFiles().length} Markdown files checked: links, anchors, pages, environment variables and wording are fine.`);
  }
  process.exit(findings.length ? 1 : 0);
}
