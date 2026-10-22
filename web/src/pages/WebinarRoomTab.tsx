import { useEffect, useState } from 'react';
import { api } from '../api';
import { Check, Field, Input, Select, Textarea, act, useLoad } from '../ui';
import { Section, fmtDuration, parseMoment } from './WebinarKit';
import type { TabProps } from './WebinarTabs';

/** The editor tabs "Raum & Angebot" and "Erinnerungen". */

/** A moment in the video as text (mm:ss); the value is kept in seconds. */
function MomentInput({ value, max, onChange, label }: { value: number; max: number; onChange: (s: number) => void; label: string }) {
  const [text, setText] = useState(fmtDuration(value));
  useEffect(() => setText((t) => (parseMoment(t) === value ? t : fmtDuration(value))), [value]);
  const bad = parseMoment(text) === null || (max > 0 && (parseMoment(text) ?? 0) > max);
  return (
    <input
      value={text}
      aria-label={label}
      aria-invalid={bad}
      className={bad ? 'wb-bad' : undefined}
      placeholder="mm:ss"
      inputMode="numeric"
      onChange={(e) => {
        setText(e.target.value);
        const n = parseMoment(e.target.value);
        if (n !== null && (max <= 0 || n <= max)) onChange(n);
      }}
      onBlur={() => setText(fmtDuration(value))}
    />
  );
}

export function RoomTab({ form, set, w }: TabProps) {
  const room = form.settings.room;
  const offer = form.settings.offer;
  const dur = form.duration_s ?? 0;
  const products = useLoad(() => api.get<any[]>('/api/products').catch(() => []), []);
  const forms = useLoad(() => api.get<any[]>('/api/forms').catch(() => []), []);
  const [offset, setOffset] = useState('0:00');
  const target = offer.target ?? { type: 'url', url: '' };
  const newId = () => Math.random().toString(36).slice(2, 10);

  const preview = async () => {
    const r = await act(() => api.post(`/api/webinars/${w.id}/preview-link`, { offset_s: parseMoment(offset) ?? 0 }));
    if (r?.url) window.open(r.url, '_blank', 'noopener');
  };

  return (
    <>
      <Section title="Raum" hint="Die Bezeichnung lässt sich ändern – nur nie in „live“ (irreführend nach § 5 UWG).">
        <div className="grid2">
          <Field label="Bezeichnung im Raum">
            <Input value={room.label} onChange={(v) => set('settings.room.label', v)} placeholder="Automatisiertes Webinar" />
          </Field>
          <Field label="Bezeichnung der Aufzeichnung">
            <Input value={room.replay_label} onChange={(v) => set('settings.room.replay_label', v)} placeholder="Aufzeichnung" />
          </Field>
        </div>
        <Field label="Text im Warteraum">
          <Textarea value={room.waiting_text} onChange={(v) => set('settings.room.waiting_text', v)} rows={2} />
        </Field>
        <Field label="Text nach dem Ende">
          <Textarea value={room.ended_text} onChange={(v) => set('settings.room.ended_text', v)} rows={2} />
        </Field>
        <div className="actions" data-tour="webinar-preview">
          <Field label="Raum testen ab Minute">
            <div className="row" style={{ alignItems: 'center' }}>
              <input value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="mm:ss" style={{ width: 90 }} aria-label="Startminute der Vorschau" />
              <button type="button" className="btn secondary" onClick={preview}>
                Vorschau öffnen ↗
              </button>
            </div>
          </Field>
        </div>
        <p className="muted small">Die Vorschau zeigt den gespeicherten Stand, zählt nichts und speichert nichts.</p>
      </Section>

      <Section title="Fragen, Zähler und Hinweise" tour="webinar-room">
        <Check checked={room.questions} onChange={(v) => set('settings.room.questions', v)} label="Zuschauer:innen können dem Team Fragen stellen (landen in Konversationen, Kanal „Chat“)" />
        <Check checked={room.show_counter} onChange={(v) => set('settings.room.show_counter', v)} label="Zähler „Personen im Raum“ anzeigen – es ist immer die echte Zahl, es gibt keine Möglichkeit, sie zu beschönigen" />
        <Check checked={room.scripted_enabled} onChange={(v) => set('settings.room.scripted_enabled', v)} label="Automatische Chat-Nachrichten zu bestimmten Zeitpunkten einblenden" />
        {room.scripted_enabled && (
          <div className="wb-list">
            <p className="muted small">Jede dieser Nachrichten trägt im Raum den festen Hinweis „Automatische Nachricht“ – sie sehen nie aus wie Beiträge echter Zuschauer.</p>
            {room.scripted.map((m: any, i: number) => (
              <div className="wb-line wb-top" key={m.id ?? i}>
                <MomentInput label="Zeitpunkt" value={m.at_s} max={dur} onChange={(s) => set(`settings.room.scripted.${i}.at_s`, s)} />
                <input value={m.name} placeholder="Name" aria-label="Name" style={{ width: 120 }} onChange={(e) => set(`settings.room.scripted.${i}.name`, e.target.value)} />
                <input className="grow" value={m.text} placeholder="Nachricht" aria-label="Nachricht" onChange={(e) => set(`settings.room.scripted.${i}.text`, e.target.value)} />
                <button type="button" className="icon-btn" aria-label="Entfernen" onClick={() => set('settings.room.scripted', room.scripted.filter((_: any, j: number) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn small secondary" onClick={() => set('settings.room.scripted', [...room.scripted, { id: newId(), at_s: 0, name: 'Team', text: '' }])}>
              + Nachricht
            </button>
          </div>
        )}
      </Section>

      <Section title="Umfragen" hint="Eine Frage mit Antworten, die zum gewählten Zeitpunkt im Raum erscheint. Jede Person kann einmal antworten; das Ergebnis ist echt.">
        <div className="wb-list">
          {room.polls.map((p: any, i: number) => (
            <div className="card wb-poll" key={p.id ?? i}>
              <div className="wb-line wb-top">
                <MomentInput label="Zeitpunkt" value={p.at_s} max={dur} onChange={(s) => set(`settings.room.polls.${i}.at_s`, s)} />
                <input className="grow" value={p.question} placeholder="Frage" aria-label="Frage" onChange={(e) => set(`settings.room.polls.${i}.question`, e.target.value)} />
                <button type="button" className="icon-btn" aria-label="Umfrage entfernen" onClick={() => set('settings.room.polls', room.polls.filter((_: any, j: number) => j !== i))}>
                  ✕
                </button>
              </div>
              <Field label="Antworten (eine pro Zeile)">
                <Textarea value={(p.options ?? []).join('\n')} rows={3} onChange={(v) => set(`settings.room.polls.${i}.options`, v.split('\n'))} />
              </Field>
              <div className="row">
                <Check checked={p.multiple} onChange={(v) => set(`settings.room.polls.${i}.multiple`, v)} label="Mehrere Antworten möglich" />
                <Check checked={p.show_results} onChange={(v) => set(`settings.room.polls.${i}.show_results`, v)} label="Ergebnis nach der Antwort zeigen" />
              </div>
            </div>
          ))}
          <button type="button" className="btn small secondary" onClick={() => set('settings.room.polls', [...room.polls, { id: newId(), at_s: 0, question: '', options: ['', ''], multiple: false, show_results: true }])}>
            + Umfrage
          </button>
        </div>
      </Section>

      <Section title="Angebot" tour="webinar-offer" hint="Ein Button, der zum gewählten Zeitpunkt über dem Video erscheint – zum Produkt, zu einem Formular oder zu einem Link.">
        <Check checked={offer.enabled} onChange={(v) => set('settings.offer.enabled', v)} label="Angebot im Raum einblenden" />
        {offer.enabled && (
          <>
            <div className="grid2">
              <Field label="Erscheint bei">
                <MomentInput label="Zeitpunkt des Angebots" value={offer.at_s} max={dur} onChange={(s) => set('settings.offer.at_s', s)} />
              </Field>
              <Field label="Text auf dem Button">
                <Input value={offer.button_text} onChange={(v) => set('settings.offer.button_text', v)} />
              </Field>
            </div>
            <Field label="Titel">
              <Input value={offer.title} onChange={(v) => set('settings.offer.title', v)} />
            </Field>
            <Field label="Beschreibung">
              <Textarea value={offer.text} onChange={(v) => set('settings.offer.text', v)} rows={2} />
            </Field>
            <div className="grid2">
              <Field label="Führt zu">
                <Select value={target.type} onChange={(v) => set('settings.offer.target', v === 'product' ? { type: 'product', product_id: '' } : v === 'form' ? { type: 'form', form_id: '' } : { type: 'url', url: '' })} options={[['product', 'Produkt (Kaufseite)'], ['form', 'Formular / Bestellformular'], ['url', 'Link']]} />
              </Field>
              <Field label={target.type === 'product' ? 'Produkt' : target.type === 'form' ? 'Formular' : 'Adresse'}>
                {target.type === 'product' && <Select value={target.product_id} placeholder="Produkt wählen …" onChange={(v) => set('settings.offer.target.product_id', v)} options={(products.data ?? []).map((p: any) => [p.id, p.name] as [string, string])} />}
                {target.type === 'form' && <Select value={target.form_id} placeholder="Formular wählen …" onChange={(v) => set('settings.offer.target.form_id', v)} options={(forms.data ?? []).map((f: any) => [f.id, f.name] as [string, string])} />}
                {target.type === 'url' && <Input value={target.url} placeholder="https://…" onChange={(v) => set('settings.offer.target.url', v)} />}
              </Field>
            </div>
            <Field label="Frist in Minuten (0 = keine)" hint="Die Frist ist echt: danach funktioniert der Button für niemanden mehr, auch nicht in der Aufzeichnung.">
              <Input type="number" min={0} value={Math.round((offer.countdown_s ?? 0) / 60)} onChange={(v) => set('settings.offer.countdown_s', Math.max(0, Number(v) || 0) * 60)} />
            </Field>
            <Check checked={offer.show_in_replay} onChange={(v) => set('settings.offer.show_in_replay', v)} label="Auch in der Aufzeichnung zeigen (solange die Frist läuft)" />
          </>
        )}
      </Section>

      <Section title="Aufzeichnung" hint="Nach dem Ende können Angemeldete das Webinar frei ansehen und vorspulen – mit dem Hinweis „Aufzeichnung“.">
        <Check checked={form.settings.replay.enabled} onChange={(v) => set('settings.replay.enabled', v)} label="Aufzeichnung anbieten" />
        {form.settings.replay.enabled && (
          <Field label="Verfügbar nach dem Ende für (Stunden)">
            <Input type="number" min={1} value={form.settings.replay.hours} onChange={(v) => set('settings.replay.hours', Math.max(1, Number(v) || 48))} />
          </Field>
        )}
      </Section>
    </>
  );
}

const UNITS: [string, string, number][] = [
  ['m', 'Minuten', 1],
  ['h', 'Stunden', 60],
  ['d', 'Tage', 1440],
];
const split = (min: number): [number, string] => (min && min % 1440 === 0 ? [min / 1440, 'd'] : min && min % 60 === 0 ? [min / 60, 'h'] : [min, 'm']);
const MERGE = '{{contact.first_name|du}} · {{webinar.title}} · {{session.start_text}} · {{session.start_time}} · {{join_url}} · {{ics_url}} · {{cancel_url}} · {{replay_url}} · {{location.name}}';

export function RemindersTab({ form, set }: TabProps) {
  const rem = form.settings.reminders;
  return (
    <>
      <Section title="Bestätigung" hint={`Geht sofort nach der Anmeldung raus – mit Kalenderdatei (.ics) und dem persönlichen Link zum Raum. Platzhalter: ${MERGE}`}>
        <Field label="Betreff">
          <Input value={rem.confirmation_subject} onChange={(v) => set('settings.reminders.confirmation_subject', v)} />
        </Field>
        <Field label="Text">
          <Textarea value={rem.confirmation_body} rows={10} onChange={(v) => set('settings.reminders.confirmation_body', v)} />
        </Field>
      </Section>
      <Section title="Erinnerungen" tour="webinar-reminders" hint="Jede Erinnerung geht einmal je Anmeldung raus – nie für Zeitpunkte, die vor der Anmeldung lagen. SMS nur an Personen, die der SMS-Erinnerung zugestimmt haben. „Nicht stören“ gilt für E-Mail und SMS.">
        {rem.items.map((r: any, i: number) => {
          const [n, unit] = split(r.offset_min);
          const put = (patch: Record<string, unknown>) => Object.entries(patch).forEach(([k, v]) => set(`settings.reminders.items.${i}.${k}`, v));
          return (
            <div className="card wb-rem" key={r.key}>
              <div className="wb-line wb-top">
                <b>{r.offset_min === 0 ? 'Beim Start' : 'Vor dem Start'}</b>
                <input type="number" min={0} value={n} aria-label="Anzahl" style={{ width: 80 }} onChange={(e) => put({ offset_min: Math.max(0, Number(e.target.value) || 0) * (UNITS.find((u) => u[0] === unit)?.[2] ?? 1) })} />
                <Select value={unit} onChange={(u) => put({ offset_min: n * (UNITS.find((x) => x[0] === u)?.[2] ?? 1) })} options={UNITS.map(([k, l]) => [k, l] as [string, string])} />
                <Check checked={r.email} onChange={(v) => put({ email: v })} label="E-Mail" />
                <Check checked={r.sms} onChange={(v) => put({ sms: v })} label="SMS" />
                <span className="grow" />
                <button type="button" className="icon-btn" aria-label="Erinnerung entfernen" onClick={() => set('settings.reminders.items', rem.items.filter((_: any, j: number) => j !== i))}>
                  ✕
                </button>
              </div>
              <details>
                <summary>Texte ansehen und ändern</summary>
                <Field label="Betreff">
                  <Input value={r.subject} onChange={(v) => put({ subject: v })} />
                </Field>
                <Field label="E-Mail-Text">
                  <Textarea value={r.body} rows={6} onChange={(v) => put({ body: v })} />
                </Field>
                <Field label="SMS-Text (höchstens 320 Zeichen)">
                  <Textarea value={r.sms_text} rows={2} onChange={(v) => put({ sms_text: v })} />
                </Field>
              </details>
            </div>
          );
        })}
        <button
          type="button"
          className="btn small secondary"
          disabled={rem.items.length >= 8}
          onClick={() => {
            const base = rem.items[1] ?? rem.items[0];
            set('settings.reminders.items', [...rem.items, { key: `r${Date.now().toString(36)}`, offset_min: 30, email: true, sms: false, subject: base?.subject ?? '', body: base?.body ?? '', sms_text: base?.sms_text ?? '' }]);
          }}
        >
          + Erinnerung
        </button>
      </Section>
    </>
  );
}
