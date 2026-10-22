import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../ui';

/**
 * Social Planner → Freigaben (client approval by magic link, modules/social-approval.ts) and → Evergreen (categories of reusable
 * posts on a weekly plan, modules/social-queues.ts) – docs/social-planner.md.
 */

const STATUS_TONE: Record<string, 'gray' | 'green' | 'red' | 'yellow' | 'blue'> = { pending: 'yellow', approved: 'blue', scheduled: 'green', changes: 'yellow', rejected: 'red' };

function ChannelPicks({ channels, value, onChange }: { channels: any[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      {channels.map((c) => (
        <Check key={c.id} checked={value.includes(c.id)} onChange={(on) => onChange(on ? [...value, c.id] : value.filter((x) => x !== c.id))} label={`${c.name} (${c.label})`} />
      ))}
    </div>
  );
}

export function SocialExtras({ tab, channels }: { tab: string; channels: any[] }) {
  return tab === 'approvals' ? <SocialApprovals channels={channels} /> : <SocialQueues channels={channels} />;
}

function SocialApprovals({ channels }: { channels: any[] }) {
  const t = useT('gaps');
  const list = useLoad(() => api.get<any[]>('/api/social-approvals'), []);
  const [form, setForm] = useState<null | { title: string; posts: { content: string; date: string }[]; integration_ids: string[] }>(null);
  const [link, setLink] = useState('');
  const label: Record<string, string> = { pending: t('Wartet auf Freigabe'), approved: t('Freigegeben'), changes: t('Änderung gewünscht'), rejected: t('Abgelehnt'), scheduled: t('Freigegeben & eingeplant') };
  const create = async () => {
    if (!form) return;
    const r = await act(() =>
      api.post('/api/social-approvals', { title: form.title, posts: form.posts.filter((p) => p.content.trim()).map((p) => ({ content: p.content, integration_ids: form.integration_ids, date: p.date ? new Date(p.date).toISOString() : undefined })) }),
    );
    if (r) {
      setForm(null);
      setLink(r.url);
      list.reload();
    }
  };
  return (
    <div className="card" data-tour="social-approvals">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{t('Freigabe durch Kunden')}</h2>
        <button className="btn small" onClick={() => setForm({ title: '', posts: [{ content: '', date: '' }], integration_ids: channels.slice(0, 1).map((c) => c.id) })}>
          {t('+ Zur Freigabe schicken')}
        </button>
      </div>
      <p className="muted small">{t('Kunden prüfen Posts über einen Link ohne Login – freigegebene Posts werden automatisch eingeplant.')}</p>
      {link && (
        <p className="small">
          {t('Link für den Kunden:')} <code style={{ overflowWrap: 'anywhere' }}>{link}</code>{' '}
          <button className="btn small secondary" onClick={() => navigator.clipboard?.writeText(link).then(() => toast(t('Kopiert')))}>
            {t('Kopieren')}
          </button>
        </p>
      )}
      {!list.data ? (
        <Spinner />
      ) : !list.data.length ? (
        <p className="muted small">{t('Noch keine Freigaben.')}</p>
      ) : (
        <table className="t">
          <tbody>
            {list.data.map((a) => (
              <tr key={a.id}>
                <td style={{ maxWidth: 420 }}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{String(a.content).slice(0, 180)}</div>
                  <div className="muted small">
                    {a.link_title && `${a.link_title} · `}
                    {a.publish_at ? dt(a.publish_at) : t('Zeitpunkt offen')}
                  </div>
                  {a.note && <div className="small">💬 {a.note}</div>}
                  {a.error && a.status === 'approved' && <div className="small muted">{a.error}</div>}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[a.status] ?? 'gray'}>{label[a.status] ?? a.status}</Badge>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="actions" style={{ justifyContent: 'flex-end' }}>
                    {a.status === 'approved' && (
                      <button className="btn small" onClick={async () => (await act(() => api.post(`/api/social-approvals/${a.id}/schedule`))) && list.reload()}>
                        {t('Einplanen')}
                      </button>
                    )}
                    <button className="btn small secondary" onClick={async () => confirmAsk(t('Freigabe löschen?')) && (await act(() => api.del(`/api/social-approvals/${a.id}`))) && list.reload()}>
                      {t('Löschen')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form && (
        <Modal
          title={t('Posts zur Freigabe schicken')}
          onClose={() => setForm(null)}
          wide
          footer={
            <button className="btn" disabled={!form.posts.some((p) => p.content.trim()) || !form.integration_ids.length} onClick={create}>
              {t('Link erstellen')}
            </button>
          }
        >
          <Field label={t('Kanäle')}>
            <ChannelPicks channels={channels} value={form.integration_ids} onChange={(v) => setForm({ ...form, integration_ids: v })} />
          </Field>
          {form.posts.map((p, i) => (
            <div key={i} className="grid2">
              <Field label={t('Post {n}', { n: i + 1 })}>
                <Textarea rows={3} value={p.content} onChange={(v) => setForm({ ...form, posts: form.posts.map((x, j) => (j === i ? { ...x, content: v } : x)) })} />
              </Field>
              <Field label={t('Geplant für')}>
                <Input type="datetime-local" value={p.date} onChange={(v) => setForm({ ...form, posts: form.posts.map((x, j) => (j === i ? { ...x, date: v } : x)) })} />
              </Field>
            </div>
          ))}
          <button className="btn small secondary" disabled={form.posts.length >= 30} onClick={() => setForm({ ...form, posts: [...form.posts, { content: '', date: '' }] })}>
            {t('+ Weiterer Post')}
          </button>
          <MoreFields id="social-approval-more" values={[form.title]}>
            <Field label={t('Titel für den Kunden')}>
              <Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder={t('z. B. Posts November')} />
            </Field>
          </MoreFields>
        </Modal>
      )}
    </div>
  );
}

function SocialQueues({ channels }: { channels: any[] }) {
  const t = useT('gaps');
  const list = useLoad(() => api.get<any[]>('/api/social-queues'), []);
  const [name, setName] = useState('');
  const [openId, setOpenId] = useState('');
  const add = async () => {
    const r = await act(() => api.post('/api/social-queues', { name, integration_ids: channels.slice(0, 1).map((c) => c.id), slots: [{ day: 'tue', time: '09:00' }, { day: 'thu', time: '17:00' }] }));
    if (r) {
      setName('');
      setOpenId(r.id);
      list.reload();
    }
  };
  if (!list.data) return <Spinner />;
  const open = list.data.find((q) => q.id === openId);
  return (
    <div className="card" data-tour="social-queues">
      <h2 style={{ marginTop: 0 }}>{t('Evergreen-Kategorien')}</h2>
      <p className="muted small">{t('Wiederverwendbare Posts, die automatisch zu festen Zeiten im Wechsel erscheinen – z. B. Tipps oder Kundenstimmen.')}</p>
      {list.data.length === 0 && <Empty>{t('Noch keine Kategorie.')}</Empty>}
      {list.data.map((q) => (
        <div key={q.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <div>
            <strong>{q.name}</strong> <span className="muted small">{t.plural(q.items.length, { one: '{n} Post', other: '{n} Posts' })}</span>{' '}
            {q.active ? <Badge tone="green">{t('aktiv')}</Badge> : <Badge>{t('pausiert')}</Badge>}
            {q.next_at && <span className="muted small"> · {t('nächster: {d}', { d: dt(q.next_at) })}</span>}
            {q.last_error && <div className="small muted">{q.last_error}</div>}
          </div>
          <button className="btn small secondary" onClick={() => setOpenId(q.id)}>
            {t('Bearbeiten')}
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <div style={{ width: 220 }}>
          <Input value={name} onChange={setName} placeholder={t('Neue Kategorie, z. B. Tipps')} aria-label={t('Name der Kategorie')} />
        </div>
        <button className="btn small" disabled={!name.trim()} onClick={add}>
          {t('+ Kategorie')}
        </button>
      </div>
      {open && <QueueModal q={open} channels={channels} onClose={() => setOpenId('')} onChanged={list.reload} />}
    </div>
  );
}

function QueueModal({ q, channels, onClose, onChanged }: { q: any; channels: any[]; onClose: () => void; onChanged: () => void }) {
  const t = useT('gaps');
  const [text, setText] = useState('');
  const [slot, setSlot] = useState({ day: 'mon', time: '09:00' });
  const preview = useLoad(() => api.get<any[]>(`/api/social-queues/${q.id}/preview`), [q.id, q.updated_at, q.items.length]);
  const patch = async (body: any, ok?: string) => (await act(() => api.patch(`/api/social-queues/${q.id}`, body), ok)) && onChanged();
  const days: [string, string][] = [
    ['mon', t('Mo')],
    ['tue', t('Di')],
    ['wed', t('Mi')],
    ['thu', t('Do')],
    ['fri', t('Fr')],
    ['sat', t('Sa')],
    ['sun', t('So')],
  ];
  const dayName = (d: string) => days.find((x) => x[0] === d)?.[1] ?? d;
  return (
    <Modal title={q.name} onClose={onClose} wide>
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <Check checked={q.active} onChange={(v) => patch({ active: v }, v ? t('Kategorie aktiv') : t('Kategorie pausiert'))} label={t('Automatisch posten')} />
        <button className="btn small secondary" disabled={!q.items.length} onClick={async () => (await act(() => api.post(`/api/social-queues/${q.id}/run`), t('Gepostet'))) && onChanged()}>
          {t('Nächsten jetzt posten')}
        </button>
      </div>
      <Field label={t('Kanäle')}>
        <ChannelPicks channels={channels} value={q.integration_ids} onChange={(v) => patch({ integration_ids: v })} />
      </Field>
      <Field label={t('Wochenplan')}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {q.slots.map((s: any) => (
            <span key={s.day + s.time} className="badge gray">
              {dayName(s.day)} {s.time}{' '}
              <button className="icon-btn" aria-label={t('Zeit entfernen')} onClick={() => patch({ slots: q.slots.filter((x: any) => x !== s) })}>
                ✕
              </button>
            </span>
          ))}
        </div>
      </Field>
      <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
        <Select value={slot.day} onChange={(v) => setSlot({ ...slot, day: v })} options={days} aria={t('Wochentag')} />
        <div style={{ width: 120 }}>
          <Input type="time" value={slot.time} onChange={(v) => setSlot({ ...slot, time: v })} aria-label={t('Uhrzeit')} />
        </div>
        <button className="btn small secondary" onClick={() => patch({ slots: [...q.slots, slot] })}>
          {t('+ Zeit')}
        </button>
      </div>
      <h3>{t('Posts')}</h3>
      {q.items.map((it: any) => (
        <div key={it.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
          <div style={{ whiteSpace: 'pre-wrap', flex: 1 }}>
            {it.content} <span className="muted small">· {t.plural(it.used_count, { zero: 'noch nie gepostet', one: '{n}× gepostet', other: '{n}× gepostet' })}</span>
          </div>
          <button className="btn small secondary" aria-label={t('Post entfernen')} onClick={async () => confirmAsk(t('Post aus der Kategorie entfernen?')) && (await act(() => api.del(`/api/social-queues/${q.id}/items/${it.id}`))) && onChanged()}>
            ✕
          </button>
        </div>
      ))}
      <Field label={t('Neuer Post')}>
        <Textarea rows={3} value={text} onChange={setText} />
      </Field>
      <button className="btn small" disabled={!text.trim()} onClick={async () => (await act(() => api.post(`/api/social-queues/${q.id}/items`, { content: text }))) && (setText(''), onChanged())}>
        {t('Hinzufügen')}
      </button>
      <MoreFields id="social-queue-more" values={[q.recycle === false ? 'x' : '']}>
        <Check checked={q.recycle} onChange={(v) => patch({ recycle: v })} label={t('Wiederverwenden, wenn alle Posts einmal erschienen sind')} />
        {(preview.data ?? []).length > 0 && (
          <>
            <h3>{t('Die nächsten Termine')}</h3>
            <ul className="small">
              {preview.data!.map((p) => (
                <li key={p.at}>
                  {dt(p.at)} – {p.content || <span className="muted">{t('nichts mehr übrig')}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        <button className="btn small secondary" onClick={async () => confirmAsk(t('Kategorie „{n}“ löschen?', { n: q.name })) && (await act(() => api.del(`/api/social-queues/${q.id}`))) && (onClose(), onChanged())}>
          {t('Kategorie löschen')}
        </button>
      </MoreFields>
    </Modal>
  );
}
