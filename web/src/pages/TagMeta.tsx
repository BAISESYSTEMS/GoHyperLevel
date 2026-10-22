import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { act, confirmAsk, Input, Select, useLoad } from '../ui';
import { chipStyle, refreshTagMeta, tagColor, type TagCategory, type TagMeta } from '../tag-chip';
import { ColorPick, PALETTE as TAG_COLORS } from '../color-pick';
import { TagBulkTools } from './TagBulk';

/**
 * Settings → Felder & Tags: tags with colour and category, and the categories themselves (modules/tag-meta.ts). Replaces the
 * plain tag list of the settings page; the chips everywhere else follow the colours set here.
 */

export function TagSettings() {
  const t = useT('tags');
  const tags = useLoad(() => api.get<{ id: string; name: string; count: number }[]>('/api/tags'), []);
  const meta = useLoad(() => api.get<TagMeta>('/api/tags/meta'), []);
  const [tag, setTag] = useState('');
  const [tagCat, setTagCat] = useState('');
  const [cat, setCat] = useState('');
  const reload = () => Promise.all([tags.reload(), meta.reload()]).then(refreshTagMeta);
  const m: TagMeta = meta.data ?? { tags: [], categories: [] };
  const cats: TagCategory[] = m.categories;
  const metaOf = (id: string) => m.tags.find((x) => x.id === id);
  const patchTag = (id: string, body: Record<string, unknown>) => act(() => api.patch(`/api/tags/${id}`, body)).then(reload);
  const patchCat = (id: string, body: Record<string, unknown>) => act(() => api.patch(`/api/tag-categories/${id}`, body)).then(reload);
  const addTag = async () => {
    const made = await act(() => api.post<{ id: string }>('/api/tags', { name: tag }));
    if (made && tagCat) await act(() => api.patch(`/api/tags/${made.id}`, { category_id: tagCat }));
    setTag('');
    await reload();
  };
  const groups: { cat: TagCategory | null; list: { id: string; name: string; count: number }[] }[] = [
    ...cats.map((c) => ({ cat: c, list: (tags.data ?? []).filter((x) => metaOf(x.id)?.category_id === c.id) })),
    { cat: null, list: (tags.data ?? []).filter((x) => !cats.some((c) => c.id === metaOf(x.id)?.category_id)) },
  ];
  const move = (c: TagCategory, dir: -1 | 1) => {
    const i = cats.findIndex((x) => x.id === c.id);
    const other = cats[i + dir];
    if (!other) return;
    void act(() => Promise.all([api.patch(`/api/tag-categories/${c.id}`, { position: i + dir }), api.patch(`/api/tag-categories/${other.id}`, { position: i })])).then(reload);
  };
  return (
    <div className="card" style={{ flex: '1 1 380px' }} data-tour="settings-tags">
      <h2>{t('Tags')}</h2>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <Input value={tag} onChange={setTag} placeholder={t('Neuer Tag')} aria-label={t('Neuer Tag')} />
        </div>
        {cats.length > 0 && (
          <div style={{ width: 150, flex: 'none' }}>
            <Select value={tagCat} onChange={setTagCat} placeholder={t('Ohne Kategorie')} aria={t('Kategorie des neuen Tags')} options={cats.map((c) => [c.id, c.name] as [string, string])} />
          </div>
        )}
        <button className="btn" aria-label={t('Tag anlegen')} disabled={!tag.trim()} onClick={addTag}>
          +
        </button>
      </div>
      <details className="tag-meta-cats" open={cats.length > 0} data-tour="settings-tag-categories">
        <summary>{t('Kategorien ({n})', { n: cats.length })}</summary>
        {cats.map((c, i) => (
          <div key={c.id} className="tag-meta-row">
            <span className="tm-tools">
              <ColorPick value={c.color} label={c.name} onChange={(color) => patchCat(c.id, { color })} />
              <Input value={c.name} aria-label={t('Name der Kategorie')} onChange={(v) => meta.setData({ ...m, categories: cats.map((x) => (x.id === c.id ? { ...x, name: v } : x)) })} onBlur={(e) => e.target.value.trim() && patchCat(c.id, { name: e.target.value })} />
            </span>
            <span className="tm-tools">
              <button className="icon-btn" disabled={!i} onClick={() => move(c, -1)} aria-label={t('Nach oben')}>
                ↑
              </button>
              <button className="icon-btn" disabled={i === cats.length - 1} onClick={() => move(c, 1)} aria-label={t('Nach unten')}>
                ↓
              </button>
              <button className="icon-btn" onClick={() => confirmAsk(t('Kategorie „{name}“ löschen? Die Tags bleiben erhalten.', { name: c.name })) && act(() => api.del(`/api/tag-categories/${c.id}`)).then(reload)} aria-label={t('Kategorie {name} löschen', { name: c.name })}>
                ✕
              </button>
            </span>
          </div>
        ))}
        <div className="row">
          <div className="grow">
            <Input value={cat} onChange={setCat} placeholder={t('Neue Kategorie, z. B. Interessen')} aria-label={t('Neue Kategorie')} />
          </div>
          <button className="btn secondary" disabled={!cat.trim()} onClick={() => act(() => api.post('/api/tag-categories', { name: cat, color: TAG_COLORS[cats.length % TAG_COLORS.length] })).then(() => (setCat(''), reload()))}>
            + {t('Kategorie')}
          </button>
        </div>
      </details>
      {groups.map(({ cat: g, list }) =>
        !list.length && (g || cats.length) ? null : (
          <div key={g?.id ?? 'none'}>
            {cats.length > 0 && (
              <div className="tag-meta-cat small" style={g?.color ? ({ '--cc': g.color } as React.CSSProperties) : undefined}>
                <strong>{g ? g.name : t('Ohne Kategorie')}</strong> <span className="muted">· {list.length}</span>
              </div>
            )}
            {list.map((x) => {
              const own = metaOf(x.id);
              const color = tagColor(m, x.name);
              return (
                <div key={x.id} className="tag-meta-row">
                  <span className={`tag${color ? ' tc' : ''}`} style={chipStyle(color)}>
                    {x.name}
                  </span>
                  <span className="tm-tools muted small">
                    <span title={t('Kontakte mit diesem Tag')}>{x.count}</span>
                    <ColorPick value={own?.color ?? ''} label={x.name} onChange={(c) => patchTag(x.id, { color: c })} />
                    {cats.length > 0 && <Select value={own?.category_id ?? ''} onChange={(v) => patchTag(x.id, { category_id: v || null })} placeholder={t('Ohne Kategorie')} aria={t('Kategorie von {name}', { name: x.name })} options={cats.map((c) => [c.id, c.name] as [string, string])} />}
                    <button className="icon-btn" onClick={() => confirmAsk(t('Tag „{name}“ überall entfernen?', { name: x.name })) && act(() => api.del(`/api/tags/${x.id}`)).then(reload)} aria-label={t('Tag {name} löschen', { name: x.name })}>
                      ✕
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ),
      )}
      <TagBulkTools categories={cats} onDone={() => void reload()} />
    </div>
  );
}
