import type { Module } from '../core/app.js';
import { headOf } from '../services/community-pwa.js';

/**
 * The installable member app (docs/courses.md): the community's manifest, service worker and install banner (modules/community-pwa.ts) also
 * cover the course pages. When the sub-account has published courses the app opens on the member home – courses, learning paths and
 * community in one place – and gets a "Meine Kurse" shortcut; the course pages carry the manifest link, the iPhone home-screen meta
 * and the install script (`/portal-pwa.js`), and so can be added to the home screen just like the community.
 */

const CSS = `<style>
.cm-install{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:60;max-width:520px;margin:0 auto;display:flex;gap:12px;align-items:center;background:var(--panel,#fff);color:var(--text,#111);border:1px solid var(--line,#e5e7eb);border-radius:16px;padding:12px 12px 12px 16px;box-shadow:0 12px 40px rgba(0,0,0,.22)}
.cm-install .ic{font-size:26px}.cm-install .tx{flex:1;min-width:0;font-size:14.5px;line-height:1.35}.cm-install .tx span{color:var(--muted,#64748b)}
.cm-install .go{min-height:44px;padding:0 18px;border-radius:12px;border:0;background:var(--brand,#2563eb);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.cm-install .x{min-height:44px;min-width:44px;border:0;background:none;color:var(--muted,#64748b);font-size:18px;cursor:pointer;border-radius:12px}
.cm-install .go:hover,.cm-install .x:hover{filter:brightness(1.08)}.cm-install button:focus-visible{outline:3px solid var(--brand,#2563eb);outline-offset:2px}
@media (display-mode: standalone){.cm-install{display:none}}
</style>`;

export const coursePwaModule: Module = {
  name: 'course-pwa',
  register(app) {
    const hasCourses = (locationId: string) => !!app.db.get(`SELECT 1 FROM courses WHERE location_id = ? AND status = 'published' LIMIT 1`, locationId);

    app.services.memberAppManifest = [
      ...((app.services.memberAppManifest as unknown[] | undefined) ?? []),
      (m: any, p: { locationId: string; base: string; name?: string; title?: string }) => {
        if (!hasCourses(p.locationId)) return;
        const name = String(p.name ?? p.title ?? '').trim() || 'Mitgliederbereich';
        m.start_url = `${p.base}/?source=app`;
        m.description = `Kurse und Community von ${name}`;
        m.categories = ['education', 'social'];
        m.shortcuts = [{ name: 'Meine Kurse', url: `${p.base}/`, icons: [{ src: `${p.base}/icon/192.png`, sizes: '192x192', type: 'image/png' }] }, ...(m.shortcuts ?? [])];
      },
    ];

    app.services.courseHead = [
      ...((app.services.courseHead as unknown[] | undefined) ?? []),
      (p: { base: string; name?: string; title?: string; color?: string }) => {
        const raw = app.services.contactPushRaw as { publicKey?: string } | undefined;
        return `${headOf({ base: p.base, name: String(p.name ?? p.title ?? ''), color: String(p.color ?? '') }, raw?.publicKey)}${CSS}`;
      },
    ];
    app.services.courseScripts = [...((app.services.courseScripts as string[] | undefined) ?? []), '/portal-pwa.js'];
  },
};
