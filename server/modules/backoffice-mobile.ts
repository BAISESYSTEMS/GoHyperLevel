import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str, type Ctx } from '../core/http.js';
import { bodyLocation, callRoute, ownLocation, visibleLocations, type Loc } from '../services/mobile.js';

/**
 * Back-Office on the phone (contract: docs/api.md → "Mobile-App"). Thin relays onto the regular routes, like the rest of
 * /api/mobile/*: the same member areas, the same checks, the same audit log (via "app").
 *
 * - receipts: photograph a receipt, see the inbox status (area "Buchhaltung")
 * - absences: request vacation/sick leave, see your balance, withdraw; managers approve their team's requests (no area – everyone
 *   sees only their own record, see modules/hr.ts)
 * - stock: what is below the minimum (area "Lager & Einkauf")
 *
 * Sensitive HR fields are not reachable here: the device token is not a browser session.
 */
export const backofficeMobileModule: Module = {
  name: 'backoffice-mobile',
  migrations: [],
  register(app) {
    const { router } = app;
    const relay = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };

    /**
     * Runs `fn` in the sub-accounts the request covers (`?location=<id>` or all the user can open). Where the user lacks the area
     * the sub-account is skipped; for one explicit sub-account the refusal is returned.
     */
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
    const tag = (loc: Loc) => ({ location_id: loc.id, location_name: loc.name });

    // --- receipts ---------------------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/receipts', 'user', async (ctx) => {
      const status = String(ctx.query.get('status') ?? '').trim();
      if (status && !['inbox', 'review', 'booked', 'discarded'].includes(status)) throw bad('status: inbox, review, booked oder discarded');
      const limit = clampLimit(ctx.query.get('limit'), 10, 20);
      const rows = await each(ctx, (loc) => callRoute<{ counts: Record<string, number>; receipts: any[] }>(app, ctx, 'GET', `/api/accounting/receipts/status${status ? `?status=${status}` : ''}`, { locationId: loc.id }));
      const counts = { inbox: 0, review: 0, booked: 0, discarded: 0 };
      for (const r of rows) for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += r.data.counts[k] ?? 0;
      const receipts = rows
        .flatMap((r) => r.data.receipts.map((x) => ({ ...x, ...tag(r.loc) })))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
      return { counts, receipts };
    });

    /** `{location_id, data: "data:image/jpeg;base64,…", name?, note?}` – the receipt lands in the inbox, marked as coming from the phone. */
    router.post('/api/mobile/receipts', 'user', async (ctx) => {
      relay(ctx);
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const mime = /^data:([\w/+.-]+);base64,/.exec(String(b.data ?? ''))?.[1] ?? '';
      const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' } as Record<string, string>)[mime] ?? 'jpg';
      const name = str(b.name, 'Dateiname', { max: 200 }) || `Beleg-${new Date().toISOString().slice(0, 10)}.${ext}`;
      const out = await callRoute(app, ctx, 'POST', '/api/accounting/receipts', { locationId: loc.id, body: { name, data: b.data, note: str(b.note, 'Notiz', { max: 500 }), source: 'mobile' } });
      return { ...out, ...tag(loc) };
    });

    // --- absences (self-service) ---------------------------------------------------------------------------------------------------------
    /** Own record per sub-account: contract data, vacation balance and the year's absences. */
    router.get('/api/mobile/absences', 'user', async (ctx) => {
      const year = ctx.query.get('year') ? `?year=${encodeURIComponent(String(ctx.query.get('year')))}` : '';
      const rows = await each(ctx, async (loc) => {
        const me = await callRoute<any>(app, ctx, 'GET', '/api/me/hr', { locationId: loc.id });
        const absences = me.employee ? await callRoute<any[]>(app, ctx, 'GET', `/api/me/hr/absences${year}`, { locationId: loc.id }) : [];
        const balance = me.employee && year ? (await callRoute<any>(app, ctx, 'GET', `/api/me/hr/balance${year}`, { locationId: loc.id })).balance : me.balance;
        return { employee: me.employee ? { id: me.employee.id, name: me.employee.name, vacation_days: me.employee.vacation_days, state: me.employee.state } : null, is_manager: !!me.is_manager, balance, absences };
      });
      // With "all" only the sub-accounts where the login is an employee (or manager) are listed.
      const one = String(ctx.query.get('location') ?? '').trim() && ctx.query.get('location') !== 'all';
      return rows.filter((r) => one || r.data.employee || r.data.is_manager).map((r) => ({ ...tag(r.loc), ...r.data }));
    });

    /** `{location_id, type: vacation|sick|other, start_date, end_date?, half_start?, half_end?, label?, reason?, certificate?}` */
    router.post('/api/mobile/absences', 'user', async (ctx) => {
      relay(ctx);
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const { location_id, ...rest } = b;
      void location_id;
      const a = await callRoute(app, ctx, 'POST', '/api/me/hr/absences', { locationId: loc.id, body: rest });
      return { ...a, ...tag(loc) };
    });

    router.post('/api/mobile/absences/:id/cancel', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'hr_absences', ctx.params.id, 'Antrag nicht gefunden');
      const a = await callRoute(app, ctx, 'POST', `/api/me/hr/absences/${encodeURIComponent(ctx.params.id)}/cancel`, { locationId: loc.id, body: {} });
      return { ...a, ...tag(loc) };
    });

    /** Colleagues' absences in a period (approved ones; sick leave only as "away"). `?location&from&to` */
    router.get('/api/mobile/absences/calendar', 'user', async (ctx) => {
      const qs = ['from', 'to'].filter((k) => ctx.query.get(k)).map((k) => `${k}=${encodeURIComponent(String(ctx.query.get(k)))}`).join('&');
      const rows = await each(ctx, (loc) => callRoute<any>(app, ctx, 'GET', `/api/me/hr/calendar${qs ? `?${qs}` : ''}`, { locationId: loc.id }));
      return rows.filter((r) => r.data.items.length || r.data.holidays.length).map((r) => ({ ...tag(r.loc), ...r.data }));
    });

    // --- approvals for managers ---------------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/absences/approvals', 'user', async (ctx) => {
      const rows = await each(ctx, (loc) => callRoute<any[]>(app, ctx, 'GET', '/api/me/hr/approvals', { locationId: loc.id }));
      return rows.flatMap((r) => r.data.map((a) => ({ ...a, ...tag(r.loc) }))).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    });
    /** `{decision: approved|rejected, note?}` – only the manager of the employee (HR decides in the web app). */
    router.post('/api/mobile/absences/:id/decide', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'hr_absences', ctx.params.id, 'Antrag nicht gefunden');
      const a = await callRoute(app, ctx, 'POST', `/api/me/hr/absences/${encodeURIComponent(ctx.params.id)}/decide`, { locationId: loc.id, body: { decision: ctx.body?.decision, note: ctx.body?.note } });
      return { ...a, ...tag(loc) };
    });

    // --- stock ----------------------------------------------------------------------------------------------------------------------------------------
    router.get('/api/mobile/stock/low', 'user', async (ctx) => {
      const rows = await each(ctx, (loc) => callRoute<any[]>(app, ctx, 'GET', '/api/inventory/low-stock', { locationId: loc.id }));
      return rows.flatMap((r) => r.data.map((a) => ({ ...a, ...tag(r.loc) })));
    });
  },
};
