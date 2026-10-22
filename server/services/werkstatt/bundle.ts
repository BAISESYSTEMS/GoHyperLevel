import { createHash } from 'node:crypto';
import { bad } from '../../core/http.js';
import { parseManifest, type Manifest } from './manifest.js';
import { checkSignature, type BundleSignature, type PublicKey, type SignatureCheck } from './signing.js';
import type { VersionRow } from './store.js';

/**
 * A plugin as one JSON file, so self-hosters can share plugins (Werkstatt → Exportieren / Importieren).
 * The bundle carries the current version only – no ids, no sub-account data, no secrets. Importing never
 * trusts it: the manifest is validated again, the static checks and the self-test run, the plugin starts
 * private and unreviewed (it needs the security review before it can go to the Marktplatz).
 */

export const BUNDLE_FORMAT = 'gohigh-plugin';
export const BUNDLE_VERSION = 1;
export const MAX_BUNDLE_BYTES = 800_000;

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  bundle_version: number;
  exported_at: string;
  plugin: { name: string; slug: string; description: string; category: string; icon: string };
  version: { version: string; manifest: Manifest; ui_html: string; server_js: string; steps: unknown; changelog: string };
  /** SHA-256 over the version's content: detects a bundle that was edited by accident (not a signature). */
  integrity: string;
  /** Ed25519 signature over the content (services/werkstatt/signing.ts); absent in unsigned bundles. */
  signature?: BundleSignature;
}

const digest = (v: Bundle['version']) => createHash('sha256').update(JSON.stringify([v.manifest, v.ui_html, v.server_js, v.steps ?? null])).digest('hex');

export function exportBundle(v: VersionRow): Bundle {
  const version = { version: v.version, manifest: v.manifest, ui_html: v.ui_html, server_js: v.server_js, steps: v.steps ?? null, changelog: v.changelog };
  const m = v.manifest;
  return { format: BUNDLE_FORMAT, bundle_version: BUNDLE_VERSION, exported_at: new Date().toISOString(), plugin: { name: m.name, slug: m.slug, description: m.description, category: m.category, icon: m.icon }, version, integrity: digest(version) };
}

export interface ParsedBundle {
  manifest: Manifest;
  ui_html: string;
  server_js: string;
  steps: unknown;
  changelog: string;
  /** false when the integrity hash does not match (edited by hand – allowed, but the importer is told). */
  intact: boolean;
  /** Signed by a key this installation trusts? („ungeprüft“ otherwise.) */
  signature: SignatureCheck;
}

export function parseBundle(raw: unknown, trusted: PublicKey[] = []): ParsedBundle {
  let v: any = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_BUNDLE_BYTES) throw bad('Die Datei ist zu groß.');
    try {
      v = JSON.parse(raw);
    } catch {
      throw bad('Das ist keine gültige JSON-Datei.');
    }
  }
  if (!v || typeof v !== 'object' || v.format !== BUNDLE_FORMAT) throw bad('Das ist kein Plugin-Paket (format „gohigh-plugin“ fehlt).');
  if (Number(v.bundle_version) !== BUNDLE_VERSION) throw bad(`Dieses Paket hat das Format ${v.bundle_version} – unterstützt wird ${BUNDLE_VERSION}.`);
  const ver = v.version;
  if (!ver || typeof ver !== 'object') throw bad('Das Paket enthält keine Version.');
  const m = parseManifest(ver.manifest);
  if (!m.ok) throw bad(`Manifest im Paket ungültig: ${m.errors.join(' ')}`);
  for (const k of ['ui_html', 'server_js'] as const) if (ver[k] !== undefined && typeof ver[k] !== 'string') throw bad(`${k} muss Text sein.`);
  const parsed = { version: m.manifest.version, manifest: m.manifest, ui_html: String(ver.ui_html ?? ''), server_js: String(ver.server_js ?? ''), steps: ver.steps ?? null, changelog: String(ver.changelog ?? '').slice(0, 500) };
  return { manifest: parsed.manifest, ui_html: parsed.ui_html, server_js: parsed.server_js, steps: parsed.steps, changelog: parsed.changelog, intact: typeof v.integrity === 'string' && v.integrity === digest(parsed as Bundle['version']), signature: checkSignature(v, trusted) };
}
