import { useEffect, useMemo, useState } from 'react';
import { Icon, OBJECT_ICONS } from '../icons';
import { api, d, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Link, Modal, PageHead, Select, Spinner, Tabs, Textarea, act, confirmAsk, navigate, pressable, toast, useLoad } from '../ui';
import {
  AssociationsPanel,
  ColumnsModal,
  CsvImportModal,
  FilterRows,
  Notes,
  Pager,
  PropInput,
  PropValue,
  PropertyCard,
  RecordTable,
  TYPE_LABELS,
  Timeline,
  ViewsBar,
  cleanFilters,
  objIcon,
  refreshAssocTypes,
  useUsers,
  type FieldDef,
  type Filter,
  type ViewConfig,
} from './ObjectKit';
import { COMPANY_STANDARD } from './Companies';
import { MoreFields, useSimple } from '../areas/fields';
import { recordColumns, splitFields } from '../areas/easy-core';
import '../areas/easy-core.css';
import { SortableGrid } from '../sortable/Sortable';

/** Eigene Objekte: overview + builder, record lists, record pages, sidebar entries, workflow parts. */

const refreshNav = () => window.dispatchEvent(new Event('pghl:objects'));

let objectsCache: { loc: string; p: Promise<any[]> } | null = null;
/** Object types with their properties (shared by the sidebar, lists and workflow steps). */
export function useObjectTypes(): { types: any[]; reload: () => void } {
  const [types, setTypes] = useState<any[]>([]);
  const load = (force = false) => {
    const loc = localStorage.getItem('pghl.location') ?? '';
    if (force || !objectsCache || objectsCache.loc !== loc) objectsCache = { loc, p: api.get<any[]>('/api/objects').catch(() => []) };
    void objectsCache.p.then(setTypes);
  };
  useEffect(() => {
    load();
    const on = () => load(true);
    window.addEventListener('pghl:objects', on);
    return () => window.removeEventListener('pghl:objects', on);
  }, []);
  return { types, reload: () => (refreshNav(), load(true)) };
}

/** Sidebar: the custom objects below "Objekte". */
export function ObjectNav({ cur }: { cur: string[] }) {
  const { types } = useObjectTypes();
  if (!types.length) return null;
  return (
    <div className="nav-sub">
      {types.map((t) => (
        <Link key={t.key} to={`objects/${t.key}`} className={cur[0] === 'objects' && cur[1] === t.key ? 'on' : ''}>
          <Icon name={objIcon(t.icon)} size={15} /> {t.plural}
        </Link>
      ))}
    </div>
  );
}

const typeFields = (t: any): FieldDef[] => (t?.properties ?? []).map((p: any) => ({ ...p }));
const SYSTEM: FieldDef[] = [
  { key: 'owner_id', label: 'Zuständig', type: 'user' },
  { key: 'created_at', label: 'Angelegt', type: 'datetime' },
  { key: 'updated_at', label: 'Geändert', type: 'datetime' },
];

// --- builder ----------------------------------------------------------------------------------

interface NewProp {
  label: string;
  type: string;
  options: string;
  required: boolean;
  unique: boolean;
}
const blankProp = (): NewProp => ({ label: '', type: 'text', options: '', required: false, unique: false });

function PropRowEditor({ p, onChange, onRemove }: { p: NewProp; onChange: (p: NewProp) => void; onRemove?: () => void }) {
  return (
    <div className="prop-row-edit">
      <Input value={p.label} onChange={(v) => onChange({ ...p, label: v })} placeholder="Bezeichnung, z. B. Kennzeichen" />
      <Select value={p.type} onChange={(v) => onChange({ ...p, type: v })} options={Object.entries(TYPE_LABELS)} />
      {(p.type === 'select' || p.type === 'multiselect') && <Input value={p.options} onChange={(v) => onChange({ ...p, options: v })} placeholder="Optionen, mit Komma" />}
      <Check checked={p.required} onChange={(v) => onChange({ ...p, required: v })} label="Pflicht" />
      {!['checkbox', 'multiselect', 'textarea', 'file'].includes(p.type) && <Check checked={p.unique} onChange={(v) => onChange({ ...p, unique: v })} label="Eindeutig" />}
      {onRemove && (
        <button type="button" className="icon-btn" onClick={onRemove} aria-label="Eigenschaft entfernen">
          ✕
        </button>
      )}
    </div>
  );
}

const toApi = (p: NewProp) => ({ label: p.label, type: p.type, options: p.options.split(',').map((o) => o.trim()).filter(Boolean), required: p.required, unique: p.unique });

export function ObjectBuilder({ type, onClose, onSaved }: { type?: any; onClose: () => void; onSaved: (t: any) => void }) {
  const [f, setF] = useState<any>(type ? { singular: type.singular, plural: type.plural, icon: type.icon, description: type.description, primary_property: type.primary_property } : { singular: '', plural: '', icon: 'layers', description: '', primary_label: 'Name', primary_unique: false });
  const [props, setProps] = useState<NewProp[]>(type ? [] : [blankProp()]);
  const [extra, setExtra] = useState<NewProp>(blankProp());
  const [cur, setCur] = useState<any>(type);
  const save = async () => {
    if (!type) {
      const r = await act(() => api.post('/api/object-types', { ...f, properties: props.filter((p) => p.label.trim()).map(toApi) }));
      if (!r) return;
      if (r.errors?.length) toast(`Angelegt – nicht übernommen: ${r.errors.join('; ')}`);
      else toast(`${r.plural} angelegt`);
      refreshAssocTypes();
      onSaved(r);
      return;
    }
    const r = await act(() => api.patch(`/api/object-types/${type.id}`, f), 'Gespeichert');
    if (r) (refreshAssocTypes(), onSaved(r));
  };
  const addExtra = async () => {
    const r = await act(() => api.post('/api/properties', { object: type.key, ...toApi(extra) }), 'Eigenschaft angelegt');
    if (r) {
      setExtra(blankProp());
      setCur({ ...cur, properties: [...cur.properties, r] });
      refreshNav();
    }
  };
  const eligible = (cur?.properties ?? []).filter((p: any) => ['text', 'email', 'phone', 'url', 'number', 'date'].includes(p.type));
  return (
    <Modal
      title={type ? `${type.plural} bearbeiten` : 'Neues Objekt'}
      onClose={onClose}
      wide
      footer={
        <>
          {type && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirmAsk(`Objekt „${type.plural}“ mit allen ${type.records} Datensätzen löschen?`)) return;
                if (await act(() => api.del(`/api/object-types/${type.id}?force=1`), 'Gelöscht')) (refreshAssocTypes(), onSaved(null));
              }}
            >
              Löschen
            </button>
          )}
          <button className="btn" disabled={!f.singular?.trim()} onClick={save}>
            {type ? 'Speichern' : 'Objekt anlegen'}
          </button>
        </>
      }
    >
      <div className="builder-grid" data-tour="obj-builder">
        <div>
          <div className="grid2">
            <Field label="Name (Einzahl) *" tour="obj-singular">
              <Input value={f.singular} onChange={(v) => setF({ ...f, singular: v })} placeholder="Fahrzeug" autoFocus />
            </Field>
            <Field label="Name (Mehrzahl)">
              <Input value={f.plural} onChange={(v) => setF({ ...f, plural: v })} placeholder="Fahrzeuge" />
            </Field>
          </div>
          <Field label="Beschreibung">
            <Textarea value={f.description} onChange={(v) => setF({ ...f, description: v })} rows={2} placeholder="Wofür ist das Objekt da?" />
          </Field>
          {!type ? (
            <div className="grid2">
              <Field label="Anzeige-Eigenschaft" hint="Name eines Datensatzes in Listen und Verknüpfungen">
                <Input value={f.primary_label} onChange={(v) => setF({ ...f, primary_label: v })} placeholder="Name" />
              </Field>
              <Field label=" ">
                <Check checked={f.primary_unique} onChange={(v) => setF({ ...f, primary_unique: v })} label="Eindeutig (z. B. Kennzeichen)" />
              </Field>
            </div>
          ) : (
            <Field label="Anzeige-Eigenschaft" hint="Text, E-Mail, Telefon, URL, Zahl oder Datum">
              <Select value={f.primary_property} onChange={(v) => setF({ ...f, primary_property: v })} options={eligible.map((p: any) => [p.key, p.label] as [string, string])} />
            </Field>
          )}
        </div>
        <div>
          <Field label="Symbol" tour="obj-icon">
            <div className="icon-grid">
              {OBJECT_ICONS.map((n) => (
                <button type="button" key={n} className={f.icon === n ? 'on' : ''} onClick={() => setF({ ...f, icon: n })} aria-label={`Symbol ${n}`} aria-pressed={f.icon === n}>
                  <Icon name={n} size={18} />
                </button>
              ))}
            </div>
          </Field>
        </div>
      </div>
      <hr />
      <h3 style={{ marginBottom: 8 }} data-tour="obj-props">Eigenschaften</h3>
      {type ? (
        <>
          <div className="table-scroll">
          <table className="t compact-t">
            <tbody>
              {(cur?.properties ?? []).map((p: any) => (
                <tr key={p.key}>
                  <td>
                    <strong>{p.label}</strong> {p.key === cur.primary_property && <Badge tone="blue">Anzeige</Badge>}
                  </td>
                  <td className="mono muted">{p.key}</td>
                  <td>{TYPE_LABELS[p.type] ?? p.type}</td>
                  <td>
                    {p.required && <Badge tone="yellow">Pflicht</Badge>} {p.unique && <Badge tone="purple">eindeutig</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="prop-add">
            <PropRowEditor p={extra} onChange={setExtra} />
            <button className="btn small secondary" disabled={!extra.label.trim()} onClick={addExtra}>
              + Eigenschaft
            </button>
          </div>
          <p className="muted small">
            Gruppen, Beschreibungen und Änderungen: <Link to={`properties/${type.key}`}>Eigenschaften verwalten →</Link>
          </p>
        </>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            Die Anzeige-Eigenschaft ({f.primary_label || 'Name'}) gibt es immer. Weitere jetzt oder später unter Eigenschaften.
          </p>
          {props.map((p, i) => (
            <PropRowEditor key={i} p={p} onChange={(x) => setProps(props.map((y, j) => (j === i ? x : y)))} onRemove={() => setProps(props.filter((_, j) => j !== i))} />
          ))}
          <button className="btn small secondary" onClick={() => setProps([...props, blankProp()])}>
            + Weitere Eigenschaft
          </button>
        </>
      )}
    </Modal>
  );
}

// --- overview -----------------------------------------------------------------------------------

export function ObjectsHome() {
  const { types, reload } = useObjectTypes();
  const [modal, setModal] = useState<any>(null);
  return (
    <>
      <PageHead title="Objekte" sub="Eigene Datensatz-Typen neben Kontakten, Firmen und Deals – z. B. Fahrzeuge, Verträge, Immobilien">
        <Link to="properties" className="btn secondary">
          <Icon name="properties" /> Eigenschaften
        </Link>
        <button className="btn" onClick={() => setModal({})}>
          + Objekt
        </button>
      </PageHead>
      <SortableGrid id="obj-cards" className="obj-cards" data-tour="obj-cards" pinned={['add']}>
        <div className="card obj-card builtin" role="button" {...pressable(() => navigate('contacts'))}>
          <Icon name="contacts" size={22} />
          <h3>Kontakte</h3>
          <span className="muted small">Standard-Objekt</span>
        </div>
        <div className="card obj-card builtin" role="button" {...pressable(() => navigate('companies'))}>
          <Icon name="company" size={22} />
          <h3>Firmen</h3>
          <span className="muted small">Standard-Objekt</span>
        </div>
        <div className="card obj-card builtin" role="button" {...pressable(() => navigate('opportunities'))}>
          <Icon name="deal" size={22} />
          <h3>Deals</h3>
          <span className="muted small">Standard-Objekt</span>
        </div>
        {types.map((t) => (
          <div key={t.key} className="card obj-card" data-tour="obj-custom" {...pressable(() => navigate(`objects/${t.key}`))}>
            <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
              <Icon name={objIcon(t.icon)} size={22} />
              <button className="icon-btn" onClick={(e) => (e.stopPropagation(), setModal(t))} aria-label={`${t.plural} bearbeiten`}>
                <Icon name="edit" size={15} />
              </button>
            </div>
            <h3>{t.plural}</h3>
            <span className="muted small">
              {t.records} Datensätze · {t.properties.length} Eigenschaften
            </span>
            {t.description && <span className="small">{t.description}</span>}
          </div>
        ))}
        <button key="add" className="card obj-card add" data-tour="obj-add" onClick={() => setModal({})}>
          <Icon name="objects" size={22} />
          <h3>Neues Objekt</h3>
          <span className="muted small">Name, Symbol und Eigenschaften festlegen</span>
        </button>
      </SortableGrid>
      {modal && (
        <ObjectBuilder
          type={modal.id ? modal : undefined}
          onClose={() => setModal(null)}
          onSaved={(t) => {
            setModal(null);
            reload();
            if (t && !modal.id) navigate(`objects/${t.key}`);
          }}
        />
      )}
    </>
  );
}

// --- records ------------------------------------------------------------------------------------

function NewRecord({ type, onClose, onSaved }: { type: any; onClose: () => void; onSaved: (r: any) => void }) {
  const users = useUsers();
  const fields = typeFields(type);
  const [v, setV] = useState<Record<string, any>>({});
  // Einfach-Modus: required, primary and the first few at first glance, the rest behind "Weitere Felder".
  const { main, more } = splitFields(fields, { primary: type.primary_property });
  const input = (f: FieldDef) =>
    f.type === 'checkbox' ? (
      <div key={f.key} className="field">
        <PropInput def={f} value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} users={users} />
      </div>
    ) : (
      <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.description || undefined}>
        <PropInput def={f} value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} users={users} />
      </Field>
    );
  return (
    <Modal
      title={`${type.singular} anlegen`}
      onClose={onClose}
      footer={
        <button
          className="btn"
          onClick={async () => {
            const r = await act(() => api.post(`/api/objects/${type.key}/records`, { properties: v }));
            if (r) (toast(r.created ? `${type.singular} angelegt` : 'Gab es schon – aktualisiert'), onSaved(r));
          }}
        >
          Speichern
        </button>
      }
    >
      <div className="grid2">
        {main.map(input)}
        {more.length > 0 && (
          <MoreFields id={`record-new-${type.key}`} values={more.map((f) => v[f.key])} count={more.length}>
            {more.map(input)}
          </MoreFields>
        )}
      </div>
    </Modal>
  );
}

export function RecordsList({ objectKey }: { objectKey: string }) {
  const types = useLoad(() => api.get<any[]>('/api/objects'), [objectKey]);
  const type = types.data?.find((t) => t.key === objectKey);
  const users = useUsers();
  const fields = useMemo(() => [...typeFields(type), ...SYSTEM], [type]);
  // Einfach-Modus: the primary property plus three; Profi: plus five and "Geändert" (web/src/areas/easy-core.ts).
  const simple = useSimple();
  const defaults = useMemo(() => (type ? recordColumns(type.primary_property, typeFields(type).filter((f) => f.type !== 'textarea').map((f) => f.key), simple) : []), [type, simple]);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [sort, setSort] = useState('');
  const [view, setView] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const [modal, setModal] = useState<'' | 'new' | 'import' | 'columns' | 'builder'>('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => (setQ(''), setFilters([]), setColumns([]), setSort(''), setView(''), setPage(0)), [objectKey]);
  const active = cleanFilters(filters);
  const qs = `q=${encodeURIComponent(debounced)}&sort=${encodeURIComponent(sort)}${active.length ? `&filters=${encodeURIComponent(JSON.stringify(active))}` : ''}`;
  const list = useLoad(() => (type ? api.get<any>(`/api/objects/${objectKey}/records?${qs}&limit=50&offset=${page * 50}`) : Promise.resolve(null)), [qs, page, type?.id]);
  const cols = columns.length ? columns : defaults;
  if (types.data && !type) return <Empty>Objekt nicht gefunden.</Empty>;
  if (!type) return <Spinner />;
  const current: ViewConfig = { columns: cols, filters: active, sort, q };
  const cell = (r: any, f: FieldDef) => {
    if (f.key === 'owner_id') return r.owner_name ?? <span className="muted">–</span>;
    if (f.key === 'created_at' || f.key === 'updated_at') return <span className="muted">{d(r[f.key])}</span>;
    if (f.key === type.primary_property) return <strong>{r.display || <span className="muted">ohne Namen</span>}</strong>;
    return <PropValue def={f} value={r.properties?.[f.key]} users={users} />;
  };
  return (
    <>
      <PageHead
        title={type.plural}
        sub={
          <>
            <Icon name={objIcon(type.icon)} size={14} /> {list.data ? `${list.data.total} Datensätze` : '…'}
            {type.description ? ` · ${type.description}` : ''}
          </>
        }
      >
        <Link to="objects" className="btn secondary">
          ← Objekte
        </Link>
        <button className="btn secondary" onClick={() => setModal('builder')}>
          <Icon name="edit" /> Objekt
        </button>
        <button className="btn secondary" onClick={() => setModal('import')}>
          Import
        </button>
        <a className="btn secondary" href={`/api/objects/${objectKey}/export.csv?${qs}&locationId=${encodeURIComponent(localStorage.getItem('pghl.location') ?? '')}`}>
          Export
        </a>
        <button className="btn" data-tour="records-new" onClick={() => setModal('new')}>
          + {type.singular}
        </button>
      </PageHead>
      <ViewsBar
        object={type.key}
        current={current}
        active={view}
        onApply={(id, c) => {
          setView(id);
          setPage(0);
          setQ(c?.q ?? '');
          setFilters(c?.filters ?? []);
          setColumns(c?.columns ?? []);
          setSort(c?.sort ?? '');
          setShowFilters(!!c?.filters?.length);
        }}
      />
      <div className="row list-tools" data-tour="records-tools">
        <div className="grow">
          <Input value={q} onChange={(v) => (setQ(v), setPage(0))} placeholder={`${type.plural} durchsuchen…`} />
        </div>
        <button className="btn secondary" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
          <Icon name="filter" /> Filter{active.length ? ` (${active.length})` : ''}
        </button>
        <button className="btn secondary" onClick={() => setModal('columns')}>
          <Icon name="columns" /> Spalten
        </button>
      </div>
      {showFilters && (
        <div className="card filter-card">
          <FilterRows fields={fields.filter((f) => f.type !== 'textarea' && f.type !== 'file')} value={filters} onChange={(f) => (setFilters(f), setPage(0))} users={users} />
        </div>
      )}
      {!list.data ? (
        <Spinner />
      ) : list.data.records.length ? (
        <RecordTable fields={fields} columns={cols} rows={list.data.records} cell={cell} sort={sort} onSort={(s) => (setSort(s), setPage(0))} onRow={(r) => navigate(`objects/${type.key}/${r.id}`)} />
      ) : (
        <Empty action={<button className="btn" onClick={() => setModal('new')}>{type.singular} anlegen</button>}>{debounced || active.length ? 'Nichts passt zu Suche und Filter.' : `Noch keine ${type.plural}.`}</Empty>
      )}
      {list.data && <Pager total={list.data.total} page={page} size={50} onPage={setPage} />}
      {modal === 'new' && <NewRecord type={type} onClose={() => setModal('')} onSaved={(r) => navigate(`objects/${type.key}/${r.id}`)} />}
      {modal === 'import' && (
        <CsvImportModal
          title={`${type.plural} importieren (CSV)`}
          url={`/api/objects/${type.key}/import`}
          hint={<>Kopfzeile mit den Namen der Eigenschaften ({typeFields(type).map((f) => f.label).join(', ')}). Gleiche Werte in eindeutigen Eigenschaften aktualisieren statt doppelt anzulegen.</>}
          placeholder={typeFields(type).map((f) => f.label).join(',')}
          onClose={() => setModal('')}
          onDone={list.reload}
        />
      )}
      {modal === 'columns' && <ColumnsModal fields={fields} value={cols} onChange={setColumns} onClose={() => setModal('')} />}
      {modal === 'builder' && <ObjectBuilder type={type} onClose={() => setModal('')} onSaved={(t) => (setModal(''), refreshNav(), t ? types.reload() : navigate('objects'))} />}
    </>
  );
}

export function RecordPage({ objectKey, id }: { objectKey: string; id: string }) {
  const r = useLoad(() => api.get<any>(`/api/objects/${objectKey}/records/${id}`), [objectKey, id]);
  const users = useUsers();
  const [edit, setEdit] = useState<Record<string, any> | null>(null);
  const [tab, setTab] = useState('activity');
  if (!r.data) return r.error ? <Empty>{r.error}</Empty> : <Spinner />;
  const rec = r.data;
  const type = rec.type;
  const fields: FieldDef[] = [...typeFields(type), { key: 'owner_id', label: 'Zuständig', type: 'user' }];
  const values = { ...rec.properties, owner_id: rec.owner_id };
  const save = async (v: Record<string, any>) => {
    const { owner_id, ...properties } = v;
    const out = await act(() => api.patch(`/api/objects/${objectKey}/records/${id}`, { properties, owner_id: owner_id || null }), 'Gespeichert');
    if (out) r.reload();
    return out;
  };
  return (
    <>
      <PageHead
        title={rec.display || `${type.singular} ohne Namen`}
        sub={
          <>
            <Icon name={objIcon(type.icon)} size={14} /> {type.singular} · angelegt {dt(rec.created_at)} · geändert {dt(rec.updated_at)}
          </>
        }
      >
        <Link to={`objects/${objectKey}`} className="btn secondary">
          ← {type.plural}
        </Link>
        <button className="btn danger" onClick={async () => confirmAsk(`${type.singular} löschen? Verknüpfungen und Notizen werden mit gelöscht.`) && (await act(() => api.del(`/api/objects/${objectKey}/records/${id}`), 'Gelöscht')) && navigate(`objects/${objectKey}`)}>
          Löschen
        </button>
      </PageHead>
      <div className="row rec-layout">
        <div className="rec-left">
          <PropertyCard id={`record-${objectKey}`} title="Eigenschaften" fields={fields} groups={type.groups ?? []} values={values} edit={edit} setEdit={setEdit} users={users} onSave={save} />
        </div>
        <div className="rec-main">
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '6px 14px 0' }}>
              <Tabs
                tabs={[
                  ['activity', 'Aktivität'],
                  ['notes', `Notizen (${rec.notes.length})`],
                ]}
                value={tab}
                onChange={setTab}
              />
            </div>
            <div style={{ padding: '0 14px 14px' }}>
              {tab === 'activity' && <Timeline items={rec.activities.map((a: any) => ({ id: a.id, at: a.created_at, summary: a.summary, by: a.user_name }))} />}
              {tab === 'notes' && <Notes notes={rec.notes} onAdd={(body) => act(() => api.post(`/api/objects/${objectKey}/records/${id}/notes`, { body })).then((x) => (r.reload(), x))} onDelete={(nid) => act(() => api.del(`/api/record-notes/${nid}`)).then(r.reload)} />}
            </div>
          </div>
        </div>
        <div className="rec-side">
          <AssociationsPanel type={objectKey} id={id} onChange={r.reload} />
        </div>
      </div>
    </>
  );
}

/** Route objects[/key[/id]]. */
export function ObjectsPage({ route }: { route: string[] }) {
  const [key, id] = route;
  if (key && id) return <RecordPage objectKey={key} id={id} />;
  if (key) return <RecordsList objectKey={key} />;
  return <ObjectsHome />;
}

// --- workflows ------------------------------------------------------------------------------------

function useObjectChoices() {
  const { types } = useObjectTypes();
  const company = useLoad(() => api.get<any>('/api/properties?object=company'), []);
  const companyFields: FieldDef[] = [...COMPANY_STANDARD, ...(company.data?.properties ?? [])];
  const objects: [string, string][] = [['company', 'Firma'], ...types.map((t) => [t.key, t.singular] as [string, string])];
  const fieldsOf = (object: string): FieldDef[] => (object === 'company' ? companyFields : typeFields(types.find((t) => t.key === object)));
  return { types, objects, fieldsOf };
}

function LabelSelect({ object, value, onChange, label = 'Label der Verknüpfung (optional)' }: { object: string; value: string; onChange: (v: string) => void; label?: string }) {
  const labels = useLoad(() => (object ? api.get<any[]>(`/api/association-labels?a_type=contact&b_type=${encodeURIComponent(object)}`) : Promise.resolve([])), [object]);
  if (!(labels.data ?? []).length) return null;
  return (
    <Field label={label}>
      <Select value={value} onChange={onChange} placeholder="–" options={(labels.data ?? []).map((l) => [l.name, l.name] as [string, string])} />
    </Field>
  );
}

/** Trigger filters for company.* and record.* triggers. */
export function ObjectTriggerFilter({ type, config, set }: { type: string; config: any; set: (p: any) => void }) {
  const { types, fieldsOf } = useObjectChoices();
  const isRecord = type.startsWith('record.');
  const object = isRecord ? config.object ?? '' : 'company';
  const fields = object ? fieldsOf(object) : [];
  return (
    <>
      {isRecord && (
        <Field label="Objekt">
          <Select value={config.object} onChange={(v) => set({ object: v, property: '' })} placeholder="jedes eigene Objekt" options={types.map((t) => [t.key, t.plural] as [string, string])} />
        </Field>
      )}
      {(type.endsWith('.property_changed') || type.endsWith('.updated')) && object && (
        <Field label="Eigenschaft">
          <Select value={config.property} onChange={(v) => set({ property: v })} placeholder="jede" options={fields.map((f) => [f.key, f.label] as [string, string])} />
        </Field>
      )}
      {type.endsWith('.property_changed') && config.property && (
        <Field label="Neuer Wert (leer = jeder)">
          <Input value={config.value} onChange={(v) => set({ value: v })} placeholder={config.property === 'lifecycle_stage' ? 'z. B. customer' : ''} />
        </Field>
      )}
      <LabelSelect object={object} value={config.label} onChange={(v) => set({ label: v })} label="Nur Kontakte mit diesem Label" />
      {!isRecord && <Check checked={config.enroll === 'primary'} onChange={(v) => set({ enroll: v ? 'primary' : '' })} label="Nur Kontakte, deren primäre Firma es ist" />}
      <p className="muted small">Der Workflow startet für die mit dem Datensatz verknüpften Kontakte. Platzhalter: {isRecord ? '{{event.record.display}}, {{event.record.properties.<schlüssel>}}' : '{{event.company.name}}, {{event.company.domain}}, {{event.company.custom.<schlüssel>}}'}.</p>
    </>
  );
}

function ValueMap({ fields, value, onChange }: { fields: FieldDef[]; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const entries = Object.entries(value ?? {});
  const free = fields.filter((f) => !(f.key in (value ?? {})));
  return (
    <div className="filter-rows">
      {entries.map(([k, v]) => (
        <div key={k} className="filter-row">
          <Select
            value={k}
            onChange={(nk) => onChange(Object.fromEntries(entries.map(([a, b]) => (a === k ? [nk, b] : [a, b]))))}
            options={[fields.find((f) => f.key === k) ?? { key: k, label: k }, ...free].map((f) => [f.key, f.label] as [string, string])}
          />
          <Input value={v} onChange={(nv) => onChange({ ...value, [k]: nv })} placeholder="Wert oder {{contact.…}}" />
          <button type="button" className="icon-btn" onClick={() => onChange(Object.fromEntries(entries.filter(([a]) => a !== k)))} aria-label="Entfernen">
            ✕
          </button>
        </div>
      ))}
      {free.length > 0 && (
        <button type="button" className="btn small secondary" onClick={() => onChange({ ...value, [free[0].key]: '' })}>
          + Eigenschaft
        </button>
      )}
    </div>
  );
}

/** Settings of the steps create_record, update_record and associate_records. */
export function ObjectStep({ step, set }: { step: any; set: (p: any) => void }) {
  const { objects, fieldsOf } = useObjectChoices();
  const object = step.object ?? '';
  const fields = object ? fieldsOf(object).filter((f) => f.type !== 'file') : [];
  return (
    <>
      <Field label="Objekt">
        <Select value={object} onChange={(v) => set({ object: v, properties: {}, property: '' })} placeholder="wählen…" options={objects} />
      </Field>
      {object && step.type === 'update_record' && (
        <Field label="Welcher Datensatz">
          <Select
            value={step.target ?? 'trigger'}
            onChange={(v) => set({ target: v })}
            options={[['trigger', 'Der Datensatz aus dem Auslöser'], ['associated', 'Alle mit dem Kontakt verknüpften'], ...(object === 'company' ? ([['primary', 'Die primäre Firma des Kontakts']] as [string, string][]) : [])]}
          />
        </Field>
      )}
      {object && step.type === 'update_record' && step.target === 'associated' && <LabelSelect object={object} value={step.label} onChange={(v) => set({ label: v })} label="Nur mit Label (optional)" />}
      {object && step.type !== 'associate_records' && (
        <Field label={step.type === 'create_record' ? 'Werte' : 'Neue Werte'} hint={object === 'company' ? 'Gleiche Domain = vorhandene Firma wird aktualisiert' : 'Eindeutige Eigenschaften verhindern Dubletten'}>
          <ValueMap fields={fields} value={step.properties ?? {}} onChange={(v) => set({ properties: v })} />
        </Field>
      )}
      {object && step.type === 'associate_records' && (
        <>
          <Field label="Datensatz finden">
            <Select value={step.target ?? 'match'} onChange={(v) => set({ target: v })} options={[['match', 'Über eine Eigenschaft'], ['trigger', 'Der Datensatz aus dem Auslöser']]} />
          </Field>
          {(step.target ?? 'match') === 'match' && (
            <div className="grid2">
              <Field label="Eigenschaft">
                <Select value={step.property ?? (object === 'company' ? 'domain' : '')} onChange={(v) => set({ property: v })} options={fields.map((f) => [f.key, f.label] as [string, string])} />
              </Field>
              <Field label="ist gleich" hint={object === 'company' && (step.property ?? 'domain') === 'domain' ? 'E-Mail-Adressen werden zur Domain' : undefined}>
                <Input value={step.value} onChange={(v) => set({ value: v })} placeholder="{{contact.email}}" />
              </Field>
            </div>
          )}
          {(step.target ?? 'match') === 'match' && <Check checked={!!step.create_if_missing} onChange={(v) => set({ create_if_missing: v })} label="Anlegen, wenn keiner passt" />}
        </>
      )}
      {object && step.type !== 'update_record' && (
        <>
          {step.type === 'create_record' && <Check checked={step.associate !== false} onChange={(v) => set({ associate: v })} label="Mit dem Kontakt verknüpfen" />}
          <LabelSelect object={object} value={step.label} onChange={(v) => set({ label: v })} />
          {object === 'company' && <Check checked={!!step.primary} onChange={(v) => set({ primary: v })} label="Als primäre Firma des Kontakts" />}
        </>
      )}
    </>
  );
}
