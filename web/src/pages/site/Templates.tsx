import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, act, useLoad } from '../../ui';
import './site.css';
import { useT } from '../../i18n';

interface Meta {
  id: string;
  name: string;
  category: string;
  kind: 'website' | 'funnel';
  description: string;
  tags: string[];
  color: string;
  surface: string;
  pages: { name: string; slug: string; legal: boolean }[];
  needs: string[];
  legal: string[];
  collections: string[];
}

/** German phrases (message ids of the sites catalog), shown through t(). */
const NEEDS: Record<string, string> = { form: 'ein Formular', calendar: 'einen Kalender', product: 'ein Produkt' };

/** A scaled-down look of the template, rendered only when the card comes into view. */
function Thumb({ id, page }: { id: string; page?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState('');
  const [seen, setSeen] = useState(false);
  const [scale, setScale] = useState(0.21);
  // The page is laid out 1200 px wide and scaled down to the card.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => el.clientWidth && setScale(el.clientWidth / 1200);
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && (setSeen(true), io.disconnect()), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen) return;
    let live = true;
    api.text('GET', `/api/site-templates/${id}/preview${page ? `?page=${encodeURIComponent(page)}` : ''}`).then((h) => live && setHtml(h.replace(/<script[\s\S]*?<\/script>/g, '')), () => undefined);
    return () => {
      live = false;
    };
  }, [seen, id, page]);
  return (
    <div className="tpl-thumb" ref={box} aria-hidden="true">
      {html ? <iframe title="" tabIndex={-1} sandbox="" srcDoc={html} loading="lazy" style={{ transform: `scale(${scale})` }} /> : <div className="tpl-thumb-wait" />}
    </div>
  );
}

/** The 23 templates: categories, search, a large preview per page and device, and the step that builds the site. */
export function TemplateGallery({ onClose, onApplied }: { onClose: () => void; onApplied: (site: { id: string }) => void }) {
  const t = useT('sites');
  const list = useLoad(() => api.get<{ categories: string[]; templates: Meta[] }>('/api/site-templates'), []);
  const [cat, setCat] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Meta | null>(null);
  const [done, setDone] = useState<any>(null);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list.data?.templates ?? []).filter((x) => (!cat || x.category === cat) && (!kind || x.kind === kind) && (!s || `${x.name} ${x.description} ${x.tags.join(' ')} ${x.category}`.toLowerCase().includes(s)));
  }, [list.data, cat, kind, q]);

  if (done)
    return (
      <Modal
        title={t('Fertig – deine Website steht')}
        onClose={() => onApplied(done)}
        footer={
          <button className="btn" onClick={() => onApplied(done)}>
            {t('Zur Website')}
          </button>
        }
      >
        <p>
          <b>{done.name}</b> {t('wurde aus der Vorlage angelegt:')}{' '}
          {[t.plural(done.pages.length, { other: '{n} Seiten' }), done.wiring.form_created ? t('ein neues Formular') : '', done.wiring.collections.length ? t.plural(done.wiring.collections.length, { other: '{n} Sammlung(en) mit Beispieleinträgen' }) : ''].filter(Boolean).join(', ')}.
        </p>
        {done.legal?.applied && <p className="a11y-ok">{t('Impressum und Datenschutz wurden aus deinen Firmendaten erzeugt ({kinds}).', { kinds: done.legal.kinds.join(', ') })}</p>}
        {done.notes?.length > 0 && (
          <>
            <p>
              <b>{t('Das fehlt noch:')}</b>
            </p>
            <ul className="tpl-notes">
              {done.notes.map((n: string, i: number) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">{t('Texte, Bilder und Farben passt du im Editor an – die Beispieltexte sind Platzhalter, bitte ersetzen.')}</p>
      </Modal>
    );

  return (
    <Modal title={pick ? t('Vorlage: {name}', { name: pick.name }) : t('Vorlagen')} wide className="tpl-modal" onClose={onClose}>
      {pick ? (
        <Detail tpl={pick} onBack={() => setPick(null)} onDone={setDone} />
      ) : (
        <div data-tour="site-templates">
          <div className="tpl-filters">
            <Input value={q} onChange={setQ} placeholder={t('Suchen: Coach, Restaurant, Webinar …')} aria-label={t('Vorlagen durchsuchen')} />
            <Select value={kind} onChange={setKind} placeholder={t('Websites & Funnels')} options={[['website', t('Nur Websites')], ['funnel', t('Nur Funnels')]]} />
          </div>
          <div className="tpl-cats" role="group" aria-label={t('Kategorien')}>
            <button className={`btn small ${cat ? 'secondary' : ''}`} onClick={() => setCat('')}>
              {t('Alle ({n})', { n: list.data?.templates.length ?? 0 })}
            </button>
            {(list.data?.categories ?? []).map((c) => (
              <button key={c} className={`btn small ${cat === c ? '' : 'secondary'}`} onClick={() => setCat(c === cat ? '' : c)}>
                {c}
              </button>
            ))}
          </div>
          {!list.data ? (
            <Spinner />
          ) : shown.length ? (
            <div className="tpl-grid">
              {shown.map((x) => (
                <button key={x.id} className="tpl-card" onClick={() => setPick(x)} aria-label={t('Vorlage {name} ansehen', { name: x.name })}>
                  <Thumb id={x.id} />
                  <span className="tpl-info">
                    <b>{x.name}</b>
                    <span className="muted small">{x.description}</span>
                    <span className="tpl-meta small">
                      <Badge tone={x.kind === 'website' ? 'blue' : 'purple'}>{x.kind === 'website' ? t('Website') : t('Funnel')}</Badge>
                      <span className="muted">{t.plural(x.pages.length, { other: '{n} Seiten' })}</span>
                    </span>
                  </span>
                  <i className="tpl-swatch" style={{ background: x.color }} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <Empty>{t('Keine Vorlage passt zur Suche.')}</Empty>
          )}
        </div>
      )}
    </Modal>
  );
}

function Detail({ tpl, onBack, onDone }: { tpl: Meta; onBack: () => void; onDone: (r: any) => void }) {
  const t = useT('sites');
  const [page, setPage] = useState(tpl.pages[0].slug);
  const [phone, setPhone] = useState(false);
  const [html, setHtml] = useState('');
  const [name, setName] = useState('');
  const [formId, setFormId] = useState('');
  const [calendar, setCalendar] = useState('');
  const [product, setProduct] = useState('');
  const [legal, setLegal] = useState(true);
  const [samples, setSamples] = useState(true);
  const [busy, setBusy] = useState(false);
  const forms = useLoad(() => (tpl.needs.includes('form') ? api.get<any[]>('/api/forms') : Promise.resolve([])), [tpl.id]);
  const calendars = useLoad(() => (tpl.needs.includes('calendar') ? api.get<any[]>('/api/calendars') : Promise.resolve([])), [tpl.id]);
  const products = useLoad(() => (tpl.needs.includes('product') ? api.get<any[]>('/api/products') : Promise.resolve([])), [tpl.id]);

  useEffect(() => {
    let live = true;
    setHtml('');
    api.text('GET', `/api/site-templates/${tpl.id}/preview?page=${encodeURIComponent(page)}`).then((h) => live && setHtml(h), () => undefined);
    return () => {
      live = false;
    };
  }, [tpl.id, page]);

  const apply = async () => {
    setBusy(true);
    const r = await act(() =>
      api.post(`/api/site-templates/${tpl.id}/apply`, {
        name: name.trim() || undefined,
        form_id: formId || undefined,
        calendar_slug: calendar || undefined,
        product_id: product || undefined,
        legal,
        samples,
      }),
    );
    setBusy(false);
    if (r) onDone(r);
  };

  return (
    <div className="tpl-detail">
      <div className="tpl-pv">
        <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
          <button className="btn small secondary" onClick={onBack}>
            {t('← Alle Vorlagen')}
          </button>
          <div className="tabs" style={{ margin: 0 }} role="group" aria-label={t('Seite der Vorlage')}>
            {tpl.pages.map((p) => (
              <button key={p.slug} className={p.slug === page ? 'on' : ''} onClick={() => setPage(p.slug)} aria-pressed={p.slug === page}>
                {p.name}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button className={`btn small ${phone ? 'secondary' : ''}`} onClick={() => setPhone(false)} aria-pressed={!phone}>
            {t('Desktop')}
          </button>
          <button className={`btn small ${phone ? '' : 'secondary'}`} onClick={() => setPhone(true)} aria-pressed={phone}>
            {t('Handy')}
          </button>
        </div>
        <div className="se-frame-wrap tpl-frame-wrap">
          <iframe className="preview-frame se-frame" style={{ width: phone ? 390 : '100%' }} title={t('Vorschau {name}', { name: tpl.name })} sandbox="allow-scripts" srcDoc={html} />
        </div>
      </div>

      <div className="tpl-side card">
        <h3>{tpl.name}</h3>
        <p className="muted small">{tpl.description}</p>
        <p>
          <Badge tone={tpl.kind === 'website' ? 'blue' : 'purple'}>{tpl.kind === 'website' ? t('Website') : t('Funnel')}</Badge> <span className="muted small">{tpl.category}</span>
        </p>
        <Field label={t('Name deiner Website')}>
          <Input value={name} onChange={setName} placeholder={t('z. B. Müller Coaching')} autoFocus />
        </Field>
        {tpl.needs.includes('form') && (
          <Field label={t('Formular')} hint={t('Ohne Auswahl legt die Vorlage ein passendes Formular mit Einwilligung neu an.')}>
            <Select value={formId} onChange={setFormId} placeholder={t('Neues Formular anlegen')} options={(forms.data ?? []).map((f) => [f.id, f.name])} />
          </Field>
        )}
        {tpl.needs.includes('calendar') && (
          <Field label={t('Kalender')}>
            <Select value={calendar} onChange={setCalendar} placeholder={(calendars.data ?? []).length ? t('Ersten Kalender nehmen') : t('Noch kein Kalender – später wählen')} options={(calendars.data ?? []).map((c) => [c.slug, c.name])} />
          </Field>
        )}
        {tpl.needs.includes('product') && (
          <Field label={t('Produkt')} hint={t('Das Produkt aus Rechnungen → Produkte; der Kauf-Button erscheint, sobald Stripe verbunden ist.')}>
            <Select value={product} onChange={setProduct} placeholder={t('Später wählen')} options={(products.data ?? []).filter((p) => p.active !== 0).map((p) => [p.id, p.name])} />
          </Field>
        )}
        {tpl.collections.length > 0 && <Check checked={samples} onChange={setSamples} label={t('Beispiel-Einträge anlegen (Team, Projekte, Stimmen …)')} />}
        {tpl.legal.length > 0 && <Check checked={legal} onChange={setLegal} label={t('Rechtsseiten ({pages}) aus den Firmendaten erzeugen', { pages: tpl.legal.map((l) => ({ impressum: t('Impressum'), datenschutz: t('Datenschutz'), widerruf: t('Widerruf') })[l] ?? l).join(', ') })} />}
        {tpl.needs.length > 0 && (
          <p className="muted small">
            {t('Diese Vorlage nutzt')} {tpl.needs.map((n) => (NEEDS[n] ? t(NEEDS[n]) : n)).join(', ')}.
          </p>
        )}
        <button className="btn" disabled={busy} onClick={apply} data-tour="site-template-apply">
          {busy ? t('Wird angelegt …') : tpl.kind === 'website' ? t('Website anlegen') : t('Funnel anlegen')}
        </button>
        <p className="muted small">{t('Alles lässt sich danach im Editor ändern. Die Beispieltexte sind Platzhalter.')}</p>
      </div>
    </div>
  );
}
