import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type User } from '../core/http.js';
import { now } from '../core/util.js';
import {
  AREAS,
  SCREENSHOT_MAX,
  SEVERITIES,
  WISH_BOARD,
  RateLimiter,
  cleanArea,
  cleanDiagnostics,
  cleanSeverity,
  kindOfCategory,
  publicStatus,
  type FeedbackKind,
} from '../services/feedback.js';
import {
  STAGES_OF_BOARD,
  addUserMessage,
  autoCaptureOn,
  createItem,
  getItem,
  isLinked,
  itemByTicket,
  loadFeedbackSettings,
  notifyReply,
  notifyUsers,
  numberOf,
  onStatusChanged,
  prefsOf,
  publicThread,
  readFile,
  roleLabel,
  serverVersion,
  setStatus,
  statusOf,
  ticketOf,
  urlOf,
  vote,
  type FeedbackRow,
} from '../services/feedback-store.js';

/**
 * „Fehler & Wünsche“ for every login (agency admins and client logins alike): report a bug or ask
 * a question with diagnostics and a screenshot, follow „Meine Meldungen“, vote on and comment the
 * public wish list, read „Was ist neu“. Everything lands as tickets in the agency's support
 * sub-account (services/feedback-store.ts); triage lives in feedback-admin.ts, automatic error
 * capture in feedback-capture.ts. Routes are open to every signed-in user on purpose (not in
 * permissions.ts) and only ever return the caller's own reports or public wish data.
 */

const reportLimit = new RateLimiter(15, 10 * 60_000);
const dailyLimit = new RateLimiter(50, 24 * 3600_000);
const commentLimit = new RateLimiter(30, 3600_000);
const voteLimit = new RateLimiter(120, 3600_000);

const filesOf = (app: App, f: FeedbackRow): { id: string; mime: string; size: number; user_id: string | null; created_at: string; url: string }[] =>
  app.db.all('SELECT id, mime, size, user_id, created_at FROM feedback_files WHERE feedback_id = ? ORDER BY created_at', f.id).map((x) => ({ id: x.id, mime: x.mime, size: x.size, user_id: x.user_id, created_at: x.created_at, url: `/api/feedback/files/${x.id}` }));

/** Sub-account the report was sent from – only one the user may open. */
function originOf(app: App, user: User, v: unknown): string | null {
  const loc = String(v ?? '').trim();
  if (!loc || !app.location(loc)) return null;
  return user.role === 'admin' || user.locations.includes(loc) ? loc : null;
}

const viewer = (ctx: Ctx) => ({ id: ctx.user!.id, role: ctx.user!.role });
const isAdmin = (ctx: Ctx) => ctx.user!.role === 'admin';

function unreadOf(app: App, userId: string, feedbackId: string) {
  return !!app.db.get('SELECT 1 FROM feedback_notifications WHERE user_id = ? AND feedback_id = ? AND read_at IS NULL', userId, feedbackId);
}

/** A report as its reporter sees it. */
export function reportOut(app: App, f: FeedbackRow, ctx: Ctx) {
  const t = ticketOf(app, f);
  const admin = isAdmin(ctx);
  const autoForMember = f.kind === 'auto' && !admin;
  const dup = f.duplicate_of ? getItem(app, f.duplicate_of) : undefined;
  const st = statusOf(app, f, t);
  return {
    id: f.id,
    kind: f.kind,
    number: t?.number ?? null,
    title: autoForMember ? 'Automatisch erfasster Fehler' : f.title,
    status: st,
    severity: f.severity,
    area: f.area,
    platform: f.platform,
    version: f.version,
    reason: st.key === 'abgelehnt' ? f.public_note : '',
    note: (st.key === 'behoben' || st.key === 'ausgeliefert') && f.version ? f.public_note : '',
    duplicate_of: dup ? { id: dup.id, number: numberOf(app, dup), title: dup.title, url: urlOf(dup) } : null,
    occurrences: f.kind === 'auto' ? f.occurrences : undefined,
    unread: unreadOf(app, ctx.user!.id, f.id),
    created_at: f.created_at,
    updated_at: t && t.updated_at > f.updated_at ? t.updated_at : f.updated_at,
    url: urlOf(f),
  };
}

/** A wish in the public list: names of authors and sub-accounts only for the agency. */
export function wishOut(app: App, r: any, ctx: Ctx) {
  const admin = isAdmin(ctx);
  const mine = r.user_id === ctx.user!.id;
  const st = publicStatus('wish', r.stage_id, r.status_kind);
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    body: r.body,
    area: r.area,
    status: st,
    votes: r.votes,
    my_vote: !!r.my_vote,
    comments: Number(r.comments ?? 0),
    mine,
    author: admin ? (r.author_name ?? '') : mine ? 'Du' : '',
    origin: admin ? (r.origin_name ?? '') : '',
    version: st.board === 'done' ? r.version : '',
    reason: st.board === 'declined' ? r.public_note : '',
    note: st.board === 'done' ? r.public_note : '',
    hidden: admin ? !!r.hidden : undefined,
    ticket: admin ? { id: r.ticket_id, location_id: r.support_location_id } : undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const WISH_SELECT = `SELECT f.*, t.number, t.stage_id, t.status_kind, t.pipeline_id,
    (SELECT COUNT(*) FROM ticket_events e WHERE e.ticket_id = f.ticket_id AND e.type IN ('reply', 'customer_reply')) AS comments,
    EXISTS (SELECT 1 FROM feedback_votes v WHERE v.feedback_id = f.id AND v.user_id = ?) AS my_vote,
    u.name AS author_name, l.name AS origin_name
  FROM feedback_items f JOIN tickets t ON t.id = f.ticket_id LEFT JOIN users u ON u.id = f.user_id LEFT JOIN locations l ON l.id = f.origin_location_id`;

const BOARD_ORDER = Object.fromEntries(WISH_BOARD.map(([k], i) => [k, i]));

export function listWishes(app: App, ctx: Ctx, q: URLSearchParams) {
  const admin = isAdmin(ctx);
  const where = [`f.kind = 'wish'`, 'f.duplicate_of IS NULL'];
  const params: any[] = [ctx.user!.id];
  if (!admin || q.get('hidden') !== '1') where.push('f.hidden = 0');
  const text = String(q.get('q') ?? '').trim().slice(0, 100);
  if (text) {
    where.push('(f.title LIKE ? OR f.body LIKE ?)');
    params.push(`%${text}%`, `%${text}%`);
  }
  const area = String(q.get('area') ?? '').trim();
  if (area) {
    where.push('f.area = ?');
    params.push(cleanArea(area));
  }
  if (q.get('mine') === '1') {
    where.push('(f.user_id = ? OR EXISTS (SELECT 1 FROM feedback_votes v WHERE v.feedback_id = f.id AND v.user_id = ?))');
    params.push(ctx.user!.id, ctx.user!.id);
  }
  const board = String(q.get('status') ?? '').trim();
  if (board && STAGES_OF_BOARD[board]) {
    where.push(`t.stage_id IN (${STAGES_OF_BOARD[board].map(() => '?').join(',')})`);
    params.push(...STAGES_OF_BOARD[board]);
  }
  const rows = app.db.all(`${WISH_SELECT} WHERE ${where.join(' AND ')} ORDER BY f.votes DESC, f.created_at DESC LIMIT 1000`, ...params).map((r) => wishOut(app, r, ctx));
  const sort = String(q.get('sort') ?? 'votes');
  // Declined wishes stay visible (with the reason) but go to the end.
  const declinedLast = (a: { status: { board: string } }, b: { status: { board: string } }) => Number(a.status.board === 'declined') - Number(b.status.board === 'declined');
  if (sort === 'votes') rows.sort((a, b) => declinedLast(a, b) || b.votes - a.votes || b.created_at.localeCompare(a.created_at));
  if (sort === 'new') rows.sort((a, b) => declinedLast(a, b) || b.created_at.localeCompare(a.created_at));
  else if (sort === 'status') rows.sort((a, b) => (BOARD_ORDER[a.status.board] ?? 9) - (BOARD_ORDER[b.status.board] ?? 9) || b.votes - a.votes);
  else if (sort === 'updated') rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return rows;
}

function mustWish(app: App, ctx: Ctx, ref: string): FeedbackRow {
  const f = getItem(app, ref);
  if (!f || f.kind !== 'wish' || (f.hidden && !isAdmin(ctx))) throw notFound('Wunsch nicht gefunden');
  return f;
}

/** Own report (or any for the agency). */
function mustReport(app: App, ctx: Ctx, ref: string): FeedbackRow {
  const f = getItem(app, ref);
  if (!f || (!isAdmin(ctx) && !isLinked(app, f.id, ctx.user!.id))) throw notFound('Meldung nicht gefunden');
  return f;
}

function markRead(app: App, userId: string, feedbackId: string) {
  app.db.run('UPDATE feedback_notifications SET read_at = ? WHERE user_id = ? AND feedback_id = ? AND read_at IS NULL', now(), userId, feedbackId);
}

/** Requests per user: 15 reports in 10 minutes, 50 a day. */
function limitReports(ctx: Ctx) {
  if (!reportLimit.take(ctx.user!.id) || !dailyLimit.take(ctx.user!.id)) throw new HttpError(429, 'Du hast gerade sehr viele Meldungen geschickt – bitte kurz warten');
}

/** New report or wish from the web app or the Android app. */
export function createReport(app: App, ctx: Ctx, kindIn?: FeedbackKind) {
  const b = ctx.body ?? {};
  const user = ctx.user!;
  const kind: FeedbackKind = kindIn ?? kindOfCategory(b.category);
  limitReports(ctx);
  const origin = originOf(app, user, b.location_id ?? ctx.req.headers['x-location-id']);
  const platform = ctx.via === 'app' || b.platform === 'android' ? 'android' : 'web';
  const diag = b.diagnostics === false || b.diagnostics === null ? {} : cleanDiagnostics(b.diagnostics ?? {});
  const v = serverVersion(app);
  const diagnostics = {
    ...diag,
    role: roleLabel(user),
    location_name: origin ? app.location(origin)?.name : undefined,
    location_id: origin ?? undefined,
    server_version: v.version,
    server_web_build: v.web_build || undefined,
    platform,
  };
  if (b.diagnostics === false || b.diagnostics === null) Object.assign(diagnostics, { removed: true });
  const f = createItem(app, {
    kind,
    user,
    originLocationId: origin,
    title: b.title,
    body: b.what ?? b.body ?? b.description,
    expected: kind === 'wish' ? '' : b.expected,
    steps: kind === 'wish' ? '' : b.steps,
    severity: kind === 'bug' ? cleanSeverity(b.severity) : '',
    area: kind === 'wish' ? cleanArea(b.area) : '',
    platform,
    diagnostics,
    screenshot: b.screenshot || undefined,
  });
  // The agency hears about new bug reports right away (wishes are collected in the list).
  if (kind !== 'wish') {
    const admins = app.db.all(`SELECT id FROM users WHERE role = 'admin'`).map((r) => r.id as string).filter((u) => u !== user.id);
    const t = ticketOf(app, f);
    if (admins.length && t)
      void Promise.resolve(app.services.pushNotify?.({ userIds: admins, kind: 'feedback', title: `${kind === 'question' ? 'Neue Frage' : 'Neue Fehlermeldung'} #${t.number} von ${user.name || user.email}`, body: f.title, url: `/app/tickets/${t.id}`, tag: `ticket-${t.id}` })).catch(() => {});
  }
  return f;
}

export const feedbackModule: Module = {
  name: 'feedback',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE feedback_items (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
        support_location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL, origin_location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', expected TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '',
        severity TEXT NOT NULL DEFAULT '', area TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'web',
        diagnostics TEXT NOT NULL DEFAULT '{}', fingerprint TEXT, occurrences INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT, last_seen_at TEXT, votes INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL DEFAULT '',
        public_note TEXT NOT NULL DEFAULT '', fixed_at TEXT, duplicate_of TEXT, hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX feedback_items_ticket ON feedback_items(ticket_id) WHERE ticket_id IS NOT NULL;
      CREATE UNIQUE INDEX feedback_items_fp ON feedback_items(fingerprint) WHERE fingerprint IS NOT NULL;
      CREATE INDEX feedback_items_kind ON feedback_items(kind, votes, created_at);
      CREATE INDEX feedback_items_fixed ON feedback_items(fixed_at) WHERE version != '';
      CREATE TABLE feedback_links (
        feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id TEXT, role TEXT NOT NULL DEFAULT 'reporter', created_at TEXT NOT NULL, PRIMARY KEY (feedback_id, user_id)
      );
      CREATE INDEX feedback_links_user ON feedback_links(user_id, created_at);
      CREATE TABLE feedback_votes (
        feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, PRIMARY KEY (feedback_id, user_id)
      );
      CREATE TABLE feedback_files (
        id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedback_items(id) ON DELETE CASCADE, user_id TEXT,
        mime TEXT NOT NULL, size INTEGER NOT NULL, file TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE feedback_notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        feedback_id TEXT REFERENCES feedback_items(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', read_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX feedback_notifications_user ON feedback_notifications(user_id, read_at, created_at);
      CREATE TABLE feedback_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, auto_capture INTEGER, email INTEGER NOT NULL DEFAULT 1,
        changelog_seen_at TEXT, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const ensurePrefs = (userId: string) => {
      if (!prefsOf(app, userId)) db.run('INSERT OR IGNORE INTO feedback_prefs (user_id, auto_capture, email, changelog_seen_at, updated_at) VALUES (?, NULL, 1, ?, ?)', userId, now(), now());
      return prefsOf(app, userId)!;
    };

    // --- changelog („Was ist neu“) -----------------------------------------------------------------
    const changelog = () =>
      db
        .all(
          `SELECT f.id, f.kind, f.title, f.version, f.public_note, f.fixed_at FROM feedback_items f JOIN tickets t ON t.id = f.ticket_id
           WHERE f.version != '' AND f.fixed_at IS NOT NULL AND f.duplicate_of IS NULL AND f.hidden = 0 AND t.stage_id IN ('behoben', 'ausgeliefert')
           ORDER BY f.fixed_at DESC LIMIT 300`,
        )
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          // Bug titles can be private: only wishes (public anyway) and the team's own changelog line are shown.
          title: r.kind === 'wish' ? r.title : r.public_note || null,
          note: r.kind === 'wish' ? r.public_note : '',
          version: r.version,
          at: r.fixed_at,
          url: r.kind === 'wish' ? `/app/wishes/${r.id}` : null,
        }));
    const newSince = (userId: string) => {
      const seen = ensurePrefs(userId).changelog_seen_at ?? now();
      return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM feedback_items f JOIN tickets t ON t.id = f.ticket_id WHERE f.version != '' AND f.fixed_at > ? AND f.duplicate_of IS NULL AND f.hidden = 0 AND t.stage_id IN ('behoben', 'ausgeliefert')`, seen)!.n;
    };

    // --- me, prefs, notifications ------------------------------------------------------------------
    const meOut = (ctx: Ctx) => {
      const u = ctx.user!;
      const p = ensurePrefs(u.id);
      const s = loadFeedbackSettings(app);
      return {
        prefs: { auto_capture: autoCaptureOn(app, u.id), email: p.email !== 0 },
        auto_capture_default: u.role === 'admin',
        capture_client: s.capture_client,
        unread: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback_notifications WHERE user_id = ? AND read_at IS NULL', u.id)!.n,
        changelog_new: newSince(u.id),
        reports_open: db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM feedback_links l JOIN feedback_items f ON f.id = l.feedback_id JOIN tickets t ON t.id = f.ticket_id WHERE l.user_id = ? AND l.role = 'reporter' AND f.kind != 'wish' AND t.status_kind IN ('new','open','waiting')`,
          u.id,
        )!.n,
        severities: SEVERITIES.map(([k, l]) => [k, l]),
        categories: [['bug', 'Fehler'], ['wish', 'Verbesserungswunsch'], ['question', 'Frage']],
        areas: AREAS,
        board: WISH_BOARD,
        screenshot_max: SCREENSHOT_MAX,
        server: serverVersion(app),
      };
    };
    router.get('/api/feedback/me', 'user', meOut);
    router.put('/api/feedback/prefs', 'user', (ctx) => {
      ensurePrefs(ctx.user!.id);
      const b = ctx.body ?? {};
      if (b.auto_capture !== undefined) db.run('UPDATE feedback_prefs SET auto_capture = ?, updated_at = ? WHERE user_id = ?', b.auto_capture === null ? null : b.auto_capture ? 1 : 0, now(), ctx.user!.id);
      if (b.email !== undefined) db.run('UPDATE feedback_prefs SET email = ?, updated_at = ? WHERE user_id = ?', b.email ? 1 : 0, now(), ctx.user!.id);
      return meOut(ctx);
    });
    router.get('/api/feedback/notifications', 'user', (ctx) => ({
      unread: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback_notifications WHERE user_id = ? AND read_at IS NULL', ctx.user!.id)!.n,
      notifications: db.all('SELECT id, feedback_id, kind, title, body, url, read_at, created_at FROM feedback_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', ctx.user!.id),
    }));
    router.post('/api/feedback/notifications/read', 'user', (ctx) => {
      const b = ctx.body ?? {};
      if (Array.isArray(b.ids) && b.ids.length) {
        for (const nid of b.ids.slice(0, 200)) db.run('UPDATE feedback_notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', now(), String(nid), ctx.user!.id);
      } else db.run('UPDATE feedback_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), ctx.user!.id);
      return { ok: true };
    });

    // --- reports („Fehler melden“, „Meine Meldungen“) --------------------------------------------------
    const myReports = (ctx: Ctx) =>
      db
        .all(`SELECT f.id FROM feedback_links l JOIN feedback_items f ON f.id = l.feedback_id WHERE l.user_id = ? ORDER BY f.updated_at DESC LIMIT 300`, ctx.user!.id)
        .map((r) => getItem(app, r.id)!)
        .filter((f) => f && (f.kind !== 'auto' || autoCaptureOn(app, ctx.user!.id)))
        .map((f) => reportOut(app, f, ctx))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const reportDetail = (ctx: Ctx, f: FeedbackRow) => {
      markRead(app, ctx.user!.id, f.id);
      const own = f.user_id === ctx.user!.id || isAdmin(ctx);
      return {
        report: reportOut(app, f, ctx),
        body: f.kind === 'auto' && !isAdmin(ctx) ? '' : f.body,
        expected: f.expected,
        steps: f.steps,
        // Only the reporter sees what was sent along (and the agency); automatic errors stay with the agency.
        diagnostics: own && f.kind !== 'auto' ? f.diagnostics : null,
        files: own || f.kind === 'wish' ? filesOf(app, f) : [],
        thread: publicThread(app, f, viewer(ctx)),
        can_reply: f.kind !== 'auto' && !f.duplicate_of,
        can_reopen: f.kind !== 'auto' && f.kind !== 'wish' && !f.duplicate_of && ['behoben', 'ausgeliefert', 'abgelehnt'].includes(statusOf(app, f).key) && isLinked(app, f.id, ctx.user!.id),
      };
    };
    router.get('/api/feedback/reports', 'user', myReports);
    router.post('/api/feedback/reports', 'user', (ctx) => {
      const f = createReport(app, ctx);
      return { ...reportOut(app, f, ctx), number: numberOf(app, f) };
    });
    router.get('/api/feedback/reports/:id', 'user', (ctx) => reportDetail(ctx, mustReport(app, ctx, ctx.params.id)));
    router.post('/api/feedback/reports/:id/messages', 'user', (ctx) => {
      const f = mustReport(app, ctx, ctx.params.id);
      if (f.kind === 'auto' || f.duplicate_of) throw bad('Hier kannst du nicht antworten');
      if (!commentLimit.take(ctx.user!.id)) throw new HttpError(429, 'Bitte kurz warten');
      addUserMessage(app, f, ctx.user!, ctx.body?.body, ctx.body?.screenshot || undefined);
      return reportDetail(ctx, f);
    });
    router.post('/api/feedback/reports/:id/reopen', 'user', (ctx) => {
      const f = mustReport(app, ctx, ctx.params.id);
      const d = reportDetail(ctx, f);
      if (!d.can_reopen) throw bad('Diese Meldung kann nicht wieder geöffnet werden');
      const reason = str(ctx.body?.reason, 'Grund', { max: 5000 });
      addUserMessage(app, f, ctx.user!, reason ? `Wieder geöffnet: ${reason}` : 'Wieder geöffnet – das Problem besteht noch.');
      excludeOnce(f.ticket_id, ctx.user!.id);
      setStatus(app, f, 'neu', { userId: ctx.user!.id, via: 'feedback' });
      return reportDetail(ctx, getItem(app, f.id)!);
    });

    // --- files (screenshots) -------------------------------------------------------------------------
    router.get('/api/feedback/files/:id', 'user', (ctx) => {
      const file = db.get('SELECT * FROM feedback_files WHERE id = ?', ctx.params.id);
      const f = file && getItem(app, file.feedback_id);
      const allowed = f && (isAdmin(ctx) || isLinked(app, f.id, ctx.user!.id) || (f.kind === 'wish' && !f.hidden));
      const buf = allowed ? readFile(app, file) : null;
      if (!buf || !file) throw notFound('Datei nicht gefunden');
      return { __raw: true, status: 200, headers: { 'content-type': file.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }, body: buf };
    });

    // --- wish list ---------------------------------------------------------------------------------------
    const wishDetail = (ctx: Ctx, f: FeedbackRow) => {
      markRead(app, ctx.user!.id, f.id);
      const row = db.get(`${WISH_SELECT} WHERE f.id = ?`, ctx.user!.id, f.id);
      const dup = f.duplicate_of ? getItem(app, f.duplicate_of) : undefined;
      return {
        wish: wishOut(app, row, ctx),
        duplicate_of: dup ? { id: dup.id, title: dup.title, url: urlOf(dup) } : null,
        files: filesOf(app, f).map(({ user_id: _u, ...x }) => x),
        thread: publicThread(app, f, viewer(ctx)),
      };
    };
    router.get('/api/feedback/wishes', 'user', (ctx) => listWishes(app, ctx, ctx.query));
    router.post('/api/feedback/wishes', 'user', (ctx) => {
      const f = createReport(app, ctx, 'wish');
      return wishDetail(ctx, f);
    });
    router.get('/api/feedback/wishes/:id', 'user', (ctx) => wishDetail(ctx, mustWish(app, ctx, ctx.params.id)));
    const setVote = (ctx: Ctx, on: boolean) => {
      const f = mustWish(app, ctx, ctx.params.id);
      if (f.duplicate_of) throw bad('Dieser Wunsch wurde zusammengeführt – bitte beim Ziel abstimmen');
      if (!voteLimit.take(ctx.user!.id)) throw new HttpError(429, 'Bitte kurz warten');
      vote(app, f.id, ctx.user!.id, on);
      const fresh = getItem(app, f.id)!;
      return { id: f.id, votes: fresh.votes, my_vote: on };
    };
    router.post('/api/feedback/wishes/:id/vote', 'user', (ctx) => setVote(ctx, true));
    router.delete('/api/feedback/wishes/:id/vote', 'user', (ctx) => setVote(ctx, false));
    router.post('/api/feedback/wishes/:id/comments', 'user', async (ctx) => {
      const f = mustWish(app, ctx, ctx.params.id);
      if (f.duplicate_of) throw bad('Dieser Wunsch wurde zusammengeführt');
      if (!commentLimit.take(ctx.user!.id)) throw new HttpError(429, 'Bitte kurz warten');
      addUserMessage(app, f, ctx.user!, ctx.body?.body);
      // The author hears about comments from others (in the app and by push, no email).
      if (f.user_id && f.user_id !== ctx.user!.id) await notifyUsers(app, f, [f.user_id], { kind: 'comment', title: `Neuer Kommentar zu deinem Wunsch „${f.title}“`, body: str(ctx.body?.body, 'Kommentar', { max: 300 }), url: urlOf(f) });
      return wishDetail(ctx, f);
    });
    router.get('/api/feedback/changelog', 'user', (ctx) => ({ entries: changelog(), new_count: newSince(ctx.user!.id) }));
    router.post('/api/feedback/changelog/seen', 'user', (ctx) => {
      ensurePrefs(ctx.user!.id);
      db.run('UPDATE feedback_prefs SET changelog_seen_at = ?, updated_at = ? WHERE user_id = ?', now(), now(), ctx.user!.id);
      return { ok: true };
    });

    // --- Android app (bearer device token; same data, flat shapes – docs/api.md → Mobile-App) -----------
    router.get('/api/mobile/bug-reports', 'user', (ctx) => myReports(ctx).filter((r) => r.kind !== 'wish'));
    router.post('/api/mobile/bug-reports', 'user', (ctx) => {
      const b = ctx.body ?? {};
      // The app sends device info and its last failed API calls separately; they become the diagnostics.
      ctx.body = { ...b, platform: 'android', diagnostics: b.diagnostics === false ? false : { ...(b.diagnostics ?? {}), device: b.device ?? b.diagnostics?.device, api_errors: b.api_errors ?? b.diagnostics?.api_errors, app_version: b.app_version ?? b.device?.app_version ?? b.diagnostics?.app_version, route: b.screen ?? b.diagnostics?.route } };
      const f = createReport(app, ctx);
      return { ...reportOut(app, f, ctx), number: numberOf(app, f) };
    });
    router.get('/api/mobile/bug-reports/:id', 'user', (ctx) => reportDetail(ctx, mustReport(app, ctx, ctx.params.id)));
    router.post('/api/mobile/bug-reports/:id/messages', 'user', (ctx) => {
      const f = mustReport(app, ctx, ctx.params.id);
      if (f.kind === 'auto' || f.duplicate_of) throw bad('Hier kannst du nicht antworten');
      if (!commentLimit.take(ctx.user!.id)) throw new HttpError(429, 'Bitte kurz warten');
      addUserMessage(app, f, ctx.user!, ctx.body?.body, ctx.body?.screenshot || undefined);
      return reportDetail(ctx, f);
    });
    router.get('/api/mobile/wishes', 'user', (ctx) => listWishes(app, ctx, ctx.query));
    router.post('/api/mobile/wishes', 'user', (ctx) => {
      ctx.body = { ...(ctx.body ?? {}), platform: 'android' };
      return wishDetail(ctx, createReport(app, ctx, 'wish'));
    });
    router.get('/api/mobile/wishes/:id', 'user', (ctx) => wishDetail(ctx, mustWish(app, ctx, ctx.params.id)));
    router.post('/api/mobile/wishes/:id/vote', 'user', (ctx) => setVote(ctx, true));
    router.delete('/api/mobile/wishes/:id/vote', 'user', (ctx) => setVote(ctx, false));

    // --- what tells people about changes --------------------------------------------------------------
    app.events.on('ticket.status_changed', (e) => {
      const skip = takeExcluded(e.data.ticketId);
      return onStatusChanged(app, e.data.ticketId, e.data.to, e.data.kind, skip);
    });
    // Replies written in the normal ticket view (or via ghl_reply_ticket): the reporter sees them under
    // „Meine Meldungen“. The ticket's contact already got the email, everyone else is mailed here.
    app.afterWrite.push((ctx, route, result: any) => {
      if (route.method !== 'POST' || route.pattern !== '/api/tickets/:id/reply' || !result?.ticket?.id) return;
      const f = itemByTicket(app, result.ticket.id);
      if (!f) return;
      app.events.emit(f.support_location_id, 'feedback.replied', { feedbackId: f.id, body: String(ctx.body?.body ?? ''), mailed: result.message?.status === 'failed' ? null : result.ticket.contact_id });
    });
    app.events.on('feedback.replied', async (e) => {
      const f = getItem(app, e.data.feedbackId);
      if (!f) return;
      const contactEmail = e.data.mailed ? db.get('SELECT email FROM contacts WHERE id = ?', e.data.mailed)?.email : null;
      const already = contactEmail ? db.all('SELECT id FROM users WHERE email = ?', String(contactEmail).toLowerCase()).map((r) => r.id as string) : [];
      await notifyReply(app, f, e.data.body, already);
    });
  },
};

// A user's own action (e.g. reopening) shouldn't notify that user.
const excluded = new Map<string, string>();
export function excludeOnce(ticketId: string, userId: string) {
  excluded.set(ticketId, userId);
  if (excluded.size > 1000) excluded.clear();
}
function takeExcluded(ticketId: string): string | undefined {
  const u = excluded.get(ticketId);
  excluded.delete(ticketId);
  return u;
}
