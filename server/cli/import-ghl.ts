/**
 * Pull a GoHighLevel sub-account into HyperLevel from the command line:
 *
 *   GHL_TOKEN=pit-… npm run import:ghl -- [ghlLocationId] [targetLocationId]
 *
 * Without ids it lists what the token can see. The token is never stored.
 */
import { createApp } from '../core/app.js';
import { loadConfig } from '../config.js';
import { MODULES } from '../modules/index.js';
import { GhlClient, IMPORT_PARTS, importFromGhl, probeGhl } from '../services/ghl-import.js';

const token = process.env.GHL_TOKEN;
if (!token) {
  console.error('GHL_TOKEN fehlt (Private Integration Token aus GHL → Einstellungen → Private Integrations)');
  process.exit(1);
}
const [ghlLoc, target] = process.argv.slice(2);
const client = new GhlClient(token);
const probe = await probeGhl(client, ghlLoc);
console.log('GHL-Locations:', probe.locations.map((l) => `${l.id} (${l.name})`).join(', ') || '–');
console.log('Zugriff:', probe.scopes);
if (!ghlLoc) process.exit(0);

const instance = createApp({ ...loadConfig(), tickMs: 0 }, MODULES);
const loc = target ?? instance.app.db.get('SELECT id FROM locations ORDER BY created_at LIMIT 1')?.id;
if (!loc) {
  console.error('Kein Sub-Account in HyperLevel – erst einrichten (npm start, Browser öffnen).');
  process.exit(1);
}
const progress = await importFromGhl(instance.app, loc, client, ghlLoc, [...IMPORT_PARTS]);
console.log(progress.log.join('\n'));
console.log('Ergebnis:', progress.counts);
instance.app.db.close();
