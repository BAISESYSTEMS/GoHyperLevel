import { useRef, useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Stat, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { Callout, Item, Panel } from './CreatorKit';
import { dur, pct, splitList, uploadRaw } from './CallsKit';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Behind "Telefonmenüs": Zeitpläne (Öffnungszeiten, Feiertage, Sonderzeiten), Ruf-Gruppen und Warteschlangen (gleichzeitig, der Reihe nach,
 * reihum; Wartemusik, Wartezeit, Überlauf) und Audio (Ansagen, Wartemusik, Voicemail-Drops). Docs: docs/telephony.md.
 */

interface Meta {
  users: { id: string; name: string }[];
  groups: { id: string; name: string; kind: string }[];
  schedules: { id: string; name: string }[];
  states: { code: string; name: string }[];
}

const DAYS: [string, string][] = [
  ['mon', 'Montag'],
  ['tue', 'Dienstag'],
  ['wed', 'Mittwoch'],
  ['thu', 'Donnerstag'],
  ['fri', 'Freitag'],
  ['sat', 'Samstag'],
  ['sun', 'Sonntag'],
];

// --- schedules ----------------------------------------------------------------------------------------------------------------

function ScheduleDialog({ initial, meta, onClose, onSaved }: { initial: any | null; meta: Meta; onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<any>(() =>
    initial
      ? JSON.parse(JSON.stringify(initial))
      : { name: '', hours: Object.fromEntries(DAYS.map(([k]) => [k, k === 'sat' || k === 'sun' ? [] : [{ from: '09:00', to: '17:00' }]])), holidays: [], german_holidays: { enabled: true, state: '' } },
  );
  const [year, setYear] = useState<any>(null);
  const set = (p: any) => setS({ ...s, ...p });
  const setDay = (k: string, iv: { from: string; to: string }[]) => set({ hours: { ...s.hours, [k]: iv } });
  const save = async () => {
    const body = { name: s.name, hours: s.hours, holidays: s.holidays, german_holidays: s.german_holidays };
    const r = await act(() => (initial ? api.put(`/api/telephony/schedules/${initial.id}`, body) : api.post('/api/telephony/schedules', body)), 'Gespeichert');
    if (r) {
      onSaved();
      onClose();
    }
  };
  const showYear = async () => {
    const y = new Date().getFullYear();
    const r = await act(() => api.get(`/api/telephony/schedules/holidays?year=${y}&state=${s.german_holidays.state}`));
    if (r) setYear(r);
  };
  return (
    <Modal
      title={initial ? `Zeitplan: ${initial.name}` : 'Neuer Zeitplan'}
      wide
      onClose={onClose}
      footer={
        <button className="btn" disabled={!s.name.trim()} onClick={save}>
          Speichern
        </button>
      }
    >
      <Field label="Name" hint="Zum Beispiel „Büro“ oder „Support, werktags“.">
        <Input value={s.name} onChange={(v) => set({ name: v })} maxLength={80} />
      </Field>
      <h4 style={{ margin: '4px 0 8px' }}>Öffnungszeiten</h4>
      <div className="tl-days">
        {DAYS.map(([k, label]) => {
          const iv: { from: string; to: string }[] = s.hours[k] ?? [];
          return (
            <div className="tl-day" key={k}>
              <span className="day">
                <Check checked={iv.length > 0} onChange={(on) => setDay(k, on ? [{ from: '09:00', to: '17:00' }] : [])} label={label} />
              </span>
              {iv.map((x, i) => (
                <span className="cr-line" key={i}>
                  <Input type="time" value={x.from} onChange={(v) => setDay(k, iv.map((y, j) => (j === i ? { ...y, from: v } : y)))} aria-label={`${label} von`} />
                  <span className="muted">bis</span>
                  <Input type="time" value={x.to} onChange={(v) => setDay(k, iv.map((y, j) => (j === i ? { ...y, to: v } : y)))} aria-label={`${label} bis`} />
                  {iv.length > 1 && (
                    <button className="icon-btn" aria-label="Zeitraum entfernen" onClick={() => setDay(k, iv.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </span>
              ))}
              {iv.length > 0 && iv.length < 4 && (
                <button className="btn small secondary" onClick={() => setDay(k, [...iv, { from: '13:00', to: '17:00' }])}>
                  ＋ Pause einplanen
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted small">Ein Zeitraum über Mitternacht (22:00 bis 02:00) gilt bis zum nächsten Morgen.</p>
      <h4 style={{ margin: '14px 0 8px' }}>Feiertage</h4>
      <Check checked={s.german_holidays.enabled} onChange={(on) => set({ german_holidays: { ...s.german_holidays, enabled: on } })} label="Gesetzliche Feiertage gelten als geschlossen" />
      {s.german_holidays.enabled && (
        <div className="cr-form-row">
          <Field label="Bundesland" hint="Ohne Auswahl gelten nur die bundesweiten Feiertage.">
            <Select value={s.german_holidays.state} onChange={(v) => set({ german_holidays: { ...s.german_holidays, state: v } })} placeholder="nur bundesweite" options={meta.states.map((x) => [x.code, x.name])} />
          </Field>
          <Field label="Zur Kontrolle">
            <button type="button" className="btn secondary" onClick={showYear}>
              Feiertage dieses Jahres anzeigen
            </button>
          </Field>
        </div>
      )}
      {year && (
        <div className="tl-tags">
          {year.holidays.map((h: any) => (
            <span className="tl-tag" key={h.date}>
              {h.date.slice(8)}.{h.date.slice(5, 7)}. {h.name}
            </span>
          ))}
        </div>
      )}
      <h4 style={{ margin: '14px 0 8px' }}>Eigene Feiertage und Sonderzeiten</h4>
      {s.holidays.map((h: any, i: number) => (
        <div className="tl-holi" key={i}>
          <Input value={h.date} onChange={(v) => set({ holidays: s.holidays.map((x: any, j: number) => (j === i ? { ...x, date: v } : x)) })} placeholder="24-12 oder 2026-12-24" aria-label="Datum" />
          <Input value={h.name} onChange={(v) => set({ holidays: s.holidays.map((x: any, j: number) => (j === i ? { ...x, name: v } : x)) })} placeholder="Name, z. B. Betriebsferien" aria-label="Name" />
          <Check checked={h.closed !== false} onChange={(on) => set({ holidays: s.holidays.map((x: any, j: number) => (j === i ? { ...x, closed: on, intervals: on ? [] : x.intervals?.length ? x.intervals : [{ from: '10:00', to: '14:00' }] } : x)) })} label="geschlossen" />
          <button className="icon-btn" aria-label="Eintrag entfernen" onClick={() => set({ holidays: s.holidays.filter((_: any, j: number) => j !== i) })}>
            ✕
          </button>
          {h.closed === false && (
            <span className="cr-line" style={{ gridColumn: '1 / -1' }}>
              <span className="muted">Sonderzeit</span>
              <Input type="time" value={h.intervals?.[0]?.from ?? '10:00'} onChange={(v) => set({ holidays: s.holidays.map((x: any, j: number) => (j === i ? { ...x, intervals: [{ from: v, to: x.intervals?.[0]?.to ?? '14:00' }] } : x)) })} aria-label="Sonderzeit von" />
              <span className="muted">bis</span>
              <Input type="time" value={h.intervals?.[0]?.to ?? '14:00'} onChange={(v) => set({ holidays: s.holidays.map((x: any, j: number) => (j === i ? { ...x, intervals: [{ from: x.intervals?.[0]?.from ?? '10:00', to: v }] } : x)) })} aria-label="Sonderzeit bis" />
            </span>
          )}
        </div>
      ))}
      <button className="btn small secondary" onClick={() => set({ holidays: [...s.holidays, { date: '', name: '', closed: true, intervals: [] }] })}>
        ＋ Eintrag
      </button>
      <p className="muted small">„24-12“ gilt jedes Jahr, „2026-12-24“ nur einmal. Eigene Einträge gehen den gesetzlichen Feiertagen vor.</p>
    </Modal>
  );
}

function Schedules({ meta, reloadMeta }: { meta: Meta; reloadMeta: () => void }) {
  const list = useLoad(() => api.get<any[]>('/api/telephony/schedules'), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  if (!list.data) return <Spinner />;
  const reload = () => (void list.reload(), reloadMeta());
  return (
    <>
      <Panel
        title="Zeitpläne"
        sub="Wann ist geöffnet – mit Pausen, gesetzlichen Feiertagen und eigenen Sonderzeiten. Ein Telefonmenü fragt den Zeitplan ab und verzweigt."
        wide
        actions={
          <button className="btn" onClick={() => setEdit('new')} data-tour="sched-new">
            <Icon name="plus" size={14} /> Neuer Zeitplan
          </button>
        }
      >
        {list.data.length ? (
          <div className="cr-list">
            {list.data.map((s) => (
              <Item
                key={s.id}
                onClick={() => setEdit(s)}
                side={
                  <>
                    <Badge tone={s.state_now.state === 'open' ? 'green' : 'gray'}>{s.state_now.state === 'open' ? 'jetzt geöffnet' : s.state_now.reason || 'jetzt geschlossen'}</Badge>
                    <button
                      className="icon-btn"
                      aria-label={`${s.name} löschen`}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (confirmAsk(`Zeitplan „${s.name}“ löschen?`) && (await act(() => api.del(`/api/telephony/schedules/${s.id}`), 'Gelöscht'))) reload();
                      }}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </>
                }
              >
                <strong>{s.name}</strong>
                <div className="cr-sub">
                  {DAYS.filter(([k]) => s.hours[k]?.length)
                    .map(([k, l]) => `${l.slice(0, 2)} ${s.hours[k].map((x: any) => `${x.from}–${x.to}`).join(', ')}`)
                    .join(' · ') || 'nie geöffnet'}
                </div>
              </Item>
            ))}
          </div>
        ) : (
          <Empty>Noch kein Zeitplan. Ohne Zeitplan nutzt ein Menü die Geschäftszeiten aus den Telefonie-Einstellungen.</Empty>
        )}
      </Panel>
      {edit && <ScheduleDialog initial={edit === 'new' ? null : edit} meta={meta} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

// --- groups -------------------------------------------------------------------------------------------------------------------

function GroupDialog({ initial, onClose, onSaved }: { initial: any | null; onClose: () => void; onSaved: () => void }) {
  const gm = useLoad(() => api.get('/api/telephony/groups/meta'), []);
  const [g, setG] = useState<any>(() => (initial ? JSON.parse(JSON.stringify(initial)) : null));
  const [numText, setNumText] = useState('');
  const m = gm.data;
  if (!m) return <Modal title="Gruppe" onClose={onClose}><Spinner /></Modal>;
  const cur = g ?? { ...m.default };
  const set = (p: any) => setG({ ...cur, ...p });
  const has = (type: string, id: string) => cur.members.some((x: any) => x.type === type && x.id === id);
  const toggleUser = (u: { id: string; name: string }, on: boolean) => set({ members: on ? [...cur.members, { type: 'user', id: u.id, name: u.name }] : cur.members.filter((x: any) => !(x.type === 'user' && x.id === u.id)) });
  const addNumbers = () => {
    const add = splitList(numText).filter((n) => !has('number', n)).map((n) => ({ type: 'number', id: n, name: n }));
    if (add.length) set({ members: [...cur.members, ...add] });
    setNumText('');
  };
  const move = (i: number, d: number) => {
    const list = [...cur.members];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    set({ members: list });
  };
  const save = async () => {
    const body = { name: cur.name, kind: cur.kind, strategy: cur.strategy, members: cur.members, ring_timeout: cur.ring_timeout, max_wait: cur.max_wait, hold_audio_id: cur.hold_audio_id, announce_position: cur.announce_position, welcome: cur.welcome, overflow: cur.overflow };
    const r = await act(() => (initial ? api.put(`/api/telephony/groups/${initial.id}`, body) : api.post('/api/telephony/groups', body)), 'Gespeichert');
    if (r) {
      onSaved();
      onClose();
    }
  };
  const o = cur.overflow;
  const queue = cur.kind === 'queue';
  const others = (m.users as any[]).length;
  return (
    <Modal
      title={initial ? `Gruppe: ${initial.name}` : 'Neue Ruf-Gruppe oder Warteschlange'}
      wide
      onClose={onClose}
      footer={
        <button className="btn" disabled={!cur.name.trim() || !cur.members.length} onClick={save}>
          Speichern
        </button>
      }
    >
      <div className="cr-form-row">
        <Field label="Name">
          <Input value={cur.name} onChange={(v) => set({ name: v })} maxLength={80} placeholder="z. B. Support" />
        </Field>
        <Field label="Art" hint={queue ? 'Anrufer warten mit Musik, bis jemand frei ist.' : 'Es klingelt einmal in der Runde, dann der Überlauf.'}>
          <Select value={cur.kind} onChange={(v) => set({ kind: v })} options={[['queue', 'Warteschlange (Anrufer warten)'], ['group', 'Ruf-Gruppe (eine Runde)']]} />
        </Field>
        <Field label="Verteilung">
          <Select value={cur.strategy} onChange={(v) => set({ strategy: v })} options={m.strategies.map((s: any) => [s.key, s.label])} />
        </Field>
      </div>
      <h4 style={{ margin: '4px 0 8px' }}>Mitglieder</h4>
      <p className="muted small">Personen klingeln im Browser-Telefon – nur, solange sie dort erreichbar und nicht im Urlaub oder in einem anderen Gespräch sind. Nummern klingeln immer.</p>
      <div className="cr-lines" style={{ marginBottom: 10 }}>
        {m.users.map((u: any) => (
          <Check key={u.id} checked={has('user', u.id)} onChange={(on) => toggleUser(u, on)} label={u.name} />
        ))}
        {!others && <span className="muted small">Noch keine Teammitglieder in diesem Projekt.</span>}
      </div>
      <div className="cr-line">
        <div className="grow">
          <Input value={numText} onChange={setNumText} placeholder="Nummer(n) hinzufügen, z. B. +49151…" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addNumbers())} aria-label="Nummern" />
        </div>
        <button className="btn secondary" onClick={addNumbers} disabled={!numText.trim()}>
          Hinzufügen
        </button>
      </div>
      {cur.members.length > 0 && (
        <ol className="cr-lines" style={{ margin: '10px 0', paddingLeft: 22 }}>
          {cur.members.map((x: any, i: number) => (
            <li key={`${x.type}:${x.id}`}>
              <span className="cr-line">
                <span className="grow">
                  {x.name} <span className="muted small">{x.type === 'user' ? 'Browser-Telefon' : 'Nummer'}</span>
                </span>
                {cur.strategy !== 'simultaneous' && (
                  <>
                    <button className="icon-btn" aria-label="nach oben" onClick={() => move(i, -1)} disabled={i === 0}>
                      ↑
                    </button>
                    <button className="icon-btn" aria-label="nach unten" onClick={() => move(i, 1)} disabled={i === cur.members.length - 1}>
                      ↓
                    </button>
                  </>
                )}
                <button className="icon-btn" aria-label={`${x.name} entfernen`} onClick={() => set({ members: cur.members.filter((_: any, j: number) => j !== i) })}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="cr-form-row">
        <Field label="Klingeldauer pro Versuch (Sekunden)">
          <Input type="number" min={5} max={60} value={cur.ring_timeout} onChange={(v) => set({ ring_timeout: Number(v) })} />
        </Field>
        {queue && (
          <Field label="Längste Wartezeit (Sekunden)" hint="Danach greift der Überlauf.">
            <Input type="number" min={10} max={900} value={cur.max_wait} onChange={(v) => set({ max_wait: Number(v) })} />
          </Field>
        )}
      </div>
      {queue && (
        <>
          <div className="cr-form-row">
            <Field label="Wartemusik" hint="Eigene Musik lädst du im Reiter „Audio“ hoch.">
              <Select value={cur.hold_audio_id} onChange={(v) => set({ hold_audio_id: v })} placeholder="Eingebaute Melodie" options={m.hold_audio.map((a: any) => [a.id, `${a.name} (${a.duration_s} s)`])} />
            </Field>
            <Field label="Begrüßung vor dem Warten (optional)">
              <Input value={cur.welcome} onChange={(v) => set({ welcome: v })} maxLength={500} placeholder="Alle Mitarbeiter sind im Gespräch." />
            </Field>
          </div>
          <Check checked={cur.announce_position} onChange={(v) => set({ announce_position: v })} label="Platz in der Warteschlange ansagen" />
        </>
      )}
      <h4 style={{ margin: '14px 0 8px' }}>{queue ? 'Wenn die Wartezeit um ist oder niemand erreichbar ist' : 'Wenn niemand abnimmt'}</h4>
      <div className="cr-form-row">
        <Field label="Überlauf">
          <Select value={o.kind} onChange={(v) => set({ overflow: { ...o, kind: v } })} options={m.overflows.map((x: any) => [x.key, x.label])} />
        </Field>
        {o.kind === 'number' && (
          <Field label="Nummer">
            <Input value={o.number} onChange={(v) => set({ overflow: { ...o, number: v } })} placeholder="+49…" />
          </Field>
        )}
        {o.kind === 'group' && (
          <GroupPick value={o.group_id} self={initial?.id} onChange={(v) => set({ overflow: { ...o, group_id: v } })} />
        )}
        {o.kind === 'voicemail' && (
          <Field label="Name des Postfachs">
            <Input value={o.box} onChange={(v) => set({ overflow: { ...o, box: v } })} maxLength={60} />
          </Field>
        )}
      </div>
      {(o.kind === 'voicemail' || o.kind === 'hangup' || o.kind === 'number') && (
        <Field label="Ansage dazu (optional)">
          <Textarea value={o.say} onChange={(v) => set({ overflow: { ...o, say: v } })} rows={2} />
        </Field>
      )}
    </Modal>
  );
}

function GroupPick({ value, self, onChange }: { value: string; self?: string; onChange: (v: string) => void }) {
  const list = useLoad(() => api.get<any[]>('/api/telephony/groups'), []);
  return (
    <Field label="Gruppe">
      <Select value={value} onChange={onChange} placeholder="— bitte wählen —" options={(list.data ?? []).filter((x) => x.id !== self).map((x) => [x.id, x.name])} />
    </Field>
  );
}

function GroupStats({ id }: { id: string }) {
  const st = useLoad(() => api.get(`/api/telephony/groups/${id}/stats?days=30`), [id]);
  if (!st.data) return <Spinner />;
  const s = st.data;
  return (
    <SortableGrid id="calls-routing.stats" className="stats" style={{ marginTop: 10 }}>
      <Stat label="Anrufe (30 Tage)" value={s.offered} sub={`${s.answered} angenommen`} />
      <Stat label="Aufgelegt beim Warten" value={s.abandoned} sub={s.overflowed ? `${s.overflowed} über den Überlauf` : undefined} />
      <Stat label="Wartezeit" value={dur(s.avg_wait)} sub={`längste ${dur(s.max_wait)}`} />
      <Stat label="In 20 s angenommen" value={pct(s.service_level)} sub={s.by_member.length ? s.by_member.map((m: any) => `${m.name} ${m.answered}`).join(' · ') : undefined} />
    </SortableGrid>
  );
}

function Groups({ reloadMeta }: { reloadMeta: () => void }) {
  const list = useLoad(() => api.get<any[]>('/api/telephony/groups'), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [stats, setStats] = useState('');
  if (!list.data) return <Spinner />;
  const reload = () => (void list.reload(), reloadMeta());
  return (
    <>
      <Panel
        title="Ruf-Gruppen und Warteschlangen"
        sub="Mehrere Personen oder Nummern für einen Anruf: alle gleichzeitig, der Reihe nach oder reihum. In der Warteschlange hören Anrufer Musik und ihren Platz, bis jemand frei ist."
        wide
        actions={
          <button className="btn" onClick={() => setEdit('new')} data-tour="group-new">
            <Icon name="plus" size={14} /> Neue Gruppe
          </button>
        }
      >
        {list.data.length ? (
          <div className="cr-list">
            {list.data.map((g) => (
              <div key={g.id}>
                <Item
                  onClick={() => setEdit(g)}
                  side={
                    <>
                      {g.waiting > 0 && <Badge tone="yellow">{g.waiting} wartet</Badge>}
                      <button className="btn small secondary" onClick={(e) => (e.stopPropagation(), setStats(stats === g.id ? '' : g.id))}>
                        <Icon name="gauge" size={14} /> Zahlen
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`${g.name} löschen`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (confirmAsk(`„${g.name}“ löschen?`) && (await act(() => api.del(`/api/telephony/groups/${g.id}`), 'Gelöscht'))) reload();
                        }}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  }
                >
                  <strong>{g.name}</strong> <Badge tone={g.kind === 'queue' ? 'blue' : 'gray'}>{g.kind === 'queue' ? 'Warteschlange' : 'Ruf-Gruppe'}</Badge>
                  <div className="cr-sub">
                    {g.members.length} Mitglied{g.members.length === 1 ? '' : 'er'} · {g.members.map((m: any) => m.name).join(', ')}
                    {g.numbers.length > 0 && ` · Nummer ${g.numbers.map((n: any) => n.number).join(', ')}`}
                  </div>
                </Item>
                {stats === g.id && <GroupStats id={g.id} />}
              </div>
            ))}
          </div>
        ) : (
          <Empty>Noch keine Gruppe. Lege ein Team an, das gemeinsam Anrufe annimmt.</Empty>
        )}
      </Panel>
      {edit && <GroupDialog initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

// --- audio --------------------------------------------------------------------------------------------------------------------

const KIND: Record<string, string> = { greeting: 'Ansage', hold: 'Wartemusik', drop: 'Voicemail-Drop' };

function Audio({ reloadMeta }: { reloadMeta: () => void }) {
  const list = useLoad(() => api.get('/api/telephony/audio'), []);
  const file = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState('greeting');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!list.data) return <Spinner />;
  const reload = () => (void list.reload(), reloadMeta());
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return toast('Bitte eine MP3- oder WAV-Datei wählen.');
    setBusy(true);
    const r = await act(() => uploadRaw(`/api/telephony/audio?kind=${kind}&name=${encodeURIComponent(name.trim() || f.name.replace(/\.[^.]+$/, ''))}`, f), 'Hochgeladen');
    setBusy(false);
    if (r) {
      if (file.current) file.current.value = '';
      setName('');
      reload();
    }
  };
  const speak = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/telephony/audio', { kind, name: name.trim() || text.slice(0, 40), text }), 'Aufnahme erzeugt');
    setBusy(false);
    if (r) {
      setText('');
      setName('');
      reload();
    }
  };
  return (
    <div className="cr-panels two">
      <Panel title="Neue Audiodatei" sub="Twilio spielt MP3 und WAV ab. Ansagen für Menüs, Musik für die Warteschlange, Voicemail-Drops für den Power-Dialer." tour="audio-new">
        <Field label="Art">
          <Select value={kind} onChange={setKind} options={Object.entries(KIND)} />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={setName} maxLength={80} placeholder="z. B. Begrüßung Hauptnummer" />
        </Field>
        <Field label="Datei hochladen (MP3 oder WAV)">
          <input ref={file} type="file" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" />
        </Field>
        <button className="btn" disabled={busy} onClick={upload}>
          <Icon name="upload" size={14} /> Hochladen
        </button>
        <hr />
        <Field label="oder aus einem Text sprechen lassen" hint="Nutzt die Stimme aus den Spracheinstellungen. Die Datei ist danach fest gespeichert.">
          <Textarea value={text} onChange={setText} rows={3} maxLength={1500} />
        </Field>
        <button className="btn secondary" disabled={busy || !text.trim()} onClick={speak}>
          <Icon name="audio" size={14} /> Aufnahme erzeugen
        </button>
      </Panel>
      <Panel title="Deine Dateien" sub={list.data.default_hold ? 'Ohne eigene Wartemusik spielt die Warteschlange eine eingebaute Melodie.' : undefined} wide>
        {list.data.audio.length ? (
          <div className="cr-list">
            {list.data.audio.map((a: any) => (
              <Item
                key={a.id}
                side={
                  <button
                    className="icon-btn"
                    aria-label={`${a.name} löschen`}
                    onClick={async () => confirmAsk(`„${a.name}“ löschen?`) && (await act(() => api.del(`/api/telephony/audio/${a.id}`), 'Gelöscht')) && reload()}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                }
              >
                <strong>{a.name}</strong> <Badge>{KIND[a.kind] ?? a.kind}</Badge> <span className="muted small">{a.duration_s} s</span>
                <audio controls preload="none" src={a.url} style={{ display: 'block', width: '100%', maxWidth: 380, marginTop: 6 }} />
                {a.text && <div className="cr-sub">„{a.text.slice(0, 140)}“</div>}
              </Item>
            ))}
          </div>
        ) : (
          <Empty>Noch keine eigenen Dateien.</Empty>
        )}
      </Panel>
    </div>
  );
}

export function CallsRouting({ tab, meta, reloadMeta }: { tab: 'schedules' | 'groups' | 'audio'; meta: Meta; reloadMeta: () => void }) {
  return (
    <>
      {tab === 'schedules' && <Schedules meta={meta} reloadMeta={reloadMeta} />}
      {tab === 'groups' && <Groups reloadMeta={reloadMeta} />}
      {tab === 'audio' && <Audio reloadMeta={reloadMeta} />}
      <Callout>
        Welche Nummer in welches Menü, welche Gruppe oder zu welcher Person führt, stellst du unter <strong>Anrufe → Nummern</strong> ein.
      </Callout>
    </>
  );
}
