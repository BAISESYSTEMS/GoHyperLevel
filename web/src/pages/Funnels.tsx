import { Suspense, useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { lazyPages } from '../lazy';
import { api, dt } from '../api';
import { useSession } from '../session';
import { DomainBadge } from './Agency';
import { BlogTab } from './Blog';
import { AbTestTab, useRunningTests } from './AbTests';
import { act, Check, confirmAsk, Empty, Field, Input, Link, Modal, navigate, PageHead, pressable, Select, Spinner, Tabs, Textarea, toast, useLoad } from '../ui';
import { QrButton } from '../QrCode';
import { useT } from '../i18n';
import { MoreFields, useSimple } from '../areas/fields';
import { SortableGrid } from '../sortable/Sortable';

// The page editor, the design, collections, redirects, statistics, accessibility check and the template gallery load as their own chunks
// (web/src/pages/site): none of it is part of the first download.
const { SiteEditor } = lazyPages(() => import('./site/Editor'), 'SiteEditor');
const { DesignTab } = lazyPages(() => import('./site/Design'), 'DesignTab');
const { CmsTab } = lazyPages(() => import('./site/Cms'), 'CmsTab');
const { RedirectsTab } = lazyPages(() => import('./site/Redirects'), 'RedirectsTab');
const { A11yTab } = lazyPages(() => import('./site/A11y'), 'A11yTab');
const { AnalyticsTab } = lazyPages(() => import('./site/Analytics'), 'AnalyticsTab');
const { TemplateGallery } = lazyPages(() => import('./site/Templates'), 'TemplateGallery');
// Funnel & Website AI: "Mit KI erstellen" and the banner of an unpublished AI draft (docs/site-ai.md).
const { SiteAiCreate } = lazyPages(() => import('./site/AiCreate'), 'SiteAiCreate');
const { SiteAiDraftBanner } = lazyPages(() => import('./site/AiPanel'), 'SiteAiDraftBanner');
// SEO-Check, structured data, password protection, URL text and own fonts (docs/sites.md#seo-check).
const { SiteSeoTab, SiteFonts } = lazyPages(() => import('./SiteSeo'), 'SiteSeoTab', 'SiteFonts');

const Later = ({ children }: { children: ReactNode }) => <Suspense fallback={<Spinner />}>{children}</Suspense>;

/** `endpoints` lets other editors reuse the builder (A/B variants); `extra` replaces the live link. */
function PageBuilder(props: { page: any; funnel: any; onSaved: () => void; endpoints?: { save: string; preview: string }; extra?: ReactNode; focusBlock?: string }) {
  return (
    <Later>
      <SiteEditor {...props} />
    </Later>
  );
}

export function FunnelEditor({ id }: { id: string }) {
  const t = useT('sites');
  const session = useSession();
  const funnel = useLoad(() => api.get(`/api/funnels/${id}`), [id]);
  const domainInfo = useLoad(() => api.get('/api/domain-info'), []);
  const [pageId, setPageId] = useState('');
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(location.search).get('tab') ?? '';
    return ['blog', 'design', 'cms', 'redirects', 'stats', 'a11y', 'seo', 'settings'].includes(q) ? q : 'pages';
  });
  const [focusBlock, setFocusBlock] = useState('');
  const [newPage, setNewPage] = useState('');
  const [pageTab, setPageTab] = useState('content');
  const testing = useRunningTests(id);
  const simple = useSimple();
  if (!funnel.data) return <Spinner />;
  const f = funnel.data;
  const page = f.pages.find((p: any) => p.id === pageId) ?? f.pages[0];
  const s = f.settings ?? {};
  const saveSettings = (patch: any) => act(() => api.patch(`/api/funnels/${id}`, patch), t('Gespeichert')).then(() => funnel.reload());

  return (
    <>
      <PageHead title={f.name} sub={<a href={f.url} target="_blank" rel="noreferrer">{f.url}</a>}>
        <QrButton url={f.url} title={t('Funnel {name}', { name: f.name })} />
        <Link to="funnels" className="btn secondary">
          {t('← Übersicht')}
        </Link>
      </PageHead>
      <Later>
        <SiteAiDraftBanner funnelId={id} />
      </Later>
      <Tabs
        tabs={[
          ['pages', t('Seiten')],
          ['design', t('Design')],
          ...(f.kind === 'website' ? [['blog', t('Blog')] as [string, string], ['cms', t('Inhalte (CMS)')] as [string, string], ['redirects', t('Weiterleitungen')] as [string, string]] : []),
          ['stats', t('Statistik')],
          ['a11y', t('Barrierefreiheit')],
          ['seo', t('SEO & Zugang')],
          ['settings', t('Einstellungen & Domain')],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'blog' && <BlogTab funnel={f} />}
      {tab === 'design' && (
        <Later>
          <DesignTab funnel={f} onSaved={funnel.reload} />
          <SiteFonts funnelId={f.id} />
        </Later>
      )}
      {tab === 'seo' && (
        <Later>
          <SiteSeoTab funnel={f} />
        </Later>
      )}
      {tab === 'cms' && (
        <Later>
          <CmsTab funnel={f} onChanged={funnel.reload} />
        </Later>
      )}
      {tab === 'redirects' && (
        <Later>
          <RedirectsTab funnel={f} />
        </Later>
      )}
      {tab === 'stats' && (
        <Later>
          <AnalyticsTab funnel={f} />
        </Later>
      )}
      {tab === 'a11y' && (
        <Later>
          <A11yTab
            funnel={f}
            onChanged={funnel.reload}
            onOpenPage={(pid, blockId) => {
              setPageId(pid);
              setFocusBlock(blockId ?? '');
              setPageTab('content');
              setTab('pages');
            }}
          />
        </Later>
      )}
      {tab === 'pages' && (
        <>
          <div className="row" style={{ marginBottom: 12, alignItems: 'center' }} data-tour="funnel-pages">
            {f.pages.map((p: any, i: number) => (
              <button key={p.id} className={`btn small ${p.id === page?.id ? '' : 'secondary'}`} onClick={() => setPageId(p.id)}>
                {i + 1}. {p.name} <span style={{ fontWeight: 400 }}>({t.plural(p.views, { other: '{n} Aufrufe' })})</span>
                {testing.has(p.id) && <span className="ab-dot" title={t('A/B-Test läuft')}>{t('A/B')}</span>}
              </button>
            ))}
            <div style={{ width: 180 }}>
              <Input value={newPage} onChange={setNewPage} placeholder={t('Neue Seite…')} />
            </div>
            <button
              className="btn small secondary"
              disabled={!newPage}
              onClick={async () => {
                const p = await act(() => api.post(`/api/funnels/${id}/pages`, { name: newPage }));
                if (p) {
                  setNewPage('');
                  await funnel.reload();
                  setPageId(p.id);
                }
              }}
            >
              {t('+ Seite')}
            </button>
            {page && f.pages.length > 1 && (
              <button className="btn small ghost" onClick={async () => confirmAsk(t('Seite „{name}“ löschen?', { name: page.name })) && (await act(() => api.del(`/api/funnel-pages/${page.id}`))) && (setPageId(''), funnel.reload())}>
                {t('Seite löschen')}
              </button>
            )}
          </div>
          {page && (
            <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
              <span className="muted">{t('Pfad:')}</span>
              <div style={{ width: 200 }}>
                <Input
                  value={page.slug}
                  aria-label={t('Pfad der Seite')}
                  onChange={(v) => funnel.setData({ ...f, pages: f.pages.map((p: any) => (p.id === page.id ? { ...p, slug: v } : p)) })}
                  onBlur={() => act(() => api.patch(`/api/funnel-pages/${page.id}`, { slug: page.slug })).then(() => funnel.reload())}
                />
              </div>
              <span className="muted small">{page.url}</span>
              <QrButton url={page.url} title={t('Seite {name}', { name: page.name ?? page.title ?? '' }).trim()} />
            </div>
          )}
          {page && <Tabs tabs={[['content', t('Inhalt')], ['ab', testing.has(page.id) ? `${t('A/B-Test')} ●` : t('A/B-Test')]]} value={pageTab} onChange={setPageTab} />}
          {page && pageTab === 'ab' ? (
            <AbTestTab
              page={page}
              funnel={f}
              onPageChanged={funnel.reload}
              renderEditor={(variant, back) => (
                <PageBuilder
                  page={variant}
                  funnel={f}
                  onSaved={() => {}}
                  endpoints={{ save: `/api/ab-variants/${variant.id}`, preview: `/api/ab-variants/${variant.id}/preview` }}
                  extra={
                    <button className="btn secondary" onClick={back}>
                      {t('← Zurück zum Test')}
                    </button>
                  }
                />
              )}
            />
          ) : page ? (
            <PageBuilder page={page} funnel={f} onSaved={funnel.reload} focusBlock={focusBlock} />
          ) : (
            <Empty>{t('Keine Seiten.')}</Empty>
          )}
        </>
      )}
      {tab === 'settings' && (
        <div className="card" style={{ maxWidth: 760 }}>
          <Field label="Name">
            <Input value={f.name} onChange={(v) => funnel.setData({ ...f, name: v })} onBlur={() => saveSettings({ name: f.name })} />
          </Field>
          <Field label={t('Pfad')} hint={`${location.origin}/p/${f.slug}`}>
            <Input value={f.slug} onChange={(v) => funnel.setData({ ...f, slug: v })} onBlur={() => saveSettings({ slug: f.slug })} />
          </Field>
          <Field
            tour="funnel-domain"
            label={t('Eigene Domain')}
            hint={
              <>
                {t('Beim Domain-Anbieter einen A-Record für')} <code>@</code> {t('und')} <code>www</code> {t('auf')} <code>{domainInfo.data?.server_ip || t('die Server-IP')}</code>
                {/* the English catalog has the verb before the address */}
                {t(' setzen.')}{' '}
                {domainInfo.data?.agent ? t('HTTPS richtet sich danach in wenigen Minuten von selbst ein.') : t('Danach die Domain im Proxy eintragen (README „Eigene Domains“).')}
              </>
            }
          >
            <Input value={f.domain} onChange={(v) => funnel.setData({ ...f, domain: v })} onBlur={() => saveSettings({ domain: f.domain ?? '' })} placeholder={t('meine-seite.de')} />
          </Field>
          {f.domain && (
            <p style={{ marginTop: -6 }}>
              <DomainBadge status={f.domain_status} /> <span className="muted small">{f.domain_status?.message}</span>{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), funnel.reload())}>
                {t('aktualisieren')}
              </a>
            </p>
          )}
          <Field label={t('Markenfarbe')}>
            <input type="color" value={s.color || '#2563eb'} onChange={(e) => funnel.setData({ ...f, settings: { ...s, color: e.target.value } })} onBlur={() => saveSettings({ settings: { color: s.color } })} />
          </Field>
          <Field label={t('Beschreibung für Google & Social Media')}>
            <Textarea value={s.description} onChange={(v) => funnel.setData({ ...f, settings: { ...s, description: v } })} rows={2} />
          </Field>
          {/* Einfach-Modus: font, sharing details, favicon, footer, chat and tracking code behind one toggle */}
          <MoreFields id="funnel-settings" values={[s.font, s.site_name, s.og_image, s.noindex, s.favicon, s.head_code, s.footer_text, s.chat_widget]}>
            <div className="grid2">
              <Field label={t('Schrift (CSS)')}>
                <Input value={s.font} onChange={(v) => funnel.setData({ ...f, settings: { ...s, font: v } })} placeholder={t('Georgia')} />
              </Field>
              <Field label={t('Favicon-URL')}>
                <Input value={s.favicon} onChange={(v) => funnel.setData({ ...f, settings: { ...s, favicon: v } })} />
              </Field>
            </div>
            <div className="grid2">
              <Field label={t('Name der Seite (og:site_name)')}>
                <Input value={s.site_name} onChange={(v) => funnel.setData({ ...f, settings: { ...s, site_name: v } })} />
              </Field>
              <Field label={t('Standard-Vorschaubild')}>
                <Input value={s.og_image} onChange={(v) => funnel.setData({ ...f, settings: { ...s, og_image: v } })} placeholder="https://…" />
              </Field>
            </div>
            <Check checked={!!s.noindex} onChange={(v) => funnel.setData({ ...f, settings: { ...s, noindex: v } })} label={t('Ganze Website vor Google verbergen (z. B. während des Aufbaus)')} />
            <p className="muted small">
              {t('Automatisch dabei:')} <a href={`${f.url}/sitemap.xml`} target="_blank" rel="noreferrer">sitemap.xml</a> {t('und')} <a href={`${f.url}/robots.txt`} target="_blank" rel="noreferrer">robots.txt</a> {t('– bei Google Search Console die Sitemap einreichen.')}
            </p>
            <Field label={t('Fußzeile (z. B. [Impressum](/p/slug/impressum) · [Datenschutz](…))')}>
              <Input value={s.footer_text} onChange={(v) => funnel.setData({ ...f, settings: { ...s, footer_text: v } })} />
            </Field>
            <Check checked={!!s.chat_widget} onChange={(v) => funnel.setData({ ...f, settings: { ...s, chat_widget: v } })} label={t('Live-Chat anzeigen (einschalten unter Einstellungen → Live-Chat)')} />
            {/* raw code: Profi only – unless it already holds something */}
            {(!simple || s.head_code) && (
              <Field label={t('Code im <head> (Tracking, Meta-Pixel, Plausible…)')}>
                <Textarea className="mono" value={s.head_code} onChange={(v) => funnel.setData({ ...f, settings: { ...s, head_code: v } })} rows={5} />
              </Field>
            )}
          </MoreFields>
          <div className="actions">
            <button className="btn" onClick={() => saveSettings({ settings: f.settings })}>
              {t('Speichern')}
            </button>
            {session.locations.length > 1 && (
              <div style={{ width: 220 }}>
                <Select
                  value=""
                  placeholder={t('In anderen Kunden kopieren…')}
                  options={session.locations.filter((l) => l.id !== session.locationId).map((l) => [l.id, l.name])}
                  onChange={async (target) => {
                    if (!target) return;
                    const r = await act(() => api.post(`/api/funnels/${id}/copy`, { location_id: target }));
                    const to = String(session.locations.find((l) => l.id === target)?.name);
                    if (r) toast(r.blog_posts ? t('Kopiert nach {name} (mit {forms} Formularen, {calendars} Kalendern, {posts} Blog-Beiträgen)', { name: to, forms: r.forms.length, calendars: r.calendars.length, posts: r.blog_posts }) : t('Kopiert nach {name} (mit {forms} Formularen, {calendars} Kalendern)', { name: to, forms: r.forms.length, calendars: r.calendars.length }));
                  }}
                />
              </div>
            )}
            <button className="btn danger" onClick={async () => confirmAsk(t('Funnel mit allen Seiten löschen?')) && (await act(() => api.del(`/api/funnels/${id}`))) && navigate('funnels')}>
              {t('Löschen')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function Funnels() {
  const t = useT('sites');
  const list = useLoad(() => api.get<any[]>('/api/funnels'), []);
  const [modal, setModal] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [aiCreate, setAiCreate] = useState(false);
  const [f, setF] = useState({ name: '', kind: 'funnel', template: 'leadmagnet' });
  return (
    <>
      <PageHead title={t('Funnels & Websites')} sub={t('Landingpages, Funnels und ganze Webseiten mit Formularen und Kalendern')}>
        <button className="btn secondary" data-tour="funnels-templates" onClick={() => setGallery(true)}>
          {t('Vorlagen ansehen')}
        </button>
        <button className="btn ai" data-tour="funnels-ai" onClick={() => setAiCreate(true)}>
          <Icon name="ai" size={15} /> {t('Mit KI erstellen')}
        </button>
        <button className="btn" data-tour="funnels-new" onClick={() => setModal(true)}>
          {t('+ Neu')}
        </button>
      </PageHead>
      {gallery && (
        <Later>
          <TemplateGallery onClose={() => setGallery(false)} onApplied={(r) => (setGallery(false), navigate(`funnels/${r.id}`))} />
        </Later>
      )}
      {aiCreate && (
        <Later>
          <SiteAiCreate onClose={() => setAiCreate(false)} onCreated={(r) => (setAiCreate(false), navigate(`funnels/${r.funnel_id}`))} />
        </Later>
      )}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <SortableGrid id="funnels-list" className="stats" data-tour="funnels-list">
          {list.data.map((x) => (
            <div key={x.id} className="card" style={{ cursor: 'pointer' }} {...pressable(() => navigate(`funnels/${x.id}`))}>
              <div className="muted small">{x.kind === 'website' ? <><Icon name="website" /> {t('Website')}</> : <><Icon name="funnels" /> {t('Funnel')}</>}</div>
              <h2 style={{ margin: '4px 0' }}>{x.name}</h2>
              <div className="muted small">
                {[t.plural(x.pages, { other: '{n} Seiten' }), t.plural(x.views, { other: '{n} Aufrufe' }), dt(x.updated_at)].join(' · ')}
              </div>
              {x.domain && (
                <div className="small">
                  <Icon name="link" /> {x.domain} <DomainBadge status={x.domain_status} />
                </div>
              )}
            </div>
          ))}
        </SortableGrid>
      ) : (
        <Empty
          learn
          action={
            <>
              <button className="btn" onClick={() => setGallery(true)}>
                {t('Aus Vorlage starten')}
              </button>{' '}
              <button className="btn secondary" onClick={() => setModal(true)}>
                {t('Leer anfangen')}
              </button>
            </>
          }
        >
          {t('Noch keine Seiten.')}
        </Empty>
      )}
      {modal && (
        <Modal
          title={t('Neuer Funnel / Website')}
          onClose={() => setModal(false)}
          footer={
            <button
              className="btn"
              onClick={async () => {
                const r = await act(() => api.post('/api/funnels', { ...f, name: f.name || t('Neuer Funnel') }));
                if (r) {
                  toast(t('Angelegt'));
                  navigate(`funnels/${r.id}`);
                }
              }}
            >
              {t('Anlegen')}
            </button>
          }
        >
          <Field label="Name" tour="funnel-name">
            <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} autoFocus />
          </Field>
          <Field label={t('Art')} tour="funnel-kind">
            <Select value={f.kind} onChange={(v) => setF({ ...f, kind: v, template: v === 'website' ? 'website' : 'leadmagnet' })} options={[['funnel', t('Funnel')], ['website', t('Website')]]} />
          </Field>
          <Field label={t('Vorlage')} tour="funnel-template">
            <Select
              value={f.template}
              onChange={(v) => setF({ ...f, template: v })}
              options={[
                ['leadmagnet', t('Lead-Magnet (Opt-in + Danke)')],
                ['booking', t('Terminbuchung')],
                ['website', t('Website (Start, Impressum, Datenschutz)')],
                ['blank', t('Leer')],
              ]}
            />
          </Field>
        </Modal>
      )}
    </>
  );
}

