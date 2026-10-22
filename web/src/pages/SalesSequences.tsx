import { Fragment, useRef, useState } from 'react';
import { api, d, dt, name } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { Choice, Section } from './SalesKit';
import { MoreFields } from '../areas/fields';
import { sequenceMoreValues } from '../areas/marketing-fields';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Sequenzen: mehrstufige Ansprache aus dem eigenen Postfach (E-Mail, Aufgabe, Anruf, LinkedIn) mit Wartezeiten innerhalb der
 * Sendezeiten, Platzhaltern, A/B-Varianten, Tageslimit und automatischem Ende bei Antwort, Termin, Deal-Änderung oder Abmeldung.
 */

const DAYS: [string, string][] = [['mon', 'Mo'], ['tue', 'Di'], ['wed', 'Mi'], ['thu', 'Do'], ['fri', 'Fr'], ['sat', 'Sa'], ['sun', 'So']];
const STEP_TYPES: [string, string][] = [['email', 'E-Mail'], ['task', 'Aufgabe'], ['call', 'Anruf'], ['linkedin', 'LinkedIn (manuell)']];
const STATUS: Record<string, [string, 'gray' | 'green' | 'yellow']> = { draft: ['Entwurf', 'gray'], active: ['Aktiv', 'green'], paused: ['Pausiert', 'yellow'] };
const ENROLL_TONE: Record<string, 'blue' | 'yellow' | 'green' | 'gray'> = { active: 'blue', waiting: 'yellow', finished: 'green', stopped: 'gray' };
const ENROLL_LABEL: Record<string, string> = { active: 'Läuft', waiting: 'Wartet auf Aufgabe', finished: 'Durchlaufen', stopped: 'Beendet' };

const blankStep = (type = 'email', first = false): any => ({ type, delay_days: first ? 0 : 2, delay_hours: 0, subject: '', body: '', reply_in_thread: false, variants: [], title: '', note: '', wait: type !== 'email', max_wait_days: 7 });
const blankSeq = () => ({ name: '', description: '', mode: 'marketing', legal_ack: false, steps: [blankStep('email', true), { ...blankStep('email'), delay_days: 3, reply_in_thread: true }], settings: { window: { enabled: true, days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00', tz: '' }, stop_on: { reply: true, meeting: true, stage_change: false, deal_closed: true }, footer: true, shared_mailbox: false } });

const rate = (n: number) => `${n.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;

/** The message fields with the personalisation buttons: clicking one puts the placeholder where the cursor was. */
function useTokenInsert() {
  const last = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const track = (e: { target: EventTarget }) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    // only fields that take text (not the buttons that insert, nor number and time fields)
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) last.current = el;
  };
  const insert = (token: string) => {
    const el = last.current;
    if (!el) return toast('Erst in ein Textfeld klicken, dann den Platzhalter wählen');
    el.focus();
    el.setRangeText(token, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { track, insert };
}

function Tokens({ tokens, insert }: { tokens: string[]; insert: (t: string) => void }) {
  return (
    <div className="tokens" aria-label="Platzhalter einfügen">
      {tokens.map((t) => (
        <button type="button" key={t} onClick={() => insert(t.replace('<feld>', 'feld'))} title="An der Cursor-Position einfügen">
          {t}
        </button>
      ))}
    </div>
  );
}

function StepEditor({ step, index, count, onChange, onRemove, onMove }: { step: any; index: number; count: number; onChange: (s: any) => void; onRemove: () => void; onMove: (dir: number) => void }) {
  const set = (patch: any) => onChange({ ...step, ...patch });
  const isMail = step.type === 'email';
  const setVariant = (i: number, patch: any) => set({ variants: step.variants.map((v: any, j: number) => (j === i ? { ...v, ...patch } : v)) });
  return (
    <div className="step" data-tour="seq-step">
      <div className="step-head">
        <span className="num">{index + 1}</span>
        <div style={{ width: 170 }}>
          <Select value={step.type} onChange={(v) => set({ type: v, wait: v !== 'email' })} options={STEP_TYPES} />
        </div>
        <label className="row" style={{ alignItems: 'center', gap: 6, margin: 0 }}>
          <span className="muted small">{index === 0 ? 'Start nach' : 'Warten'}</span>
          <input type="number" min={0} max={120} value={step.delay_days} onChange={(e) => set({ delay_days: Number(e.target.value) })} style={{ width: 72 }} aria-label="Tage" />
          <span className="muted small">Tagen</span>
          <input type="number" min={0} max={23} value={step.delay_hours} onChange={(e) => set({ delay_hours: Number(e.target.value) })} style={{ width: 72 }} aria-label="Stunden" />
          <span className="muted small">Std.</span>
        </label>
        <span className="grow" />
        <button type="button" className="icon-btn" disabled={!index} onClick={() => onMove(-1)} aria-label="Schritt nach oben">
          ↑
        </button>
        <button type="button" className="icon-btn" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Schritt nach unten">
          ↓
        </button>
        <button type="button" className="icon-btn" disabled={count < 2} onClick={onRemove} aria-label="Schritt entfernen">
          ✕
        </button>
      </div>
      {isMail ? (
        <>
          {index > 0 && <Check checked={step.reply_in_thread} onChange={(v) => set({ reply_in_thread: v })} label="Als Antwort im selben Gespräch senden (ohne neuen Betreff)" />}
          {!step.reply_in_thread && (
            <Field label="Betreff">
              <Input value={step.subject} onChange={(v) => set({ subject: v })} maxLength={300} placeholder="Kurze Frage zu {{contact.company}}" />
            </Field>
          )}
          <Field label="Text">
            <Textarea value={step.body} onChange={(v) => set({ body: v })} rows={6} placeholder={'Hallo {{contact.first_name|}},\n\n…\n\nViele Grüße\n{{user.first_name}}'} />
          </Field>
          {step.variants.map((v: any, i: number) => (
            <div className="variant" key={v.id ?? i}>
              <div className="row" style={{ alignItems: 'center' }}>
                <b>Variante {String.fromCharCode(66 + i)}</b>
                <span className="muted small">Die Hälfte der Personen bekommt diese Fassung; leere Felder übernehmen den Haupttext.</span>
                <button type="button" className="btn small secondary" onClick={() => set({ variants: step.variants.filter((_: any, j: number) => j !== i) })}>
                  Entfernen
                </button>
              </div>
              <Input value={v.subject} onChange={(x) => setVariant(i, { subject: x })} placeholder="Anderer Betreff" aria-label="Betreff der Variante" />
              <Textarea value={v.body} onChange={(x) => setVariant(i, { body: x })} rows={4} placeholder="Anderer Text (optional)" />
            </div>
          ))}
          {step.variants.length < 3 && (
            <button type="button" className="btn small secondary" style={{ marginTop: 8 }} onClick={() => set({ variants: [...step.variants, { label: '', subject: '', body: '' }] })} data-tour="seq-variant">
              + A/B-Variante
            </button>
          )}
        </>
      ) : (
        <>
          <Field label={step.type === 'call' ? 'Anruf-Aufgabe' : step.type === 'linkedin' ? 'LinkedIn-Aufgabe' : 'Aufgabe'}>
            <Input value={step.title} onChange={(v) => set({ title: v })} maxLength={200} placeholder={step.type === 'call' ? 'Kurz anrufen: {{contact.first_name}}' : step.type === 'linkedin' ? 'Auf LinkedIn vernetzen' : 'Karte schicken'} />
          </Field>
          <Field label="Notiz für den Zuständigen">
            <Textarea value={step.note} onChange={(v) => set({ note: v })} rows={3} />
          </Field>
          <Check checked={step.wait} onChange={(v) => set({ wait: v })} label="Die Sequenz wartet, bis die Aufgabe erledigt ist" />
          {step.wait && (
            <label className="row" style={{ alignItems: 'center', gap: 6 }}>
              <span className="muted small">…längstens</span>
              <input type="number" min={1} max={60} value={step.max_wait_days} onChange={(e) => set({ max_wait_days: Number(e.target.value) })} style={{ width: 72 }} aria-label="Höchstens Tage warten" />
              <span className="muted small">Tage</span>
            </label>
          )}
        </>
      )}
    </div>
  );
}

function SequenceEditor({ seq, tokens, onClose, onSaved }: { seq?: any; tokens: string[]; onClose: () => void; onSaved: (s: any) => void }) {
  const [s, setS] = useState<any>(() => (seq ? { ...seq, legal_ack: false, steps: seq.steps.map((x: any) => ({ ...x, variants: x.variants ?? [] })) } : blankSeq()));
  const tk = useTokenInsert();
  const win = s.settings.window;
  const setWin = (p: any) => setS({ ...s, settings: { ...s.settings, window: { ...win, ...p } } });
  const setStop = (p: any) => setS({ ...s, settings: { ...s.settings, stop_on: { ...s.settings.stop_on, ...p } } });
  const hasMail = s.steps.some((x: any) => x.type === 'email');
  const alreadyAcked = seq?.mode === 'individual' && !!seq?.legal_ack_at;
  const save = async () => {
    const body = { name: s.name, description: s.description, mode: s.mode, ...(s.mode === 'individual' && !alreadyAcked ? { legal_ack: s.legal_ack } : {}), steps: s.steps, settings: s.settings };
    const r = await act(() => (seq ? api.patch(`/api/sequences/${seq.id}`, body) : api.post('/api/sequences', body)), 'Sequenz gespeichert');
    if (r) onSaved(r);
  };
  return (
    <Modal
      title={seq ? `Sequenz bearbeiten: ${seq.name}` : 'Neue Sequenz'}
      wide
      className="sales-modal"
      onClose={onClose}
      footer={
        <button className="btn" onClick={save} data-tour="seq-save">
          Speichern
        </button>
      }
    >
      <div onFocusCapture={tk.track}>
        <Field label="Name">
          <Input value={s.name} onChange={(v) => setS({ ...s, name: v })} maxLength={120} placeholder="Neukunden nach Messe" />
        </Field>

        {hasMail && (
          <Section title="Art der Nachrichten" tour="seq-mode">
            <Choice
              name="mode"
              value={s.mode}
              onChange={(v) => setS({ ...s, mode: v })}
              options={[
                { value: 'marketing', label: 'Werbung (mit Einwilligung)', text: 'Läuft durch die Einwilligungsprüfung: wer nicht eingewilligt hat, wird nicht aufgenommen. Jede Mail hat einen Abmeldelink.' },
                { value: 'individual', label: 'Einzelkorrespondenz', text: 'Persönliche 1:1-Mails an Menschen, mit denen du bereits in Kontakt bist – wie von Hand geschrieben.' },
              ]}
            />
            {s.mode === 'individual' && (
              <div className="legal-note" role="note">
                <b>Rechtlicher Hinweis.</b> Einzelkorrespondenz geht ohne Einwilligungsprüfung raus. Das ist nur zulässig, wenn die Mails wirklich persönliche Korrespondenz sind: ein bestehender Geschäftskontakt, ein konkreter Anlass, ein auf die Person zugeschnittener Text. Massenhaft versendete, gleichlautende Werbung fällt auch dann unter das Wettbewerbs- und Datenschutzrecht (UWG, DSGVO). „Nicht stören“, Abmeldungen und der Abmeldelink gelten weiterhin. Du trägst die Verantwortung für diese Einstufung – sie wird mit deinem Namen festgehalten. Das ist keine Rechtsberatung.
                {alreadyAcked ? (
                  <p className="muted small">Bestätigt am {d(seq.legal_ack_at)}.</p>
                ) : (
                  <Check checked={s.legal_ack} onChange={(v) => setS({ ...s, legal_ack: v })} label="Ich bestätige: Diese Mails sind persönliche 1:1-Korrespondenz und ich verantworte die Einstufung." />
                )}
              </div>
            )}
          </Section>
        )}

        <Section title="Schritte" tour="seq-steps">
          <Tokens tokens={tokens} insert={tk.insert} />
          <div className="steps">
            {s.steps.map((st: any, i: number) => (
              <StepEditor
                key={st.id ?? i}
                step={st}
                index={i}
                count={s.steps.length}
                onChange={(x) => setS({ ...s, steps: s.steps.map((y: any, j: number) => (j === i ? x : y)) })}
                onRemove={() => setS({ ...s, steps: s.steps.filter((_: any, j: number) => j !== i) })}
                onMove={(dir) => {
                  const steps = [...s.steps];
                  [steps[i], steps[i + dir]] = [steps[i + dir], steps[i]];
                  setS({ ...s, steps });
                }}
              />
            ))}
          </div>
          {s.steps.length < 20 && (
            <div className="sales-bar" style={{ marginTop: 10 }}>
              {STEP_TYPES.map(([k, l]) => (
                <button type="button" key={k} className="btn secondary" onClick={() => setS({ ...s, steps: [...s.steps, blankStep(k)] })}>
                  + {l}
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* Einfach-Modus: description, send window and stop rules keep their good defaults behind one toggle */}
        <MoreFields id="seq-settings" label="Beschreibung, Sendezeiten & Ende der Sequenz" values={sequenceMoreValues(s)}>
          <Field label="Beschreibung (optional)">
            <Input value={s.description} onChange={(v) => setS({ ...s, description: v })} maxLength={500} />
          </Field>
          <Section title="Sendezeiten" tour="seq-window">
            <Check checked={win.enabled} onChange={(v) => setWin({ enabled: v })} label="Nur innerhalb dieser Zeiten senden (außerhalb wartet der Schritt bis zum nächsten Fenster)" />
            {win.enabled && (
              <>
                <div className="days" role="group" aria-label="Wochentage">
                  {DAYS.map(([k, l]) => (
                    <label key={k} className={win.days.includes(k) ? 'on' : ''}>
                      <input type="checkbox" checked={win.days.includes(k)} onChange={(e) => setWin({ days: e.target.checked ? [...win.days, k] : win.days.filter((x: string) => x !== k) })} />
                      {l}
                    </label>
                  ))}
                </div>
                <div className="grid2" style={{ marginTop: 8 }}>
                  <Field label="Von">
                    <Input type="time" value={win.from} onChange={(v) => setWin({ from: v })} />
                  </Field>
                  <Field label="Bis">
                    <Input type="time" value={win.to} onChange={(v) => setWin({ to: v })} />
                  </Field>
                </div>
                <Field label="Zeitzone (leer = die des Sub-Accounts)">
                  <Input value={win.tz} onChange={(v) => setWin({ tz: v })} placeholder="Europe/Berlin" />
                </Field>
              </>
            )}
          </Section>

          <Section title="Wann endet die Sequenz für eine Person?" tour="seq-stop">
            <Check checked={s.settings.stop_on.reply} onChange={(v) => setStop({ reply: v })} label="Sie antwortet" />
            <Check checked={s.settings.stop_on.meeting} onChange={(v) => setStop({ meeting: v })} label="Sie bucht einen Termin" />
            <Check checked={s.settings.stop_on.stage_change} onChange={(v) => setStop({ stage_change: v })} label="Ein Deal der Person wechselt die Phase" />
            <Check checked={s.settings.stop_on.deal_closed} onChange={(v) => setStop({ deal_closed: v })} label="Ein Deal der Person wird gewonnen oder verloren" />
            <p className="muted small">Abmeldung, „Nicht stören“ und widerrufene Einwilligung beenden die Sequenz immer.</p>
            {hasMail && (
              <>
                {s.mode === 'marketing' ? (
                  <p className="muted small">Eine Serie setzt den Abmeldelink immer unter jede Mail. Nur „Einzelkorrespondenz“ darf ihn weglassen.</p>
                ) : (
                  <Check checked={s.settings.footer} onChange={(v) => setS({ ...s, settings: { ...s.settings, footer: v } })} label="Abmeldelink unter jede Mail setzen" />
                )}
                <Check checked={s.settings.shared_mailbox} onChange={(v) => setS({ ...s, settings: { ...s.settings, shared_mailbox: v } })} label="Ohne eigenes Postfach aus dem gemeinsamen Postfach des Sub-Accounts senden" />
              </>
            )}
          </Section>
        </MoreFields>
      </div>
    </Modal>
  );
}

function EnrollDialog({ seq, onClose, onDone }: { seq: any; onClose: () => void; onDone: () => void }) {
  const tags = useLoad(() => api.get<any[]>('/api/tags'), []);
  const lists = useLoad(() => api.get<any[]>('/api/smart-lists'), []);
  const [by, setBy] = useState<'tag' | 'list'>('tag');
  const [tag, setTag] = useState('');
  const [list, setList] = useState('');
  const [res, setRes] = useState<any>();
  const go = async () => {
    const r = await act(() => api.post(`/api/sequences/${seq.id}/enroll`, by === 'tag' ? { tag, source: `Tag ${tag}` } : { smart_list_id: list, source: 'Liste' }));
    if (r) setRes(r);
  };
  return (
    <Modal title={`Kontakte aufnehmen: ${seq.name}`} className="sales-modal" onClose={onClose} footer={res ? <button className="btn" onClick={onDone}>Fertig</button> : <button className="btn" disabled={by === 'tag' ? !tag : !list} onClick={go}>Aufnehmen</button>}>
      {!res ? (
        <>
          <p className="muted">Die Mails gehen aus deinem Postfach, in deinen Sendezeiten. Kontakte ohne E-Mail-Adresse, mit „Nicht stören“ oder (bei Werbung) ohne Einwilligung werden übersprungen und genannt.</p>
          <Select value={by} onChange={(v) => setBy(v as 'tag' | 'list')} options={[['tag', 'Kontakte mit einem Tag'], ['list', 'Gespeicherte Liste']]} />
          {by === 'tag' ? <Select value={tag} onChange={setTag} placeholder="Tag wählen…" options={(tags.data ?? []).map((t: any) => t.name)} /> : <Select value={list} onChange={setList} placeholder="Liste wählen…" options={(lists.data ?? []).map((l: any) => [l.id, l.name] as [string, string])} />}
        </>
      ) : (
        <>
          <p>
            <b>{res.enrolled}</b> aufgenommen{res.skipped?.length ? `, ${res.skipped.length} übersprungen` : ''}.
          </p>
          {res.skipped?.slice(0, 20).map((x: any) => (
            <div key={x.contact_id} className="small muted">
              {x.reason}
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

function StepStats({ seq }: { seq: any }) {
  return (
    <div className="table-wrap">
      <table className="sales-table">
        <thead>
          <tr>
            <th>Schritt</th>
            <th className="r">Gesendet</th>
            <th className="r">Geöffnet</th>
            <th className="r">Antworten</th>
          </tr>
        </thead>
        <tbody>
          {seq.stats.steps.map((st: any, i: number) => {
            const def = seq.steps.find((x: any) => x.id === st.id);
            return (
              <Fragment key={st.id}>
                <tr>
                  <td>
                    {i + 1}. {STEP_TYPES.find(([k]) => k === st.type)?.[1]}
                    <div className="muted small">{def?.subject || def?.title || '(Antwort im Gespräch)'}</div>
                  </td>
                  <td className="r">{st.type === 'email' ? st.sent : `${st.tasks} Aufgaben`}</td>
                  <td className="r">{st.type === 'email' ? st.opened : '–'}</td>
                  <td className="r">{st.type === 'email' ? st.replied : '–'}</td>
                </tr>
                {st.variants.length > 1 &&
                  st.variants.map((v: any) => (
                    <tr key={`${st.id}-${v.id}`}>
                      <td className="muted small" style={{ paddingLeft: 28 }}>
                        {v.label}
                      </td>
                      <td className="r small">{v.sent}</td>
                      <td className="r small">
                        {v.opened} <span className="muted">({rate(v.open_rate)})</span>
                      </td>
                      <td className="r small">
                        {v.replied} <span className="muted">({rate(v.reply_rate)})</span>
                      </td>
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SequenceDetail({ id, tokens, onClose, onChanged }: { id: string; tokens: string[]; onClose: () => void; onChanged: () => void }) {
  const seq = useLoad(() => api.get<any>(`/api/sequences/${id}`), [id]);
  const [status, setStatus] = useState('');
  const enr = useLoad(() => api.get<any[]>(`/api/sequences/${id}/enrollments${status ? `?status=${status}` : ''}`), [id, status]);
  const [edit, setEdit] = useState(false);
  const [enroll, setEnroll] = useState(false);
  const s = seq.data;
  if (!s) return <Modal title="Sequenz" className="sales-modal" onClose={onClose}>{seq.error ? <p className="error">{seq.error}</p> : <Spinner />}</Modal>;
  if (edit) return <SequenceEditor seq={s} tokens={tokens} onClose={() => setEdit(false)} onSaved={() => (setEdit(false), seq.reload(), onChanged())} />;
  if (enroll) return <EnrollDialog seq={s} onClose={() => setEnroll(false)} onDone={() => (setEnroll(false), seq.reload(), enr.reload(), onChanged())} />;
  const st = s.stats;
  const [label, tone] = STATUS[s.status] ?? ['', 'gray'];
  const setState = async (next: string) => (await act(() => api.patch(`/api/sequences/${id}`, { status: next }), next === 'active' ? 'Sequenz ist aktiv' : 'Sequenz pausiert')) && (seq.reload(), onChanged());
  return (
    <Modal
      title={s.name}
      wide
      className="sales-modal"
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={async () => confirmAsk('Sequenz mit allen Aufnahmen und Zahlen löschen?') && (await act(() => api.del(`/api/sequences/${id}`), 'Gelöscht')) && (onChanged(), onClose())}>
            Löschen
          </button>
          <button className="btn secondary" onClick={() => setEdit(true)}>
            Bearbeiten
          </button>
          <button className="btn secondary" disabled={s.status !== 'active'} onClick={() => setEnroll(true)} data-tour="seq-enroll">
            Kontakte aufnehmen
          </button>
          {s.status === 'active' ? (
            <button className="btn" onClick={() => setState('paused')}>
              Pausieren
            </button>
          ) : (
            <button className="btn" onClick={() => setState('active')} data-tour="seq-activate">
              Aktivieren
            </button>
          )}
        </>
      }
    >
      <div className="sales-bar">
        <Badge tone={tone}>{label}</Badge>
        <Badge tone={s.mode === 'individual' ? 'purple' : 'blue'}>{s.mode === 'individual' ? 'Einzelkorrespondenz' : 'Werbung'}</Badge>
        {s.mode === 'individual' && s.legal_ack_at && <span className="muted small">bestätigt am {d(s.legal_ack_at)}</span>}
      </div>
      <SortableGrid id="seq-stats" className="sales-stats" data-tour="seq-stats">
        <div><b>{st.enrolled}</b><span>Aufgenommen · {st.active + st.waiting} aktiv</span></div>
        <div><b>{st.sent}</b><span>E-Mails gesendet</span></div>
        <div><b>{rate(st.open_rate)}</b><span>Öffnungen (nur echte Personen)</span></div>
        <div><b>{rate(st.reply_rate)}</b><span>Antworten · {st.replied}</span></div>
        <div><b>{rate(st.meeting_rate)}</b><span>Termine · {st.meetings}</span></div>
      </SortableGrid>
      {st.sent > 0 && st.open_tracking.on < st.open_tracking.senders && <p className="note-box warn">Öffnungen werden nur gezählt, wenn im Postfach der Absender „Öffnungen und Klicks verfolgen“ eingeschaltet ist (Einstellungen → E-Mail &amp; SMS).</p>}
      {Object.keys(st.stopped_by).length > 0 && (
        <p className="muted small">
          Beendet wegen: {Object.entries(st.stopped_by).map(([k, n]) => `${s.stop_labels[k] ?? k} (${n})`).join(' · ')}
        </p>
      )}
      <Section title="Schritte">
        <StepStats seq={s} />
      </Section>
      <Section
        title="Aufnahmen"
        actions={
          <div style={{ width: 200 }}>
            <Select value={status} onChange={setStatus} placeholder="Alle" options={Object.entries(ENROLL_LABEL)} />
          </div>
        }
      >
        {!enr.data ? (
          <Spinner />
        ) : enr.data.length === 0 ? (
          <Empty>Noch niemand in dieser Sequenz.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="sales-table stack">
              <thead>
                <tr>
                  <th>Kontakt</th>
                  <th>Status</th>
                  <th>Nächster Schritt</th>
                  <th>Absender</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {enr.data.map((e: any) => (
                  <tr key={e.id}>
                    <td data-label="Kontakt">
                      <a href={`/app/contacts/${e.contact_id}`}>{name(e)}</a>
                      <div className="muted small">{e.email}</div>
                    </td>
                    <td data-label="Status">
                      <Badge tone={ENROLL_TONE[e.status]}>{ENROLL_LABEL[e.status]}</Badge>
                      {e.stop_label && <div className="muted small">{e.stop_label}</div>}
                    </td>
                    <td data-label="Nächster Schritt">{e.status === 'active' ? `Schritt ${e.step_index + 1} von ${e.step_total} · ${dt(e.next_at)}` : e.status === 'waiting' ? e.note : '–'}</td>
                    <td data-label="Absender">{e.user_name ?? '–'}</td>
                    <td className="r">
                      {(e.status === 'active' || e.status === 'waiting') && (
                        <button className="btn small secondary" onClick={async () => (await act(() => api.post(`/api/sequence-enrollments/${e.id}/stop`, {}), 'Beendet')) && (enr.reload(), seq.reload())}>
                          Beenden
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Modal>
  );
}

export function SalesSequences() {
  const list = useLoad(() => api.get<any[]>('/api/sequences'), []);
  const cfg = useLoad(() => api.get<any>('/api/sequence-settings'), []);
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [limit, setLimit] = useState<string>('');
  const tokens: string[] = cfg.data?.tokens ?? [];
  const mb = cfg.data?.my_mailbox;
  return (
    <div data-tour="seq-list">
      <div className="sales-bar">
        {mb && (
          <span className="muted">
            {mb.connected ? (
              <>
                Dein Postfach: <b>{mb.address}</b> {mb.tracking ? '· Öffnungen werden gezählt' : '· Öffnungs-Verfolgung aus'}
              </>
            ) : (
              <>
                Du hast noch kein Postfach verbunden – <a href="/app/settings">Einstellungen → E-Mail &amp; SMS</a>. Sequenzen mit E-Mails senden aus deinem eigenen Postfach.
              </>
            )}
          </span>
        )}
        <span className="grow" />
        <button className="btn" onClick={() => setCreate(true)} data-tour="seq-new">
          + Neue Sequenz
        </button>
      </div>
      {cfg.data?.can_configure && (
        <div className="sales-bar">
          <label className="row" style={{ alignItems: 'center', gap: 8, margin: 0 }}>
            <span className="muted">Tageslimit je Person (E-Mails aus Sequenzen):</span>
            <input type="number" min={0} max={cfg.data.max_daily_limit} value={limit === '' ? cfg.data.daily_limit : limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 96 }} aria-label="Tageslimit" />
          </label>
          <button className="btn secondary" disabled={limit === ''} onClick={async () => (await act(() => api.put('/api/sequence-settings', { daily_limit: Number(limit) }), 'Tageslimit gespeichert')) && (setLimit(''), cfg.reload())}>
            Speichern
          </button>
        </div>
      )}
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty action={<button className="btn" onClick={() => setCreate(true)}>Erste Sequenz anlegen</button>}>Mit Sequenzen sprichst du neue Kontakte in mehreren Schritten an – E-Mail, Anruf, LinkedIn – und hörst automatisch auf, sobald jemand antwortet.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="sales-table stack">
            <thead>
              <tr>
                <th>Sequenz</th>
                <th>Status</th>
                <th className="r">Schritte</th>
                <th className="r">Aufgenommen</th>
                <th className="r">Gesendet</th>
                <th className="r">Antworten</th>
                <th className="r">Termine</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="click" onClick={() => setOpen(s.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(s.id)}>
                  <td data-label="Sequenz">
                    <b>{s.name}</b>
                    {s.mode === 'individual' && <span className="muted small"> · Einzelkorrespondenz</span>}
                  </td>
                  <td data-label="Status">
                    <Badge tone={STATUS[s.status]?.[1] ?? 'gray'}>{STATUS[s.status]?.[0]}</Badge>
                  </td>
                  <td className="r" data-label="Schritte">{s.steps}</td>
                  <td className="r" data-label="Aufgenommen">
                    {s.enrolled} <span className="muted small">({s.active} aktiv)</span>
                  </td>
                  <td className="r" data-label="Gesendet">{s.sent}</td>
                  <td className="r" data-label="Antworten">{s.replied}</td>
                  <td className="r" data-label="Termine">{s.meetings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {create && <SequenceEditor tokens={tokens} onClose={() => setCreate(false)} onSaved={(s) => (setCreate(false), list.reload(), setOpen(s.id))} />}
      {open && <SequenceDetail id={open} tokens={tokens} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </div>
  );
}

/** For the contact page: put this person into a running sequence. */
export function EnrollContact({ contactId, onClose, onDone }: { contactId: string; onClose: () => void; onDone: () => void }) {
  const list = useLoad(() => api.get<any[]>('/api/sequences'), []);
  const [sid, setSid] = useState('');
  const active = (list.data ?? []).filter((s) => s.status === 'active');
  const go = async () => {
    const r = await act(() => api.post(`/api/sequences/${sid}/enroll`, { contact_ids: [contactId], source: 'Kontaktseite' }));
    if (!r) return;
    if (r.enrolled) toast('In die Sequenz aufgenommen');
    else toast(`Nicht aufgenommen: ${r.skipped?.[0]?.reason ?? 'unbekannt'}`);
    onDone();
  };
  return (
    <Modal title="In Sequenz aufnehmen" className="sales-modal" onClose={onClose} footer={<button className="btn" disabled={!sid} onClick={go}>Aufnehmen</button>}>
      {!list.data ? <Spinner /> : active.length === 0 ? <p className="muted">Es gibt noch keine aktive Sequenz. Lege unter Vertrieb → Sequenzen eine an und aktiviere sie.</p> : <Select value={sid} onChange={setSid} placeholder="Sequenz wählen…" options={active.map((s) => [s.id, s.name] as [string, string])} />}
    </Modal>
  );
}
