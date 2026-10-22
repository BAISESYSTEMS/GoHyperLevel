import { useRef, useState } from 'react';
import { api, money, name } from '../api';
import { Badge, Check, CodeBox, Empty, Field, Input, Link, MergeHint, Modal, PageHead, Select, Spinner, TagInput, Tabs, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { useTags } from '../tags';
import { CalendarConnectionInfo } from './OAuthConnect';
import { lazyPages } from '../lazy';
import { ApptDetails, CancelModal, KindBadge, MoveModal } from './TeamCalendarKit';
import { ShareLink } from '../QrCode';
import { AfterEditor, LimitsEditor, OverridesEditor, RemindersEditor } from './BookingExtras';
import { fmtDate, fmtDateTime, fmtTime, useT } from '../i18n';
import { MoreFields, useSimple } from '../areas/fields';
import { CALENDAR_TABS_ESSENTIAL, isAutoSlug, simpleTabs } from '../areas/easy-core';
import '../areas/easy-core.css';

const { TeamEditor, RoutingForms } = lazyPages(() => import('./TeamCalendarEditor'), 'TeamEditor', 'RoutingForms');
// Day / week / month / team / agenda grid – a chunk of its own (docs/booking.md#calendar-view).
const { CalendarView } = lazyPages(() => import('./CalendarView'), 'CalendarView');
const { ServiceMenus } = lazyPages(() => import('./ServiceMenus'), 'ServiceMenus');
const { TicketEvents } = lazyPages(() => import('./TicketEvents'), 'TicketEvents');
const { Rentals } = lazyPages(() => import('./Rentals'), 'Rentals');
// Labels below are German message ids of the calendar catalog (shown through t()).
const TEAM_TABS: [string, string][] = [['team', 'Typ & Team'], ['questions', 'Fragen'], ['payment', 'Zahlung'], ['video', 'Video & Regeln']];

const DAYS: [string, string][] = [
  ['mon', 'Montag'],
  ['tue', 'Dienstag'],
  ['wed', 'Mittwoch'],
  ['thu', 'Donnerstag'],
  ['fri', 'Freitag'],
  ['sat', 'Samstag'],
  ['sun', 'Sonntag'],
];
const STATUS: Record<string, [string, any]> = {
  confirmed: ['bestätigt', 'blue'],
  cancelled: ['abgesagt', 'red'],
  showed: ['erschienen', 'green'],
  noshow: ['nicht erschienen', 'yellow'],
  blocked: ['blockiert', 'gray'],
};

function CalendarEditor({ cal: initialCal, type, onClose, onSaved }: { cal?: any; type?: any; onClose: () => void; onSaved: () => void }) {
  const t = useT('calendar');
  // A calendar created in this dialog continues as an existing one (so the team settings can be filled in right away).
  const [cal, setCal] = useState<any>(initialCal);
  const teamSave = useRef<(() => Promise<boolean>) | null>(null);
  const [c, setC] = useState<any>(cal ?? { name: '', duration: 30, interval: 30, buffer: 0, min_notice: 4, max_days: 60, color: '#2563eb', availability: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '15:00']] }, settings: {} });
  const [tab, setTab] = useState('basic');
  const simple = useSimple();
  const [allTabs, setAllTabs] = useState(false);
  const pipelines = useLoad(() => api.get<any[]>('/api/pipelines'), []);
  const tags = useTags();
  const s = c.settings ?? {};
  const setS = (patch: any) => setC({ ...c, settings: { ...s, ...patch } });
  const setDay = (day: string, windows: string[][]) => setC({ ...c, availability: { ...c.availability, [day]: windows } });
  const save = async () => {
    const body = { ...c, duration: Number(c.duration), interval: Number(c.interval), buffer: Number(c.buffer), min_notice: Number(c.min_notice), max_days: Number(c.max_days) };
    const r = await act(() => (cal ? api.patch(`/api/calendars/${cal.id}`, body) : api.post('/api/calendars', body)), t('Kalender gespeichert'));
    if (!r) return;
    if (cal) return onSaved();
    setCal(r);
    setC(r);
    setTab('team');
    toast(t('Angelegt – jetzt Typ, Team und Fragen einstellen'));
  };
  const isTeamTab = TEAM_TABS.some(([k]) => k === tab);
  const pipe = pipelines.data?.find((p) => p.id === s.pipeline_id);
  return (
    <Modal
      title={cal ? t('Kalender: {name}', { name: cal.name }) : t('Neuer Kalender')}
      onClose={onClose}
      wide
      footer={
        isTeamTab && cal ? (
          <>
            <button className="btn secondary" onClick={onSaved}>
              {t('Schließen')}
            </button>
            <button className="btn" onClick={async () => (await teamSave.current?.()) && onSaved()}>
              {t('Speichern')}
            </button>
          </>
        ) : (
          <button className="btn" onClick={save}>
            {t('Speichern')}
          </button>
        )
      }
    >
      {(() => {
        // Einfach-Modus: the tabs a booking page needs, plus every tab that already holds settings; the rest behind one button.
        const filled = [
          ...(s.followup?.enabled || s.noshow?.enabled ? ['after'] : []),
          ...(s.tags?.length || s.pipeline_id ? ['crm'] : []),
          ...(type?.questions ? ['questions'] : []),
          ...(type?.payment ? ['payment'] : []),
          ...(type?.video && type.video !== 'none' ? ['video'] : []),
        ];
        const { tabs, hidden } = simpleTabs(
          [
            ['basic', t('Allgemein')],
            ['hours', t('Verfügbarkeit')],
            ['notify', t('Bestätigung & Erinnerung')],
            ['after', t('Nachfassen')],
            ['crm', t('CRM')],
            ...(cal ? ([...TEAM_TABS.map(([k, l]) => [k, t(l)]), ['sync', t('Google/Outlook-Sync')]] as [string, string][]) : []),
          ],
          { simple, essential: CALENDAR_TABS_ESSENTIAL, current: tab, filled, expanded: allTabs },
        );
        return (
          <>
            <Tabs tabs={tabs} value={tab} onChange={setTab} />
            {hidden > 0 && (
              <button type="button" className="btn small ghost tabs-more" data-tour-unfold onClick={() => setAllTabs(true)}>
                {t.plural(hidden, { one: '+ {n} weiterer Bereich', other: '+ {n} weitere Bereiche' })}
              </button>
            )}
          </>
        );
      })()}
      {tab === 'sync' && cal && <SyncTab cal={cal} />}
      {isTeamTab && cal && <TeamEditor key={cal.id} cal={cal} tab={tab} saveRef={teamSave} />}
      {tab === 'basic' &&
        (() => {
          const nameF = (
            <Field label={t('Name')} tour="calendar-name">
              <Input value={c.name} onChange={(v) => setC({ ...c, name: v })} placeholder={t('Erstgespräch')} />
            </Field>
          );
          const slugF = (
            <Field label={t('URL-Pfad')} hint={`/book/${c.slug || '…'}`}>
              <Input value={c.slug} onChange={(v) => setC({ ...c, slug: v })} placeholder={t('automatisch')} />
            </Field>
          );
          const descF = (
            <Field label={t('Beschreibung')}>
              <Textarea value={c.description} onChange={(v) => setC({ ...c, description: v })} />
            </Field>
          );
          const placeF = (
            <Field label={t('Ort / Meeting-Link')} hint={t('z. B. Jitsi-Link (kostenlos): https://meet.jit.si/deine-firma')}>
              <Input value={s.meeting_location} onChange={(v) => setS({ meeting_location: v })} />
            </Field>
          );
          const durationF = (
            <Field label={t('Dauer (Min.)')}>
              <Input type="number" value={c.duration} onChange={(v) => setC({ ...c, duration: v })} />
            </Field>
          );
          const timing = (
            <>
              <Field label={t('Takt (Min.)')} hint={t('Abstand der Startzeiten')}>
                <Input type="number" value={c.interval} onChange={(v) => setC({ ...c, interval: v })} />
              </Field>
              <Field label={t('Puffer (Min.)')}>
                <Input type="number" value={c.buffer} onChange={(v) => setC({ ...c, buffer: v })} />
              </Field>
              <Field label={t('Vorlauf (Std.)')} hint={t('frühestens so viele Stunden vorher')}>
                <Input type="number" value={c.min_notice} onChange={(v) => setC({ ...c, min_notice: v })} />
              </Field>
              <Field label={t('Buchbar bis (Tage)')}>
                <Input type="number" value={c.max_days} onChange={(v) => setC({ ...c, max_days: v })} />
              </Field>
            </>
          );
          const colorF = (
            <Field label={t('Farbe')}>
              <input type="color" value={c.color} onChange={(e) => setC({ ...c, color: e.target.value })} />
            </Field>
          );
          const rest = (
            <>
              <Check checked={s.ask_phone !== false} onChange={(v) => setS({ ask_phone: v })} label={t('Telefonnummer abfragen')} />
              <Check checked={s.ask_notes !== false} onChange={(v) => setS({ ask_notes: v })} label={t('Anliegen abfragen')} />
              <Field label={t('Nach Buchung weiterleiten zu (optional)')}>
                <Input value={s.redirect_url} onChange={(v) => setS({ redirect_url: v })} placeholder={t('https://…/danke')} />
              </Field>
              <Field label={t('Geteilte Verfügbarkeit')} hint={t('Kalender mit demselben Gruppennamen blockieren sich gegenseitig (z. B. eine Person, mehrere Termintypen)')}>
                <Input value={s.shared_group} onChange={(v) => setS({ shared_group: v })} placeholder={t('z. B. paul')} />
              </Field>
            </>
          );
          if (!simple)
            return (
              <>
                <div className="grid2">
                  {nameF}
                  {slugF}
                </div>
                {descF}
                {placeF}
                <div className="grid3">
                  {durationF}
                  {timing}
                  {colorF}
                </div>
                {rest}
              </>
            );
          // Only values that differ from a new calendar's defaults open "Weitere Felder" by themselves.
          const changed = [!isAutoSlug(c.slug, c.name) && c.slug, Number(c.interval) !== 30 && c.interval, Number(c.buffer) !== 0 && c.buffer, Number(c.min_notice) !== 4 && c.min_notice, Number(c.max_days) !== 60 && c.max_days, s.ask_phone === false, s.ask_notes === false, s.redirect_url, s.shared_group];
          return (
            <>
              {nameF}
              {descF}
              {placeF}
              <div className="grid2">
                {durationF}
                {colorF}
              </div>
              <MoreFields id="calendar-basic" values={changed}>
                {slugF}
                <div className="grid2">{timing}</div>
                {rest}
              </MoreFields>
            </>
          );
        })()}
      {tab === 'hours' && (
        <div className="days-grid">
          {DAYS.map(([k, l]) => {
            const w: string[][] = c.availability?.[k] ?? [];
            return [
              <Check key={`${k}-c`} checked={w.length > 0} onChange={(on) => setDay(k, on ? [['09:00', '17:00']] : [])} label={t(l)} />,
              <div key={`${k}-w`}>
                {w.map((win, i) => (
                  <div className="row" key={i} style={{ alignItems: 'center', marginBottom: 4 }}>
                    <input type="time" value={win[0]} style={{ width: 130 }} aria-label={t('{day}: von', { day: t(l) })} onChange={(e) => setDay(k, w.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                    –
                    <input type="time" value={win[1]} style={{ width: 130 }} aria-label={t('{day}: bis', { day: t(l) })} onChange={(e) => setDay(k, w.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                    <button className="icon-btn" onClick={() => setDay(k, w.filter((_, j) => j !== i))} aria-label={t('Entfernen')}>
                      ✕
                    </button>
                  </div>
                ))}
                {w.length > 0 && (
                  <button className="btn small ghost" onClick={() => setDay(k, [...w, ['13:00', '17:00']])}>
                    + {t('Zeitfenster')}
                  </button>
                )}
              </div>,
            ];
          })}
        </div>
      )}
      {tab === 'hours' && (
        <>
          <OverridesEditor s={s} setS={setS} />
          {/* Einfach-Modus: booking limits folded unless one is set (0 = unlimited) */}
          <MoreFields id="calendar-limits" label={t('Buchungslimits')} values={[s.limit_day || '', s.limit_week || '']}>
            <LimitsEditor s={s} setS={setS} />
          </MoreFields>
        </>
      )}
      {tab === 'notify' && (
        <>
          <Check checked={s.confirmation_email !== false} onChange={(v) => setS({ confirmation_email: v })} label={t('Bestätigungs-E-Mail an den Kontakt')} />
          {/* Einfach-Modus: the standard confirmation goes out as it is; its own subject and text behind "Weitere Felder" */}
          <MoreFields id="calendar-confirmation" values={[s.confirmation_subject, s.confirmation_body]}>
            <Field label={t('Betreff')}>
              <Input value={s.confirmation_subject} onChange={(v) => setS({ confirmation_subject: v })} />
            </Field>
            <Field label={t('Text')}>
              <Textarea value={s.confirmation_body} onChange={(v) => setS({ confirmation_body: v })} rows={7} />
            </Field>
            <small className="muted">{t('Zusätzlich:')} {'{{appointment.start_text}}'}, {'{{appointment.manage_url}}'}, {'{{calendar.name}}'}, {'{{calendar.meeting_location}}'}</small>
            <MergeHint />
          </MoreFields>
          <RemindersEditor s={s} setS={setS} />
          <Check checked={s.notify_team !== false} onChange={(v) => setS({ notify_team: v })} label={t('Team per E-Mail benachrichtigen (an die Firmen-E-Mail)')} />
        </>
      )}
      {tab === 'after' && (
        <>
          <AfterEditor kind="followup" s={s} setS={setS} />
          <AfterEditor kind="noshow" s={s} setS={setS} />
        </>
      )}
      {tab === 'crm' && (
        <>
          <Field label={t('Tags bei Buchung')}>
            <TagInput value={s.tags ?? []} onChange={(v) => setS({ tags: v })} suggestions={tags} />
          </Field>
          <div className="grid2">
            <Field label={t('Opportunity anlegen in Pipeline')}>
              <Select value={s.pipeline_id} onChange={(v) => setS({ pipeline_id: v, stage_id: '' })} placeholder={t('– keine –')} options={(pipelines.data ?? []).map((p) => [p.id, p.name])} />
            </Field>
            {pipe && (
              <Field label={t('Stufe')}>
                <Select value={s.stage_id} onChange={(v) => setS({ stage_id: v })} options={pipe.stages.map((x: any) => [x.id, x.name])} />
              </Field>
            )}
          </div>
          <p className="muted">{t('Für alles Weitere: Workflow mit Auslöser „Termin gebucht“.')}</p>
        </>
      )}
    </Modal>
  );
}

function SyncTab({ cal }: { cal: any }) {
  const t = useT('calendar');
  const [urls, setUrls] = useState<string>((cal.settings?.ical_import ?? []).join('\n'));
  const [status, setStatus] = useState<any>(cal.settings?.ical_status);
  const feed = useLoad(() => api.get(`/api/calendars/${cal.id}/feed`), [cal.id]);
  const busy = useLoad(() => api.get<any[]>(`/api/calendars/${cal.id}/busy`), [cal.id]);
  return (
    <>
      <CalendarConnectionInfo calId={cal.id} />
      <h3>{t('Oder per iCal: belegte Zeiten aus deinem Kalender übernehmen')}</h3>
      <p className="muted small">
        {t('Google Kalender → Einstellungen → dein Kalender → „Privatadresse im iCal-Format“ kopieren. Outlook: Kalender veröffentlichen → ICS-Link. Apple: Kalender teilen → öffentlicher Link. Termine dort blockieren dann die Buchungsseite (Abgleich alle 10 Minuten).')}
      </p>
      <Field label={t('iCal-Adressen (eine pro Zeile)')} tour="calendar-ical">
        <Textarea value={urls} onChange={setUrls} rows={3} placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" />
      </Field>
      <button
        className="btn"
        onClick={async () => {
          const r = await act(() => api.post(`/api/calendars/${cal.id}/sync`, { urls: urls.split('\n') }));
          if (r) {
            setStatus(r);
            busy.reload();
          }
        }}
      >
        {t('Speichern & jetzt abgleichen')}
      </button>
      {status && (
        <p className={status.ok ? 'muted' : ''} style={status.ok ? {} : { color: 'var(--red)' }}>
          {t('Letzter Abgleich {date}: {n} belegte Zeiten', { date: fmtDateTime(status.at), n: status.events })}
          {status.message ? ` – ${status.message}` : ''}
        </p>
      )}
      {(busy.data ?? []).length > 0 && (
        <table className="t">
          <tbody>
            {busy.data!.slice(0, 8).map((b, i) => (
              <tr key={i}>
                <td>{fmtDateTime(b.start_at, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td>– {fmtTime(b.end_at)}</td>
                <td className="muted">{b.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <hr />
      <h3>{t('Gebuchte Termine in Google/Outlook/Apple anzeigen')}</h3>
      <p className="muted small">{t('Diese private Adresse in Google Kalender unter „Weitere Kalender → Per URL“ (Outlook: „Kalender hinzufügen → Aus dem Internet“) einfügen. Wer sie kennt, sieht die Termine – nicht weitergeben.')}</p>
      {feed.data && <CodeBox text={feed.data.url} />}
      <p>
        <button className="btn small ghost" onClick={async () => confirmAsk(t('Neue Adresse erzeugen? Die alte funktioniert dann nicht mehr.')) && feed.setData(await api.get(`/api/calendars/${cal.id}/feed?renew=1`))}>
          {t('Neue Adresse erzeugen')}
        </button>
      </p>
    </>
  );
}

function BookModal({ calendars, onClose, onSaved }: { calendars: any[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('calendar');
  const [f, setF] = useState<any>({ calendar_id: calendars[0]?.id, start: '', email: '', first_name: '', blocked: false, end: '', title: '' });
  const save = async () => {
    const body = f.blocked
      ? { calendar_id: f.calendar_id, blocked: true, title: f.title, start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString() }
      : { calendar_id: f.calendar_id, start: new Date(f.start).toISOString(), contact: { email: f.email, first_name: f.first_name, last_name: f.last_name }, notes: f.notes, force: true };
    const r = await act(() => api.post('/api/appointments', body), t('Eingetragen'));
    if (r) onSaved();
  };
  return (
    <Modal title={t('Termin eintragen')} onClose={onClose} footer={<button className="btn" onClick={save}>{t('Speichern')}</button>}>
      <Field label={t('Kalender')}>
        <Select value={f.calendar_id} onChange={(v) => setF({ ...f, calendar_id: v })} options={calendars.map((c) => [c.id, c.name])} />
      </Field>
      <Check checked={f.blocked} onChange={(v) => setF({ ...f, blocked: v })} label={t('Zeit blockieren (kein Kontakt)')} />
      <div className="grid2">
        <Field label={t('Beginn')}>
          <Input type="datetime-local" value={f.start} onChange={(v) => setF({ ...f, start: v })} />
        </Field>
        {f.blocked && (
          <Field label={t('Ende')}>
            <Input type="datetime-local" value={f.end} onChange={(v) => setF({ ...f, end: v })} />
          </Field>
        )}
      </div>
      {f.blocked ? (
        <Field label={t('Titel')}>
          <Input value={f.title} onChange={(v) => setF({ ...f, title: v })} placeholder={t('Urlaub')} />
        </Field>
      ) : (
        <div className="grid2">
          <Field label={t('Vorname')}>
            <Input value={f.first_name} onChange={(v) => setF({ ...f, first_name: v })} />
          </Field>
          <Field label={t('Nachname')}>
            <Input value={f.last_name} onChange={(v) => setF({ ...f, last_name: v })} />
          </Field>
          <Field label={t('E-Mail')}>
            <Input value={f.email} onChange={(v) => setF({ ...f, email: v })} />
          </Field>
          <Field label={t('Notiz')}>
            <Input value={f.notes} onChange={(v) => setF({ ...f, notes: v })} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** One line under a calendar's name: team, price, video. */
function TypeLine({ t: type }: { t?: any }) {
  const t = useT('calendar');
  if (!type) return null;
  const bits: string[] = [];
  if (type.kind !== 'single' && type.members?.length) bits.push(type.members.map((m: any) => m.name).join(', '));
  if (type.kind === 'group') bits.push(type.waitlist ? t('{n} Plätze + Warteliste', { n: type.capacity }) : t('{n} Plätze', { n: type.capacity }));
  if (type.payment) bits.push(type.payment.mode === 'deposit' ? t('Anzahlung {amount} vorab', { amount: money(type.payment.deposit_cents, type.payment.currency) }) : t('{amount} vorab', { amount: money(type.payment.amount_cents, type.payment.currency) }));
  if (type.video && type.video !== 'none') bits.push(({ meet: 'Google Meet', zoom: 'Zoom', teams: 'Teams', static: t('fester Ort') } as Record<string, string>)[type.video as string] ?? type.video);
  if (type.questions) bits.push(t.plural(type.questions, { one: '{n} Frage', other: '{n} Fragen' }));
  return bits.length ? <div className="muted small">{bits.join(' · ')}</div> : null;
}

export function Calendars() {
  const t = useT('calendar');
  const [tab, setTab] = useState('view');
  const [range, setRange] = useState('upcoming');
  const [modal, setModal] = useState<any>(null);
  const cals = useLoad(() => api.get<any[]>('/api/calendars'), []);
  const types = useLoad(() => api.get<any[]>('/api/team-calendars/types').catch(() => [] as any[]), []);
  const typeOf = (id: string) => types.data?.find((t) => t.id === id);
  const from = range === 'past' ? new Date(Date.now() - 90 * 864e5).toISOString() : new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const to = range === 'past' ? new Date().toISOString() : new Date(Date.now() + 120 * 864e5).toISOString();
  const appts = useLoad(() => api.get<any[]>(`/api/appointments?from=${from}&to=${to}`), [range]);

  const setStatus = async (a: any, status: string) => {
    // Cancelling a paid appointment asks about the refund; everything else is a plain status change.
    if (status === 'cancelled' && a.status === 'confirmed') return setModal({ kind: 'cancel', a });
    await act(() => api.patch(`/api/appointments/${a.id}`, { status }));
    appts.reload();
  };
  const groups = new Map<string, any[]>();
  for (const a of (range === 'past' ? [...(appts.data ?? [])].reverse() : appts.data) ?? []) {
    const k = fmtDate(a.start_at, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }

  return (
    <>
      <PageHead title={t('Kalender')}>
        {tab === 'appointments' && cals.data?.length ? (
          <button className="btn secondary" data-tour="calendars-book" onClick={() => setModal({ kind: 'book' })}>
            + {t('Termin eintragen')}
          </button>
        ) : null}
        <button className="btn" data-tour="calendars-new" onClick={() => setModal({ kind: 'cal' })}>
          + {t('Kalender')}
        </button>
      </PageHead>
      <Tabs tabs={[['view', t('Kalenderansicht')], ['appointments', t('Termine')], ['calendars', t('Kalender ({n})', { n: cals.data?.length ?? 0 })], ['routing', t('Routing-Formulare')], ['menus', t('Leistungsmenüs')], ['events', t('Events & Tickets')], ['rentals', t('Vermietung')]]} value={tab} onChange={setTab} />
      {tab === 'view' && <CalendarView calendars={cals.data ?? []} />}
      {/* Rental items (settings.rental) are booked by date range, never as time slots – not offered as services or routing targets. */}
      {tab === 'routing' && <RoutingForms calendars={(cals.data ?? []).filter((c) => !c.settings?.rental)} />}
      {tab === 'menus' && <ServiceMenus calendars={(cals.data ?? []).filter((c) => !c.settings?.rental)} />}
      {tab === 'events' && <TicketEvents />}
      {tab === 'rentals' && <Rentals />}
      {tab === 'appointments' && (
        <>
          <Tabs tabs={[['upcoming', t('Anstehend')], ['past', t('Vergangen (90 T.)')]]} value={range} onChange={setRange} />
          {appts.loading && !appts.data ? (
            <Spinner />
          ) : groups.size ? (
            [...groups].map(([day, list]) => (
              <div key={day} className="card">
                <h2>{day}</h2>
                <table className="t appt-table">
                  <tbody>
                    {list.map((a) => (
                      <tr key={a.id}>
                        <td style={{ width: 120 }}>
                          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: a.calendar_color, marginRight: 6 }} />
                          {fmtTime(a.start_at)}–{fmtTime(a.end_at)}
                        </td>
                        <td>
                          {a.contact_id ? <Link to={`contacts/${a.contact_id}`}>{name(a)}</Link> : <em>{a.title}</em>}
                          <div className="muted small" title={a.notes || undefined}>
                            {a.calendar_name}
                            {a.notes ? ` · ${a.notes.length > 90 ? `${a.notes.slice(0, 90)}…` : a.notes}` : ''}
                          </div>
                          <ApptDetails a={a} />
                        </td>
                        <td>
                          <Badge tone={STATUS[a.status]?.[1]}>{STATUS[a.status] ? t(STATUS[a.status][0]) : a.status}</Badge>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {a.status !== 'blocked' && (
                            <div style={{ width: 170, marginLeft: 'auto' }}>
                              <Select value={a.status} onChange={(v) => setStatus(a, v)} aria={t('Status')} options={Object.entries(STATUS).filter(([k]) => k !== 'blocked').map(([k, v]) => [k, t(v[0])])} />
                            </div>
                          )}
                          {a.status === 'confirmed' && a.contact_id && new Date(a.end_at) > new Date() && (
                            <div className="tc-appt-actions">
                              <button className="tx-btn" onClick={() => setModal({ kind: 'move', a })}>
                                {t('Verschieben')}
                              </button>
                              <button className="tx-btn" onClick={() => setModal({ kind: 'cancel', a })}>
                                {t('Absagen…')}
                              </button>
                            </div>
                          )}
                          {a.status === 'blocked' && (
                            <button className="btn small secondary" onClick={() => act(() => api.del(`/api/appointments/${a.id}`)).then(appts.reload)}>
                              {t('Freigeben')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          ) : (
            <Empty>{t('Keine Termine.')}</Empty>
          )}
        </>
      )}
      {tab === 'calendars' &&
        (cals.data?.length ? (
          cals.data.map((c) => (
            <div key={c.id} className="card" data-tour="calendar-card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h2 style={{ margin: 0 }}>
                    <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: c.color, marginRight: 8 }} />
                    {c.name} {!c.active && <Badge>{t('inaktiv')}</Badge>} <KindBadge t={typeOf(c.id)} />
                  </h2>
                  <span className="muted">{t('{min} Min. · {days} Tage/Woche · Vorlauf {hours} Std.', { min: c.duration, days: Object.keys(c.availability).length, hours: c.min_notice })}</span>
                  <TypeLine t={typeOf(c.id)} />
                </div>
                <div className="actions">
                  <a className="btn small secondary" href={c.url} target="_blank" rel="noreferrer">
                    {t('Öffnen')} ↗
                  </a>
                  <button className="btn small secondary" data-tour="calendar-edit" onClick={() => setModal({ kind: 'cal', cal: c })}>
                    {t('Bearbeiten')}
                  </button>
                  <button className="btn small secondary" onClick={() => act(() => api.patch(`/api/calendars/${c.id}`, { active: !c.active })).then(cals.reload)}>
                    {c.active ? t('Deaktivieren') : t('Aktivieren')}
                  </button>
                  <button className="btn small danger" onClick={() => confirmAsk(t('Kalender und alle Termine löschen?')) && act(() => api.del(`/api/calendars/${c.id}`)).then(cals.reload)}>
                    {t('Löschen')}
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 10 }} data-tour="calendar-link">
                <ShareLink url={c.url} title={t('Buchungsseite {name}', { name: c.name })} />
                <div style={{ height: 6 }} />
                <CodeBox text={`<iframe src="${c.url}?embed=1" style="width:100%;min-height:720px;border:0"></iframe>`} />
              </div>
            </div>
          ))
        ) : (
          <Empty learn action={<button className="btn" onClick={() => setModal({ kind: 'cal' })}>{t('Kalender anlegen')}</button>}>{t('Noch kein Kalender – Kunden können dann online Termine buchen.')}</Empty>
        ))}
      {modal?.kind === 'cal' && <CalendarEditor cal={modal.cal} type={modal.cal ? typeOf(modal.cal.id) : undefined} onClose={() => setModal(null)} onSaved={() => (setModal(null), cals.reload(), types.reload())} />}
      {modal?.kind === 'cancel' && <CancelModal a={modal.a} onClose={() => setModal(null)} onDone={() => (setModal(null), appts.reload())} />}
      {modal?.kind === 'move' && <MoveModal a={modal.a} onClose={() => setModal(null)} onDone={() => (setModal(null), appts.reload())} />}
      {modal?.kind === 'book' && <BookModal calendars={cals.data ?? []} onClose={() => setModal(null)} onSaved={() => (setModal(null), appts.reload())} />}
    </>
  );
}
