/**
 * Office (Dokumente, Tabellen, Präsentationen, PDF) as data: the four kinds of file, their types and limits, how names, links,
 * commands and edit locks are checked. Pure code without Node or browser APIs – modules/office*.ts and services/office-*.ts decide
 * with it, the web app (web/src/pages/Office*.tsx) reads the same tables. Contract and limits: docs/office.md.
 */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'pdf';
export const OFFICE_KINDS: OfficeKind[] = ['docx', 'xlsx', 'pptx', 'pdf'];

export interface KindInfo {
  /** Name in the UI (German, neutral – never an upstream product name). */
  label: string;
  /** One item, for "Neues Dokument" and the like. */
  one: string;
  mime: string;
  ext: string;
  /** Extensions a save in the browser editor may come back with: the kind's own, or the editor's native format the server converts. */
  saveExts: string[];
  /** The editor's own "save to a download" shortcut (the spreadsheet editor saves a dropped file only through Save As). */
  saveShift?: true;
}

export const KINDS: Record<OfficeKind, KindInfo> = {
  docx: { label: 'Dokumente', one: 'Dokument', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', saveExts: ['docx'] },
  xlsx: { label: 'Tabellen', one: 'Tabelle', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', saveExts: ['xlsx'], saveShift: true },
  pptx: { label: 'Präsentationen', one: 'Präsentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx', saveExts: ['pptx', 'deckcraft'] },
  pdf: { label: 'PDF', one: 'PDF', mime: 'application/pdf', ext: 'pdf', saveExts: ['pdf'] },
};

export const isKind = (v: unknown): v is OfficeKind => typeof v === 'string' && (OFFICE_KINDS as string[]).includes(v);

/** The kind of an upload: from the claimed type, else from the file name's extension. */
export function kindOf(mime: unknown, name: unknown): OfficeKind | null {
  const m = String(mime ?? '').toLowerCase();
  for (const k of OFFICE_KINDS) if (KINDS[k].mime === m) return k;
  const ext = String(name ?? '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  return ext && isKind(ext) ? ext : null;
}

/** Edit lock ("ausgecheckt"): it ends on its own unless the open editor renews it. */
export const LOCK_TTL_MS = 5 * 60_000;
/** The browser renews its lock this often while the editor is open. */
export const LOCK_RENEW_MS = 60_000;

export const LIMITS = {
  name: 160,
  message: 300,
  comment: 4000,
  commands: 200,
  /** Characters of text an agent read returns (the rest is cut, with a note). */
  readChars: 60_000,
  listMax: 200,
};

const DEFAULT_NAMES: Record<OfficeKind, string> = { docx: 'Neues Dokument', xlsx: 'Neue Tabelle', pptx: 'Neue Präsentation', pdf: 'Neues PDF' };

/** A file name as people give it: trimmed, no path or control characters, and ending in the kind's extension. */
export function cleanName(raw: unknown, kind: OfficeKind): string {
  let s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  // a name coming from a path keeps only its last part
  s = s.replace(/^\.+/, '').trim();
  const ext = `.${KINDS[kind].ext}`;
  if (s.toLowerCase().endsWith(ext)) s = s.slice(0, -ext.length).trim();
  if (!s) s = DEFAULT_NAMES[kind];
  return `${s.slice(0, LIMITS.name - ext.length)}${ext}`;
}

/** Keys in command parameters that could name a file, folder or address on the server – never passed to an engine. */
const PATH_KEYS = new Set(['path', 'paths', 'file', 'files', 'filename', 'dir', 'directory', 'folder', 'root', 'src', 'source', 'out', 'output', 'url', 'uri', 'href', 'link', 'csv', 'target', 'dest', 'destination', 'template']);
const PATH_KEY_RE = /(path|file|dir|folder|url|uri|href)$/i;
/** Command families that open, save, export or reach outside the document – the server does that itself. */
const BLOCKED_PREFIX = /^(file|app|ui|tools\.macro|macro|mailings?\.(source|data|open)|print|share|window|help)\b/i;
/** pdf steps: only tools that change the open document (the server opens and saves it itself; nothing that reads or writes other files, prints or adds scripts). */
const PDF_TOOLS = /^(page_(delete|duplicate|insert_blank|move|rotate|set_box|add_text|number)|text_(edit|color)|comment_(add|delete|edit|reply|set_status|lock|mark)|bookmark_(add|delete|move|rename|set_page)|form_(fill|reset|add_field|delete_field|set_props|tab_order)|label_[a-z_]+|redact_(mark|apply|clear)|doc_(set_info|watermark|header_footer|protect|unprotect|flatten|initial_view|background|remove_hidden|remove_marks|optimize|reduce)|undo|redo)$/;

export interface OfficeCommand {
  command: string;
  params: Record<string, unknown>;
}

const COMMAND_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

function checkParams(v: unknown, at: string, depth = 0): void {
  if (depth > 8) throw new Error(`${at}: Parameter zu tief verschachtelt`);
  if (Array.isArray(v)) {
    if (v.length > 10_000) throw new Error(`${at}: zu viele Werte`);
    v.forEach((x, i) => checkParams(x, `${at}[${i}]`, depth + 1));
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (PATH_KEYS.has(k.toLowerCase()) || PATH_KEY_RE.test(k)) throw new Error(`${at}: Parameter „${k}“ ist nicht erlaubt (Dateien und Adressen setzt der Server)`);
      checkParams(x, `${at}.${k}`, depth + 1);
    }
    return;
  }
  if (typeof v === 'string' && v.length > 200_000) throw new Error(`${at}: Text zu lang`);
}

/**
 * Commands for an engine, checked: known shape, no file/folder/URL parameters, no command that opens, saves or exports by
 * itself (the server hands the engine a temporary copy and stores the result as a new version). Throws a German message.
 */
export function cleanCommands(raw: unknown, kind: OfficeKind): OfficeCommand[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('commands muss eine Liste sein');
  if (raw.length > LIMITS.commands) throw new Error(`Höchstens ${LIMITS.commands} Befehle auf einmal`);
  return raw.map((c, i) => {
    const at = `Befehl ${i + 1}`;
    const obj = typeof c === 'string' ? { command: c } : c;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${at}: erwartet {command, params}`);
    const id = String((obj as any).command ?? (obj as any).tool ?? '').trim();
    if (!COMMAND_ID.test(id)) throw new Error(`${at}: ungültiger Befehlsname`);
    if (kind === 'pdf' ? !PDF_TOOLS.test(id) : BLOCKED_PREFIX.test(id)) throw new Error(`${at}: „${id}“ ist hier nicht erlaubt – Öffnen, Speichern und Export übernimmt HyperLevel`);
    const params = (obj as any).params ?? (obj as any).args ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(`${at}: params muss ein Objekt sein`);
    checkParams(params, at);
    return { command: id, params: params as Record<string, unknown> };
  });
}

/** Range writes for spreadsheets: `{range: "A1:C2", values: [[…]], sheet?}` → engine commands. */
export function writesToCommands(raw: unknown): OfficeCommand[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('writes muss eine Liste sein');
  if (raw.length > LIMITS.commands) throw new Error(`Höchstens ${LIMITS.commands} Bereiche auf einmal`);
  const out: OfficeCommand[] = [];
  raw.forEach((w, i) => {
    const at = `Bereich ${i + 1}`;
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error(`${at}: erwartet {range, values}`);
    const range = String((w as any).range ?? '').trim().toUpperCase();
    if (!/^\$?[A-Z]{1,3}\$?\d{1,7}(:\$?[A-Z]{1,3}\$?\d{1,7})?$/.test(range)) throw new Error(`${at}: ungültiger Zellbereich (z. B. A1 oder A1:C3)`);
    const values = (w as any).values;
    if (!Array.isArray(values) || !values.every((r) => Array.isArray(r))) throw new Error(`${at}: values muss eine Liste von Zeilen sein`);
    for (const row of values) for (const v of row) if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new Error(`${at}: Zellwerte müssen Text, Zahl, Wahrheitswert oder leer sein`);
    const sheet = (w as any).sheet;
    if (sheet !== undefined && sheet !== null && sheet !== '') {
      if (typeof sheet !== 'string' || sheet.length > 100) throw new Error(`${at}: ungültiger Blattname`);
      out.push({ command: 'sheet.activate', params: { sheet } });
    }
    checkParams(values, at);
    out.push({ command: 'range.setValues', params: { range, values } });
  });
  return out;
}

export interface LockRow {
  file_id: string;
  user_id: string | null;
  user_name: string;
  acquired_at: string;
  expires_at: string;
}

/** The lock that is still in force (expired ones count as free). */
export const activeLock = (l: LockRow | undefined | null, at = Date.now()): LockRow | null => (l && Date.parse(l.expires_at) > at ? l : null);

/** May `userId` write now? Free, or the lock is theirs. */
export const lockAllows = (l: LockRow | undefined | null, userId: string | null | undefined, at = Date.now()): boolean => {
  const a = activeLock(l, at);
  return !a || (!!userId && a.user_id === userId);
};

export const lockMessage = (l: LockRow) => `${l.user_name || 'Jemand'} bearbeitet die Datei gerade – sie ist bis ${new Date(l.expires_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })} Uhr gesperrt. Schreibgeschützt öffnen oder später erneut versuchen.`;

/** How a version's author shows in the history. */
export function authorLabel(v: { author_name: string; author_kind: string }): string {
  if (v.author_kind === 'agent' && !v.author_name.endsWith('(KI-App)') && !v.author_name.startsWith('KI-Agent')) return `KI-Agent (im Auftrag von ${v.author_name})`;
  return v.author_name || 'Unbekannt';
}
