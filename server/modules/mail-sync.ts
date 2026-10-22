import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { id, now } from '../core/util.js';
import { isPrivateIp } from '../services/net.js';
import { importMessages } from './email-import.js';

/**
 * Mailbox sync: an agency mailbox (e.g. Gmail with an app password) is read over IMAP every few
 * minutes. Rules decide which project each mail belongs to (by address, domain, subject or any
 * text); inbox, sent mail and drafts land in that project's Konversationen. Mail matching no rule
 * is ignored unless a default project is set – so newsletters don't flood the CRM.
 */

export interface MailRule {
  field: 'address' | 'domain' | 'subject' | 'any';
  value: string;
  location_id: string;
}

export interface ParsedMail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  direction: 'in' | 'out';
}

const addr = (s: string) => (String(s).match(/<([^>]+)>/)?.[1] ?? String(s)).trim().toLowerCase();

/** Which project a mail belongs to, or null (not imported). */
export function routeMail(rules: MailRule[], defaultLocation: string | null, m: ParsedMail): string | null {
  const parties = (m.direction === 'in' ? [m.from] : [...m.to, ...m.cc]).map(addr).filter(Boolean);
  const subject = m.subject.toLowerCase();
  for (const r of rules) {
    const v = String(r.value ?? '').trim().toLowerCase();
    if (!v || !r.location_id) continue;
    const hit =
      r.field === 'address' ? parties.includes(v)
      : r.field === 'domain' ? parties.some((a) => a.endsWith(`@${v}`) || a.endsWith(`.${v}`))
      : r.field === 'subject' ? subject.includes(v)
      : `${subject} ${parties.join(' ')} ${m.body.slice(0, 4000).toLowerCase()}`.includes(v);
    if (hit) return r.location_id;
  }
  return defaultLocation || null;
}

/** Moved to core (shared by every module); re-exported for the modules that import them from here. */
export { openSecret, sealSecret };

/** The subset of ImapFlow the sync uses (tests pass a fake). */
export interface ImapLike {
  connect(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  mailbox: false | { uidValidity: bigint | number; uidNext: number; exists: number };
  search(q: any, o?: any): Promise<number[] | false>;
  fetch(range: any, q: any, o?: any): AsyncIterable<{ uid: number; source?: Buffer; flags?: Set<string> }>;
  logout(): Promise<void>;
}
export type ImapFactory = (cfg: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }) => ImapLike;
const defaultFactory: ImapFactory = (cfg) => new ImapFlow({ ...cfg, logger: false }) as unknown as ImapLike;

const FIRST_SYNC_DAYS = 30;
const MAX_PER_FOLDER = 300;

async function toItem(raw: Buffer, own: string) {
  const p = await simpleParser(raw);
  const list = (v: any) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x: any) => x.value ?? []).map((a: any) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean) : []);
  const from = list(p.from)[0] ?? '';
  const text = p.text || String(p.html || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return {
    messageId: (p.messageId ?? '').replace(/[<>]/g, '') || createHash('sha256').update(raw).digest('hex').slice(0, 32),
    from,
    to: list(p.to),
    cc: list(p.cc),
    subject: p.subject ?? '',
    body: String(text).slice(0, 20_000),
    date: p.date?.toISOString(),
    direction: (addr(from) === own ? 'out' : 'in') as 'in' | 'out',
  };
}

export async function syncMailbox(app: App, accountId: string, factory: ImapFactory = defaultFactory) {
  const acc = parseJson(app.db.get('SELECT * FROM mail_accounts WHERE id = ?', accountId), ['rules', 'state']);
  if (!acc) throw notFound();
  const own = String(acc.own_address || acc.username).toLowerCase();
  const rules: MailRule[] = acc.rules ?? [];
  const state: Record<string, { uidValidity: string; lastUid: number }> = acc.state ?? {};
  const source = `Postfach ${acc.name}`.slice(0, 60);
  const batches = new Map<string, any[]>();
  const currentDrafts = new Set<string>();
  let fetched = 0;
  if (!process.env.PGHL_ALLOW_PRIVATE_FETCH) {
    const ips = await lookup(acc.host, { all: true }).catch(() => []);
    if (ips.some((x) => isPrivateIp(x.address))) throw new HttpError(400, 'IMAP-Server liegt in einem internen Netz');
  }
  const client = factory({ host: acc.host, port: acc.port, secure: !!acc.secure, auth: { user: acc.username, pass: openSecret(app, acc.password) } });
  await client.connect();
  try {
    const boxes = await client.list();
    const folders: [string, 'inbox' | 'sent' | 'drafts'][] = [['INBOX', 'inbox']];
    const sent = boxes.find((b) => b.specialUse === '\\Sent')?.path;
    const drafts = boxes.find((b) => b.specialUse === '\\Drafts')?.path;
    if (sent) folders.push([sent, 'sent']);
    if (drafts) folders.push([drafts, 'drafts']);
    for (const [path, kind] of folders) {
      const lock = await client.getMailboxLock(path);
      try {
        const box = client.mailbox;
        if (!box) continue;
        const prev = state[path];
        const validity = String(box.uidValidity);
        let lastUid = prev && prev.uidValidity === validity ? prev.lastUid : 0;
        let range: any;
        if (kind === 'drafts') range = '1:*';
        else if (lastUid) range = `${lastUid + 1}:*`;
        else {
          const found = await client.search({ since: new Date(Date.now() - FIRST_SYNC_DAYS * 864e5) }, { uid: true });
          range = (found || []).slice(-MAX_PER_FOLDER);
          if (!range.length) {
            state[path] = { uidValidity: validity, lastUid: Math.max(0, (box.uidNext ?? 1) - 1) };
            continue;
          }
        }
        if (!box.exists) {
          state[path] = { uidValidity: validity, lastUid };
          continue;
        }
        let n = 0;
        for await (const msg of client.fetch(range, { uid: true, source: true, flags: true }, { uid: true })) {
          if (kind !== 'drafts' && msg.uid <= lastUid) continue;
          if (!msg.source) continue;
          const item = await toItem(msg.source, own);
          if (kind === 'drafts') {
            const ext = `imap:${acc.id}:draft:${item.messageId}`;
            currentDrafts.add(ext);
          }
          if (kind !== 'drafts') lastUid = Math.max(lastUid, msg.uid);
          const direction = kind === 'inbox' ? item.direction : 'out';
          const loc = routeMail(rules, acc.default_location_id, { ...item, direction });
          if (!loc || !app.location(loc)) continue;
          const list = batches.get(loc) ?? [];
          list.push({
            external_id: `imap:${acc.id}:${kind === 'drafts' ? 'draft' : 'mail'}:${item.messageId}`,
            direction,
            status: kind === 'drafts' ? 'draft' : undefined,
            from: item.from,
            to: item.to,
            subject: item.subject,
            body: item.body,
            date: item.date,
            unread: kind === 'inbox' && !(msg.flags?.has('\\Seen') ?? false),
          });
          batches.set(loc, list);
          fetched++;
          if (++n >= MAX_PER_FOLDER) break;
        }
        state[path] = { uidValidity: validity, lastUid };
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  let created = 0;
  for (const [loc, list] of batches) created += importMessages(app, loc, list, { ownAddress: own, source }).created;
  // Drafts that were sent or deleted in the mailbox disappear here as well.
  const old = app.db.all(`SELECT id, external_id FROM messages WHERE status = 'draft' AND external_id LIKE ?`, `imap:${acc.id}:draft:%`);
  let removed = 0;
  for (const m of old) if (!currentDrafts.has(m.external_id)) removed += app.db.run('DELETE FROM messages WHERE id = ?', m.id).changes;
  app.db.run('UPDATE mail_accounts SET state = ?, last_sync_at = ?, last_error = NULL, last_result = ? WHERE id = ?', JSON.stringify(state), now(), JSON.stringify({ fetched, created, removed }), acc.id);
  return { fetched, created, removed };
}

const RULE_FIELDS = ['address', 'domain', 'subject', 'any'];

export const mailSyncModule: Module = {
  name: 'mail-sync',
  migrations: [
    [
      '001-init',
      `CREATE TABLE mail_accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 993, secure INTEGER NOT NULL DEFAULT 1,
        username TEXT NOT NULL, password TEXT NOT NULL, own_address TEXT NOT NULL DEFAULT '', default_location_id TEXT,
        rules TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT, last_error TEXT, last_result TEXT, created_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const out = (a: any) => {
      const r = parseJson(a, ['rules']);
      const { password: _p, state: _s, ...rest } = r;
      return { ...rest, last_result: a.last_result ? JSON.parse(a.last_result) : null, password_set: !!a.password };
    };
    const clean = (b: any, cur: any = {}) => {
      const row: Record<string, any> = {};
      if (b.name !== undefined || !cur.id) row.name = str(b.name ?? cur.name, 'Name', { required: true, max: 100 });
      if (b.host !== undefined || !cur.id) {
        const host = str(b.host ?? 'imap.gmail.com', 'Server', { required: true, max: 200 }).toLowerCase();
        if (!/^[a-z0-9.-]+$/.test(host)) throw bad('Server ungültig');
        row.host = host;
      }
      if (b.port !== undefined) row.port = Math.max(1, Math.min(65535, num(b.port, 993)));
      if (b.secure !== undefined) row.secure = b.secure ? 1 : 0;
      if (b.username !== undefined || !cur.id) row.username = str(b.username ?? cur.username, 'Benutzer', { required: true, max: 200 });
      if (b.password) row.password = sealSecret(app, str(b.password, 'Passwort', { max: 300 }));
      else if (!cur.id) throw bad('Passwort fehlt (bei Gmail: App-Passwort)');
      if (b.own_address !== undefined) row.own_address = str(b.own_address, 'Eigene Adresse', { max: 200 }).toLowerCase();
      if (b.default_location_id !== undefined) {
        if (b.default_location_id && !app.location(String(b.default_location_id))) throw notFound('Projekt nicht gefunden');
        row.default_location_id = b.default_location_id || null;
      }
      if (b.rules !== undefined) {
        if (!Array.isArray(b.rules)) throw bad('Regeln als Liste');
        row.rules = b.rules.slice(0, 200).map((r: any) => {
          if (!RULE_FIELDS.includes(r?.field)) throw bad('Regel: Feld unbekannt');
          if (!app.location(String(r.location_id ?? ''))) throw bad('Regel: Projekt nicht gefunden');
          return { field: r.field, value: str(r.value, 'Regel-Wert', { required: true, max: 200 }), location_id: String(r.location_id) };
        });
      }
      if (b.enabled !== undefined) row.enabled = b.enabled ? 1 : 0;
      return row;
    };

    router.get('/api/agency/mail-accounts', 'admin', () => db.all('SELECT * FROM mail_accounts ORDER BY created_at').map(out));
    router.post('/api/agency/mail-accounts', 'admin', (ctx) => {
      const row: Record<string, any> = { id: id(), port: 993, secure: 1, own_address: '', rules: [], state: {}, enabled: 1, created_at: now(), ...clean(ctx.body ?? {}) };
      if (!row.own_address) row.own_address = String(row.username).toLowerCase();
      db.insert('mail_accounts', row);
      return out(db.get('SELECT * FROM mail_accounts WHERE id = ?', row.id));
    });
    router.patch('/api/agency/mail-accounts/:id', 'admin', (ctx) => {
      const cur = db.get('SELECT * FROM mail_accounts WHERE id = ?', ctx.params.id);
      if (!cur) throw notFound();
      db.update('mail_accounts', cur.id, clean(ctx.body ?? {}, cur));
      return out(db.get('SELECT * FROM mail_accounts WHERE id = ?', cur.id));
    });
    router.delete('/api/agency/mail-accounts/:id', 'admin', (ctx) => {
      if (!db.run('DELETE FROM mail_accounts WHERE id = ?', ctx.params.id).changes) throw notFound();
      return { ok: true };
    });
    router.post('/api/agency/mail-accounts/:id/sync', 'admin', async (ctx) => {
      try {
        return await syncMailbox(app, ctx.params.id, app.services.imapFactory);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) throw e;
        const msg = (e as Error).message || 'Fehler';
        db.run('UPDATE mail_accounts SET last_error = ?, last_sync_at = ? WHERE id = ?', msg.slice(0, 500), now(), ctx.params.id);
        throw new HttpError(502, `Postfach: ${msg}`);
      }
    });

    let last = 0;
    let running = false;
    app.onTick(async () => {
      if (running || Date.now() - last < 5 * 60_000) return;
      last = Date.now();
      running = true;
      try {
        for (const a of db.all('SELECT id FROM mail_accounts WHERE enabled = 1')) {
          try {
            await syncMailbox(app, a.id, app.services.imapFactory);
          } catch (e) {
            db.run('UPDATE mail_accounts SET last_error = ?, last_sync_at = ? WHERE id = ?', String((e as Error).message).slice(0, 500), now(), a.id);
          }
        }
      } finally {
        running = false;
      }
    });
  },
};
