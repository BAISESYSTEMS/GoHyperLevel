import { useMemo, useState } from 'react';
import { api, dt } from '../../api';
import { Badge, Check, Copy, Empty, Field, Input, Modal, Select, Spinner, TagInput, Tabs, Textarea, act, confirmAsk, useLoad } from '../../ui';
import { ImageField } from './Fields';
import { SiteEditor } from './Editor';
import './site.css';
import { useT } from '../../i18n';
import { SortableGrid } from '../../sortable/Sortable';

/** German names of the field types (message ids of the sites catalog), shown through t(). */
const FIELD_LABEL: Record<string, string> = {
  text: 'Text (eine Zeile)',
  longtext: 'Langer Text (Markdown)',
  number: 'Zahl',
  image: 'Bild',
  url: 'Link',
  email: 'E-Mail',
  phone: 'Telefon',
  date: 'Datum',
  bool: 'Ja/Nein',
  select: 'Auswahl',
  tags: 'Schlagwörter',
  product: 'Produkt (Kauf-Button)',
  rating: 'Bewertung (1–5 Sterne)',
};
const TYPES = Object.keys(FIELD_LABEL);
const slugKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);

/** Collections of a website (team, projects, products, testimonials …): fields, entries, list and detail templates. */
export function CmsTab({ funnel, onChanged }: { funnel: any; onChanged: () => void }) {
  const t = useT('sites');
  const list = useLoad(() => api.get<any[]>(`/api/funnels/${funnel.id}/collections`), [funnel.id]);
  const presets = useLoad(() => api.get<any>(`/api/funnels/${funnel.id}/collection-presets`), [funnel.id]);
  const [open, setOpen] = useState('');
  const [creating, setCreating] = useState(false);
  const cur = (list.data ?? []).find((c) => c.id === open);
  if (!list.data) return list.error ? <Empty>{list.error}</Empty> : <Spinner />;
  if (cur)
    return (
      <CollectionView
        key={cur.id}
        c={cur}
        funnel={funnel}
        back={() => setOpen('')}
        reload={async () => {
          await list.reload();
          onChanged();
        }}
      />
    );
  return (
    <div className="site-tab" data-tour="site-cms">
      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{t('Sammlungen')}</h3>
          <span className="grow" />
          <button className="btn" data-tour="site-cms-new" onClick={() => setCreating(true)}>
            {t('+ Neue Sammlung')}
          </button>
        </div>
        <p className="muted small">
          {t('Eine Sammlung ist eine Liste gleichartiger Inhalte mit eigenen Feldern – Team, Projekte, Produkte, Kundenstimmen, Stellen. Du pflegst die Einträge einmal; die Website zeigt sie als Liste (Block „Sammlung“) und gibt jedem Eintrag eine eigene Seite mit eigener Adresse. Die Einträge erscheinen in der Sitemap und in der Websuche.')}
        </p>
      </div>
      {list.data.length === 0 ? (
        <Empty action={<button className="btn" onClick={() => setCreating(true)}>{t('Erste Sammlung anlegen')}</button>}>{t('Noch keine Sammlungen.')}</Empty>
      ) : (
        <SortableGrid id="cms.stats" className="stats">
          {list.data.map((c) => (
            <button key={c.id} className="card cms-card" onClick={() => setOpen(c.id)}>
              <h3>{c.name}</h3>
              <span className="muted small">
                {[t('{n} veröffentlicht', { n: c.published }), t('{n} gesamt', { n: c.items }), t.plural(c.fields.length, { other: '{n} Felder' })].join(' · ')}
              </span>
              <span className="muted small">/{c.slug}</span>
            </button>
          ))}
        </SortableGrid>
      )}
      {creating && (
        <NewCollection
          funnel={funnel}
          presets={presets.data?.presets ?? []}
          onClose={() => setCreating(false)}
          onCreated={async (c) => {
            setCreating(false);
            await list.reload();
            onChanged();
            setOpen(c.id);
          }}
        />
      )}
    </div>
  );
}

function NewCollection({ funnel, presets, onClose, onCreated }: { funnel: any; presets: any[]; onClose: () => void; onCreated: (c: any) => void }) {
  const t = useT('sites');
  const [preset, setPreset] = useState('team');
  const [name, setName] = useState('');
  const [samples, setSamples] = useState(true);
  const p = presets.find((x) => x.key === preset);
  return (
    <Modal
      title={t('Neue Sammlung')}
      onClose={onClose}
      footer={
        <button
          className="btn"
          onClick={async () => {
            const c = await act(() => api.post(`/api/funnels/${funnel.id}/collections`, preset ? { preset, name: name.trim() || undefined, with_samples: samples } : { name: name.trim() || t('Sammlung'), fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] }));
            if (c) onCreated(c);
          }}
          disabled={!preset && !name.trim()}
        >
          {t('Anlegen')}
        </button>
      }
    >
      <Field label={t('Vorlage')}>
        <div className="cms-presets" role="radiogroup" aria-label={t('Vorlage der Sammlung')}>
          {presets.map((x) => (
            <button key={x.key} role="radio" aria-checked={preset === x.key} className={`btn small ${preset === x.key ? '' : 'secondary'}`} onClick={() => setPreset(x.key)}>
              {x.name}
            </button>
          ))}
          <button role="radio" aria-checked={!preset} className={`btn small ${!preset ? '' : 'secondary'}`} onClick={() => setPreset('')}>
            {t('Leer')}
          </button>
        </div>
      </Field>
      {p && <p className="muted small">{p.description} {t('Felder:')} {p.fields.map((f: any) => f.label).join(', ')}.</p>}
      <Field label="Name" hint={t('Bestimmt auch den Pfad der Liste, z. B. /team.')}>
        <Input value={name} onChange={setName} placeholder={p?.name ?? t('z. B. Referenzen')} />
      </Field>
      {p && <Check checked={samples} onChange={setSamples} label={t('Beispieleinträge anlegen (zum Ansehen – ersetze sie mit deinen Daten)')} />}
    </Modal>
  );
}

function CollectionView({ c, funnel, back, reload }: { c: any; funnel: any; back: () => void; reload: () => Promise<void> }) {
  const t = useT('sites');
  const [tab, setTab] = useState('items');
  return (
    <div className="site-tab">
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <button className="btn small secondary" onClick={back}>
          {t('← Alle Sammlungen')}
        </button>
        <h2 style={{ margin: 0 }}>{c.name}</h2>
        <span className="grow" />
        {c.settings.list_page && (
          <a className="btn small secondary" href={c.url} target="_blank" rel="noreferrer">
            {t('Liste ansehen ↗')}
          </a>
        )}
        <button
          className="btn small danger"
          onClick={async () => {
            if (!confirmAsk(t('Sammlung „{name}“ mit allen {n} Einträgen löschen? Blöcke, die sie zeigen, bleiben leer.', { name: c.name, n: c.items }))) return;
            if (await act(() => api.del(`/api/site-collections/${c.id}`), t('Sammlung gelöscht'))) {
              await reload();
              back();
            }
          }}
        >
          {t('Löschen')}
        </button>
      </div>
      <Tabs tabs={[['items', t('Einträge ({n})', { n: c.items })], ['fields', t('Felder')], ['templates', t('Liste & Detailseite')]]} value={tab} onChange={setTab} />
      {tab === 'items' && <ItemsPane c={c} reload={reload} />}
      {tab === 'fields' && <FieldsPane c={c} reload={reload} />}
      {tab === 'templates' && <TemplatePane c={c} funnel={funnel} reload={reload} />}
    </div>
  );
}

// --- entries ---------------------------------------------------------------------------------------------------------------------

function ItemsPane({ c, reload }: { c: any; reload: () => Promise<void> }) {
  const t = useT('sites');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const items = useLoad(() => api.get<any[]>(`/api/site-collections/${c.id}/items?status=${status}&q=${encodeURIComponent(q)}`), [c.id, status, q]);
  const [edit, setEdit] = useState<any>(null);
  const rows = items.data ?? [];
  const refresh = async () => {
    await items.reload();
    await reload();
  };
  const mv = async (i: number, d: number) => {
    const ids = rows.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    if (await act(() => api.put(`/api/site-collections/${c.id}/order`, { ids }))) items.reload();
  };
  return (
    <div data-tour="site-cms-items">
      <div className="row" style={{ alignItems: 'end', marginBottom: 10 }}>
        <div style={{ width: 240 }}>
          <Input value={q} onChange={setQ} placeholder={t('Suchen …')} aria-label={t('Einträge suchen')} />
        </div>
        <div style={{ width: 170 }}>
          <Select value={status} onChange={setStatus} placeholder={t('Alle Stände')} options={[['published', t('Veröffentlicht')], ['draft', t('Entwurf')]]} />
        </div>
        <span className="grow" />
        <button className="btn" onClick={() => setEdit({ data: {}, status: 'published' })}>
          + {c.singular || t('Eintrag')}
        </button>
      </div>
      {!items.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty>{q || status ? t('Nichts gefunden.') : t('Noch keine Einträge.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t cms-table">
            <thead>
              <tr>
                <th>{c.fields.find((f: any) => f.key === c.settings.title_field)?.label ?? t('Titel')}</th>
                <th>{t('Stand')}</th>
                <th>{t('Aufrufe')}</th>
                <th>{t('Pfad')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((it, i) => (
                <tr key={it.id}>
                  <td>
                    <button className="linklike" onClick={() => setEdit(it)}>
                      {it.title || t('(ohne Titel)')}
                    </button>
                  </td>
                  <td>
                    <Badge tone={it.status === 'published' ? 'green' : 'gray'}>{it.status === 'published' ? t('Veröffentlicht') : t('Entwurf')}</Badge>
                    {it.published_at && it.status === 'published' && <div className="muted small">{dt(it.published_at)}</div>}
                  </td>
                  <td>{it.views}</td>
                  <td>
                    <code>{it.slug}</code>
                  </td>
                  <td className="nowrap">
                    {!q && !status && (
                      <>
                        <button className="icon-btn" disabled={!i} onClick={() => mv(i, -1)} aria-label={t('{item} nach oben', { item: it.title })}>
                          ↑
                        </button>
                        <button className="icon-btn" disabled={i === rows.length - 1} onClick={() => mv(i, 1)} aria-label={t('{item} nach unten', { item: it.title })}>
                          ↓
                        </button>
                      </>
                    )}
                    <button className="btn small secondary" onClick={async () => (await act(() => api.patch(`/api/site-items/${it.id}`, { status: it.status === 'published' ? 'draft' : 'published' }))) && refresh()}>
                      {it.status === 'published' ? t('Zurückziehen') : t('Veröffentlichen')}
                    </button>{' '}
                    <button className="btn small ghost" onClick={async () => (await act(() => api.post(`/api/site-items/${it.id}/duplicate`), t('Als Entwurf dupliziert'))) && refresh()}>
                      {t('Duplizieren')}
                    </button>
                    <button className="icon-btn" aria-label={t('{item} löschen', { item: it.title })} onClick={async () => confirmAsk(t('„{name}“ löschen?', { name: it.title })) && (await act(() => api.del(`/api/site-items/${it.id}`))) && refresh()}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <ItemModal
          c={c}
          item={edit}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/** One control per field type. */
function ValueInput({ f, value, onChange, products }: { f: any; value: any; onChange: (v: any) => void; products: any[] }) {
  const t = useT('sites');
  switch (f.type) {
    case 'longtext':
      return <Textarea rows={6} value={value ?? ''} onChange={onChange} />;
    case 'number':
      return <Input type="number" value={value ?? ''} onChange={(v) => onChange(v === '' ? null : Number(v))} />;
    case 'image':
      return <ImageField value={value ?? ''} onChange={(u) => onChange(u)} />;
    case 'date':
      return <Input type="date" value={String(value ?? '').slice(0, 10)} onChange={onChange} />;
    case 'bool':
      return <Check checked={!!value} onChange={onChange} label={t('Ja')} />;
    case 'select':
      return <Select value={value ?? ''} onChange={onChange} placeholder={t('– wählen –')} options={f.options ?? []} />;
    case 'tags':
      return <TagInput value={Array.isArray(value) ? value : []} onChange={onChange} placeholder={t('Schlagwort + Enter')} />;
    case 'product':
      return <Select value={value ?? ''} onChange={onChange} placeholder={t('– kein Produkt –')} options={products.filter((p) => p.active !== 0).map((p) => [p.id, p.name])} />;
    case 'rating':
      return <Select value={value ? String(value) : ''} onChange={(v) => onChange(v ? Number(v) : null)} placeholder={t('– keine –')} options={['1', '2', '3', '4', '5'].map((n) => [n, '★'.repeat(Number(n))] as [string, string])} />;
    case 'email':
      return <Input type="email" value={value ?? ''} onChange={onChange} />;
    case 'url':
      return <Input value={value ?? ''} onChange={onChange} placeholder={t('https://… oder /pfad')} />;
    case 'phone':
      return <Input type="tel" value={value ?? ''} onChange={onChange} />;
    default:
      return <Input value={value ?? ''} onChange={onChange} />;
  }
}

function ItemModal({ c, item, onClose, onSaved }: { c: any; item: any; onClose: () => void; onSaved: () => void }) {
  const t = useT('sites');
  const [data, setData] = useState<Record<string, any>>(item.data ?? {});
  const [slug, setSlug] = useState(item.slug ?? '');
  const [status, setStatus] = useState(item.status ?? 'draft');
  const products = useLoad(() => (c.fields.some((f: any) => f.type === 'product') ? api.get<any[]>('/api/products') : Promise.resolve([])), [c.id]);
  const isNew = !item.id;
  return (
    <Modal
      title={isNew ? t('Neu: {kind}', { kind: c.singular || t('Eintrag') }) : t('{kind} bearbeiten', { kind: c.singular || t('Eintrag') })}
      wide
      onClose={onClose}
      footer={
        <button
          className="btn"
          onClick={async () => {
            const body = { data, status, ...(slug ? { slug } : {}) };
            const r = await act(() => (isNew ? api.post(`/api/site-collections/${c.id}/items`, body) : api.patch(`/api/site-items/${item.id}`, body)), t('Gespeichert'));
            if (r) onSaved();
          }}
        >
          {t('Speichern')}
        </button>
      }
    >
      <div className="grid2">
        {c.fields.map((f: any) => (
          <div key={f.key} className={['longtext', 'image', 'tags'].includes(f.type) ? 'span2' : ''}>
            <Field label={`${f.label}${f.required ? ' *' : ''}`}>
              <ValueInput f={f} value={data[f.key]} onChange={(v) => setData({ ...data, [f.key]: v })} products={products.data ?? []} />
            </Field>
          </div>
        ))}
      </div>
      <div className="grid2">
        <Field label={t('Pfad (leer = aus dem Titel)')} hint={c.settings.detail_pages ? t('Adresse: {path}', { path: `/${c.slug}/${slug || '…'}` }) : undefined}>
          <Input value={slug} onChange={setSlug} placeholder={t('wird automatisch gebildet')} />
        </Field>
        <Field label={t('Stand')}>
          <Select value={status} onChange={setStatus} options={[['published', t('Veröffentlicht')], ['draft', t('Entwurf – nicht sichtbar')]]} />
        </Field>
      </div>
    </Modal>
  );
}

// --- fields ------------------------------------------------------------------------------------------------------------------------

function FieldsPane({ c, reload }: { c: any; reload: () => Promise<void> }) {
  const t = useT('sites');
  const [fields, setFields] = useState<any[]>(c.fields);
  const [dirty, setDirty] = useState(false);
  const set = (next: any[]) => (setFields(next), setDirty(true));
  const upd = (i: number, patch: any) => set(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const mv = (i: number, d: number) => {
    const a = [...fields];
    [a[i], a[i + d]] = [a[i + d], a[i]];
    set(a);
  };
  return (
    <div data-tour="site-cms-fields">
      <p className="muted small">
        {t('Die Felder bestimmen, was du bei jedem Eintrag ausfüllst.')} {t('Der Schlüssel (z. B.')} <code>name</code>
        {t(') ist der Platzhalter in Vorlagen:')} <code>{'{{name}}'}</code>. {t('Den Typ eines Feldes kannst du nicht mehr ändern, sobald es Einträge gibt.')}
      </p>
      {fields.map((f, i) => (
        <div key={i} className="card cms-field">
          <div className="grid3">
            <Field label={t('Beschriftung')}>
              <Input
                value={f.label}
                onChange={(v) => upd(i, { label: v, ...(f._new || !f.key ? { key: slugKey(v), _new: true } : {}) })}
              />
            </Field>
            <Field label={t('Schlüssel')}>
              <Input value={f.key} onChange={(v) => upd(i, { key: slugKey(v) })} disabled={!f._new && !!c.fields.find((x: any) => x.key === f.key)} />
            </Field>
            <Field label={t('Typ')}>
              <Select value={f.type} onChange={(v) => upd(i, { type: v })} options={TYPES.map((k) => [k, t(FIELD_LABEL[k])] as [string, string])} />
            </Field>
          </div>
          {f.type === 'select' && (
            <Field label={t('Auswahlmöglichkeiten (eine pro Zeile)')}>
              <Textarea rows={3} value={(f.options ?? []).join('\n')} onChange={(v) => upd(i, { options: v.split('\n').map((x) => x.trim()).filter(Boolean) })} />
            </Field>
          )}
          <div className="row" style={{ alignItems: 'center' }}>
            <Check checked={!!f.required} onChange={(v) => upd(i, { required: v })} label={t('Pflichtfeld')} />
            {['select', 'tags', 'bool'].includes(f.type) && <Check checked={!!f.filterable} onChange={(v) => upd(i, { filterable: v })} label={t('Als Filter anbieten')} />}
            <span className="grow" />
            <button className="icon-btn" disabled={!i} onClick={() => mv(i, -1)} aria-label={t('{item} nach oben', { item: f.label })}>
              ↑
            </button>
            <button className="icon-btn" disabled={i === fields.length - 1} onClick={() => mv(i, 1)} aria-label={t('{item} nach unten', { item: f.label })}>
              ↓
            </button>
            <button className="icon-btn" onClick={() => set(fields.filter((_, j) => j !== i))} aria-label={t('{item} entfernen', { item: f.label })}>
              ✕
            </button>
          </div>
        </div>
      ))}
      <div className="row">
        <button className="btn secondary" disabled={fields.length >= 30} onClick={() => set([...fields, { key: '', label: '', type: 'text', _new: true }])}>
          {t('+ Feld')}
        </button>
        <button
          className="btn"
          disabled={!dirty || fields.some((f) => !f.key || !f.label)}
          onClick={async () => {
            const out = await act(() => api.patch(`/api/site-collections/${c.id}`, { fields: fields.map(({ _new, ...f }) => f) }), t('Felder gespeichert'));
            if (out) {
              setDirty(false);
              await reload();
            }
          }}
        >
          {t('Felder speichern')}
        </button>
      </div>
    </div>
  );
}

// --- templates ---------------------------------------------------------------------------------------------------------------------

function TemplatePane({ c, funnel, reload }: { c: any; funnel: any; reload: () => Promise<void> }) {
  const t = useT('sites');
  const [s, setS] = useState<any>(c.settings);
  const [dirty, setDirty] = useState(false);
  const set = (patch: any) => (setS({ ...s, ...patch }), setDirty(true));
  const first = funnel.pages?.[0];
  const [ver, setVer] = useState(0);
  // A collection without a template of its own shows the standard one – the editor starts from it.
  const std = useLoad(() => api.get<{ blocks: any[] }>(`/api/site-collections/${c.id}/detail-default`), [c.id]);
  const fieldsBy = (types: string[]) => c.fields.filter((f: any) => types.includes(f.type)).map((f: any) => [f.key, f.label] as [string, string]);
  const sortable = useMemo(() => [['position', t('Reihenfolge')], ['published_at', t('Veröffentlichung')], ...c.fields.filter((f: any) => ['text', 'number', 'date', 'rating'].includes(f.type)).map((f: any) => [f.key, f.label] as [string, string])] as [string, string][], [c.fields, t]);
  return (
    <div className="cms-templates" data-tour="site-cms-templates">
      <div className="card">
        <h3>{t('Liste')}</h3>
        <div className="grid3">
          <Field label={t('Darstellung')}>
            <Select value={s.layout} onChange={(v) => set({ layout: v })} options={[['grid', t('Raster')], ['list', t('Liste')]]} />
          </Field>
          <Field label={t('Spalten (Raster)')}>
            <Select value={String(s.columns)} onChange={(v) => set({ columns: Number(v) })} options={['1', '2', '3', '4']} />
          </Field>
          <Field label={t('Einträge pro Seite')}>
            <Input type="number" value={s.per_page} onChange={(v) => set({ per_page: Number(v) })} />
          </Field>
          <Field label={t('Sortieren nach')}>
            <Select value={s.sort_field} onChange={(v) => set({ sort_field: v })} options={sortable} />
          </Field>
          <Field label={t('Richtung')}>
            <Select value={s.sort_dir} onChange={(v) => set({ sort_dir: v })} options={[['asc', t('Aufsteigend')], ['desc', t('Absteigend')]]} />
          </Field>
          <Field label={t('Text des Links zum Eintrag')}>
            <Input value={s.button_text} onChange={(v) => set({ button_text: v })} />
          </Field>
          <Field label={t('Titel-Feld')}>
            <Select value={s.title_field} onChange={(v) => set({ title_field: v })} options={fieldsBy(['text'])} />
          </Field>
          <Field label={t('Bild-Feld')}>
            <Select value={s.image_field} onChange={(v) => set({ image_field: v })} placeholder={t('– keins –')} options={fieldsBy(['image'])} />
          </Field>
          <Field label={t('Kurztext-Feld')}>
            <Select value={s.text_field} onChange={(v) => set({ text_field: v })} placeholder={t('– keins –')} options={fieldsBy(['text', 'longtext'])} />
          </Field>
        </div>
        <Field label={t('Weitere Angaben auf der Karte (bis zu drei Felder)')}>
          <div className="checks">
            {c.fields.map((f: any) => (
              <Check key={f.key} checked={(s.meta_fields ?? []).includes(f.key)} onChange={(v) => set({ meta_fields: v ? [...(s.meta_fields ?? []), f.key].slice(-3) : (s.meta_fields ?? []).filter((k: string) => k !== f.key) })} label={f.label} />
            ))}
          </div>
        </Field>
        <Field label={t('Einleitung über der Liste')}>
          <Textarea rows={2} value={s.intro} onChange={(v) => set({ intro: v })} />
        </Field>
        <div className="checks">
          <Check checked={!!s.list_page} onChange={(v) => set({ list_page: v })} label={t('Eigene Listenseite {path}', { path: `/${c.slug}` })} />
          <Check checked={!!s.detail_pages} onChange={(v) => set({ detail_pages: v })} label={t('Eigene Seite je Eintrag {path}', { path: `/${c.slug}/…` })} />
          <Check checked={!!s.indexable} onChange={(v) => set({ indexable: v })} label={t('In Sitemap und Websuche aufnehmen')} />
        </div>
        <div className="grid2">
          <Field label={t('SEO-Titel der Liste')}>
            <Input value={s.seo_title} onChange={(v) => set({ seo_title: v })} />
          </Field>
          <Field label={t('SEO-Beschreibung der Liste')}>
            <Input value={s.seo_description} onChange={(v) => set({ seo_description: v })} />
          </Field>
        </div>
        <button
          className="btn"
          disabled={!dirty}
          onClick={async () => {
            const out = await act(() => api.patch(`/api/site-collections/${c.id}`, { settings: s }), t('Gespeichert'));
            if (out) {
              setDirty(false);
              await reload();
            }
          }}
        >
          {t('Einstellungen speichern')}
        </button>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>{t('Vorlage der Detailseite')}</h3>
        <p className="muted small">
          {t('So sieht die Seite jedes Eintrags aus. Texte in doppelten geschweiften Klammern werden durch die Werte des Eintrags ersetzt:')}
        </p>
        <div className="cms-tokens">
          {c.fields.map((f: any) => (
            <Copy key={f.key} text={`{{${f.key}}}`} label={`{{${f.key}}}`} />
          ))}
          {c.fields.some((f: any) => f.type === 'product') && <span className="muted small">{t('Produkt-Felder:')} {c.fields.filter((f: any) => f.type === 'product').map((f: any) => `{{${f.key}.name}} {{${f.key}.price}} {{${f.key}.url}}`).join(' ')}</span>}
        </div>
        {!first ? (
          <p className="muted">{t('Lege zuerst eine Seite an.')}</p>
        ) : (
          <SiteEditor
            key={`${ver}-${std.data ? 1 : 0}`}
            page={{ id: `detail-${c.id}`, name: t('{name} – Detailseite', { name: c.name }), blocks: c.detail_blocks?.length ? c.detail_blocks : (std.data?.blocks ?? []) }}
            funnel={funnel}
            component
            onSaved={() => void reload()}
            endpoints={{
              save: `/api/site-collections/${c.id}`,
              key: 'detail_blocks',
              preview: `/api/site-collections/${c.id}/preview`,
              previewBody: (blocks) => ({ detail_blocks: blocks, kind: 'detail' }),
            }}
            extra={
              <button
                className="btn secondary"
                onClick={async () => {
                  if (!confirmAsk(t('Die Detailseite auf die Standard-Vorlage zurücksetzen?'))) return;
                  if (await act(() => api.patch(`/api/site-collections/${c.id}`, { detail_blocks: std.data?.blocks ?? [] }), t('Zurückgesetzt'))) {
                    await reload();
                    setVer((n) => n + 1);
                  }
                }}
              >
                {t('Standard-Vorlage')}
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}
