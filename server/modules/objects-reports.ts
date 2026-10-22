import type { App, Module } from '../core/app.js';
import type { ReportField, ReportSource } from '../services/report-engine.js';
import { contactJoin, lookupTable, userLookup } from '../services/report-sources.js';
import { COMPANY_SIZES, CUSTOM_OBJECT_RE, KEY_RE, LIFECYCLE_STAGES } from '../services/objects.js';

/**
 * Companies, custom object records and lead scores as sources for Berichte (app.services.reportSources).
 * Custom objects differ per sub-account, so their sources (one per object key, its properties as
 * dimensions and measures) are rebuilt whenever object types or properties change.
 */

const LINK = (other: string) => `((a.a_type = 'company' AND a.a_id = c.id AND a.b_type = '${other}') OR (a.b_type = 'company' AND a.b_id = c.id AND a.a_type = '${other}'))`;
const DEAL_SUM = (cond: string) =>
  `(SELECT COALESCE(SUM(o.value), 0) FROM associations a JOIN opportunities o ON o.id = CASE WHEN a.a_type = 'company' THEN a.b_id ELSE a.a_id END WHERE a.location_id = c.location_id AND ${LINK('opportunity')} AND ${cond})`;
const LINK_COUNT = (other: string) => `(SELECT COUNT(*) FROM associations a WHERE a.location_id = c.location_id AND ${LINK(other)})`;
const options = (list: string[]) => Object.fromEntries(list.map((o) => [o, o]));

/** Report fields for typed properties stored as JSON (`col` = the JSON column). */
function propertyFields(defs: { key: string; label: string; type: string; options?: string[]; locations?: string[] }[], col: string, prefix: string, group?: string): ReportField[] {
  const out: ReportField[] = [];
  for (const d of defs) {
    if (!KEY_RE.test(d.key)) continue;
    const sql = `json_extract(${col}, '$.${d.key}')`;
    const key = `${prefix}${d.key}`;
    // Properties are per sub-account: only callers of those sub-accounts see the field (scopeSources).
    const g = { ...(group ? { group } : {}), ...(d.locations ? { locations: d.locations } : {}) };
    switch (d.type) {
      case 'number':
        out.push({ key, label: d.label, type: 'number', sql: `CAST(${sql} AS REAL)`, format: 'number', ...g });
        break;
      case 'currency':
        out.push({ key, label: d.label, type: 'number', sql: `CAST(${sql} AS REAL)`, format: 'money', ...g });
        break;
      case 'date':
      case 'datetime':
        out.push({ key, label: d.label, type: 'date', sql, ...g });
        break;
      case 'select':
        out.push({ key, label: d.label, type: 'enum', sql, options: options(d.options ?? []), empty: '(leer)', ...g });
        break;
      case 'multiselect':
        out.push({ key, label: d.label, type: 'tags', sql: `COALESCE(${sql}, '[]')`, ...g });
        break;
      case 'checkbox':
        out.push({ key, label: d.label, type: 'boolean', sql: `(CASE WHEN ${sql} = 1 THEN 1 ELSE 0 END)`, options: { 1: 'Ja', 0: 'Nein' }, ...g });
        break;
      case 'user':
        out.push({ key, label: d.label, type: 'string', sql, lookup: userLookup, empty: 'Niemand', ...g });
        break;
      case 'textarea':
      case 'file':
        break;
      default:
        out.push({ key, label: d.label, type: 'string', sql, empty: '(leer)', ...g });
    }
  }
  return out;
}

/** Property definitions per object key over all sub-accounts (first definition of a key wins; `locations` = where it exists). */
function defsByObject(app: App): Map<string, { key: string; label: string; type: string; options: string[]; locations: string[] }[]> {
  const out = new Map<string, { key: string; label: string; type: string; options: string[]; locations: string[] }[]>();
  for (const p of app.db.all('SELECT location_id, object_key, key, label, type, options FROM object_properties ORDER BY created_at')) {
    const list = out.get(p.object_key) ?? [];
    const have = list.find((x) => x.key === p.key);
    if (have) {
      if (!have.locations.includes(p.location_id)) have.locations.push(p.location_id);
    } else list.push({ key: p.key, label: p.label, type: p.type, options: JSON.parse(p.options || '[]'), locations: [p.location_id] });
    out.set(p.object_key, list);
  }
  return out;
}

export function companySource(app: App): ReportSource {
  const custom = defsByObject(app).get('company') ?? [];
  return {
    key: 'companies',
    label: 'Firmen',
    description: 'Firmen mit Branche, Größe, Phase, Zuständigem und dem Wert der verknüpften Deals',
    area: 'contacts',
    from: 'companies c',
    location: 'c.location_id',
    dateField: 'created_at',
    countLabel: 'Anzahl Firmen',
    requires: ['companies', 'associations'],
    fields: [
      { key: 'created_at', label: 'Angelegt am', type: 'date', sql: 'c.created_at' },
      { key: 'updated_at', label: 'Geändert am', type: 'date', sql: 'c.updated_at' },
      { key: 'name', label: 'Name', type: 'string', sql: 'c.name', noGroup: true },
      { key: 'industry', label: 'Branche', type: 'string', sql: 'c.industry', empty: 'Ohne Branche' },
      { key: 'size', label: 'Größe', type: 'enum', sql: 'c.size', options: options(COMPANY_SIZES), empty: 'Unbekannt' },
      { key: 'lifecycle_stage', label: 'Phase', type: 'enum', sql: 'c.lifecycle_stage', options: Object.fromEntries(LIFECYCLE_STAGES), empty: 'Ohne Phase' },
      { key: 'owner', label: 'Zuständig', type: 'string', sql: 'c.owner_id', lookup: userLookup, empty: 'Nicht zugewiesen' },
      { key: 'city', label: 'Ort', type: 'string', sql: 'c.city', empty: 'Unbekannt' },
      { key: 'country', label: 'Land', type: 'string', sql: 'c.country', empty: 'Unbekannt' },
      { key: 'source', label: 'Quelle', type: 'string', sql: 'c.source', empty: 'Unbekannt' },
      { key: 'domain', label: 'Domain', type: 'string', sql: 'c.domain', noGroup: true },
      { key: 'deals_value', label: 'Deal-Wert (ohne verlorene)', type: 'number', sql: DEAL_SUM(`o.status != 'lost'`), format: 'money' },
      { key: 'won_value', label: 'Gewonnener Deal-Wert', type: 'number', sql: DEAL_SUM(`o.status = 'won'`), format: 'money' },
      { key: 'open_value', label: 'Offener Deal-Wert', type: 'number', sql: DEAL_SUM(`o.status = 'open'`), format: 'money' },
      { key: 'deals_count', label: 'Anzahl Deals', type: 'number', sql: LINK_COUNT('opportunity'), format: 'number' },
      { key: 'contacts_count', label: 'Anzahl Kontakte', type: 'number', sql: LINK_COUNT('contact'), format: 'number' },
      ...propertyFields(custom, 'c.custom', 'custom_', 'Eigene Eigenschaften'),
    ],
    calcs: [
      { key: 'avg_deal_value', label: 'Ø Deal-Wert je Firma', sql: `AVG(${DEAL_SUM(`o.status != 'lost'`)})`, format: 'money' },
      { key: 'with_deals', label: 'Firmen mit Deals', sql: `SUM(CASE WHEN ${LINK_COUNT('opportunity')} > 0 THEN 1 ELSE 0 END)`, format: 'number' },
    ],
  };
}

/** One source per custom object key ("Fahrzeuge (Objekt)"), properties as fields. */
export function recordSources(app: App): ReportSource[] {
  const defs = defsByObject(app);
  const seen = new Set<string>();
  const out: ReportSource[] = [];
  const types = app.db.all('SELECT key, singular, plural, location_id FROM object_types ORDER BY created_at');
  for (const t of types) {
    if (seen.has(t.key) || !CUSTOM_OBJECT_RE.test(t.key)) continue;
    seen.add(t.key);
    out.push({
      // Object types are per sub-account: the source (and its name) is only visible there.
      locations: [...new Set(types.filter((x) => x.key === t.key).map((x) => String(x.location_id)))],
      key: `records_${t.key}`,
      label: `${t.plural} (Objekt)`,
      description: `Datensätze des eigenen Objekts „${t.plural}“`,
      area: 'contacts',
      from: 'object_records r JOIN object_types ot ON ot.id = r.type_id',
      location: 'r.location_id',
      where: `ot.key = '${t.key}'`,
      dateField: 'created_at',
      countLabel: `Anzahl ${t.plural}`,
      requires: ['object_records'],
      fields: [
        { key: 'created_at', label: 'Angelegt am', type: 'date', sql: 'r.created_at' },
        { key: 'updated_at', label: 'Geändert am', type: 'date', sql: 'r.updated_at' },
        { key: 'display', label: t.singular, type: 'string', sql: 'r.display', noGroup: true },
        { key: 'owner', label: 'Zuständig', type: 'string', sql: 'r.owner_id', lookup: userLookup, empty: 'Nicht zugewiesen' },
        { key: 'contacts_count', label: 'Verknüpfte Kontakte', type: 'number', sql: `(SELECT COUNT(*) FROM associations a WHERE (a.a_id = r.id AND a.b_type = 'contact') OR (a.b_id = r.id AND a.a_type = 'contact'))`, format: 'number' },
        ...propertyFields(defs.get(t.key) ?? [], 'r.properties', 'p_'),
      ],
    });
  }
  return out;
}

export function leadScoreSource(): ReportSource {
  const sc = contactJoin('s.contact_id');
  return {
    key: 'lead_scores',
    label: 'Lead-Scores',
    description: 'Aktueller Score je Kontakt und Modell mit Schwelle (z. B. MQL/SQL)',
    area: 'contacts',
    from: 'lead_scores s JOIN lead_score_models m ON m.id = s.model_id',
    location: 's.location_id',
    dateField: 'changed_at',
    countLabel: 'Bewertete Kontakte',
    requires: ['lead_scores'],
    joins: sc.joins,
    fields: [
      { key: 'model', label: 'Modell', type: 'string', sql: 's.model_id', lookup: lookupTable('lead_score_models', 'name') },
      { key: 'label', label: 'Schwelle', type: 'string', sql: 's.label', empty: 'Unter allen Schwellen' },
      { key: 'score', label: 'Score', type: 'number', sql: 's.score', format: 'number' },
      { key: 'primary', label: 'Haupt-Score', type: 'boolean', sql: '(CASE WHEN m.is_primary = 1 THEN 1 ELSE 0 END)', options: { 1: 'Ja', 0: 'Nein' } },
      { key: 'changed_at', label: 'Zuletzt geändert', type: 'date', sql: 's.changed_at' },
      { key: 'calculated_at', label: 'Berechnet am', type: 'date', sql: 's.calculated_at' },
      { key: 'last_engagement_at', label: 'Letzte Aktivität', type: 'date', sql: 's.last_engagement_at' },
      ...sc.fields,
    ],
    calcs: [
      { key: 'avg_score', label: 'Ø Score', sql: 'AVG(s.score)', format: 'number' },
      { key: 'qualified', label: 'Über einer Schwelle', sql: `SUM(CASE WHEN s.label != '' THEN 1 ELSE 0 END)`, format: 'number' },
      { key: 'qualified_rate', label: 'Anteil über einer Schwelle', sql: `100.0 * SUM(CASE WHEN s.label != '' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)`, format: 'percent' },
    ],
  };
}

const MINE = (key: string) => key === 'companies' || key === 'lead_scores' || key.startsWith('records_');

export const objectsReportsModule: Module = {
  name: 'objects-reports',
  register(app) {
    let signature = '';
    const sync = (force = false) => {
      const sig = JSON.stringify(app.db.get(`SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM object_types) AS t, (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM object_properties) AS p`));
      if (!force && sig === signature) return;
      signature = sig;
      app.services.reportSources = [...((app.services.reportSources ?? []) as ReportSource[]).filter((s) => !MINE(s.key)), companySource(app), ...recordSources(app), leadScoreSource()];
    };
    // Registered now (the reports module keeps what is there) and rebuilt after the last module registered.
    sync(true);
    setImmediate(() => {
      try {
        sync(true);
      } catch {
        /* app closed right after start (CLI, tests) */
      }
    });
    // Object types and properties change through the API (and snapshots): rebuild after writes.
    app.afterWrite.push(() => sync());
    app.services.objectReportSourcesSync = () => sync(true);
  },
};
