import { useEffect, useMemo, useState } from 'react';
import { api, currentLocation, d, dt, name } from '../api';
import { Badge, Check, Empty, Field, Input, Modal, Select, Spinner, Textarea, act, confirmAsk, toastError, useLoad } from '../ui';
import './CourseDepth.css';
import { getLocale, tr, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { SortableGrid } from '../sortable/Sortable';

/** Kurs-Tabs „Diskussion“, „Bewertungen“, „Cohorts“, „Auswertung“ und die zusätzlichen Kurs-Einstellungen. Server: course-discuss/-paths/-analytics. */

const stars = (n: number) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));
/** "12 %" / "1,5" in German (as before), "12%" / "1.5" in English. */
const pctText = (n: number) => (getLocale() === SOURCE_LOCALE ? `${Math.round(n)} %` : `${Math.round(n)}%`);
const dec = (n: number) => (getLocale() === SOURCE_LOCALE ? String(n).replace('.', ',') : String(n));

// --- discussion ------------------------------------------------------------------------------------------------
type Comment = { id: string; lesson_id: string; lesson_title: string; parent_id: string | null; author_name: string; staff: boolean; body: string; status: 'visible' | 'hidden'; created_at: string; edited_at: string | null; needs_reply?: boolean };

function Reply({ course, c, onDone }: { course: any; c: Comment; onDone: () => void }) {
  const t = useT('courses');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <Textarea value={text} onChange={setText} rows={3} maxLength={2000} placeholder={t('Deine Antwort (erscheint mit dem Badge „Kursleitung“, die Person wird benachrichtigt)')} aria-label={t('Antwort')} autoFocus />
      <div className="actions" style={{ marginTop: 6 }}>
        <button
          className="btn small"
          disabled={busy || text.trim().length < 2}
          onClick={async () => {
            setBusy(true);
            const r = await act(() => api.post(`/api/courses/${course.id}/comments`, { lesson_id: c.lesson_id, parent_id: c.id, body: text }), t('Antwort veröffentlicht'));
            setBusy(false);
            if (r) onDone();
          }}
        >
          {t('Antworten')}
        </button>
        <button className="btn small ghost" onClick={onDone}>
          {t('Abbrechen')}
        </button>
      </div>
    </div>
  );
}

function CommentCard({ course, c, replies, reload }: { course: any; c: Comment; replies: Comment[]; reload: () => void }) {
  const t = useT('courses');
  const [reply, setReply] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const patch = (body: any, ok?: string) => act(() => api.patch(`/api/courses/${course.id}/comments/${c.id}`, body), ok).then((r) => r && reload());
  return (
    <div className={`cd-thread${c.status === 'hidden' ? ' hidden' : ''}`}>
      <div className="meta">
        <b>{c.author_name}</b>
        {c.staff && <Badge tone="blue">{t('Kursleitung')}</Badge>}
        {c.status === 'hidden' && <Badge tone="yellow">{t('ausgeblendet')}</Badge>}
        {c.needs_reply && <Badge tone="red">{t('unbeantwortet')}</Badge>}
        <span>{dt(c.created_at)}</span>
        <span>· {c.lesson_title}</span>
      </div>
      {edit === null ? <p>{c.body}</p> : <Textarea value={edit} onChange={setEdit} rows={3} maxLength={2000} aria-label={t('Antwort bearbeiten')} />}
      <div className="acts">
        {edit === null ? (
          <>
            {!c.parent_id && (
              <button className="btn small secondary" onClick={() => setReply(!reply)}>
                {t('Antworten')}
              </button>
            )}
            {c.staff && (
              <button className="btn small ghost" onClick={() => setEdit(c.body)}>
                {t('Bearbeiten')}
              </button>
            )}
            <button className="btn small ghost" onClick={() => patch({ status: c.status === 'hidden' ? 'visible' : 'hidden' }, c.status === 'hidden' ? t('Wieder sichtbar') : t('Ausgeblendet'))}>
              {c.status === 'hidden' ? t('Einblenden') : t('Ausblenden')}
            </button>
            <button
              className="btn small ghost danger-text"
              onClick={async () => confirmAsk(replies.length ? t.plural(replies.length, { other: 'Kommentar mit {n} Antwort(en) löschen?' }) : t('Kommentar löschen?')) && (await act(() => api.del(`/api/courses/${course.id}/comments/${c.id}`), t('Gelöscht'))) && reload()}
            >
              {t('Löschen')}
            </button>
          </>
        ) : (
          <>
            <button className="btn small" onClick={() => patch({ body: edit }, t('Gespeichert')).then(() => setEdit(null))}>
              {t('Speichern')}
            </button>
            <button className="btn small ghost" onClick={() => setEdit(null)}>
              {t('Abbrechen')}
            </button>
          </>
        )}
      </div>
      {reply && <Reply course={course} c={c} onDone={() => (setReply(false), reload())} />}
      {replies.map((r) => (
        <div key={r.id} style={{ marginTop: 10, paddingLeft: 14, borderLeft: '3px solid var(--line)' }}>
          <CommentCard course={course} c={r} replies={[]} reload={reload} />
        </div>
      ))}
    </div>
  );
}

export function CourseDiscussion({ course }: { course: any }) {
  const t = useT('courses');
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const [lesson, setLesson] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const lessons = (course.modules ?? []).flatMap((m: any) => m.lessons) as { id: string; title: string }[];
  const qs = new URLSearchParams();
  if (filter === 'open') qs.set('needs_reply', '1');
  if (filter === 'hidden') qs.set('status', 'hidden');
  if (lesson) qs.set('lesson_id', lesson);
  if (debounced) qs.set('q', debounced);
  const list = useLoad(() => api.get<Comment[]>(`/api/courses/${course.id}/comments?${qs}`), [course.id, filter, lesson, debounced]);
  const rows = list.data ?? [];
  const tree = useMemo(() => {
    const ids = new Set(rows.map((r) => r.id));
    const kids = new Map<string, Comment[]>();
    for (const r of rows) if (r.parent_id && ids.has(r.parent_id)) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r]);
    for (const l of kids.values()) l.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { roots: rows.filter((r) => !r.parent_id || !ids.has(r.parent_id)), kids };
  }, [rows]);
  const enabled = course.settings?.comments_enabled !== false;
  return (
    <div className="cd" data-tour="course-discussion">
      {!enabled && <div className="cd-note">{t('Die Diskussion ist für diesen Kurs ausgeschaltet (Einstellungen & Zugang). Bestehende Kommentare bleiben gespeichert.')}</div>}
      <div className="cd-bar">
        <div style={{ width: 210 }}>
          <Select value={filter} onChange={setFilter} options={[['open', t('Unbeantwortete Fragen')], ['all', t('Alle Kommentare')], ['hidden', t('Ausgeblendet')]]} />
        </div>
        <div style={{ width: 240 }}>
          <Select value={lesson} onChange={setLesson} placeholder={t('Alle Lektionen')} options={lessons.map((l) => [l.id, l.title])} />
        </div>
        <div className="grow" style={{ minWidth: 160 }}>
          <Input value={q} onChange={setQ} placeholder={t('Suchen …')} aria-label={t('Kommentare durchsuchen')} />
        </div>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : !tree.roots.length ? (
        <Empty>{filter === 'open' ? t('Keine unbeantworteten Fragen – gut gemacht.') : t('Keine Kommentare gefunden.')}</Empty>
      ) : (
        tree.roots.map((c) => <CommentCard key={c.id} course={course} c={c} replies={tree.kids.get(c.id) ?? []} reload={() => void list.reload()} />)
      )}
    </div>
  );
}

// --- reviews ------------------------------------------------------------------------------------------------------
type Review = { id: string; author_name: string; email?: string; rating: number; title: string; body: string; status: 'pending' | 'published' | 'rejected'; reply: string; created_at: string };

function ReviewCard({ course, r, reload }: { course: any; r: Review; reload: () => void }) {
  const t = useT('courses');
  const [reply, setReply] = useState<string | null>(null);
  const patch = (body: any, ok?: string) => act(() => api.patch(`/api/courses/${course.id}/reviews/${r.id}`, body), ok).then((x) => x && reload());
  return (
    <div className="cd-thread">
      <div className="meta">
        <span className="cd-stars" aria-label={t('{n} von 5 Sternen', { n: r.rating })}>{stars(r.rating)}</span>
        <b>{r.author_name}</b>
        <Badge tone={r.status === 'published' ? 'green' : r.status === 'pending' ? 'yellow' : 'gray'}>{r.status === 'published' ? t('veröffentlicht') : r.status === 'pending' ? t('wartet auf Freigabe') : t('abgelehnt')}</Badge>
        <span>{dt(r.created_at)}</span>
        {r.email && <span>· {r.email}</span>}
      </div>
      {r.title && <p><b>{r.title}</b></p>}
      {r.body && <p>{r.body}</p>}
      {r.reply && reply === null && <p className="muted"><b>{t('Deine Antwort:')}</b> {r.reply}</p>}
      {reply !== null && (
        <>
          <Textarea value={reply} onChange={setReply} rows={3} maxLength={1000} aria-label={t('Antwort auf die Bewertung')} placeholder={t('Öffentliche Antwort der Kursleitung')} />
          <div className="actions" style={{ marginTop: 6 }}>
            <button className="btn small" onClick={() => patch({ reply }, t('Antwort gespeichert')).then(() => setReply(null))}>
              {t('Speichern')}
            </button>
            <button className="btn small ghost" onClick={() => setReply(null)}>
              {t('Abbrechen')}
            </button>
          </div>
        </>
      )}
      <div className="acts">
        {r.status !== 'published' && (
          <button className="btn small" onClick={() => patch({ status: 'published' }, t('Veröffentlicht'))}>
            {t('Veröffentlichen')}
          </button>
        )}
        {r.status !== 'rejected' && (
          <button className="btn small secondary" onClick={() => patch({ status: 'rejected' }, r.status === 'published' ? t('Zurückgezogen') : t('Abgelehnt'))}>
            {r.status === 'published' ? t('Zurückziehen') : t('Ablehnen')}
          </button>
        )}
        {reply === null && (
          <button className="btn small ghost" onClick={() => setReply(r.reply)}>
            {r.reply ? t('Antwort ändern') : t('Antworten')}
          </button>
        )}
        <button className="btn small ghost danger-text" onClick={async () => confirmAsk(t('Bewertung endgültig löschen?')) && (await act(() => api.del(`/api/courses/${course.id}/reviews/${r.id}`), t('Gelöscht'))) && reload()}>
          {t('Löschen')}
        </button>
      </div>
    </div>
  );
}

export function CourseReviews({ course }: { course: any }) {
  const t = useT('courses');
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.get<{ summary: { count: number; average: number; distribution: number[] }; pending: number; reviews: Review[] }>(`/api/courses/${course.id}/reviews${status ? `?status=${status}` : ''}`), [course.id, status]);
  const data = list.data;
  if (!data) return list.error ? <Empty>{list.error}</Empty> : <Spinner />;
  const max = Math.max(1, ...data.summary.distribution);
  return (
    <div className="cd" data-tour="course-reviews">
      <div className="cd-split two" style={{ marginBottom: 14 }}>
        <div className="cd-stat">
          <b>{data.summary.count ? `${dec(data.summary.average)} ` : '–'}<span className="cd-stars">{data.summary.count ? stars(data.summary.average) : ''}</span></b>
          <span>{t.plural(data.summary.count, { one: '{n} veröffentlichte Bewertung', other: '{n} veröffentlichte Bewertungen' })}{data.pending ? t(' · {n} warten auf Freigabe', { n: data.pending }) : ''}</span>
        </div>
        <div className="cd-stat" aria-label={t('Verteilung der Sterne')}>
          {[5, 4, 3, 2, 1].map((n) => (
            <div key={n} className="row" style={{ alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 28 }}>{n} ★</span>
              <div className="cd-meter grow"><span style={{ width: `${(data.summary.distribution[n - 1] / max) * 100}%` }} /></div>
              <span style={{ width: 24, textAlign: 'right' }}>{data.summary.distribution[n - 1]}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="cd-bar">
        <div style={{ width: 230 }}>
          <Select value={status} onChange={setStatus} placeholder={t('Alle Bewertungen')} options={[['pending', t('Wartet auf Freigabe')], ['published', t('Veröffentlicht')], ['rejected', t('Abgelehnt')]]} />
        </div>
        <span className="muted small">
          {course.settings?.reviews_enabled === false ? t('Bewertungen sind für diesen Kurs ausgeschaltet.') : course.settings?.reviews_moderation === false ? t('Neue Bewertungen erscheinen sofort.') : t('Neue Bewertungen erscheinen erst nach deiner Freigabe.')}
        </span>
      </div>
      {!data.reviews.length ? <Empty>{t('Keine Bewertungen in dieser Ansicht.')}</Empty> : data.reviews.map((r) => <ReviewCard key={r.id} course={course} r={r} reload={() => void list.reload()} />)}
    </div>
  );
}

// --- cohorts --------------------------------------------------------------------------------------------------------
type Cohort = { id: string; name: string; starts_at: string; ends_at: string | null; capacity: number; group_id: string | null; channel_id: string | null; state: 'upcoming' | 'running' | 'ended'; members: number; full: boolean };

function CohortForm({ course, cohort, onClose, onSaved }: { course: any; cohort?: Cohort; onClose: () => void; onSaved: () => void }) {
  const t = useT('courses');
  const groups = useLoad(() => api.get<any[]>('/api/community/groups').catch(() => []), []);
  const [f, setF] = useState({ name: cohort?.name ?? '', starts_at: cohort?.starts_at ?? '', ends_at: cohort?.ends_at ?? '', capacity: cohort?.capacity ?? 0, group_id: cohort?.group_id ?? '', channel_id: cohort?.channel_id ?? '' });
  const group = (groups.data ?? []).find((g) => g.id === f.group_id);
  const save = async () => {
    const body = { ...f, capacity: Number(f.capacity) || 0, ends_at: f.ends_at || '', group_id: f.group_id || '', channel_id: f.group_id ? f.channel_id || '' : '' };
    const r = await act(() => (cohort ? api.patch(`/api/courses/${course.id}/cohorts/${cohort.id}`, body) : api.post(`/api/courses/${course.id}/cohorts`, body)), t('Cohort gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal title={cohort ? t('Cohort bearbeiten') : t('Neuer Cohort')} onClose={onClose}>
      <Field label={t('Name')} hint={t('z. B. „Herbst 2026“')}>
        <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} autoFocus />
      </Field>
      <div className="grid2">
        <Field label={t('Start')} hint={t('Ab diesem Tag zählt die zeitversetzte Freischaltung (Drip).')}>
          <Input type="date" value={f.starts_at} onChange={(v) => setF({ ...f, starts_at: v })} />
        </Field>
        <Field label={t('Ende (optional)')}>
          <Input type="date" value={f.ends_at} onChange={(v) => setF({ ...f, ends_at: v })} />
        </Field>
      </div>
      <Field label={t('Plätze (0 = unbegrenzt)')}>
        <Input type="number" min={0} value={f.capacity || ''} onChange={(v) => setF({ ...f, capacity: Number(v) || 0 })} placeholder={t('unbegrenzt')} />
      </Field>
      <Field label={t('Community-Gruppe (optional)')} hint={t('Mitglieder des Cohorts sehen auf der Kursseite einen Link in diesen Chat.')}>
        <Select value={f.group_id} onChange={(v) => setF({ ...f, group_id: v, channel_id: '' })} placeholder={t('Keine')} options={(groups.data ?? []).map((g) => [g.id, g.name])} />
      </Field>
      {group && (
        <Field label={t('Kanal')}>
          <Select value={f.channel_id} onChange={(v) => setF({ ...f, channel_id: v })} placeholder={t('Erster Kanal der Gruppe')} options={(group.channels ?? []).map((c: any) => [c.id, c.name])} />
        </Field>
      )}
      <div className="actions">
        <button className="btn" disabled={!f.name.trim() || !f.starts_at} onClick={save}>
          {t('Speichern')}
        </button>
        <button className="btn ghost" onClick={onClose}>
          {t('Abbrechen')}
        </button>
      </div>
    </Modal>
  );
}

function CohortMembers({ course, cohort, onClose, onChanged }: { course: any; cohort: Cohort; onClose: () => void; onChanged: () => void }) {
  const t = useT('courses');
  const list = useLoad(() => api.get<any[]>(`/api/courses/${course.id}/cohorts/${cohort.id}/members`), [cohort.id]);
  const [email, setEmail] = useState('');
  const add = async () => {
    const r = await act(() => api.post(`/api/courses/${course.id}/cohorts/${cohort.id}/members`, { email }), t('Zum Cohort hinzugefügt'));
    if (r) (setEmail(''), void list.reload(), onChanged());
  };
  return (
    <Modal title={t('Teilnehmer: {name}', { name: cohort.name })} onClose={onClose}>
      <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Input type="email" value={email} onChange={setEmail} placeholder={t('E-Mail der Person')} aria-label={t('E-Mail')} onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && void add()} />
        <button className="btn" disabled={!email.includes('@')} onClick={add}>
          {t('Hinzufügen')}
        </button>
      </div>
      <p className="cd-hint">{t('Legt bei Bedarf den Kontakt und den Kurszugang an. Wer schon im Kurs ist, wird in diesen Cohort verschoben.')}</p>
      {!list.data ? (
        <Spinner />
      ) : !list.data.length ? (
        <Empty>{t('Noch niemand in diesem Cohort.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <tbody>
              {list.data.map((m) => (
                <tr key={m.contact_id}>
                  <td>
                    {name(m)} <span className="muted small">{m.email}</span>
                  </td>
                  <td className="num">{m.progress?.percent ?? 0} %</td>
                  <td>
                    <button className="btn small ghost" onClick={async () => (await act(() => api.del(`/api/courses/${course.id}/cohorts/${cohort.id}/members/${m.contact_id}`), t('Aus dem Cohort entfernt'))) && (void list.reload(), onChanged())}>
                      {t('Entfernen')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// German labels (message ids of the courses catalog), shown through t()
const STATE: Record<string, [string, 'blue' | 'green' | 'gray']> = { upcoming: ['startet bald', 'blue'], running: ['läuft', 'green'], ended: ['beendet', 'gray'] };

export function CourseCohorts({ course }: { course: any }) {
  const t = useT('courses');
  const list = useLoad(() => api.get<Cohort[]>(`/api/courses/${course.id}/cohorts`), [course.id]);
  const [edit, setEdit] = useState<Cohort | 'new' | null>(null);
  const [members, setMembers] = useState<Cohort | null>(null);
  return (
    <div className="cd" data-tour="course-cohorts">
      <div className="cd-bar">
        <button className="btn" onClick={() => setEdit('new')}>
          {t('+ Cohort')}
        </button>
        <span className="muted small grow">
          {t('Ein Cohort ist eine Gruppe mit gemeinsamem Start. Die Freischaltung der Module („nach … Tagen“) zählt dann ab dem Cohort-Start statt ab dem Tag der Anmeldung.')}
          {course.settings?.cohort_mode === 'auto' ? t(' Neue Teilnehmer landen automatisch im nächsten offenen Cohort.') : t(' Automatische Zuweisung: Einstellungen & Zugang.')}
        </span>
      </div>
      {!list.data ? (
        <Spinner />
      ) : !list.data.length ? (
        <Empty>{t('Noch keine Cohorts. Ohne Cohort zählt die Freischaltung ab der Anmeldung.')}</Empty>
      ) : (
        <SortableGrid id="course.cohorts" className="cd-grid">
          {list.data.map((c) => (
            <div key={c.id} className="cd-card">
              <h3>{c.name}</h3>
              <div className="cd-badges">
                <Badge tone={STATE[c.state][1]}>{t(STATE[c.state][0])}</Badge>
                {c.full && <Badge tone="yellow">{t('voll')}</Badge>}
                {c.group_id && <Badge tone="purple">{t('Community-Chat')}</Badge>}
              </div>
              <div className="muted small">
                {d(c.starts_at)}
                {c.ends_at ? t(' bis {date}', { date: d(c.ends_at) }) : ''} · {c.members}
                {c.capacity ? t(' von {n}', { n: c.capacity }) : ''} {t('Teilnehmer')}
              </div>
              <div className="actions" style={{ marginTop: 'auto' }}>
                <button className="btn small secondary" onClick={() => setMembers(c)}>
                  {t('Teilnehmer')}
                </button>
                <button className="btn small ghost" onClick={() => setEdit(c)}>
                  {t('Bearbeiten')}
                </button>
                <button className="btn small ghost danger-text" onClick={async () => confirmAsk(t('Cohort „{name}“ löschen? Die Teilnehmer behalten den Kurszugang, zählen aber ab ihrer Anmeldung.', { name: c.name })) && (await act(() => api.del(`/api/courses/${course.id}/cohorts/${c.id}`), t('Cohort gelöscht'))) && void list.reload()}>
                  {t('Löschen')}
                </button>
              </div>
            </div>
          ))}
        </SortableGrid>
      )}
      {edit && <CohortForm course={course} cohort={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), void list.reload())} />}
      {members && <CohortMembers course={course} cohort={members} onClose={() => setMembers(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}

// --- analytics ------------------------------------------------------------------------------------------------------
type Analytics = {
  course: { id: string; title: string };
  totals: { enrolled: number; started: number; completed: number; completion_percent: number; avg_progress_percent: number; lessons: number; watch_hours: number; avg_watch_minutes: number };
  biggest_drop: { lesson_id: string; title: string; percent: number } | null;
  lessons: { id: string; title: string; module: string; position: number; viewed: number; completed: number; viewed_percent: number; completion_percent: number; drop_off_percent: number; video: null | { viewers: number; avg_watched_percent: number; avg_furthest_percent: number; watch_minutes: number; retention: number[] } }[];
  quizzes: { quiz_id: string; title: string; pass_percent: number; attempts: number; takers: number; avg_percent: number; avg_best_percent: number; pass_rate: number }[];
  reviews: { count: number; average: number; pending: number };
  comments: { total: number; unanswered: number };
  weekly: { week: string; enrolled: number; completed: number }[];
};

export async function downloadFile(path: string, filename: string) {
  try {
    const r = await fetch(path, { headers: { 'x-pghl': '1', 'x-location-id': currentLocation() }, credentials: 'same-origin' });
    const tf = tr('courses');
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).error || tf('Fehler {status}', { status: r.status }));
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    toastError(e);
  }
}

export function CourseAnalytics({ course }: { course: any }) {
  const t = useT('courses');
  const [cohort, setCohort] = useState('');
  const cohorts = useLoad(() => api.get<Cohort[]>(`/api/courses/${course.id}/cohorts`).catch(() => []), [course.id]);
  const data = useLoad(() => api.get<Analytics>(`/api/courses/${course.id}/analytics${cohort ? `?cohort=${cohort}` : ''}`), [course.id, cohort]);
  const a = data.data;
  if (!a) return data.error ? <Empty>{data.error}</Empty> : <Spinner />;
  const tot = a.totals;
  const weeks = Math.max(1, ...a.weekly.map((w) => Math.max(w.enrolled, w.completed)));
  return (
    <div className="cd" data-tour="course-analytics">
      <div className="cd-bar">
        {!!cohorts.data?.length && (
          <div style={{ width: 230 }}>
            <Select value={cohort} onChange={setCohort} placeholder={t('Alle Teilnehmer')} options={cohorts.data.map((c) => [c.id, t('Cohort: {name}', { name: c.name })])} />
          </div>
        )}
        <span className="grow" />
        <button className="btn secondary" onClick={() => downloadFile(`/api/courses/${course.id}/analytics.csv${cohort ? `?cohort=${cohort}` : ''}`, `kurs-auswertung-${course.slug || course.id}.csv`)}>
          {t('Als CSV herunterladen')}
        </button>
      </div>
      <SortableGrid id="course.analytics" className="cd-stats">
        <div className="cd-stat"><b>{tot.enrolled}</b><span>{t('Teilnehmer')}</span></div>
        <div className="cd-stat"><b>{tot.started}</b><span>{t('haben begonnen')}</span></div>
        <div className="cd-stat"><b>{tot.completed} <span>({pctText(tot.completion_percent)})</span></b><span>{t('Kurs abgeschlossen')}</span></div>
        <div className="cd-stat"><b>{pctText(tot.avg_progress_percent)}</b><span>{t('Ø Fortschritt')}</span></div>
        <div className="cd-stat"><b>{dec(tot.watch_hours)} {t('Std.')}</b><span>{t('Wiedergabe (Ø {min} Min. je Person)', { min: dec(tot.avg_watch_minutes) })}</span></div>
        <div className="cd-stat"><b>{a.reviews.count ? `${dec(a.reviews.average)} ★` : '–'}</b><span>{t.plural(a.reviews.count, { other: '{n} Bewertungen' })}{a.reviews.pending ? t(', {n} offen', { n: a.reviews.pending }) : ''}</span></div>
        <div className="cd-stat"><b>{a.comments.total}</b><span>{t('Kommentare')}{a.comments.unanswered ? t(', {n} unbeantwortet', { n: a.comments.unanswered }) : ''}</span></div>
      </SortableGrid>
      {a.biggest_drop && (
        <div className="cd-note">
          {t('Die meisten steigen bei „{title}“ aus: {pct} derer, die die Lektion davor geöffnet haben, öffnen diese nicht mehr.', { title: a.biggest_drop.title, pct: getLocale() === SOURCE_LOCALE ? `${a.biggest_drop.percent} %` : `${a.biggest_drop.percent}%` })}
        </div>
      )}
      <h3>{t('Lektionen')}</h3>
      {!a.lessons.length ? (
        <Empty>{t('Noch keine veröffentlichten Lektionen.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('Lektion')}</th>
                <th className="num">{t('Geöffnet')}</th>
                <th className="num">{t('Abgeschlossen')}</th>
                <th className="num">{t('Ausstieg')}</th>
                <th className="num">{t('Video gesehen')}</th>
                <th>{t('Wo springen sie ab?')}</th>
              </tr>
            </thead>
            <tbody>
              {a.lessons.map((l) => (
                <tr key={l.id}>
                  <td>{l.position}</td>
                  <td>
                    {l.title} <span className="muted small">{l.module}</span>
                  </td>
                  <td className="num">{l.viewed} <span className="muted small">({pctText(l.viewed_percent)})</span></td>
                  <td className="num">{l.completed} <span className="muted small">({pctText(l.completion_percent)})</span></td>
                  <td className="num">{l.position > 1 && l.drop_off_percent ? <Badge tone={l.drop_off_percent >= 30 ? 'red' : l.drop_off_percent >= 15 ? 'yellow' : 'gray'}>{l.drop_off_percent} %</Badge> : '–'}</td>
                  <td className="num">{l.video ? `${pctText(l.video.avg_watched_percent)} · ${t('{n} Min.', { n: dec(l.video.watch_minutes) })}` : '–'}</td>
                  <td>
                    {l.video?.retention.length ? (
                      <div className="cd-curve" role="img" aria-label={t.plural(l.video.viewers, { other: 'Anteil der {n} Zuschauer, die den jeweiligen Abschnitt erreichen' })} title={t('Anteil der Zuschauer, die den Abschnitt erreichen (Anfang links, Ende rechts)')}>
                        {l.video.retention.map((p, i) => (
                          <i key={i} style={{ height: `${Math.max(3, p)}%` }} />
                        ))}
                      </div>
                    ) : (
                      <span className="muted small">–</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!a.quizzes.length && (
        <>
          <h3>{t('Quiz-Ergebnisse')}</h3>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr><th>{t('Quiz')}</th><th className="num">{t('Teilnehmer')}</th><th className="num">{t('Versuche')}</th><th className="num">{t('Ø Ergebnis')}</th><th className="num">{t('Ø bester Versuch')}</th><th className="num">{t('Bestanden (ab {pct})', { pct: getLocale() === SOURCE_LOCALE ? `${a.quizzes[0].pass_percent} %` : `${a.quizzes[0].pass_percent}%` })}</th></tr>
              </thead>
              <tbody>
                {a.quizzes.map((q) => (
                  <tr key={q.quiz_id}>
                    <td>{q.title}</td>
                    <td className="num">{q.takers}</td>
                    <td className="num">{q.attempts}</td>
                    <td className="num">{pctText(q.avg_percent)}</td>
                    <td className="num">{pctText(q.avg_best_percent)}</td>
                    <td className="num">{pctText(q.pass_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h3>{t('Letzte 12 Wochen')}</h3>
      <div className="cd-bars" role="img" aria-label={t('Neue Teilnehmer und Abschlüsse pro Woche')}>
        {a.weekly.map((w) => (
          <div key={w.week} title={t('Woche ab {date}: {enrolled} neu, {completed} abgeschlossen', { date: d(w.week), enrolled: w.enrolled, completed: w.completed })}>
            <div className="col">
              <i style={{ height: `${(w.enrolled / weeks) * 100}%` }} />
              <i className="done" style={{ height: `${(w.completed / weeks) * 100}%` }} />
            </div>
            <span>{w.week.slice(8)}.{w.week.slice(5, 7)}.</span>
          </div>
        ))}
      </div>
      <p className="cd-hint">{t('Blau: neue Teilnehmer, grün: Abschlüsse. „Ausstieg“ ist der Anteil derer, die die Lektion davor geöffnet haben, diese aber nicht.')}</p>
    </div>
  );
}

// --- extra course settings -----------------------------------------------------------------------------------------
export function CourseDepthSettings({ course, onSaved }: { course: any; onSaved: () => void }) {
  const t = useT('courses');
  const [s, setS] = useState<any>(course.settings ?? {});
  useEffect(() => setS(course.settings ?? {}), [course]);
  const save = async () => {
    const r = await act(() => api.patch(`/api/courses/${course.id}`, { settings: s }), t('Einstellungen gespeichert'));
    if (r) onSaved();
  };
  return (
    <div className="card cd" data-tour="course-depth-settings">
      <h2>{t('Diskussion, Bewertungen, Cohorts')}</h2>
      <Check checked={s.comments_enabled !== false} onChange={(v) => setS({ ...s, comments_enabled: v })} label={t('Diskussion unter den Lektionen')} />
      <Check checked={s.reviews_enabled !== false} onChange={(v) => setS({ ...s, reviews_enabled: v })} label={t('Bewertungen durch Teilnehmer')} />
      {s.reviews_enabled !== false && (
        <>
          <Check checked={s.reviews_moderation !== false} onChange={(v) => setS({ ...s, reviews_moderation: v })} label={t('Bewertungen erst nach meiner Freigabe anzeigen')} />
          <Field label={t('Bewerten ab … % Fortschritt')}>
            <Input type="number" min={0} max={100} value={s.reviews_min_percent ?? 30} onChange={(v) => setS({ ...s, reviews_min_percent: Number(v) || 0 })} />
          </Field>
        </>
      )}
      <Check checked={s.cohort_mode === 'auto'} onChange={(v) => setS({ ...s, cohort_mode: v ? 'auto' : 'off' })} label={t('Neue Teilnehmer automatisch dem nächsten offenen Cohort zuweisen')} />
      <div className="actions" style={{ marginTop: 10 }}>
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      </div>
    </div>
  );
}

