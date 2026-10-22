import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { LIMITS, cleanAccent, cleanIcon, cleanLine, cleanText } from '../services/boards-model.js';
import { createBoard, stateOf, type BoardRow } from '../services/boards-store.js';
import { STARTERS, TEMPLATE_CATEGORIES, cleanTemplateInput, integrityOf, reviewTemplate, stateFromTemplate, templateFromState, type TemplateReview, type TemplateWidget } from '../services/boards-templates.js';
import { requirePro } from '../services/werkstatt/license.js';
import { NAMES } from '../services/werkstatt/names.js';

/**
 * Living Boards, templates: starter boards, the sub-account's own templates and the Marktplatz. A template is config only
 * (widgets, their settings and places) – never code, never ids of the sub-account it came from. Publishing in the
 * Marktplatz follows the plugin flow in miniature: an admin, a review of what the board reads and shows, an explicit
 * approval; installing in another sub-account asks for a consent that lists exactly that. Export and import make
 * templates travel between installations as a JSON file.
 */

interface TemplateRow {
  id: string;
  location_id: string;
  owner_id: string | null;
  owner_name: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  scope: 'location' | 'marketplace';
  widgets: string;
  accent: string;
  integrity: string;
  version: number;
  installs: number;
  source_board_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  published_by: string | null;
}

const FORMAT = 'gohigh-board-template';
const category = (v: unknown) => (TEMPLATE_CATEGORIES.some(([k]) => k === v) ? String(v) : 'sonstiges');

export const boardsTemplatesModule: Module = {
  name: 'boards-templates',
  register(app) {
    const { db, router } = app;
    const B = () => app.services.boards as any;
    const reg = () => B().registry;
    const env = (locationId: string) => ({ reg: reg(), env: { app, locationId } });
    const hostOf = (url: string) => {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return null;
      }
    };
    const widgetsOf = (r: TemplateRow): TemplateWidget[] => {
      try {
        return cleanTemplateInput({ widgets: JSON.parse(r.widgets) }).widgets;
      } catch {
        return [];
      }
    };
    const reviewOf = (locationId: string, widgets: TemplateWidget[]): TemplateReview => reviewTemplate({ widgets }, { reg: reg(), env: { app, locationId }, hostOf });
    const preview = (widgets: { type: string; x: number; y: number; w: number; h: number }[]) => widgets.slice(0, 40).map(({ type, x, y, w, h }) => ({ type, x, y, w, h }));
    const isAdmin = (ctx: Ctx) => ctx.user?.role === 'admin';

    /** May the caller see this template? Own sub-account's, or one published in the Marktplatz. */
    const visible = (ctx: Ctx, r: TemplateRow | undefined): r is TemplateRow => !!r && (r.location_id === ctx.locationId || r.scope === 'marketplace');
    const mustSee = (ctx: Ctx, id: string): TemplateRow => {
      const r = db.get<TemplateRow>('SELECT * FROM board_templates WHERE id = ?', id);
      if (!visible(ctx, r)) throw notFound('Vorlage nicht gefunden');
      return r;
    };
    const canManage = (ctx: Ctx, r: TemplateRow) => r.location_id === ctx.locationId && (isAdmin(ctx) || (!!ctx.user && r.owner_id === ctx.user.id));

    const out = (ctx: Ctx, r: TemplateRow, detail = false) => {
      const widgets = widgetsOf(r);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        category_label: TEMPLATE_CATEGORIES.find(([k]) => k === r.category)?.[1] ?? r.category,
        icon: r.icon,
        accent: r.accent,
        scope: r.scope,
        version: r.version,
        installs: r.installs,
        widgets: widgets.length,
        preview: preview(widgets),
        author: r.owner_name,
        mine: r.location_id === ctx.locationId,
        can_manage: canManage(ctx, r),
        published_at: r.published_at,
        updated_at: r.updated_at,
        ...(detail ? { items: widgets.map((w) => ({ type: w.type, title: w.title || reg().get(w.type)?.label || w.type })), review: reviewOf(ctx.locationId, widgets) } : {}),
      };
    };

    // --- listing ----------------------------------------------------------------------------------------------------------------
    router.get('/api/board-templates', 'location', (ctx) => {
      const q = String(ctx.query.get('q') ?? '').trim().toLowerCase().slice(0, 80);
      const cat = String(ctx.query.get('category') ?? '');
      const match = (name: string, description: string) => !q || `${name} ${description}`.toLowerCase().includes(q);
      const mine = db.all<TemplateRow>('SELECT * FROM board_templates WHERE location_id = ? ORDER BY updated_at DESC LIMIT 200', ctx.locationId).filter((r) => match(r.name, r.description) && (!cat || r.category === cat));
      const market = db.all<TemplateRow>("SELECT * FROM board_templates WHERE scope = 'marketplace' AND location_id <> ? ORDER BY installs DESC, published_at DESC LIMIT 200", ctx.locationId).filter((r) => match(r.name, r.description) && (!cat || r.category === cat));
      return {
        starters: STARTERS.filter((s) => match(s.name, s.description)).map((s) => ({ key: s.key, name: s.name, description: s.description, icon: s.icon, accent: cleanAccent(s.accent) ?? '', widgets: s.widgets.length, preview: preview(s.widgets) })),
        mine: mine.map((r) => out(ctx, r)),
        marketplace: market.map((r) => out(ctx, r)),
        categories: TEMPLATE_CATEGORIES.map(([key, label]) => ({ key, label })),
        names: NAMES,
        can_publish: isAdmin(ctx),
      };
    });

    // --- review before sharing (static paths before /:id) -------------------------------------------------------------------------------
    router.get('/api/board-templates/check', 'location', (ctx) => {
      const { board } = B().load(ctx, String(ctx.query.get('board_id') ?? '')) as { board: BoardRow };
      const t = templateFromState(stateOf(board), reg());
      return { review: reviewOf(ctx.locationId, t.widgets), stripped: t.stripped, widgets: t.widgets.length, name: board.name, icon: board.icon };
    });

    // --- save a board as a template, publish ------------------------------------------------------------------------------------------------
    router.post('/api/board-templates', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const { board } = B().load(ctx, String(b.board_id ?? ''), 'edit') as { board: BoardRow };
      const name = cleanLine(str(b.name, 'Name', { max: 200 }), LIMITS.name) || board.name;
      const description = cleanText(str(b.description, 'Beschreibung', { max: 2000 }), 600);
      const scope = b.scope === 'marketplace' ? 'marketplace' : 'location';
      const t = templateFromState(stateOf(board), reg());
      const review = reviewOf(ctx.locationId, t.widgets);
      if (review.verdict === 'fail') throw new HttpError(409, `Das Board lässt sich nicht als Vorlage speichern: ${review.checks.find((c) => c.level === 'fail')?.text}`);
      if (scope === 'marketplace') {
        if (!isAdmin(ctx)) throw new HttpError(403, `Nur Admins veröffentlichen im ${NAMES.marktplatz}.`);
        requirePro(app, 'marktplatz');
        if (b.approve !== true) throw bad(`Bitte bestätige die Veröffentlichung im ${NAMES.marktplatz} (approve).`);
        if (review.verdict === 'warn' && b.accept_warnings !== true) throw bad('Die Prüfung hat Hinweise – bitte bestätigen, dass du sie gelesen hast (accept_warnings).');
      }
      const widgets = t.widgets;
      const accent = cleanAccent(board.accent) ?? '';
      const row0 = { name, description, category: category(b.category), icon: cleanIcon(board.icon), accent, widgets: JSON.stringify(widgets), integrity: integrityOf({ name, icon: cleanIcon(board.icon), accent, widgets }) };
      // Publishing the same board again updates its template (a new version) instead of adding a second one.
      const prior = db.get<TemplateRow>('SELECT * FROM board_templates WHERE location_id = ? AND source_board_id = ?', ctx.locationId, board.id);
      const t0 = now();
      let row: TemplateRow;
      if (prior) {
        row = { ...prior, ...row0, scope, version: prior.version + 1, updated_at: t0, published_at: scope === 'marketplace' ? (prior.published_at ?? t0) : null, published_by: scope === 'marketplace' ? (ctx.user?.id ?? null) : null };
        db.run('UPDATE board_templates SET name = ?, description = ?, category = ?, icon = ?, accent = ?, widgets = ?, integrity = ?, scope = ?, version = ?, updated_at = ?, published_at = ?, published_by = ? WHERE id = ?', row.name, row.description, row.category, row.icon, row.accent, row.widgets, row.integrity, row.scope, row.version, row.updated_at, row.published_at, row.published_by, row.id);
      } else {
        row = { id: newId(), location_id: ctx.locationId, owner_id: ctx.user?.id ?? null, owner_name: ctx.user?.name ?? 'API-Schlüssel', ...row0, scope, version: 1, installs: 0, source_board_id: board.id, created_at: t0, updated_at: t0, published_at: scope === 'marketplace' ? t0 : null, published_by: scope === 'marketplace' ? (ctx.user?.id ?? null) : null };
        db.insert('board_templates', row);
      }
      return { ...out(ctx, row, true), stripped: t.stripped };
    });

    router.post('/api/board-templates/import', 'location', (ctx) => {
      const bundle = ctx.body?.bundle;
      if (!bundle || typeof bundle !== 'object' || bundle.format !== FORMAT || !bundle.template) throw bad(`Das ist keine Board-Vorlage (format „${FORMAT}“ erwartet).`);
      const src = bundle.template as Record<string, any>;
      const name = cleanLine(src.name, LIMITS.name);
      if (!name) throw bad('Die Vorlage hat keinen Namen.');
      const cleaned = cleanTemplateInput(src);
      if (cleaned.errors.length) throw bad(`Die Vorlage ist nicht gültig: ${cleaned.errors[0]}`);
      const icon = cleanIcon(src.icon);
      const accent = cleanAccent(src.accent) ?? '';
      const review = reviewOf(ctx.locationId, cleaned.widgets);
      if (review.verdict === 'fail') throw bad(`Die Vorlage lässt sich hier nicht verwenden: ${review.checks.find((c) => c.level === 'fail')?.text}`);
      const integrityOk = bundle.integrity === integrityOf({ name, icon, accent, widgets: cleaned.widgets });
      const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM board_templates WHERE location_id = ?', ctx.locationId)!.n;
      if (total >= 100) throw bad('Ein Sub-Account kann höchstens 100 Vorlagen haben.');
      const t0 = now();
      const row: TemplateRow = { id: newId(), location_id: ctx.locationId, owner_id: ctx.user?.id ?? null, owner_name: ctx.user?.name ?? 'API-Schlüssel', name, description: cleanText(src.description, 600), category: category(src.category), icon, accent, scope: 'location', widgets: JSON.stringify(cleaned.widgets), integrity: integrityOf({ name, icon, accent, widgets: cleaned.widgets }), version: 1, installs: 0, source_board_id: null, created_at: t0, updated_at: t0, published_at: null, published_by: null };
      db.insert('board_templates', row);
      return { ...out(ctx, row, true), integrity_ok: integrityOk };
    });

    router.get('/api/board-templates/:id', 'location', (ctx) => out(ctx, mustSee(ctx, ctx.params.id), true));

    router.get('/api/board-templates/:id/export', 'location', (ctx) => {
      const r = mustSee(ctx, ctx.params.id);
      const widgets = widgetsOf(r);
      return {
        format: FORMAT,
        bundle_version: 1,
        exported_at: now(),
        template: { name: r.name, description: r.description, category: r.category, icon: r.icon, accent: r.accent, widgets },
        integrity: integrityOf({ name: r.name, icon: r.icon, accent: r.accent, widgets }),
      };
    });

    // --- install: a new board from a template -----------------------------------------------------------------------------------------------
    router.post('/api/board-templates/:id/install', 'location', (ctx) => {
      const r = mustSee(ctx, ctx.params.id);
      const widgets = widgetsOf(r);
      if (r.integrity !== integrityOf({ name: r.name, icon: r.icon, accent: r.accent, widgets })) throw new HttpError(409, 'Die Vorlage wurde verändert und lässt sich nicht installieren.');
      const foreign = r.location_id !== ctx.locationId;
      const review = reviewOf(ctx.locationId, widgets);
      if (foreign) {
        // The Marktplatz way: installing somebody else's template asks for exactly what it reads and shows.
        requirePro(app, 'marktplatz');
        const want = review.needs.map((n) => n.key).sort().join('|');
        const given = Array.isArray(ctx.body?.consent) ? (ctx.body.consent as unknown[]).map(String).sort().join('|') : null;
        if (given !== want) throw bad('Bitte bestätige, was die Vorlage liest und zeigt (consent).');
      }
      if (review.verdict === 'fail') throw new HttpError(409, `Die Vorlage lässt sich hier nicht installieren: ${review.checks.find((c) => c.level === 'fail')?.text}`);
      const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM boards WHERE location_id = ?', ctx.locationId)!.n;
      if (total >= LIMITS.boardsPerLocation) throw bad(`Ein Sub-Account hat höchstens ${LIMITS.boardsPerLocation} Boards`);
      const name = cleanLine(str(ctx.body?.name, 'Name', { max: 200 }), LIMITS.name) || r.name;
      const scope = ctx.body?.scope === 'shared' ? 'shared' : 'personal';
      if (!ctx.user && scope === 'personal') throw bad('Mit einem Schlüssel lassen sich nur geteilte Boards anlegen (scope: shared)');
      const built = stateFromTemplate({ name, icon: r.icon, accent: r.accent, widgets }, { ...env(ctx.locationId), strict: false });
      if (built.errors.length) throw bad(`Die Vorlage lässt sich hier nicht anlegen: ${built.errors[0]}`);
      const { board } = createBoard(app, ctx, { name, scope, team_access: 'view', state: built.state, template_key: r.id, kind: 'template', summary: `Aus Vorlage „${r.name}“${foreign ? ` (${NAMES.marktplatz})` : ''} angelegt` });
      db.run('UPDATE board_templates SET installs = installs + 1 WHERE id = ?', r.id);
      return B().full(ctx, board, 'owner');
    });

    // --- take back, delete -------------------------------------------------------------------------------------------------------------------
    router.post('/api/board-templates/:id/unpublish', 'location', (ctx) => {
      const r = mustSee(ctx, ctx.params.id);
      if (!canManage(ctx, r)) throw new HttpError(403, 'Das darf nur die Autorin bzw. der Autor oder ein Admin.');
      if (r.scope !== 'marketplace') return out(ctx, r);
      db.run("UPDATE board_templates SET scope = 'location', published_at = NULL, published_by = NULL, updated_at = ? WHERE id = ?", now(), r.id);
      return out(ctx, { ...r, scope: 'location', published_at: null });
    });
    router.delete('/api/board-templates/:id', 'location', (ctx) => {
      const r = mustSee(ctx, ctx.params.id);
      if (!canManage(ctx, r)) throw new HttpError(403, 'Das darf nur die Autorin bzw. der Autor oder ein Admin.');
      db.run('DELETE FROM board_templates WHERE id = ?', r.id);
      return { ok: true };
    });

  },
};
