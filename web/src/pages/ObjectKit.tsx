import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ICONS, Icon, type IconName } from '../icons';
import { api, d, dt } from '../api';
import { act, Badge, Check, confirmAsk, Field, Input, Link, Modal, pressable, Select, Spinner, Textarea, useLoad } from '../ui';
import { useT } from '../i18n';
import { readCsvFile } from '../csv-file';
import { MoreFields, useSimple } from '../areas/fields';
import { anyFilled } from '../areas/fields-model';
import { splitFields } from '../areas/easy-core';

/**
 * Shared building blocks for companies, custom objects and the properties page: property inputs
 * and values by type, filter rows, column picker, saved views, CSV import and the associations
 * panel used on contact, company, deal and record pages.
 */

export type PropType = 'text' | 'textarea' | 'number' | 'currency' | 'date' | 'datetime' | 'select' | 'multiselect' | 'checkbox' | 'url' | 'email' | 'phone' | 'user' | 'file';
export interface FieldDef {
  key: string;
  label: string;
  type: PropType | 'id';
  options?: string[];
  group_key?: string;
  required?: boolean;
  unique?: boolean;
  description?: string;
  /** Option values → labels (e.g. lifecycle stages). */
  optionLabels?: Record<string, string>;
}
export interface User {
  id: string;
  name: string;
  email: string;
}

export const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  textarea: 'Mehrzeiliger Text',
  number: 'Zahl',
  currency: 'Währung (€)',
  date: 'Datum',
  datetime: 'Datum & Uhrzeit',
  select: 'Auswahl',
  multiselect: 'Mehrfachauswahl',
  checkbox: 'Checkbox',
  url: 'URL',
  email: 'E-Mail',
  phone: 'Telefon',
  user: 'Nutzer',
  file: 'Datei',
};

export const LIFECYCLE: Record<string, string> = {
  subscriber: 'Abonnent',
  lead: 'Lead',
  mql: 'MQL',
  sql: 'SQL',
  opportunity: 'Opportunity',
  customer: 'Kunde',
  evangelist: 'Fürsprecher',
  other: 'Sonstiges',
};

export const objIcon = (name?: string): IconName => (name && name in ICONS ? (name as IconName) : 'layers');

let usersCache: Promise<User[]> | null = null;
let usersLoc = '';
export function useUsers(): User[] {
  const [list, setList] = useState<User[]>([]);
  useEffect(() => {
    const loc = localStorage.getItem('pghl.location') ?? '';
    if (!usersCache || usersLoc !== loc) {
      usersLoc = loc;
      usersCache = api.get<User[]>('/api/location-users').catch(() => []);
    }
    void usersCache.then(setList);
  }, []);
  return list;
}

const eur = (v: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(v || 0);

/** A property value for reading (lists, record pages). */
export function PropValue({ def, value, users }: { def: FieldDef; value: any; users?: User[] }): ReactNode {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return <span className="muted">–</span>;
  switch (def.type) {
    case 'url':
      return (
        <a href={String(value)} target="_blank" rel="noreferrer noopener">
          {String(value).replace(/^https?:\/\//, '').slice(0, 60)}
        </a>
      );
    case 'email':
      return <a href={`mailto:${value}`}>{value}</a>;
    case 'phone':
      return <a href={`tel:${value}`}>{value}</a>;
    case 'checkbox':
      return value ? <Badge tone="green">ja</Badge> : <Badge>nein</Badge>;
    case 'multiselect':
      return (
        <span className="chip-list">
          {(value as string[]).map((v) => (
            <span key={v} className="tag">
              {v}
            </span>
          ))}
        </span>
      );
    case 'select':
      return <>{def.optionLabels?.[value] ?? value}</>;
    case 'currency':
      return <>{eur(Number(value))}</>;
    case 'number':
      return <>{Number(value).toLocaleString('de-DE')}</>;
    case 'date':
      return <>{d(value)}</>;
    case 'datetime':
      return <>{dt(value)}</>;
    case 'user':
      return <>{users?.find((u) => u.id === value)?.name ?? '…'}</>;
    case 'file':
      return (
        <a href={value.url} target="_blank" rel="noreferrer noopener">
          <Icon name="file" size={13} /> {value.name ?? 'Datei'}
        </a>
      );
    default:
      return <span style={{ whiteSpace: def.type === 'textarea' ? 'pre-wrap' : undefined }}>{String(value)}</span>;
  }
}

const toLocalInput = (iso: string) => {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
};

/** An input for one property, by type. */
export function PropInput({ def, value, onChange, users }: { def: FieldDef; value: any; onChange: (v: any) => void; users?: User[] }) {
  const [busy, setBusy] = useState(false);
  switch (def.type) {
    case 'textarea':
      return <Textarea value={value ?? ''} onChange={onChange} rows={3} />;
    case 'number':
    case 'currency':
      return <Input type="number" step={def.type === 'currency' ? '0.01' : 'any'} value={value ?? ''} onChange={onChange} />;
    case 'date':
      return <Input type="date" value={value ?? ''} onChange={onChange} />;
    case 'datetime':
      return <Input type="datetime-local" value={toLocalInput(value ?? '')} onChange={(v) => onChange(v ? new Date(v).toISOString() : '')} />;
    case 'select':
      return <Select value={value ?? ''} onChange={onChange} placeholder="–" options={(def.options ?? []).map((o) => [o, def.optionLabels?.[o] ?? o] as [string, string])} />;
    case 'multiselect': {
      const cur: string[] = Array.isArray(value) ? value : [];
      return (
        <div className="opt-toggle">
          {(def.options ?? []).map((o) => (
            <button type="button" key={o} className={cur.includes(o) ? 'on' : ''} onClick={() => onChange(cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o])} aria-pressed={cur.includes(o)}>
              {o}
            </button>
          ))}
        </div>
      );
    }
    case 'checkbox':
      return <Check checked={!!value} onChange={onChange} label={def.label} />;
    case 'user':
      return <Select value={value ?? ''} onChange={onChange} placeholder="–" options={(users ?? []).map((u) => [u.id, u.name] as [string, string])} />;
    case 'file':
      return (
        <div className="row" style={{ alignItems: 'center' }}>
          {value?.url ? (
            <a href={value.url} target="_blank" rel="noreferrer noopener">
              <Icon name="file" size={13} /> {value.name}
            </a>
          ) : typeof value === 'string' && value ? (
            <span className="muted small">hochgeladen</span>
          ) : null}
          <label className="btn small secondary" style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={13} /> {busy ? 'Lädt…' : 'Datei wählen'}
            <input
              type="file"
              hidden
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setBusy(true);
                const data = await new Promise<string>((r) => {
                  const fr = new FileReader();
                  fr.onload = () => r(String(fr.result));
                  fr.readAsDataURL(f);
                });
                const up = await act(() => api.post('/api/uploads', { name: f.name, data }));
                setBusy(false);
                if (up) onChange(up.id);
              }}
            />
          </label>
          {value && (
            <button type="button" className="icon-btn" onClick={() => onChange('')} aria-label="Datei entfernen">
              ✕
            </button>
          )}
        </div>
      );
    default:
      return <Input type={def.type === 'email' ? 'email' : def.type === 'url' ? 'url' : def.type === 'phone' ? 'tel' : 'text'} value={value ?? ''} onChange={onChange} />;
  }
}

// --- filters --------------------------------------------------------------------------------

export interface Filter {
  field: string;
  op: string;
  value?: any;
}
// Filter rows, the column picker and cleanFilters are the shared list-view building block (pages/ListKit.tsx, translated).
export { cleanFilters, ColumnsModal, FilterRows } from './ListKit';

// --- views ----------------------------------------------------------------------------------------------------------------

export interface ViewConfig {
  columns: string[];
  filters: Filter[];
  sort: string;
  q: string;
}

/** Saved list views of an object (own and shared ones) as chips; "Alle" resets. */
export function ViewsBar({ object, current, active, onApply }: { object: string; current: ViewConfig; active: string; onApply: (id: string, c?: ViewConfig) => void }) {
  const views = useLoad(() => api.get<any[]>(`/api/object-views?object=${encodeURIComponent(object)}`), [object]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const act0 = (views.data ?? []).find((v) => v.id === active);
  const dirty = act0 && JSON.stringify(act0.config) !== JSON.stringify(current);
  const none = !(views.data ?? []).length;
  return (
    <div className="views-bar" data-tour="views-bar">
      {/* "Alle" only when there is something else to switch to */}
      {!none && (
        <button className={`chip${!active ? ' on' : ''}`} onClick={() => onApply('')}>
          Alle
        </button>
      )}
      {(views.data ?? []).map((v) => (
        <span key={v.id} className={`chip${active === v.id ? ' on' : ''}`} role="button" tabIndex={0} onClick={() => onApply(v.id, v.config)} onKeyDown={(e) => e.key === 'Enter' && onApply(v.id, v.config)}>
          {v.shared && <Icon name="contacts" size={13} />}
          {v.name}
          {v.mine && (
            <button
              type="button"
              className="chip-x"
              aria-label={`Ansicht ${v.name} löschen`}
              onClick={async (e) => {
                e.stopPropagation();
                if (confirmAsk(`Ansicht „${v.name}“ löschen?`) && (await act(() => api.del(`/api/object-views/${v.id}`)))) {
                  if (active === v.id) onApply('');
                  views.reload();
                }
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {dirty && act0.mine && (
        <button className="btn small secondary" onClick={() => act(() => api.patch(`/api/object-views/${act0.id}`, { config: current }), 'Ansicht gespeichert').then(views.reload)}>
          Änderungen speichern
        </button>
      )}
      <button className="btn small ghost" onClick={() => setSaving(true)}>
        <Icon name="bookmark" size={14} /> Ansicht speichern
      </button>
      {saving && (
        <Modal
          title="Ansicht speichern"
          onClose={() => setSaving(false)}
          footer={
            <button
              className="btn"
              disabled={!name.trim()}
              onClick={async () => {
                const v = await act(() => api.post('/api/object-views', { object, name, shared, config: current }), 'Ansicht gespeichert');
                if (v) {
                  setSaving(false);
                  setName('');
                  await views.reload();
                  onApply(v.id, v.config);
                }
              }}
            >
              Speichern
            </button>
          }
        >
          <Field label="Name">
            <Input value={name} onChange={setName} placeholder="z. B. Kunden in Berlin" autoFocus />
          </Field>
          <Check checked={shared} onChange={setShared} label="Für alle im Team sichtbar" />
          <p className="muted small">Gespeichert werden Suche, Filter, Spalten und Sortierung.</p>
        </Modal>
      )}
    </div>
  );
}

/** Table with chosen columns, sortable headers and a click per row. */
export function RecordTable({ fields, columns, rows, cell, sort, onSort, onRow }: { fields: FieldDef[]; columns: string[]; rows: any[]; cell: (row: any, def: FieldDef) => ReactNode; sort: string; onSort: (s: string) => void; onRow: (row: any) => void }) {
  const defs = columns.map((c) => fields.find((f) => f.key === c)).filter(Boolean) as FieldDef[];
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {defs.map((f) => {
              const on = sort === f.key || sort === `-${f.key}`;
              return (
                <th key={f.key}>
                  <button type="button" className={`th-sort${on ? ' on' : ''}`} onClick={() => onSort(sort === f.key ? `-${f.key}` : f.key)}>
                    {f.label} {on ? (sort.startsWith('-') ? '↓' : '↑') : ''}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody data-tour="record-table">
          {rows.map((r) => (
            <tr key={r.id} className="click" {...pressable(() => onRow(r))}>
              {defs.map((f, i) => (
                <td key={f.key} className={i === 0 ? 'strong' : undefined}>
                  {cell(r, f)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ total, page, size, onPage }: { total: number; page: number; size: number; onPage: (p: number) => void }) {
  if (total <= size) return null;
  return (
    <div className="row" style={{ marginTop: 12, justifyContent: 'center', alignItems: 'center' }}>
      <button className="btn small secondary" disabled={!page} onClick={() => onPage(page - 1)}>
        ← Zurück
      </button>
      <span className="muted">
        Seite {page + 1} von {Math.ceil(total / size)}
      </span>
      <button className="btn small secondary" disabled={(page + 1) * size >= total} onClick={() => onPage(page + 1)}>
        Weiter →
      </button>
    </div>
  );
}

// --- CSV import ---------------------------------------------------------------------------------

export function CsvImportModal({ title, url, hint, placeholder, onClose, onDone }: { title: string; url: string; hint: ReactNode; placeholder: string; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [wf, setWf] = useState(false);
  const [res, setRes] = useState<any>();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        res ? (
          <button className="btn" onClick={() => (onDone(), onClose())}>
            Fertig
          </button>
        ) : (
          <button className="btn" disabled={!csv} onClick={async () => setRes(await act(() => api.post(url, { csv, triggerWorkflows: wf })))}>
            Importieren
          </button>
        )
      }
    >
      {res ? (
        <>
          <p>
            <strong>{res.created}</strong> neu, <strong>{res.updated}</strong> aktualisiert, <strong>{res.skipped}</strong> übersprungen.
          </p>
          <p className="muted small">Erkannte Spalten: {res.mapped.join(', ') || '–'}</p>
          {res.errors?.length > 0 && (
            <div className="card" style={{ padding: 10 }}>
              {res.errors.map((e: any) => (
                <div key={e.row} className="small">
                  Zeile {e.row}: {e.error}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {hint}
          </p>
          <Field label="Datei">
            <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; setCsv(f ? await readCsvFile(f) : ''); }} />
          </Field>
          <Field label="…oder einfügen">
            <Textarea value={csv} onChange={setCsv} rows={6} placeholder={placeholder} />
          </Field>
          <Check checked={wf} onChange={setWf} label="Workflows auslösen" />
        </>
      )}
    </Modal>
  );
}

// --- associations ---------------------------------------------------------------------------------

interface Linked {
  association_id: string;
  type: string;
  record_id: string;
  name: string;
  sub?: string;
  link?: string;
  labels: { id: string; name: string }[];
  primary: boolean;
  primary_for: string;
}

let typesCache: { loc: string; p: Promise<any[]> } | null = null;
export function useAssocTypes() {
  const [types, setTypes] = useState<any[]>([]);
  useEffect(() => {
    const loc = localStorage.getItem('pghl.location') ?? '';
    if (!typesCache || typesCache.loc !== loc) typesCache = { loc, p: api.get<any[]>('/api/associations/types').catch(() => []) };
    void typesCache.p.then(setTypes);
  }, []);
  return types;
}
export const refreshAssocTypes = () => void (typesCache = null);

/**
 * "Verknüpfungen": every record linked to this one, grouped by type, with labels and the primary
 * flag. Adding and editing happen inline (no second dialog, so it also works inside a modal).
 */
export function AssociationsPanel({ type, id, exclude = [], title = 'Verknüpfungen', onChange, compact }: { type: string; id: string; exclude?: string[]; title?: string; onChange?: () => void; compact?: boolean }) {
  const list = useLoad(() => api.get<Linked[]>(`/api/associations?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`), [type, id]);
  const types = useAssocTypes();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState('');
  const shown = (list.data ?? []).filter((l) => !exclude.includes(l.type));
  const groups = useMemo(() => {
    const m = new Map<string, Linked[]>();
    for (const l of shown) m.set(l.type, [...(m.get(l.type) ?? []), l]);
    return [...m.entries()];
  }, [list.data, exclude.join()]);
  const reload = () => (list.reload(), onChange?.());
  return (
    <div className={compact ? 'assoc compact' : 'card assoc'} data-tour="assoc">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <Icon name="link" /> {title}
        </h2>
        <button className="btn small secondary" data-tour="assoc-add" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          {adding ? 'Schließen' : '+ Verknüpfen'}
        </button>
      </div>
      {adding && <AssocAdd from={{ type, id }} types={types.filter((t) => !exclude.includes(t.type))} onDone={() => (setAdding(false), reload())} />}
      {!list.data ? (
        <Spinner />
      ) : !groups.length ? (
        <p className="muted small">Noch nichts verknüpft.</p>
      ) : (
        groups.map(([t, items]) => {
          const meta = types.find((x) => x.type === t);
          return (
            <div key={t} className="assoc-group">
              <div className="assoc-head">
                <Icon name={objIcon(meta?.icon)} size={14} /> {meta?.plural ?? t} <span className="muted">({items.length})</span>
              </div>
              {items.map((l) => (
                <div key={l.association_id} className="assoc-row">
                  <div className="grow">
                    {l.link ? <Link to={l.link}>{l.name}</Link> : <strong>{l.name}</strong>}
                    {l.primary && (l.primary_for === id || l.primary_for === l.record_id) && (
                      <Badge tone="blue">{l.primary_for === id ? 'Primär' : type === 'company' ? 'Primäre Firma' : 'Primär (dort)'}</Badge>
                    )}
                    {l.labels.map((x) => (
                      <Badge key={x.id} tone="purple">
                        {x.name}
                      </Badge>
                    ))}
                    {l.sub && <div className="muted small">{l.sub}</div>}
                    {editing === l.association_id && <AssocEdit from={{ type, id }} item={l} onDone={() => (setEditing(''), reload())} />}
                  </div>
                  <span className="actions">
                    <button className="icon-btn" data-tour="assoc-edit" title="Labels / primär" aria-label="Verknüpfung bearbeiten" onClick={() => setEditing(editing === l.association_id ? '' : l.association_id)}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button className="icon-btn" title="Verknüpfung lösen" aria-label="Verknüpfung lösen" onClick={() => confirmAsk(`Verknüpfung mit „${l.name}“ lösen?`) && act(() => api.del(`/api/associations/${l.association_id}`)).then(reload)}>
                      <Icon name="unlink" size={14} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}

function useLabels(a: string, b: string) {
  return useLoad(() => (a && b ? api.get<any[]>(`/api/association-labels?a_type=${encodeURIComponent(a)}&b_type=${encodeURIComponent(b)}`) : Promise.resolve([])), [a, b]);
}

function AssocAdd({ from, types, onDone }: { from: { type: string; id: string }; types: any[]; onDone: () => void }) {
  const searchable = types.filter((t) => t.searchable && !(t.type === from.type && false));
  const [to, setTo] = useState<string>(searchable.find((t) => t.type === 'company' && from.type === 'contact')?.type ?? searchable.find((t) => t.type !== from.type)?.type ?? searchable[0]?.type ?? '');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [pick, setPick] = useState<any>();
  const [labels, setLabels] = useState<string[]>([]);
  const [primary, setPrimary] = useState(false);
  const avail = useLabels(from.type, to);
  useEffect(() => {
    if (!to) return;
    const t = setTimeout(() => api.get<any[]>(`/api/associations/search?type=${encodeURIComponent(to)}&q=${encodeURIComponent(q)}&limit=8`).then(setFound).catch(() => setFound([])), 180);
    return () => clearTimeout(t);
  }, [q, to]);
  const canPrimary = (from.type === 'contact' && to === 'company') || (from.type === 'opportunity' && to === 'company');
  return (
    <div className="assoc-add">
      <div className="row">
        <div style={{ width: 160 }}>
          <Select value={to} onChange={(v) => (setTo(v), setPick(undefined), setLabels([]))} options={searchable.map((t) => [t.type, t.label] as [string, string])} />
        </div>
        <div className="grow">
          <Input value={q} onChange={setQ} placeholder="Suchen…" autoFocus />
        </div>
      </div>
      {!pick ? (
        <div className="assoc-found">
          {found
            .filter((f) => !(to === from.type && f.id === from.id))
            .map((f) => (
              <button type="button" key={f.id} onClick={() => setPick(f)}>
                <strong>{f.name}</strong> <span className="muted small">{f.sub}</span>
              </button>
            ))}
          {!found.length && <span className="muted small">Nichts gefunden.</span>}
        </div>
      ) : (
        <>
          <p style={{ margin: '8px 0' }}>
            <strong>{pick.name}</strong>{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), setPick(undefined))}>
              ändern
            </a>
          </p>
          {(avail.data ?? []).length > 0 && (
            <div className="opt-toggle" style={{ marginBottom: 8 }}>
              {(avail.data ?? []).map((l) => (
                <button type="button" key={l.id} className={labels.includes(l.id) ? 'on' : ''} onClick={() => setLabels(labels.includes(l.id) ? labels.filter((x) => x !== l.id) : [...labels, l.id])}>
                  {l.name}
                </button>
              ))}
            </div>
          )}
          {canPrimary && <Check checked={primary} onChange={setPrimary} label="Als primäre Firma" />}
          <button
            className="btn small"
            onClick={async () => {
              const r = await act(() => api.post('/api/associations', { from_type: from.type, from_id: from.id, to_type: to, to_id: pick.id, labels, primary }), 'Verknüpft');
              if (r) onDone();
            }}
          >
            Verknüpfen
          </button>
        </>
      )}
    </div>
  );
}

function AssocEdit({ from, item, onDone }: { from: { type: string; id: string }; item: Linked; onDone: () => void }) {
  const avail = useLabels(from.type, item.type);
  const [labels, setLabels] = useState(item.labels.map((l) => l.id));
  const [primary, setPrimary] = useState(item.primary && item.primary_for === from.id);
  const canPrimary = item.type === 'company' && ['contact', 'opportunity'].includes(from.type);
  const reverse = from.type === 'company' && ['contact', 'opportunity'].includes(item.type);
  const [primaryOther, setPrimaryOther] = useState(item.primary && item.primary_for === item.record_id);
  return (
    <div className="assoc-edit" data-tour="assoc-labels">
      {(avail.data ?? []).length ? (
        <div className="opt-toggle">
          {(avail.data ?? []).map((l) => (
            <button type="button" key={l.id} className={labels.includes(l.id) ? 'on' : ''} onClick={() => setLabels(labels.includes(l.id) ? labels.filter((x) => x !== l.id) : [...labels, l.id])}>
              {l.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small" style={{ margin: '4px 0' }}>
          Keine Labels für diese Verknüpfung – unter <Link to="properties">Eigenschaften</Link> anlegen.
        </p>
      )}
      {canPrimary && <Check checked={primary} onChange={setPrimary} label="Primäre Firma" />}
      {reverse && <Check checked={primaryOther} onChange={setPrimaryOther} label="Primäre Firma dieses Datensatzes" />}
      <button
        className="btn small"
        onClick={async () => {
          const body: any = { labels };
          if (canPrimary) body.primary_for = primary ? from.id : item.primary_for === from.id ? '' : undefined;
          if (reverse) body.primary_for = primaryOther ? item.record_id : item.primary_for === item.record_id ? '' : undefined;
          if (await act(() => api.patch(`/api/associations/${item.association_id}`, body), 'Gespeichert')) onDone();
        }}
      >
        Speichern
      </button>
    </div>
  );
}

// --- timeline ---------------------------------------------------------------------------------------

export function Timeline({ items }: { items: { id: string; at: string; summary: string; kind?: string; by?: string | null; contact_id?: string; contact_name?: string }[] }) {
  if (!items.length) return <p className="muted">Noch keine Aktivität.</p>;
  return (
    <ul className="timeline rec-timeline">
      {items.map((a) => (
        <li key={a.id} className={`k-${a.kind ?? 'record'}`}>
          <span className="muted small" style={{ minWidth: 110 }}>
            {dt(a.at)}
          </span>
          <span className="grow">
            {a.kind === 'contact' && a.contact_id && (
              <>
                <Link to={`contacts/${a.contact_id}`}>{a.contact_name}</Link>:{' '}
              </>
            )}
            {a.kind === 'note' && <Icon name="note" size={13} />} {a.summary}
            {a.by && <span className="muted small"> · {a.by}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Notes({ notes, onAdd, onDelete }: { notes: any[]; onAdd: (body: string) => Promise<unknown>; onDelete: (id: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <>
      <Textarea value={note} onChange={setNote} placeholder="Notiz…" />
      <p>
        <button className="btn small" disabled={!note.trim()} onClick={async () => (await onAdd(note)) && setNote('')}>
          Notiz speichern
        </button>
      </p>
      {notes.map((n) => (
        <div key={n.id} className="card" style={{ padding: 12 }}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
          <div className="muted small row" style={{ justifyContent: 'space-between' }}>
            <span>
              {n.user_name ?? 'Automation'} · {dt(n.created_at)}
            </span>
            <a href="#" onClick={(e) => (e.preventDefault(), confirmAsk('Notiz löschen?') && onDelete(n.id))}>
              löschen
            </a>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Groups of properties as label/value rows, or inputs while editing. Einfach-Modus: viewing shows only the filled ones; editing shows the required and the
 * first few at first glance, the rest behind "Weitere Felder" (open by itself when one of them holds a value). Profi: all, as before.
 */
export function PropertyCard({ id = 'props', title, fields, groups, values, edit, setEdit, users, onSave, extra }: { id?: string; title: string; fields: FieldDef[]; groups: { key: string; label: string }[]; values: Record<string, any>; edit: Record<string, any> | null; setEdit: (v: Record<string, any> | null) => void; users: User[]; onSave: (v: Record<string, any>) => Promise<unknown>; extra?: ReactNode }) {
  const simple = useSimple();
  const sections: [string, FieldDef[]][] = [];
  const byGroup = new Map<string, FieldDef[]>();
  for (const f of fields) byGroup.set(f.group_key ?? '', [...(byGroup.get(f.group_key ?? '') ?? []), f]);
  sections.push(['', byGroup.get('') ?? []]);
  for (const g of groups) if (byGroup.get(g.key)?.length) sections.push([g.label, byGroup.get(g.key)!]);
  for (const [k, list] of byGroup) if (k && !groups.some((g) => g.key === k)) sections.push([k, list]);
  const firstGlance = new Set(splitFields(sections.flatMap(([, list]) => list)).main.map((f) => f.key));
  const filled = (f: FieldDef) => anyFilled([values[f.key]]);
  const field = (f: FieldDef) =>
    edit ? (
      f.type === 'checkbox' ? (
        <div key={f.key} className="field">
          <PropInput def={f} value={edit[f.key]} onChange={(v) => setEdit({ ...edit, [f.key]: v })} users={users} />
        </div>
      ) : (
        <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.description || undefined}>
          <PropInput def={f} value={edit[f.key]} onChange={(v) => setEdit({ ...edit, [f.key]: v })} users={users} />
        </Field>
      )
    ) : (
      <div key={f.key} className="kv">
        <div className="muted small">{f.label}</div>
        <div>
          <PropValue def={f} value={values[f.key]} users={users} />
        </div>
      </div>
    );
  const render = (pick: (f: FieldDef) => boolean) =>
    sections.map(([label, all]) => {
      const list = all.filter(pick);
      return list.length ? (
        <div key={label || '_'} className="prop-section">
          {label && <div className="prop-group">{label}</div>}
          {list.map(field)}
        </div>
      ) : null;
    });
  const later = fields.filter((f) => !firstGlance.has(f.key));
  return (
    <div className="card prop-card" data-tour="prop-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {edit ? (
          <div className="actions">
            <button className="btn small secondary" onClick={() => setEdit(null)}>
              Abbrechen
            </button>
            <button className="btn small" onClick={async () => (await onSave(edit)) && setEdit(null)}>
              Speichern
            </button>
          </div>
        ) : (
          <button className="btn small secondary" onClick={() => setEdit(Object.fromEntries(fields.map((f) => [f.key, values[f.key] ?? (f.type === 'multiselect' ? [] : f.type === 'checkbox' ? false : '')])))}>
            Bearbeiten
          </button>
        )}
      </div>
      {!simple ? (
        render(() => true)
      ) : edit ? (
        <>
          {render((f) => firstGlance.has(f.key))}
          {later.length > 0 && (
            <MoreFields id={`${id}-edit`} values={later.map((f) => edit[f.key])} count={later.length}>
              {render((f) => !firstGlance.has(f.key))}
            </MoreFields>
          )}
        </>
      ) : fields.some(filled) ? (
        render(filled)
      ) : (
        <p className="muted small">Noch keine Angaben – über „Bearbeiten“ ausfüllen.</p>
      )}
      {extra}
    </div>
  );
}

// --- contacts list: filter by company --------------------------------------------------------------

const COMPANY_FILTERS: [string, string][] = [
  ['company.q', 'Firma (Name/Domain)'],
  ['company.industry', 'Firma: Branche'],
  ['company.lifecycle_stage', 'Firma: Phase'],
  ['company.size', 'Firma: Größe'],
  ['company.city', 'Firma: Ort'],
  ['company.country', 'Firma: Land'],
];
export type CompanyFilterValue = Record<string, string>;
export const companyQs = (v: CompanyFilterValue) =>
  Object.entries(v)
    .filter(([, x]) => x)
    .map(([k, x]) => `&${encodeURIComponent(k)}=${encodeURIComponent(x)}`)
    .join('');
export const pickCompany = (f: Record<string, any>): CompanyFilterValue => Object.fromEntries(Object.entries(f ?? {}).filter(([k, v]) => k.startsWith('company.') && typeof v === 'string'));

/** Contacts page: one filter on a property of the associated companies (also saved in smart lists). */
export function CompanyFilter({ value, onChange }: { value: CompanyFilterValue; onChange: (v: CompanyFilterValue) => void }) {
  // Part of the contact list: translated with it (contacts catalog; the German labels above are its message ids).
  const t = useT('contacts');
  const [picked, setPicked] = useState('');
  // A saved smart list brings its own field; otherwise the one picked here.
  const field = Object.keys(value)[0] ?? picked;
  const cur = field ? (value[field] ?? '') : '';
  const isStage = field === 'company.lifecycle_stage';
  const put = (v: string) => (setPicked(field), onChange(v ? { [field]: v } : {}));
  return (
    <div className="company-filter">
      <Select value={field} onChange={(f) => (setPicked(f), onChange(f && cur ? { [f]: cur } : {}))} placeholder={t('Firma: –')} aria={t('Nach Firma filtern')} options={COMPANY_FILTERS.map(([k, l]) => [k, t(l)] as [string, string])} />
      {field &&
        (isStage ? (
          <Select value={cur} onChange={put} placeholder={t('alle')} aria={t('Wert')} options={Object.entries(LIFECYCLE).map(([k, l]) => [k, t(l)] as [string, string])} />
        ) : (
          <Input value={cur} onChange={put} placeholder={t('Wert')} aria-label={t('Wert')} />
        ))}
    </div>
  );
}

// --- deals: custom property values --------------------------------------------------------------------

/** Deal properties from the properties page, inside the opportunity dialog (nothing when none exist). */
export function DealProperties({ oppId }: { oppId: string }) {
  const data = useLoad(() => api.get<any>(`/api/opportunities/${oppId}/properties`), [oppId]);
  const users = useUsers();
  const [vals, setVals] = useState<Record<string, any> | null>(null);
  const simple = useSimple();
  if (!data.data?.definitions?.length) return null;
  const defs = data.data.definitions as FieldDef[];
  const v = vals ?? data.data.properties;
  return (
    <div className="deal-props">
      {/* Einfach-Modus: folded under its own name unless a property is set */}
      <MoreFields id="deal-props" label="Deal-Eigenschaften" values={Object.values(data.data.properties ?? {})}>
      {!simple && <div className="prop-group">Deal-Eigenschaften</div>}
      <div className="grid2">
        {defs.map((f) =>
          f.type === 'checkbox' ? (
            <div key={f.key} className="field">
              <PropInput def={f} value={v[f.key]} onChange={(x) => setVals({ ...v, [f.key]: x })} users={users} />
            </div>
          ) : (
            <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
              <PropInput def={f} value={v[f.key]} onChange={(x) => setVals({ ...v, [f.key]: x })} users={users} />
            </Field>
          ),
        )}
      </div>
      {vals && (
        <button className="btn small" onClick={() => act(() => api.put(`/api/opportunities/${oppId}/properties`, { properties: vals }), 'Eigenschaften gespeichert').then((r) => r && (setVals(null), data.reload()))}>
          Eigenschaften speichern
        </button>
      )}
      </MoreFields>
    </div>
  );
}
