import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { useT } from '../i18n';
import { act, Check, confirmAsk, Empty, Field, Input, Modal, Select, Spinner, Textarea, useLoad } from '../ui';
import './call-scripts.css';

/**
 * Call scripts (modules/call-scripts.ts): the panel the browser phone and the power dialer show through the slot `call.panel`
 * (one step at a time, answer buttons follow the branches), and Anrufe → Leitfäden to write them.
 */

interface Step {
  id: string;
  title: string;
  text: string;
  options: { label: string; next: string }[];
}

/** The script for the current call: steps with the contact filled in, answer buttons jump, ← goes back. */
export function CallScriptPanel({ contactId, listId }: { contactId?: string; listId?: string }) {
  const t = useT('callscripts');
  const [pick, setPick] = useState('');
  const qs = new URLSearchParams({ ...(contactId ? { contact_id: contactId } : {}), ...(listId ? { list_id: listId } : {}) }).toString();
  const data = useLoad(() => api.get<any>(`/api/call-scripts/for?${qs}`).catch(() => null), [qs]);
  const other = useLoad(() => (pick ? api.get<any>(`/api/call-scripts`).then((l: any[]) => l.find((s) => s.id === pick)) : Promise.resolve(null)), [pick]);
  const script = (pick && other.data) || data.data?.script;
  const [path, setPath] = useState<string[]>([]);
  useEffect(() => setPath([]), [script?.id, contactId]);
  if (!script) return null;
  const steps: Step[] = script.steps ?? [];
  const cur = steps.find((s) => s.id === path[path.length - 1]) ?? steps[0];
  if (!cur) return null;
  const go = (next: string) => setPath([...path, next || '__end']);
  const ended = path[path.length - 1] === '__end';
  return (
    <section className="cs-panel" aria-label={t('Gesprächsleitfaden')} data-tour="call-script">
      <div className="cs-head">
        <Icon name="doc" size={14} />
        <strong className="grow">{script.name}</strong>
        {(data.data?.others?.length ?? 0) > 0 && (
          <div style={{ width: 150 }}>
            <Select value={pick} onChange={setPick} placeholder={t('Anderer Leitfaden…')} aria={t('Anderen Leitfaden wählen')} options={[...(data.data?.script ? [[data.data.script.id, data.data.script.name] as [string, string]] : []), ...data.data.others.map((o: any) => [o.id, o.name] as [string, string])]} />
          </div>
        )}
      </div>
      {ended ? (
        <p className="cs-text muted">{t('Ende des Leitfadens.')}</p>
      ) : (
        <>
          <div className="cs-step muted small">
            {t('Schritt {n} von {total}', { n: steps.indexOf(cur) + 1, total: steps.length })} · {cur.title}
          </div>
          <div className="cs-text">{cur.text}</div>
          <div className="cs-options">
            {cur.options.map((o, i) => (
              <button key={i} type="button" className="btn small secondary" onClick={() => go(o.next)}>
                {o.label}
              </button>
            ))}
            {!cur.options.length && steps.indexOf(cur) < steps.length - 1 && (
              <button type="button" className="btn small secondary" onClick={() => go(steps[steps.indexOf(cur) + 1].id)}>
                {t('Weiter')} →
              </button>
            )}
          </div>
        </>
      )}
      <div className="cs-foot">
        {path.length > 0 && (
          <button type="button" className="btn small ghost" onClick={() => setPath(path.slice(0, -1))}>
            ← {t('Zurück')}
          </button>
        )}
        {data.data?.scorecard && !pick && (
          <a className="muted small" href="/app/calls/intel">
            {t('Scorecard: {name}', { name: data.data.scorecard.name })}
          </a>
        )}
      </div>
    </section>
  );
}

const blankStep = (n: number): Step => ({ id: `s${Date.now().toString(36)}${n}`, title: '', text: '', options: [] });

function ScriptEditor({ script, onClose, onSaved }: { script?: any; onClose: () => void; onSaved: () => void }) {
  const t = useT('callscripts');
  const lists = useLoad(() => api.get<any[]>('/api/dialer/lists').catch(() => []), []);
  const pipelines = useLoad(() => api.get<any[]>('/api/pipelines'), []);
  const cards = useLoad(() => api.get<any[]>('/api/call-scorecards').catch(() => []), []);
  const [s, setS] = useState<any>(script ?? { name: '', steps: [{ ...blankStep(0), title: t('Begrüßung'), text: t('Hallo {{contact.first_name}}, hier ist … von {{location.name}}. Passt es gerade?'), options: [] }], dialer_list_ids: [], pipeline_ids: [], scorecard_id: '', active: 1 });
  const setStep = (i: number, patch: Partial<Step>) => setS({ ...s, steps: s.steps.map((x: Step, j: number) => (j === i ? { ...x, ...patch } : x)) });
  const toggle = (key: 'dialer_list_ids' | 'pipeline_ids', v: string) => setS({ ...s, [key]: s[key].includes(v) ? s[key].filter((x: string) => x !== v) : [...s[key], v] });
  const save = async () => {
    const body = { name: s.name, steps: s.steps, dialer_list_ids: s.dialer_list_ids, pipeline_ids: s.pipeline_ids, scorecard_id: s.scorecard_id || null, active: !!s.active };
    if (await act(() => (script ? api.patch(`/api/call-scripts/${script.id}`, body) : api.post('/api/call-scripts', body)), t('Leitfaden gespeichert'))) onSaved();
  };
  return (
    <Modal
      title={script ? t('Leitfaden bearbeiten') : t('Neuer Leitfaden')}
      onClose={onClose}
      wide
      footer={
        <button className="btn" disabled={!s.name.trim() || !s.steps.length} onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <Field label={t('Name')}>
        <Input value={s.name} onChange={(name) => setS({ ...s, name })} placeholder={t('z. B. Erstgespräch Webdesign')} />
      </Field>
      <Check checked={!!s.active} onChange={(v) => setS({ ...s, active: v ? 1 : 0 })} label={t('Aktiv')} />
      <Field label={t('Gilt für Power-Dialer-Listen')} hint={t('Nichts gewählt bei Listen und Pipelines = gilt überall, wo kein passenderer Leitfaden ist.')}>
        <div className="opt-toggle">
          {(lists.data ?? []).map((l) => (
            <button type="button" key={l.id} className={s.dialer_list_ids.includes(l.id) ? 'on' : ''} aria-pressed={s.dialer_list_ids.includes(l.id)} onClick={() => toggle('dialer_list_ids', l.id)}>
              {l.name}
            </button>
          ))}
          {!lists.data?.length && <span className="muted small">{t('Noch keine Listen.')}</span>}
        </div>
      </Field>
      <Field label={t('Gilt für Kontakte mit offenem Deal in')}>
        <div className="opt-toggle">
          {(pipelines.data ?? []).map((p) => (
            <button type="button" key={p.id} className={s.pipeline_ids.includes(p.id) ? 'on' : ''} aria-pressed={s.pipeline_ids.includes(p.id)} onClick={() => toggle('pipeline_ids', p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('Scorecard (optional)')} hint={t('Der Leitfaden nennt sie im Gespräch – bewertet wird danach in der Gesprächsauswertung.')}>
        <Select value={s.scorecard_id ?? ''} onChange={(v) => setS({ ...s, scorecard_id: v })} placeholder={t('Keine')} options={(cards.data ?? []).map((c) => [c.id, c.name] as [string, string])} />
      </Field>
      <h4>{t('Schritte')}</h4>
      <p className="muted small">{t('Platzhalter: {{contact.first_name}}, {{contact.last_name}}, {{contact.company}}, {{location.name}}. Antworten springen zu einem Schritt (Verzweigung) oder beenden den Leitfaden.')}</p>
      {s.steps.map((st: Step, i: number) => (
        <div key={st.id} className="cs-edit-step">
          <div className="row" style={{ alignItems: 'center' }}>
            <strong>{i + 1}.</strong>
            <div className="grow">
              <Input value={st.title} onChange={(title) => setStep(i, { title })} placeholder={t('Titel des Schritts')} aria-label={t('Titel des Schritts')} />
            </div>
            <button type="button" className="icon-btn" disabled={s.steps.length < 2} onClick={() => setS({ ...s, steps: s.steps.filter((_: Step, j: number) => j !== i) })} aria-label={t('Schritt {n} entfernen', { n: i + 1 })}>
              ✕
            </button>
          </div>
          <Textarea value={st.text} onChange={(text) => setStep(i, { text })} rows={3} aria-label={t('Text des Schritts')} />
          {st.options.map((o, k) => (
            <div key={k} className="row" style={{ alignItems: 'center' }}>
              <div className="grow">
                <Input value={o.label} onChange={(label) => setStep(i, { options: st.options.map((x, m) => (m === k ? { ...x, label } : x)) })} placeholder={t('Antwort, z. B. Kein Interesse')} aria-label={t('Antwort')} />
              </div>
              <div style={{ width: 200 }}>
                <Select value={o.next} onChange={(next) => setStep(i, { options: st.options.map((x, m) => (m === k ? { ...x, next } : x)) })} aria={t('Weiter zu')} options={[['', t('Ende')], ...s.steps.filter((x: Step) => x.id !== st.id).map((x: Step) => [x.id, `${s.steps.indexOf(x) + 1}. ${x.title || t('Schritt')}`] as [string, string])]} />
              </div>
              <button type="button" className="icon-btn" onClick={() => setStep(i, { options: st.options.filter((_, m) => m !== k) })} aria-label={t('Antwort entfernen')}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn small ghost" onClick={() => setStep(i, { options: [...st.options, { label: '', next: '' }] })}>
            + {t('Antwort')}
          </button>
        </div>
      ))}
      <button type="button" className="btn small secondary" onClick={() => setS({ ...s, steps: [...s.steps, blankStep(s.steps.length)] })}>
        + {t('Schritt')}
      </button>
    </Modal>
  );
}

/** Anrufe → Leitfäden. */
export function CallScripts() {
  const t = useT('callscripts');
  const list = useLoad(() => api.get<any[]>('/api/call-scripts'), []);
  const [edit, setEdit] = useState<any>(null);
  if (!list.data) return <Spinner />;
  return (
    <div data-tour="call-scripts">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          {t('Leitfäden erscheinen im Browser-Telefon und im Power-Dialer – je Liste oder Pipeline, mit Platzhaltern und Verzweigungen.')}
        </p>
        <button className="btn" onClick={() => setEdit({})}>
          + {t('Leitfaden')}
        </button>
      </div>
      {!list.data.length ? (
        <Empty>{t('Noch kein Leitfaden.')}</Empty>
      ) : (
        <table className="t">
          <tbody>
            {list.data.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong> {!s.active && <span className="muted small">({t('inaktiv')})</span>}
                  <div className="muted small">
                    {t('{n} Schritte', { n: s.steps.length })} · {s.dialer_list_ids.length || s.pipeline_ids.length ? t('{l} Listen, {p} Pipelines', { l: s.dialer_list_ids.length, p: s.pipeline_ids.length }) : t('gilt überall')}
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn small secondary" onClick={() => setEdit(s)}>
                    {t('Bearbeiten')}
                  </button>{' '}
                  <button className="icon-btn" onClick={() => confirmAsk(t('Leitfaden „{name}“ löschen?', { name: s.name })) && act(() => api.del(`/api/call-scripts/${s.id}`)).then(list.reload)} aria-label={t('Leitfaden {name} löschen', { name: s.name })}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <ScriptEditor script={edit.id ? edit : undefined} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), list.reload())} />}
    </div>
  );
}
