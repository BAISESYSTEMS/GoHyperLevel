import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, dt, name } from '../api';
import { useT } from '../i18n';
import { Badge, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, toast, useLoad } from '../ui';

/**
 * Outbound AI calls (modules/voice-outbound.ts) under the KI-Telefonagent: daily limit, default caller ID and mailbox text, a test
 * call to one contact and the latest calls with their result. The workflow action "KI-Anruf starten" does the same in bulk.
 * Slot "voiceai.panel".
 */

const TONE: Record<string, 'green' | 'blue' | 'yellow' | 'red' | 'gray'> = { booked: 'green', answered: 'blue', voicemail: 'yellow', no_answer: 'gray' };

function StartModal({ goals, onClose, onDone }: { goals: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const t = useT('voiceout');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [contact, setContact] = useState<any>(null);
  const [goal, setGoal] = useState('qualify');
  const [script, setScript] = useState('');
  useEffect(() => {
    if (q.length < 2) return setFound([]);
    const timer = setTimeout(() => api.get(`/api/contacts?q=${encodeURIComponent(q)}&limit=6`).then((r) => setFound(r.contacts), () => setFound([])), 200);
    return () => clearTimeout(timer);
  }, [q]);
  const start = async () => {
    const r = await act(() => api.post('/api/voice-ai/outbound', { contact_id: contact.id, goal, script }));
    if (!r) return;
    toast(r.status === 'blocked' ? t('Nicht angerufen: {reason}', { reason: r.reason }) : t('Anruf läuft – das Telefon des Kontakts klingelt.'));
    onDone();
  };
  return (
    <Modal
      title={t('KI-Anruf starten')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!contact} onClick={start}>
          <Icon name="callOut" size={14} /> {t('Jetzt anrufen')}
        </button>
      }
    >
      {contact ? (
        <p>
          <strong>{name(contact)}</strong> <span className="muted">{contact.phone}</span>{' '}
          <button className="linkbtn" onClick={() => setContact(null)}>
            {t('ändern')}
          </button>
        </p>
      ) : (
        <>
          <Field label={t('Kontakt')}>
            <Input value={q} onChange={setQ} placeholder={t('Name, E-Mail oder Telefon…')} autoFocus />
          </Field>
          {found.map((c) => (
            <button key={c.id} className="btn small secondary" style={{ display: 'block', marginBottom: 6 }} onClick={() => setContact(c)}>
              {name(c)} <span className="muted">{c.phone || t('keine Nummer')}</span>
            </button>
          ))}
        </>
      )}
      <Field label={t('Ziel')}>
        <Select value={goal} onChange={setGoal} options={Object.entries(goals).map(([k, v]) => [k, t(v)] as [string, string])} />
      </Field>
      <Field label={t('Leitfaden / Prompt')} hint={t('Was der Agent fragen, anbieten oder vermeiden soll. Platzhalter wie {{contact.first_name}} gehen.')}>
        <Textarea value={script} onChange={setScript} rows={4} />
      </Field>
      <p className="muted small">{t('Vorher prüft der Server Nicht stören, Einwilligung (§ 7 UWG – für Werbeanrufe eine bestätigte), Anrufzeiten, Feiertage und das Tageslimit.')}</p>
    </Modal>
  );
}

export function VoiceOutboundPanel() {
  const t = useT('voiceout');
  const data = useLoad(() => api.get<any>('/api/voice-ai/outbound').catch(() => null), []);
  const ids = useLoad(() => api.get<any>('/api/caller-ids').catch(() => null), []);
  const [s, setS] = useState<any>(null);
  const [start, setStart] = useState(false);
  useEffect(() => setS(data.data?.settings ?? null), [data.data]);
  if (!data.data || !s) return data.loading ? <Spinner /> : null;
  const d = data.data;
  const numbers: string[] = [...(ids.data?.twilio_numbers ?? []), ...(ids.data?.caller_ids ?? []).filter((c: any) => c.status === 'verified').map((c: any) => c.number)];
  const save = async () => {
    const r = await act(() => api.put('/api/voice-ai/outbound/settings', s), t('Gespeichert'));
    if (r) data.setData({ ...d, settings: r });
  };
  return (
    <div className="card" data-tour="voice-outbound">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <Icon name="callOut" size={18} /> {t('Ausgehende KI-Anrufe')}
        </h2>
        <button className="btn small" onClick={() => setStart(true)}>
          {t('KI-Anruf starten')}
        </button>
      </div>
      <p className="muted small">{t('Der KI-Telefonagent ruft Kontakte an – zum Qualifizieren, für einen Termin oder als Erinnerung. Im großen Stil über die Workflow-Aktion „KI-Anruf starten“; die Ergebnisse (angenommen, Termin gebucht, nicht erreicht, Mailbox) starten eigene Auslöser.')}</p>
      <div className="grid2">
        <Field label={t('Höchstens Anrufe pro Tag')}>
          <Input type="number" min={0} max={1000} value={s.daily_limit} onChange={(v) => setS({ ...s, daily_limit: Number(v) })} />
        </Field>
        <Field label={t('Absendernummer')} hint={t('Twilio-Nummer oder eine bestätigte eigene Nummer (Einstellungen → Telefonie).')}>
          <Select value={s.caller_id} onChange={(v) => setS({ ...s, caller_id: v })} options={[['', t('Standard')], ...numbers.map((n) => [n, n] as [string, string])]} />
        </Field>
      </div>
      <Field label={t('Mailbox-Nachricht (Standard)')} hint={t('Wird gesprochen, wenn ein Anrufbeantworter abnimmt. Leer = auflegen.')}>
        <Textarea value={s.voicemail_text} onChange={(v) => setS({ ...s, voicemail_text: v })} rows={2} />
      </Field>
      <p>
        <button className="btn secondary" onClick={save}>
          {t('Speichern')}
        </button>{' '}
        <span className="muted small">{t('Heute: {n} von {max}', { n: d.today, max: s.daily_limit })}</span>
      </p>
      {d.calls.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Kontakt')}</th>
                <th>{t('Ziel')}</th>
                <th>{t('Ergebnis')}</th>
                <th>{t('Zusammenfassung')}</th>
                <th>{t('Zeit')}</th>
              </tr>
            </thead>
            <tbody>
              {d.calls.slice(0, 20).map((c: any) => (
                <tr key={c.id}>
                  <td>{c.contact_name || c.to || '–'}</td>
                  <td>{t(c.goal_label)}</td>
                  <td>{c.status === 'blocked' ? <Badge tone="red">{t('nicht angerufen')}</Badge> : c.result ? <Badge tone={TONE[c.result] ?? 'gray'}>{t(c.result_label)}</Badge> : <Badge>{t('läuft')}</Badge>}</td>
                  <td className="small">{c.status === 'blocked' ? c.error : c.summary || <span className="muted">–</span>}</td>
                  <td className="muted small">{dt(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{t('Noch keine ausgehenden KI-Anrufe.')}</Empty>
      )}
      {start && <StartModal goals={d.goals} onClose={() => setStart(false)} onDone={() => (setStart(false), data.reload())} />}
    </div>
  );
}
