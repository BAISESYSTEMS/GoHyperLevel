import type { XrDevice } from './detect';

/**
 * How to put HyperLevel on the home screen of each headset (a PWA: its own window, no browser bars, push where the device has it).
 * Only what is stable across releases is written down; menu names differ a little between software versions – docs/xr.md.
 */

export interface InstallHint {
  id: XrDevice | 'glasses';
  title: string;
  steps: string[];
}

export const INSTALL_HINTS: InstallHint[] = [
  {
    id: 'visionos',
    title: 'Apple Vision Pro (Safari)',
    steps: ['HyperLevel in Safari öffnen und anmelden.', 'Teilen-Symbol → „Zum Home-Bildschirm“ (Home-Ansicht).', 'Die App öffnet danach als eigenes Fenster; Blick und Pinch bedienen alles, der Raum-Modus schaltet sich von selbst ein.'],
  },
  {
    id: 'quest',
    title: 'Meta Quest (Meta Horizon Browser)',
    steps: ['HyperLevel im Browser öffnen und anmelden.', 'Browser-Menü (⋮) → „App installieren“.', 'Die App startet danach aus der Bibliothek in einem eigenen Fenster. „In XR öffnen“ auf einem Board startet die immersive Ansicht.'],
  },
  {
    id: 'android-xr',
    title: 'Android XR (Chrome)',
    steps: ['HyperLevel in Chrome öffnen und anmelden.', 'Menü (⋮) → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.', 'Die App öffnet als Fenster im Raum; „In XR öffnen“ nutzt WebXR.'],
  },
  {
    id: 'glasses',
    title: 'Display-Brillen (Xreal, Viture …)',
    steps: ['Die Brille verhält sich wie ein großer externer Bildschirm: HyperLevel läuft wie gewohnt auf Handy, Mac oder PC.', 'Für 21:9 und 32:9 die Arbeitsfläche öffnen: Posteingang, Kontakt, Board und Agent nebeneinander.', 'Raum-Modus unter Einstellungen → Darstellung einschalten, wenn du mit Handy-Touchpad oder Maus aus der Entfernung arbeitest.'],
  },
];

export const hintFor = (device: XrDevice | null) => INSTALL_HINTS.find((h) => h.id === (device === 'pico' || device === 'wolvic' ? 'quest' : device)) ?? null;
