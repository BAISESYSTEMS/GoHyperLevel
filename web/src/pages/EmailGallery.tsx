import { useEffect, useRef, useState } from 'react';
import { api, currentLocation } from '../api';
import { Badge, Check, Empty, Modal, Spinner, act, confirmAsk, navigate, useLoad } from '../ui';
import { de, useDebounced } from './MarketingKit';
import { useT } from '../i18n';

/**
 * Template gallery: finished German e-mail designs by occasion, searchable, with a preview. A template is copied as the
 * sub-account's own template or onto a campaign draft and is then edited in the designer like any other design.
 */

interface Meta {
  key: string;
  name: string;
  category: string;
  category_label: string;
  description: string;
  subject: string;
  preheader: string;
  formal: 'du' | 'sie';
  service: boolean;
}

// One request per template and sub-account (the preview carries sample data of the sub-account).
const previews = new Map<string, Promise<any>>();
const htmlOf = new Map<string, string>();
const cacheKey = (key: string) => `${currentLocation()}:${key}`;
function loadPreview(key: string): Promise<any> {
  const k = cacheKey(key);
  let p = previews.get(k);
  if (!p) {
    p = api.get(`/api/email-gallery/${encodeURIComponent(key)}`).then((r) => (htmlOf.set(k, r.html), r));
    p.catch(() => previews.delete(k));
    previews.set(k, p);
  }
  return p;
}

/** The thumbnail loads when the card comes into view – sixty previews at once would be wasteful. */
function Thumb({ tkey, title }: { tkey: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(() => htmlOf.get(cacheKey(tkey)) ?? null);
  useEffect(() => {
    if (html !== null) return;
    const el = ref.current;
    let off = false;
    const go = () => void loadPreview(tkey).then((r) => !off && setHtml(r.html)).catch(() => !off && setHtml(''));
    if (!el || typeof IntersectionObserver === 'undefined') {
      go();
      return () => void (off = true);
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          go();
        }
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => {
      off = true;
      io.disconnect();
    };
  }, [tkey]);
  return (
    <div ref={ref} className={`eb-thumb${html === null ? ' wait' : ''}`} aria-hidden="true">
      {html ? <iframe title={title} srcDoc={html} sandbox="" tabIndex={-1} /> : null}
    </div>
  );
}

function DetailBody({ tkey, campaignId, onUsed, onDone }: { tkey: string; campaignId?: string; onUsed: () => void; onDone: () => void }) {
  const t = useT('campaigns');
  const r = useLoad(() => loadPreview(tkey), [tkey]);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [subject, setSubject] = useState(true);
  const [busy, setBusy] = useState(false);
  const tpl: (Meta & { html: string; text: string }) | undefined = r.data;
  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    const res = await act(fn, ok);
    setBusy(false);
    return res;
  };
  const asTemplate = async () => {
    if (await run(() => api.post(`/api/email-gallery/${encodeURIComponent(tkey)}/use`, { target: 'template' }), t('Als eigene Vorlage gespeichert (Kampagnen → Vorlagen)'))) onUsed();
  };
  const intoCampaign = async () => {
    if (!tpl) return;
    if (!confirmAsk(t('Der bisherige Inhalt der Kampagne wird durch diese Vorlage ersetzt. Fortfahren?'))) return;
    if (await run(() => api.post(`/api/email-gallery/${encodeURIComponent(tkey)}/use`, { campaign_id: campaignId, replace_subject: subject }), t('In die Kampagne übernommen'))) {
      onUsed();
      onDone();
    }
  };
  const newCampaign = async () => {
    if (!tpl) return;
    const c = await run(async () => {
      const made = await api.post('/api/campaigns', { name: tpl.name, subject: tpl.subject });
      await api.post(`/api/email-gallery/${encodeURIComponent(tkey)}/use`, { campaign_id: made.id });
      return made;
    }, t('Kampagne angelegt'));
    if (c) navigate(`campaigns/${c.id}`);
  };
  if (!tpl) return r.error ? <p className="muted">{r.error}</p> : <Spinner />;
  return (
    <>
      <div className="mk-prev">
        <div>
          <div className="mk-sub" role="group" aria-label={t('Vorschau-Größe')}>
            <button type="button" className={device === 'desktop' ? 'on' : ''} onClick={() => setDevice('desktop')}>
              {t('Computer')}
            </button>
            <button type="button" className={device === 'mobile' ? 'on' : ''} onClick={() => setDevice('mobile')}>
              {t('Smartphone')}
            </button>
          </div>
          <div className="mk-prev-frame">
            <iframe title={t('Vorschau {name}', { name: tpl.name })} srcDoc={tpl.html} sandbox="" style={{ width: device === 'mobile' ? 375 : 680 }} />
          </div>
        </div>
        <div className="mk-prev-side">
          <dl>
            <dt>{t('Kategorie')}</dt>
            <dd>{tpl.category_label}</dd>
            <dt>{t('Betreff')}</dt>
            <dd>{tpl.subject}</dd>
            <dt>{t('Vorschautext')}</dt>
            <dd>{tpl.preheader}</dd>
            <dt>{t('Anrede')}</dt>
            <dd>{tpl.formal === 'sie' ? t('Sie (förmlich)') : t('Du (persönlich)')}</dd>
          </dl>
          <p className="muted small" style={{ margin: 0 }}>{tpl.description}</p>
          {tpl.service && <p className="mk-note">{t('Service-Mail für bestehende Kundenbeziehungen (Rechnung, Bestellung) – keine Werbung. Werbliche Zusätze brauchen eine Einwilligung.')}</p>}
          <p className="muted small" style={{ margin: 0 }}>{t('Die Vorschau zeigt Beispieldaten. Platzhalter wie')} {'{{contact.first_name}}'} {t('werden beim Versand durch echte Werte ersetzt. Danach lässt sich alles im Designer ändern.')}</p>
          {campaignId && <Check checked={subject} onChange={setSubject} label={t('Betreff der Vorlage übernehmen')} />}
        </div>
      </div>
      <div className="mk-actions" style={{ marginTop: 12 }}>
        {campaignId ? (
          <button className="btn" disabled={busy} onClick={intoCampaign} data-tour="gallery-use">
            {t('In diese Kampagne übernehmen')}
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={newCampaign} data-tour="gallery-use">
            {t('Neue Kampagne damit anlegen')}
          </button>
        )}
        <button className="btn secondary" disabled={busy} onClick={asTemplate}>
          {t('Als eigene Vorlage speichern')}
        </button>
      </div>
    </>
  );
}

/** The gallery page (Kampagnen → Vorlagengalerie); with `campaignId` it applies a template to that campaign instead. */
export function EmailGallery({ campaignId, onUsed, onDone }: { campaignId?: string; onUsed?: () => void; onDone?: () => void }) {
  const t = useT('campaigns');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q, 300);
  const r = useLoad(() => api.get(`/api/email-gallery?q=${encodeURIComponent(dq)}&category=${encodeURIComponent(cat)}`), [dq, cat]);
  const cats: { key: string; label: string; description: string; count: number }[] = r.data?.categories ?? [];
  const list: Meta[] = r.data?.templates ?? [];
  const totalInSearch = cats.reduce((n, c) => n + c.count, 0);
  const picked = open ? list.find((x) => x.key === open) : undefined;
  // Inside a dialog (the campaign editor) the preview replaces the list – a second dialog on top would close together with the first on Esc.
  if (campaignId && open) {
    return (
      <div data-tour="gallery-page">
        <button type="button" className="btn secondary" onClick={() => setOpen(null)} style={{ marginBottom: 10, minHeight: 44 }}>
          {t('← Zurück zur Galerie')}
        </button>
        <h3 style={{ margin: '0 0 8px' }}>{picked?.name}</h3>
        <DetailBody tkey={open} campaignId={campaignId} onUsed={() => onUsed?.()} onDone={() => onDone?.()} />
      </div>
    );
  }
  return (
    <div data-tour="gallery-page">
      <div className="mk-gal-bar">
        <p className="muted mk-lead" style={{ margin: 0 }}>
          {r.data ? t('{n} fertige deutsche Vorlagen', { n: de(r.data.total) }) : t('Fertige deutsche Vorlagen')} {t('für Newsletter, Angebote, Events, Rechnungen und mehr – alle auch auf dem Smartphone gut lesbar. Vorlage anklicken, ansehen, übernehmen und im Designer anpassen.')}
        </p>
        <div className="mk-gal-search" data-tour="gallery-search">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('Suchen, z. B. Rabatt, Webinar, Mahnung, Ostern …')}
            aria-label={t('Vorlagen suchen')}
          />
        </div>
        <div className="mk-sub" data-tour="gallery-categories" role="group" aria-label={t('Kategorien')}>
          <button type="button" className={cat === '' ? 'on' : ''} onClick={() => setCat('')}>
            {t('Alle')} <span className="n">{totalInSearch || ''}</span>
          </button>
          {cats.map((c) => (
            <button key={c.key} type="button" className={cat === c.key ? 'on' : ''} disabled={c.count === 0 && cat !== c.key} onClick={() => setCat(cat === c.key ? '' : c.key)} title={c.description}>
              {c.label} <span className="n">{c.count}</span>
            </button>
          ))}
        </div>
      </div>
      {r.loading && !r.data ? (
        <Spinner />
      ) : list.length ? (
        <div className="mk-gal-grid" data-tour="gallery-grid">
          {list.map((x) => (
            <button key={x.key} type="button" className="mk-tpl" onClick={() => setOpen(x.key)} aria-label={t('{name} ansehen', { name: x.name })}>
              <Thumb tkey={x.key} title={x.name} />
              <strong>{x.name}</strong>
              <span className="muted small">{x.description}</span>
              <span className="tags">
                <Badge tone="gray">{x.category_label}</Badge>
                {x.formal === 'sie' && <Badge tone="blue">{t('Sie')}</Badge>}
                {x.service && <Badge tone="purple">{t('Service')}</Badge>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty>{t('Keine Vorlage gefunden. Versuche einen anderen Suchbegriff oder wähle „Alle“.')}</Empty>
      )}
      {open && !campaignId && (
        <Modal title={picked?.name ?? t('Vorlage')} onClose={() => setOpen(null)} wide className="mk-modal">
          <DetailBody tkey={open} onUsed={() => onUsed?.()} onDone={() => setOpen(null)} />
        </Modal>
      )}
    </div>
  );
}

/** The gallery inside a dialog, for the campaign editor ("Aus der Galerie wählen"). */
export function GalleryPicker({ campaignId, onClose, onUsed }: { campaignId: string; onClose: () => void; onUsed: () => void }) {
  const t = useT('campaigns');
  return (
    <Modal title={t('Vorlage aus der Galerie')} onClose={onClose} wide className="mk-modal">
      <EmailGallery campaignId={campaignId} onUsed={onUsed} onDone={onClose} />
    </Modal>
  );
}
