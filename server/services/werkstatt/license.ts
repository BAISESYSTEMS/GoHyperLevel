import type { App } from '../../core/app.js';
import { HttpError } from '../../core/http.js';

/**
 * Licensing split. The plugin runtime and local builds with your own AI key are part of the AGPL core and never
 * ask for a license. A few things around them are marked **Pro** and sit behind `app.services.license.has('pro')`:
 *
 *   marktplatz    publishing to and installing from the Marktplatz (per sub-account, with consent screens)
 *   signed        installing plugins that HyperLevel signed (Ed25519), the curated catalogue
 *   second_opinion  the second review by a different top model before publishing
 *   rollout       the advanced rollout of a feature flag (a percentage of the sub-accounts)
 *
 * There is no license system yet: modules/license.ts registers a stub whose `has()` is always true, so nothing is
 * locked today. When one exists it replaces `app.services.license`; this file is the only place that asks.
 */

export const PRO_FEATURES = {
  marktplatz: 'Veröffentlichen und Installieren im Marktplatz',
  signed: 'Installieren signierter Plugins von HyperLevel',
  second_opinion: 'Zweitmeinung bei der Sicherheitsprüfung',
  rollout: 'Erweiterter Rollout (Prozent der Sub-Accounts)',
} as const;
export type ProFeature = keyof typeof PRO_FEATURES;

export interface LicenseService {
  has: (feature: string) => boolean;
  /** true while there is no real license system (everything counts as licensed). */
  stub?: boolean;
}

/** Is the Pro license there? (No license service at all counts as yes: nothing is locked in the open-source build.) */
export function hasPro(app: App): boolean {
  const l = app.services.license as LicenseService | undefined;
  return l?.has ? !!l.has('pro') : true;
}

/** A German message when the feature needs Pro and there is no license, else null. */
export function proProblem(app: App, feature: ProFeature): string | null {
  return hasPro(app) ? null : `${PRO_FEATURES[feature]} ist eine Pro-Funktion – dafür ist eine HyperLevel-Pro-Lizenz nötig (docs/werkstatt.md → Lizenz). Plugins bauen und nutzen funktioniert weiterhin ohne Lizenz.`;
}

export function requirePro(app: App, feature: ProFeature): void {
  const p = proProblem(app, feature);
  if (p) throw new HttpError(403, p);
}

/** For the status screens: which Pro features there are and whether they are available. */
export const licenseInfo = (app: App) => ({ pro: hasPro(app), stub: !!(app.services.license as LicenseService | undefined)?.stub || !app.services.license, features: Object.entries(PRO_FEATURES).map(([id, label]) => ({ id, label })) });
