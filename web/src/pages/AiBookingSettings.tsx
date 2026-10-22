import { useEffect, useState } from 'react';
import { api } from '../api';
import { Check, Field, Input, Spinner, act, useLoad } from '../ui';
import { useT } from '../i18n';

/**
 * "Termin buchen" for the KI-Assistent's website chat bot, and which calendars the AI may book at all (also the agents at the safety
 * level "Termin buchen" and MCP). Paid calendars and ones with required questions are never offered – they go through the booking page.
 */
export function AiBookingSettings() {
  const t = useT('calview');
  const d = useLoad(() => api.get<any>('/api/ai-booking/settings'), []);
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (d.data) setS(d.data.settings);
  }, [d.data]);
  if (!d.data || !s) return d.error ? <p className="muted">{d.error}</p> : <Spinner />;
  const cals: { id: string; name: string; active: boolean; bookable: boolean }[] = d.data.calendars;
  const all = !s.calendars.length;
  const save = async () => {
    const r = await act(() => api.put('/api/ai-booking/settings', s), t('Gespeichert'));
    if (r) d.setData(r);
  };
  return (
    <div className="card" data-tour="ai-booking">
      <h2>{t('Termine buchen')}</h2>
      <p className="muted small">
        {t(
          'Der Bot sieht freie Zeiten nach denselben Regeln wie die Buchungsseite und der KI-Telefonagent und bucht erst, wenn der Besucher eine Zeit bestätigt und Name und E-Mail genannt hat. Die Bestätigung im Chat enthält Links zum Verschieben und Absagen.',
        )}
      </p>
      <Check checked={!!s.chat_bot} onChange={(v) => setS({ ...s, chat_bot: v })} label={t('Website-Chat-Bot darf Termine buchen („Termin buchen“)')} />
      <Field
        label={t('Kalender, die die KI buchen darf')}
        hint={t('Gilt auch für KI-Agenten mit der Sicherheitsstufe „Termin buchen“ und für MCP. Kostenpflichtige Kalender und solche mit Pflichtfragen bucht die KI nie.')}
      >
        <div className="cv-fcal">
          <Check checked={all} onChange={(v) => setS({ ...s, calendars: v ? [] : cals.filter((c) => c.bookable).map((c) => c.id) })} label={t('Alle passenden Kalender')} />
          {!all &&
            cals.map((c) => (
              <Check
                key={c.id}
                checked={s.calendars.includes(c.id)}
                onChange={(v) => setS({ ...s, calendars: v ? [...s.calendars, c.id] : s.calendars.filter((x: string) => x !== c.id) })}
                label={
                  <>
                    {c.name}
                    {!c.bookable && <span className="muted small"> – {c.active ? t('nur über die Buchungsseite') : t('inaktiv')}</span>}
                  </>
                }
              />
            ))}
        </div>
      </Field>
      <Field label={t('Höchstens Buchungen je Kontakt und Tag')}>
        <Input type="number" min={1} max={10} value={s.per_contact_day} onChange={(v) => setS({ ...s, per_contact_day: Number(v) || 1 })} />
      </Field>
      <button className="btn" onClick={save}>
        {t('Speichern')}
      </button>
    </div>
  );
}
