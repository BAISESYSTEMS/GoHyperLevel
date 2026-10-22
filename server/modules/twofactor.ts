import QRCode from 'qrcode';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { isSealed, openIfSealed, sealSecret } from '../core/secrets.js';
import { sha256, token, verifyPasswordAsync } from '../core/util.js';
import { newSecret, otpauthUri, verifyTotp } from '../services/totp.js';
import { getBranding } from './agency.js';

/**
 * Two-factor login with an authenticator app (TOTP) plus one-time backup codes.
 * The login route asks app.services.secondFactor before it starts a session.
 */

function backupCodes(): string[] {
  return Array.from({ length: 8 }, () => token(8).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase().padEnd(8, '0'));
}

/** 'ok' (no 2FA or right code), 'needed' (code missing) or 'invalid'. */
export function checkSecondFactor(app: App, u: any, code: unknown): 'ok' | 'needed' | 'invalid' {
  if (!u.totp_enabled) return 'ok';
  const c = String(code ?? '').trim().toLowerCase().replace(/\s|-/g, '');
  if (!c) return 'needed';
  if (/^\d{6}$/.test(c)) {
    // The secret is stored sealed; one from before sealing is sealed on first use.
    if (u.totp_secret && !isSealed(u.totp_secret)) app.db.run('UPDATE users SET totp_secret = ? WHERE id = ?', sealSecret(app, u.totp_secret), u.id);
    const counter = verifyTotp(openIfSealed(app, u.totp_secret), c);
    // A code works once: replaying the same (or an older) step is refused.
    if (counter !== null && counter > (u.totp_last ?? 0)) {
      app.db.run('UPDATE users SET totp_last = ? WHERE id = ?', counter, u.id);
      return 'ok';
    }
    return 'invalid';
  }
  const codes: string[] = JSON.parse(u.totp_backup || '[]');
  const i = codes.indexOf(sha256(c));
  if (i < 0) return 'invalid';
  codes.splice(i, 1);
  app.db.run('UPDATE users SET totp_backup = ? WHERE id = ?', JSON.stringify(codes), u.id);
  return 'ok';
}

export const twofactorModule: Module = {
  name: 'twofactor',
  migrations: [
    [
      '001-init',
      `ALTER TABLE users ADD COLUMN totp_secret TEXT;
       ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
       ALTER TABLE users ADD COLUMN totp_last INTEGER;
       ALTER TABLE users ADD COLUMN totp_backup TEXT;`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.secondFactor = (u: any, code: unknown) => checkSecondFactor(app, u, code);
    const userRow = (id: string) => db.get('SELECT * FROM users WHERE id = ?', id)!;
    const newBackup = (userId: string) => {
      const codes = backupCodes();
      db.run('UPDATE users SET totp_backup = ? WHERE id = ?', JSON.stringify(codes.map(sha256)), userId);
      return codes;
    };

    router.get('/api/me/2fa', 'user', (ctx) => {
      const u = userRow(ctx.user!.id);
      return { enabled: !!u.totp_enabled, backup_left: JSON.parse(u.totp_backup || '[]').length };
    });
    router.post('/api/me/2fa/setup', 'user', async (ctx) => {
      const u = userRow(ctx.user!.id);
      if (u.totp_enabled) throw bad('2FA ist schon aktiv');
      const secret = newSecret();
      db.run('UPDATE users SET totp_secret = ? WHERE id = ?', sealSecret(app, secret), u.id);
      const uri = otpauthUri(secret, u.email, getBranding(app).name);
      return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    });
    router.post('/api/me/2fa/enable', 'user', (ctx) => {
      const u = userRow(ctx.user!.id);
      if (!u.totp_secret) throw bad('Erst einrichten');
      const counter = verifyTotp(openIfSealed(app, u.totp_secret), String(ctx.body.code ?? ''));
      if (counter === null) throw bad('Code stimmt nicht – Uhrzeit am Handy prüfen und neuen Code eingeben');
      db.run('UPDATE users SET totp_enabled = 1, totp_last = ? WHERE id = ?', counter, u.id);
      return { enabled: true, backup_codes: newBackup(u.id) };
    });
    router.post('/api/me/2fa/backup-codes', 'user', (ctx) => {
      const u = userRow(ctx.user!.id);
      if (!u.totp_enabled) throw bad('2FA ist nicht aktiv');
      if (checkSecondFactor(app, u, ctx.body.code) !== 'ok') throw new HttpError(401, 'Code falsch');
      return { backup_codes: newBackup(u.id) };
    });
    router.post('/api/me/2fa/disable', 'user', async (ctx) => {
      const u = userRow(ctx.user!.id);
      if (!(await verifyPasswordAsync(String(ctx.body.password ?? '').slice(0, 1024), u.password_hash))) throw new HttpError(401, 'Passwort falsch');
      if (u.totp_enabled && checkSecondFactor(app, u, ctx.body.code) !== 'ok') throw new HttpError(401, 'Code falsch');
      db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup = NULL, totp_last = NULL WHERE id = ?', u.id);
      return { enabled: false };
    });
    // For a team member who lost their phone.
    router.post('/api/users/:id/2fa/reset', 'admin', (ctx) => {
      if (!db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup = NULL, totp_last = NULL WHERE id = ?', ctx.params.id).changes) throw notFound();
      return { ok: true };
    });
  },
};
