/**
 * Plugin manifest: what a plugin is called, which permissions (scopes) it asks for and where it shows up.
 * Pure functions without Node imports – the web app uses the scope catalogue for the consent screen.
 * The manifest is the contract: the bridge (bridge.ts) refuses every call whose scope is not listed here.
 */

export interface ScopeDef {
  label: string;
  hint: string;
  risk: 'low' | 'medium' | 'high';
  /** Permission area (server/core/permissions.ts) the *user* needs for the data behind the scope. */
  area: string | null;
  write: boolean;
}

/** Every permission a plugin can ask for. There is deliberately no scope for sending messages, deleting or payments. */
export const SCOPES: Record<string, ScopeDef> = {
  'contacts:read': { label: 'Kontakte lesen', hint: 'Namen, E-Mail, Telefon, Tags, Notizen und Aufgaben deiner Kontakte', risk: 'medium', area: 'contacts', write: false },
  'contacts:write': { label: 'Kontakte ändern', hint: 'Kontakte anlegen und ändern, Tags setzen', risk: 'high', area: 'contacts', write: true },
  'notes:write': { label: 'Notizen schreiben', hint: 'Notizen an Kontakten anlegen', risk: 'medium', area: 'contacts', write: true },
  'tasks:read': { label: 'Aufgaben lesen', hint: 'Deine Aufgaben mit Fälligkeit und Kontakt', risk: 'low', area: 'contacts', write: false },
  'tasks:write': { label: 'Aufgaben anlegen und ändern', hint: 'Aufgaben erstellen, ändern und erledigen', risk: 'medium', area: 'contacts', write: true },
  'conversations:read': { label: 'Konversationen lesen', hint: 'Nachrichten (E-Mail, SMS, Chat …) mit deinen Kontakten', risk: 'high', area: 'conversations', write: false },
  'opportunities:read': { label: 'Deals lesen', hint: 'Opportunities und Pipelines mit Wert und Phase', risk: 'low', area: 'opportunities', write: false },
  'opportunities:write': { label: 'Deals ändern', hint: 'Deals verschieben, Status und Wert ändern', risk: 'high', area: 'opportunities', write: true },
  'calendars:read': { label: 'Termine lesen', hint: 'Gebuchte Termine und Kalender', risk: 'low', area: 'calendars', write: false },
  'companies:read': { label: 'Firmen lesen', hint: 'Firmen mit Eigenschaften', risk: 'low', area: 'contacts', write: false },
  'companies:write': { label: 'Firmen ändern', hint: 'Firmen anlegen und ändern', risk: 'medium', area: 'contacts', write: true },
  'tickets:read': { label: 'Tickets lesen', hint: 'Tickets des Service-Bereichs', risk: 'medium', area: 'helpdesk', write: false },
  'invoices:read': { label: 'Rechnungen lesen', hint: 'Rechnungen und Angebote mit Beträgen', risk: 'medium', area: 'payments', write: false },
  'objects:read': { label: 'Eigene Objekte lesen', hint: 'Datensätze deiner eigenen Objekte', risk: 'low', area: 'contacts', write: false },
  'objects:write': { label: 'Eigene Objekte ändern', hint: 'Datensätze deiner eigenen Objekte anlegen', risk: 'medium', area: 'contacts', write: true },
  'reports:read': { label: 'Berichte auswerten', hint: 'Auswertungen über alle Berichts-Datenquellen', risk: 'medium', area: 'dashboard', write: false },
  'ai:run': { label: 'KI nutzen', hint: 'Texte mit dem KI-Anbieter des Sub-Accounts erzeugen (kostet Tokens)', risk: 'medium', area: null, write: false },
};
export const SCOPE_KEYS = Object.keys(SCOPES);

export const CATEGORIES: [key: string, label: string][] = [
  ['vertrieb', 'Vertrieb & Deals'],
  ['kontakte', 'Kontakte & Aufgaben'],
  ['kommunikation', 'Kommunikation'],
  ['berichte', 'Berichte & Zahlen'],
  ['ki', 'KI & Zusammenfassungen'],
  ['service', 'Kundenservice'],
  ['marketing', 'Marketing'],
  ['sonstiges', 'Sonstiges'],
];
export const CATEGORY_KEYS = CATEGORIES.map(([k]) => k);

export type JobEvery = 'hourly' | 'daily' | 'weekly';
export interface Manifest {
  name: string;
  slug: string;
  icon: string;
  version: string;
  description: string;
  category: string;
  scopes: string[];
  entries: {
    /** A page in the menu. */
    page?: { title: string; icon?: string };
    /** A panel on the contact or deal page. */
    panels?: { id: string; on: 'contact' | 'deal'; title: string; height?: number }[];
    /** A widget on the dashboard. */
    widgets?: { id: string; title: string; size?: 's' | 'm' | 'l' }[];
    /** Workflow actions ("Plugin-Aktion"): server logic, input fields as merge-field templates. */
    actions?: { id: string; label: string; fields?: { key: string; label: string; type?: 'text' | 'textarea' | 'number' }[] }[];
    /** Scheduled jobs (server logic). `at` is local time of the sub-account. */
    jobs?: { id: string; label: string; every: JobEvery; at?: string; weekday?: number }[];
  };
  /** Server logic: a script in the sandbox, or declarative steps (no code). Needed for actions and jobs. */
  server?: { mode: 'script' | 'declarative' };
  /** Hosts the UI may load images/fonts/scripts from or talk to – only with the admin's allow-list. */
  externalHosts?: string[];
  author?: string;
}

const TOP_KEYS = ['name', 'slug', 'icon', 'version', 'description', 'category', 'scopes', 'entries', 'server', 'externalHosts', 'author'];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const ID_RE = /^[a-z][a-z0-9_]{0,29}$/;
export const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const LIMITS = { panels: 3, widgets: 3, actions: 5, jobs: 3, scopes: 20, hosts: 5, fields: 8 };

export function slugify(s: string): string {
  const slug = String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : '';
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

/** Validates and normalises a manifest from any source (AI output, a bundle, a hand-written file). */
export function parseManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['Das Manifest muss ein Objekt sein.'] };
  const m = raw as Record<string, any>;
  for (const k of Object.keys(m)) if (!TOP_KEYS.includes(k)) errors.push(`Unbekanntes Feld im Manifest: ${k}`);

  const name = text(m.name, 60);
  if (name.length < 2) errors.push('Name fehlt (2–60 Zeichen).');
  const slug = text(m.slug, 40) || slugify(name);
  if (!SLUG_RE.test(slug)) errors.push('Kürzel (slug) nur a-z, 0-9 und -, 2–40 Zeichen.');
  const icon = text(m.icon, 30).toLowerCase() || 'puzzle';
  if (!/^[a-z0-9-]{2,30}$/.test(icon)) errors.push('Symbol (icon) nur a-z, 0-9 und -.');
  const version = text(m.version, 20) || '1.0.0';
  if (!VERSION_RE.test(version)) errors.push('Version bitte als 1.0.0 angeben.');
  const description = text(m.description, 400);
  if (description.length < 5) errors.push('Beschreibung fehlt (mindestens ein Satz).');
  const category = text(m.category, 30) || 'sonstiges';
  if (!CATEGORY_KEYS.includes(category)) errors.push(`Kategorie „${category}“ gibt es nicht (${CATEGORY_KEYS.join(', ')}).`);

  const scopesIn = m.scopes === undefined ? [] : m.scopes;
  const scopes: string[] = [];
  if (!Array.isArray(scopesIn)) errors.push('scopes muss eine Liste sein.');
  else {
    if (scopesIn.length > LIMITS.scopes) errors.push(`Höchstens ${LIMITS.scopes} Berechtigungen.`);
    for (const s of scopesIn) {
      const k = String(s);
      if (!SCOPES[k]) errors.push(`Unbekannte Berechtigung: ${k}`);
      else if (!scopes.includes(k)) scopes.push(k);
    }
  }

  const entries: Manifest['entries'] = {};
  const e = m.entries === undefined ? {} : m.entries;
  if (!e || typeof e !== 'object' || Array.isArray(e)) errors.push('entries muss ein Objekt sein.');
  else {
    for (const k of Object.keys(e)) if (!['page', 'panels', 'widgets', 'actions', 'jobs'].includes(k)) errors.push(`Unbekannter Einstiegspunkt: ${k}`);
    if (e.page !== undefined) {
      if (!e.page || typeof e.page !== 'object') errors.push('entries.page muss ein Objekt sein.');
      else {
        const title = text(e.page.title, 40) || name;
        entries.page = { title, ...(e.page.icon ? { icon: text(e.page.icon, 30).toLowerCase() } : {}) };
      }
    }
    const list = <T,>(key: string, max: number, one: (x: any, i: number) => T | null): T[] | undefined => {
      if (e[key] === undefined) return undefined;
      if (!Array.isArray(e[key])) {
        errors.push(`entries.${key} muss eine Liste sein.`);
        return undefined;
      }
      if (e[key].length > max) errors.push(`Höchstens ${max} Einträge bei entries.${key}.`);
      const ids = new Set<string>();
      const out: T[] = [];
      e[key].slice(0, max).forEach((x: any, i: number) => {
        if (!x || typeof x !== 'object') return void errors.push(`entries.${key}[${i}] ist kein Objekt.`);
        const id = String(x.id ?? '');
        if (!ID_RE.test(id)) errors.push(`entries.${key}[${i}].id: a-z, 0-9 und _, mit Buchstabe beginnend.`);
        else if (ids.has(id)) errors.push(`entries.${key}: id „${id}“ doppelt.`);
        ids.add(id);
        const v = one(x, i);
        if (v) out.push(v);
      });
      return out;
    };
    const panels = list('panels', LIMITS.panels, (x) => {
      if (x.on !== 'contact' && x.on !== 'deal') {
        errors.push('entries.panels[].on muss contact oder deal sein.');
        return null;
      }
      const h = Number(x.height);
      return { id: String(x.id), on: x.on as 'contact' | 'deal', title: text(x.title, 40) || name, ...(Number.isFinite(h) && h > 0 ? { height: Math.min(600, Math.max(80, Math.round(h))) } : {}) };
    });
    if (panels?.length) entries.panels = panels;
    const widgets = list('widgets', LIMITS.widgets, (x) => ({ id: String(x.id), title: text(x.title, 40) || name, size: (['s', 'm', 'l'].includes(x.size) ? x.size : 'm') as 's' | 'm' | 'l' }));
    if (widgets?.length) entries.widgets = widgets;
    const actions = list('actions', LIMITS.actions, (x) => {
      const fields = Array.isArray(x.fields)
        ? x.fields.slice(0, LIMITS.fields).flatMap((f: any) => {
            const key = String(f?.key ?? '');
            if (!ID_RE.test(key)) {
              errors.push(`Aktion ${x.id}: Feld-Schlüssel „${key}“ ungültig.`);
              return [];
            }
            return [{ key, label: text(f.label, 60) || key, type: (['text', 'textarea', 'number'].includes(f.type) ? f.type : 'text') as 'text' | 'textarea' | 'number' }];
          })
        : [];
      return { id: String(x.id), label: text(x.label, 60) || String(x.id), ...(fields.length ? { fields } : {}) };
    });
    if (actions?.length) entries.actions = actions;
    const jobs = list('jobs', LIMITS.jobs, (x) => {
      if (!['hourly', 'daily', 'weekly'].includes(x.every)) {
        errors.push(`Job ${x.id}: every muss hourly, daily oder weekly sein.`);
        return null;
      }
      if (x.at !== undefined && !TIME_RE.test(String(x.at))) errors.push(`Job ${x.id}: at bitte als HH:MM.`);
      const wd = x.weekday === undefined ? undefined : Number(x.weekday);
      if (wd !== undefined && !(Number.isInteger(wd) && wd >= 0 && wd <= 6)) errors.push(`Job ${x.id}: weekday 0 (Sonntag) bis 6.`);
      return { id: String(x.id), label: text(x.label, 60) || String(x.id), every: x.every as JobEvery, ...(x.at !== undefined && TIME_RE.test(String(x.at)) ? { at: String(x.at) } : {}), ...(wd !== undefined && Number.isInteger(wd) ? { weekday: wd } : {}) };
    });
    if (jobs?.length) entries.jobs = jobs;
  }
  if (!entries.page && !entries.panels && !entries.widgets && !entries.actions && !entries.jobs) errors.push('Mindestens ein Einstiegspunkt (page, panels, widgets, actions oder jobs) ist nötig.');

  let server: Manifest['server'];
  if (m.server !== undefined) {
    if (!m.server || typeof m.server !== 'object' || !['script', 'declarative'].includes(m.server.mode)) errors.push('server.mode muss script oder declarative sein.');
    else server = { mode: m.server.mode };
  }
  if ((entries.actions?.length || entries.jobs?.length) && !server) errors.push('Aktionen und Jobs brauchen server.mode (script oder declarative).');

  let externalHosts: string[] | undefined;
  if (m.externalHosts !== undefined) {
    if (!Array.isArray(m.externalHosts)) errors.push('externalHosts muss eine Liste sein.');
    else {
      if (m.externalHosts.length > LIMITS.hosts) errors.push(`Höchstens ${LIMITS.hosts} externe Hosts.`);
      externalHosts = [];
      for (const h of m.externalHosts.slice(0, LIMITS.hosts)) {
        const host = String(h).trim().toLowerCase();
        if (!HOST_RE.test(host)) errors.push(`Ungültiger Host: ${host}`);
        else if (!externalHosts.includes(host)) externalHosts.push(host);
      }
    }
  }
  const author = text(m.author, 80);

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { name, slug, icon, version, description, category, scopes, entries, ...(server ? { server } : {}), ...(externalHosts?.length ? { externalHosts } : {}), ...(author ? { author } : {}) } };
}

/** Does the plugin run code or steps on the server (jobs, workflow actions)? */
export const needsServer = (m: Manifest) => !!(m.entries.actions?.length || m.entries.jobs?.length);
/** Does the plugin have a user interface? */
export const hasUi = (m: Manifest) => !!(m.entries.page || m.entries.panels?.length || m.entries.widgets?.length);

// --- versions --------------------------------------------------------------------------------

export const parseVersion = (v: string): [number, number, number] => {
  const m = VERSION_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
};
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
/** 1.2.3 → 1.2.4 (a change by feedback); minor: 1.3.0. */
export function bumpVersion(v: string, part: 'patch' | 'minor' = 'patch'): string {
  const [a, b, c] = parseVersion(v);
  return part === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

/** Scopes in `next` that `previous` did not have (a version update with new ones needs a new consent). */
export const newScopes = (previous: string[], next: string[]) => next.filter((s) => !previous.includes(s));

/** Highest risk of a list of scopes. */
export function riskOf(scopes: string[]): 'low' | 'medium' | 'high' {
  const r = scopes.map((s) => SCOPES[s]?.risk);
  return r.includes('high') ? 'high' : r.includes('medium') ? 'medium' : 'low';
}
