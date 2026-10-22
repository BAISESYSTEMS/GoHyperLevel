import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, type Ctx } from '../core/http.js';
import { callRoute, ownLocation, visibleLocations, type Loc } from '../services/mobile.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools of the webinars (HyperLevel Agent, Claude, ChatGPT, Codex) and the native app's read endpoints. The tools are thin
 * relays onto the REST routes of modules/webinars.ts, so the key's sub-account, member rights and the audit log apply.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const link = (id?: string) => `/app/webinars${id ? `/${id}` : ''}`;
const WID = { webinar_id: { type: 'string', description: 'Webinar-ID (aus ghl_webinar_list)' } };

const NOTE =
  'Die Webinare sind automatisiert: das Video läuft zum Termin ab, die Räume heißen „Automatisiertes Webinar“ bzw. „Aufzeichnung“ – nenne sie nie „live“. Zeiten sind ISO-Zeitstempel (UTC); zeige sie in der Zeitzone des Sub-Accounts.';

export const WEBINAR_TOOLS: Tool[] = [
  {
    name: 'ghl_webinar_list',
    title: 'Webinare auflisten',
    description: `Alle Webinare eines Sub-Accounts: Titel, Status (draft/published), Dauer, nächster Termin, Anmeldungen und Teilnehmer, Anmeldeseite. ${NOTE}`,
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const list: any[] = await call.api('GET', '/api/webinars', { location: a.location_id });
      return { webinars: list.map((w) => ({ ...w, link: link(w.id) })), link: link() };
    },
  },
  {
    name: 'ghl_webinar_get',
    title: 'Webinar ansehen',
    description: `Ein Webinar mit Videoquelle, Terminen (feste Zeiten, Einzeltermine, „Just in time“, Sofort-Start, Sperrtage), den nächsten buchbaren Terminen mit freien Plätzen, Einstellungen (Anmeldung, Raum, Angebot, Erinnerungen, Aufzeichnung), Anmelde-Link und Zählern. Fehlt etwas zum Veröffentlichen, steht es unter problems. ${NOTE}`,
    inputSchema: obj({ ...LOC, ...WID }, ['location_id', 'webinar_id']),
    annotations: RO,
    run: async (call, a) => {
      const w = await call.api('GET', `/api/webinars/${encodeURIComponent(a.webinar_id)}`, { location: a.location_id });
      const s = w.settings ?? {};
      return {
        id: w.id,
        title: w.title,
        slug: w.slug,
        status: w.status,
        description: w.description,
        presenter_name: w.presenter_name,
        duration_s: w.duration_s,
        video: w.video?.type === 'url' ? { type: 'url', url: w.video.url } : { type: w.video?.type, ...(w.video?.name ? { name: w.video.name } : {}) },
        time_zone: w.tz,
        schedule: w.schedule,
        upcoming_sessions: (w.upcoming ?? []).slice(0, 12),
        registration_url: w.urls?.page,
        settings: {
          label: s.room?.label,
          questions: s.room?.questions,
          counter: s.room?.show_counter,
          scripted_messages: s.room?.scripted_enabled ? (s.room?.scripted ?? []).length : 0,
          polls: (s.room?.polls ?? []).map((p: any) => ({ at_s: p.at_s, question: p.question })),
          offer: s.offer?.enabled ? { at_s: s.offer.at_s, title: s.offer.title, target: s.offer.target, countdown_s: s.offer.countdown_s } : null,
          reminders: (s.reminders?.items ?? []).map((r: any) => ({ key: r.key, minutes_before: r.offset_min, email: r.email, sms: r.sms })),
          replay: s.replay,
        },
        counts: w.counts,
        problems: w.problems,
        link: link(w.id),
      };
    },
  },
  {
    name: 'ghl_webinar_register',
    title: 'Kontakt für Webinar anmelden',
    description: `Meldet einen Kontakt für ein veröffentlichtes Webinar an: entweder mit contact_id (bestehender Kontakt mit E-Mail) oder mit email + first_name (der Kontakt wird angelegt bzw. zusammengeführt). Ohne session gilt der nächste freie Termin; session ist der ISO-Start aus ghl_webinar_get (upcoming_sessions) oder „ondemand“ für einen eigenen Termin ab jetzt. Der Kontakt bekommt die Bestätigung mit Kalenderdatei und persönlichem Link, danach die Erinnerungen – frage vorher, ob das gewollt ist. Mehrfaches Anmelden für denselben Termin legt nichts doppelt an. ${NOTE}`,
    inputSchema: obj(
      {
        ...LOC,
        ...WID,
        contact_id: { type: 'string', description: 'Vorhandener Kontakt (statt email/first_name)' },
        email: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        session: { type: 'string', description: 'ISO-Start eines Termins oder „ondemand“; leer = nächster freier Termin' },
        silent: { type: 'boolean', description: 'true = keine Bestätigungs-E-Mail (nur für Importe)' },
      },
      ['location_id', 'webinar_id'],
    ),
    annotations: W,
    run: async (call, a) => {
      const r = await call.api('POST', `/api/webinars/${encodeURIComponent(a.webinar_id)}/registrations`, { location: a.location_id, body: { contact_id: a.contact_id, email: a.email, first_name: a.first_name, last_name: a.last_name, phone: a.phone, session: a.session, silent: a.silent } });
      return { registration_id: r.id, contact_id: r.contact_id, created: r.created, session: r.session, join_url: r.join_url, link: link(a.webinar_id) };
    },
  },
  {
    name: 'ghl_webinar_stats',
    title: 'Webinar-Auswertung',
    description: `Zahlen eines Webinars insgesamt und je Termin: Anmeldungen, Teilnehmer, Show-up-Rate (nur für begonnene Termine), durchschnittliche Sehdauer, Abbruchkurve (Anteil der Zuschauer an 21 Punkten des Videos), Klicks auf das Angebot, Käufe und Umsatz in Cent, Aufzeichnungs-Aufrufe, Fragen, Umfrage-Ergebnisse. ${NOTE}`,
    inputSchema: obj({ ...LOC, ...WID }, ['location_id', 'webinar_id']),
    annotations: RO,
    run: async (call, a) => {
      const s = await call.api('GET', `/api/webinars/${encodeURIComponent(a.webinar_id)}/stats`, { location: a.location_id });
      return { ...s, link: link(a.webinar_id) };
    },
  },
];

export const webinarToolsModule: Module = {
  name: 'webinar-tools',
  register(app) {
    const { router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...WEBINAR_TOOLS];

    // --- native app (bearer ghm_…): read only ------------------------------------------------------------------------
    /** Runs `fn` in the sub-accounts the request covers (one `?location=` or all the user can open); where the area is missing: skipped, or the refusal for one explicit sub-account. */
    async function each<T>(ctx: Ctx, fn: (loc: Loc) => Promise<T>): Promise<{ loc: Loc; data: T }[]> {
      const want = String(ctx.query.get('location') ?? '').trim() || 'all';
      const visible = visibleLocations(app, ctx);
      if (want !== 'all') {
        const loc = visible.find((l) => l.id === want);
        if (!loc) {
          if (!app.db.get('SELECT id FROM locations WHERE id = ?', want)) throw notFound('Sub-Account nicht gefunden');
          throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
        }
        return [{ loc, data: await fn(loc) }];
      }
      const out: { loc: Loc; data: T }[] = [];
      let first: HttpError | undefined;
      for (const loc of visible) {
        try {
          out.push({ loc, data: await fn(loc) });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          first ??= e;
        }
      }
      if (!out.length && first) throw first;
      return out;
    }

    router.get('/api/mobile/webinars', 'user', async (ctx) => {
      const rows = await each(ctx, (loc) => callRoute<any[]>(app, ctx, 'GET', '/api/webinars', { locationId: loc.id }));
      const limit = clampLimit(ctx.query.get('limit'), 20, 50);
      const status = String(ctx.query.get('status') ?? '').trim();
      if (status && status !== 'draft' && status !== 'published') throw bad('status: draft oder published');
      const webinars = rows
        .flatMap((r) => r.data.map((w) => ({ location_id: r.loc.id, location_name: r.loc.name, id: w.id, title: w.title, status: w.status, duration_s: w.duration_s, next_session: w.next_session, registrations: w.registrations, attended: w.attended, upcoming_registrations: w.upcoming_registrations, url: w.url, updated_at: w.updated_at })))
        .filter((w) => !status || w.status === status)
        .sort((a, b) => String(a.next_session ?? '9999').localeCompare(String(b.next_session ?? '9999')) || String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, limit);
      return { webinars };
    });

    router.get('/api/mobile/webinars/:id', 'user', async (ctx) => {
      const loc = ownLocation(app, ctx, 'webinars', ctx.params.id, 'Webinar nicht gefunden');
      const w = await callRoute<any>(app, ctx, 'GET', `/api/webinars/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id });
      return {
        location_id: loc.id,
        location_name: loc.name,
        id: w.id,
        title: w.title,
        status: w.status,
        description: w.description,
        presenter_name: w.presenter_name,
        duration_s: w.duration_s,
        time_zone: w.tz,
        upcoming: (w.upcoming ?? []).slice(0, 10).map((s: any) => ({ start: s.start, kind: s.kind, taken: s.taken, full: s.full })),
        counts: w.counts,
        url: w.urls?.page,
        problems: w.problems,
      };
    });

    router.get('/api/mobile/webinars/:id/stats', 'user', async (ctx) => {
      const loc = ownLocation(app, ctx, 'webinars', ctx.params.id, 'Webinar nicht gefunden');
      const s = await callRoute<any>(app, ctx, 'GET', `/api/webinars/${encodeURIComponent(ctx.params.id)}/stats`, { locationId: loc.id });
      return { location_id: loc.id, totals: s.totals, sessions: s.sessions.slice(0, 20), dropoff: s.dropoff };
    });
  },
};
