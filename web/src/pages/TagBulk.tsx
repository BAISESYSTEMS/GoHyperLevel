import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { act, Badge, Check, confirmAsk, Input, Select, toast, useLoad } from '../ui';
import { chipStyle } from '../tag-chip';
import { ColorPick } from '../color-pick';
import './crm-gaps.css';

/**
 * Settings → Tags → "Aufräumen" (modules/tag-bulk.ts): pick several tags and rename, merge, colour, file or delete them at once;
 * shows how often each tag is used (contacts, workflows, smart lists) so unused ones are easy to find. Folded by default.
 */

interface UsageTag {
  id: string;
  name: string;
  color: string;
  category_id: string | null;
  contacts: number;
  workflows: { id: string; name: string }[];
  smart_lists: { id: string; name: string }[];
  unused: boolean;
}
interface Refs {
  workflows?: { name: string }[];
  smart_lists?: { name: string }[];
}

export function TagBulkTools({ categories, onDone }: { categories: { id: string; name: string }[]; onDone: () => void }) {
  const t = useT('crmgaps');
  const [open, setOpen] = useState(false);
  const usage = useLoad(() => (open ? api.get<{ tags: UsageTag[] }>('/api/tags/usage') : Promise.resolve({ tags: [] as UsageTag[] })), [open]);
  const [sel, setSel] = useState<string[]>([]);
  const [onlyUnused, setOnlyUnused] = useState(false);
  const [name, setName] = useState('');
  const [into, setInto] = useState('');
  const all = usage.data?.tags ?? [];
  const list = onlyUnused ? all.filter((x) => x.unused) : all;
  const chosen = all.filter((x) => sel.includes(x.id));
  const toggle = (id: string, on: boolean) => setSel(on ? [...sel, id] : sel.filter((x) => x !== id));

  const run = async (body: Record<string, unknown>) => {
    const r = await act(() => api.post<{ count: number; contacts?: number; references?: Refs }>('/api/tags/bulk', { ids: sel, ...body }));
    if (!r) return;
    const refs = [...(r.references?.workflows ?? []), ...(r.references?.smart_lists ?? [])].map((x) => x.name);
    toast(refs.length ? t('Erledigt. Noch mit altem Namen: {list}', { list: refs.slice(0, 5).join(', ') }) : t('Erledigt'));
    setSel([]);
    setName('');
    setInto('');
    await usage.reload();
    onDone();
  };

  return (
    <details className="tag-bulk" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-tour="settings-tag-bulk">
      <summary>{t('Aufräumen: umbenennen, zusammenführen, löschen')}</summary>
      {open && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Check checked={onlyUnused} onChange={setOnlyUnused} label={t('Nur ungenutzte ({n})', { n: all.filter((x) => x.unused).length })} />
            <Check checked={list.length > 0 && list.every((x) => sel.includes(x.id))} onChange={(v) => setSel(v ? list.map((x) => x.id) : [])} label={t('Alle wählen')} />
          </div>
          <div className="tag-bulk-list">
            {list.map((x) => (
              <label key={x.id} className="tag-meta-row">
                <span className="tm-tools">
                  <input type="checkbox" checked={sel.includes(x.id)} onChange={(e) => toggle(x.id, e.target.checked)} aria-label={t('{name} wählen', { name: x.name })} />
                  <span className={`tag${x.color ? ' tc' : ''}`} style={chipStyle(x.color)}>
                    {x.name}
                  </span>
                </span>
                <span className="muted small" title={[...x.workflows, ...x.smart_lists].map((w) => w.name).join(', ')}>
                  {x.unused ? <Badge>{t('ungenutzt')}</Badge> : t('{c} Kontakte · {w} Workflows · {l} Listen', { c: x.contacts, w: x.workflows.length, l: x.smart_lists.length })}
                </span>
              </label>
            ))}
            {!list.length && <p className="muted small">{t('Keine Tags.')}</p>}
          </div>
          {sel.length > 0 && (
            <div className="tag-bulk-bar">
              <strong>{t('{n} gewählt', { n: sel.length })}</strong>
              {sel.length === 1 && (
                <span className="row" style={{ flexWrap: 'nowrap' }}>
                  <Input value={name} onChange={setName} placeholder={chosen[0]?.name} aria-label={t('Neuer Name')} />
                  <button className="btn small secondary" disabled={!name.trim()} onClick={() => run({ action: 'rename', name })}>
                    {t('Umbenennen')}
                  </button>
                </span>
              )}
              {sel.length > 1 && (
                <span className="row" style={{ flexWrap: 'nowrap' }}>
                  <Select value={into} onChange={setInto} placeholder={t('Zusammenführen in…')} aria={t('Ziel-Tag')} options={chosen.map((x) => [x.id, x.name] as [string, string])} />
                  <button className="btn small secondary" disabled={!into} onClick={() => confirmAsk(t('{n} Tags in „{name}“ zusammenführen?', { n: sel.length - 1, name: chosen.find((x) => x.id === into)?.name ?? '' })) && run({ action: 'merge', into })}>
                    {t('Zusammenführen')}
                  </button>
                </span>
              )}
              <ColorPick value="" label={t('gewählte Tags')} onChange={(color) => run({ action: 'color', color })} />
              {categories.length > 0 && <Select value="" onChange={(v) => run({ action: 'category', category_id: v === '-' ? null : v })} placeholder={t('Kategorie setzen…')} aria={t('Kategorie der gewählten Tags')} options={[['-', t('Ohne Kategorie')], ...categories.map((c) => [c.id, c.name] as [string, string])]} />}
              <button className="btn small danger" onClick={() => confirmAsk(t('{n} Tags überall entfernen?', { n: sel.length })) && run({ action: 'delete' })}>
                {t('Löschen')}
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
