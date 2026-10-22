import type { Module } from '../core/app.js';
import { bad } from '../core/http.js';

/**
 * Sprache der Oberfläche (i18n, Phase 1 – docs/translating.md): die Wahl jeder Person am Benutzer, die Browser-Sprache
 * (Accept-Language) als Vorgabe für Anmeldeseite und alle, die nichts gewählt haben.
 *
 *   GET /api/language          public – { lang, locales }: die Sprache, die der Browser verlangt (Accept-Language)
 *   GET /api/me/language       user   – { lang: gewählt oder null, auto: aus Accept-Language }
 *   PUT /api/me/language       user   – { lang: 'de' | 'en' | null }  (null = wieder der Browser-Sprache folgen)
 *
 * GET /api/me trägt `user.lang` (über app.services.meFields), damit die App ohne zweite Anfrage in der richtigen Sprache startet.
 * Die Texte selbst liegen in der App (web/src/i18n); der Server antwortet weiter auf Deutsch.
 */

export const UI_LOCALES = ['de', 'en'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
const DEFAULT: UiLocale = 'de';
const isUiLocale = (v: unknown): v is UiLocale => typeof v === 'string' && (UI_LOCALES as readonly string[]).includes(v);

/** `en-US,en;q=0.9,de;q=0.8` → the supported language with the highest weight (ties: order of the header); German when none. */
export function pickLocale(header: string | string[] | undefined): UiLocale {
  const raw = (Array.isArray(header) ? header.join(',') : (header ?? '')).slice(0, 1000);
  const ranked = raw
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([01](?:\.\d{1,3})?)\s*$/.exec(p)?.[1]).find(Boolean);
      return { base: tag.trim().toLowerCase().split(/[-_]/)[0], q: q === undefined ? 1 : Number(q), i };
    })
    .filter((x) => x.base && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const hit = ranked.find((x) => isUiLocale(x.base));
  return hit ? (hit.base as UiLocale) : DEFAULT;
}

export const languageModule: Module = {
  name: 'language',
  migrations: [['001-user-lang', `ALTER TABLE users ADD COLUMN lang TEXT;`]],
  register(app) {
    const { router, db } = app;
    const saved = (userId: string): UiLocale | null => {
      const v = db.get<{ lang: string | null }>('SELECT lang FROM users WHERE id = ?', userId)?.lang;
      return isUiLocale(v) ? v : null;
    };

    // /api/me answers with the saved language, so the app starts in it without another request.
    app.services.meFields = [...(app.services.meFields ?? []), (user: { id: string }) => ({ lang: saved(user.id) })];

    router.get('/api/language', 'public', (ctx) => ({ lang: pickLocale(ctx.req.headers['accept-language']), locales: UI_LOCALES }));

    router.get('/api/me/language', 'user', (ctx) => ({ lang: saved(ctx.user!.id), auto: pickLocale(ctx.req.headers['accept-language']), locales: UI_LOCALES }));

    router.put('/api/me/language', 'user', (ctx) => {
      const lang = ctx.body?.lang ?? null;
      if (lang !== null && !isUiLocale(lang)) throw bad(`Unbekannte Sprache – erlaubt: ${UI_LOCALES.join(', ')}`);
      db.run('UPDATE users SET lang = ? WHERE id = ?', lang, ctx.user!.id);
      return { lang };
    });
  },
};
