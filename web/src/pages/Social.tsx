import { lazy, Suspense, useMemo, useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { act, Badge, confirmAsk, Empty, Field, Modal, navigate, PageHead, pressable, Select, Spinner, Stat, Tabs, Textarea, toast, useLoad } from '../ui';
import { SignupLink } from '../referrals';
import { GenImageButton } from './GenMediaKit';
import { getLocale, intlLocale, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { SortableGrid } from '../sortable/Sortable';

// Client approval by magic link and evergreen categories load as their own chunk (docs/social-planner.md).
const SocialExtras = lazy(() => import('./SocialExtras').then((m) => ({ default: m.SocialExtras })));

const ICONS: Record<string, string> = { x: '𝕏', linkedin: 'in', 'linkedin-page': 'in', facebook: 'f', instagram: '📷', 'instagram-standalone': '📷', youtube: '▶', tiktok: '♪', threads: '@', bluesky: '🦋', mastodon: '🐘', telegram: '✈', gmb: 'G', listmonk: '✉', pinterest: 'P' };
// German labels (message ids of the social catalog), shown through t()
const STATE: Record<string, [string, any]> = { QUEUE: ['geplant', 'blue'], PUBLISHED: ['veröffentlicht', 'green'], ERROR: ['Fehler', 'red'], DRAFT: ['Entwurf', 'gray'] };
// German labels (message ids of the social catalog), shown through t()
const CONNECT_LABELS: Record<string, string> = { x: 'X (Twitter)', linkedin: 'LinkedIn (Profil)', 'linkedin-page': 'LinkedIn-Seite', facebook: 'Facebook-Seite', instagram: 'Instagram (über Facebook)', 'instagram-standalone': 'Instagram', threads: 'Threads', youtube: 'YouTube', tiktok: 'TikTok', pinterest: 'Pinterest', gmb: 'Google Unternehmensprofil' };

export function ChannelAvatar({ c, size = 26 }: { c: any; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="social-avatar" style={{ width: size, height: size }} title={c.name}>
      {c.picture && !broken ? <img src={c.picture} alt="" onError={() => setBroken(true)} /> : null}
      <span className="social-badge">{ICONS[c.identifier ?? c.providerIdentifier] ?? '•'}</span>
    </span>
  );
}

/** "12,5 %" in German (as before), "12.5%" in English. */
const dec = (n: string) => (getLocale() === SOURCE_LOCALE ? n.replace('.', ',') : n);
const percent = (n: string) => (getLocale() === SOURCE_LOCALE ? `${n} %` : `${n}%`);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localInput = (d: Date) => `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const time = (s: string) => new Date(s).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });

export function Social({ tab = 'calendar' }: { tab?: string }) {
  const t = useT('social');
  const session = useSession();
  const info = useLoad(() => api.get<any>('/api/social'), []);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const range = useMemo(() => {
    const start = new Date(month);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(end.getDate() + 42);
    return { start, end };
  }, [month]);
  const [refresh, setRefresh] = useState(0);
  const posts = useLoad(
    () => (info.data?.configured && info.data.channels.length ? api.get<any[]>(`/api/social/posts?from=${range.start.toISOString()}&to=${range.end.toISOString()}${refresh ? '&refresh=1' : ''}`) : Promise.resolve([])),
    [range.start.getTime(), info.data, refresh],
  );
  const [compose, setCompose] = useState<null | { date?: Date }>(null);
  const [open, setOpen] = useState<any>(null);
  const [connect, setConnect] = useState(false);
  if (!info.data) return <Spinner />;
  const s = info.data;
  const admin = session.user.role === 'admin';
  if (!s.configured)
    return (
      <>
        <PageHead title="Social Planner" />
        <Empty action={admin ? <button className="btn" onClick={() => navigate('agency/integrations')}>{t('Jetzt verbinden')}</button> : undefined}>
          {admin ? t('Verbinde zuerst deine Postiz-Instanz unter Agentur → Integrationen.') : t('Der Social Planner ist noch nicht eingerichtet – deine Agentur schaltet ihn frei.')} {admin && <SignupLink id="postiz" />}
        </Empty>
      </>
    );
  const reload = () => (setRefresh((n) => n + 1), info.reload());
  return (
    <>
      <PageHead title="Social Planner" sub={t('Posts für alle Kanäle planen – an einem Ort')}>
        <button className="btn secondary" data-tour="social-connect" onClick={() => setConnect(true)}>
          {t('+ Kanal verbinden')}
        </button>
        {s.postiz_url && (
          <a className="btn secondary" href={s.postiz_url} target="_blank" rel="noreferrer">
            {t('Postiz öffnen')}
          </a>
        )}
        <button className="btn" data-tour="social-new" disabled={!s.channels.length} onClick={() => setCompose({})}>
          {t('+ Neuer Post')}
        </button>
      </PageHead>
      {!s.channels.length ? (
        <Empty action={<button className="btn" onClick={() => setConnect(true)}>{t('Kanal verbinden')}</button>}>{t('Noch keine Kanäle für diesen Sub-Account.')}</Empty>
      ) : (
        <>
          <div className="social-channels" data-tour="social-channels">
            {s.channels.map((c: any) => (
              <span key={c.id} className="social-chip">
                <ChannelAvatar c={c} /> {c.name} <span className="muted small">{c.label}</span>
              </span>
            ))}
          </div>
          <Tabs tabs={[['calendar', t('Kalender')], ['list', t('Liste')], ['stats', t('Statistik')], ['approvals', t('Freigaben')], ['evergreen', t('Evergreen')]]} value={tab} onChange={(tab2) => navigate(`social/${tab2}`)} />
          {tab === 'stats' ? (
            <SocialStats channels={s.channels} />
          ) : tab === 'approvals' || tab === 'evergreen' ? (
            <Suspense fallback={<Spinner />}>
              <SocialExtras tab={tab} channels={s.channels} />
            </Suspense>
          ) : !posts.data ? (
            <Spinner />
          ) : tab === 'list' ? (
            <PostList posts={posts.data} onOpen={setOpen} />
          ) : (
            <MonthGrid month={month} setMonth={setMonth} start={range.start} posts={posts.data} onOpen={setOpen} onDay={(d) => setCompose({ date: d })} />
          )}
        </>
      )}
      {compose && (
        <Composer
          channels={s.channels}
          date={compose.date}
          onClose={() => setCompose(null)}
          onDone={() => {
            setCompose(null);
            reload();
          }}
        />
      )}
      {open && (
        <PostModal
          post={open}
          onClose={() => setOpen(null)}
          onDeleted={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
      {connect && <ConnectModal connectable={s.connectable} onClose={() => (setConnect(false), info.reload())} />}
    </>
  );
}

function MonthGrid({ month, setMonth, start, posts, onOpen, onDay }: { month: Date; setMonth: (d: Date) => void; start: Date; posts: any[]; onOpen: (p: any) => void; onDay: (d: Date) => void }) {
  const t = useT('social');
  const byDay = new Map<string, any[]>();
  for (const p of posts) {
    const k = ymd(new Date(p.publishDate));
    byDay.set(k, [...(byDay.get(k) ?? []), p]);
  }
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const today = ymd(new Date());
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button className="btn small secondary" onClick={() => shift(-1)} aria-label={t('Vorheriger Monat')}>
          ‹
        </button>
        <strong>{month.toLocaleDateString(intlLocale(), { month: 'long', year: 'numeric' })}</strong>
        <button className="btn small secondary" onClick={() => shift(1)} aria-label={t('Nächster Monat')}>
          ›
        </button>
      </div>
      <div className="social-month">
        {[t('Mo'), t('Di'), t('Mi'), t('Do'), t('Fr'), t('Sa'), t('So')].map((w) => (
          <div key={w} className="social-wd">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const k = ymd(d);
          const list = byDay.get(k) ?? [];
          const past = k < today;
          return (
            <div
              key={k}
              className={`social-day${d.getMonth() !== month.getMonth() ? ' other' : ''}${k === today ? ' today' : ''}`}
              {...pressable(() => {
                if (past) return;
                const at = new Date(d);
                at.setHours(10, 0, 0, 0);
                if (at.getTime() < Date.now()) at.setTime(Date.now() + 3600_000);
                onDay(at);
              })}
              title={past ? undefined : t('Klicken für neuen Post')}
            >
              <span className="social-date">{d.getDate()}</span>
              {list.slice(0, 4).map((p) => (
                <button
                  key={p.id}
                  className={`social-post s-${p.state}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(p);
                  }}
                >
                  <ChannelAvatar c={p.integration} size={16} /> {time(p.publishDate)} {p.content.slice(0, 40)}
                </button>
              ))}
              {list.length > 4 && <span className="muted small">+{list.length - 4} {t('weitere')}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PostList({ posts, onOpen }: { posts: any[]; onOpen: (p: any) => void }) {
  const t = useT('social');
  if (!posts.length) return <Empty>{t('In diesem Zeitraum sind keine Posts geplant.')}</Empty>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>{t('Wann')}</th>
            <th>{t('Kanal')}</th>
            <th>{t('Text')}</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} className="click" {...pressable(() => onOpen(p))}>
              <td className="muted">{new Date(p.publishDate).toLocaleString(intlLocale(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
              <td>
                <ChannelAvatar c={p.integration} /> {p.integration?.name}
              </td>
              <td>{p.content.slice(0, 120)}</td>
              <td>
                <Badge tone={STATE[p.state]?.[1]}>{STATE[p.state] ? t(STATE[p.state][0]) : p.state}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PostModal({ post, onClose, onDeleted }: { post: any; onClose: () => void; onDeleted: () => void }) {
  const t = useT('social');
  return (
    <Modal
      title={`${post.integration?.name ?? t('Post')} · ${new Date(post.publishDate).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })}`}
      onClose={onClose}
      footer={
        <>
          {post.releaseURL && (
            <a className="btn secondary" href={post.releaseURL} target="_blank" rel="noreferrer">
              {t('Ansehen')}
            </a>
          )}
          {post.state !== 'PUBLISHED' && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirmAsk(t('Post löschen?'))) return;
                const r = await act(() => api.del(`/api/social/posts/${post.id}?date=${encodeURIComponent(post.publishDate)}`), t('Gelöscht'));
                if (r) onDeleted();
              }}
            >
              {t('Löschen')}
            </button>
          )}
        </>
      }
    >
      <p>
        <Badge tone={STATE[post.state]?.[1]}>{STATE[post.state] ? t(STATE[post.state][0]) : post.state}</Badge>
      </p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{post.content}</p>
    </Modal>
  );
}

function Composer({ channels, date, onClose, onDone }: { channels: any[]; date?: Date; onClose: () => void; onDone: () => void }) {
  const t = useT('social');
  const usable = channels.filter((c) => c.supported && !c.disabled);
  const [sel, setSel] = useState<string[]>(usable.map((c) => c.id).slice(0, 1));
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'schedule' | 'now' | 'draft'>('schedule');
  const [when, setWhen] = useState(() => {
    if (date) return localInput(date);
    const d = new Date(Date.now() + 864e5);
    d.setHours(10, 0, 0, 0);
    return localInput(d);
  });
  const [images, setImages] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const chosen = usable.filter((c) => sel.includes(c.id));
  const limit = chosen.reduce((m, c) => (c.limit && c.limit < m.limit ? { limit: c.limit, label: c.label } : m), { limit: Infinity, label: '' });
  const tooLong = text.length > limit.limit;
  const upload = async (files: FileList) => {
    for (const file of [...files].slice(0, 4 - images.length)) {
      const data = await new Promise<string>((r) => {
        const fr = new FileReader();
        fr.onload = () => r(String(fr.result));
        fr.readAsDataURL(file);
      });
      const res = await act(() => api.post('/api/uploads', { name: file.name, data }));
      if (res) setImages((l) => [...l, res]);
    }
  };
  const submit = async () => {
    if (mode === 'now' && !confirmAsk(t('Jetzt auf {channels} veröffentlichen?', { channels: chosen.map((c) => c.name).join(', ') }))) return;
    setBusy(true);
    const r = await act(() => api.post('/api/social/posts', { integration_ids: sel, content: text, type: mode, date: new Date(when).toISOString(), upload_ids: images.map((i) => i.id) }));
    setBusy(false);
    if (r) {
      toast(mode === 'now' ? t('Wird veröffentlicht') : mode === 'draft' ? t('Entwurf gespeichert') : t('Geplant'));
      onDone();
    }
  };
  return (
    <Modal
      title={t('Neuer Post')}
      wide
      onClose={onClose}
      footer={
        <button className="btn" disabled={busy || !sel.length || !text.trim() || tooLong} onClick={submit}>
          {mode === 'now' ? t('Jetzt veröffentlichen') : mode === 'draft' ? t('Als Entwurf speichern') : t('Planen')}
        </button>
      }
    >
      <Field label={t('Kanäle')}>
        <div className="social-pick">
          {channels.map((c) => {
            const ok = c.supported && !c.disabled;
            const on = sel.includes(c.id);
            return (
              <button key={c.id} type="button" disabled={!ok} className={`social-chip pick${on ? ' on' : ''}`} onClick={() => setSel(on ? sel.filter((x) => x !== c.id) : [...sel, c.id])} title={ok ? c.label : t('Diese Plattform bitte direkt in Postiz planen')}>
                <ChannelAvatar c={c} /> {c.name}
                {!ok && <span className="muted small"> {t('(nur in Postiz)')}</span>}
              </button>
            );
          })}
        </div>
      </Field>
      <Field label={t('Text')} hint={<span style={{ color: tooLong ? 'var(--red)' : undefined }}>{text.length}{Number.isFinite(limit.limit) ? t(' / {limit} Zeichen ({channel})', { limit: limit.limit, channel: limit.label }) : t(' Zeichen')}</span>}>
        <Textarea value={text} onChange={setText} rows={6} placeholder={t('Was gibt\'s Neues?')} autoFocus />
      </Field>
      <Field label={t('Bilder (max. 4)')}>
        <div className="row" style={{ alignItems: 'center' }}>
          {images.map((img) => (
            <span key={img.id} className="social-thumb">
              <img src={img.url} alt="" />
              <button type="button" aria-label={t('Bild entfernen')} onClick={() => setImages(images.filter((i) => i.id !== img.id))}>
                ✕
              </button>
            </span>
          ))}
          {images.length < 4 && <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(e) => e.target.files && upload(e.target.files)} />}
          {images.length < 4 && <GenImageButton aspect="1:1" onPick={(u) => setImages((l) => [...l, u])} />}
        </div>
      </Field>
      <div className="grid2">
        <Field label={t('Wann')}>
          <Select value={mode} onChange={(v) => setMode(v as any)} options={[['schedule', t('Planen')], ['now', t('Sofort veröffentlichen')], ['draft', t('Als Entwurf (in Postiz freigeben)')]]} />
        </Field>
        {mode === 'schedule' && (
          <Field label={t('Zeitpunkt')}>
            <input type="datetime-local" value={when} min={localInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function SocialStats({ channels }: { channels: any[] }) {
  const t = useT('social');
  const [ch, setCh] = useState(channels[0]?.id ?? '');
  const [days, setDays] = useState('30');
  const stats = useLoad(() => (ch ? api.get<any[]>(`/api/social/analytics/${ch}?days=${days}`) : Promise.resolve([])), [ch, days]);
  return (
    <>
      <div className="row" style={{ maxWidth: 520, marginBottom: 12 }}>
        <Select value={ch} onChange={setCh} options={channels.map((c) => [c.id, `${c.name} (${c.label})`])} />
        <Select value={days} onChange={setDays} options={[['7', t('Letzte 7 Tage')], ['30', t('Letzte 30 Tage')], ['90', t('Letzte 90 Tage')]]} />
      </div>
      {stats.loading && !stats.data ? (
        <Spinner />
      ) : stats.error ? (
        <Empty>{String(stats.error)}</Empty>
      ) : !stats.data?.length ? (
        <Empty>{t('Für diesen Kanal liefert die Plattform keine Statistik.')}</Empty>
      ) : (
        <SortableGrid id="social.stats" className="stats">
          {stats.data.map((m: any) => {
            const last = m.data?.[m.data.length - 1]?.total ?? '–';
            const ch = Number(m.percentageChange);
            return <Stat key={m.label} label={m.label} value={Number.isFinite(Number(last)) ? Number(last).toLocaleString(intlLocale()) : last} sub={Number.isFinite(ch) ? t('{change} im Zeitraum', { change: `${ch > 0 ? '+' : ''}${percent(dec(ch.toFixed(1)))}` }) : undefined} />;
          })}
        </SortableGrid>
      )}
    </>
  );
}

function ConnectModal({ connectable, onClose }: { connectable: string[]; onClose: () => void }) {
  const t = useT('social');
  const [p, setP] = useState(connectable[0]);
  return (
    <Modal
      title={t('Kanal verbinden')}
      onClose={onClose}
      footer={
        <button
          className="btn"
          onClick={async () => {
            const r = await act(() => api.post(`/api/social/connect/${p}`));
            if (r?.url) {
              window.open(r.url, '_blank', 'noopener');
              toast(t('Im neuen Tab anmelden – danach erscheint der Kanal hier'));
            }
          }}
        >
          {t('Weiter zur Anmeldung')}
        </button>
      }
    >
      <Field label={t('Plattform')} hint={t('Du meldest dich direkt bei der Plattform an. Der neue Kanal gehört danach automatisch zu diesem Sub-Account.')}>
        <Select value={p} onChange={setP} options={connectable.map((c) => [c, CONNECT_LABELS[c] ? t(CONNECT_LABELS[c]) : c])} />
      </Field>
    </Modal>
  );
}
