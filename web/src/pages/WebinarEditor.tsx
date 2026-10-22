import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Empty, PageHead, Spinner, Tabs, act, navigate, useLoad } from '../ui';
import { setIn } from './WebinarKit';
import { RemindersTab, RoomTab } from './WebinarRoomTab';
import { StatsTab } from './WebinarStats';
import { BasicsTab, RegistrationTab, ScheduleTab } from './WebinarTabs';

/** The webinar editor: one form over six tabs, saved as a whole (the server validates everything and says what is wrong). */

/** The tabs (the academy finds their `data-tour="tab-…"` keys from this list). */
const TABS: [string, string][] = [
  ['basics', 'Grunddaten'],
  ['schedule', 'Termine'],
  ['registration', 'Anmeldung'],
  ['room', 'Raum & Angebot'],
  ['reminders', 'Erinnerungen'],
  ['stats', 'Auswertung'],
];

const FIELDS = ['title', 'slug', 'description', 'presenter_name', 'presenter_photo', 'video', 'duration_s', 'schedule', 'settings'] as const;
const pick = (w: any) => Object.fromEntries(FIELDS.map((k) => [k, w[k]]));

export function WebinarEditor({ id, tab = 'basics' }: { id: string; tab?: string }) {
  const { data, error, loading } = useLoad(() => api.get(`/api/webinars/${id}`), [id]);
  const [w, setW] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [saved, setSaved] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setW(data);
    setForm(pick(data));
    setSaved(pick(data));
  }, [data]);

  const set = useCallback((path: string, value: unknown) => setForm((f: any) => setIn(f, path, value)), []);
  const dirty = useMemo(() => !!form && !!saved && JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => (e.preventDefault(), (e.returnValue = ''));
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  if (loading && !w) return <Spinner />;
  if (error && !w) return <Empty>{error}</Empty>;
  if (!w || !form) return <Spinner />;

  const apply = (fresh: any) => {
    setW(fresh);
    setForm(pick(fresh));
    setSaved(pick(fresh));
  };
  const save = async (extra: Record<string, unknown> = {}, ok = 'Gespeichert') => {
    setBusy(true);
    const r = await act(() => api.patch(`/api/webinars/${id}`, { ...(extra.status === 'draft' ? {} : form), ...extra }), ok);
    setBusy(false);
    if (r) apply(r);
    return r;
  };
  /** An upload finished: the server already made it the webinar's video; take it over without touching other unsaved edits. */
  const reloadVideo = async () => {
    const fresh = await api.get(`/api/webinars/${id}`);
    setW(fresh);
    setForm((f: any) => ({ ...f, video: fresh.video, duration_s: f.duration_s || fresh.duration_s }));
    setSaved((s: any) => ({ ...s, video: fresh.video }));
  };

  const props = { form, set, w };
  const published = w.status === 'published';
  return (
    <>
      <PageHead
        title={form.title || 'Webinar'}
        sub={
          <>
            <Badge tone={published ? 'green' : 'gray'}>{published ? 'Veröffentlicht' : 'Entwurf'}</Badge> <a href={w.urls.page} target="_blank" rel="noreferrer">{w.urls.page}</a>
          </>
        }
      >
        <button className="btn secondary" onClick={() => navigate('webinars')}>
          ← Alle Webinare
        </button>
        <button className="btn secondary" data-tour="webinar-save" disabled={!dirty || busy} onClick={() => save()}>
          {dirty ? 'Speichern' : 'Gespeichert ✓'}
        </button>
        {published ? (
          <button className="btn secondary" disabled={busy} onClick={() => save({ status: 'draft' }, 'Zurück im Entwurf – die Seite ist nicht mehr erreichbar')}>
            Zurück zum Entwurf
          </button>
        ) : (
          <button className="btn" data-tour="webinar-publish" disabled={busy} onClick={() => save({ status: 'published' }, 'Veröffentlicht')}>
            Veröffentlichen
          </button>
        )}
      </PageHead>
      {!published && w.problems?.length > 0 && (
        <div className="wb-callout" role="note">
          <b>Zum Veröffentlichen fehlt noch:</b>
          <ul>
            {w.problems.map((p: string) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <span className="muted small">Das Video und die Termine speicherst du in den Tabs „Grunddaten“ und „Termine“.</span>
        </div>
      )}
      <Tabs tabs={TABS} value={tab} onChange={(t) => navigate(`webinars/${id}/${t}`)} />
      <div className="wb-tab">
        {tab === 'basics' && <BasicsTab {...props} reload={reloadVideo} />}
        {tab === 'schedule' && <ScheduleTab {...props} />}
        {tab === 'registration' && <RegistrationTab {...props} />}
        {tab === 'room' && <RoomTab {...props} />}
        {tab === 'reminders' && <RemindersTab {...props} />}
        {tab === 'stats' && <StatsTab {...props} />}
        {!TABS.some(([k]) => k === tab) && <Empty>Diesen Reiter gibt es nicht.</Empty>}
      </div>
      {dirty && tab !== 'stats' && (
        <div className="wb-savebar" role="status">
          <span>Ungespeicherte Änderungen</span>
          <button className="btn" disabled={busy} onClick={() => save()}>
            Speichern
          </button>
        </div>
      )}
    </>
  );
}
