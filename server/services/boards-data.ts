/**
 * Living Boards: reading the data of a board's widgets for one viewer. Each widget runs on its own: a widget that
 * fails, is locked or has nothing to show never breaks the board. The viewer's rights decide everything – the widget
 * asks the app's own guards first (member right and SaaS plan of the widget's `access` route) and reads through that
 * viewer's own API routes, pinned to the board's sub-account.
 */

import type { App } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { callRoute } from './route-call.js';
import type { BoardSpec, WidgetInst } from './boards-model.js';
import type { View, WidgetCtx, WidgetRegistry } from './boards-widgets.js';

export interface WidgetData {
  view: View;
  ms: number;
}

/** The guards' refusal for a route (member right, SaaS plan) in the viewer's words, or null when the viewer may use it. */
export function denial(app: App, ctx: Ctx, path: string): string | null {
  const url = new URL(path, 'http://local');
  const sub: Ctx = { ...ctx, method: 'GET', url, path: url.pathname, query: url.searchParams, params: {}, body: {}, rawBody: '' };
  try {
    for (const g of app.guards) g(sub, 'location');
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e.message;
    throw e;
  }
}

export function widgetCtx(app: App, ctx: Ctx): WidgetCtx {
  const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
  return {
    app,
    ctx,
    locationId: ctx.locationId,
    tz,
    user: ctx.user,
    now: new Date(),
    allowed: (path) => denial(app, ctx, path) === null,
    // Widgets only read: even a POST (a report run) changes nothing, so it leaves no audit entry.
    call: (method, path, body) => callRoute(app, ctx, method, path, body ?? {}, { quiet: true }),
  };
}

const message = (text: string, tone: 'gray' | 'yellow' | 'red' = 'gray'): View => ({ kind: 'message', text, tone });

/** One widget's view for this viewer. Never throws. */
export async function widgetData(app: App, ctx: Ctx, w: WidgetInst, reg: WidgetRegistry): Promise<WidgetData> {
  const t0 = Date.now();
  const done = (view: View): WidgetData => ({ view, ms: Date.now() - t0 });
  const def = reg.get(w.type);
  if (!def) return done(message(`Dieses Widget („${w.type}“) ist auf diesem Server nicht verfügbar.`, 'yellow'));
  if (!def.data) return done(message('Dieses Widget zeigt keine Daten.'));
  if (def.access) {
    const why = denial(app, ctx, def.access);
    if (why) return done({ kind: 'locked', reason: why });
  }
  try {
    const view = await def.data(widgetCtx(app, ctx), w.config);
    return done(view);
  } catch (e) {
    if (e instanceof HttpError) {
      // A refusal from a route behind the widget (e.g. the area of a report source) is "locked", the rest a hint.
      if (e.status === 401 || e.status === 403) return done({ kind: 'locked', reason: e.message });
      if (e.status < 500) return done(message(e.message, 'yellow'));
    }
    console.error(`[boards] widget ${w.type}:`, e);
    return done(message('Die Daten konnten gerade nicht geladen werden.', 'red'));
  }
}

/** All widgets of a spec (or only `ids`) for one viewer, keyed by widget id. */
export async function boardData(app: App, ctx: Ctx, spec: BoardSpec, reg: WidgetRegistry, ids?: string[]): Promise<Record<string, WidgetData>> {
  const list = spec.widgets.filter((w) => !ids || ids.includes(w.id));
  const out: Record<string, WidgetData> = {};
  const results = await Promise.all(list.map((w) => widgetData(app, ctx, w, reg)));
  list.forEach((w, i) => (out[w.id] = results[i]));
  return out;
}
