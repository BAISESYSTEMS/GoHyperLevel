import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Agentur-Ankündigungen – docs/saas.md#announcements. The agency writes a short notice (maintenance tonight, new feature, webinar
 * invitation) for all sub-accounts or chosen ones, optionally with a link, a period and a tone; it shows as a banner at the top of
 * the app for everyone working in those sub-accounts. A person can close a dismissible banner for themselves.
 */

const TONES = ['info', 'success', 'warning'] as const;
const safeLink = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^https:\/\/[^\s<>"]{3,500}$/i.test(s) || /^\/[^\s/][^\s<>"]{0,300}$/.test(s) ? s : '';
};
const isoOrNull = (v: unknown, field: string) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad(`${field} ungültig`);
  return d.toISOString();
};

export const agencyBannersModule: Module = {
  name: 'agency-banners',
  migrations: [
    [
      '001-init',
      `CREATE TABLE agency_banners (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', link_url TEXT NOT NULL DEFAULT '', link_label TEXT NOT NULL DEFAULT '',
        tone TEXT NOT NULL DEFAULT 'info', location_ids TEXT, starts_at TEXT, ends_at TEXT, dismissible INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE agency_banner_dismissals (
        banner_id TEXT NOT NULL REFERENCES agency_banners(id) ON DELETE CASCADE, user_id TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (banner_id, user_id)
      );`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const all = () => parseRows(db.all<any>('SELECT * FROM agency_banners ORDER BY created_at DESC'), ['location_ids']).map((b: any) => ({ ...b, active: !!b.active, dismissible: !!b.dismissible }) as Record<string, any>);
    const clean = (body: any, base: any = {}) => {
      const b: Record<string, any> = {};
      if (body.title !== undefined || !base.id) b.title = str(body.title, 'Titel', { required: true, max: 120 });
      if (body.message !== undefined) b.message = str(body.message, 'Text', { max: 600 });
      if (body.link_url !== undefined) {
        b.link_url = safeLink(body.link_url);
        if (body.link_url && !b.link_url) throw bad('Link muss mit https:// oder / beginnen');
      }
      if (body.link_label !== undefined) b.link_label = str(body.link_label, 'Link-Text', { max: 40 });
      if (body.tone !== undefined) b.tone = TONES.includes(body.tone) ? body.tone : 'info';
      // null = every sub-account, a list = only those.
      if (body.location_ids !== undefined) b.location_ids = Array.isArray(body.location_ids) && body.location_ids.length ? body.location_ids.map(String).slice(0, 500) : null;
      if (body.starts_at !== undefined) b.starts_at = isoOrNull(body.starts_at, 'Beginn');
      if (body.ends_at !== undefined) b.ends_at = isoOrNull(body.ends_at, 'Ende');
      if (body.dismissible !== undefined) b.dismissible = body.dismissible ? 1 : 0;
      if (body.active !== undefined) b.active = body.active ? 1 : 0;
      const s = b.starts_at ?? base.starts_at;
      const e = b.ends_at ?? base.ends_at;
      if (s && e && e <= s) throw bad('Das Ende liegt vor dem Beginn');
      return b;
    };

    router.get('/api/agency/banners', 'admin', () => all());
    router.post('/api/agency/banners', 'admin', (ctx) => {
      const row = { id: id(), tone: 'info', active: 1, dismissible: 1, ...clean(ctx.body ?? {}), created_by: ctx.user?.id ?? null, created_at: now(), updated_at: now() };
      db.insert('agency_banners', row);
      return all().find((b) => b.id === row.id);
    });
    router.patch('/api/agency/banners/:id', 'admin', (ctx) => {
      const cur = db.get<any>('SELECT * FROM agency_banners WHERE id = ?', ctx.params.id);
      if (!cur) throw notFound('Ankündigung nicht gefunden');
      db.update('agency_banners', cur.id, { ...clean(ctx.body ?? {}, cur), updated_at: now() });
      return all().find((b) => b.id === cur.id);
    });
    router.delete('/api/agency/banners/:id', 'admin', (ctx) => {
      if (!db.run('DELETE FROM agency_banners WHERE id = ?', ctx.params.id).changes) throw notFound('Ankündigung nicht gefunden');
      return { ok: true };
    });

    /** What the current person sees in the current sub-account. */
    const activeFor = (locationId: string, userId?: string) => {
      const t = now();
      return parseRows(
        db.all(
          `SELECT b.* FROM agency_banners b WHERE b.active = 1 AND (b.starts_at IS NULL OR b.starts_at <= ?) AND (b.ends_at IS NULL OR b.ends_at > ?)
           AND NOT EXISTS (SELECT 1 FROM agency_banner_dismissals d WHERE d.banner_id = b.id AND d.user_id = ? AND b.dismissible = 1)
           ORDER BY b.created_at DESC LIMIT 20`,
          t, t, userId ?? '',
        ),
        ['location_ids'],
      )
        .filter((b) => !b.location_ids || (b.location_ids as string[]).includes(locationId))
        .slice(0, 3)
        .map((b) => ({ id: b.id, title: b.title, message: b.message, link_url: b.link_url, link_label: b.link_label, tone: b.tone, dismissible: !!b.dismissible }));
    };
    router.get('/api/agency-banners/active', 'location', (ctx: Ctx) => activeFor(ctx.locationId, ctx.user?.id));
    router.post('/api/agency-banners/:id/dismiss', 'location', (ctx) => {
      if (!ctx.user) throw bad('Nur für angemeldete Personen');
      if (!db.get('SELECT id FROM agency_banners WHERE id = ? AND dismissible = 1', ctx.params.id)) throw notFound('Ankündigung nicht gefunden');
      db.run('INSERT OR IGNORE INTO agency_banner_dismissals (banner_id, user_id, at) VALUES (?, ?, ?)', ctx.params.id, ctx.user.id, now());
      return { ok: true };
    });

    // --- MCP (agency only) -----------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_agency_banners',
        title: 'Agentur-Ankündigungen anzeigen',
        description: 'Listet die Ankündigungs-Banner der Agentur für Sub-Accounts (Titel, Text, Zeitraum, Ziel-Sub-Accounts, aktiv).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        agencyOnly: true,
        run: (call) => call.api('GET', '/api/agency/banners'),
      },
      {
        name: 'ghl_agency_banner_create',
        title: 'Agentur-Ankündigung anlegen',
        description: 'Legt ein Ankündigungs-Banner an, das oben in der App der Sub-Accounts erscheint (alle oder location_ids). tone: info, success, warning. Optional Link (https://), Beginn/Ende (ISO).',
        inputSchema: {
          type: 'object',
          properties: { title: { type: 'string' }, message: { type: 'string' }, link_url: { type: 'string' }, link_label: { type: 'string' }, tone: { type: 'string', enum: [...TONES] }, location_ids: { type: 'array', items: { type: 'string' } }, starts_at: { type: 'string' }, ends_at: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        agencyOnly: true,
        run: (call, a) => call.api('POST', '/api/agency/banners', { body: a }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
