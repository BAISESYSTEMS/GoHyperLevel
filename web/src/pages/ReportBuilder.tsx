import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Check, Field, Input, Modal, Select, Spinner, Textarea, act, navigate } from '../ui';
import { Icon } from '../icons';
import { ReportView } from '../charts/ReportView';
import type { ReportResult } from '../charts/core';
import {
  BUCKETS,
  OP_LABELS,
  RangePicker,
  VISIBILITY,
  VIZ_LIST,
  localResult,
  applyViz,
  downloadCsv,
  emptyConfig,
  fieldOf,
  measureLabel,
  measureOptions,
  nextSlot,
  widgetSize,
  type Config,
  type FieldMeta,
  type Filter,
  type Meta,
  type SourceMeta,
} from './ReportKit';
import { useT } from '../i18n';

const valuesCache = new Map<string, Promise<{ value: string; label: string }[]>>();
function useValues(source: string, field: FieldMeta | undefined, scope: string) {
  const [list, setList] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (!field || (!field.lookup && field.type !== 'string' && field.type !== 'tags')) return setList([]);
    const key = `${source}|${field.key}|${scope}`;
    if (!valuesCache.has(key)) valuesCache.set(key, api.get(`/api/reports/values?source=${source}&field=${field.key}&scope=${scope}`).catch(() => []));
    void valuesCache.get(key)!.then(setList);
  }, [source, field?.key, scope]);
  return list;
}

function FilterRow({ src, f, scope, ranges, onChange, onRemove }: { src: SourceMeta; f: Filter; scope: string; ranges: Record<string, string>; onChange: (f: Filter) => void; onRemove: () => void }) {
  const t = useT('reports');
  const field = fieldOf(src, f.field);
  const values = useValues(src.key, field?.options ? undefined : field, scope);
  const options: [string, string][] = field?.options ? Object.entries(field.options) : values.map((v) => [v.value, v.label]);
  const ops = field?.ops ?? [];
  const multi = f.op === 'in' || f.op === 'not_in';
  const list = Array.isArray(f.value) ? (f.value as string[]) : [];
  let input = null;
  if (!field || ['empty', 'not_empty', 'is_true', 'is_false'].includes(f.op)) input = null;
  else if (field.type === 'date') {
    input =
      f.op === 'in_range' ? (
        <RangePicker value={(f.value as any) ?? 'last_30_days'} onChange={(v) => onChange({ ...f, value: v })} ranges={Object.fromEntries(Object.entries(ranges).filter(([k]) => k !== 'all'))} />
      ) : (
        <Input type="date" value={String(f.value ?? '')} onChange={(v) => onChange({ ...f, value: v })} />
      );
  } else if (field.type === 'number') {
    input =
      f.op === 'between' ? (
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <Input type="number" value={(f.value as any)?.[0] ?? ''} onChange={(v) => onChange({ ...f, value: [v, (f.value as any)?.[1] ?? ''] })} aria-label={t('von')} />
          <Input type="number" value={(f.value as any)?.[1] ?? ''} onChange={(v) => onChange({ ...f, value: [(f.value as any)?.[0] ?? '', v] })} aria-label={t('bis')} />
        </div>
      ) : (
        <Input type="number" value={String(f.value ?? '')} onChange={(v) => onChange({ ...f, value: v })} />
      );
  } else if (multi && options.length) {
    input = (
      <div className="rpt-chips">
        {list.map((v) => (
          <span key={v} className="tag">
            {options.find((o) => o[0] === v)?.[1] ?? v}
            <button type="button" aria-label={t('entfernen')} onClick={() => onChange({ ...f, value: list.filter((x) => x !== v) })}>
              ×
            </button>
          </span>
        ))}
        <Select value="" placeholder={t('+ Wert')} onChange={(v) => v && onChange({ ...f, value: [...list, v] })} options={options.filter((o) => !list.includes(o[0]))} />
      </div>
    );
  } else if (options.length && f.op !== 'contains' && f.op !== 'not_contains' && f.op !== 'starts_with') {
    input = <Select value={String(f.value ?? '')} placeholder={t('Wert wählen')} onChange={(v) => onChange({ ...f, value: v })} options={options} />;
  } else input = <Input value={String(f.value ?? '')} onChange={(v) => onChange({ ...f, value: v })} placeholder={t('Wert')} />;
  return (
    <div className="rpt-filter">
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'center' }}>
        <Select
          value={f.field}
          onChange={(v) => {
            const nf = fieldOf(src, v)!;
            onChange({ field: v, op: nf.ops[0], value: nf.type === 'date' ? 'last_30_days' : undefined });
          }}
          options={src.fields.map((x) => [x.key, x.label])}
        />
        <button className="icon-btn" onClick={onRemove} aria-label={t('Filter entfernen')}>
          ✕
        </button>
      </div>
      <Select value={f.op} onChange={(op) => onChange({ ...f, op, value: op === 'in' || op === 'not_in' ? (f.value ? [f.value].flat() : []) : Array.isArray(f.value) && op !== 'between' ? f.value[0] : f.value })} options={ops.map((o) => [o, OP_LABELS[o] ? t(OP_LABELS[o]) : o])} />
      {input}
    </div>
  );
}

function GroupRow({ src, value, onChange, onRemove, exclude }: { src: SourceMeta; value: string; onChange: (v: string) => void; onRemove: () => void; exclude?: string }) {
  const t = useT('reports');
  const [key, bucket] = value.split(':');
  const f = fieldOf(src, key);
  const groupable = src.fields.filter((x) => x.groupable && (x.key !== exclude || x.type === 'date'));
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'center', marginBottom: 6 }}>
      <div className="grow">
        <Select value={key} onChange={(v) => onChange(fieldOf(src, v)?.type === 'date' ? `${v}:${bucket || 'month'}` : v)} options={groupable.map((x) => [x.key, x.label])} />
      </div>
      {f?.type === 'date' && (
        <div style={{ width: 136, flex: 'none' }}>
          <Select value={bucket || 'month'} onChange={(b) => onChange(`${key}:${b}`)} options={BUCKETS.map(([k, l]) => [k, t(l)] as [string, string])} />
        </div>
      )}
      <button className="icon-btn" onClick={onRemove} aria-label={t('Gruppierung entfernen')}>
        ✕
      </button>
    </div>
  );
}

/** Save to the library (new or update). */
function SaveModal({ initial, onClose, onSave }: { initial: { name: string; description: string; visibility: string; isNew: boolean }; onClose: () => void; onSave: (v: { name: string; description: string; visibility: string; copy: boolean }) => void }) {
  const t = useT('reports');
  const [v, setV] = useState(initial);
  return (
    <Modal
      title={initial.isNew ? t('Bericht speichern') : t('Bericht aktualisieren')}
      onClose={onClose}
      footer={
        <>
          {!initial.isNew && (
            <button className="btn secondary" onClick={() => onSave({ ...v, copy: true })}>
              {t('Als Kopie speichern')}
            </button>
          )}
          <button className="btn" disabled={!v.name.trim()} onClick={() => onSave({ ...v, copy: false })}>
            {t('Speichern')}
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={v.name} onChange={(name) => setV({ ...v, name })} autoFocus />
      </Field>
      <Field label={t('Beschreibung')}>
        <Textarea value={v.description} onChange={(description) => setV({ ...v, description })} rows={2} />
      </Field>
      <Field label={t('Sichtbar für')}>
        <Select value={v.visibility} onChange={(visibility) => setV({ ...v, visibility })} options={VISIBILITY.map(([k, l]) => [k, t(l)] as [string, string])} />
      </Field>
    </Modal>
  );
}

function AddToDashboard({ cfg, title, onClose, preset }: { cfg: Config; title: string; onClose: () => void; preset?: string }) {
  const t = useT('reports');
  const [list, setList] = useState<any[]>();
  const [target, setTarget] = useState(preset ?? '');
  const [name, setName] = useState('Mein Dashboard');
  useEffect(() => {
    void api.get('/api/reports/dashboards').then((r) => {
      const mine = r.dashboards.filter((d: any) => d.can_edit);
      setList(mine);
      if (!preset) setTarget(mine[0]?.id ?? 'new');
    });
  }, []);
  const add = async () => {
    const size = widgetSize(cfg.viz);
    let dash = target === 'new' ? await act(() => api.post('/api/reports/dashboards', { name, widgets: [] })) : list?.find((d) => d.id === target);
    if (!dash) return;
    if (target !== 'new') dash = await api.get(`/api/reports/dashboards/${dash.id}`);
    const widgets = [...dash.widgets, { title, config: cfg, x: 0, y: nextSlot(dash.widgets), ...size }];
    const r = await act(() => api.patch(`/api/reports/dashboards/${dash.id}`, { widgets }), t('Zum Dashboard hinzugefügt'));
    if (r) navigate(`reports/d/${dash.id}`);
  };
  return (
    <Modal
      title={t('Zum Dashboard hinzufügen')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={add} disabled={!list}>
          {t('Hinzufügen')}
        </button>
      }
    >
      {!list ? (
        <Spinner />
      ) : (
        <>
          <Field label="Dashboard">
            <Select value={target} onChange={setTarget} options={[...list.map((d) => [d.id, d.name] as [string, string]), ['new', t('+ Neues Dashboard')]]} />
          </Field>
          {target === 'new' && (
            <Field label={t('Name des neuen Dashboards')}>
              <Input value={name} onChange={setName} />
            </Field>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Report builder: source → chart type → measures, groups, filters, range, scope; live preview,
 * CSV, save to the library, add to (or update a widget on) a dashboard.
 */
export function ReportBuilder({ meta, reportId }: { meta: Meta; reportId?: string }) {
  const t = useT('reports');
  const params = new URLSearchParams(location.search);
  const dashParam = params.get('dashboard') ?? undefined;
  const widgetParam = params.get('widget') ?? undefined;
  const [cfg, setCfg] = useState<Config | null>(null);
  const [title, setTitle] = useState(t('Neuer Bericht'));
  const [scope, setScope] = useState('location');
  const [saved, setSaved] = useState<any>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const shown = useMemo(() => result && localResult(result), [result, t]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'' | 'save' | 'dash'>('');
  const [table, setTable] = useState(false);
  const seq = useRef(0);

  // Start: a saved report, a dashboard widget, or a fresh report.
  useEffect(() => {
    (async () => {
      if (reportId) {
        const r = await api.get(`/api/reports/library/${reportId}`).catch(() => null);
        if (r) {
          setSaved(r);
          setTitle(r.name);
          return setCfg({ ...r.config, query: { filters: [], group_by: [], ...r.config.query } });
        }
      }
      if (dashParam && widgetParam) {
        const d = await api.get(`/api/reports/dashboards/${dashParam}`).catch(() => null);
        const w = d?.widgets.find((x: any) => x.id === widgetParam);
        if (w?.config) {
          setTitle(w.title);
          setScope(d.settings?.scope ?? 'location');
          return setCfg({ ...w.config, query: { filters: [], group_by: [], ...w.config.query } });
        }
      }
      const src = meta.sources.find((s) => s.key === params.get('source')) ?? meta.sources.find((s) => s.key === 'opportunities') ?? meta.sources[0];
      if (src) setCfg(emptyConfig(src, 'bar'));
    })();
  }, [reportId]);

  const src = cfg ? meta.sources.find((s) => s.key === cfg.query.source) : undefined;

  // Live preview (debounced; older answers are dropped).
  useEffect(() => {
    if (!cfg) return;
    const n = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api.post<ReportResult>('/api/reports/run', { query: cfg.query, scope });
        if (n === seq.current) {
          setResult(r);
          setError('');
        }
      } catch (e) {
        if (n === seq.current) setError((e as Error).message);
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [JSON.stringify(cfg?.query), scope]);

  if (!cfg || !src) return meta.sources.length ? <Spinner /> : <p className="muted">{t('Keine Datenquellen verfügbar.')}</p>;
  const q = cfg.query;
  const setQ = (patch: Partial<Config['query']>) => setCfg({ ...cfg, query: { ...q, ...patch } });
  const groupable = src.fields.filter((f) => f.groupable);
  const dateFields = src.fields.filter((f) => f.type === 'date');
  const single = ['kpi', 'pie', 'donut', 'funnel', 'heatmap', 'hbar', 'stacked'].includes(cfg.viz);

  const save = async (v: { name: string; description: string; visibility: string; copy: boolean }) => {
    const body = { name: v.name, description: v.description, visibility: v.visibility, config: { ...cfg, title: undefined } };
    const r = saved && !v.copy && saved.can_edit !== false ? await act(() => api.patch(`/api/reports/library/${saved.id}`, body), t('Bericht gespeichert')) : await act(() => api.post('/api/reports/library', body), t('Bericht gespeichert'));
    if (r) {
      setSaved({ ...r, can_edit: true });
      setTitle(r.name);
      setModal('');
      if (!saved || v.copy) navigate(`reports/r/${r.id}`);
    }
  };
  const updateWidget = async () => {
    const d = await api.get(`/api/reports/dashboards/${dashParam}`);
    const widgets = d.widgets.map((w: any) => (w.id === widgetParam ? { ...w, title, config: cfg, report_id: undefined } : w));
    const r = await act(() => api.patch(`/api/reports/dashboards/${dashParam}`, { widgets }), t('Widget aktualisiert'));
    if (r) navigate(`reports/d/${dashParam}`);
  };

  return (
    <div className="rpt-builder">
      <aside className="card rpt-config" data-tour="report-config">
        <Field label={t('Datenquelle')}>
          <Select
            value={src.key}
            onChange={(k) => {
              const ns = meta.sources.find((s) => s.key === k)!;
              setCfg(emptyConfig(ns, cfg.viz));
            }}
            options={meta.sources.map((s) => [s.key, s.label])}
          />
          {src.description && <small className="muted">{src.description}</small>}
        </Field>
        <div className="field">
          <span>{t('Darstellung')}</span>
          <div className="rpt-viz" role="radiogroup" aria-label={t('Darstellung')}>
            {VIZ_LIST.map(([v, label, icon]) => (
              <button key={v} type="button" role="radio" aria-checked={cfg.viz === v} className={cfg.viz === v ? 'on' : ''} onClick={() => setCfg(applyViz(src, cfg, v))} title={t(label)}>
                <Icon name={icon} size={18} />
                <span>{t(label)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>{t('Kennzahlen')}</span>
          {q.measures.map((m, i) => (
            <div key={m + i} className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'center', marginBottom: 6 }}>
              <div className="grow">
                <select value={m} onChange={(e) => setQ({ measures: q.measures.map((x, j) => (j === i ? e.target.value : x)) })}>
                  {measureOptions(src).map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <button className="icon-btn" disabled={q.measures.length < 2} onClick={() => setQ({ measures: q.measures.filter((_, j) => j !== i) })} aria-label={t('Kennzahl entfernen')}>
                ✕
              </button>
            </div>
          ))}
          {q.measures.length < 6 && (
            <button className="btn small secondary" onClick={() => setQ({ measures: [...q.measures, measureOptions(src)[0].items.find(([k]) => !q.measures.includes(k))?.[0] ?? 'count'] })}>
              {t('+ Kennzahl')}
            </button>
          )}
          {single && q.measures.length > 1 && <small className="muted">{t('Das Diagramm zeigt die erste Kennzahl, die Tabelle alle.')}</small>}
        </div>
        {cfg.viz !== 'kpi' && (
          <div className="field">
            <span>{t('Gruppieren nach')}</span>
            {q.group_by.map((g, i) => (
              <GroupRow key={i} src={src} value={g} exclude={q.group_by[1 - i]?.split(':')[0]} onChange={(v) => setQ({ group_by: q.group_by.map((x, j) => (j === i ? v : x)) })} onRemove={() => setQ({ group_by: q.group_by.filter((_, j) => j !== i) })} />
            ))}
            {q.group_by.length < 2 && groupable.length > 0 && (
              <button className="btn small secondary" onClick={() => setQ({ group_by: [...q.group_by, groupable.find((f) => !q.group_by.some((g) => g.startsWith(f.key)))?.key ?? groupable[0].key].map((g) => (fieldOf(src, g)?.type === 'date' && !g.includes(':') ? `${g}:month` : g)) })}>
                {t('+ Gruppierung')}
              </button>
            )}
          </div>
        )}
        <div className="field">
          <span>{t('Filter')}</span>
          {q.filters.map((f, i) => (
            <FilterRow key={i} src={src} f={f} scope={scope} ranges={meta.ranges} onChange={(nf) => setQ({ filters: q.filters.map((x, j) => (j === i ? nf : x)) })} onRemove={() => setQ({ filters: q.filters.filter((_, j) => j !== i) })} />
          ))}
          <button className="btn small secondary" onClick={() => setQ({ filters: [...q.filters, { field: src.fields[0].key, op: src.fields[0].ops[0], value: src.fields[0].type === 'date' ? 'last_30_days' : undefined }] })}>
            {t('+ Filter')}
          </button>
        </div>
        <div className="field">
          <span>{t('Zeitraum')}</span>
          <Select value={q.date_field || src.dateField} onChange={(v) => setQ({ date_field: v })} options={dateFields.map((f) => [f.key, f.label])} />
          <RangePicker value={q.range} onChange={(range) => setQ({ range })} ranges={meta.ranges} />
          <Check checked={!!q.compare} onChange={(compare) => setQ({ compare })} label={t('Mit Vorperiode vergleichen')} />
          <Check checked={!!cfg.fixed_range} onChange={(fixed_range) => setCfg({ ...cfg, fixed_range })} label={t('Zeitraum im Dashboard beibehalten')} />
        </div>
        {meta.canAgency && (
          <Field label={t('Sub-Accounts')}>
            <Select value={scope} onChange={setScope} options={[['location', t('Nur dieser Sub-Account')], ['all', t('Alle meine Sub-Accounts (Agentur)')]]} />
          </Field>
        )}
        {cfg.viz !== 'kpi' && q.group_by.length > 0 && (
          <Field label={t('Höchstens (Top N)')} hint={t('leer = alle')}>
            <Input type="number" min={1} max={1000} value={q.limit ?? ''} onChange={(v) => setQ({ limit: v ? Number(v) : undefined })} />
          </Field>
        )}
      </aside>

      <section className="rpt-preview" data-tour="report-preview">
        <div className="rpt-preview-head">
          <input className="rpt-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('Titel des Berichts')} />
          <div className="actions">
            <button className="btn secondary small" onClick={() => setTable(!table)} title={table ? t('Diagramm zeigen') : t('Tabelle zeigen')}>
              <Icon name={table ? 'vizBar' : 'vizTable'} /> {table ? t('Diagramm') : t('Tabelle')}
            </button>
            <button className="btn secondary small" onClick={() => act(() => downloadCsv(title, q, scope), t('CSV erstellt'))}>
              <Icon name="csv" /> CSV
            </button>
            {dashParam && widgetParam ? (
              <button className="btn small" onClick={updateWidget}>
                {t('Widget aktualisieren')}
              </button>
            ) : (
              <button className="btn secondary small" onClick={() => setModal('dash')}>
                <Icon name="grid" /> {t('Zum Dashboard')}
              </button>
            )}
            <button className="btn small" onClick={() => setModal('save')}>
              <Icon name="bookmark" /> {saved ? t('Speichern') : t('In Bibliothek speichern')}
            </button>
          </div>
        </div>
        <div className={`card rpt-preview-card${busy && result ? ' loading' : ''}`}>
          {saved && saved.can_edit === false && <p className="muted small">{t('Geteilter Bericht – Änderungen bitte als Kopie speichern.')}</p>}
          <div className="rpt-preview-meta muted small">
            {src.label} · {q.measures.map((m) => measureLabel(src, m)).join(', ')}
            {shown && ` · ${shown.range.label} (${shown.range.dates})`}
            {shown?.previous && t(' · Vorperiode {dates}', { dates: shown.previous.dates })}
          </div>
          {error ? <p className="rpt-error">{error}</p> : shown ? <ReportView r={shown} viz={cfg.viz} height={cfg.viz === 'kpi' ? 160 : 380} table={table} /> : <Spinner />}
        </div>
      </section>

      {modal === 'save' && (
        <SaveModal initial={{ name: saved?.name ?? title, description: saved?.description ?? '', visibility: saved?.visibility ?? 'private', isNew: !saved || saved.can_edit === false }} onClose={() => setModal('')} onSave={save} />
      )}
      {modal === 'dash' && <AddToDashboard cfg={cfg} title={title} preset={dashParam} onClose={() => setModal('')} />}
    </div>
  );
}
