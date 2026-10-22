import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons';
import { api, d, dt, euro, name } from '../api';
import { CanvasPin } from '../canvas/pin';
import { Badge, Check, Empty, Field, Input, Link, Modal, PageHead, Select, Spinner, Tabs, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import {
  AssociationsPanel,
  ColumnsModal,
  CsvImportModal,
  FilterRows,
  LIFECYCLE,
  Notes,
  Pager,
  PropValue,
  PropertyCard,
  RecordTable,
  Timeline,
  ViewsBar,
  cleanFilters,
  useUsers,
  type FieldDef,
  type Filter,
  type ViewConfig,
} from './ObjectKit';
import { MoreFields, useSimple } from '../areas/fields';
import { COMPANY_COLUMNS, defaultColumns } from '../areas/easy-core';
import '../areas/easy-core.css';
import { SortableGrid } from '../sortable/Sortable';

/** Firmen: list with filters, columns and saved views; company page with everything linked to it. */

const SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
export const COMPANY_STANDARD: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'domain', label: 'Domain', type: 'text' },
  { key: 'industry', label: 'Branche', type: 'text' },
  { key: 'size', label: 'Größe', type: 'select', options: SIZES },
  { key: 'lifecycle_stage', label: 'Phase', type: 'select', options: Object.keys(LIFECYCLE), optionLabels: LIFECYCLE },
  { key: 'owner_id', label: 'Zuständig', type: 'user' },
  { key: 'phone', label: 'Telefon', type: 'phone' },
  { key: 'website', label: 'Webseite', type: 'url' },
  { key: 'address', label: 'Adresse', type: 'text' },
  { key: 'postal_code', label: 'PLZ', type: 'text' },
  { key: 'city', label: 'Ort', type: 'text' },
  { key: 'country', label: 'Land', type: 'text' },
  { key: 'description', label: 'Beschreibung', type: 'textarea' },
];
const COMPUTED: FieldDef[] = [
  { key: 'contacts_count', label: 'Kontakte', type: 'number' },
  { key: 'deals_count', label: 'Deals', type: 'number' },
  { key: 'deals_value', label: 'Deal-Wert', type: 'currency' },
  { key: 'created_at', label: 'Angelegt', type: 'datetime' },
  { key: 'updated_at', label: 'Geändert', type: 'datetime' },
];
const VIEW_KEY = 'pghl_companies_view';

function useCompanySchema() {
  const meta = useLoad(() => api.get<any>('/api/properties?object=company'), []);
  const custom: FieldDef[] = (meta.data?.properties ?? []).map((p: any) => ({ ...p, key: p.key, type: p.type }));
  const groups: { key: string; label: string }[] = meta.data?.groups ?? [];
  return { custom, groups, ready: !!meta.data };
}

const stageTone = (s: string) => (s === 'customer' || s === 'evangelist' ? 'green' : s === 'opportunity' || s === 'sql' ? 'blue' : s === 'mql' || s === 'lead' ? 'yellow' : 'gray');

function NewCompany({ onClose, onSaved }: { onClose: () => void; onSaved: (c: any) => void }) {
  const users = useUsers();
  const [c, setC] = useState<any>({ name: '', domain: '', industry: '', size: '', lifecycle_stage: 'lead', owner_id: '', city: '', phone: '' });
  const save = async () => {
    const r = await act(() => api.post('/api/companies', { ...c, owner_id: c.owner_id || null }));
    if (r) {
      toast(r.created ? 'Firma angelegt' : `Gibt es schon (${r.domain}) – aktualisiert`);
      onSaved(r);
    }
  };
  return (
    <Modal title="Neue Firma" onClose={onClose} footer={<button className="btn" disabled={!c.name && !c.domain} onClick={save}>Speichern</button>}>
      <div className="grid2">
        <Field label="Name *" tour="company-name">
          <Input value={c.name} onChange={(v) => setC({ ...c, name: v })} autoFocus placeholder="Muster GmbH" />
        </Field>
        <Field label="Domain" hint="Kontakte mit dieser E-Mail-Domain werden verknüpft" tour="company-domain">
          <Input value={c.domain} onChange={(v) => setC({ ...c, domain: v })} placeholder="muster.de" />
        </Field>
        <Field label="Branche">
          <Input value={c.industry} onChange={(v) => setC({ ...c, industry: v })} />
        </Field>
        {/* Einfach-Modus: the rest behind "Weitere Felder" (Profi: inline, same order as always) */}
        <MoreFields id="company-new" values={[c.size, c.lifecycle_stage === 'lead' ? '' : c.lifecycle_stage, c.owner_id, c.city, c.phone]} count={5}>
        <Field label="Größe">
          <Select value={c.size} onChange={(v) => setC({ ...c, size: v })} placeholder="–" options={SIZES} />
        </Field>
        <Field label="Phase">
          <Select value={c.lifecycle_stage} onChange={(v) => setC({ ...c, lifecycle_stage: v })} placeholder="–" options={Object.entries(LIFECYCLE)} />
        </Field>
        <Field label="Zuständig">
          <Select value={c.owner_id} onChange={(v) => setC({ ...c, owner_id: v })} placeholder="–" options={users.map((u) => [u.id, u.name] as [string, string])} />
        </Field>
        <Field label="Ort">
          <Input value={c.city} onChange={(v) => setC({ ...c, city: v })} />
        </Field>
        <Field label="Telefon">
          <Input value={c.phone} onChange={(v) => setC({ ...c, phone: v })} />
        </Field>
        </MoreFields>
      </div>
    </Modal>
  );
}

function CompanySettings({ onClose }: { onClose: () => void }) {
  const s = useLoad(() => api.get<any>('/api/companies/settings'), []);
  const [busy, setBusy] = useState(false);
  const set = async (patch: any) => {
    const r = await act(() => api.put('/api/companies/settings', patch), 'Gespeichert');
    if (r) s.setData(r);
  };
  return (
    <Modal title="Firmen-Einstellungen" onClose={onClose}>
      {!s.data ? (
        <Spinner />
      ) : (
        <>
          <Check tour="companies-auto" checked={s.data.auto_associate} onChange={(v) => set({ auto_associate: v })} label="Kontakte automatisch per E-Mail-Domain mit Firmen verknüpfen (nie bei Freemail wie gmail.com, web.de)" />
          <Check checked={s.data.create_from_domain} onChange={(v) => set({ create_from_domain: v })} label="Für unbekannte Firmen-Domains automatisch eine Firma anlegen" />
          <Check checked={s.data.create_from_text} onChange={(v) => set({ create_from_text: v })} label="Aus dem Feld „Firma“ am Kontakt eine Firma anlegen und als primäre verknüpfen" />
          <p className="muted small">Das Feld „Firma“ am Kontakt zeigt immer den Namen der primären Firma – ändert man es, wird die passende Firma primär.</p>
          <button
            className="btn secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await act(() => api.post('/api/companies/sync'));
              setBusy(false);
              if (r) toast(`${r.contacts} Kontakte geprüft · ${r.companies} Firmen`);
            }}
          >
            <Icon name="refresh" /> Alle Kontakte jetzt abgleichen
          </button>
        </>
      )}
    </Modal>
  );
}

function loadView(columns: string[]): ViewConfig & { id: string } {
  try {
    return { id: '', columns, filters: [], sort: '', q: '', ...JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? '{}') };
  } catch {
    return { id: '', columns, filters: [], sort: '', q: '' };
  }
}

export function Companies() {
  const schema = useCompanySchema();
  const users = useUsers();
  // Einfach-Modus starts with four columns; "Spalten" adds the rest (web/src/areas/easy-core.ts).
  const defaultCols = defaultColumns(COMPANY_COLUMNS, useSimple());
  const init = useMemo(() => loadView(defaultCols), []);
  const [q, setQ] = useState(init.q);
  const [filters, setFilters] = useState<Filter[]>(init.filters);
  const [columns, setColumns] = useState<string[]>(init.columns.length ? init.columns : defaultCols);
  const [sort, setSort] = useState(init.sort);
  const [view, setView] = useState(init.id);
  const [showFilters, setShowFilters] = useState(init.filters.length > 0);
  const [page, setPage] = useState(0);
  const [modal, setModal] = useState<'' | 'new' | 'import' | 'columns' | 'settings'>('');
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const fields: FieldDef[] = [...COMPANY_STANDARD, ...COMPUTED, ...schema.custom.map((p) => ({ ...p, key: `custom.${p.key}` }))];
  const active = cleanFilters(filters);
  const qs = `q=${encodeURIComponent(debounced)}&sort=${encodeURIComponent(sort)}${active.length ? `&filters=${encodeURIComponent(JSON.stringify(active))}` : ''}`;
  const list = useLoad(() => api.get<any>(`/api/companies?${qs}&limit=50&offset=${page * 50}`), [qs, page]);
  const current: ViewConfig = { columns, filters: active, sort, q };
  useEffect(() => {
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({ ...current, id: view }));
    } catch {
      /* private mode */
    }
  }, [JSON.stringify(current), view]);

  const cell = (r: any, f: FieldDef) => {
    if (f.key === 'name')
      return (
        <>
          <strong>{r.name}</strong>
          {r.domain && <div className="muted small">{r.domain}</div>}
        </>
      );
    if (f.key === 'lifecycle_stage') return r.lifecycle_stage ? <Badge tone={stageTone(r.lifecycle_stage) as any}>{LIFECYCLE[r.lifecycle_stage] ?? r.lifecycle_stage}</Badge> : <span className="muted">–</span>;
    if (f.key === 'owner_id') return r.owner_name ?? <span className="muted">–</span>;
    if (f.key === 'updated_at' || f.key === 'created_at') return <span className="muted">{d(r[f.key])}</span>;
    if (f.key.startsWith('custom.')) return <PropValue def={f} value={r.custom?.[f.key.slice(7)]} users={users} />;
    if (['contacts_count', 'deals_count', 'deals_value'].includes(f.key) && !r[f.key]) return <span className="muted">–</span>;
    return <PropValue def={f} value={r[f.key]} users={users} />;
  };

  return (
    <>
      <PageHead title="Firmen" sub={list.data ? `${list.data.total} Firmen` : undefined}>
        <button className="btn secondary" data-tour="companies-settings" onClick={() => setModal('settings')} title="Einstellungen">
          <Icon name="settings" />
        </button>
        <button className="btn secondary" onClick={() => setModal('import')}>
          Import
        </button>
        <a className="btn secondary" href={`/api/companies/export.csv?${qs}&locationId=${encodeURIComponent(localStorage.getItem('pghl.location') ?? '')}`}>
          Export
        </a>
        <button className="btn" data-tour="companies-new" onClick={() => setModal('new')}>
          + Firma
        </button>
      </PageHead>
      <ViewsBar
        object="company"
        current={current}
        active={view}
        onApply={(id, c) => {
          setView(id);
          setPage(0);
          setQ(c?.q ?? '');
          setFilters(c?.filters ?? []);
          setColumns(c?.columns?.length ? c.columns : defaultCols);
          setSort(c?.sort ?? '');
          setShowFilters(!!c?.filters?.length);
        }}
      />
      <div className="row list-tools" data-tour="companies-tools">
        <div className="grow">
          <Input value={q} onChange={(v) => (setQ(v), setPage(0))} placeholder="Name, Domain, Ort, Branche…" />
        </div>
        <button className={`btn secondary${active.length ? ' has-count' : ''}`} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
          <Icon name="filter" /> Filter{active.length ? ` (${active.length})` : ''}
        </button>
        <button className="btn secondary" onClick={() => setModal('columns')}>
          <Icon name="columns" /> Spalten
        </button>
      </div>
      {showFilters && (
        <div className="card filter-card">
          <FilterRows fields={fields.filter((f) => f.type !== 'textarea')} value={filters} onChange={(f) => (setFilters(f), setPage(0))} users={users} />
        </div>
      )}
      {!list.data ? (
        <Spinner />
      ) : list.data.companies.length ? (
        <RecordTable fields={fields} columns={columns} rows={list.data.companies} cell={cell} sort={sort} onSort={(s) => (setSort(s), setPage(0))} onRow={(r) => navigate(`companies/${r.id}`)} />
      ) : (
        <Empty action={<button className="btn" onClick={() => setModal('new')}>Erste Firma anlegen</button>}>{debounced || active.length ? 'Keine Firma passt zu Suche und Filter.' : 'Noch keine Firmen. Kontakte mit Firmenname oder Firmen-E-Mail werden automatisch zugeordnet.'}</Empty>
      )}
      {list.data && <Pager total={list.data.total} page={page} size={50} onPage={setPage} />}
      {modal === 'new' && <NewCompany onClose={() => setModal('')} onSaved={(c) => navigate(`companies/${c.id}`)} />}
      {modal === 'import' && (
        <CsvImportModal
          title="Firmen importieren (CSV)"
          url="/api/companies/import"
          hint="Kopfzeile mit z. B. Name, Domain, Branche, Größe, Telefon, Webseite, Ort – eigene Eigenschaften über ihren Namen. Gleiche Domain (sonst gleicher Name) wird aktualisiert statt doppelt angelegt."
          placeholder="Name;Domain;Branche"
          onClose={() => setModal('')}
          onDone={list.reload}
        />
      )}
      {modal === 'columns' && <ColumnsModal fields={fields} value={columns} onChange={setColumns} onClose={() => setModal('')} />}
      {modal === 'settings' && <CompanySettings onClose={() => setModal('')} />}
    </>
  );
}

function MergeModal({ company, onClose, onDone }: { company: any; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState(company.name.split(/\s+/)[0] ?? '');
  const [found, setFound] = useState<any[]>([]);
  useEffect(() => {
    const t = setTimeout(() => api.get<any>(`/api/companies?q=${encodeURIComponent(q)}&limit=8`).then((r) => setFound(r.companies.filter((c: any) => c.id !== company.id))), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Modal title="Firmen zusammenführen" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Die gewählte Firma wird in <strong>{company.name}</strong> übernommen: Kontakte, Deals, Notizen und leere Felder wandern hierher, danach wird sie gelöscht.
      </p>
      <Input value={q} onChange={setQ} placeholder="Firma suchen…" autoFocus />
      <div className="assoc-found" style={{ marginTop: 8 }}>
        {found.map((c) => (
          <button
            type="button"
            key={c.id}
            onClick={async () => {
              if (!confirmAsk(`„${c.name}“ in „${company.name}“ zusammenführen?`)) return;
              if (await act(() => api.post(`/api/companies/${company.id}/merge`, { from_id: c.id }), 'Zusammengeführt')) onDone();
            }}
          >
            <strong>{c.name}</strong> <span className="muted small">{[c.domain, c.city, `${c.contacts_count} Kontakte`].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {!found.length && <span className="muted small">Keine andere Firma gefunden.</span>}
      </div>
    </Modal>
  );
}

export function CompanyDetail({ id }: { id: string }) {
  const c = useLoad(() => api.get<any>(`/api/companies/${id}`), [id]);
  const schema = useCompanySchema();
  const users = useUsers();
  const [edit, setEdit] = useState<Record<string, any> | null>(null);
  const [tab, setTab] = useState('activity');
  const [task, setTask] = useState({ title: '', due_at: '' });
  const [merge, setMerge] = useState(false);
  if (!c.data) return c.error ? <Empty>{c.error}</Empty> : <Spinner />;
  const co = c.data;
  const values = { ...co, ...Object.fromEntries(Object.entries(co.custom ?? {}).map(([k, v]) => [`custom.${k}`, v])) };
  const fields: FieldDef[] = [...COMPANY_STANDARD, ...schema.custom.map((p) => ({ ...p, key: `custom.${p.key}` }))];
  const save = async (v: Record<string, any>) => {
    const body: any = { custom: {} };
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('custom.')) body.custom[k.slice(7)] = val;
      else body[k] = val;
    }
    const r = await act(() => api.patch(`/api/companies/${id}`, body), 'Gespeichert');
    if (r) c.reload();
    return r;
  };
  const openTasks = co.tasks.filter((t: any) => !t.done).length;
  return (
    <>
      <PageHead
        title={co.name}
        sub={
          <>
            {co.domain && (
              <a href={co.website || `https://${co.domain}`} target="_blank" rel="noreferrer noopener">
                {co.domain}
              </a>
            )}
            {co.domain ? ' · ' : ''}
            {co.lifecycle_stage && <Badge tone={stageTone(co.lifecycle_stage) as any}>{LIFECYCLE[co.lifecycle_stage]}</Badge>} Angelegt {dt(co.created_at)}
            {co.source ? ` · Quelle: ${co.source}` : ''}
          </>
        }
      >
        <Link to="companies" className="btn secondary">
          ← Firmen
        </Link>
        <CanvasPin kind="company" id={id} name={co.name} />
        <button className="btn secondary" data-tour="company-merge" onClick={() => setMerge(true)}>
          Zusammenführen
        </button>
        <button className="btn danger" onClick={async () => confirmAsk('Firma löschen? Kontakte und Deals bleiben erhalten.') && (await act(() => api.del(`/api/companies/${id}`), 'Gelöscht')) && navigate('companies')}>
          Löschen
        </button>
      </PageHead>
      <SortableGrid id="company-stats" className="stats rec-stats" data-tour="company-stats">
        <div className="stat card">
          <div className="muted">Kontakte</div>
          <div className="stat-value">{co.contacts.length}</div>
        </div>
        <div className="stat card">
          <div className="muted">Deal-Wert</div>
          <div className="stat-value">{euro(co.deals_value)}</div>
          <div className="muted small">{co.deals.length} Deals, ohne verlorene</div>
        </div>
        <div className="stat card">
          <div className="muted">Offene Aufgaben</div>
          <div className="stat-value">{openTasks + co.contact_tasks.length}</div>
        </div>
      </SortableGrid>
      <div className="row rec-layout">
        <div className="rec-left">
          <PropertyCard id="company-props" title="Eigenschaften" fields={fields} groups={schema.groups} values={values} edit={edit} setEdit={setEdit} users={users} onSave={save} />
        </div>
        <div className="rec-main">
          <div className="card" style={{ padding: 0 }} data-tour="company-activity">
            <div style={{ padding: '6px 14px 0' }}>
              <Tabs
                tabs={[
                  ['activity', 'Aktivität'],
                  ['notes', `Notizen (${co.notes.length})`],
                  ['tasks', `Aufgaben (${openTasks})`],
                ]}
                value={tab}
                onChange={setTab}
              />
            </div>
            <div style={{ padding: '0 14px 14px' }}>
              {tab === 'activity' && (
                <>
                  <p className="muted small" style={{ marginTop: 0 }}>
                    Änderungen der Firma und die Aktivität aller verknüpften Kontakte.
                  </p>
                  <Timeline items={co.timeline} />
                </>
              )}
              {tab === 'notes' && <Notes notes={co.notes} onAdd={(body) => act(() => api.post(`/api/companies/${id}/notes`, { body })).then((r) => (c.reload(), r))} onDelete={(nid) => act(() => api.del(`/api/record-notes/${nid}`)).then(c.reload)} />}
              {tab === 'tasks' && (
                <>
                  <div className="row">
                    <div className="grow">
                      <Input value={task.title} onChange={(v) => setTask({ ...task, title: v })} placeholder="Neue Aufgabe zur Firma" />
                    </div>
                    <div style={{ width: 170 }}>
                      <Input type="date" value={task.due_at} onChange={(v) => setTask({ ...task, due_at: v })} aria-label="Fällig am" />
                    </div>
                    <button className="btn" disabled={!task.title} aria-label="Aufgabe anlegen" onClick={() => act(() => api.post(`/api/companies/${id}/tasks`, { ...task, due_at: task.due_at ? new Date(task.due_at).toISOString() : null })).then(() => (setTask({ title: '', due_at: '' }), c.reload()))}>
                      +
                    </button>
                  </div>
                  {co.tasks.map((t: any) => (
                    <Check key={t.id} checked={!!t.done} onChange={(v) => act(() => api.patch(`/api/tasks/${t.id}`, { done: v })).then(c.reload)} label={<span style={{ textDecoration: t.done ? 'line-through' : '' }}>{t.title} {t.due_at && <span className="muted small">bis {d(t.due_at)}</span>}</span>} />
                  ))}
                  {co.contact_tasks.length > 0 && (
                    <>
                      <div className="prop-group" style={{ marginTop: 14 }}>
                        Offene Aufgaben der Kontakte
                      </div>
                      {co.contact_tasks.map((t: any) => (
                        <div key={t.id} className="small" style={{ padding: '4px 0' }}>
                          {t.title} · <Link to={`contacts/${t.contact_id}`}>{name(t)}</Link> {t.due_at && <span className="muted">bis {d(t.due_at)}</span>}
                        </div>
                      ))}
                    </>
                  )}
                  {!co.tasks.length && !co.contact_tasks.length && <p className="muted">Keine Aufgaben.</p>}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="rec-side">
          <AssociationsPanel type="company" id={id} title="Kontakte, Deals & mehr" exclude={['task']} onChange={c.reload} />
        </div>
      </div>
      {merge && <MergeModal company={co} onClose={() => setMerge(false)} onDone={() => (setMerge(false), c.reload())} />}
    </>
  );
}
