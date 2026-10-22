/**
 * Rotates the key that protects stored secrets (SMTP passwords, API/OAuth tokens, 2FA secrets…):
 *
 *   npm run rotate-secret                 # new data key, every sealed value re-sealed (stop the server first)
 *   npm run rotate-secret -- --dry-run    # only count what would be re-sealed
 *   npm run rotate-secret -- --signing    # also a new signing secret (old unsubscribe/survey/tracking links break)
 *
 * In Docker: docker compose run --rm crm node dist-server/server/cli/rotate-secret.js
 * With PGHL_DATA_KEY in the environment nothing is written: the new key is printed for you to set.
 */
import { loadConfig } from '../config.js';
import { rotateDataKey, rotateSigningSecret } from '../services/key-rotation.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const signing = args.includes('--signing');
const keyArg = args.find((a) => a.startsWith('--key='))?.slice(6);
const cfg = loadConfig();
const keysFromEnv = !!process.env.PGHL_DATA_KEY;

const r = rotateDataKey({ dataDir: cfg.dataDir, dbFile: cfg.dbFile, secret: cfg.secret, dataKey: cfg.dataKey, previousDataKeys: cfg.previousDataKeys, newKey: keyArg, dryRun, keysFromEnv });
console.log(`${r.values} versiegelte Werte in ${r.rows} Zeilen (${r.tables.join(', ') || '–'})`);
if (r.failed.length) {
  console.error(`Abbruch – ${r.failed.length} Werte ließen sich mit den bekannten Schlüsseln nicht öffnen:\n  ${r.failed.slice(0, 20).join('\n  ')}`);
  console.error('Fehlt ein alter Schlüssel? In data.key.previous (eine Zeile je Schlüssel) oder PGHL_DATA_KEY_PREVIOUS eintragen.');
  process.exit(1);
}
if (dryRun) process.exit(0);
console.log(`Neuer Datenschlüssel aktiv (ID ${r.kid}).`);
if (keysFromEnv) {
  console.log(`\nJetzt in der Umgebung setzen und neu starten:\n  PGHL_DATA_KEY=${r.newKey}\n  PGHL_DATA_KEY_PREVIOUS=${[cfg.dataKey, ...(cfg.previousDataKeys ?? [])].filter(Boolean).join(',')}`);
} else console.log(`Gespeichert in ${cfg.dataDir}/data.key (alter Schlüssel in data.key.previous).`);
if (signing) {
  if (process.env.PGHL_SECRET) console.log('\nPGHL_SECRET kommt aus der Umgebung: neuen Wert selbst setzen (z. B. openssl rand -hex 32).');
  else {
    const s = rotateSigningSecret(cfg.dataDir);
    console.log(`\nNeues Signatur-Geheimnis in ${s.file} (Sicherung: ${s.backup}). Alte Abmelde-, Umfrage- und Tracking-Links funktionieren nicht mehr.`);
  }
}
