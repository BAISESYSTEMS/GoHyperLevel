import { useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { Badge, Check, Input, Textarea, act, useLoad } from '../ui';

/**
 * Social comments in Konversationen (modules/social-comments.ts): under each comment the public reply (with an AI suggestion) and
 * hide/show – slot "inbox.message"; and the card under Einstellungen → Kanäle that says which platforms are read – slot
 * "channels.meta".
 */

export function CommentActions({ message, onChanged }: { message: any; onChanged: () => void }) {
  const t = useT('socialcomments');
  const c = message.comment;
  const [text, setText] = useState<string>(c?.suggestion ?? '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  if (!c) return null;
  const run = async (what: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(what);
    const r = await act(fn, ok);
    setBusy('');
    return r;
  };
  return (
    <div className="comment-actions" data-tour="inbox-comment">
      <div className="muted small">
        {c.platform_label}
        {c.hidden && (
          <>
            {' · '}
            <Badge tone="yellow">{t('ausgeblendet')}</Badge>
          </>
        )}
        {c.permalink && (
          <>
            {' · '}
            <a href={c.permalink} target="_blank" rel="noopener noreferrer">
              {t('Beitrag öffnen')}
            </a>
          </>
        )}
      </div>
      {c.reply ? (
        <div className="muted small">
          <Icon name="send" size={12} /> {t('Öffentlich beantwortet {when}', { when: dt(c.replied_at) })}
        </div>
      ) : open ? (
        <div style={{ marginTop: 6 }}>
          <Textarea value={text} onChange={setText} rows={3} maxLength={c.limit} aria-label={t('Öffentliche Antwort')} placeholder={t('Öffentliche Antwort unter dem Kommentar …')} />
          <div className="actions">
            <button
              className="btn small"
              disabled={!text.trim() || !!busy}
              onClick={async () => {
                if (await run('reply', () => api.post(`/api/social-comments/${c.id}/reply`, { text }), t('Antwort veröffentlicht'))) (setOpen(false), onChanged());
              }}
            >
              {busy === 'reply' ? t('Sende…') : t('Öffentlich antworten')}
            </button>
            <button className="btn small secondary" onClick={() => setOpen(false)}>
              {t('Abbrechen')}
            </button>
            <small className="muted">
              {text.length} / {c.limit}
            </small>
          </div>
        </div>
      ) : null}
      <div className="actions" style={{ marginTop: 4, flexWrap: 'wrap' }}>
        {!c.reply && !open && (
          <button className="btn small secondary" onClick={() => setOpen(true)}>
            {t('Antworten')}
          </button>
        )}
        {!c.reply && (
          <button
            className="btn small secondary ai-btn"
            disabled={!!busy}
            onClick={async () => {
              const r = await run('ai', () => api.post(`/api/social-comments/${c.id}/suggest`, {}));
              if (r) (setText(r.text), setOpen(true));
            }}
          >
            <Icon name="sparkles" size={14} /> {busy === 'ai' ? t('Schreibe…') : t('KI-Vorschlag')}
          </button>
        )}
        {c.can_hide && (
          <button className="btn small secondary" disabled={!!busy} onClick={async () => (await run('hide', () => api.post(`/api/social-comments/${c.id}/hide`, { hidden: !c.hidden }), c.hidden ? t('Wieder sichtbar') : t('Ausgeblendet'))) && onChanged()}>
            <Icon name={c.hidden ? 'eye' : 'eyeOff'} size={14} /> {c.hidden ? t('Einblenden') : t('Ausblenden')}
          </button>
        )}
      </div>
    </div>
  );
}

export function SocialCommentsSettings() {
  const t = useT('socialcomments');
  const s = useLoad(() => api.get('/api/social-comments/settings').catch(() => null), []);
  const [org, setOrg] = useState<string | null>(null);
  if (!s.data) return null;
  const d = s.data;
  const save = async (patch: Record<string, unknown>) => {
    const r = await act(() => api.put('/api/social-comments/settings', patch), t('Gespeichert'));
    if (r) s.setData(r);
  };
  const src = d.sources;
  return (
    <div className="card" data-tour="social-comments-settings">
      <h2>
        <Icon name="quote" size={18} /> {t('Kommentare im Posteingang')}
      </h2>
      <p className="muted small">{t('Kommentare unter euren Beiträgen landen als Kanal „Kommentare“ in Konversationen – mit öffentlicher Antwort, Ausblenden und KI-Vorschlag.')}</p>
      <Check checked={d.meta} onChange={(v) => save({ meta: v })} label={t('Facebook und Instagram (Meta-Webhook: Seite „feed“, Instagram „comments“)')} />
      <div className="muted small" style={{ marginLeft: 26 }}>
        {src.facebook.available || src.instagram.available ? [...src.facebook.accounts, ...src.instagram.accounts].join(' · ') : t('Erst oben eine Seite verbinden.')}
      </div>
      <Check checked={d.youtube} onChange={(v) => save({ youtube: v })} label={t('YouTube (über eine Nango-Verbindung, alle 15 Minuten)')} />
      {!src.youtube.available && <div className="muted small" style={{ marginLeft: 26 }}>{t('Keine aktive YouTube-Verbindung unter Apps → Nango.')}</div>}
      <Check checked={d.linkedin} onChange={(v) => save({ linkedin: v, linkedin_org: org ?? d.linkedin_org })} label={t('LinkedIn-Unternehmensseite (über Nango, alle 15 Minuten)')} />
      <div style={{ marginLeft: 26, maxWidth: 360 }}>
        <Input value={org ?? d.linkedin_org} onChange={setOrg} onBlur={() => org !== null && org !== d.linkedin_org && save({ linkedin_org: org })} placeholder={t('Organisations-ID, z. B. 12345678')} aria-label={t('LinkedIn-Organisation')} />
        {!src.linkedin.available && <div className="muted small">{t('Keine aktive LinkedIn-Verbindung unter Apps → Nango.')}</div>}
      </div>
      {(d.last_poll_at || d.last_error) && (
        <p className="muted small">
          {d.last_poll_at && t('Zuletzt abgerufen {when}', { when: dt(d.last_poll_at) })}
          {d.last_error && <span style={{ color: 'var(--red)' }}> · {d.last_error}</span>}
        </p>
      )}
    </div>
  );
}
