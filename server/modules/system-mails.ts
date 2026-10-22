import type { App, Module } from '../core/app.js';
import { bad, notFound, str } from '../core/http.js';
import { render } from '../core/template.js';
import { now } from '../core/util.js';

/**
 * Eigene Texte für System-Mails – docs/saas.md#system-mails. The agency rewrites subject and text of the mails the system sends to
 * people (invitation, sign-in link, SaaS welcome with "set your password", new account). Each sender passes its built-in text and
 * the values; `app.services.systemMail(key, fallback, vars)` returns the agency's version (merge fields like `{{brand.name}}`,
 * `{{link}}`) or the built-in one. The link must stay in the text, so a custom text can never lock people out.
 */

export const SYSTEM_MAILS: Record<string, { label: string; vars: string[]; subject: string; body: string }> = {
  invite: {
    label: 'Einladung (Anmelde-Link)',
    vars: ['brand.name', 'link', 'days'],
    subject: 'Einladung zu {{brand.name}}',
    body: 'Hallo,\n\ndu bist zu {{brand.name}} eingeladen. Mit diesem Link meldest du dich an ({{days}} Tage gültig, einmal nutzbar):\n{{link}}\n\nViele Grüße\n{{brand.name}}',
  },
  magic_login: {
    label: 'Anmelde-Link per E-Mail',
    vars: ['brand.name', 'link', 'user.name'],
    subject: 'Dein Anmelde-Link für {{brand.name}}',
    body: 'Hallo {{user.name}},\n\nhier ist dein Anmelde-Link für {{brand.name}}. Er gilt 15 Minuten und nur einmal:\n{{link}}\n\nDu hast keinen Link angefordert? Dann ignoriere diese E-Mail einfach.\n\n{{brand.name}}',
  },
  saas_welcome: {
    label: 'SaaS: Willkommen & Passwort festlegen',
    vars: ['brand.name', 'link', 'user.name', 'user.email', 'location.name', 'plan.name', 'days', 'app_url', 'brand.support_email'],
    subject: 'Willkommen bei {{brand.name}} – lege dein Passwort fest',
    body: 'Hallo {{user.name}},\n\ndein Konto „{{location.name}}“ bei {{brand.name}} ist bereit (Tarif „{{plan.name}}“).\n\nLege hier dein Passwort fest – der Link ist {{days}} Tage gültig:\n{{link}}\n\nDanach meldest du dich unter {{app_url}} mit {{user.email}} an.\n\nViele Grüße\n{{brand.name}}',
  },
  saas_new_account: {
    label: 'SaaS: weiteres Konto für bestehende Person',
    vars: ['brand.name', 'link', 'user.name', 'location.name', 'plan.name'],
    subject: 'Dein neues Konto bei {{brand.name}}',
    body: 'Hallo {{user.name}},\n\ndein neues Konto „{{location.name}}“ bei {{brand.name}} ist bereit (Tarif „{{plan.name}}“). Du findest es nach dem Login unter {{link}}.\n\nViele Grüße\n{{brand.name}}',
  },
};

export const systemMailsModule: Module = {
  name: 'system-mails',
  migrations: [['001-init', `CREATE TABLE system_mail_texts (key TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);`]],
  register(app: App) {
    const { db, router } = app;
    const custom = (key: string) => db.get<{ subject: string; body: string; updated_at: string }>('SELECT subject, body, updated_at FROM system_mail_texts WHERE key = ?', key);

    /** The agency's text for a system mail, or the sender's built-in one. Values are plain text (the senders escape for HTML). */
    app.services.systemMail = (key: string, fallback: { subject: string; text: string }, vars: Record<string, unknown>) => {
      const c = custom(key);
      if (!c) return fallback;
      try {
        const subject = render(c.subject, vars).replace(/[\r\n]+/g, ' ').trim();
        const text = render(c.body, vars);
        // Without the link the mail would be useless – then the built-in text goes out.
        return subject && vars.link && text.includes(String(vars.link)) ? { subject, text } : fallback;
      } catch {
        return fallback;
      }
    };

    router.get('/api/agency/system-mails', 'admin', () =>
      Object.entries(SYSTEM_MAILS).map(([key, d]) => {
        const c = custom(key);
        return { key, label: d.label, vars: d.vars, default_subject: d.subject, default_body: d.body, subject: c?.subject ?? '', body: c?.body ?? '', custom: !!c, updated_at: c?.updated_at ?? null };
      }),
    );
    router.put('/api/agency/system-mails/:key', 'admin', (ctx) => {
      const d = SYSTEM_MAILS[ctx.params.key];
      if (!d) throw notFound('Unbekannte System-Mail');
      const subject = str(ctx.body?.subject, 'Betreff', { required: true, max: 200 });
      const body = str(ctx.body?.body, 'Text', { required: true, max: 5000 });
      if (!/\{\{\s*link\s*\}\}/.test(body)) throw bad('Der Text muss {{link}} enthalten – sonst kann sich niemand anmelden');
      db.run('INSERT INTO system_mail_texts (key, subject, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at', ctx.params.key, subject, body, now());
      return { ok: true };
    });
    router.delete('/api/agency/system-mails/:key', 'admin', (ctx) => {
      db.run('DELETE FROM system_mail_texts WHERE key = ?', ctx.params.key);
      return { ok: true };
    });
  },
};
