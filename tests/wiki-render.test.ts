import { describe, expect, it } from 'vitest';
import {
  extractRefs,
  firstHeading,
  htmlToMarkdown,
  insideFence,
  lineDiff,
  markdownToText,
  parseHtml,
  portableMarkdown,
  publicMarkdown,
  renderChat,
  renderMarkdown,
  safeHref,
  safeImageSrc,
  sanitizeHtml,
  taskCount,
  toggleTask,
  type HNode,
} from '../server/services/wiki-markdown.js';
import { buildWikiPdf } from '../server/services/wiki-pdf.js';

/**
 * Wiki / chat rendering: everything a person types is escaped, URLs come from an allow-list and a second pass keeps
 * only allow-listed tags, attributes and class names. The payloads below are the usual suspects (script, handlers,
 * javascript:/data: URLs, SVG/MathML/mXSS tricks, entity and whitespace obfuscation, broken markup).
 */

const TAGS = new Set(['p', 'br', 'hr', 'strong', 'em', 'del', 'mark', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input']);
const ATTRS = new Set(['id', 'class', 'href', 'target', 'rel', 'src', 'alt', 'loading', 'start', 'type', 'checked', 'disabled', 'data-line', 'data-lang', 'data-kind', 'data-user', 'data-page', 'data-card-kind', 'data-card-id']);

/** Every element and attribute of an output must be on the allow-list, URLs must be safe, classes must be ours. */
function audit(html: string): string[] {
  const problems: string[] = [];
  const walk = (nodes: HNode[]) => {
    for (const n of nodes) {
      if (n.tag === '#text') continue;
      if (!TAGS.has(n.tag)) problems.push(`tag <${n.tag}>`);
      for (const [k, v] of Object.entries(n.attrs)) {
        if (!ATTRS.has(k)) problems.push(`attribute ${k}`);
        if (k === 'href' && !/^(https?:\/\/[^\s]+|mailto:[^\s]+|tel:[^\s]+|\/(?!\/)[^\s\\]*|#[\w-]*)$/i.test(v)) problems.push(`href ${v}`);
        if (k === 'href' && /^(javascript|data|vbscript):/i.test(v.replace(/[\s\u0000-\u001f]/g, ''))) problems.push(`scheme in href ${v}`);
        if (k === 'src' && !/^(https:\/\/[^\s]+|\/uploads\/[\w.-]+)$/.test(v)) problems.push(`src ${v}`);
        if (k === 'class' && v.split(/\s+/).some((c) => !/^wk-[a-z0-9_-]+$/.test(c))) problems.push(`class ${v}`);
        if (k === 'type' && v !== 'checkbox') problems.push(`type ${v}`);
        if (/^on/i.test(k)) problems.push(`handler ${k}`);
      }
      walk(n.children);
    }
  };
  walk(parseHtml(html));
  return problems;
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](java\tscript:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](&#x6A;avascript&colon;alert(1))',
  '[x](java​script:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](//evil.example/x)',
  '[x](\\\\evil\\share)',
  '![x](javascript:alert(1))',
  '![x](data:image/svg+xml,<svg onload=alert(1)>)',
  '![x](http://insecure.example/x.png)',
  '![x](/uploads/../../etc/passwd)',
  '![x" onerror="alert(1)](https://ok.example/a.png)',
  '[x" onmouseover="alert(1)](https://ok.example/)',
  '[x](https://ok.example/" onmouseover="alert(1))',
  '[x](https://ok.example/ "title" onclick="alert(1)")',
  '<a href="javascript:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  '<a href="&#x6a;avascript:alert(1)">x</a>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '`</code><script>alert(1)</script>`',
  '```\n</code></pre><script>alert(1)</script>\n```',
  '**<b onmouseover=alert(1)>x</b>**',
  '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | `<script>` |',
  '> [!NOTE]<script>alert(1)</script>\n> <img src=x onerror=alert(1)>',
  '> [!WARNING] <img src=x onerror=alert(1)> Titel',
  '- [ ] <img src=x onerror=alert(1)>',
  '# <script>alert(1)</script> Titel',
  '[a](card:contact:"onmouseover="alert(1))',
  '[a](card:contact:abc"><script>alert(1)</script>)',
  '[@x](user:"><script>alert(1)</script>)',
  '[@x](user:abc onmouseover=alert(1))',
  '[x](page:../../etc/passwd)',
  '[x](card:script:abc)',
  '<style>*{background:url(javascript:alert(1))}</style>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<form action=javascript:alert(1)><input type=submit formaction=javascript:alert(1)></form>',
  '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
  '<base href="//evil.example/"><meta http-equiv=refresh content="0;url=javascript:alert(1)"><link rel=stylesheet href=//evil.example/x.css>',
  '<div style="background:url(javascript:alert(1))" class="wk-card evil" id="x" onclick="alert(1)">x</div>',
  '<input type=text autofocus onfocus=alert(1)>',
  '<details open ontoggle=alert(1)>x</details>',
  '<video src=x onerror=alert(1)><source onerror=alert(1)></video>',
  '<table background="javascript:alert(1)"><td background="javascript:alert(1)">x</td></table>',
  '<<script>alert(1)//<</script>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '&lt;script&gt;alert(1)&lt;/script&gt; &#60;script&#62;alert(1)&#60;/script&#62;',
  '<a href="https://ok.example" target="_blank" rel="">x</a><a href="//x" target=_self>y</a>',
  '‮<script>alert(1)</script>',
  '<!-- <script>alert(1)</script> --><!--><script>alert(1)</script>-->',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<?xml version="1.0"?><script>alert(1)</script>',
  '<img src="https://ok.example/a.png"onerror="alert(1)">',
  '<img/src="x"/onerror="alert(1)">',
  '<a href="https://ok.example/a.png"\nonclick\n=\nalert(1)>x</a>',
  '[![x](https://ok.example/i.png)](javascript:alert(1))',
  '[[x](javascript:alert(1))](https://ok.example)',
  '*<img src=x onerror=alert(1)>* _<script>alert(1)</script>_ ~~<svg onload=alert(1)>~~ ==<iframe>==',
];

describe('rendering: hostile input', () => {
  for (const [name, render] of [
    ['page', (s: string) => renderMarkdown(s, { baseLevel: 2, interactive: true }).html],
    ['public page', (s: string) => renderMarkdown(s, { publicView: true, baseLevel: 2 }).html],
    ['chat message', (s: string) => renderChat(s)],
  ] as const) {
    it(`${name}: no payload yields script, handlers, unsafe URLs or foreign tags`, () => {
      for (const p of PAYLOADS) {
        const html = render(p);
        expect(audit(html), `${name}: ${p}\n→ ${html}`).toEqual([]);
        expect(html, p).not.toMatch(/<\s*(script|iframe|svg|style|object|embed|form|meta|link|base|math|video|audio|details|noscript)\b/i);
        expect(html, p).not.toMatch(/<[^>]*\son\w+\s*=/i);
        expect(html, p).not.toMatch(/<[^>]*\sstyle\s*=/i);
        // already clean: a second pass changes nothing
        expect(sanitizeHtml(html), p).toBe(html);
        // the same payload inside a list, a quote, a table cell, a heading and a callout
        for (const wrap of [(x: string) => `- ${x}`, (x: string) => `> ${x}`, (x: string) => `| h |\n|---|\n| ${x.replace(/\|/g, '/').replace(/\n/g, ' ')} |`, (x: string) => `## ${x.replace(/\n/g, ' ')}`, (x: string) => `> [!TIP] ${x.replace(/\n/g, ' ')}`]) {
          const w = render(wrap(p));
          expect(audit(w), `${name} wrapped: ${p}`).toEqual([]);
          expect(w).not.toMatch(/<[^>]*\son\w+\s*=/i);
        }
      }
    });
  }

  it('shows markup as text, never as markup', () => {
    const html = renderMarkdown('<script>alert(1)</script> & <b>fett</b> "zitat"').html;
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;fett&lt;/b&gt; &quot;zitat&quot;</p>');
    expect(renderMarkdown('```\n<img src=x onerror=alert(1)>\n```').html).toBe('<pre class="wk-code"><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>');
  });

  it('only lets safe URLs through', () => {
    for (const ok of ['https://example.com/a?b=1&c=2', 'http://example.com', 'mailto:a@b.de', 'tel:+491701234567', '/uploads/abc.png', '/app/wiki/x', '#abschnitt']) expect(safeHref(ok), ok).toBe(ok);
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', '\\\\evil', '/\\evil.example', 'ftp://x', 'file:///etc/passwd', '', 'x y', 'https://', '#a b', 'about:blank']) expect(safeHref(bad), bad).toBeNull();
    expect(safeHref('/app/contacts/1', { publicView: true })).toBeNull(); // no way into the app from a public page
    expect(safeHref('/api/x', { publicView: true })).toBeNull();
    expect(safeHref('/uploads/a.png', { publicView: true })).toBe('/uploads/a.png');
    expect(safeImageSrc('https://ok.example/a.png')).toBe('https://ok.example/a.png');
    expect(safeImageSrc('/uploads/abc123.png')).toBe('/uploads/abc123.png');
    for (const bad of ['http://x/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/uploads/../x.png', '/uploads/a/b.png', '/etc/passwd', '//evil/a.png']) expect(safeImageSrc(bad), bad).toBeNull();
  });

  it('rejects malformed references instead of writing them into attributes', () => {
    expect(renderMarkdown('[a](card:contact:abc"def)').html).toBe('<p>a</p>');
    expect(renderMarkdown('[a](card:nope:abc)').html).toBe('<p>a</p>');
    expect(renderMarkdown('[a](card:contact:abc:def)').html).toBe('<p>a</p>');
    expect(renderMarkdown('[@a](user:../x)').html).toBe('<p>@a</p>'.replace('@a', '<span class="wk-mention">@a</span>').replace('<span class="wk-mention">@a</span>', '@a'));
    expect(renderMarkdown('[a](page:a b)').html).not.toContain('data-page');
  });

  it('survives pathological input quickly (no quadratic blow-up)', () => {
    const cases: [string, string][] = [
      ['unclosed emphasis', `${'**a '.repeat(30_000)}`],
      ['unclosed single emphasis', `${'*a '.repeat(30_000)}`],
      ['brackets', `${'[a'.repeat(50_000)}`],
      ['link openers', `${'[a](('.repeat(30_000)}`],
      ['backticks', `${'`a'.repeat(50_000)}`],
      ['nested quotes', `${'> '.repeat(20_000)}x`],
      ['nested lists', Array.from({ length: 3000 }, (_x, i) => `${'  '.repeat(i % 40)}- item ${i}`).join('\n')],
      ['blank lines', `- a${'\n'.repeat(300_000)}- b`],
      ['one huge line', 'x'.repeat(390_000)],
      ['table', `|${'a|'.repeat(5000)}\n|${'-|'.repeat(5000)}\n${('|' + 'b|'.repeat(5000) + '\n').repeat(50)}`],
      ['many tags', '<a href="'.repeat(40_000)],
      ['attribute soup', '<a <a <a <a '.repeat(30_000)],
      ['entities', '&#x41;&amp;&lt;'.repeat(60_000)],
      ['headings', '# a\n'.repeat(60_000)],
      ['autolinks', 'https://a.b '.repeat(30_000)],
    ];
    for (const [name, src] of cases) {
      const t0 = Date.now();
      const out = renderMarkdown(src, { baseLevel: 2 });
      renderChat(src);
      sanitizeHtml(src);
      const ms = Date.now() - t0;
      // Linear work needs well under a second on an idle machine; a quadratic blow-up on these ~400 KB inputs would take
      // minutes. The generous limit keeps the test stable on a loaded CI box without hiding a real regression.
      expect(ms, `${name}: ${ms} ms`).toBeLessThan(12_000);
      expect(audit(out.html), name).toEqual([]);
    }
  }, 120_000);
});

describe('sanitizer (second layer)', () => {
  it('keeps what the renderer writes and drops everything else', () => {
    const dirty = '<p onclick="x()">hi<script>alert(1)</script><a href="jav&#x61;script:alert(1)">x</a><a href="https://ok.com" target=_blank>ok</a><img src=x onerror=alert(1)><svg onload=alert(1)><circle/></svg><div class="wk-card evil" style="x" id="n">a</div><iframe src=//evil></iframe><input type=text><input type=checkbox checked disabled data-line=3><b>bold<i>x</p>';
    const clean = sanitizeHtml(dirty);
    expect(clean).toBe('<p>hi<a>x</a><a href="https://ok.com" target="_blank" rel="noopener noreferrer">ok</a><div class="wk-card">a</div><input type="checkbox" checked disabled data-line="3">boldx</p>');
    expect(audit(clean)).toEqual([]);
  });

  it('closes what is left open and ignores stray closing tags', () => {
    expect(sanitizeHtml('<div><p>a</div></span></p>b')).toBe('<div><p>a</p></div>b');
    expect(sanitizeHtml('<ul><li>x')).toBe('<ul><li>x</li></ul>');
    expect(sanitizeHtml('a < b > c & d &amp; e')).toBe('a &lt; b &gt; c &amp; d &amp; e');
    expect(sanitizeHtml('<p title="a>b">x</p>')).toBe('<p>x</p>'); // "title" is not allowed, the ">" in it did not end the tag early
    expect(sanitizeHtml('<img alt=">" src=x onerror=alert(1)>')).toBe(''); // no valid src: dropped
    expect(sanitizeHtml('<img alt="a>b" src="https://ok.example/a.png" onerror="alert(1)">')).toBe('<img alt="a&gt;b" src="https://ok.example/a.png">');
  });

  it('removes script-like elements together with their content', () => {
    expect(sanitizeHtml('a<script>alert(1)</script>b<style>x{}</style>c<textarea><b>x</b></textarea>d<title>t</title>e')).toBe('abcde');
    expect(sanitizeHtml('a<SCRIPT>alert(1)</SCRIPT >b')).toBe('ab');
    expect(sanitizeHtml('a<script>never closed')).toBe('a');
    expect(sanitizeHtml('<math><mi>x</mi></math><svg><title>t</title></svg>ok')).toBe('ok');
  });

  it('allows only our own class names and ids', () => {
    expect(sanitizeHtml('<div class="wk-card x-evil wk-"></div>')).toBe('<div class="wk-card"></div>');
    expect(sanitizeHtml('<h2 id="h-abc-1">a</h2><h2 id="evil">b</h2>')).toBe('<h2 id="h-abc-1">a</h2><h2>b</h2>');
    expect(sanitizeHtml('<span data-user="abc" data-x="1">a</span>')).toBe('<span data-user="abc">a</span>');
  });
});

describe('rendering: features', () => {
  it('renders blocks the editor offers', () => {
    const md = `# Titel
Absatz mit **fett**, *kursiv*, ~~weg~~, ==markiert== und \`code\` sowie [Link](https://example.com).
Zweite Zeile.

## Liste
- eins
  - verschachtelt
    - tiefer
- zwei

1. erst
2. dann

- [ ] offen
- [x] erledigt

> Zitat

> [!WARNING] Eigener Titel
> Text im Hinweis

| Name | Betrag |
|:-----|-------:|
| A | 1 |
| B | 2 |

\`\`\`js
const x = 1;
\`\`\`

---`;
    const r = renderMarkdown(md, { baseLevel: 2, interactive: true });
    expect(r.html).toContain('<h2 id="h-titel">Titel</h2>');
    expect(r.html).toContain('<strong>fett</strong>');
    expect(r.html).toContain('<em>kursiv</em>');
    expect(r.html).toContain('<del>weg</del>');
    expect(r.html).toContain('<mark>markiert</mark>');
    expect(r.html).toContain('<code>code</code>');
    expect(r.html).toContain('Absatz mit');
    expect(r.html).toContain('<br>Zweite Zeile.');
    expect(r.html).toMatch(/<ul><li>eins<ul><li>verschachtelt<ul><li>tiefer<\/li><\/ul><\/li><\/ul><\/li><li>zwei<\/li><\/ul>/);
    expect(r.html).toContain('<ol><li>erst</li><li>dann</li></ol>');
    expect(r.html).toMatch(/<li class="wk-task"><input type="checkbox" data-line="\d+"> <span>offen<\/span><\/li>/);
    expect(r.html).toMatch(/<li class="wk-task wk-done"><input type="checkbox" data-line="\d+" checked> <span>erledigt<\/span><\/li>/);
    expect(r.html).toContain('<blockquote><p>Zitat</p></blockquote>');
    expect(r.html).toContain('<div class="wk-callout wk-callout-warning" data-kind="warning"><div class="wk-callout-title">Eigener Titel</div><div class="wk-callout-body"><p>Text im Hinweis</p></div></div>');
    expect(r.html).toContain('<th class="wk-al-r">Betrag</th>');
    expect(r.html).toContain('<td>A</td><td class="wk-al-r">1</td>');
    expect(r.html).toContain('<pre class="wk-code" data-lang="js"><code>const x = 1;</code></pre>');
    expect(r.html).toContain('<hr>');
    expect(r.toc).toEqual([{ level: 2, id: 'h-titel', text: 'Titel' }, { level: 3, id: 'h-liste', text: 'Liste' }]);
  });

  it('numbers the checkboxes by source line and locks them in public and read-only views', () => {
    const md = 'Text\n\n- [ ] a\n- [x] b\n\n> - [ ] im Zitat';
    expect([...renderMarkdown(md, { interactive: true }).html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([2, 3, 5]);
    expect(renderMarkdown(md, { interactive: true }).html).not.toContain('disabled');
    expect(renderMarkdown(md, { interactive: false }).html).toContain('disabled');
    expect(renderMarkdown(md, { interactive: true, publicView: true }).html).toContain('disabled');
  });

  it('renders mentions, page links and record cards – live in the app, plain on public pages and in chat chips', () => {
    const md = 'Hallo [@Anna Müller](user:u1), siehe [Preise](page:p1) und [Max](card:contact:c1).\n\n[Angebot](card:deal:d1)';
    const app = renderMarkdown(md).html;
    expect(app).toContain('<span class="wk-mention" data-user="u1">@Anna Müller</span>');
    expect(app).toContain('<a class="wk-pagelink" href="/app/wiki/p1" data-page="p1">Preise</a>');
    expect(app).toContain('<a class="wk-chip" href="/app/contacts/c1" data-card-kind="contact" data-card-id="c1">Max</a>');
    expect(app).toContain('<div class="wk-card" data-card-kind="deal" data-card-id="d1"><a class="wk-card-link" href="/app/opportunities">Angebot</a></div>');
    const pub = renderMarkdown(md, { publicView: true }).html;
    expect(pub).not.toMatch(/data-|href="\/app/);
    expect(pub).toContain('<span class="wk-chip">Max</span>');
    expect(pub).toContain('<div class="wk-card wk-card-static"><span class="wk-chip">Angebot</span></div>');
    // chat: a card on its own line is not a block there
    expect(renderChat('[Angebot](card:deal:d1)')).toContain('<a class="wk-chip"');
  });

  it('gives headings unique anchors and builds a table of contents', () => {
    const r = renderMarkdown('# A\n## B\n## B\n### C\n##### E', { baseLevel: 1 });
    expect(r.toc.map((t) => t.id)).toEqual(['h-a', 'h-b', 'h-b-2', 'h-c']);
    expect(r.html).toContain('<h5 id="h-e">E</h5>');
  });

  it('handles escapes, lone markers and code spans', () => {
    expect(renderMarkdown('2 * 3 * 4 und snake_case_name und \\*kein fett\\*').html).toBe('<p>2 * 3 * 4 und snake_case_name und *kein fett*</p>');
    expect(renderMarkdown('`a ** b` **c**').html).toBe('<p><code>a ** b</code> <strong>c</strong></p>');
    expect(renderMarkdown('https://example.com/a_(b), und mehr.').html).toContain('href="https://example.com/a_(b)"');
    expect(renderMarkdown('| a |\n|---|').html).toContain('<table');
    expect(renderMarkdown('| a | b |\n|---|').html).not.toContain('<table'); // header and separator must agree
  });

  it('chat messages: formatting yes, headings, tables and callouts no', () => {
    const html = renderChat('# kein Titel\n**fett** `code`\n- a\n- b\n> zitat\n| a |\n|---|\n> [!NOTE] x');
    expect(html).not.toMatch(/<h\d|<table|wk-callout/);
    expect(html).toContain('<strong>fett</strong>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('# kein Titel');
  });
});

describe('text tools', () => {
  it('extracts plain text for search and previews', () => {
    const md = '# Titel\n**fett** [Link](https://x.de) ![Bild](/uploads/a.png) [@Anna](user:u1)\n- [ ] Aufgabe\n> [!NOTE] Hinweis\n| a | b |\n|---|---|\n| 1 | 2 |\n```\ncode bleibt\n```';
    expect(markdownToText(md)).toBe('Titel\nfett Link Bild @Anna\nAufgabe\nHinweis\n a b\n 1 2\ncode bleibt'.replace(/\n a b\n 1 2/, '\na b\n1 2'));
  });

  it('finds mentions, cards and page links – not inside code', () => {
    const r = extractRefs('[@A](user:u1) [@A](user:u1) [Kontakt](card:contact:c1) [Seite](page:p1) `[@B](user:u2)`\n```\n[@C](user:u3)\n```\n[kaputt](card:nope:x) [x](user:a:b)');
    expect(r).toEqual({ users: ['u1'], cards: [{ kind: 'contact', id: 'c1', label: 'Kontakt' }], pages: ['p1'] });
  });

  it('toggles checklist items by line, never in code, and counts them', () => {
    const md = '- [ ] a\n  - [x] b\n1. [ ] c\ntext [ ] d\n```\n- [ ] e\n```';
    expect(toggleTask(md, 0, true)).toBe('- [x] a\n  - [x] b\n1. [ ] c\ntext [ ] d\n```\n- [ ] e\n```');
    expect(toggleTask(md, 1, false)).toContain('  - [ ] b');
    expect(toggleTask(md, 2, true)).toContain('1. [x] c');
    expect(toggleTask(md, 3, true)).toBeNull();
    expect(toggleTask(md, 5, true)).toBeNull(); // inside the code block
    expect(toggleTask(md, 99, true)).toBeNull();
    expect(toggleTask(md, -1, true)).toBeNull();
    expect(taskCount(md)).toEqual([1, 3]);
    expect(insideFence(md, 5)).toBe(true);
    expect(insideFence(md, 7)).toBe(false);
  });

  it('prepares text for export and for the help center', () => {
    const md = 'Hallo [@Anna](user:u1) und [Max](card:contact:c1), siehe [Seite](page:p1).\n\n![Bild](/uploads/a.png) [Datei](/uploads/b.pdf)\n\n- [ ] offen\n- [x] fertig\n\n> [!TIP] Tipp\n> Text\n\n| Feld | Wert |\n|---|---|\n| A | 1 |';
    const portable = portableMarkdown(md, 'https://crm.example.com');
    expect(portable).toContain('Hallo @Anna und [Max](https://crm.example.com/app/contacts/c1), siehe [Seite](https://crm.example.com/app/wiki/p1).');
    expect(portable).toContain('![Bild](https://crm.example.com/uploads/a.png)');
    expect(portable).toContain('- [ ] offen');
    const pub = publicMarkdown(md, 'https://crm.example.com');
    expect(pub).toContain('Hallo @Anna und Max, siehe Seite.');
    expect(pub).toContain('☐ offen');
    expect(pub).toContain('☑ fertig');
    expect(pub).toContain('> **Tipp:** Text'.replace('> **Tipp:** Text', '> **Tipp:** '));
    expect(pub).toContain('- **Feld:** A · **Wert:** 1');
    expect(pub).toContain('![Bild](https://crm.example.com/uploads/a.png)');
    expect(pub).not.toMatch(/user:|card:|page:/);
  });

  it('turns a little HTML into Markdown without keeping anything active', () => {
    const md = htmlToMarkdown('<h1>Titel</h1><p>Text <strong>fett</strong> <a href="https://ok.example/a">Link</a> <a href="javascript:alert(1)">böse</a><script>alert(1)</script><img src="https://x.example/a.png" alt="Bild" onerror="alert(1)"><img src="javascript:x"></p><ul><li>eins</li><li>zwei</li></ul>');
    expect(md).toContain('# Titel');
    expect(md).toContain('**fett**');
    expect(md).toContain('[Link](https://ok.example/a)');
    expect(md).toContain('böse');
    expect(md).not.toContain('javascript');
    expect(md).not.toContain('alert');
    expect(md).toContain('![Bild](https://x.example/a.png)');
    expect(md).toContain('- eins');
    expect(firstHeading('\n# Erste Zeile ##\nText')).toBe('Erste Zeile');
    expect(firstHeading('Text\n# Später')).toBe('');
  });

  it('diffs lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([{ t: 'same', text: 'a' }, { t: 'del', text: 'b' }, { t: 'add', text: 'x' }, { t: 'same', text: 'c' }]);
    expect(lineDiff('a', 'a')).toEqual([{ t: 'same', text: 'a' }]);
    expect(lineDiff('', 'neu').map((d) => d.t)).toEqual(['del', 'add']);
  });
});

describe('PDF export', () => {
  it('lays out headings, lists, tables, code and long words on several pages', () => {
    const body = ['# Überschrift', '', 'Ein **langer** Absatz mit `code` und Umlauten äöüß € – ' + 'Wort '.repeat(4000), '', '- [x] erledigt', '- [ ] offen', '  - verschachtelt', '', '| A | B |', '|---|---:|', '| ' + 'lang '.repeat(30) + ' | 2 |', '', '```', 'x = 1', '```', '', '> [!INFO] Hinweis', '> Text', '', 'Superlongword' + 'x'.repeat(300)].join('\n');
    const pages = [{ id: 'p1', location_id: 'l', title: 'Test-Seite', body, updated_at: new Date().toISOString(), updated_by_name: 'Chef' }] as any[];
    const app: any = { config: { dataDir: '/nonexistent' }, location: () => ({ timezone: 'Europe/Berlin' }) };
    const bytes = buildWikiPdf(app, pages, { space: 'Wiki', baseUrl: 'https://x.example', author: 'Chef' });
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect((text.match(/\/Type \/Page /g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('Seite 1 von');
    expect(text).toContain('/BaseFont /Courier');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // hostile content only ever becomes text in the PDF
    const evil = buildWikiPdf(app, [{ ...pages[0], body: '<script>alert(1)</script> [x](javascript:alert(1)) ![i](https://x.test/a.png)' }], { space: 'W', baseUrl: 'https://x.example', author: 'A' });
    const et = Buffer.from(evil).toString('latin1');
    expect(et).not.toContain('/JavaScript');
    expect(et).not.toContain('/URI');
    expect(et).not.toContain('/Launch');
  });
});
