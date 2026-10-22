#!/usr/bin/env node
/**
 * Translation checks (docs/translating.md) – `npm run i18n:check`; tests/i18n.test.ts runs the same functions.
 *
 *   node scripts/i18n-check.mjs           # every rule, exit code 1 when something is found
 *   node scripts/i18n-check.mjs --json
 *   node scripts/i18n-check.mjs --todo en # what is left to translate into a language, also in namespaces not declared complete
 *
 * German is the source language: the texts in the code are the message ids, the catalogs in web/src/i18n/<lang>/<namespace>.ts
 * map them (web/src/i18n/registry.ts lists languages and namespaces). Rules:
 *  - missing:      a t('…') text of a namespace declared `complete` has no translation (in its own catalog or in core)
 *  - untranslated: a German UI text in a file of a complete namespace that is neither wrapped in t() nor in a catalog –
 *                  JSX text, titles, labels, placeholders, toasts, texts with German words or umlauts. Brand names and
 *                  examples are allowed below; a line may opt out with the comment `i18n-ignore`
 *  - placeholders: a translation uses other {placeholders} than the German text
 *  - unused:       a catalog entry whose German text appears nowhere in its namespace's files any more, nor as a text the
 *                  server sends (error messages, document titles, units)
 *  - registry:     every namespace file exists, every catalog file is registered and every registered catalog exists
 * A namespace may hold part of a file: `pages/Feedback.tsx#FeedbackButton` checks only that component (the top-bar button of
 * a page that is otherwise not translated yet).
 * The TypeScript compiler (a dev dependency) parses the sources, so JSX, comments and types are told apart reliably.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = 'web/src';
const I18N = 'web/src/i18n';

/** Words and names that are the same in every language (brands, protocols, units) – never reported as untranslated. */
export const ALLOW = new Set([
  'HyperLevel', 'GoHighLevel', 'GHL', 'HubSpot', 'Claude', 'Codex', 'ChatGPT', 'OpenAI', 'Anthropic', 'Stripe', 'Twilio', 'Google', 'Gmail', 'Outlook',
  'Microsoft', 'Apple', 'GitHub', 'WhatsApp', 'Instagram', 'Messenger', 'Facebook', 'Telegram', 'Discord', 'Slack', 'Zapier', 'Make', 'Postiz',
  'Zoom', 'Google Meet', 'Teams', 'Jitsi', 'Norman', 'Authy', 'Lexware', 'sevDesk', 'DATEV', 'SEPA', 'IBAN', 'BIC', 'ZUGFeRD', 'XRechnung', 'Factur-X', 'GiroCode', 'Brevo', 'Mailgun',
  'Postmark', 'Resend', 'Hostinger', 'Cloudflare', 'ImprovMX', 'Android', 'iPhone', 'iPad', 'iPhone & iPad', 'iOS', 'Mac', 'Windows', 'Linux', 'Chrome', 'Edge', 'Firefox', 'Safari',
  'SMTP', 'IMAP', 'SMS', 'API', 'URL', 'CSV', 'PDF', 'JSON', 'HTML', 'MCP', 'OK', 'ID', 'UTC', 'iCal', 'ICS', 'UTM', 'SSO', 'OIDC', '2FA', 'BYOK', 'KI', 'AI',
  'DND', 'MB', 'KB', 'GB', 'EUR', 'E-Mail', 'Account SID', 'Auth Token', 'Secret', 'Webhook', 'Webhooks', 'Port', 'Admin', 'Dashboard', 'Opportunities', 'Pipeline', 'Pipelines', 'Tags',
  'Tag', 'Name', 'Status', 'Team', 'Canvas', 'Wiki', 'Boards', 'Tickets', 'Funnels', 'Community', 'Affiliates', 'Attribution', 'Lead-Scoring', 'Social Planner',
]);

const read = (rel, root) => readFileSync(join(root, rel), 'utf8');
const exists = (rel, root) => existsSync(join(root, rel));
const kindOf = (file) => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const parse = (file, src) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindOf(file));
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
const textOf = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined);
const propName = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) ? p.name.text : undefined);

/** An object literal of plain values → JS value (strings, booleans, arrays and nested objects; anything else → undefined). */
function literalValue(n) {
  if (!n) return undefined;
  if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) return literalValue(n.expression);
  const s = textOf(n);
  if (s !== undefined) return s;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(n)) {
    const o = {};
    for (const p of n.properties) if (ts.isPropertyAssignment(p) && propName(p) !== undefined) o[propName(p)] = literalValue(p.initializer);
    return o;
  }
  return undefined;
}

/** Languages, the source language and the namespaces (with their files) from web/src/i18n/registry.ts. */
export function readRegistry(root = repoRoot) {
  const sf = parse('registry.ts', read(`${I18N}/registry.ts`, root));
  const consts = {};
  sf.forEachChild((s) => {
    if (!ts.isVariableStatement(s)) return;
    for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) consts[d.name.text] = d.initializer;
  });
  const locales = Object.keys(literalValue(consts.LOCALES) ?? {});
  const source = literalValue(consts.SOURCE_LOCALE);
  const namespaces = literalValue(consts.NAMESPACES) ?? {};
  /** CATALOGS: { en: { core: () => import('./en/core') } } → { en: { core: 'web/src/i18n/en/core.ts' } } */
  const catalogs = {};
  const cat = consts.CATALOGS;
  const obj = cat && (ts.isObjectLiteralExpression(cat) ? cat : ts.isAsExpression(cat) || ts.isSatisfiesExpression(cat) ? cat.expression : undefined);
  for (const p of obj?.properties ?? []) {
    if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) continue;
    catalogs[propName(p)] = {};
    for (const q of p.initializer.properties) {
      const spec = q.initializer && /import\('([^']+)'\)/.exec(q.initializer.getText(sf))?.[1];
      if (spec) catalogs[propName(p)][propName(q)] = `${I18N}/${spec.replace(/^\.\//, '')}.ts`;
    }
  }
  return { locales, source, namespaces, catalogs };
}

/** `export default { 'Speichern': 'Save', '{n} Kontakte': { one: '…', other: '…' } }` → entries with their line. */
export function readCatalog(rel, root = repoRoot) {
  const sf = parse(rel, read(rel, root));
  const out = new Map();
  sf.forEachChild((s) => {
    if (!ts.isExportAssignment(s)) return;
    let e = s.expression;
    while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isObjectLiteralExpression(e)) return;
    for (const p of e.properties) if (ts.isPropertyAssignment(p) && propName(p) !== undefined) out.set(propName(p), { value: literalValue(p.initializer), line: lineOf(sf, p) });
  });
  return out;
}

const UI_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'hint', 'sub', 'empty', 'text', 'message', 'tooltip', 'heading', 'description', 'caption', 'aria-description', 'aria-valuetext', 'confirm', 'aria']);
const CODE_ATTRS = /^(className|class|key|tour|href|to|src|type|id|name|role|rel|target|autoComplete|inputMode|htmlFor|method|icon|tone|kind|size|variant|mode|align|value|defaultValue|lang|dept|accept|pattern|d|viewBox|fill|stroke|xmlns|loading|style|width|height|min|max|step|form|data-.*|aria-(hidden|current|live|expanded|haspopup|controls|selected|pressed|busy|modal|checked|orientation))$/;
const UI_CALLS = new Set(['toast', 'confirmAsk', 'confirm', 'alert', 'prompt', 'setErr', 'setError', 'setMsg', 'setWaiting', 'Error']);
const CODE_CALLS = /^(console\.\w+|api\.\w+|navigate|fetch|addEventListener|removeEventListener|dispatchEvent|Event|CustomEvent|querySelector(All)?|getElementById|matchMedia|setItem|getItem|removeItem|setAttribute|getAttribute|Intl\.\w+|RegExp|require|import|preload|whenIdle|lazyPages|useT|tr|setLocation|history\.\w+|split|join|replace|includes|startsWith|endsWith|indexOf|test|match|toLocaleString|toLocaleDateString|toLocaleTimeString|announce|report|add)$/;
const GERMAN = /[äöüÄÖÜß]|\b(und|oder|nicht|kein|keine|keinen|keiner|mit|für|von|vom|zum|zur|der|die|das|den|dem|des|ein|eine|einen|einem|einer|ist|sind|wird|werden|wurde|auf|aus|bei|nach|noch|schon|alle|alles|jetzt|bitte|hier|dein|deine|deinen|deiner|dich|dir|du|ich|wir|ihr|im|bis|ohne|gibt|kann|soll|muss|neu|neue|neuer|neues|neuen|wählen|speichern|anlegen|bearbeiten|zurück|weiter|abbrechen|senden|suchen|wenn|dann|aber|auch|nur|wie|mehr|als|seit|heute|gestern|morgen|Woche|Monat|Jahr)\b/i;
const NOUN = /^[A-ZÄÖÜ][\p{L}-]*[a-zäöüß][\p{L}-]*( [\p{L}-]+){0,3}[.:!?…]?$/u;

function calleeName(e) {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const left = ts.isIdentifier(e.expression) ? e.expression.text : '';
    return left === 'console' || left === 'api' || left === 'Intl' || left === 'history' ? `${left}.${e.name.text}` : e.name.text;
  }
  return '';
}

/**
 * What a source file holds: t() texts (static first argument of a translator: `t`, or a name bound to useT()/tr()), every string
 * literal (for dynamic keys such as menu labels), and – if `scan` – the German UI texts it shows without translation.
 */
export function scanSource(rel, src, { catalogKeys = new Set(), scan = true, only } = {}) {
  const sf = parse(rel, src);
  const lines = src.split('\n');
  const translators = new Set(['t']);
  const calls = [];
  const literals = new Set();
  const untranslated = [];
  // Names bound to a translator (const t = useT('x'); const tc = tr('core')).
  const findTranslators = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && ['useT', 'tr'].includes(calleeName(n.initializer.expression))) translators.add(n.name.text);
    n.forEachChild(findTranslators);
  };
  findTranslators(sf);
  const isTranslatorCall = (n) => ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && translators.has(n.expression.text)) || (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'plural' && ts.isIdentifier(n.expression.expression) && translators.has(n.expression.expression.text)));
  const keyNodes = new Set();
  const ignored = (node) => /i18n-ignore/.test(lines[lineOf(sf, node) - 1] ?? '') || /i18n-ignore/.test(lines[lineOf(sf, node) - 2] ?? '');

  /** The top-level declaration a node belongs to (function, const, class) – for files translated only in part (`file.tsx#A,B`). */
  const topName = (node) => {
    let n = node;
    while (n.parent && n.parent !== sf) n = n.parent;
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) return n.name.text;
    if (ts.isVariableStatement(n)) return n.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : '')).join(',');
    return '';
  };
  const report = (node, text, why) => {
    if (!inScope(node)) return;
    const s = text.replace(/\s+/g, ' ').trim();
    // merge tags ({{contact.first_name}}) and placeholders are code, not words
    const words = s.replace(/\{\{[^}]*\}\}|\{\w+\}/g, ' ');
    if (!/\p{L}.*\p{L}/u.test(words) || ALLOW.has(s) || catalogKeys.has(s) || ignored(node)) return;
    // examples and code-like values: import-2026, smtp.example.com, +49…, https://…
    if (/^[a-z0-9._@:/+#=?&%~…-]+$/.test(s) || /^<[a-z][\s\S]*>$/i.test(s) || /^[{[]["{[]/.test(s)) return;
    untranslated.push({ line: lineOf(sf, node), text: s, why });
  };

  /** Where a literal sits: in an attribute, a call argument, rendered directly, or as a plain value. */
  const context = (node) => {
    let n = node;
    while (n.parent && (ts.isConditionalExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || (ts.isBinaryExpression(n.parent) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.PlusToken].includes(n.parent.operatorToken.kind)) || ts.isTemplateSpan(n.parent) || ts.isTemplateExpression(n.parent))) {
      if (ts.isConditionalExpression(n.parent) && n.parent.condition === n) return { kind: 'code' };
      n = n.parent;
    }
    const p = n.parent;
    if (!p) return { kind: 'value' };
    if (ts.isJsxExpression(p)) {
      const holder = p.parent;
      if (ts.isJsxAttribute(holder)) return { kind: 'attr', name: holder.name.getText(sf) };
      return { kind: 'jsx' };
    }
    if (ts.isJsxAttribute(p)) return { kind: 'attr', name: p.name.getText(sf) };
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const name = calleeName(p.expression);
      if (name === 'act' && p.arguments?.[1] === n) return { kind: 'ui' };
      return { kind: CODE_CALLS.test(name) ? 'code' : UI_CALLS.has(name) ? 'ui' : 'arg' };
    }
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return { kind: 'code' };
    if (ts.isCaseClause(p) || ts.isElementAccessExpression(p) || ts.isLiteralTypeNode(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isImportTypeNode(p)) return { kind: 'code' };
    if (ts.isPropertyAssignment(p) && p.name === n) return { kind: 'code' };
    if (ts.isArrayLiteralExpression(p) || ts.isPropertyAssignment(p)) return { kind: 'data' };
    return { kind: 'value' };
  };

  const inScope = (node) => !only || topName(node).split(',').some((x) => only.has(x));
  const visit = (n) => {
    if (isTranslatorCall(n) && inScope(n)) {
      const plural = ts.isPropertyAccessExpression(n.expression);
      if (plural) {
        const forms = n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1]) ? literalValue(n.arguments[1]) : undefined;
        if (forms?.other) calls.push({ key: forms.other, forms, line: lineOf(sf, n) });
        if (n.arguments[1]) keyNodes.add(n.arguments[1]);
      } else {
        const key = n.arguments[0] && textOf(n.arguments[0]);
        if (key !== undefined) calls.push({ key, line: lineOf(sf, n) });
        if (n.arguments[0]) keyNodes.add(n.arguments[0]);
      }
    }
    if (keyNodes.has(n)) {
      // the message id itself (and plural forms) are what the catalogs translate
      n.forEachChild((c) => void keyNodes.add(c));
    } else if (scan) {
      if (ts.isJsxText(n)) report(n, n.text, 'JSX text');
      const s = textOf(n);
      if (s !== undefined || ts.isTemplateExpression(n)) {
        const text = s ?? [n.head.text, ...n.templateSpans.map((x) => x.literal.text)].join('…');
        if (!(ts.isTemplateExpression(n.parent) || ts.isTemplateSpan(n.parent))) {
          const c = context(n);
          if (c.kind === 'attr') {
            if (UI_ATTRS.has(c.name)) report(n, text, `attribute ${c.name}`);
            else if (!CODE_ATTRS.test(c.name) && GERMAN.test(text)) report(n, text, `attribute ${c.name}`);
          } else if (c.kind === 'jsx' || c.kind === 'ui') report(n, text, c.kind === 'jsx' ? 'rendered text' : 'message');
          else if (c.kind !== 'code' && (GERMAN.test(text) || (c.kind === 'data' && NOUN.test(text.trim())))) report(n, text, 'German text');
        }
      }
    }
    const s = textOf(n);
    if (s !== undefined) literals.add(s);
    n.forEachChild(visit);
  };
  visit(sf);
  return { calls, literals, untranslated };
}

const walk = (dir, root) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel, root) : /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) ? [rel] : [];
  });

/** Runs every rule. Returns findings `{ rule, file, line, text, locale? }`. `todo` adds the gaps of namespaces not declared complete. */
export function checkTranslations(root = repoRoot, { todo = false } = {}) {
  const reg = readRegistry(root);
  const findings = [];
  const add = (rule, file, line, text, extra = {}) => findings.push({ rule, file, line, text, ...extra });
  const targets = reg.locales.filter((l) => l !== reg.source);

  // catalogs
  const catalogs = {};
  for (const l of targets) {
    catalogs[l] = {};
    for (const ns of Object.keys(reg.namespaces)) {
      const rel = reg.catalogs[l]?.[ns];
      if (!rel) continue;
      if (!exists(rel, root)) add('registry', `${I18N}/registry.ts`, 0, `catalog ${rel} is registered but missing`);
      else catalogs[l][ns] = readCatalog(rel, root);
    }
    const dir = `${I18N}/${l}`;
    if (exists(dir, root))
      for (const f of readdirSync(join(root, dir))) {
        const rel = `${dir}/${f}`;
        if (!Object.values(reg.catalogs[l] ?? {}).includes(rel)) add('registry', rel, 0, `catalog file is not registered in CATALOGS.${l}`);
      }
  }

  // sources
  const allKeys = new Set(targets.flatMap((l) => Object.values(catalogs[l]).flatMap((c) => [...c.keys()])));
  const perNs = {};
  for (const [ns, meta] of Object.entries(reg.namespaces)) {
    perNs[ns] = { calls: [], literals: new Set(), files: [] };
    for (const entry of meta.files ?? []) {
      // `pages/Feedback.tsx#FeedbackButton`: only these top-level components of the file are translated (and checked)
      const [f, part] = entry.split('#');
      const only = part ? new Set(part.split(',')) : undefined;
      const rel = `${WEB}/${f}`;
      if (!exists(rel, root)) {
        add('registry', `${I18N}/registry.ts`, 0, `namespace ${ns}: file ${rel} does not exist`);
        continue;
      }
      const keys = new Set([...targets.flatMap((l) => [...(catalogs[l][ns]?.keys() ?? []), ...(catalogs[l].core?.keys() ?? [])])]);
      const r = scanSource(rel, read(rel, root), { catalogKeys: keys, scan: !!meta.complete, only });
      perNs[ns].files.push(rel);
      for (const c of r.calls) perNs[ns].calls.push({ ...c, file: rel });
      for (const s of r.literals) perNs[ns].literals.add(s);
      for (const u of r.untranslated) add('untranslated', rel, u.line, u.text, { why: u.why });
    }
  }

  // missing + placeholders
  const tokens = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  for (const [ns, meta] of Object.entries(reg.namespaces)) {
    if (!meta.complete && !todo) continue;
    for (const l of targets) {
      const own = catalogs[l][ns];
      const core = catalogs[l].core;
      const seen = new Set();
      for (const c of perNs[ns].calls) {
        if (seen.has(c.key)) continue;
        seen.add(c.key);
        if (!own?.has(c.key) && !core?.has(c.key)) add(meta.complete ? 'missing' : 'todo', c.file, c.line, c.key, { locale: l, namespace: ns });
      }
    }
  }
  for (const l of targets)
    for (const [ns, cat] of Object.entries(catalogs[l])) {
      const rel = reg.catalogs[l][ns];
      for (const [key, { value, line }] of cat) {
        const want = tokens(key);
        const values = typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value) : [];
        if (!values.length || values.some((v) => typeof v !== 'string')) add('placeholders', rel, line, `${key}: the translation must be a string or plural forms`);
        if (value && typeof value === 'object' && typeof value.other !== 'string') add('placeholders', rel, line, `${key}: plural forms need "other"`);
        for (const v of values) for (const tok of tokens(v)) if (!want.has(tok) && !(tok === 'n' && typeof value === 'object')) add('placeholders', rel, line, `${key} → ${v}: {${tok}} is not in the German text`);
      }
    }

  // unused
  const allCalls = new Set(Object.values(perNs).flatMap((x) => x.calls.map((c) => c.key)));
  let serverLiterals;
  const serverText = () => {
    if (serverLiterals) return serverLiterals;
    serverLiterals = new Set();
    for (const f of walk('server', root)) for (const s of scanSource(f, read(f, root), { scan: false }).literals) serverLiterals.add(s);
    for (const s of scanSource(`${I18N}/index.ts`, read(`${I18N}/index.ts`, root), { scan: false }).literals) serverLiterals.add(s);
    return serverLiterals;
  };
  for (const l of targets)
    for (const [ns, cat] of Object.entries(catalogs[l])) {
      const meta = reg.namespaces[ns];
      const rel = reg.catalogs[l][ns];
      for (const [key, { line }] of cat) {
        // A key is in use when its namespace calls t() with it, shows it as a value (menu labels, states), or – for texts that
        // arrive as data, like the server's document titles and units – when the server sends it.
        const used = meta?.server ? serverText().has(key) : perNs[ns]?.calls.some((c) => c.key === key) || perNs[ns]?.literals.has(key) || (ns === 'core' ? allCalls.has(key) : serverText().has(key));
        if (!used) add('unused', rel, line, key, { locale: l });
      }
    }
  void allKeys;
  return findings;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const todoAt = args.indexOf('--todo');
  const all = checkTranslations(repoRoot, { todo: todoAt >= 0 });
  const findings = todoAt >= 0 ? all.filter((f) => f.rule === 'todo' || f.rule === 'missing') : all;
  if (args.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else if (!findings.length) console.log('i18n: every declared namespace is complete, nothing untranslated or unused.');
  else {
    for (const f of findings) console.log(`${f.rule.padEnd(12)} ${relative(repoRoot, join(repoRoot, f.file))}${f.line ? `:${f.line}` : ''}  ${f.locale ? `[${f.locale}] ` : ''}${f.text}${f.why ? `  (${f.why})` : ''}`);
    console.log(`\n${findings.length} finding(s) – see docs/translating.md`);
  }
  process.exit(findings.length && todoAt < 0 ? 1 : 0);
}
