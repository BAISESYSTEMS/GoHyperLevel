import { useMemo, useRef, useState } from 'react';
import { DEFAULT_SCHEDULE, upcomingSessions, type Schedule } from '../../../server/services/webinar-schedule';
import { MoreFields } from '../areas/fields';
import { webinarMoreValues } from '../areas/marketing-fields';
import { api, currentLocation } from '../api';
import { useTags } from '../tags';
import { Check, CodeBox, Field, Input, Select, TagInput, Textarea, Badge, toast, toastError, useLoad } from '../ui';
import { Section, WEEKDAYS, fileDuration, fmtDuration, fmtSession, parseDuration, videoLabel, zones } from './WebinarKit';

/** The editor tabs Grunddaten, Termine and Anmeldung. They edit `form` (the webinar as the editor holds it) through `set(path, value)`. */

export interface TabProps {
  form: any;
  set: (path: string, value: unknown) => void;
  w: any;
}

// --- Grunddaten ----------------------------------------------------------------------------------------

const SOURCES: [string, string][] = [
  ['upload', 'Datei hochladen'],
  ['url', 'Link (MP4, WebM oder HLS)'],
  ['youtube', 'YouTube'],
  ['vimeo', 'Vimeo'],
  ['studio', 'Video-Studio'],
];

const kindOf = (v: any) => (v?.type === 'studio_clip' || v?.type === 'studio_upload' ? 'studio' : v?.type && v.type !== 'none' ? v.type : '');

function VideoPicker({ form, set, w, reload }: TabProps & { reload: () => void }) {
  const [kind, setKind] = useState<string>(kindOf(form.video) || 'upload');
  const [progress, setProgress] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const assets = useLoad(() => api.get('/api/webinars/studio-assets').catch(() => ({ clips: [], uploads: [] })), []);
  const v = form.video ?? { type: 'none' };

  const upload = async (f: File) => {
    try {
      const secs = await fileDuration(f);
      setProgress(0);
      const start = await api.post(`/api/webinars/${w.id}/video/upload`, { name: f.name, size: f.size });
      for (let off = 0; off < f.size; off += start.chunk_size) {
        const r = await fetch(`/api/webinars/${w.id}/video/upload/${start.id}?offset=${off}`, { method: 'PUT', headers: { 'x-pghl': '1', 'x-location-id': currentLocation(), 'content-type': 'application/octet-stream' }, body: f.slice(off, off + start.chunk_size), credentials: 'same-origin' });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).error || `Fehler ${r.status}`);
        setProgress(Math.min(1, (off + start.chunk_size) / f.size));
      }
      if (secs && !form.duration_s) set('duration_s', secs);
      toast('Video hochgeladen');
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setProgress(null);
      if (file.current) file.current.value = '';
    }
  };

  return (
    <div data-tour="webinar-video">
      <Field label="Videoquelle" hint="Das Video läuft zum Termin ab – für alle Angemeldeten zur gleichen Zeit, niemand kann vorspulen.">
        <Select value={kind} onChange={(k) => (setKind(k), k !== kindOf(v) && set('video', { type: 'none' }))} options={SOURCES} />
      </Field>
      {kind === 'upload' && (
        <Field label="Videodatei" hint="MP4, MOV, WebM, MKV oder Ogg. Große Dateien werden in Teilen hochgeladen.">
          <div className="row" style={{ alignItems: 'center' }}>
            <input ref={file} type="file" accept="video/*,.mkv" disabled={progress !== null} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            {progress !== null && <progress value={progress} max={1} style={{ width: 160 }} aria-label="Fortschritt" />}
          </div>
          {v.type === 'upload' && <small className="muted">Aktuell: {videoLabel(v)}</small>}
        </Field>
      )}
      {kind === 'url' && (
        <Field label="Video-Link" hint="Direkter https-Link auf eine MP4/WebM-Datei oder eine HLS-Playlist (.m3u8). Chrome und Firefox spielen HLS nur mit dem optionalen hls.js ab – siehe docs/webinars.md.">
          <Input value={v.type === 'url' ? v.url : ''} placeholder="https://…/webinar.mp4" onChange={(url) => set('video', { type: 'url', url })} />
        </Field>
      )}
      {(kind === 'youtube' || kind === 'vimeo') && (
        <Field label={kind === 'youtube' ? 'YouTube-Link oder Video-ID' : 'Vimeo-Link oder Video-ID'} hint="Eingebettete Videos starten bei der richtigen Sekunde, werden aber nicht nachgeregelt – für den genauen Ablauf ist eine Datei besser.">
          <Input value={v.type === kind ? (v.id ?? '') : ''} placeholder={kind === 'youtube' ? 'https://youtu.be/…' : 'https://vimeo.com/…'} onChange={(id) => set('video', { type: kind, id })} />
        </Field>
      )}
      {kind === 'studio' && (
        <Field label="Aus dem Video-Studio" hint="Fertige Clips und Uploads dieses Sub-Accounts.">
          <Select
            value={v.type === 'studio_clip' ? `clip:${v.clip_id}` : v.type === 'studio_upload' ? `up:${v.upload_id}` : ''}
            placeholder="Video wählen …"
            onChange={(x) => {
              const [t, id] = x.split(':');
              const clip = (assets.data?.clips ?? []).find((c: any) => c.id === id);
              if (t === 'clip') {
                set('video', { type: 'studio_clip', clip_id: id, title: clip?.title ?? '' });
                if (clip?.duration_s && !form.duration_s) set('duration_s', clip.duration_s);
              } else if (t === 'up') set('video', { type: 'studio_upload', upload_id: id, name: (assets.data?.uploads ?? []).find((u: any) => u.id === id)?.name ?? '' });
            }}
            options={[
              ...(assets.data?.clips ?? []).map((c: any) => [`clip:${c.id}`, `Clip: ${c.title || c.id}`] as [string, string]),
              ...(assets.data?.uploads ?? []).map((u: any) => [`up:${u.id}`, `Upload: ${u.name}`] as [string, string]),
            ]}
          />
        </Field>
      )}
    </div>
  );
}

export function BasicsTab({ form, set, w, reload }: TabProps & { reload: () => void }) {
  const [dur, setDur] = useState<string | null>(null);
  const shown = dur ?? (form.duration_s ? fmtDuration(form.duration_s) : '');
  return (
    <>
      <Section title="Das Webinar">
        <Field label="Titel *" tour="webinar-title">
          <Input value={form.title} onChange={(v) => set('title', v)} maxLength={160} />
        </Field>
        <Field label="Beschreibung" hint="Erscheint auf der Anmeldeseite. Leerzeilen trennen Absätze.">
          <Textarea value={form.description} onChange={(v) => set('description', v)} rows={5} />
        </Field>
        <Field label="Vortragende:r">
          <Input value={form.presenter_name} onChange={(v) => set('presenter_name', v)} placeholder="Erika Muster" />
        </Field>
        <MoreFields id="webinar-basics" values={webinarMoreValues(form, DEFAULT_SCHEDULE).basics}>
          <Field label="Foto (Link)" hint="https-Adresse eines Bildes, z. B. aus der Mediathek.">
            <Input value={form.presenter_photo} onChange={(v) => set('presenter_photo', v)} placeholder="https://…/foto.jpg" />
          </Field>
          <Field label="Adresse der Anmeldeseite" hint="Nur Kleinbuchstaben, Ziffern und Bindestriche.">
            <div className="row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
              <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{location.origin}/w/</span>
              <Input value={form.slug} onChange={(v) => set('slug', v)} />
            </div>
          </Field>
        </MoreFields>
      </Section>
      <Section title="Video" tour="webinar-source">
        <VideoPicker form={form} set={set} w={w} reload={reload} />
        <Field label="Dauer" hint="Minuten oder mm:ss, z. B. 45 oder 45:30. Bei Dateien liest die Seite sie selbst aus.">
          <div data-tour="webinar-duration">
            <Input
              value={shown}
              placeholder="45:00"
              onChange={(v) => {
                setDur(v);
                const n = parseDuration(v);
                if (n !== null) set('duration_s', n);
                else if (v.trim() === '') set('duration_s', 0);
              }}
            />
          </div>
        </Field>
        {dur !== null && parseDuration(dur) === null && dur.trim() !== '' && <p className="wb-err">Bitte als Minuten (45) oder mm:ss (45:30) angeben.</p>}
      </Section>
    </>
  );
}

// --- Termine -------------------------------------------------------------------------------------------

function WeekdayChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips" role="group" aria-label="Wochentage">
      {WEEKDAYS.map(([k, l]) => (
        <button key={k} type="button" className={`chip${value.includes(k) ? ' on' : ''}`} aria-pressed={value.includes(k)} onClick={() => onChange(value.includes(k) ? value.filter((d) => d !== k) : [...value, k])}>
          {l}
        </button>
      ))}
    </div>
  );
}

function ListEditor({ items, onChange, render, blank, add }: { items: string[]; onChange: (v: string[]) => void; render: (v: string, set: (x: string) => void) => React.ReactNode; blank: string; add: string }) {
  return (
    <div className="wb-list">
      {items.map((it, i) => (
        <div className="wb-line" key={i}>
          {render(it, (x) => onChange(items.map((y, j) => (j === i ? x : y))))}
          <button type="button" className="icon-btn" aria-label="Entfernen" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn small secondary" onClick={() => onChange([...items, blank])}>
        {add}
      </button>
    </div>
  );
}

export function ScheduleTab({ form, set, w }: TabProps) {
  const s: Schedule = form.schedule;
  const tz = s.tz || w.tz || 'Europe/Berlin';
  const all = useMemo(zones, []);
  const preview = useMemo(() => {
    try {
      return upcomingSessions(s, tz, new Date(), { limit: 8 });
    } catch {
      return [];
    }
  }, [s, tz]);
  const kindLabel: Record<string, string> = { fixed: 'fester Termin', date: 'Einzeltermin', jit: 'Just in time', ondemand: 'sofort' };
  return (
    <>
      <div data-tour="webinar-schedule">
        <Section title="Feste Zeiten" hint="Zum Beispiel jeden Montag und Donnerstag um 19:00 Uhr.">
          <Check checked={s.fixed.enabled} onChange={(v) => set('schedule.fixed.enabled', v)} label="Feste Wochentage und Uhrzeiten anbieten" />
          {s.fixed.enabled && (
            <>
              <Field label="Wochentage">
                <WeekdayChips value={s.fixed.weekdays} onChange={(v) => set('schedule.fixed.weekdays', v)} />
              </Field>
              <Field label="Uhrzeiten">
                <ListEditor items={s.fixed.times} onChange={(v) => set('schedule.fixed.times', v)} blank="19:00" add="+ Uhrzeit" render={(v, c) => <input type="time" value={v} onChange={(e) => c(e.target.value)} aria-label="Uhrzeit" />} />
              </Field>
              <Field label="Wie weit im Voraus (Tage)">
                <Input type="number" min={1} max={90} value={s.horizon_days} onChange={(v) => set('schedule.horizon_days', Number(v) || 14)} />
              </Field>
            </>
          )}
        </Section>
        <Section title="Einzeltermine" hint="Bestimmte Tage, zusätzlich oder statt fester Zeiten.">
          <ListEditor items={s.dates} onChange={(v) => set('schedule.dates', v)} blank={`${new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)}T19:00`} add="+ Termin" render={(v, c) => <input type="datetime-local" value={v} onChange={(e) => c(e.target.value)} aria-label="Datum und Uhrzeit" />} />
        </Section>
      </div>
      {/* Einfach-Modus: further kinds of dates, time zone, blackout days and seats behind one toggle */}
      <MoreFields id="webinar-schedule" label="Weitere Terminarten, Zeitzone & Plätze" values={webinarMoreValues(form, DEFAULT_SCHEDULE).schedule}>
        <Section title="Zeitzone" hint="In dieser Zeitzone gelten die Uhrzeiten unten. Besucher:innen sehen ihre Termine automatisch in ihrer eigenen Zeitzone.">
          <Field label="Zeitzone der Termine">
            <Select value={s.tz} onChange={(v) => set('schedule.tz', v)} placeholder={`wie der Sub-Account (${w.tz ?? 'Europe/Berlin'})`} options={all} />
          </Field>
        </Section>
        <Section title="Just in time" hint="Der nächste Start ist immer in wenigen Minuten – zum Beispiel alle 15 Minuten zwischen 9 und 21 Uhr.">
          <Check checked={s.jit.enabled} onChange={(v) => set('schedule.jit.enabled', v)} label="Regelmäßige Starts anbieten" />
          {s.jit.enabled && (
            <>
              <div className="grid3">
                <Field label="Alle … Minuten">
                  <Select value={String(s.jit.every_min)} onChange={(v) => set('schedule.jit.every_min', Number(v))} options={['5', '10', '15', '20', '30', '45', '60', '90', '120'].map((m) => [m, `${m} Minuten`] as [string, string])} />
                </Field>
                <Field label="Von">
                  <input type="time" value={s.jit.from} onChange={(e) => set('schedule.jit.from', e.target.value)} />
                </Field>
                <Field label="Bis">
                  <input type="time" value={s.jit.to === '24:00' ? '23:59' : s.jit.to} onChange={(e) => set('schedule.jit.to', e.target.value)} />
                </Field>
              </div>
              <Field label="An Wochentagen">
                <WeekdayChips value={s.jit.weekdays} onChange={(v) => set('schedule.jit.weekdays', v)} />
              </Field>
            </>
          )}
        </Section>
        <Section title="Sofort starten" hint="Wer sich anmeldet, kommt direkt in den Raum – das Video beginnt für diese Person bei null.">
          <Check checked={s.ondemand.enabled} onChange={(v) => set('schedule.ondemand.enabled', v)} label="„Jetzt starten“ anbieten" />
        </Section>
        <Section title="Sperrtage" hint="An diesen Tagen gibt es keine Termine (Feiertage, Urlaub). Ein Zeitraum geht von … bis ….">
          <ListEditor
            items={s.blackout}
            onChange={(v) => set('schedule.blackout', v)}
            blank={new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)}
            add="+ Sperrtag"
            render={(v, c) => {
              const [a, z] = v.split('..');
              return (
                <span className="row" style={{ alignItems: 'center', gap: 6 }}>
                  <input type="date" value={a} onChange={(e) => c(z ? `${e.target.value}..${z}` : e.target.value)} aria-label="Von" />
                  <span className="muted small">bis</span>
                  <input type="date" value={z ?? ''} min={a} onChange={(e) => c(e.target.value ? `${a}..${e.target.value}` : a)} aria-label="Bis (optional)" />
                </span>
              );
            }}
          />
        </Section>
        <Section title="Plätze und Einlass">
          <div className="grid2">
            <Field label="Plätze pro Termin" hint="0 = unbegrenzt. Ist ein Termin voll, steht er auf der Anmeldeseite als ausgebucht.">
              <Input type="number" min={0} value={s.max_per_session} onChange={(v) => set('schedule.max_per_session', Math.max(0, Number(v) || 0))} />
            </Field>
            <Field label="Einlass nach dem Start" hint="Wer später kommt, steigt an der aktuellen Stelle des Videos ein.">
              <Select
                value={String(s.late_join_min)}
                onChange={(v) => set('schedule.late_join_min', Number(v))}
                options={[
                  ['0', 'nur pünktlich'],
                  ['5', 'bis 5 Minuten nach Beginn'],
                  ['15', 'bis 15 Minuten nach Beginn'],
                  ['30', 'bis 30 Minuten nach Beginn'],
                  ['60', 'bis 60 Minuten nach Beginn'],
                  ['9999', 'bis zum Ende'],
                ]}
              />
            </Field>
          </div>
        </Section>
      </MoreFields>
      <Section title="Die nächsten Termine" tour="webinar-sessions-preview" hint={`So sehen Besucher:innen die Termine – hier in der Zeitzone ${tz}.`}>
        {preview.length ? (
          <ul className="wb-sessions">
            {preview.map((p) => (
              <li key={p.start}>
                <b>{p.kind === 'ondemand' ? 'Jetzt starten' : fmtSession(p.start, tz)}</b> <Badge tone={p.kind === 'ondemand' ? 'purple' : p.kind === 'jit' ? 'blue' : 'gray'}>{kindLabel[p.kind]}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Noch kein Termin eingerichtet.</p>
        )}
      </Section>
    </>
  );
}

// --- Anmeldung -----------------------------------------------------------------------------------------

export function RegistrationTab({ form, set, w }: TabProps) {
  const r = form.settings.registration;
  const tags = useTags();
  const forms = useLoad(() => api.get<any[]>('/api/forms').catch(() => []), []);
  const t = form.settings.tags;
  const TAGS: [string, string][] = [
    ['attended', 'Im Webinar erschienen'],
    ['missed', 'Webinar verpasst'],
    ['cta', 'Angebot angeklickt'],
    ['purchased', 'Nach dem Angebot gekauft'],
    ['replay', 'Aufzeichnung angesehen'],
  ];
  const more = webinarMoreValues(form, DEFAULT_SCHEDULE);
  return (
    <>
      <Section title="Anmeldeseite" tour="webinar-registration" hint="Besucher:innen wählen einen Termin und tragen Name und E-Mail ein. Die Seite nennt das Webinar immer „automatisiert“.">
        <Field label="Einwilligung" hint="Pflichtfeld. Beschreibe, wofür die Angaben gebraucht werden.">
          <Textarea value={r.consent_text} onChange={(v) => set('settings.registration.consent_text', v)} rows={3} />
        </Field>
        <Check checked={r.ask_phone} onChange={(v) => set('settings.registration.ask_phone', v)} label="Telefonnummer abfragen (für SMS-Erinnerungen)" />
        {r.ask_phone && (
          <>
            <Check checked={r.phone_required} onChange={(v) => set('settings.registration.phone_required', v)} label="Telefonnummer ist Pflicht" />
            <Field label="Text der SMS-Einwilligung" hint="Erscheint nur, wenn eine Nummer eingetragen wird und mindestens eine Erinnerung per SMS eingestellt ist.">
              <Input value={r.sms_consent_text} onChange={(v) => set('settings.registration.sms_consent_text', v)} />
            </Field>
          </>
        )}
        <Field label="Dankestext nach der Anmeldung">
          <Textarea value={r.thanks_text} onChange={(v) => set('settings.registration.thanks_text', v)} rows={2} />
        </Field>
        <Check checked={r.notify_team} onChange={(v) => set('settings.registration.notify_team', v)} label="Team per E-Mail über jede Anmeldung informieren" />
        <MoreFields id="webinar-registration" values={more.registration}>
          <Field label="Überschrift (optional)" hint="Ersetzt den Titel als große Überschrift. „Live“ ist hier nicht erlaubt, weil das Webinar automatisiert ist.">
            <Input value={r.headline} onChange={(v) => set('settings.registration.headline', v)} />
          </Field>
          <Field label="Text des Buttons">
            <Input value={r.button_text} onChange={(v) => set('settings.registration.button_text', v)} />
          </Field>
          <Field label="Weiterleitung nach der Anmeldung (optional)" hint="Ein https-Link, z. B. eine eigene Danke-Seite.">
            <Input value={r.redirect_url} placeholder="https://…" onChange={(v) => set('settings.registration.redirect_url', v)} />
          </Field>
        </MoreFields>
      </Section>
      <Section title="Tags" hint="Tags landen am Kontakt und lösen Automationen aus („Tag hinzugefügt“).">
        <Field label="Bei der Anmeldung">
          <TagInput value={r.tags} onChange={(v) => set('settings.registration.tags', v)} suggestions={tags} />
        </Field>
        <MoreFields id="webinar-tags" label="Tags für Teilnahme, Angebot und Aufzeichnung" values={more.tags}>
          {TAGS.map(([k, label]) => (
            <Field key={k} label={label}>
              <TagInput value={t[k]} onChange={(v) => set(`settings.tags.${k}`, v)} suggestions={tags} />
            </Field>
          ))}
        </MoreFields>
      </Section>
      <Section title="Formulare, die anmelden" hint="Wer eines dieser Formulare ausfüllt, wird automatisch für den nächsten freien Termin angemeldet – praktisch für Funnel-Seiten mit eigenem Formular.">
        {(forms.data ?? []).length ? (
          (forms.data ?? []).map((f: any) => (
            <Check key={f.id} checked={r.form_ids.includes(f.id)} onChange={(on) => set('settings.registration.form_ids', on ? [...r.form_ids, f.id] : r.form_ids.filter((x: string) => x !== f.id))} label={f.name} />
          ))
        ) : (
          <p className="muted">Noch keine Formulare vorhanden.</p>
        )}
      </Section>
      <Section title="Einbinden" hint="Die Anmeldeseite lässt sich direkt verlinken oder als Block „HTML“ in eine Funnel-Seite einbetten – sie passt ihre Höhe selbst an.">
        <Field label="Link">
          <CodeBox text={w.urls?.page ?? ''} />
        </Field>
        <Field label="Einbettungs-Code für eine Funnel-Seite">
          <CodeBox text={w.urls?.embed ?? ''} />
        </Field>
      </Section>
    </>
  );
}


