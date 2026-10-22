import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { act, Badge, Check, confirmAsk, Empty, Field, Input, Link, Modal, PageHead, pressable, Select, Spinner, Tabs, TagInput, Textarea, useLoad } from '../ui';

/** Wissensdatenbank: categories and Markdown articles for the public help center. */

function CategoryModal({ cat, onClose, onSaved }: { cat?: any; onClose: () => void; onSaved: () => void }) {
  const [c, setC] = useState<any>(cat ?? { name: '', description: '' });
  const save = async () => (await act(() => (cat ? api.patch(`/api/kb/categories/${cat.id}`, c) : api.post('/api/kb/categories', c)), 'Gespeichert')) && onSaved();
  return (
    <Modal
      title={cat ? 'Kategorie bearbeiten' : 'Neue Kategorie'}
      onClose={onClose}
      footer={
        <>
          {cat && (
            <button className="btn danger" onClick={async () => confirmAsk(`Kategorie „${cat.name}“ löschen? Die Artikel bleiben (ohne Kategorie).`) && (await act(() => api.del(`/api/kb/categories/${cat.id}`))) && onSaved()}>
              Löschen
            </button>
          )}
          <button className="btn" onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <Field label="Name">
        <Input value={c.name} onChange={(v) => setC({ ...c, name: v })} autoFocus />
      </Field>
      <Field label="Beschreibung (öffentlich)">
        <Input value={c.description} onChange={(v) => setC({ ...c, description: v })} />
      </Field>
      {cat && (
        <Field label="Adresse" hint="Teil der URL im Hilfe-Center">
          <Input value={c.slug} onChange={(v) => setC({ ...c, slug: v })} />
        </Field>
      )}
    </Modal>
  );
}

function ArticleEditor({ id, cats, onClose, onSaved }: { id?: string; cats: any[]; onClose: () => void; onSaved: () => void }) {
  const loaded = useLoad(() => (id ? api.get(`/api/kb/articles/${id}`) : Promise.resolve({ title: '', body: '', status: 'draft', tags: [], seo: {}, category_id: cats[0]?.id ?? '' })), [id]);
  const [a, setA] = useState<any>();
  const [tab, setTab] = useState('text');
  const [preview, setPreview] = useState('');
  useEffect(() => setA(loaded.data), [loaded.data]);
  useEffect(() => {
    if (tab !== 'preview' || !a) return;
    void api.post('/api/kb/preview', { body: a.body ?? '' }).then((r) => setPreview(r.html)).catch(() => setPreview(''));
  }, [tab]);
  if (!a) return null;
  const save = async (status?: string) => {
    const body = { title: a.title, body: a.body, excerpt: a.excerpt, category_id: a.category_id || '', tags: a.tags, seo: a.seo, slug: a.slug, status: status ?? a.status };
    const r = await act(() => (id ? api.patch(`/api/kb/articles/${id}`, body) : api.post('/api/kb/articles', body)), status === 'published' ? 'Veröffentlicht' : 'Gespeichert');
    if (r) onSaved();
  };
  return (
    <Modal
      title={id ? 'Artikel bearbeiten' : 'Neuer Artikel'}
      wide
      onClose={onClose}
      footer={
        <>
          {id && (
            <button className="btn danger" onClick={async () => confirmAsk('Artikel löschen?') && (await act(() => api.del(`/api/kb/articles/${id}`))) && onSaved()}>
              Löschen
            </button>
          )}
          {a.preview_url && (
            <a className="btn secondary" href={a.preview_url} target="_blank" rel="noopener">
              Vorschau öffnen
            </a>
          )}
          <button className="btn secondary" onClick={() => save(a.status === 'published' ? 'draft' : undefined)}>
            {a.status === 'published' ? 'Zurück auf Entwurf' : 'Als Entwurf speichern'}
          </button>
          <button className="btn" data-tour="kb-publish" onClick={() => save('published')}>
            {a.status === 'published' ? 'Speichern' : 'Veröffentlichen'}
          </button>
        </>
      }
    >
      <Field label="Titel" tour="kb-title">
        <Input value={a.title} onChange={(v) => setA({ ...a, title: v })} autoFocus={!id} placeholder="z. B. Passwort zurücksetzen" />
      </Field>
      <div className="grid2">
        <Field label="Kategorie" tour="kb-category">
          <Select value={a.category_id} onChange={(v) => setA({ ...a, category_id: v })} placeholder="– ohne –" options={cats.map((c) => [c.id, c.name])} />
        </Field>
        <Field label="Tags (Suchbegriffe)" tour="kb-tags">
          <TagInput value={a.tags ?? []} onChange={(v) => setA({ ...a, tags: v })} />
        </Field>
      </div>
      <Tabs tabs={[['text', 'Text (Markdown)'], ['preview', 'Vorschau'], ['seo', 'SEO & Adresse']]} value={tab} onChange={setTab} />
      {tab === 'text' && (
        <Field tour="kb-body" label="Text" hint="## Überschrift, **fett**, *kursiv*, - Liste, 1. Liste, [Link](https://…), ![Bild](https://…), > Hinweis, ``` Code; ein YouTube-/Vimeo-Link allein in einer Zeile wird zum Video.">
          <Textarea value={a.body} onChange={(v) => setA({ ...a, body: v })} rows={16} className="mono" />
        </Field>
      )}
      {tab === 'preview' && <div className="card kb-preview prose" dangerouslySetInnerHTML={{ __html: preview || '<p class="muted">Kein Text.</p>' }} />}
      {tab === 'seo' && (
        <>
          <Field label="Kurzbeschreibung" hint="Erscheint in Listen und Suchergebnissen – leer = Anfang des Textes">
            <Textarea value={a.excerpt} onChange={(v) => setA({ ...a, excerpt: v })} rows={2} />
          </Field>
          <Field label="SEO-Titel">
            <Input value={a.seo?.title} onChange={(v) => setA({ ...a, seo: { ...a.seo, title: v } })} placeholder={a.title} />
          </Field>
          <Field label="SEO-Beschreibung (meta description)">
            <Textarea value={a.seo?.description} onChange={(v) => setA({ ...a, seo: { ...a.seo, description: v } })} rows={2} />
          </Field>
          {id && (
            <Field label="Adresse (Slug)">
              <Input value={a.slug} onChange={(v) => setA({ ...a, slug: v })} />
            </Field>
          )}
          <Check checked={!!a.seo?.noindex} onChange={(v) => setA({ ...a, seo: { ...a.seo, noindex: v } })} label="Nicht in Suchmaschinen anzeigen (noindex)" />
        </>
      )}
    </Modal>
  );
}

export function KnowledgeBase() {
  const info = useLoad(() => api.get('/api/kb/info'), []);
  const cats = useLoad(() => api.get<any[]>('/api/kb/categories'), []);
  const [status, setStatus] = useState('');
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const arts = useLoad(() => api.get<any[]>(`/api/kb/articles?status=${status}&category_id=${cat}&q=${encodeURIComponent(q)}`), [status, cat, q]);
  const [modal, setModal] = useState<{ kind: 'cat'; cat?: any } | { kind: 'art'; id?: string } | null>(null);
  const reload = () => (setModal(null), arts.reload(), cats.reload());
  return (
    <>
      <PageHead title="Wissensdatenbank" sub="Hilfe-Artikel für dein öffentliches Hilfe-Center – und als Vorschläge beim Beantworten von Tickets">
        {info.data && (
          <a className="btn secondary" data-tour="kb-public" href={info.data.url} target="_blank" rel="noopener">
            <Icon name="external" size={14} /> Hilfe-Center {info.data.enabled ? 'öffnen' : '(nicht öffentlich)'}
          </a>
        )}
        <button className="btn secondary" data-tour="kb-new-cat" onClick={() => setModal({ kind: 'cat' })}>
          + Kategorie
        </button>
        <button className="btn" data-tour="kb-new" onClick={() => setModal({ kind: 'art' })}>
          + Artikel
        </button>
      </PageHead>
      {info.data && !info.data.enabled && (
        <div className="card notice-card" data-tour="kb-notice">
          Das Hilfe-Center ist noch nicht öffentlich. Einschalten unter <Link to="settings/helpdesk">Einstellungen → Service</Link> (Bereich „Kundenportal & Hilfe-Center“).
        </div>
      )}
      <div className="kb-layout">
        <aside className="card kb-cats" data-tour="kb-cats">
          <button className={`kb-cat${cat === '' ? ' on' : ''}`} onClick={() => setCat('')}>
            Alle Artikel
          </button>
          {(cats.data ?? []).map((c) => (
            <div key={c.id} className={`kb-cat${cat === c.id ? ' on' : ''}`}>
              <button onClick={() => setCat(c.id)}>
                {c.name} <span className="muted small">{c.articles}</span>
              </button>
              <button className="icon-btn" aria-label={`Kategorie ${c.name} bearbeiten`} onClick={() => setModal({ kind: 'cat', cat: c })}>
                <Icon name="edit" size={13} />
              </button>
            </div>
          ))}
          <button className={`kb-cat${cat === 'none' ? ' on' : ''}`} onClick={() => setCat('none')}>
            <span className="muted">Ohne Kategorie</span>
          </button>
        </aside>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 12 }} data-tour="kb-search">
            <div className="grow">
              <Input value={q} onChange={setQ} placeholder="Artikel suchen…" />
            </div>
            <div style={{ width: 170 }}>
              <Select value={status} onChange={setStatus} placeholder="Alle Status" options={[['published', 'Veröffentlicht'], ['draft', 'Entwurf']]} />
            </div>
          </div>
          {arts.loading && !arts.data ? (
            <Spinner />
          ) : (arts.data ?? []).length ? (
            <div className="table-wrap" data-tour="kb-list">
              <table className="t">
                <thead>
                  <tr>
                    <th>Artikel</th>
                    <th>Status</th>
                    <th>Aufrufe</th>
                    <th>Hilfreich</th>
                    <th>Geändert</th>
                  </tr>
                </thead>
                <tbody>
                  {(arts.data ?? []).map((a) => {
                    const votes = a.helpful_yes + a.helpful_no;
                    return (
                      <tr key={a.id} className="click" {...pressable(() => setModal({ kind: 'art', id: a.id }))}>
                        <td>
                          <strong>{a.title}</strong>
                          <div className="muted small">
                            {a.category_name || 'ohne Kategorie'}
                            {a.status === 'published' && (
                              <>
                                {' · '}
                                <a href={a.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
                                  ansehen
                                </a>
                              </>
                            )}
                          </div>
                        </td>
                        <td>{a.status === 'published' ? <Badge tone="green">Veröffentlicht</Badge> : <Badge>Entwurf</Badge>}</td>
                        <td>{a.views}</td>
                        <td>{votes ? `${Math.round((a.helpful_yes / votes) * 100)} % (${votes})` : <span className="muted">–</span>}</td>
                        <td className="muted small">{dt(a.updated_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty action={<button className="btn" onClick={() => setModal({ kind: 'art' })}>Ersten Artikel schreiben</button>}>Noch keine Artikel{q || status || cat ? ' für diese Filter' : ''}.</Empty>
          )}
        </div>
      </div>
      {modal?.kind === 'cat' && <CategoryModal cat={modal.cat} onClose={() => setModal(null)} onSaved={reload} />}
      {modal?.kind === 'art' && (
<ArticleEditor id={modal.id} cats={cats.data ?? []} onClose={() => setModal(null)} onSaved={reload} />
      )}
    </>
  );
}
