import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, ago, d, name } from '../api';
import { act, Badge, Check, CodeBox, confirmAsk, Empty, Field, Input, Link, Modal, navigate, PageHead, pressable, Select, Spinner, Tabs, TagInput, Textarea, toast, useLoad } from '../ui';
import { DownloadsField, ImagePicker, MarkdownEditor } from './ContentKit';
import { useSession } from '../session';
import { PageSuspense, lazyPages } from '../lazy';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { CourseAiButton } from './CourseAi';
import { SortableGrid } from '../sortable/Sortable';
import { Slot } from '../slots';

// Creator depth (hosted video, discussion, reviews, cohorts, analytics, learning paths) loads with the course pages only when opened.
const { LessonVideoFields, VideoLibrary } = lazyPages(() => import('./CourseVideo'), 'LessonVideoFields', 'VideoLibrary');
const { CourseDiscussion, CourseReviews, CourseCohorts, CourseAnalytics, CourseDepthSettings } = lazyPages(() => import('./CourseTabs'), 'CourseDiscussion', 'CourseReviews', 'CourseCohorts', 'CourseAnalytics', 'CourseDepthSettings');
const { LearningPaths } = lazyPages(() => import('./CoursePaths'), 'LearningPaths');

/** Kurse & Mitgliederbereich: courses → modules → lessons, members, access rules, portal settings. */

type Lesson = { id: string; module_id: string; title: string; video_url: string; body: string; downloads: { upload_id: string; name: string }[]; duration_min: number; drip_days: number; published: number; video_id?: string | null; chapters?: { t: number; title: string }[]; complete_percent?: number };
const chaptersText = (list?: { t: number; title: string }[]) => (list ?? []).map((c) => `${Math.floor(c.t / 3600) ? `${Math.floor(c.t / 3600)}:${String(Math.floor((c.t % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(c.t / 60)}`}:${String(c.t % 60).padStart(2, '0')} ${c.title}`).join('\n');
type Mod = { id: string; title: string; drip_days: number; published: number; lessons: Lesson[] };

export const useCourses = () => useLoad(() => api.get<any[]>('/api/courses'), []);

// German labels (message ids of the courses catalog), shown through t()
const SOURCE: Record<string, string> = { manual: 'manuell', tag: 'Tag', workflow: 'Workflow', purchase: 'Kauf', api: 'API', community: 'Community-Level' };

function Progress({ p }: { p: { done: number; total: number; percent: number } }) {
  const t = useT('courses');
  return (
    <div className="course-progress" title={t.plural(p.total, { other: '{done} von {n} Lektionen' }, { done: p.done })}>
      <div className="bar">
        <div style={{ width: `${p.percent}%` }} />
      </div>
      <span className="small muted">{p.percent} %</span>
    </div>
  );
}

function videoKind(url: string): string {
  if (!url) return '';
  if (/youtu\.?be/i.test(url)) return 'YouTube';
  if (/vimeo\.com/i.test(url)) return 'Vimeo';
  if (/loom\.com/i.test(url)) return 'Loom';
  if (/\.(mp4|webm|m4v|mov|ogg)(\?|$)/i.test(url)) return 'Videodatei'; // German label (message id of the courses catalog), shown through t()
  return '';
}

// --- login link (admin action) -----------------------------------------------------------
function useLoginLink() {
  const t = useT('courses');
  const [link, setLink] = useState('');
  const send = async (courseId: string, contactId: string) => {
    const r = await act(() => api.post(`/api/courses/${courseId}/enrollments/${contactId}/login-link`));
    if (!r) return;
    if (r.link) setLink(r.link);
    else toast(r.status === 'sent' ? t('Login-Link gesendet') : t('Login-Link gespeichert (kein E-Mail-Versand eingerichtet)'));
  };
  const modal = link ? (
    <Modal title={t('Login-Link')} onClose={() => setLink('')}>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('Es ist noch kein E-Mail-Versand eingerichtet (Einstellungen → E-Mail & SMS), deshalb ging keine Mail raus. Zum Testen kannst du diesen Link öffnen – er gilt 30 Minuten und nur einmal.')}
      </p>
      <CodeBox text={link} />
    </Modal>
  ) : null;
  return { send, modal };
}

// --- lesson & module editors ---------------------------------------------------------------
function LessonEditor({ course, lesson, modules, onSaved, onDeleted, onDirty }: { course: any; lesson: Lesson; modules: Mod[]; onSaved: (l: Lesson) => void; onDeleted: () => void; onDirty: (d: boolean) => void }) {
  const t = useT('courses');
  const [l, setL] = useState<Lesson>(lesson);
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (v: boolean) => {
    setDirtyState(v);
    onDirty(v);
  };
  const [preview, setPreview] = useState('');
  const [chapters, setChapters] = useState(chaptersText(lesson.chapters));
  useEffect(() => {
    setL(lesson);
    setChapters(chaptersText(lesson.chapters));
    setDirty(false);
  }, [lesson.id]);
  const set = (patch: Partial<Lesson>) => {
    setL({ ...l, ...patch });
    setDirty(true);
  };
  const save = async () => {
    const r = await act(() => api.patch(`/api/courses/${course.id}/lessons/${l.id}`, { title: l.title, module_id: l.module_id, video_url: l.video_url, body: l.body, downloads: l.downloads, duration_min: l.duration_min, drip_days: l.drip_days, published: !!l.published, video_id: l.video_id ?? null, chapters, complete_percent: l.complete_percent ?? 0 }), t('Lektion gespeichert'));
    if (r) {
      setDirty(false);
      onSaved(r);
    }
  };
  const kind = videoKind(l.video_url);
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }} className="grow">
          <Icon name="lesson" /> {t('Lektion')}
        </h2>
        <button className="btn secondary small" onClick={async () => setPreview(await api.text('POST', `/api/courses/${course.id}/lessons/${l.id}/preview`, { ...l, chapters }))}>
          {t('Vorschau')}
        </button>
        <button className="btn small" disabled={!dirty} onClick={save}>
          {dirty ? t('Speichern') : t('Gespeichert ✓')}
        </button>
      </div>
      <Field label={t('Titel')}>
        <Input value={l.title} onChange={(v) => set({ title: v })} />
      </Field>
      <Field label={t('Video')} hint={kind ? t('✓ {kind} wird im Mitgliederbereich eingebettet', { kind: t(kind) }) : l.video_url ? t('Kein bekanntes Format – Mitglieder bekommen einen Link zum Video.') : t('YouTube-, Vimeo- oder Loom-Link oder eine MP4-Datei (https://…)')}>
        <Input value={l.video_url} onChange={(v) => set({ video_url: v })} placeholder="https://youtu.be/…" />
      </Field>
      <Check checked={!!l.published} onChange={(v) => set({ published: v ? 1 : 0 })} label={t('Veröffentlicht (für Mitglieder sichtbar)')} />
      <Field label={t('Text')}>
        <MarkdownEditor value={l.body} onChange={(v) => set({ body: v })} rows={12} placeholder={t('Worum geht es in dieser Lektion?')} />
      </Field>
      <Field label={t('Downloads')}>
        <DownloadsField value={l.downloads ?? []} onChange={(v) => set({ downloads: v })} />
      </Field>
      {/* Einfach-Modus: hosted video, chapters, duration, drip and module behind one toggle */}
      <MoreFields key={l.id} id="course-lesson" values={[l.video_id, chapters, l.complete_percent, l.duration_min, l.drip_days]}>
        <PageSuspense>
          <LessonVideoFields
            lesson={l}
            chaptersText={chapters}
            onChange={(p) => {
              if (p.chapters !== undefined) setChapters(p.chapters);
              const { chapters: _c, ...rest } = p;
              if (Object.keys(rest).length) set(rest as Partial<Lesson>);
              else setDirty(true);
            }}
          />
        </PageSuspense>
        <div className="grid3">
          <Field label={t('Dauer (Minuten)')}>
            <Input type="number" min={0} value={l.duration_min || ''} onChange={(v) => set({ duration_min: Number(v) || 0 })} />
          </Field>
          <Field label={t('Freischalten nach … Tagen')} hint={t('ab Kursbeginn des Mitglieds')}>
            <Input type="number" min={0} value={l.drip_days || ''} onChange={(v) => set({ drip_days: Number(v) || 0 })} placeholder={t('sofort')} />
          </Field>
          <Field label={t('Modul')}>
            <Select value={l.module_id} onChange={(v) => set({ module_id: v })} options={modules.map((m) => [m.id, m.title])} />
          </Field>
        </div>
      </MoreFields>
      <div className="actions">
        <button className="btn ghost small" onClick={async () => confirmAsk(t('Lektion „{title}“ löschen? Der Fortschritt dazu geht verloren.', { title: l.title })) && (await act(() => api.del(`/api/courses/${course.id}/lessons/${l.id}`), t('Gelöscht'))) && onDeleted()}>
          {t('Lektion löschen')}
        </button>
      </div>
      {preview && (
        <Modal title={t('Vorschau: {title}', { title: l.title })} onClose={() => setPreview('')} wide>
          <iframe className="preview-frame" srcDoc={preview} title={t('Vorschau')} sandbox="allow-scripts" />
        </Modal>
      )}
    </div>
  );
}

function ModuleEditor({ course, mod, onSaved, onDeleted }: { course: any; mod: Mod; onSaved: () => void; onDeleted: () => void }) {
  const t = useT('courses');
  const [m, setM] = useState(mod);
  useEffect(() => setM(mod), [mod.id]);
  const save = async () => (await act(() => api.patch(`/api/courses/${course.id}/modules/${m.id}`, { title: m.title, drip_days: m.drip_days, published: !!m.published }), t('Modul gespeichert'))) && onSaved();
  return (
    <div className="card">
      <h2>
        <Icon name="layers" /> {t('Modul')}
      </h2>
      <Field label={t('Titel')}>
        <Input value={m.title} onChange={(v) => setM({ ...m, title: v })} />
      </Field>
      <Field label={t('Freischalten nach … Tagen')} hint={t('Gilt für alle Lektionen des Moduls (z. B. 7 = eine Woche nach Kursbeginn). Lektionen können zusätzlich später kommen.')}>
        <Input type="number" min={0} value={m.drip_days || ''} onChange={(v) => setM({ ...m, drip_days: Number(v) || 0 })} placeholder={t('sofort')} />
      </Field>
      <Check checked={!!m.published} onChange={(v) => setM({ ...m, published: v ? 1 : 0 })} label={t('Veröffentlicht')} />
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
        <button className="btn ghost" onClick={async () => confirmAsk(t.plural(mod.lessons.length, { other: 'Modul „{title}“ mit {n} Lektionen löschen?' }, { title: m.title })) && (await act(() => api.del(`/api/courses/${course.id}/modules/${m.id}`), t('Gelöscht'))) && onDeleted()}>
          {t('Modul löschen')}
        </button>
      </div>
    </div>
  );
}

// --- content tab -----------------------------------------------------------------------------
function Content({ course, reload }: { course: any; reload: () => Promise<void> }) {
  const t = useT('courses');
  const [mods, setMods] = useState<Mod[]>(course.modules);
  const [sel, setSelState] = useState<{ kind: 'lesson' | 'module'; id: string } | null>(() => (course.modules[0]?.lessons[0] ? { kind: 'lesson', id: course.modules[0].lessons[0].id } : null));
  const [dirty, setDirty] = useState(false);
  const setSel = (next: { kind: 'lesson' | 'module'; id: string } | null) => {
    if (next?.id === sel?.id) return;
    if (dirty && next && !confirmAsk(t('Die Lektion hat ungespeicherte Änderungen. Verwerfen?'))) return;
    setDirty(false);
    setSelState(next);
  };
  useEffect(() => setMods(course.modules), [course]);

  const reorder = async (next: Mod[]) => {
    setMods(next);
    const r = await act(() => api.post(`/api/courses/${course.id}/reorder`, { modules: next.map((m) => ({ id: m.id, lessons: m.lessons.map((l) => l.id) })) }));
    if (r) setMods(r.modules);
  };
  const moveModule = (i: number, dir: number) => {
    const a = [...mods];
    [a[i], a[i + dir]] = [a[i + dir], a[i]];
    void reorder(a);
  };
  const moveLesson = (mi: number, li: number, dir: number) => {
    const a = mods.map((m) => ({ ...m, lessons: [...m.lessons] }));
    const list = a[mi].lessons;
    if (li + dir >= 0 && li + dir < list.length) [list[li], list[li + dir]] = [list[li + dir], list[li]];
    else if (dir < 0 && mi > 0) a[mi - 1].lessons.push(list.splice(li, 1)[0]);
    else if (dir > 0 && mi < a.length - 1) a[mi + 1].lessons.unshift(list.splice(li, 1)[0]);
    else return;
    void reorder(a);
  };
  const addLesson = async (m: Mod) => {
    const l = await act(() => api.post(`/api/courses/${course.id}/lessons`, { module_id: m.id, title: t('Lektion {n}', { n: m.lessons.length + 1 }) }));
    if (l) {
      await reload();
      setSel({ kind: 'lesson', id: l.id });
    }
  };
  const addModule = async () => {
    const m = await act(() => api.post(`/api/courses/${course.id}/modules`, { title: t('Modul {n}', { n: mods.length + 1 }) }));
    if (m) {
      await reload();
      setSel({ kind: 'module', id: m.id });
    }
  };
  const lesson = sel?.kind === 'lesson' ? mods.flatMap((m) => m.lessons).find((l) => l.id === sel.id) : undefined;
  const mod = sel?.kind === 'module' ? mods.find((m) => m.id === sel.id) : undefined;

  return (
    <div className="course-builder" data-tour="course-outline">
      <div>
        {mods.map((m, mi) => (
          <div key={m.id} className="outline-mod">
            <div className={`outline-head${sel?.id === m.id ? ' on' : ''}`} {...pressable(() => setSel({ kind: 'module', id: m.id }))}>
              <Icon name="layers" />
              <span className="grow">
                {m.title}
                {m.drip_days > 0 && <span className="muted small"> {t('· ab Tag {n}', { n: m.drip_days })}</span>}
              </span>
              {!m.published && <Badge>{t('Entwurf')}</Badge>}
              <button className="icon-btn" disabled={!mi} onClick={(e) => (e.stopPropagation(), moveModule(mi, -1))} aria-label={t('Modul hoch')}>
                ↑
              </button>
              <button className="icon-btn" disabled={mi === mods.length - 1} onClick={(e) => (e.stopPropagation(), moveModule(mi, 1))} aria-label={t('Modul runter')}>
                ↓
              </button>
            </div>
            {m.lessons.map((l, li) => (
              <div key={l.id} className={`outline-lesson${sel?.id === l.id ? ' on' : ''}`} {...pressable(() => setSel({ kind: 'lesson', id: l.id }))}>
                <Icon name={l.video_url || l.video_id ? 'video' : 'text'} size={14} />
                <span className="grow">{l.title}</span>
                {l.drip_days > 0 && <Icon name="lock" size={13} aria-label={t('ab Tag {n}', { n: l.drip_days })} />}
                {!l.published && <Badge>{t('Entwurf')}</Badge>}
                {l.duration_min > 0 && <span className="muted small">{l.duration_min}′</span>}
                <button className="icon-btn" disabled={!mi && !li} onClick={(e) => (e.stopPropagation(), moveLesson(mi, li, -1))} aria-label={t('Lektion hoch')}>
                  ↑
                </button>
                <button className="icon-btn" disabled={mi === mods.length - 1 && li === m.lessons.length - 1} onClick={(e) => (e.stopPropagation(), moveLesson(mi, li, 1))} aria-label={t('Lektion runter')}>
                  ↓
                </button>
              </div>
            ))}
            <button className="btn small ghost outline-add" onClick={() => addLesson(m)}>
              {t('+ Lektion')}
            </button>
          </div>
        ))}
        <button className="btn secondary" onClick={addModule}>
          {t('+ Modul')}
        </button>
      </div>
      <div>
        {lesson ? (
          <LessonEditor key={lesson.id} course={course} lesson={lesson} modules={mods} onDirty={setDirty} onSaved={() => void reload()} onDeleted={() => (setDirty(false), setSelState(null), void reload())} />
        ) : mod ? (
          <ModuleEditor key={mod.id} course={course} mod={mod} onSaved={() => void reload()} onDeleted={() => (setSelState(null), void reload())} />
        ) : (
          <Empty>{t('Links eine Lektion oder ein Modul wählen.')}</Empty>
        )}
      </div>
    </div>
  );
}

// --- members tab ---------------------------------------------------------------------------
function AddMember({ course, onClose, onAdded }: { course: any; onClose: () => void; onAdded: () => void }) {
  const t = useT('courses');
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [nm, setNm] = useState('');
  useEffect(() => {
    if (q.trim().length < 2) return setRes([]);
    const timer = setTimeout(() => api.get(`/api/contacts?q=${encodeURIComponent(q)}&limit=8`).then((r) => setRes(r.contacts)).catch(() => {}), 200);
    return () => clearTimeout(timer);
  }, [q]);
  const grant = async (body: any) => {
    const r = await act(() => api.post(`/api/courses/${course.id}/enrollments`, body));
    if (r) {
      toast(r.changed ? t('Zugang freigeschaltet') : t('Hatte schon Zugang'));
      onAdded();
    }
  };
  return (
    <Modal title={t('Teilnehmer hinzufügen')} onClose={onClose}>
      <Field label={t('Kontakt suchen')}>
        <Input value={q} onChange={setQ} placeholder={t('Name oder E-Mail')} autoFocus />
      </Field>
      {res.map((c) => (
        <div key={c.id} className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
          <span className="grow">
            {name(c)} <span className="muted small">{c.email}</span>
          </span>
          <button className="btn small" onClick={() => grant({ contact_id: c.id })}>
            {t('Freischalten')}
          </button>
        </div>
      ))}
      <hr />
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Oder neu per E-Mail (legt den Kontakt an, falls es ihn noch nicht gibt):')}
      </p>
      <div className="grid2">
        <Field label={t('E-Mail')}>
          <Input type="email" value={email} onChange={setEmail} />
        </Field>
        <Field label={t('Name (optional)')}>
          <Input value={nm} onChange={setNm} />
        </Field>
      </div>
      <button className="btn" disabled={!email.includes('@')} onClick={() => grant({ email, name: nm })}>
        {t('Freischalten')}
      </button>
    </Modal>
  );
}

function Members({ course, onChange }: { course: any; onChange: () => void }) {
  const t = useT('courses');
  const list = useLoad(() => api.get<any[]>(`/api/courses/${course.id}/enrollments`), [course.id]);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('active');
  const login = useLoginLink();
  const refresh = () => (void list.reload(), onChange());
  const rows = (list.data ?? []).filter((e) => !filter || e.status === filter);
  return (
    <>
      <div className="row" style={{ marginBottom: 12, alignItems: 'center' }} data-tour="course-members">
        <button className="btn" onClick={() => setAdding(true)}>
          {t('+ Teilnehmer')}
        </button>
        <div style={{ width: 200 }}>
          <Select value={filter} onChange={setFilter} placeholder={t('Alle')} options={[['active', t('Mit Zugang')], ['revoked', t('Zugang entzogen')]]} />
        </div>
        <span className="muted small">{t('Zugang kommt auch automatisch über Tags, Käufe und Workflows (Einstellungen & Zugang).')}</span>
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Teilnehmer')}</th>
                <th>{t('Über')}</th>
                <th>{t('Seit')}</th>
                <th>{t('Fortschritt')}</th>
                <th>{t('Zuletzt aktiv')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`contacts/${e.contact_id}`}>{name(e)}</Link>
                    <div className="muted small">{e.email}</div>
                  </td>
                  <td>
                    {SOURCE[e.source] ? t(SOURCE[e.source]) : e.source}
                    {e.source === 'tag' && e.source_ref ? <div className="muted small">{e.source_ref}</div> : null}
                  </td>
                  <td className="muted">{d(e.enrolled_at)}</td>
                  <td style={{ minWidth: 150 }}>
                    <Progress p={e.progress} />
                    {e.completed_at && <Badge tone="green">{t('abgeschlossen')}</Badge>}
                  </td>
                  <td className="muted">{e.last_seen_at ? ago(e.last_seen_at) : t('noch nie')}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {e.status === 'active' ? (
                      <>
                        <button className="btn small secondary" onClick={() => login.send(course.id, e.contact_id)} disabled={!e.email} title={t('Login-Link per E-Mail senden')}>
                          {t('Login-Link')}
                        </button>{' '}
                        <button className="btn small ghost" onClick={async () => confirmAsk(t('Zugang für {name} entziehen?', { name: name(e) })) && (await act(() => api.del(`/api/courses/${course.id}/enrollments/${e.contact_id}`), t('Zugang entzogen'))) && refresh()}>
                          {t('Entziehen')}
                        </button>
                      </>
                    ) : (
                      <button className="btn small secondary" onClick={async () => (await act(() => api.post(`/api/courses/${course.id}/enrollments`, { contact_id: e.contact_id }), t('Wieder freigeschaltet'))) && refresh()}>
                        {t('Wieder freischalten')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty action={<button className="btn" onClick={() => setAdding(true)}>{t('Ersten Teilnehmer freischalten')}</button>}>{filter === 'revoked' ? t('Niemandem wurde der Zugang entzogen.') : t('Noch keine Teilnehmer.')}</Empty>
      )}
      {adding && <AddMember course={course} onClose={() => setAdding(false)} onAdded={() => (setAdding(false), refresh())} />}
      {login.modal}
    </>
  );
}

// --- settings & access tab -------------------------------------------------------------------
function CourseSettings({ course, onSaved }: { course: any; onSaved: () => void }) {
  const t = useT('courses');
  const session = useSession();
  const [c, setC] = useState<any>(course);
  const tags = useLoad(() => api.get<any[]>('/api/tags'), []);
  const products = useLoad(() => api.get<any[]>('/api/products'), []);
  useEffect(() => setC(course), [course]);
  const a = c.access ?? {};
  const cs = course.settings ?? {};
  const setA = (patch: any) => setC({ ...c, access: { ...a, ...patch } });
  const save = async () => {
    const r = await act(() => api.patch(`/api/courses/${course.id}`, { title: c.title, slug: c.slug, description: c.description, cover_image: c.cover_image, status: c.status, access: c.access }));
    if (r) {
      toast(r.synced ? t.plural(r.synced, { other: 'Gespeichert – {n} Kontakt(e) mit dem Tag haben jetzt Zugang' }) : t('Gespeichert'));
      onSaved();
    }
  };
  return (
    <div className="grid2 course-settings">
      <div className="card">
        <h2>{t('Kurs')}</h2>
        <Field label={t('Titel')}>
          <Input value={c.title} onChange={(v) => setC({ ...c, title: v })} />
        </Field>
        <Field label={t('Adresse im Mitgliederbereich')} hint={course.url}>
          <Input value={c.slug} onChange={(v) => setC({ ...c, slug: v })} />
        </Field>
        <Field label={t('Beschreibung')} hint={t('Markdown erlaubt (**fett**, Listen, Links)')}>
          <Textarea value={c.description} onChange={(v) => setC({ ...c, description: v })} rows={5} />
        </Field>
        <Field label={t('Titelbild (16:9)')}>
          <ImagePicker value={c.cover_image} onChange={(v) => setC({ ...c, cover_image: v })} />
        </Field>
        <Field label={t('Status')}>
          <Select value={c.status} onChange={(v) => setC({ ...c, status: v })} options={[['draft', t('Entwurf (Mitglieder sehen ihn nicht)')], ['published', t('Veröffentlicht')]]} />
        </Field>
      </div>
      <div className="card" data-tour="course-access">
        <h2>{t('Zugang')}</h2>
        <Field label={t('Zugang mit diesen Tags')} hint={t('Wer einen dieser Tags bekommt (Formular, Workflow, Import, Kauf), ist sofort freigeschaltet – z. B. kurs:mein-kurs oder kauf:produkt.')}>
          <TagInput value={a.tags ?? []} onChange={(v) => setA({ tags: v })} suggestions={(tags.data ?? []).map((tag) => tag.name)} />
        </Field>
        <Field label={t('Zugang beim Kauf dieser Produkte')}>
          {(products.data ?? []).length ? (
            <div className="check-list">
              {(products.data ?? []).map((p) => (
                <Check key={p.id} checked={(a.product_ids ?? []).includes(p.id)} onChange={(on) => setA({ product_ids: on ? [...(a.product_ids ?? []), p.id] : (a.product_ids ?? []).filter((x: string) => x !== p.id) })} label={p.name} />
              ))}
            </div>
          ) : (
            <span className="muted small">{t('Noch keine Produkte angelegt (Umsatz → Produkte).')}</span>
          )}
        </Field>
        <MoreFields id="course-access" values={[a.revoke_on_tag_removal === false]}>
          <Check checked={a.revoke_on_tag_removal !== false} onChange={(v) => setA({ revoke_on_tag_removal: v })} label={t('Tag entfernt → Zugang wieder weg (nur wenn er über den Tag kam)')} />
          <p className="muted small">{t('Außerdem: von Hand unter „Teilnehmer“, über die Workflow-Aktion „Kurszugang geben“ oder per API/MCP.')}</p>
        </MoreFields>
        <hr />
        <Check checked={!!a.welcome_email} onChange={(v) => setA({ welcome_email: v })} label={t('Willkommens-E-Mail bei Freischaltung senden')} />
        {a.welcome_email && (
          <>
            <Field label={t('Betreff')}>
              <Input value={a.welcome_subject} onChange={(v) => setA({ welcome_subject: v })} placeholder={course.defaults?.welcome_subject} />
            </Field>
            <Field label={t('Text')} hint={t('Platzhalter: {{contact.first_name}}, {{course.title}}, {{portal_url}}, {{location.name}}')}>
              <Textarea value={a.welcome_body} onChange={(v) => setA({ welcome_body: v })} rows={8} placeholder={course.defaults?.welcome_body} />
            </Field>
          </>
        )}
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <MoreFields id="course-depth" label={t('Diskussion, Bewertungen, Cohorts')} values={[cs.comments_enabled === false, cs.reviews_enabled === false, cs.reviews_moderation === false, cs.reviews_min_percent !== undefined && cs.reviews_min_percent !== 30, cs.cohort_mode === 'auto']}>
          <PageSuspense>
            <CourseDepthSettings course={course} onSaved={onSaved} />
          </PageSuspense>
        </MoreFields>
      </div>
      <div className="actions" style={{ gridColumn: '1 / -1' }}>
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
        {session.locations.length > 1 && (
          <div style={{ width: 240 }}>
            <Select
              value=""
              placeholder={t('In anderen Kunden kopieren…')}
              options={session.locations.filter((l) => l.id !== session.locationId).map((l) => [l.id, l.name])}
              onChange={async (target) => {
                if (!target) return;
                const r = await act(() => api.post(`/api/courses/${course.id}/copy`, { location_id: target }));
                if (r) toast(t('Kopiert nach {name} – mit allen Modulen und Lektionen, ohne Teilnehmer', { name: session.locations.find((l) => l.id === target)?.name ?? '' }));
              }}
            />
          </div>
        )}
        <button className="btn danger" onClick={async () => confirmAsk(t('Kurs „{title}“ mit allen Lektionen, Teilnehmern und Fortschritten löschen?', { title: course.title })) && (await act(() => api.del(`/api/courses/${course.id}`), t('Kurs gelöscht'))) && navigate('courses')}>
          {t('Kurs löschen')}
        </button>
      </div>
    </div>
  );
}

export function CourseEditor({ id }: { id: string }) {
  const t = useT('courses');
  const course = useLoad(() => api.get(`/api/courses/${id}`), [id]);
  const [tab, setTab] = useState('content');
  if (course.error) return <Empty action={<Link to="courses" className="btn">{t('Zu den Kursen')}</Link>}>{course.error}</Empty>;
  if (!course.data) return <Spinner />;
  const c = course.data;
  const publish = (status: string) => act(() => api.patch(`/api/courses/${id}`, { status }), status === 'published' ? t('Kurs veröffentlicht') : t('Kurs ist wieder Entwurf')).then(() => course.reload());
  return (
    <>
      <PageHead
        title={c.title}
        sub={
          <>
            <Badge tone={c.status === 'published' ? 'green' : 'gray'}>{c.status === 'published' ? t('Veröffentlicht') : t('Entwurf')}</Badge> · {t.plural(c.lessons, { other: '{n} Lektionen ·' })} {t.plural(c.members, { other: '{n} Teilnehmer ·' })}{' '}
            <a href={c.url} target="_blank" rel="noreferrer">
              {t('im Mitgliederbereich ↗')}
            </a>
          </>
        }
      >
        <Link to="courses" className="btn secondary">
          {t('← Kurse')}
        </Link>
        {c.status === 'published' ? (
          <button className="btn secondary" onClick={() => publish('draft')}>
            {t('Auf Entwurf setzen')}
          </button>
        ) : (
          <button className="btn" data-tour="course-publish" onClick={() => publish('published')}>
            {t('Veröffentlichen')}
          </button>
        )}
      </PageHead>
      <Tabs tabs={[['content', t('Inhalt')], ['members', t('Teilnehmer ({n})', { n: c.members })], ['discussion', t('Diskussion')], ['reviews', t('Bewertungen')], ['cohorts', t('Cohorts')], ['analytics', t('Auswertung')], ['settings', t('Einstellungen & Zugang')]]} value={tab} onChange={setTab} />
      {tab === 'content' && <Content course={c} reload={course.reload} />}
      {tab === 'members' && <Members course={c} onChange={() => void course.reload()} />}
      {tab === 'settings' && <CourseSettings course={c} onSaved={() => void course.reload()} />}
      {['discussion', 'reviews', 'cohorts', 'analytics'].includes(tab) && (
        <PageSuspense key={tab}>
          {tab === 'discussion' && <CourseDiscussion course={c} />}
          {tab === 'reviews' && <CourseReviews course={c} />}
          {tab === 'cohorts' && <CourseCohorts course={c} />}
          {tab === 'analytics' && <CourseAnalytics course={c} />}
        </PageSuspense>
      )}
    </>
  );
}

// --- portal settings ---------------------------------------------------------------------------
function PortalSettings() {
  const t = useT('courses');
  const portal = useLoad(() => api.get('/api/courses/portal'), []);
  const [p, setP] = useState<any>(null);
  useEffect(() => {
    if (portal.data) setP(portal.data);
  }, [portal.data]);
  if (!p) return <Spinner />;
  const s = p.settings;
  const setS = (patch: any) => setP({ ...p, settings: { ...s, ...patch } });
  const save = async () => {
    const r = await act(() => api.patch('/api/courses/portal', { slug: p.slug, settings: s }), t('Gespeichert'));
    if (r) setP(r);
  };
  return (
    <div className="grid2 course-settings">
      <div className="card" data-tour="portal-settings">
        <h2>{t('Mitgliederbereich')}</h2>
        <Field label={t('Adresse')}>
          <CodeBox text={p.url} />
        </Field>
        <p className="muted small" style={{ marginTop: -4 }}>
          <a href={p.url} target="_blank" rel="noreferrer">
            {t('Öffnen ↗')}
          </a>{' '}
          {t('· Mitglieder melden sich mit ihrer E-Mail an und bekommen einen Login-Link (30 Minuten gültig, nur einmal nutzbar) – ganz ohne Passwort. Dafür muss unter Einstellungen → E-Mail & SMS ein Versand eingerichtet sein.')}
        </p>
        <Field label={t('Eigene Kurz-Adresse (optional)')} hint={t('z. B. akademie → /portal/akademie')}>
          <Input value={p.slug} onChange={(v) => setP({ ...p, slug: v })} placeholder={t('akademie')} />
        </Field>
        <Field label={t('Titel')}>
          <Input value={s.title} onChange={(v) => setS({ title: v })} placeholder={p.defaults.title} />
        </Field>
        <Field label={t('Begrüßung')} hint={t('Steht auf der Anmeldeseite und über den Kursen.')}>
          <Textarea value={s.welcome} onChange={(v) => setS({ welcome: v })} rows={3} />
        </Field>
      </div>
      <div className="card">
        <h2>{t('Aussehen')}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t('Leer = Branding des Sub-Accounts (Logo und Farbe aus der Agentur-Einstellung).')}
        </p>
        <Field label={t('Farbe')}>
          <div className="row" style={{ alignItems: 'center' }}>
            <input type="color" value={s.color || p.defaults.color} onChange={(e) => setS({ color: e.target.value })} style={{ width: 64, height: 36, padding: 2 }} />
            {s.color && (
              <button className="btn small ghost" onClick={() => setS({ color: '' })}>
                {t('Zurücksetzen')}
              </button>
            )}
          </div>
        </Field>
        <Field label={t('Logo')}>
          <ImagePicker value={s.logo_url} onChange={(v) => setS({ logo_url: v })} />
        </Field>
        {!s.logo_url && p.defaults.logo_url && <p className="muted small">{t('Aktuell: Logo des Sub-Accounts.')}</p>}
        <Field label={t('Support-E-Mail')} hint={t('Wird Mitgliedern bei Fragen angezeigt.')}>
          <Input type="email" value={s.support_email} onChange={(v) => setS({ support_email: v })} placeholder={p.defaults.support_email} />
        </Field>
      </div>
      <div className="actions" style={{ gridColumn: '1 / -1' }}>
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      </div>
      <Slot name="portal.settings" />
    </div>
  );
}

export function Courses() {
  const t = useT('courses');
  const list = useCourses();
  const [tab, setTab] = useState('courses');
  const [modal, setModal] = useState(false);
  const [library, setLibrary] = useState(false);
  const [title, setTitle] = useState('');
  const create = async () => {
    const r = await act(() => api.post('/api/courses', { title }));
    if (r) navigate(`courses/${r.id}`);
  };
  return (
    <>
      <PageHead title={t('Kurse')} sub={t('Online-Kurse mit Mitgliederbereich – Zugang per Tag, Kauf, Workflow oder von Hand')}>
        <button className="btn secondary" data-tour="course-videos" onClick={() => setLibrary(true)}>
          {t('Video-Bibliothek')}
        </button>
        <CourseAiButton />
        <button className="btn" data-tour="courses-new" onClick={() => setModal(true)}>
          {t('+ Neuer Kurs')}
        </button>
      </PageHead>
      <Tabs tabs={[['courses', t('Kurse')], ['paths', t('Lernpfade')], ['portal', t('Mitgliederbereich')]]} value={tab} onChange={setTab} />
      {library && (
        <PageSuspense>
          <VideoLibrary onClose={() => setLibrary(false)} />
        </PageSuspense>
      )}
      {tab === 'portal' ? (
        <PortalSettings />
      ) : tab === 'paths' ? (
        <PageSuspense>
          <LearningPaths />
        </PageSuspense>
      ) : list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <SortableGrid id="courses-list" className="course-grid" data-tour="courses-list">
          {list.data.map((c) => (
            <div key={c.id} className="card course-card" {...pressable(() => navigate(`courses/${c.id}`))}>
              <div className="course-cover" style={c.cover_image ? { backgroundImage: `url("${c.cover_image}")` } : undefined}>
                {!c.cover_image && <Icon name="courses" size={34} />}
                <Badge tone={c.status === 'published' ? 'green' : 'gray'}>{c.status === 'published' ? t('Live') : t('Entwurf')}</Badge>
              </div>
              <div className="course-body">
                <h3>{c.title}</h3>
                <div className="muted small">
                  {t.plural(c.modules, { other: '{n} Module ·' })} {t.plural(c.lessons, { other: '{n} Lektionen' })}{c.minutes ? t(' · {n} Min.', { n: c.minutes }) : ''}
                </div>
                <div className="small">
                  <Icon name="contacts" size={14} /> {t.plural(c.members, { other: '{n} Teilnehmer' })}{c.completed ? t(' · {n} abgeschlossen', { n: c.completed }) : ''}
                </div>
              </div>
            </div>
          ))}
        </SortableGrid>
      ) : (
        <Empty action={<button className="btn" onClick={() => setModal(true)}>{t('Ersten Kurs anlegen')}</button>}>
          {t('Noch keine Kurse. Lege Module und Lektionen mit Video, Text und Downloads an – Mitglieder lernen im eigenen Mitgliederbereich.')}
        </Empty>
      )}
      {modal && (
        <Modal
          title={t('Neuer Kurs')}
          onClose={() => setModal(false)}
          footer={
            <button className="btn" disabled={!title.trim()} onClick={create}>
              {t('Anlegen')}
            </button>
          }
        >
          <Field label={t('Titel')} hint={t('Startet als Entwurf mit einem ersten Modul und einer Lektion.')} tour="course-title">
            <Input value={title} onChange={setTitle} autoFocus placeholder={t('z. B. Social Media Kickstart')} />
          </Field>
        </Modal>
      )}
    </>
  );
}

// --- used by other pages -------------------------------------------------------------------------

/** Workflow step „Kurszugang geben / entziehen“. */
export function CourseStep({ step, set }: { step: any; set: (p: any) => void }) {
  const t = useT('courses');
  const list = useCourses();
  return (
    <>
      <Field label={t('Kurs')}>
        <Select value={step.course_id} onChange={(v) => set({ course_id: v })} placeholder={t('wählen…')} options={(list.data ?? []).map((c) => [c.id, `${c.title}${c.status === 'published' ? '' : ' (Entwurf)'}`])} />
      </Field>
      <p className="muted small">{step.type === 'course_revoke' ? t('Nimmt dem Kontakt den Zugang; sein Fortschritt bleibt gespeichert.') : t('Schaltet den Kurs für den Kontakt frei. Er meldet sich im Mitgliederbereich mit seiner E-Mail an.')}</p>
    </>
  );
}

/** Optional course filter for the course triggers in workflows. */
export function CourseTriggerFilter({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const t = useT('courses');
  const list = useCourses();
  return (
    <Field label={t('Kurs')}>
      <Select value={value} onChange={onChange} placeholder={t('jeder Kurs')} options={(list.data ?? []).map((c) => [c.id, c.title])} />
    </Field>
  );
}

/** "Kurse" card on the contact page: enrollments with progress, grant / revoke, login link. */
export function ContactCourses({ contactId }: { contactId: string }) {
  const t = useT('courses');
  const mine = useLoad(() => api.get<any[]>(`/api/contacts/${contactId}/courses`), [contactId]);
  const all = useCourses();
  const [pick, setPick] = useState('');
  const login = useLoginLink();
  if (mine.error) return null;
  const has = new Set((mine.data ?? []).filter((e) => e.status === 'active').map((e) => e.course_id));
  const options = (all.data ?? []).filter((c) => !has.has(c.id)).map((c) => [c.id, c.title] as [string, string]);
  return (
    <div className="card">
      <h2>{t('Kurse')}</h2>
      {(mine.data ?? []).map((e) => (
        <div key={e.id} style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
            <Link to={`courses/${e.course_id}`}>{e.course_title}</Link>
            {e.status === 'active' ? e.completed_at ? <Badge tone="green">{t('abgeschlossen')}</Badge> : <Badge tone="blue">{t('aktiv')}</Badge> : <Badge tone="red">{t('entzogen')}</Badge>}
          </div>
          <Progress p={e.progress} />
          <div className="muted small">
            {t.plural(e.progress.total, { other: '{done}/{n} Lektionen ·' }, { done: e.progress.done })} {e.last_seen_at ? t('zuletzt {time}', { time: ago(e.last_seen_at) }) : t('noch nicht angemeldet')} {t('· über {source}', { source: SOURCE[e.source] ? t(SOURCE[e.source]) : e.source })}
          </div>
          <div className="actions" style={{ marginTop: 4 }}>
            {e.status === 'active' ? (
              <>
                <a href="#" className="small" onClick={(ev) => (ev.preventDefault(), void login.send(e.course_id, contactId))}>
                  {t('Login-Link senden')}
                </a>
                <a href="#" className="small" onClick={async (ev) => (ev.preventDefault(), confirmAsk(t('Zugang zu „{title}“ entziehen?', { title: e.course_title })) && (await act(() => api.del(`/api/courses/${e.course_id}/enrollments/${contactId}`), t('Zugang entzogen'))) && mine.reload())}>
                  {t('entziehen')}
                </a>
              </>
            ) : (
              <a href="#" className="small" onClick={async (ev) => (ev.preventDefault(), (await act(() => api.post(`/api/courses/${e.course_id}/enrollments`, { contact_id: contactId }), t('Wieder freigeschaltet'))) && mine.reload())}>
                {t('wieder freischalten')}
              </a>
            )}
          </div>
        </div>
      ))}
      {!mine.data?.length && <p className="muted">{t('Keine.')}</p>}
      {options.length > 0 && (
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="grow">
            <Select value={pick} onChange={setPick} placeholder={t('Kurs freischalten…')} options={options} />
          </div>
          <button className="btn small secondary" disabled={!pick} aria-label={t('Kurs freischalten')} onClick={async () => (await act(() => api.post(`/api/courses/${pick}/enrollments`, { contact_id: contactId }), t('Zugang freigeschaltet'))) && (setPick(''), mine.reload())}>
            +
          </button>
        </div>
      )}
      {login.modal}
    </div>
  );
}
