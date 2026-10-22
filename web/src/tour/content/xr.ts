import type { Tour } from '../types';

/** XR: Raum-Modus, Arbeitsfläche, Boards und Canvas im Headset. */
export const XR_TOURS: Tour[] = [
  {
    id: 'xr',
    title: 'Raum-Modus und XR: mit Blick, Pinch und Brille arbeiten',
    summary: 'Große Ziele für Vision Pro, Quest und Android XR, vier Seiten nebeneinander auf dem Riesen-Bildschirm der Brille – und Boards als schwebende Panels im Raum.',
    icon: 'glasses',
    group: 'settings',
    minutes: 5,
    routes: ['settings/appearance', 'workspace'],
    keywords: 'xr vr ar raum modus raummodus headset brille vision pro quest android xreal viture ultrawide arbeitsfläche panels webxr 3d blick pinch controller sprache sprechen board canvas',
    learned: ['Den Raum-Modus für Blick und Pinch einschalten (oder automatisch erkennen lassen)', 'Mit der Arbeitsfläche Posteingang, Kontakt, Board und Agent nebeneinander sehen', 'Ein Board oder Canvas mit „In XR öffnen“ als schwebende Panels erleben und dem Board per Sprache sagen, was du sehen willst'],
    docs: { label: 'XR: Raum-Modus, Arbeitsfläche, Boards im Headset', file: 'xr' },
    steps: [
      { title: 'Raum-Modus', route: 'settings/appearance', target: 'appearance-spatial', text: 'Für Headsets und Brillen: Alles ist mindestens 60 px groß, die Schrift größer, Schaltflächen leuchten sanft, wenn du sie anschaust, und nichts ist nur beim Darüberfahren erreichbar. Glasflächen bleiben lesbar (Kontrast AA).' },
      { title: 'Automatisch oder von Hand', target: 'spatial-auto', text: '„Automatisch“ schaltet den Raum-Modus ein, sobald ein XR-Gerät erkannt wird (Apple Vision Pro, Meta Quest, Android XR). Mit „An“ nutzt du ihn auch an einer Display-Brille oder per Handy-Touchpad aus der Ferne.' },
      { title: 'Arbeitsfläche öffnen', target: 'appearance-workspace', text: 'Für 21:9 und 32:9, zum Beispiel an Xreal oder Viture: zwei bis vier Seiten nebeneinander. Der Knopf bringt dich direkt hin; im Menü steht sie unter „Arbeitsfläche“.' },
      { title: 'Seiten nebeneinander', route: 'workspace', target: 'ws-panels', text: 'Standard ist Posteingang | Kontakt | Board | KI-Agent. Jedes Panel ist eine echte Seite der App; über den Titel wählst du eine andere. Unter 1000 px Breite siehst du die Seiten wie gewohnt einzeln.' },
      { title: 'Anzahl und Breite', target: 'ws-count', text: 'Zwei, drei oder vier Panels. Die Trenner dazwischen ziehst du mit dem Zeiger oder verschiebst sie mit den Pfeiltasten (Umschalt: größere Schritte, Doppelklick: gleich breit). Die Anordnung wird für dich gespeichert.' },
      { title: 'Auswahl verknüpfen', target: 'ws-sync', text: 'Ein Klick im Posteingang oder in der Pipeline zeigt den Kontakt sofort im Kontakt-Panel. Ein Link in einem Panel öffnet sich dort, wo diese Art Seite schon offen ist.' },
      { title: 'In XR öffnen', route: 'boards', target: 'xr-open', optional: true, missing: 'Öffne ein Board oder ein Canvas: oben steht „In XR öffnen“ (ohne WebXR „3D-Vorschau“).', text: 'Die Widgets eines Boards schweben als Panels auf einem Bogen um dich, ein Canvas hängt als große Fläche im Raum. Mit Controllern oder der Hand greifst du ein Panel und schiebst es – deine Anordnung wird gespeichert.' },
      { title: 'Sprechen im Headset', text: 'Im Headset hältst du „Sprechen“ und sagst zum Beispiel „Zeig mir die offenen Angebote“. Der Wunsch geht wie getippt an das Board; Änderungen übernimmst du mit „Übernehmen“ – gesprochen wird nie etwas bestätigt. Erlaube das Mikrofon vorher auf der Seite.' },
      { title: 'App installieren', text: 'Auf Quest, Vision Pro und Android XR öffnet sich {brand} installiert in einem eigenen Fenster – ohne Browserleisten. Die Schritte pro Gerät stehen in der Karte „Raum-Modus“ unter „App auf dem Headset installieren“.' },
    ],
  },
];
