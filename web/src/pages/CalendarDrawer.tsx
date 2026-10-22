import { useEffect, useState } from 'react';
import { ApiError, api, money } from '../api';
import { Badge, Check, Field, Input, Link, Modal, Select, Spinner, Textarea, act, navigate, toast, toastError, useLoad } from '../ui';
import { fmtDate, fmtTime, useT } from '../i18n';
import { addDays, hm, minOf, wall, weekdayOf, zoned, type Appt, type Cal, type Issue } from './calview-model';
import { MoreFields, useSimple } from '../areas/fields';
import '../areas/easy-core.css';

/**
 * The calendar view's dialogs: the appointment drawer (contact, notes, status, payment, series), booking from an empty slot (with
 * repetition), the series editor, the "only this / this and following / all" question and the conflict notice of a drop.
 */

export const STATUS: Record<string, [string, 'blue' | 'green' | 'yellow' | 'red' | 'gray']> = {
  confirmed: ['bestätigt', 'blue'],
  showed: ['erschienen', 'green'],
  noshow: ['nicht erschienen', 'yellow'],
  cancelled: ['abgesagt', 'red'],
  blocked: ['blockiert', 'gray'],
};
export const ISSUE_KIND: Record<Issue['kind'], string> = {
  appointment: 'Überschneidet sich mit einem anderen Termin',
  blocked: 'Liegt in einer blockierten Zeit',
  buffer: 'Zu nah an einem anderen Termin (Puffer)',
  person: 'Die Person hat zu der Zeit einen anderen Termin',
  busy: 'Im verbundenen Kalender belegt (Google/Outlook/iCal)',
  hours: 'Außerhalb der Buchungszeiten',
  limit: 'Tages- oder Wochenlimit erreicht',
  absence: 'Die Person ist abwesend',
};
export type Scope = 'single' | 'following' | 'all';

/** The reasons of a 409 (drop, booking, series) – one line per kind, with what it is about. */
export function IssueList({ issues }: { issues: Issue[] }) {
  const t = useT('calview');
  const seen = new Set<string>();
  return (
    <ul className="cv-issues">
      {issues
        .filter((i) => {
          const k = `${i.kind}|${i.label}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map((i, n) => (
          <li key={n}>
            {t(ISSUE_KIND[i.kind] ?? i.kind)}
            {i.label ? <span className="muted"> – {i.label}</span> : null}
          </li>
        ))}
    </ul>
  );
}

export function ConflictDialog({ issues, title, confirm, onCancel, onConfirm }: { issues: Issue[]; title: string; confirm: string; onCancel: () => void; onConfirm: () => void }) {
  const t = useT('calview');
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn secondary" onClick={onCancel}>
            {t('Abbrechen')}
          </button>
          <button className="btn" onClick={onConfirm}>
            {confirm}
          </button>
        </>
      }
    >
      <p>{t('Die Zeit ist nicht frei:')}</p>
      <IssueList issues={issues} />
    </Modal>
  );
}

export function ScopeDialog({ title, allowWide = true, onCancel, onPick }: { title: string; allowWide?: boolean; onCancel: () => void; onPick: (s: Scope) => void }) {
  const t = useT('calview');
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="muted">{t('Dieser Termin gehört zu einer Serie.')}</p>
      <div className="cv-scope">
        <button className="btn secondary" onClick={() => onPick('single')}>
          {t('Nur dieser Termin')}
        </button>
        {allowWide && (
          <button className="btn secondary" onClick={() => onPick('following')}>
            {t('Dieser und alle folgenden')}
          </button>
        )}
        {allowWide && (
          <button className="btn secondary" onClick={() => onPick('all')}>
            {t('Alle Termine der Serie')}
          </button>
        )}
      </div>
      {!allowWide && <p className="muted small">{t('Den Wochentag einer ganzen Serie änderst du unter „Serie bearbeiten“.')}</p>}
    </Modal>
  );
}

// --- repetition ----------------------------------------------------------------------------------------------------------------------

export interface Repeat {
  freq: 'none' | 'daily' | 'weekly' | 'monthly';
  interval: number;
  /** 0 = Sunday … 6 = Saturday (the server's numbering). */
  weekdays: number[];
  end: 'never' | 'count' | 'date';
  count: number;
  until: string;
}
export const NO_REPEAT: Repeat = { freq: 'none', interval: 1, weekdays: [], end: 'never', count: 10, until: '' };
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT: Record<number, string> = { 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 0: 'So' };

export function repeatBody(r: Repeat) {
  if (r.freq === 'none') return null;
  return {
    freq: r.freq,
    interval: Math.max(1, Math.round(Number(r.interval) || 1)),
    ...(r.freq === 'weekly' && r.weekdays.length ? { weekdays: r.weekdays } : {}),
    end: r.end === 'count' ? { type: 'count', count: Math.max(1, Math.round(Number(r.count) || 1)) } : r.end === 'date' && r.until ? { type: 'date', date: r.until } : { type: 'never' },
  };
}

/** A rule of the API back into the form (series editor). */
export function repeatOf(rule: any): Repeat {
  if (!rule?.freq) return NO_REPEAT;
  return { freq: rule.freq, interval: rule.interval ?? 1, weekdays: rule.weekdays ?? [], end: rule.end?.type ?? 'never', count: rule.end?.count ?? 10, until: rule.end?.date ?? '' };
}

export function RepeatFields({ value, onChange, firstDay }: { value: Repeat; onChange: (r: Repeat) => void; firstDay: string }) {
  const t = useT('calview');
  const set = (p: Partial<Repeat>) => onChange({ ...value, ...p });
  const unit = value.freq === 'daily' ? t('Tage') : value.freq === 'weekly' ? t('Wochen') : t('Monate');
  return (
    <div className="cv-repeat">
      <div className="grid2">
        <Field label={t('Wiederholen')}>
          <Select
            value={value.freq}
            onChange={(v) => set({ freq: v as Repeat['freq'], weekdays: v === 'weekly' && !value.weekdays.length ? [(weekdayOf(firstDay) + 1) % 7] : value.weekdays })}
            options={[
              ['none', t('Nicht wiederholen')],
              ['daily', t('Täglich')],
              ['weekly', t('Wöchentlich')],
              ['monthly', t('Monatlich')],
            ]}
          />
        </Field>
        {value.freq !== 'none' && (
          <Field label={t('Alle')} hint={unit}>
            <Input type="number" min={1} max={52} value={value.interval} onChange={(v) => set({ interval: Number(v) || 1 })} />
          </Field>
        )}
      </div>
      {value.freq === 'weekly' && (
        <div className="cv-days" role="group" aria-label={t('Wochentage')}>
          {DAY_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              className={`cv-day${value.weekdays.includes(d) ? ' on' : ''}`}
              aria-pressed={value.weekdays.includes(d)}
              onClick={() => set({ weekdays: value.weekdays.includes(d) ? value.weekdays.filter((x) => x !== d) : [...value.weekdays, d].sort() })}
            >
              {t(DAY_SHORT[d])}
            </button>
          ))}
        </div>
      )}
      {value.freq !== 'none' && (
        <div className="grid2">
          <Field label={t('Endet')}>
            <Select
              value={value.end}
              onChange={(v) => set({ end: v as Repeat['end'], until: v === 'date' && !value.until ? addDays(firstDay, 56) : value.until })}
              options={[
                ['never', t('Nie (90 Tage im Voraus angelegt)')],
                ['count', t('Nach Anzahl Terminen')],
                ['date', t('Am Datum')],
              ]}
            />
          </Field>
          {value.end === 'count' && (
            <Field label={t('Anzahl Termine')}>
              <Input type="number" min={1} max={500} value={value.count} onChange={(v) => set({ count: Number(v) || 1 })} />
            </Field>
          )}
          {value.end === 'date' && (
            <Field label={t('Letzter Tag')}>
              <Input type="date" value={value.until} onChange={(v) => set({ until: v })} />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

// --- booking from an empty slot -------------------------------------------------------------------------------------------------------

export interface Slot {
  ymd: string;
  min: number;
  calendarId: string;
}

export function BookDialog({ slot, calendars, tz, onClose, onDone }: { slot: Slot; calendars: Cal[]; tz: string; onClose: () => void; onDone: () => void }) {
  const t = useT('calview');
  const first = calendars.find((c) => c.id === slot.calendarId) ?? calendars[0];
  const [f, setF] = useState({ calendar_id: first?.id ?? '', day: slot.ymd, from: hm(slot.min), to: hm(Math.min(1439, slot.min + (first?.duration ?? 30))), blocked: false, title: '', notes: '' });
  const [repeat, setRepeat] = useState<Repeat>(NO_REPEAT);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [contact, setContact] = useState<any>(null);
  const [fresh, setFresh] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [preview, setPreview] = useState<{ description: string; count: number; conflicts: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const cal = calendars.find((c) => c.id === f.calendar_id);
  const simple = useSimple();

  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const id = window.setTimeout(
      () =>
        api
          .get(`/api/contacts?q=${encodeURIComponent(q.trim())}&limit=6`)
          .then((r) => setFound((r?.contacts ?? r ?? []).slice(0, 6)))
          .catch(() => setFound([])),
      200,
    );
    return () => window.clearTimeout(id);
  }, [q]);

  const startIso = () => zoned(f.day, minOf(f.from), tz);
  const endIso = () => {
    const e = minOf(f.to);
    return zoned(e > minOf(f.from) ? f.day : addDays(f.day, 1), e, tz);
  };
  const rule = repeatBody(repeat);
  const valid = !!cal && !Number.isNaN(minOf(f.from)) && !Number.isNaN(minOf(f.to)) && minOf(f.to) !== minOf(f.from);

  useEffect(() => {
    if (!rule || !valid) return setPreview(null);
    const id = window.setTimeout(
      () =>
        api
          .post('/api/appointment-series/preview', {
            calendar_id: f.calendar_id,
            start: startIso(),
            duration: Math.round((Date.parse(endIso()) - Date.parse(startIso())) / 60000),
            recurrence: rule,
            blocked: f.blocked,
          })
          .then((r) => setPreview({ description: r.description, count: r.occurrences.length, conflicts: r.conflicts.length }))
          .catch(() => setPreview(null)),
      250,
    );
    return () => window.clearTimeout(id);
  }, [JSON.stringify(rule), f.calendar_id, f.day, f.from, f.to, f.blocked]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (force = false) => {
    if (!valid) return toastError(new Error(t('Bitte Beginn und Ende angeben')));
    const who = f.blocked ? {} : contact ? { contact_id: contact.id } : fresh.email || fresh.phone ? { contact: fresh } : null;
    if (!who) return toastError(new Error(t('Bitte einen Kontakt wählen oder anlegen')));
    setBusy(true);
    try {
      if (rule) {
        const minutes = Math.round((Date.parse(endIso()) - Date.parse(startIso())) / 60000);
        await api.post('/api/appointment-series', {
          calendar_id: f.calendar_id,
          start: startIso(),
          duration: minutes,
          recurrence: rule,
          notes: f.notes,
          title: f.blocked ? f.title || t('Blockiert') : undefined,
          blocked: f.blocked,
          force,
          ...who,
        });
        toast(t('Serie angelegt'));
      } else {
        await api.post('/api/calendar-view/book', {
          calendar_id: f.calendar_id,
          start: startIso(),
          end: endIso(),
          notes: f.notes,
          blocked: f.blocked,
          title: f.blocked ? f.title || t('Blockiert') : undefined,
          force,
          ...who,
        });
        toast(f.blocked ? t('Zeit blockiert') : t('Termin eingetragen'));
      }
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.data?.issues || e.data?.conflicts))
        setIssues(
          e.data.issues ??
            e.data.conflicts.flatMap((c: any) =>
              c.issues.map((i: Issue) => ({ ...i, label: `${fmtDate(c.start_at, { day: '2-digit', month: '2-digit', timeZone: tz })}${i.label ? ` · ${i.label}` : ''}` })),
            ),
        );
      else toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (issues)
    return <ConflictDialog issues={issues} title={t('Trotzdem eintragen?')} confirm={t('Trotzdem eintragen')} onCancel={() => setIssues(null)} onConfirm={() => (setIssues(null), void save(true))} />;
  return (
    <Modal
      title={f.blocked ? t('Zeit blockieren') : t('Termin eintragen')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={busy} onClick={() => save()}>
          {t('Speichern')}
        </button>
      }
    >
      <div className="grid2">
        <Field label={t('Kalender')}>
          <Select value={f.calendar_id} onChange={(v) => setF({ ...f, calendar_id: v })} options={calendars.map((c) => [c.id, c.name])} />
        </Field>
        <Field label={t('Datum')}>
          <Input type="date" value={f.day} onChange={(v) => v && setF({ ...f, day: v })} />
        </Field>
        <Field label={t('Beginn')}>
          <Input type="time" value={f.from} step={300} onChange={(v) => setF({ ...f, from: v })} />
        </Field>
        <Field label={t('Ende')}>
          <Input type="time" value={f.to} step={300} onChange={(v) => setF({ ...f, to: v })} />
        </Field>
      </div>
      <p className="muted small">{t('Zeiten in der Zeitzone des Sub-Accounts: {tz}', { tz })}</p>
      <Check checked={f.blocked} onChange={(v) => setF({ ...f, blocked: v })} label={t('Zeit blockieren (kein Kontakt)')} />
      {f.blocked ? (
        <Field label={t('Titel')}>
          <Input value={f.title} onChange={(v) => setF({ ...f, title: v })} placeholder={t('z. B. Urlaub')} />
        </Field>
      ) : contact ? (
        <div className="cv-picked">
          <strong>{[contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email}</strong>
          <span className="muted small">{contact.email || contact.phone}</span>
          <button type="button" className="btn small ghost" onClick={() => setContact(null)}>
            {t('Ändern')}
          </button>
        </div>
      ) : (
        <>
          <Field label={t('Kontakt suchen')}>
            <Input value={q} onChange={setQ} placeholder={t('Name, E-Mail oder Telefon')} />
          </Field>
          {found.length > 0 && (
            <div className="cv-found" role="listbox" aria-label={t('Treffer')}>
              {found.map((c) => (
                <button key={c.id} type="button" role="option" aria-selected={false} onClick={() => (setContact(c), setQ(''))}>
                  {[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email} <span className="muted small">{c.email || c.phone}</span>
                </button>
              ))}
            </div>
          )}
          {!simple && <p className="muted small">{t('Oder neuer Kontakt:')}</p>}
          {/* Einfach-Modus: search first; a new contact behind one toggle */}
          <MoreFields id="book-new-contact" label={t('Neuen Kontakt anlegen')} values={Object.values(fresh)}>
          <div className="grid2">
            <Field label={t('Vorname')}>
              <Input value={fresh.first_name} onChange={(v) => setFresh({ ...fresh, first_name: v })} />
            </Field>
            <Field label={t('Nachname')}>
              <Input value={fresh.last_name} onChange={(v) => setFresh({ ...fresh, last_name: v })} />
            </Field>
            <Field label={t('E-Mail')}>
              <Input type="email" value={fresh.email} onChange={(v) => setFresh({ ...fresh, email: v })} />
            </Field>
            <Field label={t('Telefon')}>
              <Input type="tel" value={fresh.phone} onChange={(v) => setFresh({ ...fresh, phone: v })} />
            </Field>
          </div>
          </MoreFields>
        </>
      )}
      {/* Einfach-Modus: note and repetition behind "Weitere Felder" */}
      <MoreFields id="book-more" values={[f.notes, repeat.freq === 'none' ? '' : repeat.freq]}>
      {!f.blocked && (
        <Field label={t('Notiz')}>
          <Textarea value={f.notes} onChange={(v) => setF({ ...f, notes: v })} rows={2} />
        </Field>
      )}
      <RepeatFields value={repeat} onChange={setRepeat} firstDay={f.day} />
      </MoreFields>
      {preview && (
        <p className={`small ${preview.conflicts ? 'cv-warn' : 'muted'}`}>
          {preview.description} – {t.plural(preview.count, { one: '{n} Termin wird angelegt', other: '{n} Termine werden angelegt' })}
          {preview.conflicts ? ` · ${t.plural(preview.conflicts, { one: '{n} überschneidet sich', other: '{n} überschneiden sich' })}` : ''}
        </p>
      )}
    </Modal>
  );
}

// --- the series editor --------------------------------------------------------------------------------------------------------------

export function SeriesDialog({ series, appt, tz, onClose, onDone }: { series: any; appt: Appt; tz: string; onClose: () => void; onDone: () => void }) {
  const t = useT('calview');
  const [time, setTime] = useState<string>(series.start_time);
  const [duration, setDuration] = useState<number>(series.duration);
  const [repeat, setRepeat] = useState<Repeat>(repeatOf(series.rule));
  const [notes, setNotes] = useState<string>(series.notes ?? '');
  const [scope, setScope] = useState<Scope>('following');
  const save = async () => {
    const rule = repeatBody(repeat);
    if (!rule) return toastError(new Error(t('Eine Serie braucht eine Wiederholung – zum Beenden die Serie absagen')));
    const r = await act(
      () => api.patch(`/api/appointment-series/${series.id}`, { scope, appointment_id: appt.id, start_time: time, duration, recurrence: scope === 'single' ? undefined : rule, notes }),
      t('Serie gespeichert'),
    );
    if (r) onDone();
  };
  return (
    <Modal
      title={t('Serie bearbeiten')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <p className="muted small">{series.description}</p>
      <div className="grid2">
        <Field label={t('Uhrzeit')}>
          <Input type="time" value={time} step={300} onChange={setTime} />
        </Field>
        <Field label={t('Dauer (Min.)')}>
          <Input type="number" min={5} max={1440} value={duration} onChange={(v) => setDuration(Number(v) || 30)} />
        </Field>
      </div>
      {scope !== 'single' && <RepeatFields value={repeat} onChange={setRepeat} firstDay={wall(appt.start_at, tz).ymd} />}
      <Field label={t('Notiz')}>
        <Textarea value={notes} onChange={setNotes} rows={2} />
      </Field>
      <Field label={t('Ändern für')}>
        <Select
          value={scope}
          onChange={(v) => setScope(v as Scope)}
          options={[
            ['single', t('Nur diesen Termin')],
            ['following', t('Diesen und alle folgenden')],
            ['all', t('Alle Termine der Serie')],
          ]}
        />
      </Field>
    </Modal>
  );
}

// --- the drawer -----------------------------------------------------------------------------------------------------------------------

export function ApptDrawer({ id, tz, onClose, onChanged, teamCancel }: { id: string; tz: string; onClose: () => void; onChanged: () => void; teamCancel: boolean }) {
  const t = useT('calview');
  const d = useLoad(() => api.get<any>(`/api/calendar-view/appointments/${id}`), [id]);
  const [notes, setNotes] = useState<string | null>(null);
  const [cancel, setCancel] = useState<{ scope?: Scope; reason: string } | null>(null);
  const [askScope, setAskScope] = useState(false);
  const [editSeries, setEditSeries] = useState(false);
  const data = d.data;
  const a = data?.appointment;
  const changed = () => (d.reload(), onChanged());

  const setStatus = async (status: string) => {
    if (status === a.status) return;
    if (status === 'cancelled') return a.series_id ? setAskScope(true) : setCancel({ reason: '' });
    if (await act(() => api.patch(`/api/appointments/${a.id}`, { status }), t('Status gespeichert'))) changed();
  };
  const doCancel = async () => {
    if (!cancel) return;
    const r = a.series_id
      ? await act(() => api.post(`/api/appointment-series/${a.series_id}/cancel`, { scope: cancel.scope ?? 'single', appointment_id: a.id, reason: cancel.reason }), t('Abgesagt'))
      : teamCancel && a.status === 'confirmed'
        ? await act(() => api.post(`/api/team-calendars/appointments/${a.id}/cancel`, { reason: cancel.reason }), t('Abgesagt'))
        : await act(() => api.patch(`/api/appointments/${a.id}`, { status: 'cancelled' }), t('Abgesagt'));
    setCancel(null);
    if (r) changed();
  };
  const invoice = async () => {
    const r = await act(() => api.post<any>(`/api/calendar-view/appointments/${a.id}/invoice`), t('Rechnungsentwurf angelegt'));
    if (r) navigate(`invoices/${r.invoice_id}`);
  };
  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast(t('Link kopiert')),
      () => toast(text),
    );

  if (askScope) return <ScopeDialog title={t('Termin absagen')} onCancel={() => setAskScope(false)} onPick={(scope) => (setAskScope(false), setCancel({ scope, reason: '' }))} />;
  if (editSeries && data?.series)
    return <SeriesDialog series={data.series} appt={{ ...a, people: [] }} tz={tz} onClose={() => setEditSeries(false)} onDone={() => (setEditSeries(false), changed())} />;
  if (cancel)
    return (
      <Modal
        title={t('Termin absagen')}
        onClose={() => setCancel(null)}
        footer={
          <>
            <button className="btn secondary" onClick={() => setCancel(null)}>
              {t('Zurück')}
            </button>
            <button className="btn danger" onClick={doCancel}>
              {cancel.scope === 'all' ? t('Serie absagen') : cancel.scope === 'following' ? t('Diesen und folgende absagen') : t('Termin absagen')}
            </button>
          </>
        }
      >
        <p className="muted small">{t('Der Kontakt bekommt eine E-Mail, die Zeit wird wieder frei.')}</p>
        <Field label={t('Grund (optional)')}>
          <Textarea value={cancel.reason} onChange={(v) => setCancel({ ...cancel, reason: v })} rows={3} />
        </Field>
      </Modal>
    );

  const when = a
    ? `${fmtDate(a.start_at, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz })}, ${fmtTime(a.start_at, { hour: '2-digit', minute: '2-digit', timeZone: tz })}–${fmtTime(a.end_at, { hour: '2-digit', minute: '2-digit', timeZone: tz })}`
    : '';
  const c = data?.contact;
  const name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email : a?.title;
  return (
    <Modal title={name || t('Termin')} onClose={onClose} className="drawer cv-drawer">
      {!data ? (
        d.error ? (
          <p className="cv-warn">{d.error}</p>
        ) : (
          <Spinner />
        )
      ) : (
        <>
          <div className="cv-dhead">
            <span className="cv-dot" style={{ background: data.calendar.color }} aria-hidden="true" />
            <div>
              <strong>{data.calendar.name}</strong>
              <div className="muted small">
                {when} <span title={t('Zeitzone')}>({tz})</span>
              </div>
            </div>
            <Badge tone={STATUS[a.status]?.[1] ?? 'gray'}>{t(STATUS[a.status]?.[0] ?? a.status)}</Badge>
          </div>
          {data.people.length > 0 && (
            <p className="small">
              {t('Mit')}: {data.people.map((p: any) => p.name).join(', ')}
            </p>
          )}
          {data.series && (
            <div className="cv-dsec">
              <h4>
                ↻ {t('Serie')}
                {a.series_exception ? <span className="muted small"> · {t('einzeln geändert')}</span> : null}
              </h4>
              <p className="small">{data.series.description}</p>
              {data.series.status !== 'cancelled' && (
                <button className="btn small secondary" onClick={() => setEditSeries(true)}>
                  {t('Serie bearbeiten')}
                </button>
              )}
            </div>
          )}
          {c && (
            <div className="cv-dsec">
              <h4>{t('Kontakt')}</h4>
              <p>
                <Link to={`contacts/${c.id}`}>{name}</Link>
                {c.dnd ? <Badge tone="yellow">{t('Nicht stören')}</Badge> : null}
              </p>
              {c.email && (
                <p className="small">
                  <a href={`mailto:${c.email}`}>{c.email}</a>
                </p>
              )}
              {c.phone && (
                <p className="small">
                  <a href={`tel:${c.phone}`}>{c.phone}</a>
                </p>
              )}
              {data.conversation_id && (
                <p className="small">
                  <Link to={`conversations/${data.conversation_id}`}>{t('Konversation öffnen')}</Link>
                </p>
              )}
            </div>
          )}
          {a.status !== 'blocked' && (
            <div className="cv-dsec">
              <h4>{t('Status')}</h4>
              <div className="cv-status" role="group" aria-label={t('Status')}>
                {(['confirmed', 'showed', 'noshow', 'cancelled'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`btn small ${a.status === s ? '' : 'secondary'}`}
                    aria-pressed={a.status === s}
                    disabled={a.status === 'cancelled' && s !== 'cancelled'}
                    onClick={() => setStatus(s)}
                  >
                    {t(STATUS[s][0])}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="cv-dsec">
            <h4>{t('Notizen')}</h4>
            <Textarea value={notes ?? a.notes ?? ''} onChange={setNotes} rows={4} />
            {notes !== null && notes !== a.notes && (
              <button className="btn small" onClick={async () => (await act(() => api.patch(`/api/appointments/${a.id}`, { notes }), t('Notiz gespeichert'))) && (setNotes(null), changed())}>
                {t('Notiz speichern')}
              </button>
            )}
          </div>
          {/* no payment, no invoice and nothing to invoice: no section saying so */}
          {a.status !== 'blocked' && (data.payment || data.invoice || data.can_invoice) && (
            <div className="cv-dsec">
              <h4>{t('Zahlung')}</h4>
              {data.payment ? (
                <p className="small">
                  {t(
                    (
                      {
                        paid: 'Bezahlt',
                        waived: 'Ohne Zahlung gebucht',
                        refunded: 'Erstattet',
                        refund_pending: 'Erstattung offen',
                        pending: 'Zahlung ausstehend',
                      } as Record<string, string>
                    )[data.payment.status] ?? 'Zahlung',
                  )}
                  {data.payment.amount_cents ? ` · ${money(data.payment.due_cents ?? data.payment.amount_cents, data.payment.currency)}` : ''}
                </p>
              ) : null}
              {data.invoice ? (
                <p className="small">
                  <Link to={`invoices/${data.invoice.id}`}>{t('Rechnung {number}', { number: data.invoice.number })}</Link> · {money(data.invoice.total_cents, data.invoice.currency)} ·{' '}
                  {t(({ draft: 'Entwurf', sent: 'versendet', paid: 'bezahlt', void: 'storniert', overdue: 'überfällig' } as Record<string, string>)[data.invoice.status] ?? data.invoice.status)}
                </p>
              ) : data.can_invoice ? (
                <button className="btn small secondary" onClick={invoice}>
                  {t('Rechnung anlegen')}
                </button>
              ) : null}
            </div>
          )}
          {a.status === 'confirmed' && a.contact_id && (
            <div className="cv-dsec">
              <h4>{t('Links für den Kontakt')}</h4>
              <div className="cv-links">
                <button className="btn small ghost" onClick={() => copy(data.links.reschedule_url)}>
                  {t('Link zum Verschieben kopieren')}
                </button>
                <button className="btn small ghost" onClick={() => copy(data.links.cancel_url)}>
                  {t('Link zum Absagen kopieren')}
                </button>
              </div>
            </div>
          )}
          {a.status === 'blocked' && (
            <div className="cv-dsec">
              <button className="btn small danger" onClick={async () => (await act(() => api.del(`/api/appointments/${a.id}`), t('Zeit freigegeben'))) && (onChanged(), onClose())}>
                {t('Zeit freigeben')}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
