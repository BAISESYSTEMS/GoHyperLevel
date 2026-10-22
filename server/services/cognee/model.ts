/**
 * Wissensgedächtnis (Cognee) – pure model: data types, dataset names, per-sub-account settings, address checks.
 * No imports from the app, so the rules that keep sub-accounts apart can be tested in isolation.
 */

export const TYPES = ['wiki', 'notes', 'tickets', 'courses', 'conversations', 'contacts', 'memory'] as const;
export type CogneeType = (typeof TYPES)[number];

export interface TypeInfo {
  key: CogneeType;
  label: string;
  /** Permission area a member needs to ask about this type (null: everybody in the sub-account). */
  area: string | null;
  /** Contains personal data: shown with a warning. */
  personal: boolean;
  /** On as soon as the sub-account opts in. Only the wiki is. */
  defaultOn: boolean;
  /** Redact e-mail addresses, phone numbers and IBANs before sending (default for this type). */
  redactDefault: boolean;
  description: string;
  warning?: string;
}

export const CATALOG: Record<CogneeType, TypeInfo> = {
  wiki: {
    key: 'wiki',
    label: 'Wiki & Dokumente',
    area: 'wiki',
    personal: false,
    defaultOn: true,
    redactDefault: false,
    description: 'Seiten des Team-Wikis (ohne private Bereiche und Papierkorb) und die Dokumenten-Einträge des Sub-Accounts (Titel, Art, Zusammenfassung).',
  },
  notes: {
    key: 'notes',
    label: 'Notizen',
    area: 'contacts',
    personal: true,
    defaultOn: false,
    redactDefault: true,
    description: 'Notizen, die an Kontakten hängen (Text und Name des Kontakts).',
    warning: 'Notizen enthalten oft personenbezogene Daten.',
  },
  tickets: {
    key: 'tickets',
    label: 'Tickets, Helpdesk & Wissensdatenbank',
    area: 'helpdesk',
    personal: true,
    defaultOn: false,
    redactDefault: true,
    description: 'Tickets mit Verlauf und internen Notizen sowie veröffentlichte Artikel der Wissensdatenbank.',
    warning: 'Tickets enthalten Nachrichten von Kunden – also personenbezogene Daten.',
  },
  courses: {
    key: 'courses',
    label: 'Kursinhalte',
    area: 'courses',
    personal: false,
    defaultOn: false,
    redactDefault: false,
    description: 'Veröffentlichte Lektionen deiner Kurse (nur Text – keine Videos, keine Teilnehmerdaten).',
  },
  conversations: {
    key: 'conversations',
    label: 'Gesprächsverläufe (E-Mail/Chat)',
    area: 'conversations',
    personal: true,
    defaultOn: false,
    redactDefault: true,
    description: 'Nachrichten aus der Inbox (E-Mail, SMS, Chat, WhatsApp …), je Gespräch und Monat zusammengefasst, ohne Entwürfe.',
    warning: 'Gespräche sind personenbezogen und können Vertrauliches enthalten.',
  },
  contacts: {
    key: 'contacts',
    label: 'Kontakte (personenbezogen)',
    area: 'contacts',
    personal: true,
    defaultOn: false,
    redactDefault: true,
    description: 'Stammdaten der Kontakte: Name, Firma, Ort, Land, Quelle, Tags, eigene Felder (keine Anschrift, kein Geburtsdatum).',
    warning: 'Achtung: personenbezogene Daten. Nur aktivieren, wenn Auftragsverarbeitung und Rechtsgrundlage geklärt sind.',
  },
  memory: {
    key: 'memory',
    label: 'Gemerkte Hinweise (manuell)',
    area: null,
    personal: false,
    defaultOn: false,
    redactDefault: false,
    description: 'Hinweise, die jemand ausdrücklich merken lässt (Tool „ghl_memory_remember“ oder die Oberfläche). Sie liegen auch in HyperLevel und lassen sich dort löschen.',
  },
};

export const isType = (v: unknown): v is CogneeType => typeof v === 'string' && (TYPES as readonly string[]).includes(v);

// --- dataset names: the only place a name is made -------------------------------------------------------------------

const LOCATION_ID = /^[A-Za-z0-9]{6,64}$/;
const NAME = new RegExp(`^gh_([A-Za-z0-9]{6,64})_(${TYPES.join('|')})$`);

/** `gh_<locationId>_<type>`: one dataset per sub-account and data type. Throws for anything that could make two names collide. */
export function datasetName(locationId: string, type: CogneeType): string {
  if (!LOCATION_ID.test(locationId)) throw new Error('Ungültige Sub-Account-ID für den Dataset-Namen');
  if (!isType(type)) throw new Error('Unbekannter Datentyp');
  return `gh_${locationId}_${type}`;
}

export function parseDatasetName(name: string): { locationId: string; type: CogneeType } | null {
  const m = NAME.exec(String(name ?? ''));
  return m ? { locationId: m[1], type: m[2] as CogneeType } : null;
}

/** A Cognee dataset that provably belongs to one sub-account (built by LocationClient only). */
export interface OwnedDataset {
  readonly locationId: string;
  readonly type: CogneeType;
  readonly name: string;
  /** Cognee's dataset id (UUID). */
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function ownedDataset(locationId: string, type: CogneeType, id: string): OwnedDataset {
  if (!isUuid(id)) throw new Error('Ungültige Dataset-ID von Cognee');
  return Object.freeze({ locationId, type, name: datasetName(locationId, type), id });
}

// --- per-sub-account settings -----------------------------------------------------------------------------------------

export interface CogneeSettings {
  enabled: boolean;
  types: Record<CogneeType, boolean>;
  redact: Record<CogneeType, boolean>;
  /** Members (client logins) may ask the memory – limited to the types their areas allow. */
  members_ask: boolean;
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : v === 1 || v === 0 ? v === 1 : fallback);

export function defaultSettings(): CogneeSettings {
  return {
    enabled: false,
    types: Object.fromEntries(TYPES.map((t) => [t, CATALOG[t].defaultOn])) as Record<CogneeType, boolean>,
    redact: Object.fromEntries(TYPES.map((t) => [t, CATALOG[t].redactDefault])) as Record<CogneeType, boolean>,
    members_ask: true,
  };
}

/** Settings from a stored row (or nothing): missing keys fall back to the safe defaults (off, only the wiki, redaction on for personal data). */
export function readSettings(row: { enabled?: unknown; types?: unknown; redact?: unknown; members_ask?: unknown } | undefined | null): CogneeSettings {
  const d = defaultSettings();
  if (!row) return d;
  const parse = (v: unknown): Record<string, unknown> => {
    if (typeof v === 'string') {
      try {
        const p = JSON.parse(v);
        return p && typeof p === 'object' ? p : {};
      } catch {
        return {};
      }
    }
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  };
  const types = parse(row.types);
  const redact = parse(row.redact);
  for (const t of TYPES) {
    d.types[t] = bool(types[t], d.types[t]);
    d.redact[t] = bool(redact[t], d.redact[t]);
  }
  d.enabled = bool(row.enabled, false);
  d.members_ask = bool(row.members_ask, true);
  return d;
}

/** The types data is shared for right now: none unless the sub-account opted in. */
export const activeTypes = (s: CogneeSettings): CogneeType[] => (s.enabled ? TYPES.filter((t) => s.types[t]) : []);

/**
 * The types a person may ask about: what is shared, narrowed to the permission areas they hold.
 * `areas` null = unrestricted (agency admins, unrestricted members, API keys of the sub-account).
 */
export function askableTypes(s: CogneeSettings, areas: string[] | null): CogneeType[] {
  return activeTypes(s).filter((t) => areas === null || CATALOG[t].area === null || areas.includes(CATALOG[t].area!));
}

// --- the server address -----------------------------------------------------------------------------------------------

/** Hosts that are normally only reachable inside a network (docker service names, .local, private IPv4). */
export function looksInternal(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.localdomain')) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // single label: a docker/compose service name
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

/** Normalises the Cognee address: http(s) only, no credentials/query/fragment, no trailing slash; plain http only inside a network. */
export function cleanBaseUrl(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('Adresse des Cognee-Servers fehlt');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Adresse ungültig – z. B. https://cognee.example.com oder http://cognee:8000');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Nur http:// oder https://');
  if (u.username || u.password) throw new Error('Keine Zugangsdaten in der Adresse – sie kommen in die Felder darunter');
  if (u.search || u.hash) throw new Error('Adresse ohne ? und # angeben');
  if (u.protocol === 'http:' && !looksInternal(u.hostname)) throw new Error('Außerhalb des eigenen Netzes bitte https:// verwenden – Zugangsdaten würden sonst unverschlüsselt gesendet');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}
