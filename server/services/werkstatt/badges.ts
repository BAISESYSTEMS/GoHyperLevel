import type { App } from '../../core/app.js';
import type { VersionRow } from './store.js';

/**
 * The badge row on every plugin version ("Sicherheitsnetz"): static checks ✓, self-tests ✓, review ✓ (and the
 * second opinion), who signed it, and which model wrote it with which Denkstufe. Pure facts from what was stored.
 */

export interface Badges {
  static: boolean;
  /** null = nothing to test (no UI script, no handlers). */
  tests: boolean | null;
  tests_detail: string;
  review: { verdict: 'pass' | 'warn' | 'fail'; model: string } | null;
  second_opinion: { verdict: 'pass' | 'warn' | 'fail'; model: string } | null;
  signature: { state: string; label: string; gohigh: boolean } | null;
  model: string;
  effort: string;
  effort_note: string;
}

export function reviewsOf(app: App, versionId: string): { kind: string; verdict: 'pass' | 'warn' | 'fail'; model: string; created_at: string }[] {
  try {
    return app.db.all<any>('SELECT kind, verdict, model, created_at FROM plugin_security_reviews WHERE version_id = ? ORDER BY created_at DESC', versionId);
  } catch {
    return []; // no Marktplatz module
  }
}

export function versionBadges(app: App, v: VersionRow): Badges {
  const c: any = v.checks ?? {};
  const st = c.selftest;
  const handlers: any[] = st?.handlers ?? [];
  const ran = !!st && (!!st.ui?.ran || handlers.length > 0);
  const rs = reviewsOf(app, v.id);
  const first = rs.find((r) => r.kind === 'review' || !r.kind);
  const second = rs.find((r) => r.kind === 'second_opinion');
  const entries: any[] = st?.entries ?? [];
  return {
    static: !!c.static?.ok,
    tests: ran ? !!st.ok : null,
    tests_detail: ran ? [`${handlers.filter((h) => h.ok).length}/${handlers.length} Handler`, st.ui?.ran ? `Oberfläche ${st.ui.errors?.length ? 'mit Fehlern' : 'ok'}` : '', entries.length ? `${entries.filter((e) => e.ok).length}/${entries.length} Einstiegspunkte` : ''].filter(Boolean).join(' · ') : '',
    review: first ? { verdict: first.verdict, model: first.model } : null,
    second_opinion: second ? { verdict: second.verdict, model: second.model } : null,
    signature: v.meta?.signature ? { state: v.meta.signature.state, label: v.meta.signature.label, gohigh: v.meta.signature.gohigh } : null,
    model: v.meta?.ai?.model ?? '',
    effort: v.meta?.ai?.label ?? '',
    effort_note: v.meta?.ai?.note ?? '',
  };
}
