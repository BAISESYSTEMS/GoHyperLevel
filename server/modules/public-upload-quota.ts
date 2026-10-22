import type { App, Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { now } from '../core/util.js';
import { notifyTeam } from '../services/messaging.js';

/**
 * Disk quota for what anonymous visitors upload – the files and signatures of public forms – per sub-account, so that one public
 * form cannot fill the server's disk (12 MB per submission and 120 submissions a minute per address are only rate limits).
 *
 * Two caps, whichever is lower: `PGHL_PUBLIC_UPLOADS_MB` (default 2048 MB of form files per sub-account, 0 = no cap of its own) and, in the
 * hosted cloud, the plan's media storage (fair use) – form files count in that meter like every other upload. A submission that
 * would pass a cap is refused with **413** before anything is written. The sub-account hears about it at 90 % and at 100 % (an e-mail to
 * the sub-account's address and a push/bell notice), once per level until the usage drops below 90 % again.
 * Other modules ask the gate through `app.services.publicUploadGate(locationId, bytes)`.
 */

const MB = 1024 * 1024;

/** The cap of the sub-account's own form files in bytes (null = none). */
export function publicUploadCap(): number | null {
  const raw = process.env.PGHL_PUBLIC_UPLOADS_MB;
  const mb = raw === undefined || raw.trim() === '' ? 2048 : Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return 2048 * MB;
  return mb === 0 ? null : Math.round(mb * MB);
}

export function publicUploadsUsed(app: App, locationId: string): number {
  try {
    return Number(app.db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM form_files WHERE location_id = ?', locationId)?.n ?? 0);
  } catch {
    return 0; // the forms module is not loaded
  }
}

type Meter = { scope: 'public' | 'plan'; used: number; limit: number };

const fmt = (bytes: number) => `${(bytes / MB).toLocaleString('de-DE', { maximumFractionDigits: 0 })} MB`;

export const publicUploadQuotaModule: Module = {
  name: 'public-upload-quota',
  migrations: [
    [
      '001-alerts',
      `CREATE TABLE public_upload_alerts (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, scope TEXT NOT NULL, level INTEGER NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (location_id, scope, level)
      );`,
    ],
    // The gate and the cloud's storage meter sum a sub-account's form files on every upload (forms is registered before this module).
    ['002-form-files-index', `CREATE INDEX IF NOT EXISTS form_files_location ON form_files(location_id, size);`],
  ],
  register(app) {
    const { db } = app;

    const meters = (locationId: string): Meter[] => {
      const out: Meter[] = [];
      const cap = publicUploadCap();
      if (cap !== null) out.push({ scope: 'public', used: publicUploadsUsed(app, locationId), limit: cap });
      // Hosted cloud: the plan's media storage (modules/cloud.ts) – form files are part of that meter.
      const plan = app.services.storageMeter?.(locationId) as { used: number; limit: number | null } | undefined;
      if (plan && plan.limit !== null) out.push({ scope: 'plan', used: plan.used, limit: plan.limit });
      return out;
    };

    /** Tells the sub-account once per level; a level that is no longer reached is armed again. */
    const alert = (locationId: string, m: Meter, level: number) => {
      if (!db.run('INSERT OR IGNORE INTO public_upload_alerts (location_id, scope, level, at) VALUES (?, ?, ?, ?)', locationId, m.scope, level, now()).changes) return;
      const what = m.scope === 'plan' ? 'Der Medien-Speicher deines Tarifs' : 'Der Speicher für Datei-Uploads aus öffentlichen Formularen';
      const title = level >= 100 ? `${what} ist voll` : `${what} ist zu ${level} % belegt`;
      const body =
        level >= 100
          ? `${what} ist voll (${fmt(m.used)} von ${fmt(m.limit)}). Formulare mit Datei-Upload werden abgelehnt, bis du alte Einsendungen mit Dateien löschst${m.scope === 'plan' ? ' oder mehr Speicher bekommst' : ' oder der Betreiber das Limit (PGHL_PUBLIC_UPLOADS_MB) erhöht'}.`
          : `${what} ist zu ${level} % belegt (${fmt(m.used)} von ${fmt(m.limit)}). Ist er voll, werden Formulare mit Datei-Upload abgelehnt. Lösche alte Einsendungen mit Dateien, um Platz zu schaffen.`;
      void notifyTeam(app, locationId, title, `${body}\n\n${app.baseUrl()}/app/forms`).catch(() => undefined);
      void Promise.resolve(app.services.pushNotify?.({ locationId, kind: 'storage', title, body, url: '/app/forms', tag: `upload-quota-${m.scope}`, urgency: level >= 100 ? 'high' : 'normal' })).catch(() => undefined);
    };
    /** Below 90 % again (files deleted, a bigger plan): both levels may be told again next time. */
    const rearm = (locationId: string, m: Meter) => {
      if (m.used < m.limit * 0.9) db.run('DELETE FROM public_upload_alerts WHERE location_id = ? AND scope = ?', locationId, m.scope);
    };

    /** Throws 413 when `incoming` more bytes of public uploads would pass a cap; tells the team at 90 % and 100 %. */
    app.services.publicUploadGate = (locationId: string, incoming: number) => {
      if (!(incoming > 0)) return;
      for (const m of meters(locationId)) {
        const after = m.used + incoming;
        rearm(locationId, m);
        if (after > m.limit) {
          alert(locationId, m, 100);
          throw new HttpError(413, 'Die Datei kann gerade nicht angenommen werden: der Speicherplatz für Uploads ist voll. Bitte sende das Formular ohne Datei oder melde dich direkt beim Anbieter.');
        }
        if (after >= m.limit * 0.9) alert(locationId, m, 90);
      }
    };
  },
};
