import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { useSession } from '../session';
import { act, Check, confirmAsk, Field, Input, Modal, pressable, Select, useLoad } from '../ui';
import './lists.css';

/**
 * The shared list-view building block: smart-list tabs (saved views per person or team, a pinned default, "+ Smart List"),
 * a column picker (choose and reorder), advanced filter rows by field type, a sortable table with row selection, the bulk bar
 * and a pager. The deal list (pages/DealList.tsx) is built from it; companies and custom objects use its column picker and
 * filter rows through pages/ObjectKit.tsx. Views are stored by `/api/object-views` (columns, filters, sort, search).
 */

export type ListFieldType = 'text' | 'textarea' | 'number' | 'currency' | 'date' | 'datetime' | 'select' | 'multiselect' | 'checkbox' | 'url' | 'email' | 'phone' | 'user' | 'file' | 'id';
export interface ListField {
  key: string;
  label: string;
  type: ListFieldType;
  options?: string[];
  /** Option values → labels (stages, statuses …). */
  optionLabels?: Record<string, string>;
  /** Not offered as a filter (e.g. a computed column). */
  noFilter?: boolean;
  /** Not sortable on the server. */
  noSort?: boolean;
}
export interface ListUser {
  id: string;
  name: string;
}
export interface ListFilter {
  field: string;
  op: string;
  value?: any;
}
export interface ListViewConfig {
  columns: string[];
  filters: ListFilter[];
  sort: string;
  q: string;
}

// --- filter rows ------------------------------------------------------------------------------------------------------

/** Operators per field type; the labels are message ids of the `lists` catalog. */
const OPS_BY_TYPE: Record<string, [string, string][]> = {
  text: [['contains', 'enthält'], ['eq', 'ist'], ['neq', 'ist nicht'], ['not_contains', 'enthält nicht'], ['empty', 'ist leer'], ['not_empty', 'ist nicht leer']],
  number: [['eq', '='], ['gt', '>'], ['lt', '<'], ['gte', '≥'], ['lte', '≤'], ['empty', 'ist leer'], ['not_empty', 'ist nicht leer']],
  date: [['gt', 'nach'], ['lt', 'vor'], ['eq', 'am'], ['empty', 'ist leer'], ['not_empty', 'ist nicht leer']],
  select: [['eq', 'ist'], ['neq', 'ist nicht'], ['empty', 'ist leer'], ['not_empty', 'ist nicht leer']],
  multiselect: [['contains', 'enthält'], ['not_contains', 'enthält nicht'], ['empty', 'ist leer'], ['not_empty', 'ist nicht leer']],
  checkbox: [['eq', 'ist']],
  user: [['eq', 'ist'], ['neq', 'ist nicht'], ['empty', 'niemand'], ['not_empty', 'jemand']],
};
export const opsFor = (type: string) => OPS_BY_TYPE[type === 'currency' ? 'number' : type === 'datetime' ? 'date' : type] ?? OPS_BY_TYPE.text;

export function FilterRows({ fields, value, onChange, users }: { fields: ListField[]; value: ListFilter[]; onChange: (f: ListFilter[]) => void; users?: ListUser[] }) {
  const t = useT('lists');
  const usable = fields.filter((f) => !f.noFilter);
  const set = (i: number, patch: Partial<ListFilter>) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="filter-rows">
      {value.map((f, i) => {
        const def = usable.find((x) => x.key === f.field) ?? usable[0];
        const ops = opsFor(def?.type ?? 'text');
        const needsValue = !['empty', 'not_empty'].includes(f.op);
        const opts = (def?.options ?? []).map((o) => [o, def?.optionLabels?.[o] ?? o] as [string, string]);
        return (
          <div key={i} className="filter-row">
            <Select value={f.field} aria={t('Feld')} onChange={(v) => set(i, { field: v, op: opsFor(usable.find((x) => x.key === v)?.type ?? 'text')[0][0], value: '' })} options={usable.map((x) => [x.key, x.label] as [string, string])} />
            <Select value={f.op} aria={t('Bedingung')} onChange={(v) => set(i, { op: v })} options={ops.map(([k, l]) => [k, t(l)] as [string, string])} />
            {needsValue &&
              (def?.type === 'checkbox' ? (
                <Select value={String(f.value ?? 'true')} aria={t('Wert')} onChange={(v) => set(i, { value: v === 'true' })} options={[['true', t('ja')], ['false', t('nein')]]} />
              ) : def?.type === 'select' || def?.type === 'multiselect' ? (
                <Select value={f.value ?? ''} aria={t('Wert')} onChange={(v) => set(i, { value: v })} placeholder={t('wählen…')} options={opts} />
              ) : def?.type === 'user' ? (
                <Select value={f.value ?? ''} aria={t('Wert')} onChange={(v) => set(i, { value: v })} placeholder={t('wählen…')} options={(users ?? []).map((u) => [u.id, u.name] as [string, string])} />
              ) : (
                <Input value={f.value ?? ''} aria-label={t('Wert')} type={def?.type === 'date' || def?.type === 'datetime' ? 'date' : def?.type === 'number' || def?.type === 'currency' ? 'number' : 'text'} onChange={(v) => set(i, { value: v })} placeholder={t('Wert')} />
              ))}
            <button type="button" className="icon-btn" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('Filter entfernen')}>
              ✕
            </button>
          </div>
        );
      })}
      <button type="button" className="btn small secondary" onClick={() => usable[0] && onChange([...value, { field: usable[0].key, op: opsFor(usable[0].type)[0][0], value: '' }])}>
        + {t('Filter')}
      </button>
    </div>
  );
}

/** Filters ready for the API: incomplete rows dropped. */
export const cleanFilters = (f: ListFilter[]) => f.filter((x) => x.field && x.op && (['empty', 'not_empty'].includes(x.op) || (x.value !== '' && x.value !== undefined && x.value !== null)));

// --- columns --------------------------------------------------------------------------------------------------------------

/** Choose columns and their order (tick boxes, arrows, drag & drop). */
export function ColumnsModal({ fields, value, onChange, onClose }: { fields: ListField[]; value: string[]; onChange: (v: string[]) => void; onClose: () => void }) {
  const t = useT('lists');
  const [cols, setCols] = useState(value);
  const [drag, setDrag] = useState<string | null>(null);
  const moveTo = (k: string, to: number) => {
    const i = cols.indexOf(k);
    if (i < 0 || to < 0 || to >= cols.length || i === to) return;
    const next = [...cols];
    next.splice(i, 1);
    next.splice(to, 0, k);
    setCols(next);
  };
  const ordered = [...(cols.map((k) => fields.find((f) => f.key === k)).filter(Boolean) as ListField[]), ...fields.filter((f) => !cols.includes(f.key))];
  return (
    <Modal
      title={t('Spalten')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!cols.length} onClick={() => (onChange(cols), onClose())}>
          {t('Übernehmen')}
        </button>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Haken setzen, dann ziehen oder mit den Pfeilen sortieren.')}
      </p>
      <div className="col-pick">
        {ordered.map((f) => {
          const on = cols.includes(f.key);
          const i = cols.indexOf(f.key);
          return (
            <div
              key={f.key}
              className={`col-pick-row${drag === f.key ? ' dragging' : ''}`}
              draggable={on}
              onDragStart={(e) => (e.dataTransfer.setData('text/plain', f.key), setDrag(f.key))}
              onDragOver={(e) => {
                if (!on || !drag) return;
                e.preventDefault();
                if (drag !== f.key) moveTo(drag, i);
              }}
              onDragEnd={() => setDrag(null)}
            >
              <Check checked={on} onChange={(v) => setCols(v ? [...cols, f.key] : cols.filter((c) => c !== f.key))} label={f.label} />
              {on && (
                <span className="actions">
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => moveTo(f.key, i - 1)} aria-label={t('{name} nach oben', { name: f.label })}>
                    ↑
                  </button>
                  <button type="button" className="icon-btn" disabled={i === cols.length - 1} onClick={() => moveTo(f.key, i + 1)} aria-label={t('{name} nach unten', { name: f.label })}>
                    ↓
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// --- smart-list tabs ----------------------------------------------------------------------------------------------------

interface SavedView {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
  config: ListViewConfig;
}
const pinKey = (userId: string, object: string) => `pghl.views.default.${userId}.${object}`;
const readPin = (key: string) => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const writePin = (key: string, v: string) => {
  try {
    if (v) localStorage.setItem(key, v);
    else localStorage.removeItem(key);
  } catch {
    // storage blocked: the pin only lasts for this page
  }
};
const sameConfig = (a: ListViewConfig, b: ListViewConfig) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Saved views as tabs: the built-in first tab (`allLabel`) is always there, then the person's own and the team's smart lists.
 * ☆ pins a tab as the person's default (it opens with the list, kept in this browser); "+ Smart List" saves the current
 * columns, filters, sort and search, optionally for the whole team.
 */
export function SmartListTabs({ object, allLabel, base, current, active, onApply }: { object: string; allLabel: string; base: ListViewConfig; current: ListViewConfig; active: string; onApply: (id: string, c: ListViewConfig) => void }) {
  const t = useT('lists');
  const session = useSession();
  const key = pinKey(session.user?.id ?? '', object);
  const views = useLoad(() => api.get<SavedView[]>(`/api/object-views?object=${encodeURIComponent(object)}`), [object]);
  const [pin, setPin] = useState(() => readPin(key));
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const opened = useRef(false);
  const list = views.data ?? [];
  // The pinned default opens once, when the views are there.
  useEffect(() => {
    if (opened.current || !views.data) return;
    opened.current = true;
    const v = views.data.find((x) => x.id === pin);
    if (v && !active) onApply(v.id, v.config);
  }, [views.data]);
  const cur = list.find((v) => v.id === active);
  const dirty = active ? !!cur && !sameConfig(cur.config, current) : !sameConfig(base, current);
  const togglePin = (id: string) => {
    const next = pin === id ? '' : id;
    setPin(next);
    writePin(key, next);
  };
  const tab = (id: string, label: string, v?: SavedView) => (
    <span key={id || 'all'} className={`chip sl-tab${active === id ? ' on' : ''}`} role="presentation">
      <button type="button" role="tab" aria-selected={active === id} className="sl-tab-btn" onClick={() => onApply(id, v ? v.config : base)}>
        {v?.shared && (
          <span className="sl-team" title={t('Fürs Team')}>
            <Icon name="contacts" size={13} />
          </span>
        )}
        {label}
      </button>
      <button type="button" className={`chip-x sl-pin${pin === id || (!id && !pin) ? ' on' : ''}`} aria-pressed={pin === id || (!id && !pin)} aria-label={pin === id || (!id && !pin) ? t('{name} ist deine Standard-Ansicht', { name: label }) : t('{name} als Standard anheften', { name: label })} title={t('Als Standard anheften')} onClick={() => togglePin(id)}>
        {pin === id || (!id && !pin) ? '★' : '☆'}
      </button>
      {v?.mine && (
        <button
          type="button"
          className="chip-x"
          aria-label={t('Smart List {name} löschen', { name: label })}
          onClick={async () => {
            if (!confirmAsk(t('Smart List „{name}“ löschen?', { name: label }))) return;
            if (await act(() => api.del(`/api/object-views/${id}`))) {
              if (pin === id) togglePin(id);
              if (active === id) onApply('', base);
              await views.reload();
            }
          }}
        >
          ×
        </button>
      )}
    </span>
  );
  return (
    <div className="views-bar sl-tabs" role="tablist" aria-label={t('Smart Lists')} data-tour="smart-list-tabs">
      {tab('', allLabel)}
      {list.map((v) => tab(v.id, v.name, v))}
      {dirty && cur?.mine && (
        <button className="btn small secondary" onClick={() => act(() => api.patch(`/api/object-views/${cur.id}`, { config: current }), t('Smart List gespeichert')).then(views.reload)}>
          {t('Änderungen speichern')}
        </button>
      )}
      <button className="btn small ghost" data-tour="smart-list-add" onClick={() => setSaving(true)}>
        + {t('Smart List')}
      </button>
      {saving && (
        <Modal
          title={t('Neue Smart List')}
          onClose={() => setSaving(false)}
          footer={
            <button
              className="btn"
              disabled={!name.trim()}
              onClick={async () => {
                const v = await act(() => api.post<SavedView>('/api/object-views', { object, name, shared, config: current }), t('Smart List gespeichert'));
                if (!v) return;
                setSaving(false);
                setName('');
                await views.reload();
                onApply(v.id, v.config);
              }}
            >
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Name')}>
            <Input value={name} onChange={setName} placeholder={t('z. B. Heiße Deals über 5.000 €')} autoFocus />
          </Field>
          <Check checked={shared} onChange={setShared} label={t('Für alle im Team sichtbar')} />
          <p className="muted small">{t('Gespeichert werden Suche, Filter, Spalten und Sortierung.')}</p>
        </Modal>
      )}
    </div>
  );
}

// --- table, bulk bar, pager -----------------------------------------------------------------------------------------------

/** Table with chosen columns, sortable headers (`field` / `-field`), row selection and a click per row. */
export function DataTable({ fields, columns, rows, cell, sort, onSort, onRow, selected, onSelect, caption }: { fields: ListField[]; columns: string[]; rows: any[]; cell: (row: any, def: ListField) => ReactNode; sort: string; onSort: (s: string) => void; onRow: (row: any) => void; selected: string[]; onSelect: (ids: string[]) => void; caption: string }) {
  const t = useT('lists');
  const defs = columns.map((c) => fields.find((f) => f.key === c)).filter(Boolean) as ListField[];
  const ids = rows.map((r) => r.id as string);
  const all = ids.length > 0 && ids.every((x) => selected.includes(x));
  return (
    <div className="table-wrap">
      <table className="t list-table">
        <caption className="ls-sr">{caption}</caption>
        <thead>
          <tr>
            <th className="sel">
              <input type="checkbox" checked={all} onChange={(e) => onSelect(e.target.checked ? [...new Set([...selected, ...ids])] : selected.filter((x) => !ids.includes(x)))} aria-label={t('Alle auf dieser Seite wählen')} />
            </th>
            {defs.map((f) => {
              const on = sort === f.key || sort === `-${f.key}`;
              return (
                <th key={f.key} aria-sort={on ? (sort.startsWith('-') ? 'descending' : 'ascending') : undefined}>
                  {f.noSort ? (
                    f.label
                  ) : (
                    <button type="button" className={`th-sort${on ? ' on' : ''}`} onClick={() => onSort(sort === f.key ? `-${f.key}` : f.key)}>
                      {f.label} {on ? (sort.startsWith('-') ? '↓' : '↑') : ''}
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`click${selected.includes(r.id) ? ' on' : ''}`} {...pressable(() => onRow(r))}>
              <td className="sel" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={selected.includes(r.id)} onChange={(e) => onSelect(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} aria-label={t('Zeile wählen')} />
              </td>
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

export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const t = useT('lists');
  if (!count) return null;
  return (
    <div className="bulk-bar list-bulk" role="region" aria-label={t('Massenaktionen')} data-tour="list-bulk">
      <strong>{t.plural(count, { one: '{n} ausgewählt', other: '{n} ausgewählt' })}</strong>
      {children}
      <button type="button" className="btn small ghost" onClick={onClear}>
        {t('Auswahl aufheben')}
      </button>
    </div>
  );
}

export function ListPager({ total, page, size, onPage }: { total: number; page: number; size: number; onPage: (p: number) => void }) {
  const t = useT('lists');
  if (total <= size) return null;
  return (
    <div className="row" style={{ marginTop: 12, justifyContent: 'center', alignItems: 'center' }}>
      <button className="btn small secondary" disabled={!page} onClick={() => onPage(page - 1)}>
        ← {t('Zurück')}
      </button>
      <span className="muted">{t('Seite {page} von {pages}', { page: page + 1, pages: Math.ceil(total / size) })}</span>
      <button className="btn small secondary" disabled={(page + 1) * size >= total} onClick={() => onPage(page + 1)}>
        {t('Weiter')} →
      </button>
    </div>
  );
}
