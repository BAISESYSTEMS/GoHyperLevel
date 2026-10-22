/**
 * Fills a fresh HyperLevel install with fictional demo data (the agency „Nordlicht Digital“ and five client
 * sub-accounts with contacts, deals, inbox, calendar, invoices, store orders, projects, reviews, tickets, a course,
 * a community …) – for screenshots, trying it out and the public demo. Takes a few seconds.
 *
 *   npm run demo:seed                         # uses PGHL_DATA_DIR (default ./data) – must be empty
 *   npm run demo:seed -- --data-dir ./demo    # another folder
 *   npm run demo:seed -- --reset              # wipe an existing DEMO database first
 *
 * Nothing is sent while seeding: outgoing connections are blocked for the whole run. Afterwards
 * start the app on the same folder (PGHL_DATA_DIR=… npm start) and sign in with the printed login.
 * For a public instance use PGHL_DEMO_MODE=1 instead – it seeds and resets by itself.
 */
import { resolve } from 'node:path';
import { createApp } from '../server/core/app.js';
import { loadConfig } from '../server/config.js';
import { MODULES } from '../server/modules/index.js';
import { demoCredentials, wipeData } from '../server/modules/demo.js';
import { seedDemo } from '../server/services/demo-seed.js';
import { blockedConnections, installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('help') || flag('h')) {
  console.log('Usage: npm run demo:seed -- [--data-dir <folder>] [--reset]');
  process.exit(0);
}

const env = { ...process.env, PGHL_DEMO_MODE: '0', ...(value('data-dir') ? { PGHL_DATA_DIR: resolve(value('data-dir')!) } : {}) };
const config = { ...loadConfig(env), tickMs: 0, demoMode: false };
const instance = createApp(config, MODULES);
const { app } = instance;

const hasUsers = !!app.db.get('SELECT id FROM users LIMIT 1');
const wasDemo = !!app.db.get(`SELECT value FROM demo_state WHERE key = 'seeded_at'`);
if (hasUsers && !(flag('reset') && wasDemo)) {
  console.error(
    hasUsers && !wasDemo
      ? `${config.dataDir} enthält schon echte Daten – Demo-Daten nur in einen leeren Datenordner (z. B. --data-dir ./demo-data).`
      : `${config.dataDir} enthält schon Demo-Daten – mit --reset neu anlegen.`,
  );
  await instance.close();
  process.exit(1);
}

installOutboundGuard();
try {
  if (hasUsers) wipeData(app);
  const result = await seedDemo(app, demoCredentials());
  app.db.run(`INSERT INTO demo_state (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, new Date().toISOString());
  const count = (t: string) => Number(app.db.get(`SELECT COUNT(*) n FROM ${t}`)?.n ?? 0);
  console.log(`Demo-Daten in ${config.dataDir}`);
  console.log(`  Login: ${result.email} / ${result.password}`);
  console.log(`  Sub-Accounts: ${result.locations.map((l) => l.name).join(', ')}`);
  console.log(`  ${count('contacts')} Kontakte, ${count('opportunities')} Deals, ${count('appointments')} Termine, ${count('messages')} Nachrichten, ${count('invoices')} Rechnungen, ${count('tickets')} Tickets`);
  console.log(`  ${result.ok} Schritte${result.failed.length ? `, ${result.failed.length} übersprungen:` : ''}`);
  for (const f of result.failed) console.log(`    - ${f}`);
  if (blockedConnections().length) console.log(`  ${blockedConnections().length} Verbindungen nach außen blockiert (nichts wurde verschickt).`);
  console.log(`Starten: PGHL_DATA_DIR=${config.dataDir} npm start`);
} finally {
  uninstallOutboundGuard();
  await instance.close();
}
