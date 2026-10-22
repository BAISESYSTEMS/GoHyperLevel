import { createHash } from 'node:crypto';
import type { App } from '../../core/app.js';
import { bad, type User } from '../../core/http.js';
import { id as newId, now } from '../../core/util.js';
import { parseManifest, slugify, type Manifest } from './manifest.js';
import type { PluginScope } from './names.js';

/** Database access for plugins: rows, versions, installs and "which plugins are active for this person here". */

export interface PluginRow {
  id: string;
  slug: string;
  name: string;
  icon: string;
  description: string;
  category: string;
  owner_location_id: string | null;
  owner_user_id: string | null;
  origin: string;
  scope: PluginScope;
  /** active | killed | disabled | in_core */
  status: string;
  active_version_id: string | null;
  /** The version the Marktplatz offers (reviewed and approved); installs from there pin it. */
  market_version_id: string | null;
  wish_id: string | null;
  killed_at: string | null;
  killed_reason: string;
  /** Who jobs and workflow actions of an agency-wide plugin run as. */
  run_as: string | null;
  core_status: string;
  core_version: string;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  plugin_id: string;
  version: string;
  manifest: Manifest;
  ui_html: string;
  server_js: string;
  steps: unknown;
  changelog: string;
  source: string;
  build_id: string | null;
  /** draft | checked | failed */
  status: string;
  checks: any;
  hash: string;
  /** Where it came from and what vouches for it: { signature, ai } (see setVersionMeta). */
  meta: VersionMeta;
  created_by: string | null;
  created_at: string;
}

export interface VersionMeta {
  /** Import of a signed bundle: the result of the signature check. */
  signature?: { state: string; key_id: string; label: string; gohigh: boolean };
  /** The build that wrote it: model, Denkstufe and what it said about it. */
  ai?: { model: string; requested: string | null; applied: string | null; label: string; note: string };
  /** What changed against the version before ("Ändern lassen"). */
  diff?: unknown;
}

export interface InstallRow {
  id: string;
  plugin_id: string;
  location_id: string;
  user_id: string | null;
  version_id: string | null;
  enabled: number;
  consent_scopes: string[];
  consent_at: string | null;
  consent_by: string | null;
  installed_by: string | null;
  created_at: string;
  updated_at: string;
}

const jsonOr = <T>(s: unknown, fallback: T): T => {
  try {
    return s === null || s === undefined ? fallback : (JSON.parse(String(s)) as T);
  } catch {
    return fallback;
  }
};

export const versionOut = (r: any): VersionRow => ({ ...r, manifest: jsonOr(r.manifest, {} as Manifest), steps: jsonOr(r.steps, null), checks: jsonOr(r.checks, {}), meta: jsonOr(r.meta, {}) });
const installOut = (r: any): InstallRow => ({ ...r, consent_scopes: jsonOr(r.consent_scopes, [] as string[]) });

export const getPlugin = (app: App, id: string): PluginRow | undefined => app.db.get<PluginRow>('SELECT * FROM plugins WHERE id = ?', id);
export const getPluginBySlug = (app: App, slug: string): PluginRow | undefined => app.db.get<PluginRow>('SELECT * FROM plugins WHERE slug = ?', slug);
export const getVersion = (app: App, id: string | null | undefined): VersionRow | undefined => {
  if (!id) return undefined;
  const r = app.db.get('SELECT * FROM plugin_versions WHERE id = ?', id);
  return r ? versionOut(r) : undefined;
};
export const versionsOf = (app: App, pluginId: string): VersionRow[] => app.db.all('SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC, rowid DESC', pluginId).map(versionOut);
export const installsOf = (app: App, pluginId: string): InstallRow[] => app.db.all('SELECT * FROM plugin_installs WHERE plugin_id = ? ORDER BY created_at', pluginId).map(installOut);

/** A hash of what a version contains (for integrity checks and to see whether anything changed). */
export const contentHash = (v: { manifest: Manifest; ui_html: string; server_js: string; steps: unknown }): string =>
  createHash('sha256').update(JSON.stringify([v.manifest, v.ui_html, v.server_js, v.steps ?? null])).digest('hex').slice(0, 32);

export function uniqueSlug(app: App, base: string, ignoreId?: string): string {
  const root = slugify(base) || 'plugin';
  let slug = root;
  for (let i = 2; app.db.get('SELECT id FROM plugins WHERE slug = ? AND id <> ?', slug, ignoreId ?? ''); i++) slug = `${root.slice(0, 36)}-${i}`;
  return slug;
}

export interface NewPlugin {
  manifest: Manifest;
  ownerLocationId: string | null;
  ownerUserId: string | null;
  origin: 'werkstatt' | 'import' | 'example' | 'manual';
  scope?: PluginScope;
  wishId?: string | null;
}

export function createPlugin(app: App, o: NewPlugin): PluginRow {
  const m = o.manifest;
  const row = {
    id: newId(),
    slug: uniqueSlug(app, m.slug || m.name),
    name: m.name,
    icon: m.icon,
    description: m.description,
    category: m.category,
    owner_location_id: o.ownerLocationId,
    owner_user_id: o.ownerUserId,
    origin: o.origin,
    scope: o.scope ?? 'private',
    status: 'active',
    active_version_id: null,
    market_version_id: null,
    wish_id: o.wishId ?? null,
    killed_at: null,
    killed_reason: '',
    run_as: null,
    core_status: '',
    core_version: '',
    published_at: null,
    published_by: null,
    created_at: now(),
    updated_at: now(),
  };
  app.db.insert('plugins', row);
  return row as PluginRow;
}

export interface NewVersion {
  manifest: Manifest;
  ui_html: string;
  server_js: string;
  steps: unknown;
  changelog: string;
  source: 'ai' | 'manual' | 'import' | 'example';
  buildId?: string | null;
  status: 'draft' | 'checked' | 'failed';
  checks: unknown;
  createdBy: string | null;
  meta?: VersionMeta;
}

export function addVersion(app: App, pluginId: string, o: NewVersion): VersionRow {
  if (app.db.get('SELECT 1 FROM plugin_versions WHERE plugin_id = ? AND version = ?', pluginId, o.manifest.version)) throw bad(`Version ${o.manifest.version} gibt es schon.`);
  const row = { id: newId(), plugin_id: pluginId, version: o.manifest.version, manifest: o.manifest, ui_html: o.ui_html, server_js: o.server_js, steps: o.steps ?? null, changelog: o.changelog.slice(0, 500), source: o.source, build_id: o.buildId ?? null, status: o.status, checks: o.checks, hash: contentHash({ manifest: o.manifest, ui_html: o.ui_html, server_js: o.server_js, steps: o.steps }), meta: o.meta ?? {}, created_by: o.createdBy, created_at: now() };
  app.db.insert('plugin_versions', row);
  app.db.run('UPDATE plugins SET updated_at = ? WHERE id = ?', now(), pluginId);
  return versionOut(app.db.get('SELECT * FROM plugin_versions WHERE id = ?', row.id));
}

/** Adds to what is known about a version (signature, model and Denkstufe, diff). */
export function setVersionMeta(app: App, versionId: string, patch: VersionMeta) {
  const cur = jsonOr<VersionMeta>(app.db.get<{ meta: string }>('SELECT meta FROM plugin_versions WHERE id = ?', versionId)?.meta, {});
  app.db.run('UPDATE plugin_versions SET meta = ? WHERE id = ?', JSON.stringify({ ...cur, ...patch }), versionId);
}

/** Makes a version the plugin's current one and refreshes name, icon and description from its manifest. */
export function setActiveVersion(app: App, pluginId: string, v: VersionRow) {
  const m = v.manifest;
  app.db.run('UPDATE plugins SET active_version_id = ?, name = ?, icon = ?, description = ?, category = ?, updated_at = ? WHERE id = ?', v.id, m.name, m.icon, m.description, m.category, now(), pluginId);
}

/** The next free version after `from` (1.0.0 → 1.0.1 …). */
export function nextVersion(app: App, pluginId: string, from: string): string {
  const [a, b, c] = from.split('.').map(Number);
  let patch = (c || 0) + 1;
  while (app.db.get('SELECT 1 FROM plugin_versions WHERE plugin_id = ? AND version = ?', pluginId, `${a}.${b}.${patch}`)) patch++;
  return `${a}.${b}.${patch}`;
}

// --- who has which plugin where -----------------------------------------------------------------------------------

export interface ActivePlugin {
  plugin: PluginRow;
  version: VersionRow;
  manifest: Manifest;
  /** The install row that makes it active here; null for agency-wide plugins. */
  install: InstallRow | null;
  via: 'private' | 'location' | 'agency';
}

/** Installs that apply to this person in this sub-account: whole-sub-account ones and their private ones. */
const installsFor = (app: App, pluginId: string, locationId: string, userId: string | undefined): InstallRow[] =>
  app.db.all('SELECT * FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND (user_id IS NULL OR user_id = ?)', pluginId, locationId, userId ?? '').map(installOut);

/** The plugin as it runs for this person here, or null (not installed, switched off, killed, no usable version). */
export function resolveFor(app: App, pluginId: string, user: User | undefined, locationId: string): ActivePlugin | null {
  const plugin = getPlugin(app, pluginId);
  if (!plugin || plugin.status !== 'active') return null;
  const installs = installsFor(app, plugin.id, locationId, user?.id);
  const on = installs.filter((i) => i.enabled === 1);
  // A sub-account install that switched an agency plugin off (enabled = 0) wins over the agency scope.
  const off = installs.some((i) => i.enabled === 0 && i.user_id === null);
  let install: InstallRow | null = on.find((i) => i.user_id === user?.id) ?? on.find((i) => i.user_id === null) ?? null;
  let via: ActivePlugin['via'] = install ? (install.user_id ? 'private' : 'location') : 'agency';
  if (!install && !(plugin.scope === 'agency' && !off)) return null;
  const version = getVersion(app, install?.version_id || plugin.active_version_id);
  if (!version || version.status !== 'checked') return null;
  if (!install) install = null;
  if (install && !install.version_id && plugin.scope === 'agency') via = 'agency';
  return { plugin, version, manifest: version.manifest, install, via };
}

/** Every plugin that is active for this person in this sub-account. */
export function activeFor(app: App, user: User | undefined, locationId: string): ActivePlugin[] {
  const ids = new Set<string>();
  for (const r of app.db.all<{ plugin_id: string }>('SELECT DISTINCT plugin_id FROM plugin_installs WHERE location_id = ? AND enabled = 1 AND (user_id IS NULL OR user_id = ?)', locationId, user?.id ?? '')) ids.add(r.plugin_id);
  for (const r of app.db.all<{ id: string }>(`SELECT id FROM plugins WHERE scope = 'agency' AND status = 'active'`)) ids.add(r.id);
  return [...ids].map((pid) => resolveFor(app, pid, user, locationId)).filter((x): x is ActivePlugin => !!x);
}

/** May this person manage (change, promote, delete) the plugin? Its author and admins. */
export const canManage = (user: User | undefined, p: PluginRow) => !!user && (user.role === 'admin' || (!!p.owner_user_id && p.owner_user_id === user.id));

/** Parsed manifest from raw JSON with a clear German error. */
export function manifestOrThrow(raw: unknown): Manifest {
  const r = parseManifest(raw);
  if (!r.ok) throw bad(`Manifest ungültig: ${r.errors.join(' ')}`);
  return r.manifest;
}
