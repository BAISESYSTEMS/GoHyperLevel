import { Suspense, useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, d, dt } from '../api';
import { act, Badge, Check, confirmAsk, Copy, Empty, Field, Input, Modal, pressable, Select, Spinner, TagInput, Textarea, toast, useLoad } from '../ui';
import { ImagePicker, MarkdownEditor, fromLocalInput, toLocalInput } from './ContentKit';
import { lazyPages } from '../lazy';

// The AI writer of the Funnel & Website AI (docs/site-ai.md#ai-writer).
const { AiWriteButton } = lazyPages(() => import('./site/AiWriter'), 'AiWriteButton');
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';

/** Blog tab of a website (Funnels & Websites → Website → Blog). */

/** German labels (message ids of the sites catalog), shown through t(). */
const STATUS: Record<string, [string, 'gray' | 'yellow' | 'green']> = {
  draft: ['Entwurf', 'gray'],
  scheduled: ['Geplant', 'yellow'],
  published: ['Veröffentlicht', 'green'],
};

export function StatusBadge({ p }: { p: any }) {
  const t = useT('sites');
  const [label, tone] = STATUS[p.status] ?? [p.status, 'gray'];
  return (
    <Badge tone={tone}>
      {STATUS[p.status] ? t(label) : label}
      {p.status === 'scheduled' && p.publish_at ? ` · ${dt(p.publish_at)}` : ''}
    </Badge>
  );
}

function BlogSettings({ funnel, info, onClose, onSaved }: { funnel: any; info: any; onClose: () => void; onSaved: () => void }) {
  const t = useT('sites');
  const [s, setS] = useState({ title: t('Blog'), description: '', per_page: 9, ...(info?.settings ?? {}) });
  const save = async () => {
    const r = await act(() => api.patch(`/api/funnels/${funnel.id}`, { settings: { blog: { title: s.title, description: s.description, per_page: Number(s.per_page) || 9 } } }), t('Gespeichert'));
    if (r) {
      onSaved();
      onClose();
    }
  };
  return (
    <Modal title={t('Blog-Einstellungen')} onClose={onClose} footer={<button className="btn" onClick={save}>{t('Speichern')}</button>}>
      <Field label={t('Überschrift der Blog-Seite')}>
        <Input value={s.title} onChange={(v) => setS({ ...s, title: v })} placeholder={t('Blog')} />
      </Field>
      <Field label={t('Einleitung (auch für Google)')}>
        <Textarea value={s.description} onChange={(v) => setS({ ...s, description: v })} rows={3} placeholder={t('Tipps rund um …')} />
      </Field>
      <Field label={t('Beiträge pro Seite')}>
        <Input type="number" min={3} max={48} value={s.per_page} onChange={(v) => setS({ ...s, per_page: Number(v) })} />
      </Field>
    </Modal>
  );
}

function PostEditor({ funnel, postId, tags, onBack }: { funnel: any; postId: string; tags: string[]; onBack: () => void }) {
  const t = useT('sites');
  const loaded = useLoad(() => api.get(`/api/funnels/${funnel.id}/posts/${postId}`), [postId]);
  const [p, setP] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (loaded.data) setP({ ...loaded.data, seo: loaded.data.seo ?? {} });
  }, [loaded.data]);
  useEffect(() => {
    if (!p) return;
    const timer = setTimeout(() => api.text('POST', `/api/funnels/${funnel.id}/posts/preview`, p).then(setHtml), 400);
    return () => clearTimeout(timer);
  }, [p, funnel.id]);
  if (!p) return <Spinner />;

  const set = (patch: any) => {
    setP({ ...p, ...patch });
    setDirty(true);
  };
  const setSeo = (patch: any) => set({ seo: { ...p.seo, ...patch } });
  const save = async (extra: any = {}) => {
    setBusy(true);
    const body = { title: p.title, slug: p.slug, excerpt: p.excerpt, cover_image: p.cover_image, content: p.content, author: p.author, tags: p.tags, status: p.status, publish_at: p.publish_at || null, seo: p.seo, ...extra };
    const r = await act(() => api.patch(`/api/funnels/${funnel.id}/posts/${p.id}`, body));
    setBusy(false);
    if (!r) return;
    setP({ ...r, seo: r.seo ?? {} });
    setDirty(false);
    toast(r.status === 'published' ? (p.status === 'published' ? t('Gespeichert') : t('Veröffentlicht 🎉')) : r.status === 'scheduled' ? t('Geplant für {date}', { date: dt(r.publish_at) }) : t('Entwurf gespeichert'));
  };
  const live = p.status === 'published' ? p.url : p.preview_url;

  return (
    <>
      <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
        <button className="btn secondary" onClick={() => (!dirty || confirmAsk(t('Ungespeicherte Änderungen verwerfen?'))) && onBack()}>
          {t('← Alle Beiträge')}
        </button>
        <StatusBadge p={p} />
        <span className="grow" />
        {live && (
          <a className="btn secondary" href={live} target="_blank" rel="noreferrer">
            {p.status === 'published' ? t('Ansehen ↗') : t('Vorschau-Link ↗')}
          </a>
        )}
        <button className="btn secondary" disabled={busy || !dirty} onClick={() => save()}>
          {dirty ? t('Speichern') : t('Gespeichert ✓')}
        </button>
        {p.status !== 'published' && (
          <button className="btn" disabled={busy} onClick={() => save({ status: 'published', publish_at: p.publish_at && Date.parse(p.publish_at) <= Date.now() ? p.publish_at : null })}>
            {t('Jetzt veröffentlichen')}
          </button>
        )}
      </div>
      <div className="builder post-builder">
        <div>
          <div className="card">
            <Field label={t('Titel')}>
              <Input value={p.title} onChange={(v) => set({ title: v })} />
            </Field>
            <Field label={t('Titelbild')}>
              <ImagePicker value={p.cover_image} onChange={(v) => set({ cover_image: v })} />
            </Field>
            <Field label={t('Inhalt')}>
              <MarkdownEditor value={p.content ?? ''} onChange={(v) => set({ content: v })} rows={18} placeholder={t('## Zwischenüberschrift\n\nDein Text …')} />
              <Suspense fallback={null}>
                <AiWriteButton kind="blog" topic={p.title} current={p.content} onText={(r) => set({ content: r.text, ...(p.title ? {} : { title: r.title ?? '' }), ...(p.excerpt ? {} : { excerpt: r.excerpt ?? '' }) })} />
              </Suspense>
            </Field>
            {/* Einfach-Modus: address, excerpt, author and tags behind one toggle (the address follows the title by itself) */}
            <MoreFields id="blog-post" values={[p.excerpt, p.author, p.tags]}>
              <Field label={t('Adresse')} hint={p.url}>
                <Input value={p.slug} onChange={(v) => set({ slug: v })} />
              </Field>
              <Field label={t('Kurzbeschreibung')} hint={t('Steht in der Übersicht, unter dem Titel und im RSS-Feed. Leer = Anfang des Textes.')}>
                <Textarea value={p.excerpt} onChange={(v) => set({ excerpt: v })} rows={3} />
              </Field>
              <div className="grid2">
                <Field label={t('Autor')}>
                  <Input value={p.author} onChange={(v) => set({ author: v })} />
                </Field>
                <Field label="Tags">
                  <TagInput value={p.tags ?? []} onChange={(v) => set({ tags: v })} suggestions={tags} />
                </Field>
              </div>
            </MoreFields>
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>{t('Veröffentlichung')}</h3>
            <div className="grid2">
              <Field label="Status">
                <Select value={p.status} onChange={(v) => set({ status: v })} options={[['draft', t('Entwurf')], ['scheduled', t('Geplant')], ['published', t('Veröffentlicht')]]} />
              </Field>
              {p.status !== 'draft' && (
                <Field label={p.status === 'scheduled' ? t('Erscheint am') : t('Datum (leer = jetzt)')}>
                  <Input type="datetime-local" value={toLocalInput(p.status === 'published' ? p.published_at ?? p.publish_at : p.publish_at)} onChange={(v) => set({ publish_at: fromLocalInput(v) })} />
                </Field>
              )}
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {t('Geplante Beiträge gehen zum eingestellten Zeitpunkt automatisch online.')} {p.views ? t.plural(p.views, { other: 'Bisher {n} Aufrufe.' }) : ''}
            </p>
          </div>
          <MoreFields id="blog-seo" label={t('SEO & Social Media')} values={[p.seo.title, p.seo.description, p.seo.og_image, p.seo.noindex]}>
            <div className="card">
              <h3 style={{ marginBottom: 10 }}>{t('SEO & Social Media')}</h3>
              <Field label={t('Titel für Google')} hint={t('{n}/{max} Zeichen', { n: (p.seo.title || p.title || '').length, max: 60 })}>
                <Input value={p.seo.title} onChange={(v) => setSeo({ title: v })} placeholder={p.title} />
              </Field>
              <Field label={t('Beschreibung für Google')} hint={t('{n}/{max} Zeichen', { n: (p.seo.description || '').length, max: 160 })}>
                <Textarea value={p.seo.description} onChange={(v) => setSeo({ description: v })} rows={3} placeholder={p.excerpt || p.excerpt_auto} />
              </Field>
              <Field label={t('Bild für Social Media (leer = Titelbild)')}>
                <ImagePicker value={p.seo.og_image} onChange={(v) => setSeo({ og_image: v })} />
              </Field>
              <Check checked={!!p.seo.noindex} onChange={(v) => setSeo({ noindex: v })} label={t('Nicht in Google anzeigen (noindex)')} />
            </div>
          </MoreFields>
          <div className="actions" style={{ marginTop: 14 }}>
            <button
              className="btn danger"
              onClick={async () => {
                if (confirmAsk(t('Beitrag „{name}“ löschen?', { name: p.title })) && (await act(() => api.del(`/api/funnels/${funnel.id}/posts/${p.id}`), t('Gelöscht')))) onBack();
              }}
            >
              {t('Löschen')}
            </button>
          </div>
        </div>
        <div>
          <p className="muted small">{t('Live-Vorschau')}</p>
          <iframe className="preview-frame" srcDoc={html} title={t('Vorschau')} sandbox="allow-scripts" />
        </div>
      </div>
    </>
  );
}

export function BlogTab({ funnel }: { funnel: any }) {
  const t = useT('sites');
  const posts = useLoad(() => api.get<any[]>(`/api/funnels/${funnel.id}/posts`), [funnel.id]);
  const info = useLoad(() => api.get(`/api/funnels/${funnel.id}/blog`), [funnel.id]);
  const [edit, setEdit] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [settings, setSettings] = useState(false);
  const [filter, setFilter] = useState('');
  const tags: string[] = (info.data?.tags ?? []).map((x: any) => x.tag);

  if (edit)
    return (
      <PostEditor
        funnel={funnel}
        postId={edit}
        tags={tags}
        onBack={() => {
          setEdit('');
          void posts.reload();
          void info.reload();
        }}
      />
    );

  const list = (posts.data ?? []).filter((p) => !filter || p.status === filter);
  const count = (s: string) => (posts.data ?? []).filter((p) => p.status === s).length;
  return (
    <>
      <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
        <button className="btn" data-tour="blog-new" onClick={() => setCreating(true)}>
          {t('+ Neuer Beitrag')}
        </button>
        <div style={{ width: 190 }} data-tour="blog-filter">
          <Select value={filter} onChange={setFilter} placeholder={t('Alle ({n})', { n: posts.data?.length ?? 0 })} options={[['published', t('Veröffentlicht ({n})', { n: count('published') })], ['scheduled', t('Geplant ({n})', { n: count('scheduled') })], ['draft', t('Entwürfe ({n})', { n: count('draft') })]]} />
        </div>
        <span className="grow" />
        {info.data && (
          <>
            <a className="btn small secondary" href={info.data.url} target="_blank" rel="noreferrer">
              <Icon name="blog" /> {t('Blog ansehen ↗')}
            </a>
            <Copy text={info.data.rss_url} label={t('RSS-Link kopieren')} />
          </>
        )}
        <button className="btn small secondary" data-tour="blog-settings" onClick={() => setSettings(true)}>
          {t('Einstellungen')}
        </button>
      </div>
      {info.data && (posts.data ?? []).some((p) => p.status === 'published') && (
        <p className="muted small" style={{ marginTop: -4 }}>
          {/* i18n-ignore – Markdown example */}
          {t('Öffentlich unter')} <a href={info.data.url} target="_blank" rel="noreferrer">{info.data.url}</a> {t('– verlinke den Blog auf deinen Seiten, z. B. mit einem Button oder in der Fußzeile')} (<code>[Blog]({info.data.url})</code>).
        </p>
      )}
      {info.data?.page_conflict && (posts.data ?? []).length > 0 && (
        <p className="notice-warn">{t('Die Seite mit dem Pfad „blog“ wird vom Blog überdeckt – benenne sie um, wenn du beides brauchst.')}</p>
      )}
      {posts.loading && !posts.data ? (
        <Spinner />
      ) : list.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Beitrag')}</th>
                <th>Status</th>
                <th>{t('Datum')}</th>
                <th style={{ textAlign: 'right' }}>{t('Aufrufe')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="click" {...pressable(() => setEdit(p.id))}>
                  <td>
                    <div className="post-row">
                      {p.cover_image ? <img src={p.cover_image} alt="" /> : <span className="post-thumb"><Icon name="blog" /></span>}
                      <div style={{ minWidth: 0 }}>
                        <strong>{p.title}</strong>
                        <div className="muted small">
                          /{p.slug}
                          {p.tags?.length ? ` · ${p.tags.join(', ')}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusBadge p={p} />
                  </td>
                  <td className="muted">{p.published_at ? d(p.published_at) : t('geändert {date}', { date: d(p.updated_at) })}</td>
                  <td style={{ textAlign: 'right' }}>{p.views}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty action={!filter && <button className="btn" onClick={() => setCreating(true)}>{t('Ersten Beitrag schreiben')}</button>}>
          {filter ? t('Keine Beiträge mit diesem Status.') : <>{t('Noch keine Beiträge. Sie erscheinen unter')} <code>{info.data?.url ?? '/blog'}</code>{t(', mit RSS-Feed und in der Sitemap.')}</>}
        </Empty>
      )}
      {creating && (
        <Modal
          title={t('Neuer Beitrag')}
          onClose={() => setCreating(false)}
          footer={
            <button
              className="btn"
              disabled={!title.trim()}
              onClick={async () => {
                const r = await act(() => api.post(`/api/funnels/${funnel.id}/posts`, { title }));
                if (r) {
                  setCreating(false);
                  setTitle('');
                  setEdit(r.id);
                }
              }}
            >
              {t('Anlegen')}
            </button>
          }
        >
          <Field label={t('Titel')} hint={t('Startet als Entwurf – erst „Veröffentlichen“ macht ihn sichtbar.')}>
            <Input value={title} onChange={setTitle} autoFocus placeholder={t('z. B. 5 Tipps für …')} />
          </Field>
        </Modal>
      )}
      {settings && <BlogSettings funnel={funnel} info={info.data} onClose={() => setSettings(false)} onSaved={() => void info.reload()} />}
    </>
  );
}
