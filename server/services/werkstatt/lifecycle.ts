import type { App } from '../../core/app.js';
import { bad, notFound, type User } from '../../core/http.js';
import { id as newId, now } from '../../core/util.js';
import type { PluginFiles } from './checks.js';
import { revivePlugin } from './health.js';
import { verify, type Verification } from './logic.js';
import { newScopes } from './manifest.js';
import { addVersion, getPlugin, getVersion, installsOf, setActiveVersion, type InstallRow, type PluginRow, type VersionMeta, type VersionRow } from './store.js';

/** Steps every route and build shares: verify and store a version, activate it, install a plugin. */

export interface StoredVersion {
  version: VersionRow;
  verification: Verification;
}

/** Static checks + self-test, then the version is stored: `checked` when everything passed, `failed` otherwise (kept for the log). */
export async function storeVersion(app: App, plugin: PluginRow, files: PluginFiles & { changelog: string; source: 'ai' | 'manual' | 'import' | 'example'; buildId?: string | null; meta?: VersionMeta }, user: User | undefined, locationId: string, done?: Verification): Promise<StoredVersion> {
  const verification = done ?? (await verify(app, files, locationId));
  const version = addVersion(app, plugin.id, { manifest: files.manifest, ui_html: files.ui_html, server_js: files.server_js, steps: files.steps, changelog: files.changelog, source: files.source, buildId: files.buildId, status: verification.ok ? 'checked' : 'failed', checks: verification, createdBy: user?.id ?? null, meta: files.meta });
  return { version, verification };
}

/** Makes a checked version the plugin's current one. New scopes of a shared plugin need an admin (they apply to everyone using it). */
export function activateVersion(app: App, plugin: PluginRow, version: VersionRow, user: User, consent?: string[]): { newScopes: string[] } {
  if (version.plugin_id !== plugin.id) throw bad('Die Version gehört nicht zu diesem Plugin.');
  if (version.status !== 'checked') throw bad('Diese Version hat die Prüfung nicht bestanden und kann nicht aktiviert werden.');
  const prev = getVersion(app, plugin.active_version_id);
  const added = prev ? newScopes(prev.manifest.scopes, version.manifest.scopes) : version.manifest.scopes;
  if (added.length) {
    if (plugin.scope !== 'private' && user.role !== 'admin') throw bad('Diese Version fragt neue Berechtigungen an – bei einem geteilten Plugin bestätigt das nur ein Admin.');
    const want = [...version.manifest.scopes].sort().join(',');
    if (!consent || [...consent].sort().join(',') !== want) throw bad('Bitte die angefragten Berechtigungen bestätigen.');
  }
  setActiveVersion(app, plugin.id, version);
  // The author's own installs consented to what the new version asks.
  app.db.run(`UPDATE plugin_installs SET consent_scopes = ?, consent_at = ?, consent_by = ?, updated_at = ? WHERE plugin_id = ? AND version_id IS NULL`, JSON.stringify(version.manifest.scopes), now(), user.id, now(), plugin.id);
  return { newScopes: added };
}

/** Creates or updates an install row. `userId` null = the whole sub-account. */
export function upsertInstall(app: App, o: { pluginId: string; locationId: string; userId: string | null; versionId?: string | null; enabled?: boolean; consent: string[]; by: string | null }): InstallRow {
  const { db } = app;
  const cur = db.get<InstallRow>('SELECT * FROM plugin_installs WHERE plugin_id = ? AND location_id = ? AND COALESCE(user_id, \'\') = ?', o.pluginId, o.locationId, o.userId ?? '');
  if (cur) {
    db.run('UPDATE plugin_installs SET enabled = ?, version_id = ?, consent_scopes = ?, consent_at = ?, consent_by = ?, updated_at = ? WHERE id = ?', o.enabled === false ? 0 : 1, o.versionId ?? null, JSON.stringify(o.consent), now(), o.by, now(), cur.id);
    return installsOf(app, o.pluginId).find((i) => i.id === cur.id)!;
  }
  const row = { id: newId(), plugin_id: o.pluginId, location_id: o.locationId, user_id: o.userId, version_id: o.versionId ?? null, enabled: o.enabled === false ? 0 : 1, consent_scopes: o.consent, consent_at: now(), consent_by: o.by, installed_by: o.by, created_at: now(), updated_at: now() };
  db.insert('plugin_installs', row);
  return row as unknown as InstallRow;
}

/** Removes a plugin entirely: versions and installs go with it (cascade), its data is removed explicitly. */
export function deletePlugin(app: App, pluginId: string) {
  const { db } = app;
  for (const t of ['plugin_storage', 'plugin_events', 'plugin_runs', 'plugin_created', 'plugin_job_state']) db.run(`DELETE FROM ${t} WHERE plugin_id = ?`, pluginId);
  for (const t of ['plugin_media', 'plugin_reviews', 'plugin_security_reviews', 'plugin_core']) {
    try {
      db.run(`DELETE FROM ${t} WHERE plugin_id = ?`, pluginId);
    } catch {
      /* no Marktplatz module */
    }
  }
  db.run('DELETE FROM plugins WHERE id = ?', pluginId);
}

export const pluginOrThrow = (app: App, id: string): PluginRow => {
  const p = getPlugin(app, id);
  if (!p) throw notFound('Plugin nicht gefunden.');
  return p;
};

export interface RollbackResult {
  from: string;
  to: string;
  /** The Marktplatz offered the version that was rolled back and the older one was never reviewed: the listing is taken down. */
  unpublished: boolean;
  revived: boolean;
}

/**
 * One-click rollback: the plugin runs the version before the active one again (or the one asked for) – the author's
 * install, installs pinned to the bad version and, when the Marktplatz offered it, the listing. A killed plugin
 * is switched back on with a clean slate. The bad version stays in the list (and can be activated again).
 */
export function rollbackPlugin(app: App, plugin: PluginRow, user: User, targetId?: string): RollbackResult {
  const { db } = app;
  const cur = getVersion(app, plugin.active_version_id);
  if (!cur) throw bad('Das Plugin hat keine aktive Version.');
  const rows = db.all<{ id: string }>(`SELECT id FROM plugin_versions WHERE plugin_id = ? AND status = 'checked' AND id <> ? ORDER BY created_at DESC, rowid DESC`, plugin.id, cur.id);
  let target: ReturnType<typeof getVersion>;
  if (targetId) {
    target = getVersion(app, targetId);
    if (!target || target.plugin_id !== plugin.id || target.status !== 'checked' || target.id === cur.id) throw bad('Diese Version kann nicht wiederhergestellt werden.');
  } else {
    // The newest checked version that is older than the active one.
    target = rows.map((r) => getVersion(app, r.id)!).find((v) => v.created_at <= cur.created_at);
    if (!target) throw bad('Es gibt keine ältere geprüfte Version, auf die zurückgerollt werden könnte.');
  }
  // The version ran before, so its permissions were accepted; a rollback never asks for new ones.
  setActiveVersion(app, plugin.id, target);
  db.run(`UPDATE plugin_installs SET consent_scopes = ?, consent_at = ?, consent_by = ?, updated_at = ? WHERE plugin_id = ? AND version_id IS NULL`, JSON.stringify(target.manifest.scopes), now(), user.id, now(), plugin.id);
  db.run('UPDATE plugin_installs SET version_id = ?, updated_at = ? WHERE plugin_id = ? AND version_id = ?', target.id, now(), plugin.id, cur.id);
  let unpublished = false;
  if (plugin.market_version_id === cur.id) {
    let reviewed = false;
    try {
      reviewed = !!db.get(`SELECT 1 FROM plugin_security_reviews WHERE version_id = ? AND verdict <> 'fail'`, target.id);
    } catch {
      reviewed = false;
    }
    if (reviewed) db.run('UPDATE plugins SET market_version_id = ?, updated_at = ? WHERE id = ?', target.id, now(), plugin.id);
    else {
      const hasLocal = db.get('SELECT 1 FROM plugin_installs WHERE plugin_id = ? AND user_id IS NULL', plugin.id);
      db.run(`UPDATE plugins SET scope = ?, market_version_id = NULL, updated_at = ? WHERE id = ?`, hasLocal ? 'location' : 'private', now(), plugin.id);
      unpublished = true;
    }
  }
  const revived = revivePlugin(app, plugin.id);
  return { from: cur.version, to: target.version, unpublished, revived };
}
