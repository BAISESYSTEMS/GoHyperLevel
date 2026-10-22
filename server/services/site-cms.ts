import { bad } from '../core/http.js';
import { fold } from './site-search.js';
import type { Block } from './site-blocks.js';
import { newSection } from './site-layout.js';

/**
 * Site builder: CMS collections (pure). A collection is a list of records with fields you define (team members, projects, products,
 * testimonials …). Each record gets its own page `/<collection>/<slug>` built from the collection's detail template – a list of
 * blocks whose texts may contain `{{field}}` placeholders – and the collection can be shown anywhere as a list ("collection" block)
 * with filters, sorting and paging.
 */

export const FIELD_TYPES = ['text', 'longtext', 'number', 'image', 'url', 'email', 'phone', 'date', 'bool', 'select', 'tags', 'product', 'rating'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_LABEL: Record<FieldType, string> = {
  text: 'Text (eine Zeile)',
  longtext: 'Langer Text (Markdown)',
  number: 'Zahl',
  image: 'Bild',
  url: 'Link',
  email: 'E-Mail',
  phone: 'Telefon',
  date: 'Datum',
  bool: 'Ja/Nein',
  select: 'Auswahl',
  tags: 'Schlagwörter',
  product: 'Produkt (Kauf-Button)',
  rating: 'Bewertung (1–5 Sterne)',
};

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  filterable?: boolean;
}
export interface CollectionSettings {
  title_field: string;
  image_field: string;
  text_field: string;
  /** shown under the title on cards */
  meta_fields: string[];
  per_page: number;
  sort_field: string;
  sort_dir: 'asc' | 'desc';
  layout: 'grid' | 'list';
  columns: number;
  /** true: records have their own pages; false: only the list */
  detail_pages: boolean;
  /** true: the list is available at /<collection> */
  list_page: boolean;
  intro: string;
  indexable: boolean;
  seo_title: string;
  seo_description: string;
  button_text: string;
}

const KEY = /^[a-z][a-z0-9_]{0,29}$/;
export const RESERVED_KEYS = ['id', 'slug', 'status', 'url', 'collection', 'site', 'created_at', 'updated_at'];
export const MAX_FIELDS = 30;

const str = (v: unknown, max: number) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);

export function cleanFields(input: unknown): Field[] {
  if (!Array.isArray(input)) throw bad('Felder fehlen');
  const seen = new Set<string>();
  const out: Field[] = [];
  for (const f of input.slice(0, MAX_FIELDS)) {
    const key = str(f?.key, 30).toLowerCase();
    if (!KEY.test(key) || RESERVED_KEYS.includes(key)) throw bad(`Feld-Schlüssel „${key || '…'}“: Kleinbuchstaben, Ziffern und _, mit einem Buchstaben beginnen (nicht ${RESERVED_KEYS.slice(0, 4).join(', ')} …)`);
    if (seen.has(key)) throw bad(`Feld „${key}“ kommt doppelt vor`);
    seen.add(key);
    const type = (FIELD_TYPES as readonly string[]).includes(f?.type) ? (f.type as FieldType) : 'text';
    const field: Field = { key, label: str(f?.label, 60) || key, type };
    if (f?.required) field.required = true;
    if (type === 'select') {
      field.options = [...new Set((Array.isArray(f?.options) ? f.options : String(f?.options ?? '').split('\n')).map((o: unknown) => str(o, 60)).filter(Boolean))].slice(0, 40) as string[];
      if (!field.options.length) throw bad(`Feld „${field.label}“ (Auswahl) braucht mindestens eine Option`);
    }
    if (f?.filterable && ['select', 'tags', 'bool', 'text'].includes(type)) field.filterable = true;
    out.push(field);
  }
  if (!out.length) throw bad('Mindestens ein Feld');
  return out;
}

export function cleanSettings(input: any, fields: Field[], cur?: Partial<CollectionSettings>): CollectionSettings {
  const i = { ...(cur ?? {}), ...(input && typeof input === 'object' ? input : {}) };
  const keys = new Set(fields.map((f) => f.key));
  const pick = (v: unknown, types: FieldType[], d: string) => (typeof v === 'string' && keys.has(v) && types.includes(fields.find((f) => f.key === v)!.type) ? v : d);
  const firstOf = (types: FieldType[]) => fields.find((f) => types.includes(f.type))?.key ?? '';
  const sort = typeof i.sort_field === 'string' && (i.sort_field === 'position' || i.sort_field === 'published_at' || keys.has(i.sort_field)) ? i.sort_field : 'position';
  return {
    title_field: pick(i.title_field, ['text'], firstOf(['text'])),
    image_field: pick(i.image_field, ['image'], firstOf(['image'])),
    text_field: pick(i.text_field, ['text', 'longtext'], fields.find((f) => f.type === 'longtext')?.key ?? ''),
    meta_fields: (Array.isArray(i.meta_fields) ? i.meta_fields : []).filter((k: unknown) => typeof k === 'string' && keys.has(k)).slice(0, 3),
    per_page: Math.min(48, Math.max(3, Math.round(Number(i.per_page) || 12))),
    sort_field: sort,
    sort_dir: i.sort_dir === 'desc' ? 'desc' : 'asc',
    layout: i.layout === 'list' ? 'list' : 'grid',
    columns: Math.min(4, Math.max(1, Math.round(Number(i.columns) || 3))),
    detail_pages: i.detail_pages !== false,
    list_page: i.list_page !== false,
    intro: str(i.intro, 1000),
    indexable: i.indexable !== false,
    seo_title: str(i.seo_title, 200),
    seo_description: str(i.seo_description, 400),
    button_text: str(i.button_text, 40) || 'Mehr erfahren',
  };
}

// --- values ---------------------------------------------------------------------------------------------------------

const URLISH = /^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/i;
const MAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** One value of a record, checked and shaped by its field type. `products` tells whether a product id exists in this sub-account. */
export function cleanValue(f: Field, raw: unknown, products?: (id: string) => boolean): unknown {
  const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
  if (empty) {
    if (f.required && f.type !== 'bool') throw bad(`Bitte „${f.label}“ ausfüllen`);
    return f.type === 'bool' ? false : f.type === 'tags' ? [] : f.type === 'number' || f.type === 'rating' ? null : '';
  }
  switch (f.type) {
    case 'text':
      return str(raw, 500).replace(/\n/g, ' ');
    case 'longtext':
      return String(raw).replace(/\r/g, '').slice(0, 20_000);
    case 'number': {
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) throw bad(`„${f.label}“ muss eine Zahl sein`);
      return n;
    }
    case 'rating': {
      const n = Math.round(Number(raw));
      if (!Number.isFinite(n) || n < 0 || n > 5) throw bad(`„${f.label}“: 1 bis 5 Sterne`);
      return n || null;
    }
    case 'image':
    case 'url': {
      const s = str(raw, 1000);
      if (!URLISH.test(s)) throw bad(`„${f.label}“: bitte eine Adresse mit https:// (oder ein Bild aus der Mediathek)`);
      return s;
    }
    case 'email': {
      const s = str(raw, 200);
      if (!MAIL.test(s)) throw bad(`„${f.label}“: keine gültige E-Mail-Adresse`);
      return s;
    }
    case 'phone': {
      const s = str(raw, 40);
      if (!/^[+\d\s()/.-]{3,40}$/.test(s)) throw bad(`„${f.label}“: keine gültige Telefonnummer`);
      return s;
    }
    case 'date': {
      const s = str(raw, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`„${f.label}“: Datum als JJJJ-MM-TT`);
      return s;
    }
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'ja';
    case 'select': {
      const s = str(raw, 60);
      if (!f.options?.includes(s)) throw bad(`„${f.label}“: bitte eine der Optionen wählen`);
      return s;
    }
    case 'tags':
      return [...new Set((Array.isArray(raw) ? raw : String(raw).split(',')).map((t) => str(t, 40)).filter(Boolean))].slice(0, 20);
    case 'product': {
      const s = str(raw, 60);
      if (products && !products(s)) throw bad(`„${f.label}“: Produkt nicht gefunden`);
      return s;
    }
  }
}

export function cleanData(fields: Field[], data: unknown, products?: (id: string) => boolean, cur: Record<string, unknown> = {}): Record<string, unknown> {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...cur };
  for (const f of fields) {
    if (f.key in d || !(f.key in cur)) out[f.key] = cleanValue(f, d[f.key], products);
  }
  // keys of fields that no longer exist stay out of the record
  for (const k of Object.keys(out)) if (!fields.some((f) => f.key === k)) delete out[k];
  return out;
}

const DE_DATE = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/** A value as text for a placeholder or a card. */
export function display(f: Field | undefined, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  switch (f?.type) {
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? DE_DATE(String(v)) : String(v);
    case 'bool':
      return v ? 'Ja' : 'Nein';
    case 'number':
      return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 6 }).format(Number(v));
    case 'tags':
      return Array.isArray(v) ? v.join(', ') : String(v);
    case 'rating':
      return '★'.repeat(Number(v)) + '☆'.repeat(5 - Number(v));
    default:
      return String(v);
  }
}

// --- templates ---------------------------------------------------------------------------------------------------------

export interface ItemView {
  id: string;
  slug: string;
  data: Record<string, unknown>;
  url: string;
  product?: (id: string) => { name: string; price: string; url: string } | undefined;
}

/**
 * Fills `{{field}}` placeholders in every text of a block tree (never in keys, never in `html` blocks). Also `{{title}}`, `{{url}}`,
 * `{{slug}}`, `{{collection}}`, `{{site}}`, and for a product field `{{field.id}}`, `{{field.name}}`, `{{field.price}}` and `{{field}}` / `{{field.url}}` (the buy link).
 */
export function fillTemplate<T>(tpl: T, view: ItemView, fields: Field[], settings: CollectionSettings, extra: { collection: string; site: string }): T {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const lookup = (path: string): string => {
    const [head, sub] = path.split('.');
    if (head === 'title') return display(byKey.get(settings.title_field), view.data[settings.title_field]);
    if (head === 'url') return view.url;
    if (head === 'slug') return view.slug;
    if (head === 'collection') return extra.collection;
    if (head === 'site') return extra.site;
    const f = byKey.get(head);
    if (!f) return '';
    if (f.type === 'product') {
      if (sub === 'id') return String(view.data[head] ?? '');
      const p = view.product?.(String(view.data[head] ?? ''));
      if (!p) return '';
      return sub === 'name' ? p.name : sub === 'price' ? p.price : p.url;
    }
    return display(f, view.data[head]);
  };
  const fill = (s: string) => (s.includes('{{') ? s.replace(/\{\{\s*([a-z][a-z0-9_.]{0,40})\s*\}\}/gi, (_m, k: string) => lookup(k)) : s);
  const walk = (v: any, inHtml = false): any => {
    if (typeof v === 'string') return inHtml ? v : fill(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, inHtml));
    if (v && typeof v === 'object') {
      const html = inHtml || v.type === 'html';
      const out: Record<string, any> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, html);
      return out;
    }
    return v;
  };
  return walk(tpl);
}

/** Filters, text query, sort and paging of a list (items already hold their `data`). */
export interface ListQuery {
  filters?: Record<string, string>;
  q?: string;
  page?: number;
  per?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}
export function listItems<T extends { data: Record<string, any>; position: number; published_at?: string | null }>(items: T[], fields: Field[], q: ListQuery): { rows: T[]; total: number; pages: number; page: number } {
  let rows = items;
  for (const [k, v] of Object.entries(q.filters ?? {})) {
    const f = fields.find((x) => x.key === k && x.filterable);
    if (!f || !v) continue;
    rows = rows.filter((it) => {
      const x = it.data[k];
      if (f.type === 'tags') return Array.isArray(x) && x.includes(v);
      if (f.type === 'bool') return (v === '1' || v === 'ja') === !!x;
      return String(x ?? '') === v;
    });
  }
  const needle = fold(q.q ?? '').trim();
  if (needle) rows = rows.filter((it) => fold(Object.values(it.data).map((v) => (Array.isArray(v) ? v.join(' ') : String(v ?? ''))).join(' ')).includes(needle));
  const dir = q.dir === 'desc' ? -1 : 1;
  const key = q.sort ?? 'position';
  const val = (it: T) => (key === 'position' ? it.position : key === 'published_at' ? Date.parse(it.published_at ?? '') || 0 : it.data[key]);
  rows = [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'de', { numeric: true });
    return c * dir || a.position - b.position;
  });
  const per = Math.min(48, Math.max(1, q.per ?? 12));
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const page = Math.min(Math.max(1, Math.round(q.page ?? 1)), pages);
  return { rows: rows.slice((page - 1) * per, page * per), total: rows.length, pages, page };
}

// --- presets -----------------------------------------------------------------------------------------------------------

export interface Preset {
  key: string;
  name: string;
  singular: string;
  description: string;
  slug: string;
  fields: Field[];
  settings: Partial<CollectionSettings>;
  detail: () => Block[];
  samples: Record<string, unknown>[];
}

const h = (text: string, level = 1) => ({ id: 'h' + level, type: 'heading', text, level });
const detailLayout = (title: string, image: string, body: Block[], extra: Block[] = []): Block[] => [
  newSection(
    [5, 7],
    [
      [{ id: 'i1', type: 'image', src: image, alt: title, radius: 16 } as Block],
      [h(title), ...body],
    ],
    { pad_y: 56, id: 'sec_detail' },
  ),
  ...extra,
];

export const PRESETS: Preset[] = [
  {
    key: 'team',
    name: 'Team',
    singular: 'Teammitglied',
    description: 'Ansprechpartner mit Foto, Rolle und Kurzvorstellung – für „Über uns“.',
    slug: 'team',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'role', label: 'Rolle', type: 'text' },
      { key: 'department', label: 'Bereich', type: 'select', options: ['Geschäftsführung', 'Beratung', 'Service'], filterable: true },
      { key: 'photo', label: 'Foto', type: 'image' },
      { key: 'bio', label: 'Kurzvorstellung', type: 'longtext' },
      { key: 'email', label: 'E-Mail', type: 'email' },
      { key: 'phone', label: 'Telefon', type: 'phone' },
    ],
    settings: { meta_fields: ['role'], columns: 3, button_text: 'Mehr über mich' },
    detail: () => detailLayout('{{name}}', '{{photo}}', [{ id: 'r', type: 'text', text: '**{{role}}**' } as Block, { id: 'b', type: 'text', text: '{{bio}}' } as Block, { id: 'm', type: 'button', text: 'E-Mail schreiben', url: 'mailto:{{email}}' } as Block]),
    samples: [
      { name: 'Anna Beispiel', role: 'Geschäftsführerin', department: 'Geschäftsführung', bio: 'Gründerin und Ansprechpartnerin für alle Fragen rund um Ihr Projekt. Hier steht eine kurze, persönliche Vorstellung.', email: 'anna@beispiel.de' },
      { name: 'Ben Muster', role: 'Berater', department: 'Beratung', bio: 'Begleitet Kundinnen und Kunden von der ersten Idee bis zum Ergebnis.', email: 'ben@beispiel.de' },
      { name: 'Clara Probe', role: 'Kundenservice', department: 'Service', bio: 'Sorgt dafür, dass jede Anfrage schnell beantwortet wird.', email: 'clara@beispiel.de' },
    ],
  },
  {
    key: 'projects',
    name: 'Projekte & Referenzen',
    singular: 'Projekt',
    description: 'Referenzen mit Bild, Kategorie und Beschreibung – filterbar nach Kategorie.',
    slug: 'projekte',
    fields: [
      { key: 'title', label: 'Titel', type: 'text', required: true },
      { key: 'category', label: 'Kategorie', type: 'select', options: ['Neubau', 'Sanierung', 'Umbau'], filterable: true },
      { key: 'image', label: 'Titelbild', type: 'image' },
      { key: 'summary', label: 'Kurzbeschreibung', type: 'text' },
      { key: 'description', label: 'Beschreibung', type: 'longtext' },
      { key: 'date', label: 'Fertigstellung', type: 'date' },
      { key: 'client', label: 'Kunde', type: 'text' },
    ],
    settings: { text_field: 'summary', meta_fields: ['category', 'date'], columns: 3, sort_field: 'date', sort_dir: 'desc', button_text: 'Zum Projekt' },
    detail: () =>
      detailLayout('{{title}}', '{{image}}', [{ id: 's', type: 'text', text: '**{{category}}** · {{date}} · {{client}}' } as Block, { id: 'd', type: 'text', text: '{{description}}' } as Block], [
        newSection([12], [[{ id: 'cta', type: 'cta', heading: 'Ihr Projekt ist das nächste?', text: 'Wir beraten Sie gern – unverbindlich und persönlich.', button_text: 'Anfrage senden', button_url: 'page:kontakt' } as Block]], { pad_y: 40, id: 'sec_cta' }),
      ]),
    samples: [
      { title: 'Einfamilienhaus in Stadtnähe', category: 'Neubau', summary: 'Energieeffizientes Haus mit offener Küche und Garten.', description: 'Hier beschreiben Sie das Projekt: Aufgabe, Lösung, Ergebnis.\n\n- Bauzeit: 9 Monate\n- Besonderheit: Holzbauweise', date: '2026-06-15', client: 'Familie Beispiel' },
      { title: 'Altbau mit neuem Gesicht', category: 'Sanierung', summary: 'Denkmalgerechte Sanierung einer Gründerzeitvilla.', description: 'Beschreibung des Projekts.', date: '2026-03-01', client: 'Muster GmbH' },
      { title: 'Dachgeschoss-Ausbau', category: 'Umbau', summary: 'Aus dem Speicher wurde eine helle Wohnung.', description: 'Beschreibung des Projekts.', date: '2025-11-20', client: 'Herr Probe' },
    ],
  },
  {
    key: 'products',
    name: 'Produkte',
    singular: 'Produkt',
    description: 'Angebote mit Bild, Preis und Kauf-Button (verknüpft mit deinen Produkten und Stripe).',
    slug: 'angebote',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'category', label: 'Kategorie', type: 'select', options: ['Beratung', 'Kurs', 'Paket'], filterable: true },
      { key: 'image', label: 'Bild', type: 'image' },
      { key: 'summary', label: 'Kurzbeschreibung', type: 'text' },
      { key: 'description', label: 'Beschreibung', type: 'longtext' },
      { key: 'product', label: 'Produkt für den Kauf-Button', type: 'product' },
      { key: 'badge', label: 'Aufkleber (z. B. „Neu“)', type: 'text' },
    ],
    settings: { text_field: 'summary', meta_fields: ['category', 'badge'], columns: 3, button_text: 'Ansehen' },
    detail: () =>
      detailLayout('{{name}}', '{{image}}', [
        { id: 's', type: 'text', text: '**{{category}}** {{badge}}' } as Block,
        { id: 'd', type: 'text', text: '{{description}}' } as Block,
        { id: 'p', type: 'product', product_id: '{{product.id}}' } as Block,
      ]),
    samples: [
      { name: 'Erstberatung', category: 'Beratung', summary: '60 Minuten Klarheit zu Ihrem Vorhaben.', description: 'Beschreiben Sie, was enthalten ist und für wen das Angebot passt.', badge: 'Beliebt' },
      { name: 'Online-Kurs', category: 'Kurs', summary: 'Schritt für Schritt zum Ergebnis – in Ihrem Tempo.', description: 'Inhalte, Dauer, Voraussetzungen.' },
      { name: 'Komplett-Paket', category: 'Paket', summary: 'Alles aus einer Hand, zum Festpreis.', description: 'Leistungsumfang und Ablauf.', badge: 'Neu' },
    ],
  },
  {
    key: 'testimonials',
    name: 'Kundenstimmen',
    singular: 'Kundenstimme',
    description: 'Zitate mit Name, Foto und Sternen – für Startseite und Angebotsseiten.',
    slug: 'kundenstimmen',
    fields: [
      { key: 'author', label: 'Name', type: 'text', required: true },
      { key: 'role', label: 'Funktion / Ort', type: 'text' },
      { key: 'quote', label: 'Zitat', type: 'longtext', required: true },
      { key: 'rating', label: 'Sterne', type: 'rating' },
      { key: 'photo', label: 'Foto', type: 'image' },
    ],
    settings: { title_field: 'author', text_field: 'quote', meta_fields: ['role', 'rating'], columns: 3, detail_pages: false, layout: 'grid' },
    detail: () => [],
    samples: [
      { author: 'Sabine K.', role: 'Geschäftsführerin', quote: 'Schnell, freundlich und genau das, was wir gebraucht haben. Wir würden jederzeit wieder zusammenarbeiten.', rating: 5 },
      { author: 'Markus T.', role: 'Selbstständig', quote: 'Der Prozess war klar strukturiert, die Ergebnisse haben uns überzeugt.', rating: 5 },
      { author: 'Julia R.', role: 'Kundin seit 2023', quote: 'Endlich jemand, der zuhört und mitdenkt. Sehr empfehlenswert.', rating: 4 },
    ],
  },
  {
    key: 'faq',
    name: 'Häufige Fragen',
    singular: 'Frage',
    description: 'Fragen und Antworten, gruppiert nach Thema – eine zentrale Pflege für mehrere Seiten.',
    slug: 'fragen',
    fields: [
      { key: 'question', label: 'Frage', type: 'text', required: true },
      { key: 'answer', label: 'Antwort', type: 'longtext', required: true },
      { key: 'topic', label: 'Thema', type: 'select', options: ['Allgemein', 'Preise', 'Ablauf'], filterable: true },
    ],
    settings: { title_field: 'question', text_field: 'answer', meta_fields: ['topic'], layout: 'list', columns: 1, per_page: 24, detail_pages: false },
    detail: () => [],
    samples: [
      { question: 'Wie läuft die Zusammenarbeit ab?', answer: 'Wir starten mit einem kostenlosen Erstgespräch und erstellen danach ein Angebot.', topic: 'Ablauf' },
      { question: 'Was kostet das?', answer: 'Das hängt vom Umfang ab. Im Erstgespräch nennen wir Ihnen einen Preisrahmen.', topic: 'Preise' },
    ],
  },
  {
    key: 'jobs',
    name: 'Stellenangebote',
    singular: 'Stelle',
    description: 'Offene Stellen mit Ort, Art und Beschreibung – jede mit eigener Seite.',
    slug: 'karriere',
    fields: [
      { key: 'title', label: 'Stellenbezeichnung', type: 'text', required: true },
      { key: 'location', label: 'Ort', type: 'text' },
      { key: 'type', label: 'Art', type: 'select', options: ['Vollzeit', 'Teilzeit', 'Ausbildung', 'Minijob'], filterable: true },
      { key: 'description', label: 'Beschreibung', type: 'longtext' },
      { key: 'apply_email', label: 'Bewerbung an', type: 'email' },
    ],
    settings: { text_field: 'description', meta_fields: ['location', 'type'], layout: 'list', columns: 1, button_text: 'Zur Stelle' },
    detail: () => [
      newSection([12], [[h('{{title}}'), { id: 'm', type: 'text', text: '**{{type}}** · {{location}}' } as Block, { id: 'd', type: 'text', text: '{{description}}' } as Block, { id: 'b', type: 'button', text: 'Jetzt bewerben', url: 'mailto:{{apply_email}}' } as Block]], { pad_y: 56, width: 'narrow', id: 'sec_job' }),
    ],
    samples: [{ title: 'Kundenberater (m/w/d)', location: 'Berlin', type: 'Vollzeit', description: 'Das erwartet Sie:\n\n- Beratung von Kundinnen und Kunden\n- Eigenverantwortliches Arbeiten', apply_email: 'jobs@beispiel.de' }],
  },
];

export const presetOf = (key: unknown) => PRESETS.find((p) => p.key === key);

/** Detail template used when a collection has none: title, picture, all text fields. */
export function defaultDetail(fields: Field[], s: CollectionSettings): Block[] {
  const title = s.title_field ? `{{${s.title_field}}}` : '{{title}}';
  const body: Block[] = fields.filter((f) => f.key !== s.title_field && f.key !== s.image_field && ['text', 'longtext', 'select', 'date', 'number', 'tags'].includes(f.type)).slice(0, 8).map((f, i) => ({ id: `df${i}`, type: 'text', text: f.type === 'longtext' ? `{{${f.key}}}` : `**${f.label}:** {{${f.key}}}` }) as Block);
  return detailLayout(title, s.image_field ? `{{${s.image_field}}}` : '', body);
}
