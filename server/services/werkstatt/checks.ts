import { OPS } from './ops.js';
import { NAMES } from './names.js';
import { hasUi, needsServer, type Manifest } from './manifest.js';
import { validateSteps } from './declarative.js';

/**
 * Static checks before a plugin version may become active: size limits, forbidden APIs, external URLs
 * (only hosts the manifest declares *and* an admin allowed), operations vs. declared scopes, entry points vs.
 * code, declarative steps. They are guard rails and good feedback for the AI (the messages go back to it
 * for a repair round) – the real protection is the runtime: sandboxed iframe + CSP, scope-checking bridge,
 * permission-restricted child process. A pattern scan cannot stop a determined attacker, and does not try to.
 */

export const SIZE_LIMITS = { manifest: 8_000, ui: 200_000, server: 100_000, steps: 40_000, total: 320_000 };

export interface PluginFiles {
  manifest: Manifest;
  ui_html: string;
  server_js: string;
  steps: unknown;
}
export interface CheckIssue {
  level: 'error' | 'warn';
  code: string;
  message: string;
}
export interface CheckResult {
  ok: boolean;
  issues: CheckIssue[];
  stats: { ui_bytes: number; server_bytes: number; external_hosts: string[]; ops: string[]; scopes_used: string[] };
}
export interface CheckOptions {
  /** Hosts an admin allowed (policy.allowed_hosts). */
  allowedHosts: string[];
  serverLogic: 'script' | 'declarative' | 'off';
  /** Is the child-process sandbox usable on this server? */
  sandboxOk: boolean;
}

interface Rule {
  re: RegExp;
  code: string;
  message: string;
}

/** Things neither the UI nor server code may use (browser/Node features that reach outside the plugin). */
const COMMON: Rule[] = [
  { re: /\beval\s*\(/, code: 'eval', message: 'eval() ist nicht erlaubt.' },
  { re: /\bnew\s+Function\b|(?<![.\w])Function\s*\(/, code: 'function-ctor', message: 'Function(...) / new Function ist nicht erlaubt.' },
  { re: /\b__proto__\b|\bconstructor\s*\.\s*constructor\b|\bconstructor\s*\[/, code: 'proto', message: '__proto__ und constructor.constructor sind nicht erlaubt.' },
  { re: /\bWebAssembly\b/, code: 'wasm', message: 'WebAssembly ist nicht erlaubt.' },
  { re: /\bimportScripts\b/, code: 'import-scripts', message: 'importScripts ist nicht erlaubt.' },
  { re: /\bXMLHttpRequest\b/, code: 'xhr', message: 'XMLHttpRequest ist nicht erlaubt – Daten gibt es nur über die gohigh-Funktionen.' },
  { re: /\bfetch\s*\(/, code: 'fetch', message: 'fetch() ist nicht erlaubt – Daten gibt es nur über die gohigh-Funktionen.' },
  { re: /\bWebSocket\b|\bEventSource\b/, code: 'socket', message: 'WebSocket/EventSource sind nicht erlaubt.' },
  { re: /\bimport\s*\(/, code: 'dynamic-import', message: 'import() ist nicht erlaubt.' },
];
const UI_ONLY: Rule[] = [
  { re: /\bdocument\s*\.\s*cookie\b/, code: 'cookie', message: 'document.cookie ist nicht erlaubt.' },
  { re: /\b(?:localStorage|sessionStorage|indexedDB)\b/, code: 'browser-storage', message: 'localStorage/sessionStorage/indexedDB sind nicht erlaubt – nutze gohigh.storage.' },
  { re: /\bnavigator\s*\.\s*(?:sendBeacon|serviceWorker|geolocation|mediaDevices|clipboard)\b|\bgetUserMedia\b/, code: 'navigator', message: 'navigator.sendBeacon/serviceWorker/geolocation/mediaDevices/clipboard sind nicht erlaubt.' },
  { re: /\b(?:webkit)?RTCPeerConnection\b|\bRTCDataChannel\b/, code: 'webrtc', message: 'WebRTC ist nicht erlaubt.' },
  { re: /\b(?:Shared)?Worker\s*\(|\bcaches\s*\./, code: 'worker', message: 'Worker und Cache-API sind nicht erlaubt.' },
  { re: /\bwindow\s*\.\s*open\b|(?<![.\w])open\s*\(\s*['"`]/, code: 'window-open', message: 'window.open ist nicht erlaubt – nutze gohigh.navigate("contacts/…").' },
  { re: /\b(?:window|document|self|top|parent)\s*\.\s*location\b|(?<!\b(?:const|let|var)\s+)(?<![.\w])location\s*(?:\.\s*(?:href|assign|replace|reload|open)\b|=(?!=))/, code: 'location', message: 'location.* ist nicht erlaubt – nutze gohigh.navigate("contacts/…").' },
  { re: /\b(?:window|self|globalThis)\s*\.\s*(?:top|parent|opener|frameElement)\b|(?<![.\w])(?:opener|frameElement)\b/, code: 'frame-escape', message: 'Zugriff auf top/parent/opener ist nicht erlaubt.' },
  { re: /\bpostMessage\b|addEventListener\s*\(\s*['"`]message['"`]/, code: 'post-message', message: 'postMessage ist nicht erlaubt – die gohigh-Funktionen übernehmen die Verbindung zu HyperLevel.' },
  { re: /\bdocument\s*\.\s*(?:write|writeln|domain)\b/, code: 'document-write', message: 'document.write/domain sind nicht erlaubt.' },
  { re: /\bAtomics\b|\bSharedArrayBuffer\b/, code: 'shared-memory', message: 'Atomics/SharedArrayBuffer sind nicht erlaubt.' },
  { re: /javascript\s*:/i, code: 'js-url', message: 'javascript:-Adressen sind nicht erlaubt.' },
  { re: /\bcreateElement\s*\(\s*['"`](?:iframe|frame|object|embed|script|link|meta|base)['"`]/i, code: 'create-element', message: 'iframe/object/embed/script/link/meta/base lassen sich nicht erzeugen.' },
];
const SERVER_ONLY: Rule[] = [
  { re: /\brequire\s*\(/, code: 'require', message: 'require() gibt es in der Sandbox nicht.' },
  { re: /^\s*(?:import|export)\b/m, code: 'esm', message: 'Kein import/export: das Skript läuft als einfaches Skript.' },
  { re: /\bprocess\b|\bBuffer\b|\bglobalThis\s*\.\s*(?:process|require)\b/, code: 'node', message: 'process und Buffer gibt es in der Sandbox nicht.' },
  { re: /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b/, code: 'timers', message: 'Timer gibt es in der Sandbox nicht – warte mit await auf gohigh-Aufrufe.' },
  { re: /\b(?:ArrayBuffer|Uint8Array|Int8Array|Uint16Array|Int16Array|Uint32Array|Int32Array|Float32Array|Float64Array|DataView|SharedArrayBuffer|Atomics)\b/, code: 'buffers', message: 'Binärdaten (ArrayBuffer, typed arrays) gibt es in der Sandbox nicht.' },
];
/** Tags the UI fragment may not contain (it is only a body fragment; the frame supplies everything else). */
const FORBIDDEN_TAGS = ['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'html', 'head', 'body', 'title'];
/** Attributes that navigate, embed or phone home. */
const FORBIDDEN_ATTRS = /\s(?:srcdoc|formaction|http-equiv|ping)\s*=/i;

const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, ' ');
/** Removes line and block comments of JavaScript (keeps `://` inside URLs). */
const stripJsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** Inline scripts of a UI fragment (what the self-test runs) and the markup without them. */
export function splitUi(html: string): { scripts: string[]; markup: string } {
  const scripts: string[] = [];
  const markup = html.replace(SCRIPT_RE, (_m, _a, body: string) => (scripts.push(body), ' '));
  return { scripts, markup };
}

const URL_RE = /(?:https?:)?\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?[^\s"'<>)\\`]*/gi;
/** Namespace URIs are identifiers, not connections. */
const NAMESPACE_HOSTS = new Set(['www.w3.org']);

function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    let host = '';
    try {
      host = new URL(m[0].startsWith('//') ? `https:${m[0]}` : m[0]).hostname.toLowerCase();
    } catch {
      host = '';
    }
    if (host && !NAMESPACE_HOSTS.has(host)) out.add(host);
  }
  return [...out];
}

const opsUsed = (code: string) => {
  const used = new Set<string>();
  for (const m of code.matchAll(/\bgohigh\s*\.\s*([a-z]+)\s*\.\s*([A-Za-z]+)\s*\(/g)) used.add(`${m[1]}.${m[2]}`);
  for (const m of code.matchAll(/\bgohigh\s*\.\s*call\s*\(\s*['"`]([\w.]+)['"`]/g)) used.add(m[1]);
  return used;
};
const NAMESPACES = new Set(Object.keys(OPS).map((o) => o.split('.')[0]));

export function staticChecks(files: PluginFiles, opts: CheckOptions): CheckResult {
  const issues: CheckIssue[] = [];
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => issues.push({ level: 'warn', code, message });
  const m = files.manifest;
  const ui = files.ui_html ?? '';
  const server = files.server_js ?? '';
  const stepsJson = files.steps === undefined || files.steps === null ? '' : JSON.stringify(files.steps);

  // --- sizes ----------------------------------------------------------------------------------
  const manifestSize = JSON.stringify(m).length;
  if (manifestSize > SIZE_LIMITS.manifest) err('size-manifest', `Das Manifest ist zu groß (${manifestSize} von ${SIZE_LIMITS.manifest} Zeichen).`);
  if (ui.length > SIZE_LIMITS.ui) err('size-ui', `Die Oberfläche ist zu groß (${Math.round(ui.length / 1000)} von ${SIZE_LIMITS.ui / 1000} KB).`);
  if (server.length > SIZE_LIMITS.server) err('size-server', `Der Server-Code ist zu groß (${Math.round(server.length / 1000)} von ${SIZE_LIMITS.server / 1000} KB).`);
  if (stepsJson.length > SIZE_LIMITS.steps) err('size-steps', `Die Schritte sind zu groß (${Math.round(stepsJson.length / 1000)} von ${SIZE_LIMITS.steps / 1000} KB).`);
  if (manifestSize + ui.length + server.length + stepsJson.length > SIZE_LIMITS.total) err('size-total', `Das Plugin ist insgesamt zu groß (höchstens ${SIZE_LIMITS.total / 1000} KB).`);

  // --- entry points vs. code --------------------------------------------------------------------
  if (hasUi(m) && ui.trim().length < 20) err('ui-missing', 'Das Manifest hat eine Oberfläche (page, panels oder widgets), aber ui_html ist leer.');
  if (!hasUi(m) && ui.trim()) warn('ui-unused', 'ui_html ist gesetzt, aber das Manifest hat weder page, panels noch widgets.');
  const mode = m.server?.mode;
  if (needsServer(m)) {
    if (opts.serverLogic === 'off') err('server-off', 'Server-Logik ist laut Richtlinie ausgeschaltet – Aktionen und Jobs sind nicht möglich.');
    if (mode === 'script') {
      if (opts.serverLogic === 'declarative') err('server-script-off', 'Die Richtlinie erlaubt nur deklarative Schritte (server.mode "declarative"), keine Skripte.');
      else if (!opts.sandboxOk) err('sandbox', 'Die Skript-Sandbox ist auf diesem Server nicht verfügbar (Node-Rechtemodell) – bitte server.mode "declarative" nutzen.');
      if (server.trim().length < 20) err('server-missing', 'server.mode ist "script", aber server_js ist leer.');
      for (const a of m.entries.actions ?? []) if (!new RegExp(`gohigh\\s*\\.\\s*action\\s*\\(\\s*['"\`]${a.id}['"\`]`).test(server)) err('action-missing', `Aktion „${a.id}“ steht im Manifest, aber server_js ruft gohigh.action('${a.id}', …) nicht auf.`);
      for (const j of m.entries.jobs ?? []) if (!new RegExp(`gohigh\\s*\\.\\s*job\\s*\\(\\s*['"\`]${j.id}['"\`]`).test(server)) err('job-missing', `Job „${j.id}“ steht im Manifest, aber server_js ruft gohigh.job('${j.id}', …) nicht auf.`);
    } else if (mode === 'declarative') {
      const v = validateSteps(files.steps, m);
      for (const e of v.errors) err('steps', e);
    }
  } else if (server.trim() || stepsJson.length > 2) warn('server-unused', 'Server-Code oder Schritte sind gesetzt, aber das Manifest hat keine Aktionen oder Jobs.');
  if (mode === 'declarative' && server.trim()) warn('server-ignored', 'server_js wird bei server.mode "declarative" nicht ausgeführt.');

  // --- forbidden APIs ---------------------------------------------------------------------------
  const { scripts, markup } = splitUi(stripHtmlComments(ui));
  const uiCode = stripJsComments(scripts.join('\n;\n'));
  const attrCode = markup.replace(STYLE_RE, ' ');
  const serverCode = stripJsComments(server);
  const flag = (where: string, rules: Rule[], text: string) => {
    for (const r of rules) if (r.re.test(text)) err(`${where}-${r.code}`, `${where === 'ui' ? 'Oberfläche' : 'Server-Code'}: ${r.message}`);
  };
  flag('ui', [...COMMON, ...UI_ONLY], uiCode);
  // Inline event handlers (onclick="…") are code, too.
  const handlers = [...attrCode.matchAll(/\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((x) => x[2] ?? x[3] ?? '').join('\n;\n');
  if (handlers) flag('ui', [...COMMON, ...UI_ONLY], stripJsComments(handlers));
  flag('server', [...COMMON, ...SERVER_ONLY], serverCode);
  for (const tag of FORBIDDEN_TAGS) if (new RegExp(`<\\s*${tag}\\b`, 'i').test(markup)) err('ui-tag', `Oberfläche: <${tag}> ist nicht erlaubt (nur ein Body-Fragment ohne iframe/object/embed/base/meta/link).`);
  if (/<\s*script\b[^>]*\btype\s*=\s*["']?module/i.test(markup + ui)) err('ui-module', 'Oberfläche: <script type="module"> ist nicht erlaubt.');
  if (/(?:href|src|action|formaction|xlink:href)\s*=\s*["']?\s*(?:javascript|vbscript)\s*:/i.test(attrCode)) err('ui-js-url', 'Oberfläche: javascript:-Adressen sind nicht erlaubt.');
  if (FORBIDDEN_ATTRS.test(attrCode)) err('ui-attr', 'Oberfläche: srcdoc, formaction, http-equiv und ping sind nicht erlaubt.');
  if (/\sform\b[^>]*\saction\s*=/i.test(attrCode) || /<\s*form\b[^>]*\saction\s*=/i.test(attrCode)) err('ui-form-action', 'Oberfläche: <form action> ist nicht erlaubt – Eingaben mit JavaScript an gohigh übergeben.');
  if (/@import\b|expression\s*\(/i.test([...ui.matchAll(STYLE_RE)].map((x) => x[1]).join('\n') + attrCode)) err('ui-css-import', 'Oberfläche: @import und expression() im CSS sind nicht erlaubt.');

  // --- external URLs ----------------------------------------------------------------------------
  const found = [...new Set([...hostsIn(stripHtmlComments(ui).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (s) => stripJsComments(s))), ...hostsIn(serverCode)])];
  const declared = m.externalHosts ?? [];
  for (const h of found) {
    if (!declared.includes(h)) err('url-undeclared', `Externe Adresse ${h} – Hosts müssen im Manifest unter externalHosts stehen (und ein Admin muss sie freigeben).`);
  }
  for (const h of declared) if (!opts.allowedHosts.includes(h)) err('url-not-allowed', `Der Host ${h} ist nicht freigegeben – ein Admin kann ihn unter ${NAMES.werkstatt} → Richtlinien erlauben.`);
  if (server && hostsIn(serverCode).length) err('url-server', 'Server-Code hat keinen Netzwerkzugriff – Adressen darin sind nicht erlaubt.');
  if (/<a\b[^>]*\shref\s*=\s*["'](?!#|https?:|\/\/)/i.test(attrCode)) warn('ui-relative-link', 'Links zu internen Seiten bitte mit gohigh.navigate("contacts/…") statt href lösen.');

  // --- operations vs. scopes ----------------------------------------------------------------------
  const used = new Set<string>([...opsUsed(uiCode), ...opsUsed(stripJsComments(handlers)), ...opsUsed(serverCode)]);
  const scopesUsed = new Set<string>();
  for (const op of used) {
    const def = OPS[op];
    if (!def) {
      if (NAMESPACES.has(op.split('.')[0])) err('op-unknown', `Unbekannte Funktion ${op} – verfügbar sind nur die Funktionen der Referenz.`);
      continue;
    }
    if (def.scope) {
      scopesUsed.add(def.scope);
      if (!m.scopes.includes(def.scope)) err('scope-missing', `${op}() braucht die Berechtigung „${def.scope}“ im Manifest (scopes).`);
    }
  }
  for (const s of m.scopes) if (!scopesUsed.has(s)) warn('scope-unused', `Die Berechtigung „${s}“ wird im Code nicht benutzt – bitte nur anfragen, was nötig ist.`);

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    stats: { ui_bytes: ui.length, server_bytes: server.length, external_hosts: found, ops: [...used].sort(), scopes_used: [...scopesUsed].sort() },
  };
}

/** The messages of failed checks as one text block (for the AI's repair round and the build log). */
export const issuesText = (r: CheckResult) => r.issues.filter((i) => i.level === 'error').map((i) => `- ${i.message}`).join('\n');
