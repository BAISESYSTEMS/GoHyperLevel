import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { HttpError, bad, html, notFound, str, type Ctx } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { id, now, sha256, token } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Kunden-Freigabe von Social-Posts per Magic-Link – docs/social-planner.md#client-approval. The team prepares one or more posts and
 * sends the client one link (no login): the client sees each post with its channels and date and approves it, asks for changes
 * with a note, or rejects it. An approved post is scheduled through the social planner right away (Postiz); if that is not
 * possible (planner not connected, date passed) it stays "freigegeben" and the team schedules it with one click.
 * Links last 30 days; only the hash of the link's token is stored.
 */

const DAYS = 30;
type Status = 'pending' | 'approved' | 'changes' | 'rejected' | 'scheduled';
const LABEL: Record<Status, string> = { pending: 'Wartet auf Freigabe', approved: 'Freigegeben', changes: 'Änderung gewünscht', rejected: 'Abgelehnt', scheduled: 'Freigegeben & eingeplant' };

export const socialApprovalModule: Module = {
  name: 'social-approval',
  migrations: [
    [
      '001-init',
      `CREATE TABLE social_approval_links (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE social_approvals (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        link_id TEXT NOT NULL REFERENCES social_approval_links(id) ON DELETE CASCADE,
        content TEXT NOT NULL, integration_ids TEXT NOT NULL DEFAULT '[]', upload_ids TEXT NOT NULL DEFAULT '[]', publish_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending', reviewer TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        post_id TEXT, decided_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX social_approvals_loc ON social_approvals(location_id, created_at);
      CREATE INDEX social_approvals_link ON social_approvals(link_id);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const rows = (where: string, ...args: any[]): any[] => parseRows(db.all(`SELECT a.*, l.title AS link_title, l.expires_at FROM social_approvals a JOIN social_approval_links l ON l.id = a.link_id WHERE ${where} ORDER BY a.created_at`, ...args), ['integration_ids', 'upload_ids']);
    const out = (a: any) => ({ ...a, status_label: LABEL[a.status as Status] ?? a.status });

    /** Hands an approved post to the social planner; on failure the reason is kept and the post stays approved. */
    const schedule = async (a: any): Promise<void> => {
      if (!app.services.socialPost) {
        db.run("UPDATE social_approvals SET error = ?, updated_at = ? WHERE id = ?", 'Social Planner nicht verfügbar', now(), a.id);
        return;
      }
      try {
        const future = a.publish_at && new Date(a.publish_at).getTime() > Date.now() + 120_000;
        const post = await app.services.socialPost(a.location_id, { integrationIds: a.integration_ids, content: a.content, type: future ? 'schedule' : 'draft', date: a.publish_at ?? undefined, uploadIds: a.upload_ids, source: 'Kunden-Freigabe' });
        db.run("UPDATE social_approvals SET status = 'scheduled', post_id = ?, error = '', updated_at = ? WHERE id = ?", post?.id ?? null, now(), a.id);
      } catch (e) {
        db.run('UPDATE social_approvals SET error = ?, updated_at = ? WHERE id = ?', String((e as Error).message).slice(0, 300), now(), a.id);
      }
    };

    // --- team side -----------------------------------------------------------------------------------------------------------
    router.get('/api/social-approvals', 'location', (ctx) => rows('a.location_id = ?', ctx.locationId).reverse().slice(0, 200).map(out));
    /** `{ title?, posts: [{ content, integration_ids, date?, upload_ids? }] }` (or one post's fields directly) → one link for all. */
    router.post('/api/social-approvals', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const list: any[] = Array.isArray(ctx.body?.posts) ? ctx.body.posts : [ctx.body ?? {}];
      if (!list.length || list.length > 30) throw bad('1 bis 30 Posts je Freigabe-Link');
      const posts = list.map((p, i) => {
        const content = str(p?.content, `Text (Post ${i + 1})`, { required: true, max: 63_000 });
        const integration_ids = Array.isArray(p?.integration_ids) ? p.integration_ids.map(String).slice(0, 20) : [];
        const date = p?.date ? new Date(String(p.date)) : null;
        if (date && Number.isNaN(date.getTime())) throw bad(`Zeitpunkt ungültig (Post ${i + 1})`);
        return { content, integration_ids, upload_ids: Array.isArray(p?.upload_ids) ? p.upload_ids.map(String).slice(0, 4) : [], publish_at: date ? date.toISOString() : null };
      });
      const raw = token(24);
      const link = { id: id(), location_id: ctx.locationId, token_hash: sha256(raw), title: String(ctx.body?.title ?? '').trim().slice(0, 120), created_by: ctx.user?.id ?? null, created_at: now(), expires_at: new Date(Date.now() + DAYS * 864e5).toISOString() };
      db.tx(() => {
        db.insert('social_approval_links', link);
        for (const p of posts) db.insert('social_approvals', { id: id(), location_id: ctx.locationId, link_id: link.id, ...p, status: 'pending', created_at: now(), updated_at: now() });
      });
      return { url: `${app.baseUrl()}/social-review/${raw}`, expires_at: link.expires_at, approvals: rows('a.link_id = ?', link.id).map(out) };
    });
    router.post('/api/social-approvals/:id/schedule', 'location', async (ctx) => {
      const a = rows('a.id = ? AND a.location_id = ?', ctx.params.id, ctx.locationId)[0];
      if (!a) throw notFound('Freigabe nicht gefunden');
      if (a.status !== 'approved') throw bad('Nur freigegebene Posts lassen sich einplanen');
      await schedule(a);
      return out(rows('a.id = ?', a.id)[0]);
    });
    router.delete('/api/social-approvals/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM social_approvals WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Freigabe nicht gefunden');
      db.run('DELETE FROM social_approval_links WHERE location_id = ? AND id NOT IN (SELECT link_id FROM social_approvals)', ctx.locationId);
      return { ok: true };
    });

    // --- client side (no login) -------------------------------------------------------------------------------------------------
    const linkOf = (raw: string) => {
      const l = db.get<any>('SELECT * FROM social_approval_links WHERE token_hash = ?', sha256(String(raw ?? '')));
      return l && l.expires_at > now() ? l : undefined;
    };
    const fmt = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso)) : 'Zeitpunkt offen');
    const reviewPage = (raw: string, l: any, notice = '') => {
      const loc = app.location(l.location_id);
      const tz = loc?.timezone || 'Europe/Berlin';
      const items = rows('a.link_id = ?', l.id);
      const cards = items
        .map((a, i) => {
          const done = a.status !== 'pending' && a.status !== 'changes';
          const imgs = (a.upload_ids as string[])
            .map((u) => db.get<any>("SELECT file FROM uploads WHERE id = ? AND location_id = ? AND mime LIKE 'image/%'", u, l.location_id))
            .filter(Boolean)
            .map((u: any) => `<img src="/uploads/${escapeHtml(u.file)}" alt="Bild zu Post ${i + 1}" style="max-width:100%;border-radius:8px;margin-top:8px">`)
            .join('');
          return `<div class="card" style="margin-bottom:16px"><p class="muted" style="margin:0 0 6px">Post ${i + 1} · ${escapeHtml(fmt(a.publish_at, tz))} · <strong>${escapeHtml(LABEL[a.status as Status])}</strong></p>
<div style="white-space:pre-wrap">${escapeHtml(a.content)}</div>${imgs}
${a.note ? `<p class="muted">Anmerkung: ${escapeHtml(a.note)}</p>` : ''}
${done ? '' : `<form method="post" action="/social-review/${escapeHtml(raw)}/${escapeHtml(a.id)}">
<label for="n-${escapeHtml(a.id)}">Anmerkung (optional)</label><textarea id="n-${escapeHtml(a.id)}" name="note" rows="2"></textarea>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button name="decision" value="approved">✓ Freigeben</button><button name="decision" value="changes" class="secondary">Änderung wünschen</button><button name="decision" value="rejected" class="secondary">Ablehnen</button></div></form>`}</div>`;
        })
        .join('');
      const body = `<div class="wrap" style="max-width:640px"><h1>${escapeHtml(l.title || 'Social-Posts zur Freigabe')}</h1><p class="muted">${escapeHtml(loc?.name ?? '')} bittet dich, diese Posts zu prüfen.</p>${notice ? `<p role="status"><strong>${escapeHtml(notice)}</strong></p>` : ''}${cards || '<p>Keine Posts mehr offen.</p>'}</div>`;
      const r = html(publicPage({ title: 'Freigabe', body, head: '<meta name="robots" content="noindex, nofollow">' }));
      r.headers['cache-control'] = 'no-store';
      r.headers['referrer-policy'] = 'no-referrer';
      return r;
    };
    const gone = () => html(publicPage({ title: 'Link abgelaufen', body: '<div class="wrap"><div class="card"><h1>Link abgelaufen</h1><p class="muted">Bitte frag nach einem neuen Freigabe-Link.</p></div></div>' }), 404);
    router.get('/social-review/:token', 'public', (ctx) => {
      const l = linkOf(ctx.params.token);
      return l ? reviewPage(ctx.params.token, l) : gone();
    });
    router.post('/social-review/:token/:id', 'public', async (ctx: Ctx) => {
      const l = linkOf(ctx.params.token);
      if (!l) return gone();
      const a = rows('a.id = ? AND a.link_id = ?', ctx.params.id, l.id)[0];
      if (!a) return reviewPage(ctx.params.token, l, 'Post nicht gefunden.');
      const decision = String(ctx.body?.decision ?? '') as Status;
      if (!['approved', 'changes', 'rejected'].includes(decision)) return reviewPage(ctx.params.token, l, 'Bitte eine Entscheidung wählen.');
      if (a.status !== 'pending' && a.status !== 'changes') return reviewPage(ctx.params.token, l, 'Dieser Post ist schon entschieden.');
      const note = String(ctx.body?.note ?? '').trim().slice(0, 1000);
      db.run('UPDATE social_approvals SET status = ?, note = ?, decided_at = ?, updated_at = ? WHERE id = ?', decision, note, now(), now(), a.id);
      app.events.emit(l.location_id, 'social.approval', { approvalId: a.id, decision, note });
      if (decision === 'approved') await schedule({ ...a, status: 'approved' });
      return reviewPage(ctx.params.token, l, decision === 'approved' ? 'Danke – freigegeben.' : decision === 'changes' ? 'Danke – wir passen den Post an.' : 'Danke – der Post wird nicht veröffentlicht.');
    });

    // --- MCP ---------------------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_social_approval_list',
        title: 'Social-Freigaben anzeigen',
        description: 'Listet Social-Posts, die per Magic-Link beim Kunden zur Freigabe liegen, mit Status (pending, approved, changes, rejected, scheduled) und Anmerkung des Kunden.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        untrusted: true,
        run: (call, a) => call.api('GET', '/api/social-approvals', { location: a.location_id }),
      },
      {
        name: 'ghl_social_approval_create',
        title: 'Social-Posts zur Freigabe schicken',
        description: 'Legt einen Freigabe-Link für einen oder mehrere Social-Posts an (ohne Login für den Kunden). Gibt die URL zurück – sie wird nicht automatisch verschickt. Freigegebene Posts werden über den Social Planner eingeplant.',
        inputSchema: {
          type: 'object',
          properties: {
            location_id: { type: 'string' },
            title: { type: 'string' },
            posts: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, integration_ids: { type: 'array', items: { type: 'string' } }, date: { type: 'string', description: 'ISO-Zeitpunkt' } }, required: ['content'] } },
          },
          required: ['location_id', 'posts'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: (call, a) => call.api('POST', '/api/social-approvals', { location: a.location_id, body: { title: a.title, posts: a.posts } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
