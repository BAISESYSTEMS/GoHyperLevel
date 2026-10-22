import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Link, Modal, Select, Spinner, Stat, TagInput, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { Callout, Item, Panel } from './CreatorKit';
import { Tl, dur, pct, uploadRaw, useCanSettings } from './CallsKit';
import { Scores, ScorecardsDialog } from './CallsScorecards';
import { SortableGrid } from '../sortable/Sortable';

/**
 * "Gespräche": the analysis of calls and uploaded meeting recordings – transcript (per speaker when the recording has two channels),
 * summary, action items that become tasks, topics, sentiment, talk-time ratio and filler words – plus scorecards. The summary lands in the
 * contact's timeline. Audio goes to the speech provider you chose, which is why the analysis of every call is off until you switch it on.
 * Docs: docs/telephony.md.
 */

const SOURCE: Record<string, string> = { call: 'Anruf', upload: 'Aufnahme', text: 'Transkript' };
const RUNNING = ['queued', 'transcribing', 'analyzing'];
const STATUS_TEXT: Record<string, string> = { queued: 'wartet', transcribing: 'wird transkribiert …', analyzing: 'wird ausgewertet …', failed: 'fehlgeschlagen' };
const TONE: Record<string, 'green' | 'red' | 'gray' | 'yellow'> = { positiv: 'green', negativ: 'red', neutral: 'gray', gemischt: 'yellow' };
const SPEAKER: Record<string, string> = { agent: 'Mitarbeiter', customer: 'Gegenüber' };

const sentimentBadge = (s: any) => (s?.overall ? <Badge tone={TONE[s.overall] ?? 'gray'}>{s.overall}</Badge> : null);

// --- settings ---------------------------------------------------------------------------------------------------------------------

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const data = useLoad(() => api.get('/api/call-intel/settings'), []);
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (data.data && !s) setS({ ...data.data.settings });
  }, [data.data]);
  if (!data.data || !s) return <Modal title="Einstellungen der Gesprächsauswertung" onClose={onClose}><Spinner /></Modal>;
  const d = data.data;
  const set = (p: any) => setS({ ...s, ...p });
  const save = async () => {
    if (await act(() => api.put('/api/call-intel/settings', s), 'Gespeichert')) onClose();
  };
  return (
    <Modal
      title="Einstellungen der Gesprächsauswertung"
      wide
      onClose={onClose}
      footer={
        <button className="btn" onClick={save}>
          Speichern
        </button>
      }
    >
      {!d.stt_ready && <Callout tone="warn">Für die Transkription fehlt eine Sprach-Verbindung (Einstellungen → KI-Verbindungen, Art „Sprache zu Text“).</Callout>}
      {d.ai_problem && <Callout tone="warn">Für Zusammenfassung und Aufgaben fehlt der KI-Assistent: {d.ai_problem} Ohne ihn zählt die Auswertung nur Redeanteile, Füllwörter und Stichwörter.</Callout>}
      <Check checked={s.auto_calls} onChange={(v) => set({ auto_calls: v })} label="Jedes aufgezeichnete Gespräch automatisch auswerten" tour="intel-auto" />
      <p className="muted small" style={{ margin: '0 0 12px 32px' }}>
        Dafür wird die Aufnahme an deinen Sprachanbieter gesendet. Schalte das nur ein, wenn die Aufzeichnung rechtmäßig ist (Hinweis am Telefon, Einwilligung) und der Anbieter in deiner Datenschutzerklärung und im Auftragsverarbeitungsvertrag steht. Einzelne Gespräche kannst du auch von Hand auswerten.
      </p>
      <div className="cr-form-row">
        <Field label="Kürzere Aufnahmen auslassen (Sekunden)">
          <Input type="number" min={5} max={3600} value={s.min_seconds} onChange={(v) => set({ min_seconds: Number(v) })} />
        </Field>
        <Field label="Sprache der Gespräche">
          <Input value={s.language} onChange={(v) => set({ language: v })} maxLength={5} placeholder="de" />
        </Field>
        <Field label="Aufbewahrung der Auswertungen (Tage, 0 = unbegrenzt)">
          <Input type="number" min={0} max={3650} value={s.retention_days} onChange={(v) => set({ retention_days: Number(v) })} />
        </Field>
      </div>
      {d.stt_connections.length > 1 && (
        <Field label="Sprachanbieter">
          <Select value={s.stt_connection_id} onChange={(v) => set({ stt_connection_id: v })} placeholder="Standard" options={d.stt_connections.map((c: any) => [c.id, `${c.label} (${c.provider})`])} />
        </Field>
      )}
      <Check checked={s.ai} onChange={(v) => set({ ai: v })} label="KI fasst zusammen und findet Aufgaben, Themen und Einwände" />
      <Check checked={s.timeline} onChange={(v) => set({ timeline: v })} label="Zusammenfassung in den Verlauf des Kontakts schreiben" />
      <Check checked={s.auto_tasks} onChange={(v) => set({ auto_tasks: v })} label="Aufgaben der eigenen Seite sofort als Aufgabe anlegen" />
      <Check checked={s.channel_swap} onChange={(v) => set({ channel_swap: v })} label="Mitarbeiter und Gegenüber vertauschen (falls die Zuordnung der Tonspuren bei dir umgekehrt ist)" />
      <Field label="Standard-Scorecard" hint="Wird nach jeder Auswertung automatisch von der KI vorbewertet.">
        <Select value={s.default_scorecard_id} onChange={(v) => set({ default_scorecard_id: v })} placeholder="keine" options={d.scorecards.map((c: any) => [c.id, c.name])} />
      </Field>
      <Field label="Eigene Füllwörter" hint="Kommen zur eingebauten Liste (äh, ähm, also, quasi …) dazu.">
        <TagInput value={s.fillers} onChange={(v) => set({ fillers: v })} placeholder="Wort + Enter" />
      </Field>
      <Field label="Namen und Fachbegriffe" hint="Hilft der Spracherkennung, z. B. Produktnamen richtig zu schreiben.">
        <Input value={s.glossary} onChange={(v) => set({ glossary: v })} maxLength={500} />
      </Field>
    </Modal>
  );
}

// --- upload ----------------------------------------------------------------------------------------------------------------------------

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState('audio');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    let r: any;
    if (mode === 'audio') {
      const f = file.current?.files?.[0];
      if (!f) {
        setBusy(false);
        return toast('Bitte eine Audiodatei wählen.');
      }
      r = await act(() => uploadRaw(`/api/call-intel/upload?title=${encodeURIComponent(title)}&consent=${consent ? '1' : '0'}`, f), 'Wird ausgewertet …');
    } else r = await act(() => api.post('/api/call-intel/text', { title, transcript: text }), 'Wird ausgewertet …');
    setBusy(false);
    if (r) {
      onDone(r.id);
      onClose();
    }
  };
  return (
    <Modal
      title="Gespräch auswerten"
      onClose={onClose}
      footer={
        <button className="btn" disabled={busy || (mode === 'audio' ? !consent : text.trim().length < 20)} onClick={send}>
          {busy ? 'Wird hochgeladen …' : 'Auswerten'}
        </button>
      }
    >
      <Field label="Was hast du?">
        <Select value={mode} onChange={setMode} options={[['audio', 'Eine Aufnahme (MP3, WAV, M4A, WebM …)'], ['text', 'Ein fertiges Transkript (Teams, Zoom, Meet)']]} />
      </Field>
      <Field label="Titel (optional)">
        <Input value={title} onChange={setTitle} maxLength={120} placeholder="z. B. Erstgespräch Müller GmbH" />
      </Field>
      {mode === 'audio' ? (
        <>
          <Field label="Aufnahme" hint="Mit einer Tonspur je Gesprächspartner (z. B. aus einer Konferenz-Aufzeichnung) lässt sich auch der Redeanteil messen.">
            <input ref={file} type="file" accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.aac" />
          </Field>
          <Check checked={consent} onChange={setConsent} label="Alle Beteiligten wurden über die Aufzeichnung informiert und haben zugestimmt (§ 201 StGB, DSGVO)." />
          <p className="muted small">Die Aufnahme geht zur Transkription an deinen Sprachanbieter und wird danach gelöscht; behalten wird das Transkript.</p>
        </>
      ) : (
        <Field label="Transkript">
          <Textarea value={text} onChange={setText} rows={10} placeholder="Sprecher: Text …" />
        </Field>
      )}
    </Modal>
  );
}

// --- one conversation -----------------------------------------------------------------------------------------------------------------

function Detail({ id, onClose, ready }: { id: string; onClose: () => void; ready: boolean }) {
  const data = useLoad(() => api.get(`/api/call-intel/${id}`), [id]);
  const d = data.data;
  const running = !!d && RUNNING.includes(d.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void data.reload(), 4000);
    return () => clearInterval(t);
  }, [running, id]);
  if (!d) {
    return (
      <Modal title="Gespräch" wide onClose={onClose}>
        {data.error ? <p className="cr-err">{data.error}</p> : <Spinner />}
      </Modal>
    );
  }
  const m = d.metrics ?? {};
  const task = async (i: number) => {
    const r = await act(() => api.post(`/api/call-intel/${id}/action-items/${i}/task`), 'Aufgabe angelegt');
    if (r) data.setData({ ...d, action_items: r.items });
  };
  const done = async (i: number, on: boolean) => {
    const r = await act(() => api.patch(`/api/call-intel/${id}/action-items/${i}`, { done: on }));
    if (r) data.setData({ ...d, action_items: r.items });
  };
  return (
    <Modal title={d.title || 'Gespräch'} wide onClose={onClose}>
      <div className="cr-line" style={{ marginBottom: 10 }}>
        <Badge tone="blue">{SOURCE[d.source] ?? d.source}</Badge>
        {d.contact_id && (
          <Link to={`contacts/${d.contact_id}`} className="btn small secondary">
            {d.contact_name || 'Kontakt'}
          </Link>
        )}
        {d.user_name && <span className="muted small">{d.user_name}</span>}
        <span className="muted small">
          {dt(d.created_at)}
          {d.duration_s ? ` · ${dur(d.duration_s)}` : ''}
        </span>
        {sentimentBadge(d.sentiment)}
        {d.separated && <Badge>je Sprecher getrennt</Badge>}
      </div>
      {running && (
        <p>
          <Spinner /> {STATUS_TEXT[d.status]}
        </p>
      )}
      {d.status === 'failed' && (
        <Callout tone="bad">
          <p>{d.error || 'Die Auswertung ist fehlgeschlagen.'}</p>
          <button
            className="btn small"
            onClick={async () => {
              if (await act(() => api.post(`/api/call-intel/${id}/retry`), 'Neuer Versuch gestartet')) void data.reload();
            }}
          >
            Nochmal versuchen
          </button>
        </Callout>
      )}
      {d.ai_error && d.status === 'done' && (
        <Callout tone="warn">
          Die KI konnte nicht zusammenfassen ({d.ai_error}). Redeanteile, Füllwörter und Stichwörter sind trotzdem gezählt.{' '}
          <button className="btn small secondary" onClick={async () => (await act(() => api.post(`/api/call-intel/${id}/retry`), 'Neuer Versuch gestartet')) && data.reload()}>
            Erneut versuchen
          </button>
        </Callout>
      )}
      {d.status === 'done' && (
        <div className="cr-panels two">
          <Panel title="Zusammenfassung" tour="intel-summary">
            {d.summary ? <p style={{ marginTop: 0 }}>{d.summary}</p> : <p className="muted">Keine Zusammenfassung (die KI war nicht erreichbar).</p>}
            {d.next_step && (
              <p>
                <strong>Nächster Schritt:</strong> {d.next_step}
              </p>
            )}
            {d.topics.length > 0 && (
              <div className="tl-tags">
                {d.topics.map((t: string) => (
                  <span className="tl-tag" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            )}
            {d.objections.length > 0 && (
              <>
                <h4 style={{ margin: '8px 0 6px' }}>Einwände</h4>
                <div className="tl-tags">
                  {d.objections.map((t: string) => (
                    <span className="tl-tag bad" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </>
            )}
          </Panel>
          <Panel title="Zahlen" tour="intel-metrics">
            {m.talk ? (
              <>
                <div className="tl-talk" role="img" aria-label={`Redeanteil Mitarbeiter ${m.talk.agent_pct} Prozent`}>
                  <i className="a" style={{ width: `${m.talk.agent_pct}%` }} />
                  <i className="b" style={{ width: `${m.talk.customer_pct}%` }} />
                </div>
                <div className="tl-legend">
                  <span>
                    Mitarbeiter <b>{m.talk.agent_pct} %</b>
                  </span>
                  <span>
                    Gegenüber <b>{m.talk.customer_pct} %</b>
                  </span>
                  <span>
                    Längster Monolog <b>{dur(m.talk.longest_agent_s)}</b> / <b>{dur(m.talk.longest_customer_s)}</b>
                  </span>
                  <span>
                    Redewechsel <b>{m.talk.turns}</b>
                  </span>
                </div>
              </>
            ) : (
              <p className="muted small">Der Redeanteil lässt sich nur messen, wenn die Aufnahme eine Tonspur je Gesprächspartner hat (Anrufe mit Aufzeichnung haben sie).</p>
            )}
            <SortableGrid id="calls-intel.stats" className="stats" style={{ marginTop: 12 }}>
              <Stat label="Wörter" value={m.words?.total ?? 0} sub={m.words?.agent !== undefined ? `${m.words.agent} / ${m.words.customer}` : undefined} />
              <Stat label="Fragen" value={m.questions?.total ?? 0} sub={m.questions?.agent !== undefined ? `${m.questions.agent} / ${m.questions.customer}` : undefined} />
              <Stat label="Füllwörter je 100 Wörter" value={m.fillers?.per_100 ?? 0} sub={m.fillers?.agent ? `Mitarbeiter ${m.fillers.agent.per_100}` : undefined} />
              {m.wpm && <Stat label="Wörter pro Minute" value={m.wpm.agent} sub={`Gegenüber ${m.wpm.customer}`} />}
            </SortableGrid>
            {m.fillers?.by && Object.keys(m.fillers.by).length > 0 && (
              <div className="tl-tags" style={{ marginTop: 8 }}>
                {Object.entries(m.fillers.by as Record<string, number>)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 8)
                  .map(([w, n]) => (
                    <span className="tl-tag" key={w}>
                      {w} × {n}
                    </span>
                  ))}
              </div>
            )}
            {d.sentiment?.score !== undefined && (
              <p className="muted small">
                Stimmung: {d.sentiment.overall} ({d.sentiment.score > 0 ? '+' : ''}
                {Math.round(d.sentiment.score * 100) / 100}){d.sentiment.customer ? ` · Gegenüber ${d.sentiment.customer}` : ''}
                {d.sentiment.agent ? ` · Mitarbeiter ${d.sentiment.agent}` : ''}
              </p>
            )}
          </Panel>
          <Panel title="Aufgaben aus dem Gespräch" wide tour="intel-actions">
            {d.action_items.length ? (
              d.action_items.map((a: any, i: number) => (
                <div className="tl-action" key={i}>
                  <Check checked={a.done} onChange={(on) => done(i, on)} label="" />
                  <span className="grow" style={a.done ? { textDecoration: 'line-through' } : undefined}>
                    {a.title} <span className="muted small">· {a.owner === 'agent' ? 'wir' : a.owner === 'customer' ? 'Gegenüber' : 'andere'}{a.due ? ` · bis ${a.due.slice(8)}.${a.due.slice(5, 7)}.` : ''}</span>
                  </span>
                  {a.task_id ? (
                    <Badge tone="green">als Aufgabe angelegt</Badge>
                  ) : (
                    <button className="btn small secondary" onClick={() => task(i)}>
                      <Icon name="todo" size={14} /> Aufgabe anlegen
                    </button>
                  )}
                </div>
              ))
            ) : (
              <p className="muted">Keine Aufgaben erkannt.</p>
            )}
          </Panel>
          <Panel title="Bewertung (Scorecard)" wide sub="Die KI schlägt je Kriterium eine Note vor, eine Führungskraft prüft." tour="intel-scores">
            <Scores intelId={id} ready={ready} />
          </Panel>
          <Panel title="Transkript" wide>
            {d.utterances?.length ? (
              <div className="tl-transcript">
                {d.utterances.map((u: any, i: number) => (
                  <div key={i}>
                    <strong>{SPEAKER[u.speaker] ?? u.speaker}:</strong> {u.text}
                  </div>
                ))}
              </div>
            ) : (
              <div className="tl-transcript">{d.transcript || 'Kein Transkript.'}</div>
            )}
            {d.consent_note && <p className="muted small">{d.consent_note}</p>}
          </Panel>
        </div>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        {d.call_id && (
          <button className="btn secondary" onClick={() => navigate('calls')}>
            Zur Anrufliste
          </button>
        )}
        <button
          className="btn danger"
          onClick={async () => {
            if (confirmAsk('Auswertung mit Transkript löschen?') && (await act(() => api.del(`/api/call-intel/${id}`), 'Gelöscht'))) onClose();
          }}
        >
          <Icon name="trash" size={14} /> Löschen
        </button>
      </div>
    </Modal>
  );
}

// --- the page -----------------------------------------------------------------------------------------------------------------------------

export function CallsIntel({ open }: { open?: string }) {
  const can = useCanSettings();
  const [q, setQ] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [source, setSource] = useState('');
  const list = useLoad(() => api.get(`/api/call-intel?${new URLSearchParams({ ...(q ? { q } : {}), ...(sentiment ? { sentiment } : {}), ...(source ? { source } : {}) })}`), [q, sentiment, source]);
  const stats = useLoad(() => api.get('/api/call-intel/stats?days=30'), []);
  const settings = useLoad(() => api.get('/api/call-intel/settings'), []);
  const [upload, setUpload] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [cards, setCards] = useState(false);
  const running = (list.data?.open ?? 0) > 0;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => (void list.reload(), void stats.reload()), 6000);
    return () => clearInterval(t);
  }, [running, q, sentiment, source]);
  const st = stats.data;
  const ready = !!settings.data && !settings.data.ai_problem;
  const show = (id: string) => navigate(`calls/intel/${id}`);
  return (
    <Tl name="intel">
      {settings.data && !settings.data.stt_ready && (
        <Callout tone="warn">
          Für die Transkription fehlt eine Sprach-Verbindung. Trage bei den KI-Verbindungen einen Sprachanbieter ein (Art „Sprache zu Text“), dann lassen sich Anrufe und Aufnahmen auswerten.
        </Callout>
      )}
      {st && (
        <SortableGrid id="intel-stats" className="stats" style={{ marginBottom: 14 }} data-tour="intel-stats">
          <Stat label="Ausgewertet (30 Tage)" value={st.analysed} sub={st.open ? `${st.open} laufen` : st.failed ? `${st.failed} fehlgeschlagen` : undefined} />
          <Stat label="Redeanteil Mitarbeiter" value={st.avg_agent_talk_pct === null ? '–' : `${Math.round(st.avg_agent_talk_pct)} %`} sub="Richtwert: unter 50 %" />
          <Stat label="Füllwörter je 100 Wörter" value={st.avg_fillers_per_100 ?? '–'} />
          <Stat label="Stimmung" value={Object.entries(st.sentiment as Record<string, number>).map(([k, n]) => `${n} ${k}`).join(' · ') || '–'} />
        </SortableGrid>
      )}
      <div className="tl-bar">
        <div className="grow" data-tour="intel-search">
          <Input value={q} onChange={setQ} placeholder="Suchen in Titel, Zusammenfassung, Transkript …" aria-label="Suchen" />
        </div>
        <Select value={sentiment} onChange={setSentiment} placeholder="Jede Stimmung" options={['positiv', 'neutral', 'negativ', 'gemischt']} />
        <Select value={source} onChange={setSource} placeholder="Jede Quelle" options={Object.entries(SOURCE)} />
        <button className="btn" onClick={() => setUpload(true)} data-tour="intel-upload">
          <Icon name="upload" size={14} /> Aufnahme oder Transkript
        </button>
        <button className="btn secondary" onClick={() => setCards(true)} data-tour="intel-cards">
          <Icon name="award" size={14} /> Scorecards
        </button>
        {can && (
          <button className="btn secondary" onClick={() => setPrefs(true)}>
            <Icon name="settings" size={14} /> Einstellungen
          </button>
        )}
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.items.length ? (
        <div className="cr-list" data-tour="intel-list">
          {list.data.items.map((r: any) => (
            <Item
              key={r.id}
              onClick={() => show(r.id)}
              side={
                <>
                  {RUNNING.includes(r.status) || r.status === 'failed' ? <Badge tone={r.status === 'failed' ? 'red' : 'blue'}>{STATUS_TEXT[r.status]}</Badge> : sentimentBadge(r.sentiment)}
                  <Badge>{SOURCE[r.source] ?? r.source}</Badge>
                </>
              }
            >
              <strong>{r.title || (r.source === 'call' ? 'Telefonat' : 'Gespräch')}</strong>{' '}
              <span className="muted small">
                {r.contact_name && `${r.contact_name} · `}
                {dt(r.created_at)}
                {r.duration_s ? ` · ${dur(r.duration_s)}` : ''}
              </span>
              {r.summary && <div className="cr-sub">{r.summary.slice(0, 220)}</div>}
              {r.metrics?.talk && (
                <div className="cr-sub">
                  Redeanteil Mitarbeiter {pct(r.metrics.talk.agent_pct)}
                  {r.topics.length > 0 && ` · ${r.topics.slice(0, 3).join(', ')}`}
                </div>
              )}
            </Item>
          ))}
        </div>
      ) : (
        <Empty>Noch nichts ausgewertet. Aufgezeichnete Anrufe wertest du in der Anrufliste per ✨ aus, Meeting-Aufnahmen und Transkripte lädst du oben hoch.</Empty>
      )}
      {st?.agents?.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <Panel title="Pro Person (30 Tage)" sub="Zum Coaching, nicht zum Ranking: Redeanteil, Füllwörter, Stimmung und Scorecard-Durchschnitt." wide>
            <table className="tl-report">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="n">Gespräche</th>
                  <th className="n">Redeanteil</th>
                  <th className="n">Füllwörter / 100</th>
                  <th className="n">Scorecard</th>
                </tr>
              </thead>
              <tbody>
                {st.agents.map((a: any) => (
                  <tr key={a.user_id ?? 'x'}>
                    <td>{a.name}</td>
                    <td className="n">{a.calls}</td>
                    <td className="n">{pct(a.avg_agent_talk_pct)}</td>
                    <td className="n">{a.avg_fillers_per_100 ?? '–'}</td>
                    <td className="n">{a.avg_score === null ? '–' : Math.round(a.avg_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {st.topics.length > 0 && (
              <div className="tl-tags" style={{ marginTop: 12 }}>
                {st.topics.map((t: any) => (
                  <span className="tl-tag" key={t.topic}>
                    {t.topic} × {t.n}
                  </span>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
      {open && <Detail id={open} ready={ready} onClose={() => (navigate('calls/intel'), void list.reload())} />}
      {upload && <UploadDialog onClose={() => setUpload(false)} onDone={(id) => (void list.reload(), show(id))} />}
      {prefs && <SettingsDialog onClose={() => (setPrefs(false), void settings.reload())} />}
      {cards && <ScorecardsDialog onClose={() => setCards(false)} />}
    </Tl>
  );
}
