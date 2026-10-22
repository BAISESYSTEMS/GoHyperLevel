import type { App } from './core/app.js';
import { createLocation } from './modules/core.js';
import { hashPassword, id, now } from './core/util.js';

/**
 * With PGHL_ADMIN_EMAIL and PGHL_ADMIN_PASSWORD set, the first start creates the admin and a
 * first sub-account, so a server can come up without anyone visiting the setup page.
 */
export function bootstrapAdmin(app: App, env: NodeJS.ProcessEnv) {
  const email = env.PGHL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.PGHL_ADMIN_PASSWORD;
  if (!email || !password || app.db.get('SELECT id FROM users LIMIT 1')) return;
  if (password.length < 8) {
    console.warn('PGHL_ADMIN_PASSWORD braucht mindestens 8 Zeichen – übersprungen');
    return;
  }
  app.db.insert('users', { id: id(), email, name: env.PGHL_ADMIN_NAME || email, password_hash: hashPassword(password), role: 'admin', locations: [], created_at: now() });
  createLocation(app.db, env.PGHL_COMPANY_NAME || 'Meine Firma', env.PGHL_TIMEZONE || 'Europe/Berlin');
  console.log(`Admin ${email} angelegt.`);
}
