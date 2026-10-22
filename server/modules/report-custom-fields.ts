import type { App, Module } from '../core/app.js';
import type { ReportField, ReportSource } from '../services/report-engine.js';

/**
 * Eigene Kontaktfelder als Kennzahl und Dimension in Berichten & Dashboards – docs/reports.md#own-contact-fields. The built-in
 * source „Kontakte“ gets one field per custom field of the sub-account (group „Eigene Felder“): number fields can be summed,
 * averaged, min/max'd (and used in dashboard widgets), selects/checkboxes/dates/texts group and filter. Fields are per
 * sub-account (`locations`), so a caller only sees the fields of their own sub-accounts. Rebuilt when custom fields change.
 */

const KEY = /^[a-z0-9_]{1,60}$/;

export function customFieldReportFields(defs: { location_id: string; key: string; label: string; type: string; options: string }[], col = 'c.custom'): ReportField[] {
  const by = new Map<string, { key: string; label: string; type: string; options: string[]; locations: string[] }>();
  for (const d of defs) {
    if (!KEY.test(d.key) || d.type === 'textarea') continue;
    const have = by.get(d.key);
    if (have) {
      if (!have.locations.includes(d.location_id)) have.locations.push(d.location_id);
      continue;
    }
    let options: string[] = [];
    try {
      options = JSON.parse(d.options || '[]').map(String);
    } catch {
      /* none */
    }
    by.set(d.key, { key: d.key, label: d.label, type: d.type, options, locations: [d.location_id] });
  }
  const out: ReportField[] = [];
  for (const d of by.values()) {
    const sql = `json_extract(${col}, '$.${d.key}')`;
    const base = { key: `cf_${d.key}`, label: d.label, group: 'Eigene Felder', locations: d.locations };
    switch (d.type) {
      case 'number':
        out.push({ ...base, type: 'number', sql: `CAST(NULLIF(REPLACE(CAST(${sql} AS TEXT), ',', '.'), '') AS REAL)`, format: 'number' } as ReportField);
        break;
      case 'date':
        out.push({ ...base, type: 'date', sql: `NULLIF(${sql}, '')` } as ReportField);
        break;
      case 'select':
        out.push({ ...base, type: 'enum', sql, options: Object.fromEntries(d.options.map((o) => [o, o])), empty: '(leer)' } as ReportField);
        break;
      case 'checkbox':
        out.push({ ...base, type: 'boolean', sql: `(CASE WHEN ${sql} IN (1, '1', 'true', 'ja', 'yes') THEN 1 ELSE 0 END)`, options: { 1: 'Ja', 0: 'Nein' } } as ReportField);
        break;
      default:
        out.push({ ...base, type: 'string', sql: `NULLIF(${sql}, '')`, empty: '(leer)' } as ReportField);
    }
  }
  return out;
}

export const reportCustomFieldsModule: Module = {
  name: 'report-custom-fields',
  register(app: App) {
    let base: ReportField[] | null = null;
    let signature = '';
    const sync = (force = false) => {
      const sources = (app.services.reportSources ?? []) as ReportSource[];
      const i = sources.findIndex((s) => s.key === 'contacts');
      if (i < 0) return;
      const sig = JSON.stringify(app.db.get("SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), '') || ':' || COALESCE(SUM(LENGTH(label) + LENGTH(type) + LENGTH(options)), 0) AS s FROM custom_fields"));
      if (!force && sig === signature && base) return;
      signature = sig;
      base ??= sources[i].fields.filter((f) => !String(f.key).startsWith('cf_'));
      const defs = app.db.all<any>('SELECT location_id, key, label, type, options FROM custom_fields ORDER BY position, created_at');
      const next = [...sources];
      next[i] = { ...sources[i], fields: [...base, ...customFieldReportFields(defs)] };
      app.services.reportSources = next;
    };
    // After every module registered (the reports module puts the built-in sources in), and after changes to custom fields.
    setImmediate(() => {
      try {
        sync(true);
      } catch {
        /* app closed right after start (CLI, tests) */
      }
    });
    app.afterWrite.push((ctx) => {
      if (ctx.path.startsWith('/api/custom-fields') || ctx.path.startsWith('/api/snapshots')) sync();
    });
    app.services.reportCustomFields = { sync: () => sync(true) };
  },
};
