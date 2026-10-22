import { useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { Badge, Check, CodeBox, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../ui';

/**
 * Bewertungen → "Weitere Plattformen" (modules/review-sources.ts): connect Facebook, Trustpilot, ProvenExpert, Yelp, Tripadvisor or an
 * import source (CSV, RSS, web hook), see every platform's rating, and work through the reviews – AI draft, reply through the API
 * where the platform allows it, otherwise a link to reply on the platform. Rendered through the slot "reviews.panel".
 */

const stars = (n: number | null) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '');
const de = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function ConnectModal({ adapters, pages, onClose, onDone }: { adapters: any[]; pages: any[]; onClose: () => void; onDone: () => void }) {
  const t = useT('reviewsources');
  const [source, setSource] = useState(adapters[0]?.id ?? 'trustpilot');
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const a = adapters.find((x) => x.id === source);
  const save = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/review-sources', { source, ...f }));
    setBusy(false);
    if (!r) return;
    toast(r.sync?.error ? t('Verbunden – erster Abruf: {error}', { error: r.sync.error }) : t('Verbunden'));
    onDone();
  };
  return (
    <Modal
      title={t('Plattform verbinden')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={busy} onClick={save}>
          {busy ? t('Verbinde…') : t('Verbinden')}
        </button>
      }
    >
      <Field label={t('Plattform')}>
        <Select value={source} onChange={(v) => (setSource(v), setF({}))} options={adapters.map((x) => [x.id, t(x.label)] as [string, string])} />
      </Field>
      {a && <p className="muted small">{t(a.hint)}</p>}
      {a?.fields.map((fl: any) =>
        source === 'facebook' && fl.key === 'page_id' ? (
          <Field key={fl.key} label={t(fl.label)} hint={pages.length ? undefined : t('Erst unter Einstellungen → Kanäle eine Facebook-Seite verbinden.')}>
            <Select value={f.page_id ?? ''} onChange={(v) => setF({ ...f, page_id: v })} placeholder={t('Seite wählen…')} options={pages.map((p: any) => [p.page_id, p.page_name || p.page_id] as [string, string])} />
          </Field>
        ) : (
          <Field key={fl.key} label={`${t(fl.label)}${fl.required ? ' *' : ''}`} hint={fl.help ? t(fl.help) : undefined}>
            <Input type={fl.secret ? 'password' : 'text'} autoComplete={fl.secret ? 'new-password' : 'off'} value={f[fl.key] ?? ''} onChange={(v) => setF({ ...f, [fl.key]: v })} placeholder={fl.placeholder ? t(fl.placeholder) : undefined} />
          </Field>
        ),
      )}
    </Modal>
  );
}

function ImportModal({ conn, onClose, onDone }: { conn: any; onClose: () => void; onDone: () => void }) {
  const t = useT('reviewsources');
  const [csv, setCsv] = useState('');
  const [announce, setAnnounce] = useState(false);
  return (
    <Modal
      title={t('Bewertungen importieren – {platform}', { platform: conn.label })}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!csv.trim()} onClick={async () => (await act(() => api.post(`/api/review-sources/${conn.id}/import`, { csv, announce }), t('Importiert'))) && onDone()}>
          {t('Importieren')}
        </button>
      }
    >
      <p className="muted small">{t('CSV mit Kopfzeile: author, rating, text, date, link, id (auch deutsch: Name, Sterne, Kommentar, Datum).')}</p>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label={t('CSV-Datei wählen')}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) setCsv(await file.text());
        }}
      />
      <Field label={t('… oder hier einfügen')}>
        <Textarea value={csv} onChange={setCsv} rows={6} />
      </Field>
      <Check checked={announce} onChange={setAnnounce} label={t('Neue Bewertungen melden (Auslöser „Bewertung erhalten“)')} />
      {conn.hook_url && (
        <Field label={t('Web-Hook für automatische Lieferungen (POST, JSON)')}>
          <CodeBox text={conn.hook_url} />
        </Field>
      )}
    </Modal>
  );
}

function ReviewItem({ r, onChanged }: { r: any; onChanged: (x: any) => void }) {
  const t = useT('reviewsources');
  const [draft, setDraft] = useState<string>(r.reply_draft ?? '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const suggest = async () => {
    setBusy('ai');
    const res = await act(() => api.post(`/api/review-items/${r.id}/suggest-reply`, {}));
    setBusy('');
    if (res) (setDraft(res.text), setOpen(true), onChanged(res.item));
  };
  const reply = async () => {
    setBusy('reply');
    const res = await act(() => api.post(`/api/review-items/${r.id}/reply`, { text: draft }), t('Antwort veröffentlicht'));
    setBusy('');
    if (res) (onChanged(res), setOpen(false));
  };
  return (
    <div className="review-item card" style={{ padding: 14, marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span>
          <Badge tone="blue">{r.platform}</Badge> <span className="g-stars" aria-label={r.rating ? t('{n} von 5 Sternen', { n: r.rating }) : undefined}>{stars(r.rating)}</span> <strong>{r.author}</strong>
        </span>
        <span className="muted small">{dt(r.published_at || r.first_seen_at)}</span>
      </div>
      {r.title && <strong>{r.title}</strong>}
      <p style={{ margin: '6px 0' }}>{r.text || <span className="muted">{t('(nur Sterne)')}</span>}</p>
      {r.reply_text && (
        <p className="muted small">
          <Icon name="send" size={12} /> {r.reply_text}
        </p>
      )}
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        {!r.reply_text && (
          <button className="btn small secondary ai-btn" disabled={!!busy} onClick={suggest}>
            <Icon name="sparkles" size={14} /> {busy === 'ai' ? t('Schreibe…') : t('KI-Antwort vorschlagen')}
          </button>
        )}
        {!r.reply_text && !open && (
          <button className="btn small secondary" onClick={() => setOpen(true)}>
            {t('Antworten')}
          </button>
        )}
        {r.link && (
          <a className="btn small secondary" href={r.link} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={14} /> {t('Ansehen')}
          </a>
        )}
      </div>
      {open && !r.reply_text && (
        <div style={{ marginTop: 8 }}>
          <Textarea value={draft} onChange={setDraft} rows={4} aria-label={t('Antwort')} />
          <div className="actions">
            {r.can_reply ? (
              <button className="btn small" disabled={!draft.trim() || !!busy} onClick={reply}>
                {t('Öffentlich antworten')}
              </button>
            ) : (
              <>
                <button className="btn small secondary" disabled={!draft.trim()} onClick={async () => (await act(() => api.put(`/api/review-items/${r.id}/reply-draft`, { text: draft }), t('Entwurf gespeichert'))) && onChanged({ ...r, reply_draft: draft })}>
                  {t('Entwurf speichern')}
                </button>
                {r.reply_link && (
                  <a
                    className="btn small"
                    href={r.reply_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => void navigator.clipboard?.writeText(draft).then(() => toast(t('Text kopiert – auf der Plattform einfügen')), () => undefined)}
                  >
                    <Icon name="external" size={14} /> {t('Auf {platform} antworten', { platform: r.platform })}
                  </a>
                )}
              </>
            )}
          </div>
          {!r.can_reply && <p className="muted small">{t('Diese Plattform erlaubt keine Antwort über ihre API – der Text wird kopiert, die Plattform öffnet sich.')}</p>}
        </div>
      )}
    </div>
  );
}

export function ReviewSourcesPanel() {
  const t = useT('reviewsources');
  const src = useLoad(() => api.get('/api/review-sources').catch(() => null), []);
  const [filter, setFilter] = useState('');
  const items = useLoad(() => api.get(`/api/review-items?limit=100${filter ? `&connection_id=${encodeURIComponent(filter)}` : ''}`).catch(() => null), [filter]);
  const [modal, setModal] = useState<'' | 'connect'>('');
  const [importing, setImporting] = useState<any>(null);
  if (!src.data) return null;
  const { adapters, connections, facebook_pages } = src.data;
  const reload = () => (src.reload(), items.reload());
  const platforms = (items.data?.summary?.platforms ?? []) as any[];
  return (
    <div className="card review-sources" data-tour="review-sources">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <Icon name="reviews" size={18} /> {t('Weitere Plattformen')}
        </h2>
        <button className="btn small" onClick={() => setModal('connect')}>
          + {t('Plattform verbinden')}
        </button>
      </div>
      {platforms.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, margin: '10px 0' }} aria-label={t('Bewertung je Plattform')}>
          {items.data.summary.overall && (
            <Badge tone="green">
              {t('Gesamt')}: {de(items.data.summary.overall.rating)} ★ · {items.data.summary.overall.total}
            </Badge>
          )}
          {platforms.map((p) => (
            <Badge key={`${p.source}-${p.label}`}>
              {t(p.label)}: {p.rating != null ? `${de(p.rating)} ★` : '–'} ({p.total})
            </Badge>
          ))}
        </div>
      )}
      {connections.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Plattform')}</th>
                <th>{t('Bewertung')}</th>
                <th>{t('Antworten')}</th>
                <th>{t('Stand')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connections.map((c: any) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.label}</strong> {c.name && <span className="muted small">{c.name}</span>}
                    {!c.enabled && <Badge>{t('aus')}</Badge>}
                  </td>
                  <td>{c.rating != null ? `${de(c.rating)} ★ (${c.total ?? 0})` : '–'}</td>
                  <td>{c.can_reply ? <Badge tone="green">{t('über die API')}</Badge> : <span className="muted small">{t('auf der Plattform')}</span>}</td>
                  <td className="muted small">
                    {c.last_sync_at ? dt(c.last_sync_at) : '–'}
                    {c.last_error && <div style={{ color: 'var(--red)' }}>{c.last_error}</div>}
                  </td>
                  <td>
                    <div className="actions" style={{ justifyContent: 'flex-end' }}>
                      {c.kind === 'import' && (
                        <button className="btn small secondary" onClick={() => setImporting(c)}>
                          {t('Import')}
                        </button>
                      )}
                      {(c.kind === 'api' || c.config?.rss_url) && (
                        <button className="btn small secondary" aria-label={t('{platform} jetzt abrufen', { platform: c.label })} onClick={async () => (await act(() => api.post(`/api/review-sources/${c.id}/sync`), t('Abgerufen'))) && reload()}>
                          <Icon name="refresh" size={14} />
                        </button>
                      )}
                      <button className="btn small secondary" aria-label={c.enabled ? t('{platform} pausieren', { platform: c.label }) : t('{platform} einschalten', { platform: c.label })} onClick={async () => (await act(() => api.patch(`/api/review-sources/${c.id}`, { enabled: !c.enabled }))) && reload()}>
                        <Icon name={c.enabled ? 'pause' : 'play'} size={14} />
                      </button>
                      <button className="btn small secondary" aria-label={t('{platform} trennen', { platform: c.label })} onClick={async () => confirmAsk(t('{platform} trennen? Die gespeicherten Bewertungen werden gelöscht.', { platform: c.label })) && (await act(() => api.del(`/api/review-sources/${c.id}`))) && reload()}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{t('Trustpilot, Facebook, ProvenExpert, Yelp, Tripadvisor – oder Jameda, Kununu & Co. per Import: alle Bewertungen an einem Ort, mit KI-Antwortentwürfen.')}</p>
      )}
      {connections.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <h3 style={{ margin: 0 }}>{t('Bewertungen')}</h3>
            <span style={{ width: 220 }}>
              <Select value={filter} onChange={setFilter} aria={t('Plattform filtern')} options={[['', t('Alle Plattformen')], ...connections.map((c: any) => [c.id, c.label] as [string, string])]} />
            </span>
          </div>
          {!items.data ? (
            <Spinner />
          ) : items.data.items.length ? (
            items.data.items.map((r: any) => <ReviewItem key={r.id} r={r} onChanged={(x) => items.setData({ ...items.data, items: items.data.items.map((y: any) => (y.id === x.id ? { ...y, ...x } : y)) })} />)
          ) : (
            <Empty>{t('Noch keine Bewertungen gespeichert.')}</Empty>
          )}
        </>
      )}
      {modal === 'connect' && <ConnectModal adapters={adapters} pages={facebook_pages} onClose={() => setModal('')} onDone={() => (setModal(''), reload())} />}
      {importing && <ImportModal conn={importing} onClose={() => setImporting(null)} onDone={() => (setImporting(null), reload())} />}
    </div>
  );
}
