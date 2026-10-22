import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { act, confirmAsk, Input, Modal, Select, toast, useLoad } from '../ui';
import './crm-gaps.css';

/**
 * The workflow list's folders and bulk actions (modules/workflow-folders.ts): a folder row above the list (filter, new folder,
 * rename, delete) and "Mehrere bearbeiten" – a dialog to pick workflows and move, activate, pause or delete them together.
 */

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  workflows: number;
}
interface Row {
  id: string;
  name: string;
  status: string;
  folder_id?: string | null;
}
/** What the list shows: `ids` null = everything, else the folder ids ('' = without folder) whose workflows show. */
export interface WorkflowFolderFilter {
  key: string;
  ids: Set<string> | null;
}
export const ALL_FOLDERS: WorkflowFolderFilter = { key: '', ids: null };
export const inWorkflowFolder = (f: WorkflowFolderFilter) => (w: Row) => !f.ids || f.ids.has(w.folder_id ?? '');

/** A folder and everything below it. */
function subtree(folders: Folder[], root: string): Set<string> {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) (out.add(f.id), (grew = true));
  }
  return out;
}
/** Folders in tree order with their depth. */
function ordered(folders: Folder[]): { f: Folder; depth: number }[] {
  const out: { f: Folder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => (x.parent_id ?? null) === parent)) {
      out.push({ f, depth });
      if (depth < 6) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (parent removed elsewhere) still show.
  for (const f of folders) if (!out.some((o) => o.f.id === f.id)) out.push({ f, depth: 0 });
  return out;
}

export function WorkflowFolderBar({ rows, value, onChange, onChanged }: { rows: Row[]; value: WorkflowFolderFilter; onChange: (v: WorkflowFolderFilter) => void; onChanged: () => void }) {
  const t = useT('crmgaps');
  const folders = useLoad(() => api.get<Folder[]>('/api/workflow-folders').catch(() => [] as Folder[]), []);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const list = folders.data ?? [];
  const tree = ordered(list);
  const current = list.find((f) => f.id === value.key);
  const pick = (key: string) => onChange(key === '' ? ALL_FOLDERS : key === 'none' ? { key, ids: new Set(['']) } : { key, ids: subtree(list, key) });
  const refresh = async () => (await folders.reload(), onChanged());
  const none = rows.filter((w) => !w.folder_id).length;

  if (!list.length && adding === null)
    return (
      <div className="inbox-filters" data-tour="workflows-folders">
        <button type="button" className="btn small secondary" onClick={() => setAdding('')}>
          <Icon name="project" size={14} /> {t('Ordner anlegen')}
        </button>
        {rows.length > 1 && (
          <button type="button" className="btn small secondary" onClick={() => setBulk(true)}>
            {t('Mehrere bearbeiten')}
          </button>
        )}
        {bulk && <BulkModal rows={rows} folders={list} onClose={() => setBulk(false)} onDone={refresh} />}
      </div>
    );

  return (
    <div className="inbox-filters wf-folders" data-tour="workflows-folders" role="toolbar" aria-label={t('Ordner')}>
      <button type="button" className={`btn small ${value.key === '' ? '' : 'secondary'}`} onClick={() => pick('')}>
        {t('Alle ({n})', { n: rows.length })}
      </button>
      {list.length > 0 && (
        <button type="button" className={`btn small ${value.key === 'none' ? '' : 'secondary'}`} onClick={() => pick('none')}>
          {t('Ohne Ordner ({n})', { n: none })}
        </button>
      )}
      {tree.map(({ f, depth }) => (
        <button key={f.id} type="button" className={`btn small ${value.key === f.id ? '' : 'secondary'}`} onClick={() => pick(f.id)} title={depth ? `${'· '.repeat(depth)}${f.name}` : f.name}>
          <Icon name="project" size={13} /> {depth ? '↳ ' : ''}
          {f.name} <span className="muted">{rows.filter(inWorkflowFolder({ key: f.id, ids: subtree(list, f.id) })).length}</span>
        </button>
      ))}
      {adding === null ? (
        <button type="button" className="icon-btn" aria-label={t('Ordner anlegen')} title={current ? t('Unterordner in „{name}“ anlegen', { name: current.name }) : t('Ordner anlegen')} onClick={() => setAdding('')}>
          +
        </button>
      ) : (
        <span className="row" style={{ flexWrap: 'nowrap' }}>
          <Input value={adding} onChange={setAdding} placeholder={current ? t('Unterordner in „{name}“', { name: current.name }) : t('Name des Ordners')} aria-label={t('Name des Ordners')} autoFocus onKeyDown={(e) => e.key === 'Escape' && setAdding(null)} />
          <button type="button" className="btn small" disabled={!adding.trim()} onClick={() => act(() => api.post('/api/workflow-folders', { name: adding, parent_id: current?.id ?? null })).then((r) => (r && setAdding(null), refresh()))}>
            {t('Anlegen')}
          </button>
          <button type="button" className="icon-btn" aria-label={t('Abbrechen')} onClick={() => setAdding(null)}>
            ✕
          </button>
        </span>
      )}
      {current && renaming !== null && (
        <span className="row" style={{ flexWrap: 'nowrap' }}>
          <Input value={renaming} onChange={setRenaming} aria-label={t('Neuer Name')} autoFocus onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
          <button type="button" className="btn small" disabled={!renaming.trim()} onClick={() => act(() => api.patch(`/api/workflow-folders/${current.id}`, { name: renaming })).then((r) => (r && setRenaming(null), refresh()))}>
            {t('Speichern')}
          </button>
        </span>
      )}
      {current && (
        <>
          <button type="button" className="icon-btn" aria-label={t('Ordner {name} umbenennen', { name: current.name })} onClick={() => setRenaming(current.name)}>
            <Icon name="edit" size={14} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('Ordner {name} löschen', { name: current.name })} onClick={() => confirmAsk(t('Ordner „{name}“ löschen? Die Workflows bleiben erhalten.', { name: current.name })) && act(() => api.del(`/api/workflow-folders/${current.id}`)).then(() => (pick(''), refresh()))}>
            ✕
          </button>
        </>
      )}
      <button type="button" className="btn small secondary" onClick={() => setBulk(true)}>
        {t('Mehrere bearbeiten')}
      </button>
      {bulk && <BulkModal rows={rows.filter(inWorkflowFolder(value))} folders={list} onClose={() => setBulk(false)} onDone={refresh} />}
    </div>
  );
}

function BulkModal({ rows, folders, onClose, onDone }: { rows: Row[]; folders: Folder[]; onClose: () => void; onDone: () => Promise<unknown> | void }) {
  const t = useT('crmgaps');
  const [sel, setSel] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    const r = await act(() => api.post<{ count: number; failed: { name: string; error: string }[] }>('/api/workflows/bulk', { action, ids: sel, ...extra }));
    if (!r) return;
    toast(r.failed.length ? t('{n} erledigt, nicht möglich: {list}', { n: r.count, list: r.failed.map((f) => `${f.name} (${f.error})`).join('; ').slice(0, 300) }) : t('{n} erledigt', { n: r.count }));
    setSel([]);
    await onDone();
    onClose();
  };
  const STATUS: Record<string, string> = { active: t('aktiv'), paused: t('pausiert'), draft: t('Entwurf') };
  return (
    <Modal title={t('Mehrere Workflows bearbeiten')} onClose={onClose} wide>
      <label className="bulk-row-main">
        <input type="checkbox" checked={rows.length > 0 && sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((w) => w.id) : [])} />
        <strong>{t('Alle wählen ({n})', { n: rows.length })}</strong>
      </label>
      <div className="tag-bulk-list">
        {rows.map((w) => (
          <label key={w.id} className="bulk-row">
            <span className="bulk-row-main">
              <input type="checkbox" checked={sel.includes(w.id)} onChange={(e) => setSel(e.target.checked ? [...sel, w.id] : sel.filter((x) => x !== w.id))} />
              {w.name}
            </span>
            <span className="muted small">{STATUS[w.status] ?? w.status}</span>
          </label>
        ))}
      </div>
      <div className="tag-bulk-bar">
        <strong>{t('{n} gewählt', { n: sel.length })}</strong>
        <div style={{ width: 200 }}>
          <Select value={target} onChange={setTarget} placeholder={t('In Ordner verschieben…')} aria={t('Ziel-Ordner')} options={[['-', t('Ohne Ordner')], ...ordered(folders).map(({ f, depth }) => [f.id, `${'— '.repeat(depth)}${f.name}`] as [string, string])]} />
        </div>
        <button type="button" className="btn small secondary" disabled={!sel.length || !target} onClick={() => run('move', { folder_id: target === '-' ? null : target })}>
          {t('Verschieben')}
        </button>
        <button type="button" className="btn small secondary" disabled={!sel.length} onClick={() => run('activate')}>
          {t('Aktivieren')}
        </button>
        <button type="button" className="btn small secondary" disabled={!sel.length} onClick={() => run('pause')}>
          {t('Pausieren')}
        </button>
        <button type="button" className="btn small danger" disabled={!sel.length} onClick={() => confirmAsk(t('{n} Workflows löschen? Im Verlauf rückgängig machbar.', { n: sel.length })) && run('delete')}>
          {t('Löschen')}
        </button>
      </div>
    </Modal>
  );
}
