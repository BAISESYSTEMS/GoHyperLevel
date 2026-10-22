import { useState } from 'react';
import { api, d, dt } from '../api';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { act, confirmAsk, Field, Input, Modal, Select, useLoad } from '../ui';
import { ColumnsModal, type ListField } from './ListKit';
import './smart-lists.css';

/**
 * Smart Lists 2.0 on the contacts page (modules/smart-lists.ts, docs/sales.md#smart-lists): the quick switch between saved views
 * above the table, saving the current search, filters, columns and sort (for the team or only for me), renaming and deleting,
 * the column picker with custom fields, and sortable headers for every column. The contact list (pages/Contacts.tsx) owns the
 * state; this file only shows it.
 */

export interface ContactView {
  filter: Record<string, any>;
  columns: string[];
  sort: string;
  sort_dir: string;
}
export interface SmartList extends ContactView {
  id: string;
  name: string;
  visibility: 'shared' | 'private';
  mine: boolean;
  can_edit: boolean;
  owner_name: string;
}
interface CustomField {
  key: string;
  label: string;
  type: string;
}

/** Columns besides the contact list's own: shown after them, in the order chosen. */
const EXTRA = ['company', 'city', 'activity'];
export const isExtraColumn = (k: string) => EXTRA.includes(k) || k.startsWith('custom.');
/** Columns the server cannot sort by (computed or lists). */
const NO_SORT = new Set(['tags', 'health', 'score']);
/** Newest first is the natural way for dates. */
const firstDir = (k: string) => (k === 'created' || k === 'activity' ? 'desc' : 'asc');

/** Empty filter values (an unset attribution filter, no tag) do not make a view different. */
const set = (f: Record<string, any>) => JSON.stringify(Object.entries(f ?? {}).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)).sort(([x], [y]) => x.localeCompare(y)));
const same = (a: ContactView, b: ContactView) => set(a.filter) === set(b.filter) && JSON.stringify([a.columns, a.sort || '', a.sort_dir || '']) === JSON.stringify([b.columns, b.sort || '', b.sort_dir || '']);

/** The custom fields of the sub-account (for columns and sorting). */
export function useCustomFields(): CustomField[] {
  return useLoad(() => api.get<CustomField[]>('/api/custom-fields').catch(() => []), []).data ?? [];
}

/** Every column a contact view can show, with its label: the list's own (labels from the page) plus extras and custom fields. */
export function useColumnFields(base: Record<string, string>, available: readonly string[]): ListField[] {
  const t = useT('smartlists');
  const custom = useCustomFields();
  const extra: Record<string, string> = { company: t('Firma'), city: t('Ort'), activity: t('Letzte Aktivität') };
  return [
    ...available.map((k) => ({ key: k, label: base[k] ?? k, type: 'text' as const })),
    ...EXTRA.map((k) => ({ key: k, label: extra[k], type: 'text' as const })),
    ...custom.map((f) => ({ key: `custom.${f.key}`, label: f.label, type: (f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text') as ListField['type'] })),
  ];
}

/** A sortable column head: first click sorts (A–Z, dates newest first), the next one turns it round. */
export function SortTh({ k, label, sort, dir, onSort }: { k: string; label: string; sort: string; dir: string; onSort: (sort: string, dir: string) => void }) {
  const t = useT('smartlists');
  if (NO_SORT.has(k)) return <th>{label}</th>;
  const on = sort === k;
  const way = on ? dir || firstDir(k) : '';
  return (
    <th aria-sort={on ? (way === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className={`th-sort${on ? ' on' : ''}`} title={t('Sortieren')} onClick={() => onSort(k, on ? (way === 'asc' ? 'desc' : 'asc') : firstDir(k))}>
        {label} {on ? (way === 'asc' ? '↑' : '↓') : ''}
      </button>
    </th>
  );
}

/** Heads of the extra columns (company, city, last activity, custom fields). */
export function ExtraHeads({ keys, fields, sort, dir, onSort }: { keys: string[]; fields: ListField[]; sort: string; dir: string; onSort: (sort: string, dir: string) => void }) {
  return (
    <>
      {keys.filter(isExtraColumn).map((k) => (
        <SortTh key={k} k={k} label={fields.find((f) => f.key === k)?.label ?? k.replace(/^custom\./, '')} sort={sort} dir={dir} onSort={onSort} />
      ))}
    </>
  );
}

/** Cells of the extra columns for one contact. */
export function ExtraCells({ keys, contact, fields }: { keys: string[]; contact: any; fields: ListField[] }) {
  return (
    <>
      {keys.filter(isExtraColumn).map((k) => {
        if (k === 'activity') return <td key={k} className="muted">{contact.last_activity_at ? dt(contact.last_activity_at) : '–'}</td>;
        if (!k.startsWith('custom.')) return <td key={k}>{contact[k] || <span className="muted">–</span>}</td>;
        const v = contact.custom?.[k.slice(7)];
        const type = fields.find((f) => f.key === k)?.type;
        return <td key={k}>{v === undefined || v === null || v === '' ? <span className="muted">–</span> : type === 'date' ? d(String(v)) : String(v)}</td>;
      })}
    </>
  );
}

/** "Spalten": choose and order the columns of the current view (also custom fields). */
export function ColumnsButton({ fields, value, onChange }: { fields: ListField[]; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT('smartlists');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn small secondary" onClick={() => setOpen(true)}>
        <Icon name="columns" size={14} /> {t('Spalten')}
      </button>
      {/* the name column always stays */}
      {open && <ColumnsModal fields={fields} value={value} onChange={(v) => onChange(v.includes('name') ? v : ['name', ...v])} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The quick switch above the table: "Alle Kontakte" and every list the person may see (🔒 = only mine), "Änderungen speichern"
 * when the open list was changed, "+ Smart List" to save the current view, and "Verwalten" to rename, share or delete.
 */
export function SmartListBar({ active, base, current, onApply }: { active: string; base: ContactView; current: ContactView; onApply: (l: SmartList | null) => void }) {
  const t = useT('smartlists');
  const lists = useLoad(() => api.get<SmartList[]>('/api/smart-lists'), []);
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const all = lists.data ?? [];
  const cur = all.find((l) => l.id === active);
  const dirty = cur ? !same(cur, current) : !same(base, current);
  const chip = (l: SmartList | null) => {
    const on = (l?.id ?? '') === active;
    return (
      <span key={l?.id ?? 'all'} className={`chip sl-tab${on ? ' on' : ''}`} role="presentation">
        <button type="button" role="tab" aria-selected={on} className="sl-tab-btn" onClick={() => onApply(l)} title={l ? (l.visibility === 'private' ? t('Nur für dich sichtbar') : l.owner_name ? t('Fürs Team · von {name}', { name: l.owner_name }) : t('Fürs Team')) : undefined}>
          {l?.visibility === 'private' && <Icon name="lock" size={12} />} {l ? l.name : t('Alle Kontakte')}
        </button>
      </span>
    );
  };
  return (
    <div className="views-bar sl-tabs" role="tablist" aria-label={t('Smart Lists')} data-tour="contacts-smart-lists" style={{ marginBottom: 10 }}>
      {chip(null)}
      {all.map((l) => chip(l))}
      {dirty && cur?.can_edit && (
        <button className="btn small secondary" onClick={() => act(() => api.patch(`/api/smart-lists/${cur.id}`, current), t('Smart List gespeichert')).then(lists.reload)}>
          {t('Änderungen speichern')}
        </button>
      )}
      {dirty && (
        <button className="btn small ghost" data-tour="contacts-smart-list-add" onClick={() => setSaving(true)}>
          + {t('Smart List')}
        </button>
      )}
      {all.length > 0 && (
        <button className="btn small ghost" onClick={() => setManaging(true)}>
          {t('Verwalten')}
        </button>
      )}
      {saving && (
        <SaveModal
          view={current}
          onClose={() => setSaving(false)}
          onSaved={async (l) => {
            setSaving(false);
            await lists.reload();
            onApply(l);
          }}
        />
      )}
      {managing && (
        <ManageModal
          lists={all}
          onClose={() => setManaging(false)}
          onChanged={async (gone) => {
            await lists.reload();
            if (gone && gone === active) onApply(null);
          }}
        />
      )}
    </div>
  );
}

function SaveModal({ view, onClose, onSaved }: { view: ContactView; onClose: () => void; onSaved: (l: SmartList) => void }) {
  const t = useT('smartlists');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'shared' | 'private'>('shared');
  const save = async () => {
    const l = await act(() => api.post<SmartList>('/api/smart-lists', { ...view, name, visibility }), t('Smart List gespeichert'));
    if (l) onSaved(l);
  };
  return (
    <Modal
      title={t('Neue Smart List')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!name.trim()} onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <Field label={t('Name')}>
        <Input value={name} onChange={setName} placeholder={t('z. B. Heiße Leads aus Berlin')} autoFocus />
      </Field>
      <Field label={t('Sichtbar für')}>
        <Select value={visibility} onChange={(v) => setVisibility(v === 'private' ? 'private' : 'shared')} options={[['shared', t('Das ganze Team')], ['private', t('Nur mich')]]} />
      </Field>
      <p className="muted small">{t('Gespeichert werden Suche, Filter, Spalten und Sortierung.')}</p>
    </Modal>
  );
}

function ManageModal({ lists, onClose, onChanged }: { lists: SmartList[]; onClose: () => void; onChanged: (deletedId?: string) => void }) {
  const t = useT('smartlists');
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(lists.map((l) => [l.id, l.name])));
  const patch = async (l: SmartList, body: Record<string, unknown>) => {
    if (await act(() => api.patch(`/api/smart-lists/${l.id}`, body), t('Gespeichert'))) onChanged();
  };
  return (
    <Modal title={t('Smart Lists verwalten')} onClose={onClose} wide>
      <table className="t">
        <thead>
          <tr>
            <th>{t('Name')}</th>
            <th>{t('Sichtbar für')}</th>
            <th aria-label={t('Aktionen')} />
          </tr>
        </thead>
        <tbody>
          {lists.map((l) => (
            <tr key={l.id}>
              <td>
                {l.can_edit ? (
                  <Input value={names[l.id] ?? ''} onChange={(v) => setNames({ ...names, [l.id]: v })} aria-label={t('Name von „{name}“', { name: l.name })} />
                ) : (
                  <>
                    {l.name}
                    {l.owner_name && <div className="muted small">{t('von {name}', { name: l.owner_name })}</div>}
                  </>
                )}
              </td>
              <td>
                {l.mine ? (
                  <Select value={l.visibility} aria={t('Sichtbar für')} onChange={(v) => v !== l.visibility && patch(l, { visibility: v })} options={[['shared', t('Das ganze Team')], ['private', t('Nur mich')]]} />
                ) : (
                  <span className="muted">{l.visibility === 'private' ? t('Nur mich') : t('Das ganze Team')}</span>
                )}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {l.can_edit && (
                  <span className="actions">
                    <button className="btn small secondary" disabled={!names[l.id]?.trim() || names[l.id] === l.name} onClick={() => patch(l, { name: names[l.id] })}>
                      {t('Umbenennen')}
                    </button>
                    <button
                      className="btn small danger"
                      aria-label={t('Smart List „{name}“ löschen', { name: l.name })}
                      onClick={async () => {
                        if (confirmAsk(t('Smart List „{name}“ löschen?', { name: l.name })) && (await act(() => api.del(`/api/smart-lists/${l.id}`), t('Gelöscht')))) onChanged(l.id);
                      }}
                    >
                      {t('Löschen')}
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
