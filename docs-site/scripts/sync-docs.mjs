// Builds the documentation website's content from the repository's docs/ folder – docs/ stays the single source.
//
//   node scripts/sync-docs.mjs      (runs before `astro dev` and `astro build`)
//
// - docs/<page>.md → src/content/docs/<page>.md (English, the root locale); docs/<page>.de.md → src/content/docs/de/<page>.md
// - the first "# Title" becomes the frontmatter title, the language-switcher line at the top is dropped (the site has its own)
// - links to other pages become site URLs, links outside docs/ point to the file on GitHub, images move to /assets/
// - the sidebar comes from docs/README.md (English labels) and docs/README.de.md (German labels): same order, matched by link
// - pages marked export-ignore in .gitattributes stay private and are left out
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(SITE);
const DOCS = join(ROOT, 'docs');
const OUT = join(SITE, 'src', 'content', 'docs');
const REPO = 'https://github.com/BAISESYSTEMS/GoHyperLevel';

const ignored = new Set(
  readFileSync(join(ROOT, '.gitattributes'), 'utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === 'export-ignore' && p[0].startsWith('docs/'))
    .map((p) => p[0]),
);

/** docs/-relative paths of every page (without the two index pages, which become the sidebar). */
const pages = [];
for (const dir of ['', 'deploy']) {
  for (const f of readdirSync(join(DOCS, dir))) {
    const rel = dir ? `${dir}/${f}` : f;
    if (!f.endsWith('.md') || /^README(\.de)?\.md$/.test(rel) || ignored.has(`docs/${rel}`)) continue;
    pages.push(rel);
  }
}

/** docs/-relative page path → { locale, slug } (deploy/README.md is the deploy section's index). */
const pageInfo = (rel) => {
  const de = rel.endsWith('.de.md');
  let slug = rel.replace(/\.de\.md$|\.md$/, '');
  if (/(^|\/)README$/.test(slug)) slug = slug.replace(/\/?README$/, '');
  return { locale: de ? 'de' : 'root', slug };
};
const urlOf = (slug, locale) => `/${locale === 'de' ? 'de/' : ''}${slug ? `${slug}/` : ''}`;

/** Rewrites a link target found in docs/<from>. */
const rewrite = (target, from, locale) => {
  if (/^(https?:|mailto:|#|\/)/.test(target)) return target;
  const [path, hash = ''] = target.split('#');
  const anchor = hash ? `#${hash}` : '';
  const repoRel = posix.normalize(posix.join('docs', posix.dirname(from), path));
  if (repoRel.startsWith('docs/') && repoRel.endsWith('.md')) {
    const rel = repoRel.slice(5);
    if (ignored.has(repoRel)) return `${REPO}/blob/main/${repoRel}${anchor}`;
    const info = pageInfo(rel);
    // A German page links to the German version when there is one; the site falls back to English otherwise.
    return urlOf(info.slug, info.locale === 'de' ? 'de' : locale) + anchor;
  }
  if (repoRel.startsWith('docs/assets/')) return `/${repoRel.slice(5)}`;
  return `${REPO}/blob/main/${repoRel}${anchor}`;
};

const convert = (rel) => {
  const { locale, slug } = pageInfo(rel);
  let text = readFileSync(join(DOCS, rel), 'utf8').replace(/\r\n/g, '\n');
  // Language switcher line ("**English** · [Deutsch](x.de.md)") – the site has its own.
  text = text.replace(/^(\*\*English\*\*|\[English\]\([^)]*\))[^\n]*\n+/, '');
  const h1 = text.match(/^#\s+(.+)\n/m);
  const title = h1 ? h1[1].replace(/`/g, '').trim() : slug;
  if (h1) text = text.replace(h1[0], '');
  text = text.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, target, t = '') => `](${rewrite(target, rel, locale)}${t})`);
  text = text.replace(/(<img[^>]+src=")(?!https?:|\/)([^"]+)"/g, (m, a, src) => `${a}${rewrite(src, rel, locale)}"`);
  const front = ['---', `title: ${JSON.stringify(title)}`, `editUrl: ${JSON.stringify(`${REPO}/edit/main/docs/${rel}`)}`, '---', ''].join('\n');
  const file = join(OUT, locale === 'de' ? 'de' : '', slug ? `${slug}.md` : 'index.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, front + text.replace(/^\n+/, ''));
};

/** The sidebar: "## Group" headings with "- [label](target) · [label](target)" lines below them. */
const parseIndex = (file) => {
  const groups = [];
  for (const line of readFileSync(join(DOCS, file), 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^##\s+(.+)/);
    if (h) groups.push({ label: h[1].trim(), items: [] });
    else if (groups.length && line.startsWith('- '))
      for (const m of line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) groups.at(-1).items.push({ label: m[1].replace(/\s*\(DE\)$/, ''), target: m[2], de: /\(DE\)$/.test(m[1]) });
  }
  return groups;
};
const sidebar = () => {
  const en = parseIndex('README.md');
  const de = existsSync(join(DOCS, 'README.de.md')) ? parseIndex('README.de.md') : [];
  return en.map((g, gi) => {
    const dg = de[gi];
    const seen = new Set();
    const items = [];
    for (const it of g.items) {
      const deLabel = dg?.items.find((x) => x.target === it.target)?.label;
      const translations = deLabel ? { de: deLabel } : undefined;
      const href = rewrite(it.target, 'README.md', 'root');
      if (seen.has(href)) continue;
      seen.add(href);
      if (href.startsWith('/') && !href.includes('#') && href !== '/')
        items.push({ label: it.label + (it.de ? ' (DE)' : ''), slug: href.replace(/^\/|\/$/g, ''), ...(translations && { translations }) });
      else items.push({ label: it.label, link: href, ...(translations && { translations }), attrs: href.startsWith('http') ? { target: '_blank' } : undefined });
    }
    return { label: g.label, ...(dg && { translations: { de: dg.label } }), items };
  });
};

// Fresh output every run: only the generated pages and the two hand-written home pages live there.
for (const f of readdirSync(OUT, { withFileTypes: true })) {
  if (f.name === 'index.mdx') continue;
  if (f.name === 'de') {
    for (const g of readdirSync(join(OUT, 'de'))) if (g !== 'index.mdx') rmSync(join(OUT, 'de', g), { recursive: true, force: true });
    continue;
  }
  rmSync(join(OUT, f.name), { recursive: true, force: true });
}
for (const rel of pages) convert(rel);
cpSync(join(DOCS, 'assets'), join(SITE, 'public', 'assets'), { recursive: true });
writeFileSync(join(SITE, 'src', 'sidebar.generated.json'), JSON.stringify(sidebar(), null, 2) + '\n');
console.log(`[docs] ${pages.length} pages from docs/ → ${relative(ROOT, OUT)}`);
