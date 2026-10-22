import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Badge, Check, Field, Input, Modal, Textarea, act, confirmAsk, toast, useLoad } from '../ui';

/**
 * Bewertungen → Video-Testimonials (modules/video-testimonials.ts, docs/reputation.md#video-testimonials; slot "reviews.panel"):
 * the collect page's link, the incoming videos (play, approve, reject, delete) and the embed code of the video wall.
 */

export function VideoTestimonialsPanel() {
  const t = useT('gaps');
  const data = useLoad(() => api.get<any>('/api/video-testimonials').catch(() => null), []);
  const [play, setPlay] = useState<any>(null);
  const [page, setPage] = useState<any>(null);
  if (!data.data) return null;
  const { page: p, items } = data.data;
  const status = async (id: string, s: string) => (await act(() => api.patch(`/api/video-testimonials/${id}`, { status: s }))) && data.reload();
  const label: Record<string, string> = { pending: t('neu'), approved: t('freigegeben'), rejected: t('abgelehnt') };
  const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast(t('Kopiert')));
  const embed = `<iframe src="${p.wall_url}" style="width:100%;min-height:480px;border:0" title="Kundenstimmen" loading="lazy"></iframe>`; // i18n-ignore
  return (
    <div className="card" data-tour="video-testimonials">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('Video-Testimonials')}</h2>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small secondary" onClick={() => copy(p.url)}>
            {t('Link zur Sammelseite kopieren')}
          </button>
          <button className="btn small secondary" onClick={() => setPage({ ...p })}>
            {t('Seite anpassen')}
          </button>
        </div>
      </div>
      <p className="muted small">
        {t('Kunden nehmen auf ihrem Handy ein kurzes Video auf. Erst nach deiner Freigabe erscheint es auf der Video-Wand.')}{' '}
        {!p.active && <Badge tone="yellow">{t('Sammelseite aus')}</Badge>}
      </p>
      {items.length === 0 ? (
        <p className="muted small">{t('Noch keine Videos – schick den Link nach einem erfolgreichen Auftrag.')}</p>
      ) : (
        <table className="t">
          <tbody>
            {items.map((v: any) => (
              <tr key={v.id}>
                <td>
                  <strong>{v.name}</strong> <Badge tone={v.status === 'approved' ? 'green' : v.status === 'rejected' ? 'red' : 'yellow'}>{label[v.status] ?? v.status}</Badge>
                  {v.text && <div className="small">{v.text}</div>}
                  <div className="muted small">
                    {dt(v.created_at)} · {(v.size / 1048576).toFixed(1)} MB
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="actions" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small secondary" onClick={() => setPlay(v)}>
                      ▶ {t('Ansehen')}
                    </button>
                    {v.status !== 'approved' && (
                      <button className="btn small" onClick={() => status(v.id, 'approved')}>
                        {t('Freigeben')}
                      </button>
                    )}
                    {v.status !== 'rejected' && (
                      <button className="btn small secondary" onClick={() => status(v.id, 'rejected')}>
                        {t('Ablehnen')}
                      </button>
                    )}
                    <button className="btn small secondary" aria-label={t('Video löschen')} onClick={async () => confirmAsk(t('Video von {n} endgültig löschen?', { n: v.name })) && (await act(() => api.del(`/api/video-testimonials/${v.id}`))) && data.reload()}>
                      ✕
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <MoreFields id="video-testimonials-embed" label={t('Video-Wand einbinden')}>
        <p className="small muted">{t('Zeigt alle freigegebenen Videos – als iframe auf jeder Website.')}</p>
        <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{embed}</pre>
        <button className="btn small secondary" onClick={() => copy(embed)}>
          {t('Code kopieren')}
        </button>
      </MoreFields>
      {play && (
        <Modal title={play.name} onClose={() => setPlay(null)}>
          <video controls autoPlay playsInline src={play.video_url} style={{ width: '100%', borderRadius: 8, background: '#000' }} />
          {play.email && <p className="small muted">{play.email}</p>}
        </Modal>
      )}
      {page && (
        <Modal
          title={t('Sammelseite anpassen')}
          onClose={() => setPage(null)}
          footer={
            <button className="btn" onClick={async () => (await act(() => api.put('/api/video-testimonials/page', { title: page.title, intro: page.intro, thank_you: page.thank_you, active: page.active }), t('Gespeichert'))) && (setPage(null), data.reload())}>
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Überschrift')}>
            <Input value={page.title} onChange={(v) => setPage({ ...page, title: v })} />
          </Field>
          <Field label={t('Einleitung')}>
            <Textarea rows={3} value={page.intro} onChange={(v) => setPage({ ...page, intro: v })} />
          </Field>
          <MoreFields id="video-testimonials-page" values={[page.thank_you]}>
            <Field label={t('Danke-Text')}>
              <Input value={page.thank_you} onChange={(v) => setPage({ ...page, thank_you: v })} />
            </Field>
          </MoreFields>
          <Check checked={page.active} onChange={(v) => setPage({ ...page, active: v })} label={t('Sammelseite nimmt Videos an')} />
        </Modal>
      )}
    </div>
  );
}
