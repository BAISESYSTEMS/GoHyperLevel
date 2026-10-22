import type { App, Module } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { parseJson } from '../core/db.js';
import { callRoute } from '../services/route-call.js';

/**
 * Dogfooding hook for the public landing page: its waitlist/newsletter form posts into a sub-account of this instance
 * through the normal forms module – same validation, spam and rate limits, Double-Opt-in, consent proof, attribution and
 * workflows as any public form. The landing page itself lives elsewhere (it only calls these routes).
 *
 *   PGHL_LANDING_LOCATION  sub-account id that receives the sign-ups (off when empty)
 *   PGHL_LANDING_FORM      form id in that sub-account; empty = its newest form named „Warteliste & Newsletter“
 *                          (the form of the „Software- & SaaS-Firma (HQ)“ template)
 *
 * GET  /api/public/landing/waitlist  → { enabled, form_id?, fields? }  what to render
 * POST /api/public/landing/waitlist  → the form's answer ({ ok, id }); body = the form's field names (`email`,
 *      `first_name`, `consent`, …) plus `_hp`/`_ts`/`_attr`/`_page`/UTM keys as for any form. `plan` is accepted for
 *      `custom.plan`, and `source` defaults to „Landingpage“.
 * Other server code (a server-rendered landing page) uses `app.services.landingWaitlist.config()` / `.submit(ctx, body)`.
 * See docs/company-playbook.md#landing-page-waitlist-dogfooding.
 */

export const LANDING_FORM_NAME = 'Warteliste & Newsletter';

export function landingConfig(app: App): { locationId: string; form: any } | null {
  const locationId = (process.env.PGHL_LANDING_LOCATION ?? '').trim();
  if (!locationId || !app.location(locationId)) return null;
  const formId = (process.env.PGHL_LANDING_FORM ?? '').trim();
  const row = formId
    ? app.db.get('SELECT * FROM forms WHERE id = ? AND location_id = ?', formId, locationId)
    : app.db.get('SELECT * FROM forms WHERE location_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1', locationId, LANDING_FORM_NAME);
  return row ? { locationId, form: parseJson(row, ['fields', 'settings']) } : null;
}

async function submit(app: App, ctx: Ctx, body: Record<string, any>) {
  const cfg = landingConfig(app);
  if (!cfg) throw new HttpError(404, 'Die Warteliste ist gerade nicht verfügbar');
  const names = new Set<string>((cfg.form.fields ?? []).map((f: any) => String(f.name)));
  const raw: Record<string, any> = { ...(body ?? {}) };
  if (raw.plan !== undefined && names.has('custom.plan') && raw['custom.plan'] === undefined) raw['custom.plan'] = raw.plan;
  if (names.has('source') && !raw.source) raw.source = 'Landingpage';
  return callRoute(app, ctx, 'POST', `/api/public/forms/${encodeURIComponent(cfg.form.id)}/submit`, raw);
}

export const landingWaitlistModule: Module = {
  name: 'landing-waitlist',
  register(app) {
    const { router } = app;
    app.services.landingWaitlist = {
      config: () => {
        const c = landingConfig(app);
        return c ? { locationId: c.locationId, formId: c.form.id } : null;
      },
      submit: (ctx: Ctx, body: Record<string, any>) => submit(app, ctx, body),
    };
    router.get('/api/public/landing/waitlist', 'public', () => {
      const c = landingConfig(app);
      if (!c) return { enabled: false };
      const fields = (c.form.fields ?? []).filter((f: any) => !['heading', 'page_break'].includes(f.type)).map((f: any) => ({ name: f.name, type: f.type, label: f.label, required: !!f.required, options: f.options ?? [] }));
      return { enabled: true, form_id: c.form.id, fields, thank_you: String(c.form.settings?.thank_you ?? '') };
    });
    router.post('/api/public/landing/waitlist', 'public', (ctx) => submit(app, ctx, ctx.body ?? {}));
  },
};
