import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, redirect, str, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { relTime } from '../services/community.js';
import { setBan } from '../services/community-actions.js';
import { onlineIds } from '../services/community-ext.js';
import { TEAM, dmGroups, inbox, isBlocked, markRead, messagesOf, nameOf, reportMessage, sendDm, setBlocked, sharedGroups, threadOf, unreadCount, whyNot, type Message } from '../services/community-dm.js';
import { communityUi, kitOf, type PortalCtx, type PortalMember } from '../services/community-ui.js';

/**
 * Direct messages in the member area (/portal/<key>/community/messages): inbox, conversation with live updates, blocking and
 * reporting; the bell icon in the top bar shows unread messages. The team can write to members (and answer them) from the CRM;
 * reports of messages land in the same moderation place as reports of posts. Rules: services/community-dm.ts.
 */

const CSS = `<style>
.pn-msg{position:relative;color:var(--text);display:inline-grid;place-items:center;width:44px;height:44px;border-radius:10px;text-decoration:none}
.pn-msg:hover{background:var(--soft);color:var(--brand)}
.pn-msg b{position:absolute;top:4px;right:2px;background:#e11d48;color:#fff;border-radius:99px;font-size:10px;line-height:16px;min-width:16px;padding:0 4px;text-align:center}
.dm-list{list-style:none;margin:0;padding:0}.dm-list li a{display:flex;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--line);text-decoration:none;color:inherit;min-height:64px}
.dm-list li:first-child a{border-top:0}.dm-list li a:hover{background:var(--soft)}.dm-list .t{flex:1;min-width:0}.dm-list .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dm-list a.un strong{color:var(--text)}.dm-list a.un{background:var(--soft)}.dm-list .when{font-size:12px;color:var(--muted);white-space:nowrap}
.dm-head{display:flex;gap:12px;align-items:center;margin:0 0 14px;max-width:760px}.dm-head h1{margin:0;font-size:22px}
.dm-thread{display:flex;flex-direction:column;gap:6px;max-width:760px}
.dm-b{max-width:82%;padding:9px 14px;border-radius:16px;background:var(--panel);border:1px solid var(--line);align-self:flex-start;overflow-wrap:anywhere}
.dm-b.me{align-self:flex-end;background:var(--brand);border-color:var(--brand);color:#fff}.dm-b.me a{color:#fff;text-decoration:underline}
.dm-b .prose{font-size:15.5px}.dm-b .prose p{margin:2px 0}.dm-b time{display:block;font-size:11px;opacity:.7;margin-top:2px}
.dm-day{align-self:center;font-size:12px;color:var(--muted);margin:10px 0 4px}
.dm-compose{position:sticky;bottom:0;background:var(--bg);padding:12px 0 4px;max-width:760px;display:flex;gap:10px;align-items:flex-end}
.dm-compose textarea{flex:1;min-height:48px;max-height:180px;resize:vertical;padding:11px 14px;border:1px solid var(--line);border-radius:14px;font:inherit;font-size:16px;background:var(--panel);color:var(--text)}
.dm-menu summary{list-style:none;cursor:pointer;min-height:44px;min-width:44px;display:grid;place-items:center;border-radius:10px;font-size:20px}.dm-menu summary::-webkit-details-marker{display:none}
.dm-menu{position:relative;margin-left:auto}.dm-menu .pop{position:absolute;right:0;top:46px;z-index:5;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px;min-width:230px;box-shadow:0 10px 30px rgba(0,0,0,.15)}
.dm-menu .pop form{margin:0}.dm-menu .pop button{width:100%;text-align:left;background:none;border:0;padding:10px 12px;font:inherit;cursor:pointer;border-radius:8px;color:var(--text);min-height:44px}.dm-menu .pop button:hover{background:var(--soft)}
</style>`;

const ICON_CHAT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

export const communityDmModule: Module = {
  name: 'community-dm',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_dm_threads (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_a TEXT NOT NULL, contact_b TEXT NOT NULL, created_at TEXT NOT NULL, last_message_at TEXT NOT NULL, last_preview TEXT NOT NULL DEFAULT '',
        UNIQUE (location_id, contact_a, contact_b)
      );
      CREATE INDEX community_dm_threads_a ON community_dm_threads(location_id, contact_a, last_message_at);
      CREATE INDEX community_dm_threads_b ON community_dm_threads(location_id, contact_b, last_message_at);
      CREATE TABLE community_dm_messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES community_dm_threads(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible', created_at TEXT NOT NULL
      );
      CREATE INDEX community_dm_messages_thread ON community_dm_messages(thread_id, created_at);
      CREATE INDEX community_dm_messages_sender ON community_dm_messages(location_id, sender_id, created_at);
      CREATE TABLE community_dm_reads (
        thread_id TEXT NOT NULL REFERENCES community_dm_threads(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL, last_read_at TEXT NOT NULL, PRIMARY KEY (thread_id, contact_id)
      );
      CREATE TABLE community_blocks (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        blocker_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        blocked_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, PRIMARY KEY (location_id, blocker_id, blocked_id)
      );
      CREATE TABLE community_dm_reports (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES community_dm_threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES community_dm_messages(id) ON DELETE CASCADE,
        reporter_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', action TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT NOT NULL DEFAULT '',
        UNIQUE (message_id, reporter_id)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const ui = communityUi(app);
    ui.head.push(() => CSS);
    app.services.communityDm = {
      /** From a member or from the team (`from` = TEAM) to a member. */
      send: (locationId: string, from: string, to: string, body: string, opts?: { fromName?: string; skipLimits?: boolean }) => sendDm(app, locationId, from, to, body, opts),
      TEAM,
    };

    // GDPR. The threads point at members by id without a foreign key (one side may be the team), so the contact erase never
    // reached them. Access: the person's conversations (both sides – they are its correspondence), blocks and reports.
    // Erasure: every conversation the person took part in goes (messages, read marks and reports with it), and so do the
    // bell entries the other side got for it.
    const threadsOf = (loc: string, cid: string) => db.all<{ id: string; contact_a: string; contact_b: string; created_at: string; last_message_at: string }>('SELECT id, contact_a, contact_b, created_at, last_message_at FROM community_dm_threads WHERE location_id = ? AND (contact_a = ? OR contact_b = ?)', loc, cid, cid);
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: unknown, loc: string, c: { id: string }) => {
        const threads = threadsOf(loc, c.id).map((t) => {
          const other = t.contact_a === c.id ? t.contact_b : t.contact_a;
          const messages = db.all<Message>('SELECT * FROM community_dm_messages WHERE thread_id = ? ORDER BY created_at, rowid', t.id);
          return { mit: nameOf(app, loc, other), begonnen: t.created_at, letzte_nachricht: t.last_message_at, nachrichten: messages.map((m) => ({ von: m.sender_id === c.id ? 'ich' : m.sender_name, text: m.body, status: m.status, at: m.created_at })) };
        });
        const blocks = db.all<{ blocked_id: string; created_at: string }>('SELECT blocked_id, created_at FROM community_blocks WHERE location_id = ? AND blocker_id = ?', loc, c.id).map((b) => ({ blockiert: nameOf(app, loc, b.blocked_id), at: b.created_at }));
        const reports = db.all('SELECT reason, status, action, created_at, resolved_at FROM community_dm_reports WHERE location_id = ? AND reporter_id = ?', loc, c.id);
        return { ...(threads.length ? { 'Community-Direktnachrichten': threads } : {}), ...(blocks.length ? { 'Community-Blockierungen': blocks } : {}), ...(reports.length ? { 'Community-Meldungen (Nachrichten)': reports } : {}) };
      },
    ];
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: unknown, loc: string, c: { id: string }) => {
        for (const t of threadsOf(loc, c.id)) {
          db.run(`DELETE FROM community_notifications WHERE location_id = ? AND kind = 'dm' AND post_id = ?`, loc, t.id);
          db.run('DELETE FROM community_dm_threads WHERE id = ?', t.id);
        }
        db.run('DELETE FROM community_blocks WHERE location_id = ? AND (blocker_id = ? OR blocked_id = ?)', loc, c.id, c.id);
      },
    ];

    // The envelope in the top bar, next to the bell.
    const headerLinks = (app.services.portalHeader ??= []);
    headerLinks.push((p: PortalCtx, m: PortalMember) => {
      if (!dmGroups(app, p.locationId, m.contact.id).length && !inbox(app, p.locationId, m.contact.id).length) return '';
      const n = unreadCount(app, p.locationId, m.contact.id);
      return `<a class="pn-msg" href="${p.base}/community/messages" aria-label="Nachrichten${n ? ` (${n} ungelesen)` : ''}">${ICON_CHAT}${n ? `<b>${n > 99 ? '99+' : n}</b>` : ''}</a>`;
    });
    ui.notificationIcon.push((k) => (k === 'dm' ? ICON_CHAT : undefined));
    ui.notificationTarget.push((p, n) => {
      if (n.kind !== 'dm') return undefined;
      const t = db.get<any>('SELECT * FROM community_dm_threads WHERE id = ? AND location_id = ?', n.post_id, p.locationId);
      if (!t) return `${p.base}/community/messages`;
      const other = t.contact_a === n.contact_id ? t.contact_b : t.contact_a;
      return `${p.base}/community/messages/${other === TEAM ? TEAM : encodeURIComponent(handleOf(p.locationId, other))}`;
    });

    const handleOf = (loc: string, cid: string) => db.get<{ handle: string }>('SELECT handle FROM community_profiles WHERE location_id = ? AND contact_id = ?', loc, cid)?.handle ?? '';
    const byHandle = (loc: string, handle: string): string | undefined => {
      if (handle === TEAM) return TEAM;
      return db.get<{ contact_id: string }>('SELECT contact_id FROM community_profiles WHERE location_id = ? AND handle = ?', loc, handle.toLowerCase())?.contact_id;
    };

    const bubble = (p: PortalCtx, m: PortalMember, msg: Message) => {
      const kit = kitOf(app);
      const me = msg.sender_id === m.contact.id;
      const tz = kit.tz(p);
      return `<div class="dm-b${me ? ' me' : ''}" id="m-${escapeHtml(msg.id)}"><div class="prose">${kit.renderText(p, msg.body, true)}</div><time datetime="${escapeHtml(msg.created_at)}" title="${escapeHtml(formatInTz(msg.created_at, tz))}">${escapeHtml(formatInTz(msg.created_at, tz, { weekday: undefined, day: undefined, month: undefined, year: undefined }))}</time></div>`;
    };
    const dayLabel = (p: PortalCtx, iso: string) => formatInTz(iso, kitOf(app).tz(p), { weekday: 'long', year: undefined, hour: undefined, minute: undefined });

    // --- inbox ---------------------------------------------------------------------------------------------------------------------
    router.get('/portal/:p/community/messages', 'public', (ctx) =>
      kitOf(app).withMember(ctx, (p, m) => {
        const kit = kitOf(app);
        const threads = inbox(app, p.locationId, m.contact.id);
        const allowed = dmGroups(app, p.locationId, m.contact.id).length > 0;
        const rows = threads
          .map((t) => {
            const team = t.other === TEAM;
            const pr = team ? undefined : kit.profile(p, t.other);
            const name = team ? 'Team' : (pr?.display_name ?? nameOf(app, p.locationId, t.other));
            const href = `${kit.cbase(p)}/messages/${team ? TEAM : encodeURIComponent(pr?.handle ?? '')}`;
            if (!team && !pr) return '';
            return `<li><a class="${t.unread ? 'un' : ''}" href="${href}">${team ? `<span class="av" style="background:var(--brand)" aria-hidden="true">★</span>` : kit.avatar(p, name, pr)}<span class="t"><div><strong>${escapeHtml(name)}</strong></div><div class="muted small">${escapeHtml(t.last_preview)}</div></span><span class="when">${t.unread ? `<span class="cm-n">${t.unread}</span><br>` : ''}${relTime(t.last_message_at)}</span></a></li>`;
          })
          .join('');
        return kit.frame(
          p,
          m,
          'Nachrichten',
          `<div class="crumb"><a href="${kit.cbase(p)}">Community</a></div><div class="cm-row" style="margin-bottom:14px"><h1 class="grow" style="margin:0">Nachrichten</h1>${allowed ? `<a class="btn ghost" href="${kit.cbase(p)}/messages/${TEAM}">Team schreiben</a>` : ''}</div>
<div class="cm-box" style="padding:0;max-width:760px;overflow:hidden">${rows ? `<ul class="dm-list">${rows}</ul>` : `<p class="cm-empty">${allowed ? 'Noch keine Nachrichten. Öffne ein Profil oder das Mitgliederverzeichnis und schreib jemandem.' : 'Nachrichten sind in deinen Gruppen ausgeschaltet.'}</p>`}</div>`,
        );
      }),
    );

    // --- a conversation ------------------------------------------------------------------------------------------------------------------
    const thread = (p: PortalCtx, m: PortalMember, other: string, opts: { error?: string; draft?: string; status?: number } = {}): RawResult => {
      const kit = kitOf(app);
      const team = other === TEAM;
      const pr = team ? undefined : kit.profile(p, other);
      if (!team && !pr) return kit.errorPage(p, m, 'Dieses Mitglied gibt es nicht.', 404);
      const name = team ? 'Team' : pr!.display_name;
      const handle = team ? TEAM : pr!.handle;
      const th = threadOf(app, p.locationId, m.contact.id, other);
      const msgs = th ? messagesOf(app, th.id) : [];
      if (th) markRead(app, th.id, m.contact.id);
      const why = whyNot(app, p.locationId, m.contact.id, other);
      const blocked = !team && isBlocked(app, p.locationId, m.contact.id, other);
      const online = !team && onlineIds(app, p.locationId, [other]).has(other);
      let day = '';
      const list = msgs
        .map((x) => {
          const d = dayLabel(p, x.created_at);
          const sep = d !== day ? `<div class="dm-day">${escapeHtml(d)}</div>` : '';
          day = d;
          return sep + bubble(p, m, x);
        })
        .join('');
      const last = msgs[msgs.length - 1]?.created_at ?? '';
      const base = `${kit.cbase(p)}/messages/${encodeURIComponent(handle)}`;
      const menu = team
        ? ''
        : `<details class="dm-menu"><summary aria-label="Mehr">⋯</summary><div class="pop">
<form method="post" action="${base}/${blocked ? 'unblock' : 'block'}">${kit.tokenInput(m)}<button>${blocked ? 'Blockierung aufheben' : 'Blockieren'}</button></form>
${msgs.filter((x) => x.sender_id === other).slice(-1).map((x) => `<form method="post" action="${base}/report" data-confirm="Die letzte Nachricht von ${escapeHtml(name)} ans Team melden?">${kit.tokenInput(m)}<input type="hidden" name="message_id" value="${escapeHtml(x.id)}"><button>Letzte Nachricht melden</button></form>`).join('')}
<a class="cm-link" style="display:block;padding:10px 12px" href="${kit.cbase(p)}/u/${encodeURIComponent(handle)}">Profil ansehen</a></div></details>`;
      return kit.frame(
        p,
        m,
        `Nachricht an ${name}`,
        `<div class="crumb"><a href="${kit.cbase(p)}/messages">Nachrichten</a></div>
<div class="dm-head">${team ? `<span class="av" style="background:var(--brand)" aria-hidden="true">★</span>` : kit.avatar(p, name, pr)}<div><h1>${escapeHtml(name)}</h1>${online ? '<div class="muted small"><span class="dot on"></span> online</div>' : ''}</div>${menu}</div>
${opts.error ? `<div class="cm-err" role="alert">${escapeHtml(opts.error)}</div>` : ''}
<div data-dm-thread data-poll="${base}/poll" data-last="${escapeHtml(last)}" data-scroll><div class="dm-thread" data-dm-list>${list || '<p class="muted">Noch keine Nachrichten – schreib die erste.</p>'}</div>
${why ? `<p class="cm-hint" style="margin-top:14px">${escapeHtml(why)}</p>` : `<form class="dm-compose" method="post" action="${base}">${kit.tokenInput(m)}<textarea name="body" required maxlength="4000" rows="2" placeholder="Nachricht schreiben … (Enter sendet, Umschalt+Enter für eine neue Zeile)" aria-label="Nachricht">${escapeHtml(opts.draft ?? '')}</textarea><button class="btn">Senden</button></form>`}</div>`,
        opts.status,
      );
    };
    router.get('/portal/:p/community/messages/:handle', 'public', (ctx) =>
      kitOf(app).withMember(ctx, (p, m) => {
        const other = byHandle(p.locationId, ctx.params.handle);
        if (!other) return kitOf(app).errorPage(p, m, 'Dieses Mitglied gibt es nicht.', 404);
        // Somebody I can't see (no shared group) is not a conversation either – except an old one.
        if (other !== TEAM && !threadOf(app, p.locationId, m.contact.id, other) && !sharedGroups(app, p.locationId, m.contact.id, other).length) return kitOf(app).errorPage(p, m, 'Dieses Mitglied gibt es nicht.', 404);
        return thread(p, m, other);
      }),
    );
    router.get('/portal/:p/community/messages/:handle/poll', 'public', (ctx) => {
      const kit = kitOf(app);
      const p = kit.portal.resolve(ctx.params.p);
      const m = p && kit.portal.memberOf(ctx, p);
      const empty = (status: number): RawResult => ({ __raw: true, status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{}' });
      if (!p || !m) return empty(401);
      const other = byHandle(p.locationId, ctx.params.handle);
      const th = other && threadOf(app, p.locationId, m.contact.id, other);
      if (!th) return empty(404);
      const since = String(ctx.query.get('since') ?? '');
      const fresh = messagesOf(app, th.id, since);
      if (fresh.length) markRead(app, th.id, m.contact.id);
      return { __raw: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify({ html: fresh.map((x) => bubble(p, m, x)).join(''), last: fresh[fresh.length - 1]?.created_at ?? since }) };
    });
    router.post('/portal/:p/community/messages/:handle', 'public', (ctx) =>
      kitOf(app).withMember(ctx, (p, m) => {
        const kit = kitOf(app);
        const other = byHandle(p.locationId, ctx.params.handle);
        if (!other) return kit.errorPage(p, m, 'Dieses Mitglied gibt es nicht.', 404);
        try {
          sendDm(app, p.locationId, m.contact.id, other, ctx.body?.body);
        } catch (e) {
          if (e instanceof HttpError) return thread(p, m, other, { error: e.message, draft: String(ctx.body?.body ?? '').slice(0, 4000), status: e.status });
          throw e;
        }
        return redirect(`${kit.cbase(p)}/messages/${encodeURIComponent(other === TEAM ? TEAM : handleOf(p.locationId, other))}#unten`, 303);
      }),
    );
    for (const action of ['block', 'unblock'] as const) {
      router.post(`/portal/:p/community/messages/:handle/${action}`, 'public', (ctx) =>
        kitOf(app).withMember(ctx, (p, m) => {
          const other = byHandle(p.locationId, ctx.params.handle);
          if (!other || other === TEAM || other === m.contact.id) return kitOf(app).errorPage(p, m, 'Das geht hier nicht.', 400);
          setBlocked(app, p.locationId, m.contact.id, other, action === 'block');
          return redirect(`${kitOf(app).cbase(p)}/messages/${encodeURIComponent(ctx.params.handle)}`, 303);
        }),
      );
    }
    router.post('/portal/:p/community/messages/:handle/report', 'public', (ctx) =>
      kitOf(app).withMember(ctx, (p, m) => {
        const kit = kitOf(app);
        try {
          reportMessage(app, p.locationId, m.contact.id, String(ctx.body?.message_id ?? ''), ctx.body?.reason);
        } catch (e) {
          if (e instanceof HttpError) return kit.errorPage(p, m, e.message, e.status);
          throw e;
        }
        return kit.frame(p, m, 'Danke', `<div class="cm-box cm-empty" style="max-width:560px"><p><strong>Danke – das Team schaut sich die Nachricht an.</strong></p><p class="small">Du kannst die Person zusätzlich blockieren.</p><p><a class="btn" href="${kit.cbase(p)}/messages/${encodeURIComponent(ctx.params.handle)}">Zurück</a></p></div>`);
      }),
    );

    // --- the team's side -------------------------------------------------------------------------------------------------------------------
    const nameFor = (loc: string, cid: string) => {
      const c = getContact(app, loc, cid);
      return { name: nameOf(app, loc, cid), email: c?.email ?? '' };
    };
    /** Conversations between the team and members (members who wrote to the team, and team messages). */
    router.get('/api/community/messages', 'location', (ctx) => {
      const rows = db.all<any>(
        `SELECT t.*, (SELECT COUNT(*) FROM community_dm_messages m WHERE m.thread_id = t.id AND m.sender_id != ? AND m.created_at > COALESCE((SELECT last_read_at FROM community_dm_reads r WHERE r.thread_id = t.id AND r.contact_id = ?), '')) AS unread
         FROM community_dm_threads t WHERE t.location_id = ? AND (t.contact_a = ? OR t.contact_b = ?) ORDER BY t.last_message_at DESC LIMIT 200`,
        TEAM,
        TEAM,
        ctx.locationId,
        TEAM,
        TEAM,
      );
      return rows.map((t) => {
        const cid = t.contact_a === TEAM ? t.contact_b : t.contact_a;
        return { thread_id: t.id, contact_id: cid, ...nameFor(ctx.locationId, cid), last_message_at: t.last_message_at, last_preview: t.last_preview, unread: t.unread };
      });
    });
    router.get('/api/community/messages/:contactId', 'location', (ctx) => {
      const th = threadOf(app, ctx.locationId, TEAM, ctx.params.contactId);
      if (!th) return { contact_id: ctx.params.contactId, ...nameFor(ctx.locationId, ctx.params.contactId), messages: [] };
      markRead(app, th.id, TEAM);
      return { contact_id: ctx.params.contactId, ...nameFor(ctx.locationId, ctx.params.contactId), messages: messagesOf(app, th.id).map((x) => ({ id: x.id, from_team: x.sender_id === TEAM, sender_name: x.sender_name, body: x.body, created_at: x.created_at })) };
    });
    /** The team writes to one member (shown as the sender "Team" or the name given). */
    router.post('/api/community/messages/:contactId', 'location', (ctx) => {
      if (!getContact(app, ctx.locationId, ctx.params.contactId)) throw notFound('Kontakt nicht gefunden');
      const name = str(ctx.body?.from_name, 'Absender', { max: 60 }) || 'Team';
      const sent = sendDm(app, ctx.locationId, TEAM, ctx.params.contactId, ctx.body?.body, { fromName: name, skipLimits: true });
      return { id: sent.message.id, thread_id: sent.thread.id };
    });

    // Messages reported by members: the team looks at them next to the reported posts.
    router.get('/api/community/dm-reports', 'location', (ctx) => {
      const status = ctx.query.get('status') ?? 'open';
      return db
        .all<any>(
          `SELECT r.*, m.body, m.sender_id, m.sender_name, m.status AS message_status FROM community_dm_reports r JOIN community_dm_messages m ON m.id = r.message_id
           WHERE r.location_id = ?${status === 'all' ? '' : ' AND r.status = ?'} ORDER BY r.created_at DESC LIMIT 200`,
          ctx.locationId,
          ...(status === 'all' ? [] : [status]),
        )
        .map((r) => ({
          id: r.id,
          status: r.status,
          reason: r.reason,
          created_at: r.created_at,
          reporter: nameFor(ctx.locationId, r.reporter_id),
          sender: { id: r.sender_id, ...nameFor(ctx.locationId, r.sender_id) },
          message: { id: r.message_id, text: r.body, status: r.message_status },
          context: db.all<any>(`SELECT sender_name, body, created_at FROM community_dm_messages WHERE thread_id = ? AND created_at <= (SELECT created_at FROM community_dm_messages WHERE id = ?) ORDER BY created_at DESC LIMIT 4`, r.thread_id, r.message_id).reverse(),
        }));
    });
    router.patch('/api/community/dm-reports/:id', 'location', (ctx) => {
      const r = db.get<any>('SELECT * FROM community_dm_reports WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Meldung nicht gefunden');
      const action = String(ctx.body?.action ?? '');
      if (!['dismiss', 'remove', 'ban'].includes(action)) throw bad('Aktion: dismiss, remove oder ban');
      const msg = db.get<Message>('SELECT * FROM community_dm_messages WHERE id = ?', r.message_id);
      if (action !== 'dismiss' && msg) db.run(`UPDATE community_dm_messages SET status = 'removed' WHERE id = ?`, msg.id);
      if (action === 'ban' && msg && msg.sender_id !== TEAM) {
        const g = sharedGroups(app, ctx.locationId, msg.sender_id, r.reporter_id)[0];
        if (g) setBan(app, g, msg.sender_id, true, { reason: 'Nachricht gemeldet', by: ctx.user?.name ?? '' });
        logActivity(app, ctx.locationId, msg.sender_id, 'community.dm_banned', 'Wegen einer gemeldeten Nachricht gesperrt');
      }
      db.run(`UPDATE community_dm_reports SET status = ?, action = ?, resolved_at = ?, resolved_by = ? WHERE message_id = ? AND status = 'open'`, action === 'dismiss' ? 'dismissed' : 'resolved', action, now(), ctx.user?.name ?? '', r.message_id);
      return { ok: true };
    });
  },
};

