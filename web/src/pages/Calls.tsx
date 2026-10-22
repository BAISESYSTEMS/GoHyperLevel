import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../icons';
import { api, currentLocation, dt, name } from '../api';
import { useSession } from '../session';
import { Badge, Check, CodeBox, Empty, Field, Input, Link, PageHead, Select, Spinner, Stat, Tabs, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { lazyPages } from '../lazy';
import { CallActions, CallMeta } from './CallsNotes';
import { PhoneDialButton, phoneDial, usePhone } from './Phone';
import { AiCallButton } from './VoiceAi';
import { TicketFromCall } from './Tickets';
import { SignupLink } from '../referrals';
import { MoreFields } from '../areas/fields';
import { SortableGrid } from '../sortable/Sortable';

const { CallsFlows } = lazyPages(() => import('./CallsFlows'), 'CallsFlows');
const { CallsNumbers } = lazyPages(() => import('./CallsNumbers'), 'CallsNumbers');
const { CallsDialer } = lazyPages(() => import('./CallsDialer'), 'CallsDialer');
const { CallsIntel } = lazyPages(() => import('./CallsIntel'), 'CallsIntel');
const { CallScripts } = lazyPages(() => import('./CallScripts'), 'CallScripts');

/** Telephony over Twilio: call log page, click-to-call button, call entries in threads, settings. */

type Tone = 'gray' | 'green' | 'red' | 'blue' | 'yellow';
export const CALL_STATUS: Record<string, [string, Tone]> = {
  initiated: ['wird aufgebaut', 'blue'],
  ringing: ['klingelt', 'blue'],
  'in-progress': ['läuft', 'blue'],
  completed: ['angenommen', 'green'],
  missed: ['verpasst', 'red'],
  voicemail: ['Voicemail', 'yellow'],
  busy: ['besetzt', 'gray'],
  'no-answer': ['nicht erreicht', 'gray'],
  failed: ['fehlgeschlagen', 'red'],
  canceled: ['abgebrochen', 'gray'],
};

export const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function callIcon(c: { direction: string; status: string }): IconName {
  if (c.status === 'voicemail') return 'voicemail';
  if (c.status === 'missed') return 'callMissed';
  return c.direction === 'in' ? 'callIn' : 'callOut';
}

/** Whether click-to-call is set up (one request per sub-account and page load). */
const statusCache = new Map<string, Promise<any>>();
function useCallStatus() {
  const loc = currentLocation();
  const [st, setSt] = useState<any>(null);
  useEffect(() => {
    if (!statusCache.has(loc)) statusCache.set(loc, api.get('/api/calls/status').catch(() => null));
    let live = true;
    void statusCache.get(loc)!.then((v) => live && setSt(v));
    return () => {
      live = false;
    };
  }, [loc]);
  return st;
}
export const resetCallStatus = () => statusCache.clear();

/**
 * Call button: with the browser phone on, the call runs in the browser; otherwise click-to-call
 * (your phone rings first, then Twilio connects the contact). Hidden until telephony is set up.
 */
export function CallButton({ contactId, phone, label = 'Anrufen', onStarted }: { contactId: string; phone?: string; label?: string; onStarted?: () => void }) {
  const st = useCallStatus();
  const browser = usePhone().status === 'ready';
  const [busy, setBusy] = useState(false);
  if ((!st?.ready && !browser) || !phone) return null;
  return (
    <button
      className="btn small secondary"
      disabled={busy}
      title={browser ? `${phone} im Browser anrufen` : `Erst klingelt dein Telefon, dann wird ${phone} verbunden`}
      onClick={async () => {
        if (browser && (await phoneDial(phone, { contactId }))) return onStarted?.();
        setBusy(true);
        const r = await act(() => api.post('/api/calls', { contact_id: contactId }));
        setBusy(false);
        if (r) {
          toast('Dein Telefon klingelt gleich – nimm ab, dann wird verbunden.');
          onStarted?.();
        }
      }}
    >
      <Icon name="phone" size={14} /> {busy ? 'Wählt…' : label}
    </button>
  );
}

/** Extra content for a call entry in a conversation: recording player (fetched once per state). */
const callCache = new Map<string, Promise<any>>();
export function CallInfo({ m }: { m: any }) {
  const [call, setCall] = useState<any>(null);
  const key = `${m.provider_id}:${m.status}:${m.body?.length ?? 0}`;
  const mayHaveRecording = m.status === 'voicemail' || m.status === 'completed';
  useEffect(() => {
    if (!mayHaveRecording || !m.provider_id) return;
    if (!callCache.has(key)) callCache.set(key, api.get(`/api/calls/${encodeURIComponent(m.provider_id)}`).catch(() => null));
    let live = true;
    void callCache.get(key)!.then((c) => live && setCall(c));
    return () => {
      live = false;
    };
  }, [key]);
  if (!call?.has_recording) return null;
  return <Recording call={call} />;
}

function Recording({ call }: { call: any }) {
  return <audio className="call-audio" controls preload="none" src={`${call.recording}?locationId=${encodeURIComponent(currentLocation())}`} />;
}

const TABS: [string, string][] = [
  ['all', 'Alle'],
  ['missed', 'Verpasst'],
  ['voicemail', 'Voicemail'],
  ['out', 'Ausgehend'],
];

/** Pages behind "Anrufe": the log, the telephone menu builder, numbers (buy, route, track), the power dialer and the conversation analysis. */
const TOP: [string, string, boolean][] = [
  ['log', 'Anrufliste', false],
  ['dialer', 'Power-Dialer', false],
  ['intel', 'Gespräche', false],
  ['scripts', 'Leitfäden', true],
  ['ivr', 'Telefonmenü', true],
  ['numbers', 'Nummern', true],
];

export function Calls({ tab, item }: { tab?: string; item?: string }) {
  const session = useSession();
  const canSettings = session.user.role === 'admin' || !session.user.permissions || session.user.permissions.includes('settings');
  const tops = TOP.filter(([, , settings]) => canSettings || !settings);
  const cur = tops.some(([k]) => k === tab) ? tab! : 'log';
  return (
    <>
      <PageHead title="Anrufe" sub="Ein- und ausgehende Anrufe über Twilio – verpasste Anrufe, Telefonmenüs, Nummern, Power-Dialer und Gesprächsauswertung">
        <PhoneDialButton />
        {canSettings && (
          <Link to="settings/telephony" className="btn secondary">
            Einstellungen
          </Link>
        )}
      </PageHead>
      <div style={{ margin: '0 0 12px' }} data-tour="calls-tabs">
        <Tabs tabs={tops.map(([k, l]) => [k, l])} value={cur} onChange={(k) => navigate(k === 'log' ? 'calls' : `calls/${k}`)} />
      </div>
      {cur === 'log' && <CallLog />}
      {cur === 'ivr' && <CallsFlows />}
      {cur === 'numbers' && <CallsNumbers />}
      {cur === 'dialer' && <CallsDialer />}
      {cur === 'intel' && <CallsIntel open={item} />}
      {cur === 'scripts' && <CallScripts />}
    </>
  );
}

function CallLog() {
  const session = useSession();
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const status = useLoad(() => api.get('/api/calls/status').catch(() => null), []);
  const params = new URLSearchParams({ limit: '200', ...(q ? { q } : {}), ...(tab === 'missed' ? { status: 'missed,voicemail', direction: 'in' } : tab === 'voicemail' ? { status: 'voicemail' } : tab === 'out' ? { direction: 'out' } : {}) });
  const list = useLoad(() => api.get(`/api/calls?${params}`), [tab, q]);
  useEffect(() => {
    const t = setInterval(() => void list.reload(), 20000);
    return () => clearInterval(t);
  }, [tab, q]);
  const canSettings = session.user.role === 'admin' || !session.user.permissions || session.user.permissions.includes('settings');
  const st = list.data?.stats;
  return (
    <>
      {status.data && !status.data.ready && (
        <div className="card call-setup" data-tour="calls-setup">
          <strong>
            <Icon name="phone" /> Telefonie ist noch nicht eingerichtet.
          </strong>{' '}
          Es fehlt: {status.data.missing.join(', ')}. {canSettings ? <Link to="settings/telephony">Jetzt einrichten</Link> : 'Bitte die Agentur fragen.'}
        </div>
      )}
      {st && (
        <SortableGrid id="calls-stats" className="stats" data-tour="calls-stats">
          <Stat label={`Anrufe (${st.days} Tage)`} value={st.total} sub={`${st.inbound} eingehend · ${st.outbound} ausgehend`} />
          <Stat label="Verpasst" value={st.missed + st.voicemail} sub={`davon ${st.voicemail} mit Voicemail`} />
          <Stat label="Angenommen" value={st.answered} sub={st.total ? `${Math.round((st.answered / st.total) * 100)} % aller Anrufe` : '–'} />
          <Stat label="Gesprächszeit" value={`${Math.floor(st.talk_seconds / 3600)}:${String(Math.floor((st.talk_seconds % 3600) / 60)).padStart(2, '0')} h`} />
        </SortableGrid>
      )}
      <div className="row" style={{ alignItems: 'center', marginBottom: 10 }}>
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <div style={{ width: 260, marginLeft: 'auto' }} data-tour="calls-search">
          <Input value={q} onChange={setQ} placeholder="Nummer, Name, Transkription…" />
        </div>
      </div>
      {!list.data ? (
        <Spinner />
      ) : list.data.calls.length ? (
        <div className="table-wrap" data-tour="calls-list">
          <table className="t calls">
            <thead>
              <tr>
                <th></th>
                <th>Kontakt</th>
                <th>Status</th>
                <th>Dauer</th>
                <th>Wann</th>
                <th>Voicemail / Aufnahme</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.data.calls.map((c: any) => {
                const [label, tone] = CALL_STATUS[c.status] ?? [c.status, 'gray'];
                const number = c.direction === 'in' ? c.from_number : c.to_number;
                return (
                  <tr key={c.id} className={c.missed ? 'missed' : ''}>
                    <td title={c.direction === 'in' ? 'eingehend' : 'ausgehend'}>
                      <Icon name={callIcon(c)} />
                    </td>
                    <td>
                      {c.contact_id ? <Link to={`contacts/${c.contact_id}`}>{c.contact_name || name(c)}</Link> : <span className="muted">Unbekannt</span>}
                      <div className="muted small">{number || 'Nummer unterdrückt'}</div>
                      <CallMeta c={c} />
                    </td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                      {String(c.reason).startsWith('ai') && (
                        <>
                          {' '}
                          <Badge tone="purple">KI</Badge>
                        </>
                      )}
                      {c.missed && c.reason === 'closed' && <div className="muted small">außerhalb der Zeiten</div>}
                      {c.error && <div className="muted small">{c.error}</div>}
                    </td>
                    <td>{c.answered ? mmss(c.duration) : c.status === 'voicemail' ? mmss(c.recording_duration) : '–'}</td>
                    <td className="muted">{dt(c.started_at)}</td>
                    <td style={{ minWidth: 240 }}>
                      {c.has_recording && <Recording call={c} />}
                      {c.transcription && <div className="small call-transcript">„{c.transcription}“</div>}
                      {String(c.reason).startsWith('ai') && <AiCallButton callId={c.id} />}
                    </td>
                    <td>
                      <div className="actions" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                        {c.contact_id && <CallButton contactId={c.contact_id} phone={c.contact_phone || number} label="Zurückrufen" onStarted={list.reload} />}
                        {c.contact_id && <TicketFromCall call={c} />}
                        <CallActions c={c} onChanged={list.reload} />
                        {c.has_recording && (
                          <button
                            className="icon-btn"
                            title="Aufnahme löschen (auch bei Twilio)"
                            aria-label="Aufnahme löschen"
                            onClick={async () => confirmAsk('Aufnahme endgültig löschen – auch bei Twilio?') && (await act(() => api.del(`/api/calls/${c.id}/recording`), 'Aufnahme gelöscht')) && list.reload()}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{tab === 'all' && !q ? 'Noch keine Anrufe. Anrufe auf deine Twilio-Nummer und Klicks auf „Anrufen“ beim Kontakt landen hier.' : 'Keine Anrufe in dieser Ansicht.'}</Empty>
      )}
    </>
  );
}

// --- settings ------------------------------------------------------------------------

const DAYS: [string, string][] = [
  ['mon', 'Montag'],
  ['tue', 'Dienstag'],
  ['wed', 'Mittwoch'],
  ['thu', 'Donnerstag'],
  ['fri', 'Freitag'],
  ['sat', 'Samstag'],
  ['sun', 'Sonntag'],
];

export function TelephonySettings() {
  const session = useSession();
  const data = useLoad(() => api.get('/api/telephony/settings'), []);
  const [s, setS] = useState<any>();
  const [nums, setNums] = useState<any[] | null>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (data.data) setS({ ...data.data, numbers: data.data.numbers.join(', '), forward_to: data.data.forward_to.join(', ') });
  }, [data.data]);
  if (!s) return <Spinner />;
  const set = (p: any) => setS({ ...s, ...p });
  const setDay = (k: string, p: any) => set({ hours: { ...s.hours, [k]: { ...s.hours[k], ...p } } });
  const tz = session.locations.find((l) => l.id === session.locationId)?.timezone ?? 'Europe/Berlin';
  const save = async () => {
    const { account_sid, auth_token, numbers, forward_to, ring_timeout, hours_mode, hours, greeting, voicemail, max_length, transcribe, record_inbound, record_outbound, record_announce, record_announce_text, retention_recordings_days, retention_voicemail_days, notify_missed, notify_voicemail } = s;
    const r = await act(
      () => api.put('/api/telephony/settings', { account_sid, auth_token, numbers, forward_to, ring_timeout, hours_mode, hours, greeting, voicemail, max_length, transcribe, record_inbound, record_outbound, record_announce, record_announce_text, retention_recordings_days, retention_voicemail_days, notify_missed, notify_voicemail }),
      'Gespeichert',
    );
    if (r) {
      data.setData(r);
      resetCallStatus();
    }
    return r;
  };
  const loadNumbers = async () => {
    setBusy('numbers');
    const r = await act(() => api.get<any[]>('/api/telephony/numbers'));
    setBusy('');
    if (r) setNums(r);
  };
  const d = data.data;
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 380px' }} data-tour="tel-twilio">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>
            <Icon name="phone" size={18} /> Twilio-Zugang <SignupLink id="twilio" />
          </h2>
          {d.ready ? <Badge tone="green">Bereit</Badge> : <Badge tone="yellow">Es fehlt: {d.missing.join(', ')}</Badge>}
        </div>
        <p className="muted small">
          Account SID und Auth Token stehen in der Twilio-Konsole auf der Startseite (deutsche Nummern brauchen einen Adressnachweis).
          {d.uses_sms_credentials && ' Leer gelassen, nutzt die Telefonie die Twilio-Daten aus „E-Mail & SMS“.'}
        </p>
        <Field label="Account SID">
          <Input value={s.account_sid} onChange={(v) => set({ account_sid: v })} placeholder={d.uses_sms_credentials ? 'aus den SMS-Einstellungen' : 'AC…'} autoComplete="off" />
        </Field>
        <Field label="Auth Token" hint="Wird verschlüsselt gespeichert und nie wieder angezeigt.">
          <Input type="password" value={s.auth_token} onChange={(v) => set({ auth_token: v })} placeholder={d.uses_sms_credentials ? 'aus den SMS-Einstellungen' : ''} autoComplete="new-password" />
        </Field>
        <Field label="Twilio-Nummer(n)" hint={d.effective_numbers.length && !s.numbers ? `Aus den SMS-Einstellungen: ${d.effective_numbers.join(', ')}` : 'Mehrere mit Komma trennen; die erste ist Absender bei Klick-Anrufen.'}>
          <Input value={s.numbers} onChange={(v) => set({ numbers: v })} placeholder="+4930…" />
        </Field>
        <div className="actions">
          <button className="btn small secondary" disabled={busy === 'numbers'} onClick={loadNumbers}>
            <Icon name="refresh" size={14} /> Nummern von Twilio laden
          </button>
        </div>
        {nums && (
          <table className="t" style={{ marginTop: 10 }}>
            <tbody>
              {nums.map((n) => (
                <tr key={n.sid}>
                  <td>
                    <strong>{n.phone_number}</strong>
                    <div className="muted small">{n.friendly_name}</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {n.connected ? (
                      <Badge tone="green">verbunden</Badge>
                    ) : (
                      <button
                        className="btn small"
                        onClick={async () => {
                          if (n.voice_url && !confirmAsk(`Diese Nummer zeigt bisher auf ${n.voice_url}. Auf HyperLevel umstellen?`)) return;
                          const r = await act(() => api.post(`/api/telephony/numbers/${n.sid}/connect`), 'Webhooks eingetragen');
                          if (r) {
                            data.setData(r.settings);
                            resetCallStatus();
                            void loadNumbers();
                          }
                        }}
                      >
                        Verbinden
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!nums.length && (
                <tr>
                  <td className="muted">Keine Nummern in diesem Twilio-Konto.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <MoreFields id="tel-webhooks" label="Webhook-Adressen">
          <p className="muted small">„Verbinden“ trägt diese Adressen bei der Nummer ein. Von Hand: Twilio → Phone Numbers → Nummer → Voice Configuration.</p>
          <Field label="A call comes in (Webhook, POST)">
            <CodeBox text={d.webhooks.voice} />
          </Field>
          <Field label="Call status changes (POST)">
            <CodeBox text={d.webhooks.status} />
          </Field>
        </MoreFields>
      </div>

      <div className="card" style={{ flex: '1 1 380px' }} data-tour="tel-incoming">
        <h2>
          <Icon name="callIn" size={18} /> Eingehende Anrufe
        </h2>
        <div className="grid2">
          <Field label="Weiterleiten an (dein Handy)" hint="Mehrere Nummern klingeln gleichzeitig.">
            <Input value={s.forward_to} onChange={(v) => set({ forward_to: v })} placeholder="+49151…" />
          </Field>
          <Field label="Klingeldauer (Sekunden)" hint="Kürzer als deine Handy-Mailbox, sonst nimmt die ab.">
            <Input type="number" value={s.ring_timeout} onChange={(v) => set({ ring_timeout: Number(v) })} min={5} max={60} />
          </Field>
        </div>
        <Field label="Erreichbarkeit">
          <Select
            value={s.hours_mode}
            onChange={(v) => set({ hours_mode: v })}
            options={[
              ['hours', 'Zu Geschäftszeiten weiterleiten, sonst Voicemail'],
              ['always', 'Immer weiterleiten'],
              ['never', 'Nie weiterleiten – immer Voicemail'],
            ]}
          />
        </Field>
        {s.hours_mode === 'hours' && (
          <div className="hours">
            <div className="muted small" style={{ marginBottom: 6 }}>
              Zeitzone: {tz}
            </div>
            {DAYS.map(([k, l]) => (
              <div key={k} className="hours-row">
                <Check checked={!!s.hours[k]?.open} onChange={(v) => setDay(k, { open: v })} label={l} />
                <Input type="time" value={s.hours[k]?.from} onChange={(v) => setDay(k, { from: v })} disabled={!s.hours[k]?.open} aria-label={`${l} von`} />
                <span className="muted">bis</span>
                <Input type="time" value={s.hours[k]?.to} onChange={(v) => setDay(k, { to: v })} disabled={!s.hours[k]?.open} aria-label={`${l} bis`} />
              </div>
            ))}
          </div>
        )}
        <hr />
        <h2 data-tour="tel-voicemail">
          <Icon name="voicemail" size={18} /> Ansage & Voicemail
        </h2>
        <Field label="Ansage, wenn niemand abnimmt" hint="Platzhalter: {{location.name}}. Wird mit deutscher Computerstimme vorgelesen.">
          <Textarea value={s.greeting} onChange={(v) => set({ greeting: v })} rows={3} placeholder={d.default_greeting} />
        </Field>
        <Check checked={s.voicemail} onChange={(v) => set({ voicemail: v })} label="Nach der Ansage eine Voicemail aufnehmen" />
        {s.voicemail && (
          <MoreFields id="tel-voicemail" values={[s.transcribe]}>
            <Field label="Höchstlänge (Sekunden)">
              <Input type="number" value={s.max_length} onChange={(v) => set({ max_length: Number(v) })} min={10} max={600} />
            </Field>
            <Check checked={s.transcribe} onChange={(v) => set({ transcribe: v })} label="Voicemail transkribieren (Twilio, bis 2 Minuten; zuverlässig nur auf Englisch, kostet extra)" />
          </MoreFields>
        )}
        <Check checked={s.notify_voicemail} onChange={(v) => set({ notify_voicemail: v })} label="Team per E-Mail über neue Voicemails informieren" />
        <Check checked={s.notify_missed} onChange={(v) => set({ notify_missed: v })} label="Team auch über verpasste Anrufe ohne Voicemail informieren" />
        <hr />
        <h2>
          <Icon name="callOut" size={18} /> Aufzeichnung
        </h2>
        <p className="muted small">Gespräche nur aufzeichnen, wenn alle Beteiligten zugestimmt haben (§ 201 StGB, DSGVO). Aufnahmen bleiben bei Twilio und lassen sich in der Anrufliste löschen.</p>
        <Check checked={s.record_outbound} onChange={(v) => set({ record_outbound: v })} label="Klick-Anrufe aufzeichnen" />
        <Check checked={s.record_inbound} onChange={(v) => set({ record_inbound: v })} label="Angenommene eingehende Anrufe aufzeichnen" />
        {(s.record_inbound || s.record_outbound) && (
          <div data-tour="tel-notice">
            <Check checked={s.record_announce} onChange={(v) => set({ record_announce: v })} label="Vor der Aufzeichnung ansagen, dass das Gespräch aufgezeichnet wird (empfohlen)" />
            {s.record_announce ? (
              <Field label="Wortlaut des Hinweises" hint="Wird allen Beteiligten vorgelesen, bevor verbunden wird – bei eingehenden Anrufen dem Anrufer, bei ausgehenden der angerufenen Person. Leer: die Standardansage.">
                <Textarea value={s.record_announce_text} onChange={(v) => set({ record_announce_text: v })} rows={3} maxLength={500} placeholder={d.default_record_notice} />
              </Field>
            ) : (
              <p className="voice-warn small">Ohne Hinweis dürfen Gespräche nur aufgezeichnet werden, wenn alle Beteiligten vorher zugestimmt haben (§ 201 StGB). Bei Anrufen aus dem Browser-Telefon und beim Power-Dialer gilt dasselbe.</p>
            )}
          </div>
        )}
        <MoreFields id="tel-retention" label="Automatisch löschen" values={[s.retention_recordings_days, s.retention_voicemail_days]}>
        <div className="grid2">
          <Field label="Aufnahmen löschen nach (Tagen)" hint="0 = nicht automatisch. Die Aufnahme wird auch bei Twilio gelöscht.">
            <Input type="number" min={0} max={3650} value={s.retention_recordings_days} onChange={(v) => set({ retention_recordings_days: Number(v) })} />
          </Field>
          <Field label="Voicemails löschen nach (Tagen)" hint="0 = nicht automatisch.">
            <Input type="number" min={0} max={3650} value={s.retention_voicemail_days} onChange={(v) => set({ retention_voicemail_days: Number(v) })} />
          </Field>
        </div>
        </MoreFields>
      </div>

      <div className="card" style={{ flex: '1 1 100%' }}>
        <div className="actions">
          <button className="btn" onClick={save}>
            Speichern
          </button>
          <button
            className="btn secondary"
            disabled={!d.ready || busy === 'test'}
            title={d.ready ? 'Ruft deine Weiterleitungsnummer an' : 'Erst alles eintragen und speichern'}
            onClick={async () => {
              setBusy('test');
              const r = await act(() => api.post('/api/telephony/test-call'));
              setBusy('');
              if (r) toast('Testanruf gestartet – dein Handy klingelt gleich.');
            }}
          >
            <Icon name="phone" size={14} /> Testanruf an mein Handy
          </button>
          <span className="muted small">Tipp: Workflow-Vorlage „Verpasster Anruf: SMS zurück + Rückruf-Aufgabe“ unter Automationen.</span>
        </div>
      </div>
    </div>
  );
}
