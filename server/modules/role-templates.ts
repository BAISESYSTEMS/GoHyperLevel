import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { PERMISSIONS, cleanPermissions, requiredPermission, type Permission } from '../core/permissions.js';
import { id, now } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Eigene Rollen (Rollen-Vorlagen) – docs/security.md#roles. A role is a named set of areas a member may open, plus the areas they
 * may only read (no creating, changing or deleting there). Assigning a role sets the member's areas; changing the role later
 * updates everyone who has it. Changing a member's areas by hand takes them out of the role. Admins are never restricted.
 * Ready-made starting points (Vertrieb, Marketing, Kundenservice, Buchhaltung, Assistenz) come as presets to copy.
 */

export const ROLE_PRESETS: { key: string; name: string; description: string; permissions: Permission[]; readonly: Permission[] }[] = [
  { key: 'sales', name: 'Vertrieb', description: 'Kontakte, Deals, Kalender und Gespräche – ohne Einstellungen.', permissions: ['dashboard', 'contacts', 'opportunities', 'calendars', 'conversations', 'payments'], readonly: ['payments'] },
  { key: 'marketing', name: 'Marketing', description: 'Kampagnen, Websites, Formulare, Social Media, Bewertungen.', permissions: ['dashboard', 'campaigns', 'funnels', 'forms', 'social', 'reviews', 'contacts'], readonly: ['contacts'] },
  { key: 'support', name: 'Kundenservice', description: 'Posteingang, Tickets und Kontakte.', permissions: ['dashboard', 'conversations', 'helpdesk', 'contacts', 'calendars'], readonly: [] },
  { key: 'accounting', name: 'Buchhaltung', description: 'Rechnungen und Buchhaltung, Kontakte nur lesen.', permissions: ['dashboard', 'payments', 'accounting', 'contacts'], readonly: ['contacts'] },
  { key: 'assistant', name: 'Assistenz (nur lesen)', description: 'Sieht Kontakte, Kalender und Deals, ändert nichts.', permissions: ['dashboard', 'contacts', 'calendars', 'opportunities'], readonly: ['contacts', 'calendars', 'opportunities'] },
];

const sameSet = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x) => b.includes(x));

export const roleTemplatesModule: Module = {
  name: 'role-templates',
  migrations: [
    [
      '001-init',
      `CREATE TABLE role_templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        permissions TEXT NOT NULL DEFAULT '[]', readonly TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE user_role_templates (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL REFERENCES role_templates(id) ON DELETE CASCADE, assigned_at TEXT NOT NULL
      );
      CREATE INDEX user_role_templates_tpl ON user_role_templates(template_id);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const list = (): any[] =>
      parseRows(db.all<any>('SELECT t.*, (SELECT COUNT(*) FROM user_role_templates u WHERE u.template_id = t.id) AS users FROM role_templates t ORDER BY t.name'), ['permissions', 'readonly']);
    const one = (tid: string) => list().find((t) => t.id === tid);
    const clean = (body: any, base: any = {}) => {
      const permissions = body.permissions !== undefined ? cleanPermissions(body.permissions) ?? [] : base.permissions ?? [];
      if (!permissions.length) throw bad('Mindestens einen Bereich wählen');
      const readonly = (body.readonly !== undefined ? cleanPermissions(body.readonly) ?? [] : base.readonly ?? []).filter((p: Permission) => permissions.includes(p));
      return {
        name: body.name !== undefined || !base.id ? str(body.name, 'Name', { required: true, max: 60 }) : base.name,
        description: body.description !== undefined ? str(body.description, 'Beschreibung', { max: 300 }) : (base.description ?? ''),
        permissions,
        readonly,
      };
    };
    /** Sets the areas of every member who has the role (admins are skipped – they always have everything). */
    const applyTo = (tpl: { id: string; permissions: string[] }, userIds?: string[]) => {
      const ids = userIds ?? db.all<{ user_id: string }>('SELECT user_id FROM user_role_templates WHERE template_id = ?', tpl.id).map((r) => r.user_id);
      for (const uid of ids) db.run("UPDATE users SET permissions = ? WHERE id = ? AND role = 'member'", JSON.stringify(tpl.permissions), uid);
    };

    /** Keys manage data, not people (mcp.ts KEY_BLOCKED): a role sets members' areas, so only a logged-in admin changes roles. */
    const noKey = (ctx: Ctx) => {
      if (ctx.viaApiKey) throw new HttpError(403, 'Rollen nur mit Anmeldung ändern – nicht mit einem Schlüssel');
    };

    router.get('/api/role-templates', 'admin', () => ({
      templates: list(),
      presets: ROLE_PRESETS,
      permissions: PERMISSIONS,
      assignments: Object.fromEntries(db.all<{ user_id: string; template_id: string }>('SELECT user_id, template_id FROM user_role_templates').map((r) => [r.user_id, r.template_id])),
    }));
    router.post('/api/role-templates', 'admin', (ctx) => {
      noKey(ctx);
      const preset = ROLE_PRESETS.find((p) => p.key === ctx.body?.preset);
      const data = clean(preset ? { ...preset, ...ctx.body, permissions: ctx.body?.permissions ?? preset.permissions, readonly: ctx.body?.readonly ?? preset.readonly } : (ctx.body ?? {}));
      if (db.get('SELECT id FROM role_templates WHERE name = ?', data.name)) throw bad('Eine Rolle mit diesem Namen gibt es schon');
      const row = { id: id(), ...data, created_at: now(), updated_at: now() };
      db.insert('role_templates', row);
      return one(row.id);
    });
    router.patch('/api/role-templates/:id', 'admin', (ctx) => {
      noKey(ctx);
      const cur = one(ctx.params.id);
      if (!cur) throw notFound('Rolle nicht gefunden');
      const data = clean(ctx.body ?? {}, cur);
      if (db.get('SELECT id FROM role_templates WHERE name = ? AND id != ?', data.name, cur.id)) throw bad('Eine Rolle mit diesem Namen gibt es schon');
      db.tx(() => {
        db.update('role_templates', cur.id, { ...data, updated_at: now() });
        applyTo({ id: cur.id, permissions: data.permissions });
      });
      return one(cur.id);
    });
    /** Deleting a role keeps everyone's current areas – only the link (and the read-only limits) go. */
    router.delete('/api/role-templates/:id', 'admin', (ctx) => {
      noKey(ctx);
      if (!db.run('DELETE FROM role_templates WHERE id = ?', ctx.params.id).changes) throw notFound('Rolle nicht gefunden');
      return { ok: true };
    });
    router.post('/api/role-templates/:id/assign', 'admin', (ctx) => {
      noKey(ctx);
      const tpl = one(ctx.params.id);
      if (!tpl) throw notFound('Rolle nicht gefunden');
      const ids: string[] = Array.isArray(ctx.body?.user_ids) ? ctx.body.user_ids.map(String) : [];
      const members = ids.filter((u) => db.get("SELECT id FROM users WHERE id = ? AND role = 'member'", u));
      if (!members.length) throw bad('Keine Mitglieder gewählt (Admins haben immer alle Rechte)');
      db.tx(() => {
        for (const u of members) db.run('INSERT INTO user_role_templates (user_id, template_id, assigned_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET template_id = excluded.template_id, assigned_at = excluded.assigned_at', u, tpl.id, now());
        applyTo(tpl, members);
      });
      return { ok: true, assigned: members.length, template: one(tpl.id) };
    });
    router.post('/api/role-templates/unassign', 'admin', (ctx) => {
      noKey(ctx);
      db.run('DELETE FROM user_role_templates WHERE user_id = ?', String(ctx.body?.user_id ?? ''));
      return { ok: true };
    });

    // Read-only areas: a member with a role may open them, but every write there is refused.
    app.guards.push((ctx) => {
      const u = ctx.user;
      if (!u || u.role === 'admin' || ctx.method === 'GET' || ctx.method === 'HEAD' || ctx.method === 'OPTIONS') return;
      const need = requiredPermission(ctx.method, ctx.path);
      if (!need) return;
      const row = db.get<{ readonly: string }>('SELECT t.readonly FROM user_role_templates u JOIN role_templates t ON t.id = u.template_id WHERE u.user_id = ?', u.id);
      if (!row) return;
      const ro = JSON.parse(row.readonly || '[]') as string[];
      if (ro.includes(need)) throw new HttpError(403, `Nur Lesezugriff auf „${PERMISSIONS[need]}“`);
    });
    // A member's areas changed by hand (Team → Bearbeiten) no longer follow the role.
    app.afterWrite.push((ctx, route) => {
      if (route.pattern !== '/api/users/:id' || ctx.method !== 'PATCH' || ctx.body?.permissions === undefined) return;
      const link = db.get<{ permissions: string }>('SELECT t.permissions FROM user_role_templates u JOIN role_templates t ON t.id = u.template_id WHERE u.user_id = ?', ctx.params.id);
      if (!link) return;
      const mine = cleanPermissions(ctx.body.permissions);
      if (!mine || !sameSet(mine, JSON.parse(link.permissions))) db.run('DELETE FROM user_role_templates WHERE user_id = ?', ctx.params.id);
    });

    // --- MCP (agency only) -----------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_role_templates',
        title: 'Rollen und Rechte anzeigen',
        description: 'Listet die eigenen Rollen (Bereiche, Nur-Lese-Bereiche, Anzahl Personen), die Vorlagen und welche Person welche Rolle hat.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        agencyOnly: true,
        run: (call) => call.api('GET', '/api/role-templates'),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
