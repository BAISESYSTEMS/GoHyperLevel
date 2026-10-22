import { DEFAULT_SETTINGS, newBlock, newSection, type EmailDesign, type EmailSettings, type Section } from './email-render.js';

/** Starter designs for the email builder (shared by the editor and GET /api/email-builder/starters). */

const design = (sections: Section[], settings: Partial<EmailSettings> = {}): EmailDesign => ({ version: 1, settings: { ...DEFAULT_SETTINGS, ...settings }, sections });
const footer = () => newSection(1, [[newBlock('footer')]]);
const logo = () => newSection(1, [[newBlock('heading', { text: '{{location.name}}', level: 3 }, { align: 'center', paddingY: 20 })]]);

export interface Starter {
  key: string;
  name: string;
  description: string;
  subject: string;
  build: () => EmailDesign;
}

export const STARTERS: Starter[] = [
  {
    key: 'newsletter',
    name: 'Newsletter',
    description: 'Titelbild, Intro, zwei Beiträge nebeneinander, Social-Links',
    subject: 'Neuigkeiten von {{location.name}}',
    build: () =>
      design(
        [
          logo(),
          newSection(1, [[newBlock('image', { alt: 'Titelbild' }, { paddingX: 0, paddingY: 0 })]]),
          newSection(1, [
            [
              newBlock('heading', { text: 'Das ist neu bei {{location.name}}', level: 1 }),
              newBlock('text', { text: 'Hallo {{contact.first_name|du}},\n\nhier sind die wichtigsten Neuigkeiten der letzten Wochen – kurz und knapp.' }),
            ],
          ]),
          newSection(2, [
            [newBlock('image', { alt: 'Beitrag 1' }), newBlock('heading', { text: 'Beitrag eins', level: 3 }), newBlock('text', { text: 'Zwei, drei Sätze zum Thema. [Weiterlesen](https://example.com)' })],
            [newBlock('image', { alt: 'Beitrag 2' }), newBlock('heading', { text: 'Beitrag zwei', level: 3 }), newBlock('text', { text: 'Zwei, drei Sätze zum Thema. [Weiterlesen](https://example.com)' })],
          ]),
          newSection(1, [[newBlock('divider'), newBlock('social')]]),
          footer(),
        ],
      ),
  },
  {
    key: 'offer',
    name: 'Angebot',
    description: 'Großer Rabatt-Hinweis mit Button und Countdown-Text',
    subject: '{{contact.first_name|Hallo}}, nur bis Sonntag: 20 % Rabatt',
    build: () => {
      const hero = newSection(1, [
        [
          newBlock('heading', { text: '20 % auf alles', level: 1 }, { align: 'center', color: '#ffffff', fontSize: 36, paddingY: 24 }),
          newBlock('text', { text: 'Nur bis Sonntag – mit dem Code **HERBST20** im Warenkorb.' }, { align: 'center', color: '#e0e7ff' }),
          newBlock('button', { label: 'Jetzt sparen', href: 'https://example.com/shop', background: '#f59e0b', textColor: '#111827' }, { align: 'center', paddingY: 20 }),
        ],
      ]);
      hero.style = { background: '#1e3a8a', paddingY: 24, paddingX: 0 };
      return design([
        logo(),
        hero,
        newSection(1, [[newBlock('text', { text: 'Hallo {{contact.first_name|du}},\n\nals Dankeschön für deine Treue bekommst du diese Woche 20 % auf unser gesamtes Angebot. Das Angebot gilt bis Sonntag, 23:59 Uhr.' })]]),
        newSection(3, [
          [newBlock('heading', { text: '✓ Versandkostenfrei', level: 3 }, { align: 'center', fontSize: 15 })],
          [newBlock('heading', { text: '✓ 30 Tage Rückgabe', level: 3 }, { align: 'center', fontSize: 15 })],
          [newBlock('heading', { text: '✓ Persönliche Beratung', level: 3 }, { align: 'center', fontSize: 15 })],
        ]),
        footer(),
      ]);
    },
  },
  {
    key: 'event',
    name: 'Event-Einladung',
    description: 'Einladung mit Wann/Wo in zwei Spalten und Anmelde-Button',
    subject: 'Einladung: Unser Sommerfest am 12. Juli',
    build: () =>
      design(
        [
          logo(),
          newSection(1, [
            [
              newBlock('image', { alt: 'Event-Bild' }, { paddingX: 0, paddingY: 0 }),
              newBlock('heading', { text: 'Du bist eingeladen!', level: 1 }, { align: 'center', paddingY: 20 }),
              newBlock('text', { text: 'Hallo {{contact.first_name|du}},\n\nwir feiern – und du bist herzlich eingeladen. Freu dich auf gute Gespräche, Musik und Essen.' }, { align: 'center' }),
            ],
          ]),
          newSection(2, [
            [newBlock('heading', { text: 'Wann', level: 3 }, { align: 'center' }), newBlock('text', { text: 'Samstag, 12. Juli\n16:00 – 22:00 Uhr' }, { align: 'center' })],
            [newBlock('heading', { text: 'Wo', level: 3 }, { align: 'center' }), newBlock('text', { text: '{{location.name}}\n{{location.address|Adresse folgt}}' }, { align: 'center' })],
          ]),
          newSection(1, [[newBlock('button', { label: 'Jetzt anmelden', href: 'https://example.com/anmeldung' }, { align: 'center', paddingY: 20 }), newBlock('text', { text: 'Bitte gib uns bis zum 1. Juli Bescheid.' }, { align: 'center', color: '#6b7280', fontSize: 14 })]]),
          footer(),
        ],
        { background: '#fef3c7' },
      ),
  },
  {
    key: 'review',
    name: 'Bewertungsanfrage',
    description: 'Kurze Bitte um eine Google-Bewertung mit großem Button',
    subject: 'Wie war es bei {{location.name}}?',
    build: () =>
      design([
        logo(),
        newSection(1, [
          [
            newBlock('heading', { text: 'Wie zufrieden warst du?', level: 1 }, { align: 'center', paddingY: 20 }),
            newBlock('text', { text: 'Hallo {{contact.first_name|du}},\n\ndanke für dein Vertrauen! Deine ehrliche Bewertung hilft uns und anderen – sie dauert nur 30 Sekunden.' }, { align: 'center' }),
            newBlock('heading', { text: '★★★★★', level: 2 }, { align: 'center', color: '#f59e0b', fontSize: 32 }),
            newBlock('button', { label: 'Jetzt bewerten', href: 'https://' }, { align: 'center', paddingY: 16 }),
            newBlock('text', { text: 'Etwas lief nicht rund? Antworte einfach auf diese E-Mail – wir kümmern uns.' }, { align: 'center', color: '#6b7280', fontSize: 14 }),
          ],
        ]),
        footer(),
      ]),
  },
  {
    key: 'welcome',
    name: 'Willkommen',
    description: 'Begrüßung neuer Kontakte mit drei nächsten Schritten',
    subject: 'Willkommen bei {{location.name}}, {{contact.first_name|schön, dass du da bist}}!',
    build: () =>
      design([
        logo(),
        newSection(1, [
          [
            newBlock('heading', { text: 'Willkommen an Bord, {{contact.first_name|du}}!', level: 1 }),
            newBlock('text', { text: 'Schön, dass du da bist. So geht es weiter:\n\n1. Profil vervollständigen\n2. Termin für das Kennenlerngespräch buchen\n3. Unseren Newsletter lesen – mit Tipps aus der Praxis' }),
            newBlock('button', { label: 'Termin buchen', href: 'https://example.com/termin' }, { align: 'left' }),
            newBlock('text', { text: 'Fragen? Antworte einfach auf diese E-Mail.\n\nViele Grüße\n{{location.name}}' }),
          ],
        ]),
        footer(),
      ]),
  },
  {
    key: 'letter',
    name: 'Schlichter Brief',
    description: 'Nur Text, wie eine persönliche E-Mail',
    subject: 'Kurze Frage, {{contact.first_name|}}',
    build: () =>
      design(
        [
          newSection(1, [[newBlock('text', { text: 'Hallo {{contact.first_name|du}},\n\nich wollte mich kurz persönlich melden …\n\nViele Grüße\n{{location.name}}' }, { paddingY: 24 })]]),
          newSection(1, [[newBlock('footer', { text: '' }, { align: 'left' })]]),
        ],
        { background: '#ffffff' },
      ),
  },
];
