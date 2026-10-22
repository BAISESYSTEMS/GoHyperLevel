import { useMemo, useState, type CSSProperties } from 'react';
import { amount, api, dt, name } from '../api';
import { useT } from '../i18n';
import { TagChips } from '../tag-chip';
import { useTags } from '../tags';
import { act, Badge, confirmAsk, Input, Select, useLoad } from '../ui';
import { closeInfo, LOST_TEXT, sums } from './deal-kit';
import { BulkBar, cleanFilters, ColumnsModal, DataTable, FilterRows, ListPager, SmartListTabs, type ListField, type ListViewConfig } from './ListKit';
import './deals.css';
import { useSimple } from '../areas/fields';
import { DEAL_COLUMNS, defaultColumns } from '../areas/easy-core';

/**
 * The opportunity list (Opportunities → Liste): every deal of every pipeline in a table with the columns you choose, sorting,
 * advanced filters on the deal's fields and properties, smart lists per person or team (pinned default, "+ Smart List") and
 * bulk actions – stage, owner, tags of the contacts, delete (one undo entry), CSV export. Filtering and sorting run on the server
 * (`GET /api/opportunities?filters=…&sort=…`, services/deal-query.ts).
 */

const PAGE = 50;
const BASE_VIEW: Omit<ListViewConfig, 'columns'> = { filters: [], sort: '-updated_at', q: '' };
/** Status values → German labels (message ids of the deals catalog). */
const STATUS_TEXT: Record<string, string> = { open: 'Offen', won: 'Gewonnen', lost: 'Verloren', abandoned: 'Aufgegeben' };

export function DealList({ pipelines, onOpen, version = 0 }: { pipelines: any[]; onOpen: (o: any) => void; version?: number }) {
  const t = useT('deals');
  const tags = useTags();
  // Einfach-Modus starts with five columns – name, contact, stage, value, expected close; "Spalten" adds the rest.
  const simple = useSimple();
  const DEFAULT_COLUMNS = defaultColumns(DEAL_COLUMNS, simple);
  const BASE: ListViewConfig = { ...BASE_VIEW, columns: DEFAULT_COLUMNS };
  const users = useLoad(() => api.get<{ id: string; name: string }[]>('/api/location-users').catch(() => []), []);
  const props = useLoad(() => api.get<any>('/api/properties?object=opportunity').catch(() => ({ properties: [] })), []);
  const [view, setView] = useState<ListViewConfig>(BASE);
  const [active, setActive] = useState('');
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [cols, setCols] = useState(false);
  const [bulkStage, setBulkStage] = useState('');
  const [bulkOwner, setBulkOwner] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const set = (patch: Partial<ListViewConfig>) => (setView({ ...view, ...patch }), setPage(0));

  // Stages of every pipeline as "Pipeline › Stufe" (filters, the bulk move and the cells).
  const stageOpts = pipelines.flatMap((p) => p.stages.map((s: any) => [`${p.id}:${s.id}`, `${p.name} › ${s.name}`] as [string, string]));
  const stageName = (o: any) => pipelines.find((p) => p.id === o.pipeline_id)?.stages.find((s: any) => s.id === o.stage_id)?.name ?? '–';
  const fields: ListField[] = useMemo(
    () => [
      { key: 'name', label: t('Name'), type: 'text' },
      { key: 'contact_name', label: t('Kontakt'), type: 'text' },
      { key: 'contact_email', label: t('E-Mail'), type: 'email' },
      { key: 'contact_phone', label: t('Telefon'), type: 'phone' },
      { key: 'contact_company', label: t('Firma'), type: 'text' },
      { key: 'pipeline_id', label: t('Pipeline'), type: 'select', options: pipelines.map((p) => p.id), optionLabels: Object.fromEntries(pipelines.map((p) => [p.id, p.name])) },
      { key: 'stage_id', label: t('Stufe'), type: 'select', options: pipelines.flatMap((p) => p.stages.map((s: any) => s.id)), optionLabels: Object.fromEntries(pipelines.flatMap((p) => p.stages.map((s: any) => [s.id, `${p.name} › ${s.name}`]))) },
      { key: 'status', label: t('Status'), type: 'select', options: Object.keys(STATUS_TEXT), optionLabels: Object.fromEntries(Object.entries(STATUS_TEXT).map(([k, v]) => [k, t(v)])) },
      { key: 'value', label: t('Wert'), type: 'number' },
      { key: 'currency', label: t('Währung'), type: 'select', options: ['EUR', 'USD', 'CHF', 'GBP'] },
      { key: 'assigned_to', label: t('Zuständig'), type: 'user' },
      { key: 'tags', label: t('Tags'), type: 'multiselect', options: tags },
      { key: 'expected_close_date', label: t('Erwarteter Abschluss'), type: 'date' },
      { key: 'source', label: t('Quelle'), type: 'text' },
      { key: 'lost_reason', label: t('Verlustgrund'), type: 'text' },
      { key: 'created_at', label: t('Angelegt'), type: 'datetime' },
      { key: 'updated_at', label: t('Geändert'), type: 'datetime' },
      { key: 'stage_changed_at', label: t('In der Stufe seit'), type: 'datetime' },
      ...((props.data?.properties ?? []) as any[]).filter((p) => p.type !== 'file').map((p) => ({ key: `props.${p.key}`, label: p.label, type: p.type, options: p.options })),
    ],
    [pipelines, tags, props.data, t],
  );

  const filters = cleanFilters(view.filters);
  const qs = new URLSearchParams({ status: 'all', sort: view.sort, ...(view.q ? { q: view.q } : {}), ...(filters.length ? { filters: JSON.stringify(filters) } : {}) }).toString();
  const rows = useLoad(() => api.get<any[]>(`/api/opportunities?${qs}`), [qs, version]);
  const list = rows.data ?? [];
  const shown = list.slice(page * PAGE, (page + 1) * PAGE);
  const chosen = list.filter((o) => sel.includes(o.id));

  const cell = (o: any, f: ListField) => {
    if (f.key.startsWith('props.')) {
      const v = o.props?.[f.key.slice(6)];
      return v === undefined || v === null || v === '' ? <span className="muted">–</span> : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? t('ja') : t('nein')) : String(v);
    }
    switch (f.key) {
      case 'name':
        return o.name;
      case 'contact_name':
        return name(o);
      case 'contact_email':
        return o.email || <span className="muted">–</span>;
      case 'contact_phone':
        return o.phone || <span className="muted">–</span>;
      case 'contact_company':
        return o.contact_company || <span className="muted">–</span>;
      case 'pipeline_id':
        return pipelines.find((p) => p.id === o.pipeline_id)?.name ?? '–';
      case 'stage_id': {
        const st = pipelines.find((p) => p.id === o.pipeline_id)?.stages.find((s: any) => s.id === o.stage_id);
        return (
          <span className="stage-cell">
            <span className="stage-dot" style={{ '--stage': st?.color || 'var(--line)' } as CSSProperties} aria-hidden="true" />
            {stageName(o)}
          </span>
        );
      }
      case 'status':
        return o.status === 'open' ? t('Offen') : <Badge tone={o.status === 'won' ? 'green' : 'red'}>{LOST_TEXT[o.status] ? t(LOST_TEXT[o.status]) : o.status}</Badge>;
      case 'value':
        return amount(o.value, o.currency);
      case 'currency':
        return o.currency;
      case 'assigned_to':
        return o.assigned_to ? (users.data?.find((u) => u.id === o.assigned_to)?.name ?? '…') : <span className="muted">{t('Niemand')}</span>;
      case 'tags':
        return <TagChips tags={o.contact_tags} max={3} />;
      case 'expected_close_date': {
        const c = closeInfo(o);
        return c ? <span className={c.late ? 'deal-close late' : undefined}>{c.label}</span> : <span className="muted">–</span>;
      }
      case 'created_at':
      case 'updated_at':
      case 'stage_changed_at':
        return o[f.key] ? dt(o[f.key]) : '–';
      default:
        return o[f.key] ?? '–';
    }
  };

  const done = (n?: number) => {
    setSel([]);
    void rows.reload();
    return n;
  };
  const bulk = async (body: Record<string, unknown>, ok: string) => {
    const r = await act(() => api.post<{ count: number; skipped: number }>('/api/opportunities/bulk', { ids: sel, ...body }), ok);
    if (r) done(r.count);
  };
  const moveStage = (v: string) => {
    setBulkStage('');
    if (!v) return;
    const [pipeline_id, stage_id] = v.split(':');
    void bulk({ action: 'stage', pipeline_id, stage_id }, t('Stufe geändert'));
  };
  const setOwner = (v: string) => {
    setBulkOwner('');
    if (!v) return;
    void bulk({ action: 'owner', assigned_to: v === '-' ? null : v }, t('Zuständigkeit geändert'));
  };
  const tagContacts = async (action: 'add_tag' | 'remove_tag') => {
    const tag = bulkTag.trim();
    if (!tag) return;
    const ids = [...new Set(chosen.map((o) => o.contact_id))];
    if (await act(() => api.post('/api/contacts/bulk', { action, tag, ids }), action === 'add_tag' ? t('Tag hinzugefügt') : t('Tag entfernt'))) (setBulkTag(''), done());
  };
  const remove = async () => {
    if (!confirmAsk(t.plural(sel.length, { one: '{n} Deal löschen?', other: '{n} Deals löschen?' }))) return;
    await bulk({ action: 'delete' }, t('Gelöscht – im Verlauf rückgängig zu machen'));
  };
  const loc = encodeURIComponent(localStorage.getItem('pghl.location') ?? '');
  const exportHref = (ids?: string[]) => `/api/opportunities/export.csv?${qs}${ids?.length ? `&ids=${ids.join(',')}` : ''}&locationId=${loc}`;

  return (
    <div className="deal-list" data-tour="opps-list">
      <SmartListTabs object="opportunity" allLabel={t('Alle Deals')} base={BASE} current={view} active={active} onApply={(id, c) => (setActive(id), setView({ ...BASE, ...c, columns: c.columns?.length ? c.columns : DEFAULT_COLUMNS }), setPage(0), setSel([]))} />
      <div className="list-toolbar">
        <div className="grow" style={{ maxWidth: 320 }}>
          <Input value={view.q} onChange={(q) => set({ q })} placeholder={t('Suchen…')} aria-label={t('Deals durchsuchen')} />
        </div>
        <button className={`btn small${showFilters || filters.length ? '' : ' secondary'}`} aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)} data-tour="opps-list-filters">
          {filters.length ? t('Filter ({n})', { n: filters.length }) : t('Filter')}
        </button>
        <button className="btn small secondary" onClick={() => setCols(true)} data-tour="opps-list-columns">
          {t('Spalten')}
        </button>
        <a className="btn small secondary" href={exportHref()} data-tour="opps-list-export">
          {t('CSV exportieren')}
        </a>
        <span className="muted small">
          {t.plural(list.length, { one: '{n} Deal', other: '{n} Deals' })} · {sums(list)}
          {list.length >= 2000 && ` · ${t('die ersten 2.000 – Filter eingrenzen')}`}
        </span>
      </div>
      {showFilters && (
        <div className="list-filters">
          <FilterRows fields={fields} value={view.filters} onChange={(f) => set({ filters: f })} users={users.data ?? []} />
        </div>
      )}
      <BulkBar count={sel.length} onClear={() => setSel([])}>
        <div style={{ width: 190 }}>
          <Select value={bulkStage} onChange={moveStage} placeholder={t('Stufe ändern…')} aria={t('Stufe der gewählten Deals ändern')} options={stageOpts} />
        </div>
        <div style={{ width: 160 }}>
          <Select value={bulkOwner} onChange={setOwner} placeholder={t('Zuständig…')} aria={t('Zuständige Person der gewählten Deals')} options={[['-', t('Niemand')], ...(users.data ?? []).map((u) => [u.id, u.name] as [string, string])]} />
        </div>
        <span className="row" style={{ gap: 4 }}>
          <Input value={bulkTag} onChange={setBulkTag} list="deal-bulk-tags" placeholder={t('Tag')} aria-label={t('Tag für die Kontakte der gewählten Deals')} style={{ width: 130 }} />
          <datalist id="deal-bulk-tags">
            {tags.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <button className="btn small secondary" disabled={!bulkTag.trim()} onClick={() => tagContacts('add_tag')}>
            + {t('Tag')}
          </button>
          <button className="btn small secondary" disabled={!bulkTag.trim()} onClick={() => tagContacts('remove_tag')}>
            − {t('Tag')}
          </button>
        </span>
        <a className="btn small secondary" href={exportHref(sel)}>
          {t('CSV exportieren')}
        </a>
        <button className="btn small danger" onClick={remove}>
          {t('Löschen')}
        </button>
      </BulkBar>
      {rows.data && !list.length ? (
        <p className="muted">{filters.length || view.q ? t('Keine Deals für diese Filter.') : t('Noch keine Deals.')}</p>
      ) : (
        <DataTable fields={fields} columns={view.columns} rows={shown} cell={cell} sort={view.sort} onSort={(sort) => set({ sort })} onRow={onOpen} selected={sel} onSelect={setSel} caption={t('Deals')} />
      )}
      <ListPager total={list.length} page={page} size={PAGE} onPage={setPage} />
      {cols && <ColumnsModal fields={fields} value={view.columns} onChange={(columns) => set({ columns })} onClose={() => setCols(false)} />}
    </div>
  );
}

