import { useState } from 'react';
import { api } from '../api';
import { Check, Field, Input, Link, Select, Textarea, useLoad } from '../ui';
import './quickwins.css';

/** Calendar editor parts for Calendly-style booking rules: limits, date-specific hours, several reminders, follow-up and no-show messages. All of it lives in the calendar's settings. */

type SetS = (patch: Record<string, any>) => void;
type Windows = [string, string][];

export function LimitsEditor({ s, setS }: { s: any; setS: SetS }) {
  return (
    <div className="qw-box" data-tour="calendar-limits">
      <h3>Buchungslimits</h3>
      <p className="muted small">Ist das Limit erreicht, verschwindet der Tag (oder die ganze Woche) von der Buchungsseite – abgesagte Termine zählen nicht. 0 = unbegrenzt. Gilt für Einzeltermine; Team-Typen richten sich nach den Zeiten ihrer Mitglieder.</p>
      <div className="grid2">
        <Field label="Höchstens … Buchungen pro Tag">
          <Input type="number" min={0} max={500} value={s.limit_day ?? 0} onChange={(v) => setS({ limit_day: Number(v) || 0 })} />
        </Field>
        <Field label="Höchstens … Buchungen pro Woche (Mo–So)">
          <Input type="number" min={0} max={500} value={s.limit_week ?? 0} onChange={(v) => setS({ limit_week: Number(v) || 0 })} />
        </Field>
      </div>
    </div>
  );
}

/** Holidays (a closed day) and extra hours (other windows on one day) – they replace the weekly hours of that date. */
export function OverridesEditor({ s, setS }: { s: any; setS: SetS }) {
  const ov: Record<string, Windows> = s.date_overrides ?? {};
  const [day, setDay] = useState('');
  const set = (next: Record<string, Windows>) => setS({ date_overrides: next });
  const days = Object.keys(ov).sort();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="qw-box" data-tour="calendar-overrides">
      <h3>Abweichende Tage</h3>
      <p className="muted small">Feiertage, Urlaub oder Sonderöffnungszeiten für einzelne Daten. Sie ersetzen die Wochenzeiten an diesem Tag; vergangene Tage räumt die App selbst auf.</p>
      {days.map((d) => {
        const w = ov[d];
        const closed = w.length === 0;
        return (
          <div className="override-row" key={d}>
            <strong>{new Date(`${d}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })}</strong>
            <Select value={closed ? 'closed' : 'hours'} onChange={(v) => set({ ...ov, [d]: v === 'closed' ? [] : [['09:00', '17:00']] })} options={[['closed', 'Geschlossen (z. B. Feiertag)'], ['hours', 'Andere Zeiten']]} />
            {!closed && (
              <span className="override-windows">
                {w.map((win, i) => (
                  <span className="row" key={i} style={{ alignItems: 'center', gap: 4 }}>
                    <input type="time" value={win[0]} aria-label="von" onChange={(e) => set({ ...ov, [d]: w.map((x, j) => (j === i ? [e.target.value, x[1]] : x)) })} />–
                    <input type="time" value={win[1]} aria-label="bis" onChange={(e) => set({ ...ov, [d]: w.map((x, j) => (j === i ? [x[0], e.target.value] : x)) })} />
                    <button type="button" className="icon-btn" disabled={w.length < 2} aria-label="Zeitfenster entfernen" onClick={() => set({ ...ov, [d]: w.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  </span>
                ))}
                <button type="button" className="btn small ghost" onClick={() => set({ ...ov, [d]: [...w, ['13:00', '17:00']] })}>
                  + Zeitfenster
                </button>
              </span>
            )}
            <button type="button" className="icon-btn" aria-label={`${d} entfernen`} onClick={() => set(Object.fromEntries(Object.entries(ov).filter(([k]) => k !== d)))}>
              ✕
            </button>
          </div>
        );
      })}
      <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
        <input type="date" value={day} min={today} aria-label="Datum" onChange={(e) => setDay(e.target.value)} />
        <button type="button" className="btn small secondary" disabled={!day || day < today || !!ov[day]} onClick={() => (set({ ...ov, [day]: [] }), setDay(''))}>
          + Tag hinzufügen
        </button>
      </div>
    </div>
  );
}

/** Several reminders (24 h and 1 h before …), each by e-mail and/or SMS. Without a list the calendar keeps its single "Erinnerung" of before. */
export function RemindersEditor({ s, setS }: { s: any; setS: SetS }) {
  const loc = useLoad(() => api.get('/api/location').catch(() => null), []);
  const provider = loc.data?.settings?.sms?.provider;
  const smsReady = !!provider && provider !== 'log';
  const list: any[] = s.reminders ?? (Number(s.reminder_hours) > 0 ? [{ hours: Number(s.reminder_hours), email: true, sms: false }] : []);
  const set = (next: any[]) => setS({ reminders: next, reminder_hours: next.length ? Math.max(...next.map((r) => Number(r.hours) || 0)) : 0 });
  const free = [24, 1, 48, 2, 72, 4, 12].find((h) => !list.some((r) => Number(r.hours) === h)) ?? 6;
  return (
    <div className="qw-box" data-tour="calendar-reminders">
      <h3>Erinnerungen</h3>
      <p className="muted small">
        Bis zu 5, z. B. 24 Stunden und 1 Stunde vorher – per E-Mail und/oder SMS. Wurde der Termin erst nach dem Erinnerungszeitpunkt gebucht, entfällt diese Erinnerung; fallen mehrere zusammen, geht nur die nächste raus.
        {!smsReady && (
          <>
            {' '}
            Kein SMS-Anbieter eingerichtet – SMS werden erst gesendet, wenn er unter <Link to="settings/channels">Einstellungen</Link> verbunden ist.
          </>
        )}
      </p>
      {list.map((r, i) => (
        <div className="reminder-row" key={i}>
          <span className="row" style={{ alignItems: 'center', gap: 6 }}>
            <input type="number" min={0.25} max={720} step={0.25} value={r.hours} aria-label="Stunden vorher" onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, hours: Number(e.target.value) } : x)))} />
            <span>Std. vorher</span>
          </span>
          <Check checked={!!r.email} onChange={(v) => set(list.map((x, j) => (j === i ? { ...x, email: v } : x)))} label="E-Mail" />
          <Check checked={!!r.sms} onChange={(v) => set(list.map((x, j) => (j === i ? { ...x, sms: v } : x)))} label={smsReady ? 'SMS' : 'SMS (kein Anbieter)'} />
          <button type="button" className="icon-btn" aria-label="Erinnerung entfernen" onClick={() => set(list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      {list.length < 5 && (
        <button type="button" className="btn small secondary" onClick={() => set([...list, { hours: free, email: true, sms: false }])}>
          + Erinnerung
        </button>
      )}
      {list.length > 0 && (
        <>
          <Field label="E-Mail: Betreff">
            <Input value={s.reminder_subject} onChange={(v) => setS({ reminder_subject: v })} />
          </Field>
          <Field label="E-Mail: Text">
            <Textarea value={s.reminder_body} onChange={(v) => setS({ reminder_body: v })} rows={5} />
          </Field>
          <Field label="SMS: Text" hint="Kurz halten (bis 480 Zeichen). Leer = Standardtext mit Termin und Verwaltungslink.">
            <Textarea value={s.reminder_sms_body} onChange={(v) => setS({ reminder_sms_body: v })} rows={2} maxLength={480} placeholder="Erinnerung: {{calendar.name}} am {{appointment.start_text}}. Absagen/verschieben: {{appointment.manage_url}}" />
          </Field>
        </>
      )}
    </div>
  );
}

const AFTER = {
  followup: {
    title: 'Nachfassen nach dem Termin',
    hint: 'Eine Danke-Nachricht einige Stunden nach dem Ende – für bestätigte und als „erschienen“ markierte Termine, nicht für abgesagte oder verpasste. Gilt erst für Termine, die nach dem Einschalten enden. „Nicht stören“ wird beachtet.',
    subject: 'Danke für den Termin: {{calendar.name}}',
    body: 'Hallo {{contact.first_name|du}},\n\nvielen Dank für unseren Termin „{{calendar.name}}“ am {{appointment.start_text}}. Wenn du Fragen hast, antworte einfach auf diese Nachricht.\n\n{{location.name}}',
    sms: 'Danke für den Termin „{{calendar.name}}“ am {{appointment.start_text}}. Bei Fragen melde dich gern. {{location.name}}',
  },
  noshow: {
    title: 'Nicht erschienen',
    hint: 'Geht sofort raus, wenn du einen Termin auf „nicht erschienen“ setzt – einmal je Termin, mit dem Link für eine neue Buchung ({{appointment.booking_url}}). „Nicht stören“ wird beachtet.',
    subject: 'Schade, wir haben dich vermisst',
    body: 'Hallo {{contact.first_name|du}},\n\nbei deinem Termin „{{calendar.name}}“ am {{appointment.start_text}} haben wir dich leider nicht erreicht. Hier kannst du einen neuen Termin buchen: {{appointment.booking_url}}\n\n{{location.name}}',
    sms: 'Wir haben dich beim Termin am {{appointment.start_text}} vermisst. Neuen Termin buchen: {{appointment.booking_url}} – {{location.name}}',
  },
} as const;

/** Follow-up after the appointment, and the message for no-shows. */
export function AfterEditor({ kind, s, setS }: { kind: 'followup' | 'noshow'; s: any; setS: SetS }) {
  const d = AFTER[kind];
  const v = s[kind] ?? { enabled: false, hours: kind === 'followup' ? 2 : 0, email: true, sms: false, subject: '', body: '', sms_body: '' };
  const set = (patch: Record<string, any>) => setS({ [kind]: { ...v, ...patch } });
  return (
    <div className="qw-box" data-tour={`calendar-${kind}`}>
      <h3>{d.title}</h3>
      <p className="muted small">{d.hint}</p>
      <Check checked={!!v.enabled} onChange={(x) => set({ enabled: x })} label={kind === 'followup' ? 'Nachfass-Nachricht senden' : 'Nachricht an Kontakte senden, die nicht erschienen sind'} />
      {v.enabled && (
        <>
          {kind === 'followup' && (
            <Field label="Stunden nach dem Ende des Termins">
              <Input type="number" min={0} max={720} step={0.5} value={v.hours} onChange={(x) => set({ hours: Number(x) })} />
            </Field>
          )}
          <div className="row" style={{ gap: 16 }}>
            <Check checked={v.email !== false} onChange={(x) => set({ email: x })} label="E-Mail" />
            <Check checked={!!v.sms} onChange={(x) => set({ sms: x })} label="SMS (nur mit eingerichtetem SMS-Anbieter und Telefonnummer)" />
          </div>
          <Field label="E-Mail: Betreff">
            <Input value={v.subject} onChange={(x) => set({ subject: x })} placeholder={d.subject} />
          </Field>
          <Field label="E-Mail: Text">
            <Textarea value={v.body} onChange={(x) => set({ body: x })} rows={5} placeholder={d.body} />
          </Field>
          {v.sms && (
            <Field label="SMS: Text">
              <Textarea value={v.sms_body} onChange={(x) => set({ sms_body: x })} rows={2} maxLength={480} placeholder={d.sms} />
            </Field>
          )}
        </>
      )}
    </div>
  );
}
