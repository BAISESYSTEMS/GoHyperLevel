import { Fragment, useState } from 'react';
import { api, dt, name } from '../api';
import { useT } from '../i18n';
import { channelIcon, Icon } from '../icons';
import { useTags } from '../tags';
import { pressable, Select, Spinner, useLoad } from '../ui';
import './crm-gaps.css';

/**
 * Conversations: extra filters (tag, open deal in pipeline/stage, contact owner) and full-text search over every message
 * (modules/inbox-filters.ts). `onChange` hands the page the query string to append to GET /api/conversations; the hits of the
 * message search open their conversation through `onOpen`. Folded behind one button so the list stays calm.
 */

export interface InboxFilterValue {
  tag: string;
  pipeline_id: string;
  stage_id: string;
  owner: string;
}
const EMPTY: InboxFilterValue = { tag: '', pipeline_id: '', stage_id: '', owner: '' };

export const inboxFilterQs = (v: InboxFilterValue) =>
  Object.entries(v)
    .filter(([, x]) => x)
    .map(([k, x]) => `&${k}=${encodeURIComponent(x)}`)
    .join('');

/** The hit marks of the server (\u0001 … \u0002) as <mark>. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\u0001|\u0002/);
  return (
    <span>
      {parts.map((p, i) => (
        <Fragment key={i}>{i % 2 ? <mark>{p}</mark> : p}</Fragment>
      ))}
    </span>
  );
}

export function InboxFilters({ value, onChange, q, onOpen }: { value: InboxFilterValue; onChange: (v: InboxFilterValue) => void; q: string; onOpen: (conversationId: string) => void }) {
  const t = useT('crmgaps');
  const active = Object.values(value).filter(Boolean).length;
  const [open, setOpen] = useState(active > 0);
  const [search, setSearch] = useState('');
  const tags = useTags();
  const pipelines = useLoad(() => (open ? api.get<{ id: string; name: string; stages: { id: string; name: string }[] }[]>('/api/pipelines') : Promise.resolve([])), [open]);
  const users = useLoad(() => (open ? api.get<{ id: string; name: string }[]>('/api/location-users').catch(() => []) : Promise.resolve([])), [open]);
  const hits = useLoad(
    () => (search.length >= 2 ? api.get<{ hits: any[] }>(`/api/conversations/search?q=${encodeURIComponent(search)}${inboxFilterQs(value)}`) : Promise.resolve({ hits: [] as any[] })),
    [search, value.tag, value.pipeline_id, value.stage_id, value.owner],
  );
  const pipe = (pipelines.data ?? []).find((p) => p.id === value.pipeline_id);
  const set = (patch: Partial<InboxFilterValue>) => onChange({ ...value, ...patch });
  const term = q.trim();

  return (
    <div data-tour="inbox-more-filters">
      <div className="inbox-filters">
        <button type="button" className={`btn small ${active ? '' : 'secondary'}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="filter" size={14} /> {active ? t('Filter ({n})', { n: active }) : t('Filter')}
        </button>
        {term.length >= 2 && search !== term && (
          <button type="button" className="btn small secondary" onClick={() => setSearch(term)} title={t('Sucht in Betreff und Text aller Nachrichten')}>
            {t('„{q}“ in allen Nachrichten suchen', { q: term.slice(0, 30) })}
          </button>
        )}
        {active > 0 && (
          <button type="button" className="btn small secondary" onClick={() => onChange(EMPTY)}>
            {t('Filter zurücksetzen')}
          </button>
        )}
      </div>
      {open && (
        <div className="inbox-filters">
          <Select value={value.tag} onChange={(v) => set({ tag: v })} placeholder={t('Jeder Tag')} aria={t('Nach Tag filtern')} options={tags.map((x) => [x, x] as [string, string])} />
          <Select value={value.pipeline_id} onChange={(v) => set({ pipeline_id: v, stage_id: '' })} placeholder={t('Jede Pipeline')} aria={t('Nach Pipeline filtern (offener Deal)')} options={(pipelines.data ?? []).map((p) => [p.id, p.name] as [string, string])} />
          {pipe && <Select value={value.stage_id} onChange={(v) => set({ stage_id: v })} placeholder={t('Jede Stufe')} aria={t('Nach Stufe filtern')} options={pipe.stages.map((s) => [s.id, s.name] as [string, string])} />}
          <Select value={value.owner} onChange={(v) => set({ owner: v })} placeholder={t('Jeder Zuständige')} aria={t('Nach zuständiger Person des Kontakts filtern')} options={[['me', t('Meine Kontakte')], ['none', t('Ohne Zuständigen')], ...(users.data ?? []).map((u) => [u.id, u.name] as [string, string])]} />
        </div>
      )}
      {search && (
        <div className="card" style={{ margin: '6px 0', padding: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong className="small">{t('Treffer in Nachrichten für „{q}“', { q: search })}</strong>
            <button type="button" className="icon-btn" aria-label={t('Nachrichtensuche schließen')} onClick={() => setSearch('')}>
              ✕
            </button>
          </div>
          {hits.loading && !hits.data ? (
            <Spinner />
          ) : hits.data?.hits.length ? (
            <ul className="inbox-hits" style={{ maxHeight: 280, overflowY: 'auto' }}>
              {hits.data.hits.map((h) => (
                <li key={h.message_id} {...pressable(() => onOpen(h.conversation_id))}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong className="small">
                      <Icon name={channelIcon(h.channel)} size={12} /> {name(h)}
                    </strong>
                    <span className="muted small">{dt(h.created_at)}</span>
                  </div>
                  <div className="small">
                    {h.subject && h.snippet.replace(/[\u0001\u0002]/g, '') !== h.subject && <strong>{h.subject} · </strong>}
                    <Snippet text={h.snippet} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{t('Keine Nachricht enthält diese Wörter.')}</p>
          )}
        </div>
      )}
    </div>
  );
}
