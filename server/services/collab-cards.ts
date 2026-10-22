import type { App } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import type { CardData } from './canvas-render.js';
import { areaAllowed, resolveCards } from './canvas-cards.js';
import { accessOf, type BoardRow } from './canvas-store.js';
import { isCardKind, isRefId, type CardKind } from './wiki-markdown.js';

/**
 * Live cards for Wiki pages and Team-Chat messages: a record (contact, deal, task, ticket …), a Canvas
 * board, a project document or another wiki page, shown with its *current* data and the viewer's own
 * rights. CRM kinds are read by the Canvas's card resolver (same guards, same sub-account filter);
 * the extra kinds are resolved here. A record that is gone, in another sub-account or in an area the
 * viewer lacks comes back as an error card, never as data.
 */

export interface EmbedCard extends CardData {
  kind: CardKind;
  /** Preview image (a board's thumbnail) – a path the viewer's browser can load. */
  thumb?: string;
  /** The link leaves the app (a project document). */
  external?: boolean;
}
export type EmbedRef = { kind: string; id: string };

const dt = (iso: string | null | undefined, tz: string) => (iso ? new Date(iso).toLocaleString('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');

type Resolver = (app: App, ctx: Ctx, id: string, tz: string) => EmbedCard | Promise<EmbedCard>;

const RESOLVERS: Partial<Record<CardKind, Resolver>> = {
  canvas: (app, ctx, id, tz) => {
    if (!areaAllowed(app, ctx, '/api/canvas')) return { ok: false, kind: 'canvas', error: 'Kein Zugriff auf Canvas' };
    const b = app.db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ? AND location_id = ?', id, ctx.locationId);
    if (!b || !accessOf(app, ctx, b)) return { ok: false, kind: 'canvas', error: 'Board nicht gefunden (gelöscht, privat oder in einem anderen Sub-Account)' };
    return {
      ok: true,
      kind: 'canvas',
      title: b.name,
      subtitle: b.description || `${b.element_count} Elemente`,
      badge: { text: 'Canvas', tone: 'purple' },
      fields: [
        ['Elemente', String(b.element_count)],
        ['Zuletzt geändert', dt(b.updated_at, tz)],
        ['Von', b.updated_by || '–'],
      ],
      url: `/app/canvas/${b.id}`,
      thumb: `/api/canvas/${b.id}/svg?thumb=1`,
    };
  },
  doc: (app, ctx, id, tz) => {
    if (!areaAllowed(app, ctx, '/api/docs')) return { ok: false, kind: 'doc', error: 'Kein Zugriff auf Dokumente' };
    const d = app.db.get<any>('SELECT * FROM docs WHERE id = ? AND location_id = ?', id, ctx.locationId);
    if (!d) return { ok: false, kind: 'doc', error: 'Dokument nicht gefunden (gelöscht oder in einem anderen Projekt)' };
    return {
      ok: true,
      kind: 'doc',
      title: d.title,
      subtitle: [d.source, d.kind].filter(Boolean).join(' · '),
      badge: { text: d.kind === 'artifact' ? 'Artefakt' : 'Dokument', tone: 'blue' },
      fields: [
        ['Quelle', d.source || '–'],
        ['Aktualisiert', dt(d.updated_at, tz)],
      ],
      url: String(d.url),
      external: true,
    };
  },
};

/** Other modules add kinds (the Wiki registers "wiki" for page links): `app.services.collabCards.wiki = (app, ctx, id, tz) => card`. */
export function registerCardKind(app: App, kind: CardKind, fn: Resolver) {
  (app.services.collabCards ??= {} as Partial<Record<CardKind, Resolver>>)[kind] = fn;
}

/** Resolves many references at once: `{ "kind:id": card }` (at most 100, duplicates once). */
export async function resolveEmbeds(app: App, ctx: Ctx, refs: EmbedRef[]): Promise<Record<string, EmbedCard>> {
  const out: Record<string, EmbedCard> = {};
  const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
  const crm: { kind: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const r of refs.slice(0, 100)) {
    if (!r || !isCardKind(r.kind) || !isRefId(r.id)) continue;
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const own = RESOLVERS[r.kind] ?? (app.services.collabCards as Partial<Record<CardKind, Resolver>> | undefined)?.[r.kind];
    if (!own) {
      crm.push(r);
      continue;
    }
    try {
      out[key] = { ...(await own(app, ctx, r.id, tz)), updatedAt: new Date().toISOString() };
    } catch (e) {
      out[key] = { ok: false, kind: r.kind, error: e instanceof HttpError ? (e.status === 404 ? 'Nicht gefunden' : e.status === 403 ? 'Kein Zugriff' : e.message) : 'Konnte nicht geladen werden' };
    }
  }
  if (crm.length) {
    const cards = await resolveCards(app, ctx, crm);
    for (const [key, c] of Object.entries(cards)) out[key] = { ...c, kind: key.split(':')[0] as CardKind };
  }
  return out;
}
