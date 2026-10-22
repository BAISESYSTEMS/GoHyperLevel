import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { App } from '../core/app.js';
import { contentMatches, extFor } from '../core/files.js';
import { bad, notFound, str } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { actorOf, filesDir, json, logTask, mentionsIn, notifyUser, removeFiles, storedPath, team, type Actor } from './pm-core.js';
import { getTask, taskRow, type TaskOut } from './pm-tasks.js';

/** Comments with @mentions and attachments (links and small files) on tasks. */

export interface CommentOut {
  id: string;
  task_id: string;
  user_id: string | null;
  author_name: string;
  body: string;
  mentions: { id: string; name: string }[];
  via: string | null;
  created_at: string;
  edited_at: string | null;
}

const commentOut = (app: App, locationId: string, c: any): CommentOut => {
  const people = new Map(team(app, locationId).map((p) => [p.id, p.name]));
  return { ...c, mentions: json<string[]>(c.mentions, []).filter((u) => people.has(u)).map((u) => ({ id: u, name: people.get(u)! })) };
};

export function listComments(app: App, locationId: string, taskId: string): CommentOut[] {
  taskRow(app, locationId, taskId);
  return app.db.all<any>('SELECT * FROM pm_comments WHERE task_id = ? AND location_id = ? ORDER BY created_at, rowid LIMIT 1000', taskId, locationId).map((c) => commentOut(app, locationId, c));
}

/** Tells the people a comment is for: mentioned people, then the task's assignees and watchers. */
function notifyComment(app: App, task: TaskOut, c: { id: string; body: string }, actor: Actor, mentioned: string[], onlyNew?: string[]) {
  const preview = c.body.replace(/\s+/g, ' ').slice(0, 160);
  for (const u of mentioned) {
    if (u === actor.id || (onlyNew && !onlyNew.includes(u))) continue;
    notifyUser(app, { locationId: task.location_id, userId: u, kind: 'mention', title: `${actor.name} hat dich erwähnt: ${task.title}`, body: preview, taskId: task.id, projectId: task.project_id, ref: `mention:${c.id}:${u}` });
  }
  if (onlyNew) return;
  const rest = new Set([...task.assignees.map((a) => a.id), ...task.watchers]);
  for (const u of rest) {
    if (u === actor.id || mentioned.includes(u)) continue;
    notifyUser(app, { locationId: task.location_id, userId: u, kind: 'comment', title: `${actor.name} hat „${task.title}“ kommentiert`, body: preview, taskId: task.id, projectId: task.project_id, ref: `comment:${c.id}:${u}`, quiet: false });
  }
}

export function addComment(app: App, locationId: string, taskId: string, b: any, actor: Actor): CommentOut {
  const task = getTask(app, locationId, taskId);
  const body = str(b.body, 'Kommentar', { required: true, max: 10_000 });
  const mentions = mentionsIn(app, locationId, body, b.mentions);
  const row = { id: newId(), location_id: locationId, task_id: task.id, user_id: actor.id, author_name: actor.name.slice(0, 200), body, mentions: JSON.stringify(mentions), via: actor.via ?? null, created_at: now(), edited_at: null };
  app.db.tx(() => {
    app.db.insert('pm_comments', row);
    // Whoever is mentioned follows the task from now on.
    for (const u of mentions) app.db.run('INSERT OR IGNORE INTO pm_watchers (task_id, user_id, created_at) VALUES (?, ?, ?)', task.id, u, now());
    if (actor.id && (actor.via === 'session' || actor.via === 'app')) app.db.run('INSERT OR IGNORE INTO pm_watchers (task_id, user_id, created_at) VALUES (?, ?, ?)', task.id, actor.id, now());
    app.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), task.id);
    logTask(app, task, actor, 'comment', { id: row.id });
  });
  const fresh = getTask(app, locationId, task.id);
  notifyComment(app, fresh, row, actor, mentions);
  app.events.emit(locationId, 'task.commented', { contactId: task.contact_id ?? undefined, task: fresh, comment: { id: row.id, body }, mentions });
  return commentOut(app, locationId, row);
}

export function editComment(app: App, locationId: string, commentId: string, b: any, actor: Actor, isManager: boolean): CommentOut {
  const c = app.db.get<any>('SELECT * FROM pm_comments WHERE id = ? AND location_id = ?', commentId, locationId);
  if (!c) throw notFound('Kommentar nicht gefunden');
  if (c.user_id !== actor.id && !isManager) throw bad('Nur eigene Kommentare bearbeiten');
  const body = str(b.body, 'Kommentar', { required: true, max: 10_000 });
  const before = new Set(json<string[]>(c.mentions, []));
  const mentions = mentionsIn(app, locationId, body, b.mentions);
  app.db.run('UPDATE pm_comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?', body, JSON.stringify(mentions), now(), c.id);
  const fresh = getTask(app, locationId, c.task_id);
  notifyComment(app, fresh, { id: c.id, body }, actor, mentions, mentions.filter((u) => !before.has(u)));
  return commentOut(app, locationId, app.db.get('SELECT * FROM pm_comments WHERE id = ?', c.id));
}

export function deleteComment(app: App, locationId: string, commentId: string, actor: Actor, isManager: boolean) {
  const c = app.db.get<any>('SELECT * FROM pm_comments WHERE id = ? AND location_id = ?', commentId, locationId);
  if (!c) throw notFound('Kommentar nicht gefunden');
  if (c.user_id !== actor.id && !isManager) throw bad('Nur eigene Kommentare löschen');
  app.db.run('DELETE FROM pm_comments WHERE id = ?', c.id);
  return { ok: true };
}

// --- attachments --------------------------------------------------------------------------------

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 40;
/** Types accepted as files; HTML, SVG and scripts are not among them (links cover the rest). */
export const FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/zip',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
];

export interface AttachmentOut {
  id: string;
  task_id: string;
  kind: 'file' | 'link';
  name: string;
  url: string | null;
  mime: string | null;
  size: number;
  created_by: string | null;
  created_at: string;
}
const attachmentOut = (a: any): AttachmentOut => ({ id: a.id, task_id: a.task_id, kind: a.kind, name: a.name, url: a.kind === 'link' ? a.url : `/api/pm/attachments/${a.id}/file`, mime: a.mime, size: a.size, created_by: a.created_by, created_at: a.created_at });

export function listAttachments(app: App, locationId: string, taskId: string): AttachmentOut[] {
  taskRow(app, locationId, taskId);
  return app.db.all<any>('SELECT * FROM pm_attachments WHERE task_id = ? AND location_id = ? ORDER BY created_at', taskId, locationId).map(attachmentOut);
}

function assertRoom(app: App, taskId: string) {
  if (Number(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pm_attachments WHERE task_id = ?', taskId)?.n) >= MAX_ATTACHMENTS) throw bad(`Höchstens ${MAX_ATTACHMENTS} Anhänge je Aufgabe`);
}

export function addLink(app: App, locationId: string, taskId: string, b: any, actor: Actor): AttachmentOut {
  const task = taskRow(app, locationId, taskId);
  const url = str(b.url, 'Link', { required: true, max: 1000 });
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw bad('Link: bitte mit https:// angeben');
  assertRoom(app, task.id);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the raw text */
  }
  const row = { id: newId(), location_id: locationId, task_id: task.id, kind: 'link', name: str(b.name, 'Name', { max: 200 }) || host, url, file: null, mime: null, size: 0, created_by: actor.id, created_at: now() };
  app.db.insert('pm_attachments', row);
  logTask(app, task, actor, 'attachment', { name: row.name });
  return attachmentOut(row);
}

export function addFile(app: App, locationId: string, taskId: string, b: any, actor: Actor): AttachmentOut {
  const task = taskRow(app, locationId, taskId);
  const mime = String(b.mime ?? '').toLowerCase().split(';')[0].trim();
  if (!FILE_TYPES.includes(mime)) throw bad('Dateityp nicht erlaubt (Bilder, PDF, Office, Text, CSV, ZIP) – andere Dateien als Link anhängen');
  const raw = String(b.data ?? '').replace(/^data:[^,]*,/, '');
  if (!raw) throw bad('Datei fehlt');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw bad('Datei ist leer');
  if (buf.length > MAX_FILE_BYTES) throw bad('Datei ist zu groß (höchstens 8 MB)');
  if (!contentMatches(mime, buf)) throw bad('Der Inhalt passt nicht zum Dateityp');
  assertRoom(app, task.id);
  const id = newId();
  const stored = `${id}${extFor(mime)}`;
  mkdirSync(filesDir(app), { recursive: true });
  writeFileSync(storedPath(app, stored), buf, { mode: 0o600 });
  const name = (str(b.name, 'Name', { max: 200 }) || 'Datei').replace(/[\r\n"\\/]/g, '_');
  const row = { id, location_id: locationId, task_id: task.id, kind: 'file', name, url: null, file: stored, mime, size: buf.length, created_by: actor.id, created_at: now() };
  app.db.insert('pm_attachments', row);
  logTask(app, task, actor, 'attachment', { name });
  return attachmentOut(row);
}

/** The stored file of an attachment of this sub-account (for the download route). */
export function attachmentFile(app: App, locationId: string, attachmentId: string): { path: string; name: string; mime: string } {
  const a = app.db.get<any>(`SELECT * FROM pm_attachments WHERE id = ? AND location_id = ? AND kind = 'file'`, attachmentId, locationId);
  if (!a || !a.file) throw notFound('Anhang nicht gefunden');
  const path = storedPath(app, a.file);
  if (!existsSync(path)) throw notFound('Datei nicht mehr vorhanden');
  return { path, name: a.name, mime: a.mime };
}

export function deleteAttachment(app: App, locationId: string, attachmentId: string) {
  const a = app.db.get<any>('SELECT * FROM pm_attachments WHERE id = ? AND location_id = ?', attachmentId, locationId);
  if (!a) throw notFound('Anhang nicht gefunden');
  app.db.run('DELETE FROM pm_attachments WHERE id = ?', a.id);
  removeFiles(app, [a.file]);
  return { ok: true };
}

export { actorOf, removeFiles };
