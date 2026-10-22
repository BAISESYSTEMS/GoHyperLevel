import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { sealSecret } from '../core/secrets.js';
import { id, now } from '../core/util.js';
import { cleanFields, cleanFormSettings } from '../services/form-fields.js';
import { TEMPLATES, TEMPLATE_CATEGORIES, templateById, templateCard } from '../services/form-templates.js';
import { FONTS, PRESETS, cleanTheme } from '../services/form-themes.js';
import { captchaKeys } from '../services/form-captcha.js';

/**
 * The form editor's library (docs/forms.md): the template gallery (German starting points, opened as a normal form), the theme presets and
 * the Turnstile keys of the sub-account (secret key sealed, never returned). These routes sit before /api/forms/:id in the registry.
 */

const KEY = /^[A-Za-z0-9_-]{8,120}$/;
const hint = (secret: string) => (secret ? `…${secret.slice(-4)}` : '');

export const formLibraryModule: Module = {
  name: 'form-library',
  migrations: [
    [
      '001-captcha',
      `CREATE TABLE form_captcha (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        site_key TEXT NOT NULL, secret_sealed TEXT NOT NULL, hint TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- templates -------------------------------------------------------------------------------------------------------------------------
    router.get('/api/forms/templates', 'location', () => ({ categories: TEMPLATE_CATEGORIES, templates: TEMPLATES.map(templateCard) }));
    router.get('/api/forms/templates/:tid', 'location', (ctx) => {
      const t = templateById(ctx.params.tid);
      if (!t) throw notFound('Vorlage nicht gefunden');
      return t;
    });
    /** Opens a template as a new form of this sub-account. A payment template needs one of the sub-account's products. */
    router.post('/api/forms/templates/:tid/use', 'location', (ctx) => {
      const t = templateById(ctx.params.tid);
      if (!t) throw notFound('Vorlage nicht gefunden');
      const productId = str(ctx.body?.product_id, 'Produkt', { max: 60 });
      if (t.needs_product) {
        if (!productId) throw bad('Bitte ein Produkt wählen, das bezahlt werden soll');
        if (!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', productId, ctx.locationId)) throw bad('Produkt nicht gefunden');
      }
      const draft = t.fields.map((f) => (f.type === 'payment' ? { ...f, product_id: productId } : { ...f }));
      const settings = { submit_text: 'Absenden', thank_you: 'Danke! Wir melden uns in Kürze.', tags: [], notify_team: true, ...t.settings, mode: t.mode };
      const fields = cleanFields(draft, { mode: t.mode, productOk: (pid) => !!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', pid, ctx.locationId) });
      const cleaned = cleanFormSettings(settings, fields);
      if (cleaned.theme) cleaned.theme = cleanTheme(cleaned.theme);
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body?.name, 'Name', { max: 120 }) || t.name, kind: t.kind, fields, settings: cleaned, created_at: now(), updated_at: now() };
      db.insert('forms', row);
      return { id: row.id, name: row.name, url: `${app.baseUrl()}/f/${row.id}` };
    });

    // --- themes ----------------------------------------------------------------------------------------------------------------------------
    router.get('/api/forms/themes', 'location', () => ({
      presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, theme: { preset: key, ...p.theme } })),
      fonts: Object.entries(FONTS).map(([key, f]) => ({ key, label: f.label })),
    }));

    // --- Cloudflare Turnstile ----------------------------------------------------------------------------------------------------------------
    const status = (loc: string) => {
      const row = db.get<{ site_key: string; hint: string; updated_at: string }>('SELECT site_key, hint, updated_at FROM form_captcha WHERE location_id = ?', loc);
      return { configured: !!captchaKeys(app, loc), site_key: row?.site_key ?? '', secret_hint: row?.hint ?? '', updated_at: row?.updated_at ?? null, forms: db.all<any>('SELECT settings FROM forms WHERE location_id = ?', loc).filter((f) => (parseJson(f, ['settings']) as any).settings?.captcha?.enabled).length };
    };
    router.get('/api/forms/captcha', 'location', (ctx) => status(ctx.locationId));
    router.put('/api/forms/captcha', 'location', (ctx) => {
      const site = str(ctx.body?.site_key, 'Site Key', { required: true, max: 200 });
      const secret = str(ctx.body?.secret_key, 'Secret Key', { max: 200 });
      if (!KEY.test(site)) throw bad('Der Site Key sieht nicht richtig aus (er steht im Cloudflare-Dashboard unter Turnstile)');
      const cur = db.get<{ secret_sealed: string; hint: string }>('SELECT secret_sealed, hint FROM form_captcha WHERE location_id = ?', ctx.locationId);
      if (!secret && !cur) throw bad('Bitte auch den Secret Key eintragen');
      if (secret && !KEY.test(secret)) throw bad('Der Secret Key sieht nicht richtig aus');
      db.run(
        'INSERT INTO form_captcha (location_id, site_key, secret_sealed, hint, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET site_key = excluded.site_key, secret_sealed = excluded.secret_sealed, hint = excluded.hint, updated_at = excluded.updated_at',
        ctx.locationId,
        site,
        secret ? sealSecret(app, secret) : cur!.secret_sealed,
        secret ? hint(secret) : cur!.hint,
        now(),
      );
      return status(ctx.locationId);
    });
    /** Without keys no form can be protected: switching the keys off switches the protection off on every form. */
    router.delete('/api/forms/captcha', 'location', (ctx) => {
      db.tx(() => {
        db.run('DELETE FROM form_captcha WHERE location_id = ?', ctx.locationId);
        for (const f of db.all<any>('SELECT id, settings FROM forms WHERE location_id = ?', ctx.locationId)) {
          const s = (parseJson(f, ['settings']) as any).settings ?? {};
          if (s.captcha?.enabled) db.run('UPDATE forms SET settings = ? WHERE id = ?', JSON.stringify({ ...s, captcha: { enabled: false } }), f.id);
        }
      });
      return status(ctx.locationId);
    });
  },
};
