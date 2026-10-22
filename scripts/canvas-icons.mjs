#!/usr/bin/env node
/**
 * Generates server/services/canvas-icons.ts – the icon set of the Canvas (icon elements, CRM cards):
 * a curated part of the app's own icon set (Lucide, ISC licence) as plain data, so the server can draw
 * icons in SVG/PDF/PNG exports without the browser package. Dev-only:
 *
 *   node scripts/canvas-icons.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'node_modules/lucide-react/dist/esm/icons');
const version = JSON.parse(readFileSync(join(root, 'node_modules/lucide-react/package.json'), 'utf8')).version;

/** [lucide name, German label, extra search words] */
const ICONS = [
  ['user', 'Person', 'kontakt kunde'],
  ['users', 'Team', 'gruppe kontakte'],
  ['user-plus', 'Neuer Kontakt', 'lead'],
  ['users-round', 'Community', 'gruppe'],
  ['building-2', 'Firma', 'unternehmen büro'],
  ['briefcase', 'Deal', 'geschäft job'],
  ['handshake', 'Abschluss', 'partner deal'],
  ['mail', 'E-Mail', 'nachricht brief'],
  ['phone', 'Telefon', 'anruf'],
  ['message-circle', 'Chat', 'nachricht'],
  ['message-square', 'Kommentar', 'nachricht'],
  ['send', 'Senden', 'versand'],
  ['megaphone', 'Kampagne', 'marketing ankündigung'],
  ['bell', 'Benachrichtigung', 'alarm'],
  ['calendar-days', 'Kalender', 'termin datum'],
  ['clock', 'Uhr', 'zeit'],
  ['timer', 'Timer', 'zeit stoppuhr'],
  ['hourglass', 'Warten', 'zeit sanduhr'],
  ['square-check-big', 'Aufgabe', 'todo erledigt'],
  ['list-checks', 'Checkliste', 'liste'],
  ['check', 'Haken', 'ok ja'],
  ['x', 'Kreuz', 'nein schließen'],
  ['circle-check', 'Erledigt', 'ok'],
  ['circle-x', 'Fehler', 'abgelehnt'],
  ['circle-help', 'Frage', 'hilfe'],
  ['circle-alert', 'Hinweis', 'achtung'],
  ['triangle-alert', 'Warnung', 'achtung risiko'],
  ['info', 'Info', 'information'],
  ['star', 'Stern', 'bewertung favorit'],
  ['heart', 'Herz', 'like'],
  ['thumbs-up', 'Daumen hoch', 'like gut'],
  ['thumbs-down', 'Daumen runter', 'schlecht'],
  ['smile', 'Zufrieden', 'emoji glücklich'],
  ['frown', 'Unzufrieden', 'emoji traurig'],
  ['rocket', 'Start', 'launch rakete'],
  ['target', 'Ziel', 'zielgruppe'],
  ['zap', 'Auslöser', 'blitz trigger'],
  ['lightbulb', 'Idee', 'glühbirne'],
  ['sparkles', 'KI', 'magie neu'],
  ['bot', 'Bot', 'ki agent'],
  ['flag', 'Meilenstein', 'flagge'],
  ['trophy', 'Erfolg', 'pokal gewinner'],
  ['award', 'Auszeichnung', 'preis'],
  ['gift', 'Geschenk', 'bonus'],
  ['tag', 'Tag', 'etikett preis'],
  ['percent', 'Rabatt', 'prozent'],
  ['euro', 'Euro', 'geld preis umsatz'],
  ['credit-card', 'Zahlung', 'karte bezahlen'],
  ['wallet', 'Geldbörse', 'geld'],
  ['piggy-bank', 'Sparen', 'budget'],
  ['receipt', 'Rechnung', 'beleg'],
  ['shopping-cart', 'Warenkorb', 'shop kaufen'],
  ['store', 'Laden', 'shop geschäft'],
  ['package', 'Produkt', 'paket'],
  ['truck', 'Lieferung', 'versand'],
  ['ticket', 'Ticket', 'support'],
  ['headset', 'Support', 'service'],
  ['chart-column', 'Balken', 'statistik bericht'],
  ['chart-pie', 'Torte', 'statistik bericht'],
  ['trending-up', 'Wachstum', 'steigend'],
  ['trending-down', 'Rückgang', 'fallend'],
  ['layout-dashboard', 'Dashboard', 'übersicht'],
  ['kanban', 'Kanban', 'board pipeline'],
  ['folder-kanban', 'Projekt', 'board'],
  ['workflow', 'Workflow', 'automation prozess'],
  ['git-branch', 'Verzweigung', 'branch'],
  ['layers', 'Ebenen', 'stapel'],
  ['puzzle', 'Integration', 'puzzle teil'],
  ['settings', 'Einstellungen', 'zahnrad'],
  ['wrench', 'Werkzeug', 'reparatur'],
  ['hammer', 'Bauen', 'werkzeug'],
  ['lock', 'Schloss', 'sicher privat'],
  ['key-round', 'Schlüssel', 'zugang'],
  ['shield-check', 'Sicherheit', 'schutz'],
  ['cloud', 'Cloud', 'wolke'],
  ['database', 'Datenbank', 'daten'],
  ['server', 'Server', 'hosting'],
  ['code', 'Code', 'entwicklung'],
  ['terminal', 'Terminal', 'konsole'],
  ['bug', 'Bug', 'fehler'],
  ['smartphone', 'Smartphone', 'handy mobil'],
  ['laptop', 'Laptop', 'computer'],
  ['monitor', 'Bildschirm', 'desktop'],
  ['globe', 'Website', 'web welt'],
  ['wifi', 'WLAN', 'internet'],
  ['link', 'Link', 'verknüpfung'],
  ['share-2', 'Teilen', 'social'],
  ['qr-code', 'QR-Code', 'scan'],
  ['mouse-pointer-click', 'Klick', 'cursor'],
  ['search', 'Suche', 'lupe'],
  ['filter', 'Filter', 'trichter'],
  ['plus', 'Plus', 'hinzufügen'],
  ['minus', 'Minus', 'entfernen'],
  ['arrow-right', 'Pfeil rechts', 'weiter'],
  ['arrow-left', 'Pfeil links', 'zurück'],
  ['arrow-up', 'Pfeil hoch', 'oben'],
  ['arrow-down', 'Pfeil runter', 'unten'],
  ['refresh-cw', 'Wiederholen', 'aktualisieren schleife'],
  ['download', 'Download', 'herunterladen'],
  ['upload', 'Upload', 'hochladen'],
  ['file-text', 'Dokument', 'datei text'],
  ['folder', 'Ordner', 'dateien'],
  ['image', 'Bild', 'foto'],
  ['camera', 'Kamera', 'foto'],
  ['video', 'Video', 'film'],
  ['play', 'Abspielen', 'video start'],
  ['pause', 'Pause', 'stopp'],
  ['mic', 'Mikrofon', 'audio podcast'],
  ['book-open', 'Buch', 'wissen lesen'],
  ['graduation-cap', 'Kurs', 'lernen schule'],
  ['house', 'Start', 'home haus'],
  ['map-pin', 'Standort', 'ort karte'],
  ['map', 'Karte', 'route'],
  ['compass', 'Kompass', 'orientierung'],
  ['coffee', 'Kaffee', 'pause meeting'],
  ['sun', 'Sonne', 'tag hell'],
  ['moon', 'Mond', 'nacht dunkel'],
  ['pen-tool', 'Design', 'stift vektor'],
  ['palette', 'Farben', 'design'],
  ['brush', 'Pinsel', 'design malen'],
];

const out = {};
const missing = [];
for (const [name] of ICONS) {
  let src;
  try {
    src = readFileSync(join(dir, `${name}.mjs`), 'utf8');
    // renamed icons re-export their new name
    for (let hop = 0; hop < 3; hop++) {
      const alias = src.match(/export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/);
      if (!alias) break;
      src = readFileSync(join(dir, `${alias[1]}.mjs`), 'utf8');
    }
  } catch {
    missing.push(name);
    continue;
  }
  const m = src.match(/const __iconData = (\{[\s\S]*?\n\});/);
  if (!m) {
    missing.push(name);
    continue;
  }
  // The data is a plain JS literal ({name, node: [[tag, {attrs}] …]}) – evaluate it in isolation.
  const { node } = Function(`"use strict"; return (${m[1]});`)();
  out[name] = node.map(([tag, attrs]) => {
    const { key: _k, ...rest } = attrs;
    return [tag, rest];
  });
}
if (missing.length) console.warn('missing:', missing.join(', '));

const lines = [
  '/**',
  ` * Icon set of the Canvas: a curated part of Lucide ${version} (ISC licence, https://lucide.dev – see NOTICE),`,
  ' * generated by scripts/canvas-icons.mjs. Every icon is drawn on a 24×24 grid with round caps, no fill.',
  ' * Static data only – the renderer never draws user-supplied SVG.',
  ' */',
  '',
  'export type IconNode = [tag: string, attrs: Record<string, string | number>][];',
  '',
  '/** name → [German label, search words, shapes] */',
  'export const CANVAS_ICONS: Record<string, [string, string, IconNode]> = {',
  ...ICONS.filter(([n]) => out[n]).map(([n, label, words]) => `  '${n}': [${JSON.stringify(label)}, ${JSON.stringify(words)}, ${JSON.stringify(out[n])}],`),
  '};',
  '',
];
writeFileSync(join(root, 'server/services/canvas-icons.ts'), lines.join('\n'));
console.log(`wrote ${Object.keys(out).length} icons`);
