import { useEffect, useState } from 'react';
import { api, d as day, dt } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Badge, Check, Empty, Input, Link, PageHead, Select, Spinner, Tabs, Textarea, act, navigate, useLoad, useRoute } from '../ui';
import { WishBuilds } from '../werkstatt/Build';
import { Shots, StatusPill, Thread, openReport, refreshFeedback, useFeedbackMe } from './Feedback';

/**
 * Wunschliste for every login: all wishes (author and sub-account only visible to the agency),
 * one vote per user (undo possible), public comments, search, sort and area filter, a roadmap board
 * (Idee → Geplant → In Arbeit → Fertig, plus Abgelehnt with reason) and „Was ist neu“.
 */

type Wish = {
  id: string;
  number: number;
  title: string;
  body: string;
  area: string;
  status: { key: string; board: string; label: string; tone: string; done: boolean };
  votes: number;
  my_vote: boolean;
  comments: number;
  mine: boolean;
  author: string;
  origin: string;
  version: string;
  reason: string;
  note: string;
  hidden?: boolean;
  ticket?: { id: string; location_id: string };
  created_at: string;
};

function VoteButton({ w, onChange, big }: { w: Pick<Wish, 'id' | 'votes' | 'my_vote' | 'status'>; onChange: (votes: number, mine: boolean) => void; big?: boolean }) {
  const [busy, setBusy] = useState(false);
  const closed = w.status.board === 'declined';
  return (
    <button
      type="button"
      className={`wish-vote${w.my_vote ? ' on' : ''}${big ? ' big' : ''}`}
      disabled={busy || (closed && !w.my_vote)}
      aria-pressed={w.my_vote}
      aria-label={w.my_vote ? `Stimme zurücknehmen (${w.votes} Stimmen)` : `Dafür stimmen (${w.votes} Stimmen)`}
      title={w.my_vote ? 'Stimme zurücknehmen' : 'Dafür stimmen'}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBusy(true);
        const r = await act(() => (w.my_vote ? api.del(`/api/feedback/wishes/${w.id}/vote`) : api.post(`/api/feedback/wishes/${w.id}/vote`)));
        setBusy(false);
        if (r) onChange(r.votes, r.my_vote);
      }}
    >
      <Icon name="up" size={big ? 18 : 15} />
      <strong>{w.votes}</strong>
      {big && <span>{w.my_vote ? 'Abgestimmt' : 'Dafür stimmen'}</span>}
    </button>
  );
}

function WishCard({ w, onVote, compact }: { w: Wish; onVote: (votes: number, mine: boolean) => void; compact?: boolean }) {
  return (
    <a className={`wish-card${compact ? ' compact' : ''}`} href={`/app/wishes/${w.id}`} onClick={(e) => (e.preventDefault(), navigate(`wishes/${w.id}`))}>
      <VoteButton w={w} onChange={onVote} />
      <span className="grow">
        <strong>{w.title}</strong>
        {!compact && w.body && <span className="wish-body">{w.body}</span>}
        <span className="wish-meta">
          {!compact && <StatusPill s={w.status} />}
          <Badge>{w.area}</Badge>
          {w.comments > 0 && (
            <span className="muted small">
              <Icon name="chat" size={12} /> {w.comments}
            </span>
          )}
          {w.mine && <span className="muted small">dein Wunsch</span>}
          {w.author && !w.mine && (
            <span className="muted small">
              {w.author}
              {w.origin ? ` · ${w.origin}` : ''}
            </span>
          )}
          {w.hidden && <Badge tone="red">ausgeblendet</Badge>}
          {w.version && <span className="muted small">Version {w.version}</span>}
        </span>
        {w.reason && <span className="muted small wish-reason">Begründung: {w.reason}</span>}
      </span>
    </a>
  );
}

function useWishes(params: string) {
  const r = useLoad(() => api.get<Wish[]>(`/api/feedback/wishes${params}`), [params]);
  const vote = (id: string) => (votes: number, mine: boolean) => r.setData((list) => list?.map((w) => (w.id === id ? { ...w, votes, my_vote: mine } : w)));
  return { ...r, vote };
}

function WishList() {
  const me = useFeedbackMe();
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [area, setArea] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('votes');
  const [mine, setMine] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQd(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const params = `?${new URLSearchParams({ q: qd, area, status, sort, ...(mine ? { mine: '1' } : {}) })}`;
  const { data, loading, vote } = useWishes(params);
  return (
    <>
      <div className="wish-filters" data-tour="wish-filters">
        <Input value={q} onChange={setQ} placeholder="Wünsche durchsuchen…" aria-label="Suchen" />
        <Select value={area} onChange={setArea} placeholder="Alle Bereiche" options={me?.areas ?? []} />
        <Select value={status} onChange={setStatus} placeholder="Jeder Status" options={me?.board ?? []} />
        <Select
          value={sort}
          onChange={setSort}
          options={[
            ['votes', 'Meiste Stimmen'],
            ['new', 'Neueste'],
            ['status', 'Nach Status'],
          ]}
        />
        <Check checked={mine} onChange={setMine} label="Nur meine & abgestimmte" />
      </div>
      {loading && !data ? (
        <Spinner />
      ) : data?.length ? (
        <div className="wish-list" data-tour="wish-list">
          {data.map((w) => (
            <WishCard key={w.id} w={w} onVote={vote(w.id)} />
          ))}
        </div>
      ) : (
        <Empty
          tour="wish-list"
          action={
            <button className="btn" onClick={() => openReport('wish')}>
              Wunsch einreichen
            </button>
          }
        >
          {qd || area || status || mine ? 'Keine Wünsche passen zum Filter.' : 'Noch keine Wünsche – sei die oder der Erste!'}
        </Empty>
      )}
    </>
  );
}

function Roadmap() {
  const { data, loading, vote } = useWishes('?sort=votes');
  const me = useFeedbackMe();
  if (loading && !data) return <Spinner />;
  const cols = (me?.board ?? []).filter(([k]) => k !== 'declined');
  const declined = (data ?? []).filter((w) => w.status.board === 'declined');
  return (
    <>
      <div className="roadmap" data-tour="wish-roadmap">
        {cols.map(([k, l]) => {
          const items = (data ?? []).filter((w) => w.status.board === k);
          return (
            <div key={k} className={`roadmap-col c-${k}`}>
              <h3>
                {l} <span className="muted">{items.length}</span>
              </h3>
              {items.length ? items.map((w) => <WishCard key={w.id} w={w} onVote={vote(w.id)} compact />) : <p className="muted small">Noch nichts.</p>}
            </div>
          );
        })}
      </div>
      {declined.length > 0 && (
        <details className="card" style={{ marginTop: 14 }}>
          <summary>
            Abgelehnt <span className="muted">({declined.length})</span>
          </summary>
          <div className="wish-list" style={{ marginTop: 10 }}>
            {declined.map((w) => (
              <WishCard key={w.id} w={w} onVote={vote(w.id)} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function Changelog() {
  const { data, loading } = useLoad(() => api.get<{ entries: any[]; new_count: number }>('/api/feedback/changelog'), []);
  useEffect(() => {
    if (data?.new_count) void api.post('/api/feedback/changelog/seen').then(() => refreshFeedback());
  }, [data]);
  if (loading && !data) return <Spinner />;
  const groups = new Map<string, any[]>();
  for (const e of data?.entries ?? []) groups.set(e.version, [...(groups.get(e.version) ?? []), e]);
  if (!groups.size) return <Empty tour="wish-changelog">Hier erscheinen neue Funktionen aus der Wunschliste und behobene Fehler – mit Versionsnummer.</Empty>;
  return (
    <div className="changelog" data-tour="wish-changelog">
      {[...groups.entries()].map(([version, items]) => {
        const wishes = items.filter((e) => e.kind === 'wish');
        const lines = items.filter((e) => e.kind !== 'wish' && e.title);
        const silent = items.filter((e) => e.kind !== 'wish' && !e.title).length;
        return (
          <div key={version} className="card changelog-v">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h2>Version {version}</h2>
              <span className="muted small">{day(items[0].at)}</span>
            </div>
            {wishes.length > 0 && (
              <>
                <h3 className="changelog-h">
                  <Icon name="idea" size={14} /> Neu
                </h3>
                <ul>
                  {wishes.map((e) => (
                    <li key={e.id}>
                      <Link to={`wishes/${e.id}`}>{e.title}</Link>
                      {e.note ? <span className="muted"> – {e.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(lines.length > 0 || silent > 0) && (
              <>
                <h3 className="changelog-h">
                  <Icon name="bug" size={14} /> Behoben
                </h3>
                <ul>
                  {lines.map((e) => (
                    <li key={e.id}>{e.title}</li>
                  ))}
                  {silent > 0 && <li className="muted">{lines.length ? `und ${silent} weitere Fehlerbehebung${silent > 1 ? 'en' : ''}` : `${silent} Fehlerbehebung${silent > 1 ? 'en' : ''}`}</li>}
                </ul>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function WishDetail({ id }: { id: string }) {
  const session = useSession();
  const { data, error, setData } = useLoad(() => api.get(`/api/feedback/wishes/${id}`), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => void (data && refreshFeedback()), [data?.wish.id]);
  if (error) return <Empty action={<Link to="wishes">Zur Wunschliste</Link>}>{error}</Empty>;
  if (!data) return <Spinner />;
  const w: Wish = data.wish;
  return (
    <>
      <div className="crumb-line">
        <Link to="wishes">← Wunschliste</Link>
      </div>
      <div className="wish-head" data-tour="page-head">
        <VoteButton big w={w} onChange={(votes, mine) => setData({ ...data, wish: { ...w, votes, my_vote: mine } })} />
        <div className="grow">
          <h1>{w.title}</h1>
          <div className="wish-meta">
            <StatusPill s={w.status} /> <Badge>{w.area}</Badge>
            <span className="muted small">
              eingereicht {dt(w.created_at)}
              {w.mine ? ' · dein Wunsch' : w.author ? ` · ${w.author}${w.origin ? ` (${w.origin})` : ''}` : ''}
            </span>
            {data.wish.ticket && (
              <button className="btn small secondary" data-tour="wish-ticket" onClick={() => session.switchLocation(data.wish.ticket.location_id, `tickets/${data.wish.ticket.id}`)}>
                <Icon name="ticket" size={13} /> Im Ticket #{w.number} bearbeiten
              </button>
            )}
          </div>
        </div>
      </div>
      {data.duplicate_of && (
        <div className="card notice-card">
          Zusammengeführt mit <Link to={data.duplicate_of.url.replace('/app/', '')}>{data.duplicate_of.title}</Link> – Stimmen und Kommentare zählen dort.
        </div>
      )}
      {w.version && (
        <div className="card notice-card ok">
          <Icon name="ok" size={15} /> Umgesetzt in Version <strong>{w.version}</strong>
          {w.note ? ` – ${w.note}` : ''}
        </div>
      )}
      {w.reason && <div className="card notice-card">Abgelehnt: {w.reason}</div>}
      <div className="card">
        {w.body ? (
          <p className="fb-text" style={{ marginTop: 0 }}>
            {w.body}
          </p>
        ) : (
          <p className="muted">Keine Beschreibung.</p>
        )}
        <Shots files={data.files} />
      </div>
      {!data.duplicate_of && w.status.board !== 'declined' && <WishBuilds wishId={w.id} />}
      <div className="card" data-tour="wish-comments">
        <h2>Kommentare</h2>
        <Thread items={data.thread.filter((e: any) => e.type !== 'status')} />
        {!data.duplicate_of && (
          <div style={{ marginTop: 12 }}>
            <Textarea value={text} onChange={setText} rows={2} placeholder="Wofür brauchst du das? Ergänzungen helfen bei der Planung." />
            <div className="actions" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button
                className="btn"
                disabled={busy || !text.trim()}
                onClick={async () => {
                  setBusy(true);
                  const r = await act(() => api.post(`/api/feedback/wishes/${id}/comments`, { body: text }), 'Kommentar gespeichert');
                  setBusy(false);
                  if (r) (setText(''), setData(r));
                }}
              >
                Kommentieren
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Route `wishes`, `wishes/roadmap`, `wishes/changelog`, `wishes/<id>`. */
export function WishesPage() {
  const route = useRoute();
  const me = useFeedbackMe();
  const session = useSession();
  const sub = route[1] ?? 'list';
  if (!['list', 'roadmap', 'changelog'].includes(sub)) return <WishDetail id={sub} />;
  return (
    <>
      <PageHead title="Wunschliste" sub={`Was soll ${session.branding.name} als Nächstes können? Stimme für Wünsche ab oder schlag selbst etwas vor.`}>
        <button className="btn secondary" onClick={() => navigate('feedback')}>
          <Icon name="inbox" size={14} /> Meine Meldungen
        </button>
        <button className="btn" data-tour="wish-new" onClick={() => openReport('wish')}>
          <Icon name="idea" size={14} /> Wunsch einreichen
        </button>
      </PageHead>
      <Tabs
        tabs={[
          ['list', 'Alle Wünsche'],
          ['roadmap', 'Roadmap'],
          ['changelog', me?.changelog_new ? `Was ist neu (${me.changelog_new})` : 'Was ist neu'],
        ]}
        value={sub}
        onChange={(t) => navigate(t === 'list' ? 'wishes' : `wishes/${t}`)}
      />
      {sub === 'list' && <WishList />}
      {sub === 'roadmap' && <Roadmap />}
      {sub === 'changelog' && <Changelog />}
    </>
  );
}
