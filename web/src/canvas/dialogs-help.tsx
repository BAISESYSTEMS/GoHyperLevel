import { Modal } from '../ui';
import type { DialogProps } from './dialogs';

/** Keyboard and mouse reference ("?" on the board). */

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Werkzeuge',
    rows: [
      ['V', 'Auswählen'],
      ['H oder Leertaste + Ziehen', 'Board verschieben'],
      ['Q oder Strg + Ziehen', 'Lasso-Auswahl'],
      ['R · O · D', 'Rechteck · Ellipse · Raute'],
      ['A · L', 'Pfeil · Linie'],
      ['P', 'Stift'],
      ['T · S', 'Text · Notiz'],
      ['F', 'Rahmen / Artboard'],
      ['I', 'Bild einfügen'],
      ['C', 'Kommentar setzen'],
      ['X', 'Radierer'],
      ['K', 'KI zeichnen lassen'],
    ],
  },
  {
    title: 'Ansicht',
    rows: [
      ['Mausrad / Zwei Finger', 'Verschieben'],
      ['Strg + Mausrad / Zwei Finger spreizen', 'Zoomen'],
      ['Strg + 0', 'Zoom 100 %'],
      ['Strg + + / Strg + −', 'Vergrößern / Verkleinern'],
      ['⇧ 1', 'Alles einpassen'],
      ['⇧ 2', 'Auswahl einpassen'],
    ],
  },
  {
    title: 'Bearbeiten',
    rows: [
      ['Strg + Z / Strg + ⇧ + Z', 'Rückgängig / Wiederholen'],
      ['Strg + C / X / V', 'Kopieren / Ausschneiden / Einfügen (auch Bilder aus der Zwischenablage)'],
      ['Strg + D oder Alt + Ziehen', 'Duplizieren'],
      ['Strg + A', 'Alles auswählen'],
      ['Strg + G / Strg + ⇧ + G', 'Gruppieren / Gruppierung aufheben'],
      ['Strg + L', 'Sperren / Entsperren'],
      ['Entf', 'Löschen'],
      ['Pfeiltasten (⇧ = 10 px)', 'Auswahl verschieben'],
      ['Enter oder Doppelklick', 'Text bearbeiten'],
      ['] / [ (mit Strg: ganz)', 'Nach vorne / hinten'],
      ['⇧ beim Ziehen', 'Seitenverhältnis halten · Linien in 45°-Schritten'],
      ['Alt beim Ziehen', 'Vom Mittelpunkt aus · ohne Einrasten'],
    ],
  },
];

export function ShortcutsDialog({ onClose }: DialogProps) {
  return (
    <Modal title="Tastenkürzel" onClose={onClose} wide>
      <div className="cv-keys">
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <h3>{s.title}</h3>
            <dl>
              {s.rows.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted small">Auf Mac gilt ⌘ statt Strg. Mit Maus: Rechtsklick öffnet das Kontextmenü, Doppelklick auf eine freie Stelle legt einen Text an.</p>
    </Modal>
  );
}
