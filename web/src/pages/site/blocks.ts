import type { IconName } from '../../icons';

/**
 * The block types of the page builder: what the editor shows to fill in (fields, repeatable items) and the values a new block
 * starts with. The server renders them (server/services/site-blocks.ts and the modules that add blocks); this is only the form.
 */

export type FieldType = 'text' | 'textarea' | 'number' | 'image' | 'form' | 'calendar' | 'product' | 'collection' | 'component' | 'select' | 'datetime' | 'code' | 'bool' | 'link';
export type Opt = string | [value: string, label: string];
export type F = [key: string, type: FieldType, label: string, opts?: Opt[]];
export interface ItemSpec {
  key: string;
  label: string;
  fields: F[];
}
export interface BlockSpec {
  label: string;
  icon: IconName;
  group: string;
  fields: F[];
  items?: ItemSpec;
  init: Record<string, any>;
  /** One line under the title of the inspector. */
  hint?: string;
  /** No colour/padding/alignment controls (spacers, raw code). */
  plain?: boolean;
}

export const GROUPS = ['Grundlagen', 'Abschnitte', 'Verkaufen & Einsammeln', 'Inhalte', 'Erweitert'];

export const BLOCKS: Record<string, BlockSpec> = {
  heading: { label: 'Überschrift', icon: 'heading', group: 'Grundlagen', fields: [['text', 'text', 'Text'], ['level', 'select', 'Ebene', [['1', 'H1 – Haupttitel'], ['2', 'H2'], ['3', 'H3']]]], init: { text: 'Überschrift', level: 2 }, hint: 'Pro Seite genau eine H1; danach H2, H3 – das hilft Google und Screenreadern.' },
  text: { label: 'Text', icon: 'text', group: 'Grundlagen', fields: [['text', 'textarea', 'Text (**fett**, *kursiv*, [Link](https://…), - Liste)']], init: { text: 'Dein Text hier.' } },
  image: { label: 'Bild', icon: 'image', group: 'Grundlagen', fields: [['src', 'image', 'Bild'], ['alt', 'text', 'Alt-Text (was ist zu sehen?)'], ['width', 'number', 'Breite in %']], init: { width: 100, align: 'center' }, hint: 'Beim Hochladen entstehen kleinere Fassungen für Handys (srcset); Breite und Höhe verhindern Springen.' },
  button: { label: 'Button', icon: 'button', group: 'Grundlagen', fields: [['text', 'text', 'Text'], ['url', 'link', 'Link'], ['text2', 'text', 'Zweiter Button (optional)'], ['url2', 'link', 'Link des zweiten Buttons']], init: { text: 'Jetzt starten', url: '#', align: 'center' } },
  video: { label: 'Video', icon: 'video', group: 'Grundlagen', fields: [['url', 'text', 'YouTube- oder Vimeo-Link'], ['title', 'text', 'Titel (für Screenreader)']], init: { url: '' } },
  divider: { label: 'Trennlinie', icon: 'divider', group: 'Grundlagen', fields: [], init: {} },
  spacer: { label: 'Abstand', icon: 'spacer', group: 'Grundlagen', fields: [['height', 'number', 'Höhe (px)']], init: { height: 40 }, plain: true },

  hero: { label: 'Hero', icon: 'hero', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift (H1)'], ['subheading', 'textarea', 'Unterzeile'], ['button_text', 'text', 'Button-Text'], ['button_url', 'link', 'Button-Link'], ['image', 'image', 'Bild'], ['image_alt', 'text', 'Alt-Text des Bildes']], init: { heading: 'Große Überschrift', subheading: 'Was du anbietest, in einem Satz.', align: 'center' } },
  cta: { label: 'Aufruf (CTA)', icon: 'button', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift'], ['text', 'textarea', 'Text'], ['button_text', 'text', 'Button-Text'], ['button_url', 'link', 'Button-Link'], ['button2_text', 'text', 'Zweiter Button'], ['button2_url', 'link', 'Link des zweiten Buttons'], ['style', 'select', 'Look', [['', 'Markenfarbe'], ['dark', 'Dunkel'], ['light', 'Hell']]]], init: { heading: 'Bereit für den nächsten Schritt?', text: 'Sprich uns an – unverbindlich.', button_text: 'Kontakt aufnehmen', button_url: '#' } },
  features: { label: 'Vorteile', icon: 'features', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift']], items: { key: 'items', label: 'Vorteil', fields: [['icon', 'text', 'Icon/Emoji'], ['title', 'text', 'Titel'], ['text', 'textarea', 'Text']] }, init: { heading: 'Deine Vorteile', items: [{ icon: '✓', title: 'Vorteil', text: 'Beschreibung' }] } },
  steps: { label: 'Ablauf', icon: 'list', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift']], items: { key: 'items', label: 'Schritt', fields: [['title', 'text', 'Titel'], ['text', 'textarea', 'Text']] }, init: { heading: 'So läuft es ab', items: [{ title: 'Kontakt', text: 'Du meldest dich bei uns.' }, { title: 'Gespräch', text: 'Wir klären deine Ziele.' }, { title: 'Umsetzung', text: 'Wir legen los.' }] } },
  stats: { label: 'Zahlen', icon: 'gauge', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift']], items: { key: 'items', label: 'Zahl', fields: [['value', 'text', 'Wert (z. B. 500+)'], ['label', 'text', 'Beschriftung']] }, init: { items: [{ value: '10+', label: 'Jahre Erfahrung' }, { value: '500+', label: 'Kunden' }, { value: '4,9', label: 'Bewertung' }] } },
  logos: { label: 'Logos', icon: 'shield', group: 'Abschnitte', fields: [['heading', 'text', 'Zeile darüber (z. B. Bekannt aus)'], ['grayscale', 'bool', 'Grau darstellen']], items: { key: 'items', label: 'Logo', fields: [['src', 'image', 'Logo'], ['alt', 'text', 'Name des Unternehmens'], ['url', 'link', 'Link (optional)']] }, init: { heading: 'Vertrauen von', grayscale: true, items: [] } },
  gallery: { label: 'Galerie', icon: 'grid', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift'], ['columns', 'select', 'Spalten', ['2', '3', '4']]], items: { key: 'items', label: 'Bild', fields: [['src', 'image', 'Bild'], ['alt', 'text', 'Alt-Text']] }, init: { columns: 3, items: [] } },
  testimonial: { label: 'Kundenstimme', icon: 'quote', group: 'Abschnitte', fields: [['quote', 'textarea', 'Zitat'], ['author', 'text', 'Name']], init: { quote: 'Toll!', author: 'Kundin', align: 'center' } },
  faq: { label: 'FAQ', icon: 'faq', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift']], items: { key: 'items', label: 'Frage', fields: [['q', 'text', 'Frage'], ['a', 'textarea', 'Antwort']] }, init: { heading: 'Häufige Fragen', items: [{ q: 'Frage?', a: 'Antwort.' }] } },
  pricing: { label: 'Preise', icon: 'price', group: 'Abschnitte', fields: [['heading', 'text', 'Überschrift']], items: { key: 'items', label: 'Paket', fields: [['name', 'text', 'Name'], ['price', 'text', 'Preis'], ['features', 'textarea', 'Leistungen (eine pro Zeile)'], ['button_text', 'text', 'Button-Text'], ['button_url', 'link', 'Button-Link']] }, init: { heading: 'Preise', items: [{ name: 'Basis', price: '49 €', features: 'Leistung 1\nLeistung 2', button_text: 'Wählen', button_url: '#' }] } },

  form: { label: 'Formular', icon: 'forms', group: 'Verkaufen & Einsammeln', fields: [['heading', 'text', 'Überschrift'], ['form_id', 'form', 'Formular']], init: { heading: 'Jetzt eintragen' } },
  calendar: { label: 'Kalender', icon: 'calendars', group: 'Verkaufen & Einsammeln', fields: [['calendar_slug', 'calendar', 'Kalender']], init: {} },
  product: {
    label: 'Produkt / Kasse',
    icon: 'cart',
    group: 'Verkaufen & Einsammeln',
    fields: [['product_id', 'product', 'Produkt'], ['heading', 'text', 'Überschrift (leer = Produktname)'], ['text', 'textarea', 'Text (leer = Beschreibung des Produkts)'], ['badge', 'text', 'Hinweis-Plakette (z. B. Beliebt)'], ['button_text', 'text', 'Button-Text'], ['highlight', 'bool', 'Hervorheben'], ['show_bump', 'bool', 'Zusatzangebot (Order-Bump) ankündigen']],
    init: { button_text: 'Zur Bestellung', show_bump: true },
    hint: 'Preis, Steuerhinweis und Widerrufs-Hinweise kommen aus Produkt und Rechtstexten. Bestellt wird auf der Kaufseite – dort steht der rechtssichere Bestell-Button.',
  },
  countdown: { label: 'Countdown', icon: 'countdown', group: 'Verkaufen & Einsammeln', fields: [['until', 'datetime', 'Endet am']], init: { until: '' } },
  store_products: {
    label: 'Shop: Produktliste',
    icon: 'cart',
    group: 'Verkaufen & Einsammeln',
    fields: [['heading', 'text', 'Überschrift'], ['collection', 'text', 'Kollektion (Kurzname, leer = alle Produkte)'], ['columns', 'select', 'Spalten', ['2', '3', '4']], ['limit', 'number', 'Höchstens so viele Produkte'], ['detail_url', 'link', 'Seite mit dem Block „Shop: Produktdetail“ (optional)'], ['button_text', 'text', 'Button-Text']],
    init: { heading: 'Unsere Produkte', columns: 3, limit: 12, button_text: 'In den Warenkorb' },
    hint: 'Zeigt die im Online-Shop veröffentlichten Produkte mit Preis, Varianten und „In den Warenkorb“. Bezahlt wird auf der Kasse des Shops.',
  },
  store_product: {
    label: 'Shop: Produktdetail',
    icon: 'products',
    group: 'Verkaufen & Einsammeln',
    fields: [['product_id', 'product', 'Produkt (leer = das Produkt aus der Produktliste)'], ['heading', 'text', 'Überschrift (leer = Produktname)'], ['heading_level', 'select', 'Ebene der Überschrift', [['1', 'H1'], ['2', 'H2']]], ['show_description', 'bool', 'Beschreibung zeigen'], ['button_text', 'text', 'Button-Text']],
    init: { show_description: true, button_text: 'In den Warenkorb' },
    hint: 'Bilder, Preis, Varianten mit Bestand und Menge. Ohne gewähltes Produkt zeigt der Block das Produkt, das die Produktliste verlinkt (?product=…) – eine Seite für alle Produkte.',
  },

  collection: {
    label: 'Sammlung (CMS)',
    icon: 'library',
    group: 'Inhalte',
    fields: [
      ['collection_id', 'collection', 'Sammlung'],
      ['heading', 'text', 'Überschrift'],
      ['heading_level', 'select', 'Ebene der Überschrift', [['2', 'H2'], ['1', 'H1'], ['3', 'H3']]],
      ['layout', 'select', 'Darstellung', [['', 'Wie in der Sammlung'], ['grid', 'Raster'], ['list', 'Liste']]],
      ['columns', 'select', 'Spalten', [['', 'Wie in der Sammlung'], '1', '2', '3', '4']],
      ['limit', 'number', 'Höchstens so viele Einträge (0 = alle)'],
      ['show_filters', 'bool', 'Filter und Suche anzeigen'],
      ['paginate', 'bool', 'Seitenweise blättern'],
      ['filter_field', 'text', 'Nur Einträge mit Feld … (Feldschlüssel)'],
      ['filter_value', 'text', '… gleich dem Wert'],
      ['sort_field', 'text', 'Sortieren nach Feld (Schlüssel)'],
      ['sort_dir', 'select', 'Richtung', [['', 'Wie in der Sammlung'], ['asc', 'Aufsteigend'], ['desc', 'Absteigend']]],
      ['button_text', 'text', 'Text des Links zum Eintrag'],
    ],
    init: { heading: '', heading_level: 2 },
    hint: 'Zeigt die veröffentlichten Einträge einer Sammlung als Karten. Jeder Eintrag bekommt außerdem eine eigene Seite.',
  },
  search: { label: 'Suche', icon: 'search', group: 'Inhalte', fields: [['heading', 'text', 'Überschrift'], ['placeholder', 'text', 'Platzhalter']], init: { heading: 'Suche', placeholder: 'Wonach suchst du?' } },
  component: { label: 'Komponente', icon: 'puzzle', group: 'Inhalte', fields: [['component_id', 'component', 'Komponente']], init: {}, plain: true, hint: 'Eine Änderung an der Komponente zeigt sich auf allen Seiten, die sie benutzen.' },

  html: { label: 'Eigener Code', icon: 'code', group: 'Erweitert', fields: [['html', 'code', 'HTML (Tracking-Pixel, Embeds…)']], init: { html: '' }, plain: true, hint: 'Wird erst nach Einwilligung geladen, wenn der Cookie-Banner an ist.' },
};

/** Block types a person can add (not the layout containers). */
export const BLOCK_TYPES = Object.keys(BLOCKS);

/** Values of the select-fields that hold numbers (the server wants numbers there). */
const NUMERIC = new Set(['level', 'heading_level', 'columns']);
export const coerce = (key: string, v: string): string | number => (NUMERIC.has(key) && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v);

/** The keys that carry picture dimensions next to an image field (`image` → image_w, … ; `src` → w, …). */
export function imageKeys(key: string): { w: string; h: string; srcset: string } {
  return key === 'image' ? { w: 'image_w', h: 'image_h', srcset: 'image_srcset' } : { w: 'w', h: 'h', srcset: 'srcset' };
}
