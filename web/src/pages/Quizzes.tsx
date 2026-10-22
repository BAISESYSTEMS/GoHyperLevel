import { useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { Badge, Check, Empty, Field, Input, Link, Modal, PageHead, Select, Spinner, Tabs, Textarea, act, confirmAsk, useLoad } from '../ui';
import { Callout, Item, Panel, StatusBadge, lessonOptions } from './CreatorKit';
import { AssignmentsTab, ReviewsTab } from './QuizReviews';
import { CertificatesTab } from './Certificates';
import { MoreFields } from '../areas/fields';

/**
 * Quiz & Zertifikate: quizzes and assignments as lesson types of a course (auto-graded, with attempts and a lock for the next
 * lesson), the review queue for short answers and hand-ins, and certificates (template, issue, verify page, PDF).
 * Docs: docs/quizzes-certificates.md.
 */

type Q = { id?: string; kind: 'single' | 'multiple' | 'truefalse' | 'short'; text: string; points: number; explanation: string; options: { id?: string; text: string; correct: boolean }[]; accepted: string; review: 'auto' | 'manual'; correct_value: boolean };

const KINDS: [string, string][] = [
  ['single', 'Eine richtige Antwort'],
  ['multiple', 'Mehrere richtige Antworten'],
  ['truefalse', 'Wahr oder falsch'],
  ['short', 'Kurzantwort (Text)'],
];
const SHOW: [string, string][] = [
  ['after_pass', 'Nach dem Bestehen'],
  ['always', 'Nach jedem Versuch'],
  ['never', 'Nie'],
];

const blankQuestion = (): Q => ({ kind: 'single', text: '', points: 1, explanation: '', options: [{ text: '', correct: true }, { text: '', correct: false }], accepted: '', review: 'auto', correct_value: true });
const fromServer = (q: any): Q => ({
  id: q.id,
  kind: q.kind,
  text: q.text,
  points: q.points,
  explanation: q.explanation ?? '',
  options: q.kind === 'truefalse' || q.kind === 'short' ? [{ text: '', correct: true }, { text: '', correct: false }] : q.options.map((o: any) => ({ id: o.id, text: o.text, correct: !!o.correct })),
  accepted: (q.accepted ?? []).join('\n'),
  review: q.review ?? 'auto',
  correct_value: q.kind === 'truefalse' ? !!q.options.find((o: any) => o.id === 'true')?.correct : true,
});
const toServer = (q: Q) => ({
  ...(q.id ? { id: q.id } : {}),
  kind: q.kind,
  text: q.text,
  points: q.points,
  explanation: q.explanation,
  ...(q.kind === 'truefalse' ? { correct_value: q.correct_value } : {}),
  ...(q.kind === 'short' ? { accepted: q.accepted.split('\n').map((x) => x.trim()).filter(Boolean), review: q.review } : {}),
  ...(q.kind === 'single' || q.kind === 'multiple' ? { options: q.options.filter((o) => o.text.trim()) } : {}),
});

function QuestionEditor({ q, i, n, set, move, remove }: { q: Q; i: number; n: number; set: (p: Partial<Q>) => void; move: (d: -1 | 1) => void; remove: () => void }) {
  const setOpt = (k: number, p: Partial<Q['options'][number]>) => set({ options: q.options.map((o, j) => (j === k ? { ...o, ...p } : q.kind === 'single' && p.correct ? { ...o, correct: false } : o)) });
  return (
    <div className="cr-fold open" style={{ padding: 14, marginBottom: 12 }} data-tour={i === 0 ? 'quiz-question' : undefined}>
      <div className="cr-line" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Frage {i + 1}</strong>
        <span className="actions">
          <button className="btn small secondary" disabled={i === 0} onClick={() => move(-1)} aria-label="Nach oben">
            ↑
          </button>
          <button className="btn small secondary" disabled={i === n - 1} onClick={() => move(1)} aria-label="Nach unten">
            ↓
          </button>
          <button className="btn small ghost danger-text" onClick={remove}>
            Entfernen
          </button>
        </span>
      </div>
      <Field label="Art">
        <Select value={q.kind} onChange={(v) => set({ kind: v as Q['kind'] })} options={KINDS} />
      </Field>
      <Field label="Frage *">
        <Textarea value={q.text} onChange={(v) => set({ text: v })} rows={2} maxLength={1000} />
      </Field>
      {(q.kind === 'single' || q.kind === 'multiple') && (
        <div className="cr-lines" style={{ marginBottom: 10 }}>
          {q.options.map((o, k) => (
            <div className="cr-line" key={k}>
              <label className="check" title="Richtige Antwort">
                <input type={q.kind === 'single' ? 'radio' : 'checkbox'} name={`q${i}`} checked={o.correct} onChange={(e) => setOpt(k, { correct: e.target.checked })} aria-label={`Antwort ${k + 1} ist richtig`} />
              </label>
              <Input value={o.text} className="grow" onChange={(v) => setOpt(k, { text: v })} placeholder={`Antwort ${k + 1}`} maxLength={300} />
              {q.options.length > 2 && (
                <button className="btn small ghost" aria-label="Antwort entfernen" onClick={() => set({ options: q.options.filter((_, j) => j !== k) })}>
                  ✕
                </button>
              )}
            </div>
          ))}
          {q.options.length < 10 && (
            <button className="btn small secondary" style={{ alignSelf: 'flex-start' }} onClick={() => set({ options: [...q.options, { text: '', correct: false }] })}>
              + Antwort
            </button>
          )}
        </div>
      )}
      {q.kind === 'truefalse' && (
        <Field label="Die Aussage ist …">
          <Select value={q.correct_value ? 'true' : 'false'} onChange={(v) => set({ correct_value: v === 'true' })} options={[['true', 'wahr'], ['false', 'falsch']]} />
        </Field>
      )}
      {q.kind === 'short' && (
        <>
          <Field label="Richtige Antworten (eine pro Zeile)" hint="Groß-/Kleinschreibung, Satzzeichen am Ende und Leerzeichen spielen keine Rolle. Leer = du prüfst jede Antwort von Hand.">
            <Textarea value={q.accepted} onChange={(v) => set({ accepted: v })} rows={3} />
          </Field>
          <Check checked={q.review === 'manual' || !q.accepted.trim()} onChange={(v) => set({ review: v ? 'manual' : 'auto' })} label="Immer von Hand prüfen" />
        </>
      )}
      <MoreFields id="quiz-question" label="Punkte & Erklärung" values={[Number(q.points) !== 1, q.explanation]}>
        <Field label="Punkte">
          <Input type="number" min={1} max={100} value={q.points} onChange={(v) => set({ points: Math.max(1, Number(v) || 1) })} />
        </Field>
        <Field label="Erklärung (wird nach dem Versuch gezeigt)">
          <Input value={q.explanation} onChange={(v) => set({ explanation: v })} maxLength={1000} />
        </Field>
      </MoreFields>
    </div>
  );
}

function QuizDialog({ quiz, onClose, onSaved }: { quiz?: any; onClose: () => void; onSaved: () => void }) {
  const courses = useLoad(() => api.get<any[]>('/api/courses'), []);
  const [courseId, setCourseId] = useState(quiz?.course_id ?? '');
  const course = useLoad(() => (courseId ? api.get(`/api/courses/${courseId}`) : Promise.resolve(null)), [courseId]);
  const [lessonId, setLessonId] = useState(quiz?.lesson_id ?? '');
  const [title, setTitle] = useState(quiz?.title ?? '');
  const [intro, setIntro] = useState(quiz?.intro ?? '');
  const [pass, setPass] = useState(String(quiz?.pass_percent ?? 70));
  const [attempts, setAttempts] = useState(String(quiz?.max_attempts ?? 0));
  const [gate, setGate] = useState(quiz ? !!quiz.gate : true);
  const [shuffle, setShuffle] = useState(!!quiz?.shuffle);
  const [show, setShow] = useState(quiz?.show_answers ?? 'after_pass');
  const [questions, setQuestions] = useState<Q[]>(quiz ? quiz.questions.map(fromServer) : [blankQuestion()]);
  const upd = (i: number, p: Partial<Q>) => setQuestions(questions.map((q, j) => (j === i ? { ...q, ...p } : q)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...questions];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setQuestions(next);
  };
  const problem = !quiz && !lessonId ? 'Bitte Kurs und Lektion wählen.' : !questions.length ? 'Mindestens eine Frage.' : questions.some((q) => !q.text.trim()) ? 'Jede Frage braucht einen Text.' : '';
  const save = async () => {
    const body = { title, intro, pass_percent: Number(pass), max_attempts: Number(attempts) || 0, gate, shuffle, show_answers: show, questions: questions.map(toServer), ...(quiz ? {} : { course_id: courseId, lesson_id: lessonId }) };
    const r = await act(() => (quiz ? api.put(`/api/quizzes/${quiz.id}`, body) : api.post('/api/quizzes', body)), 'Quiz gespeichert');
    if (r) {
      onSaved();
      onClose();
    }
  };
  return (
    <Modal
      title={quiz ? `Quiz: ${quiz.title}` : 'Neues Quiz'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={!!problem} title={problem} onClick={save} data-tour="quiz-save">
            Speichern
          </button>
        </>
      }
    >
      {!quiz && (
        <div className="cr-form-row">
          <Field label="Kurs *">
            <Select value={courseId} onChange={(v) => (setCourseId(v), setLessonId(''))} options={(courses.data ?? []).map((c) => [c.id, c.title] as [string, string])} placeholder="Kurs wählen …" />
          </Field>
          <Field label="Lektion *" hint="Das Quiz ersetzt den Inhalt dieser Lektion. Lege die Lektion vorher im Kurs an.">
            <Select value={lessonId} onChange={(v) => (setLessonId(v), !title && setTitle(lessonOptions(course.data?.modules).find((l) => l[0] === v)?.[1].split(' › ')[1] ?? ''))} options={lessonOptions(course.data?.modules)} placeholder={courseId ? 'Lektion wählen …' : 'Erst Kurs wählen'} />
          </Field>
        </div>
      )}
      <Field label="Titel">
        <Input value={title} onChange={setTitle} maxLength={160} placeholder="Wissenstest zu Modul 1" />
      </Field>
      {/* Einfach-Modus: the good defaults (70 %, unlimited attempts, solutions after passing, next lesson locked) behind one toggle */}
      <MoreFields id="quiz-settings" label="Einleitung & Regeln" values={[intro, pass !== '70', attempts !== '0', show !== 'after_pass', !gate, shuffle]}>
        <Field label="Einleitung (optional)">
          <Textarea value={intro} onChange={setIntro} rows={2} maxLength={3000} />
        </Field>
        <div className="cr-form-row" data-tour="quiz-settings">
          <Field label="Bestanden ab (%)">
            <Input type="number" min={1} max={100} value={pass} onChange={setPass} />
          </Field>
          <Field label="Versuche (0 = unbegrenzt)">
            <Input type="number" min={0} max={50} value={attempts} onChange={setAttempts} />
          </Field>
          <Field label="Lösungen zeigen">
            <Select value={show} onChange={setShow} options={SHOW} />
          </Field>
        </div>
        <Check checked={gate} onChange={setGate} label="Die nächste Lektion bleibt gesperrt, bis das Quiz bestanden ist" />
        <Check checked={shuffle} onChange={setShuffle} label="Fragen und Antworten mischen" />
      </MoreFields>
      <h4 style={{ margin: '16px 0 10px' }}>Fragen ({questions.length})</h4>
      {questions.map((q, i) => (
        <QuestionEditor key={q.id ?? i} q={q} i={i} n={questions.length} set={(p) => upd(i, p)} move={(d) => move(i, d)} remove={() => setQuestions(questions.filter((_, j) => j !== i))} />
      ))}
      <button className="btn secondary" onClick={() => setQuestions([...questions, blankQuestion()])} disabled={questions.length >= 100} data-tour="quiz-add-question">
        + Frage
      </button>
    </Modal>
  );
}

function AttemptsDialog({ quiz, onClose }: { quiz: any; onClose: () => void }) {
  const { data, reload } = useLoad(() => api.get<any[]>(`/api/quizzes/${quiz.id}/attempts`), [quiz.id]);
  const reset = async (a: any) => {
    if (!confirmAsk(`Alle Versuche von ${a.contact.name} zurücksetzen? Die Person kann das Quiz dann neu beginnen.`)) return;
    if (await act(() => api.post(`/api/quizzes/${quiz.id}/reset`, { contact_id: a.contact.id }), 'Versuche zurückgesetzt')) reload();
  };
  return (
    <Modal title={`Versuche: ${quiz.title}`} wide onClose={onClose}>
      {!data ? (
        <Spinner />
      ) : data.length ? (
        <div className="cr-list">
          {data.map((a) => (
            <Item
              key={a.id}
              tone={a.status === 'pending' ? 'warn' : a.passed ? 'ok' : undefined}
              side={
                <>
                  <StatusBadge status={a.status === 'pending' ? 'pending' : a.passed ? 'approved' : 'rejected'} />
                  <button className="btn small secondary" onClick={() => reset(a)}>
                    Zurücksetzen
                  </button>
                </>
              }
            >
              <strong>{a.contact.name}</strong> · Versuch {a.attempt_no} · {a.percent} %
              <div className="cr-sub">
                {dt(a.submitted_at)} · {a.score} von {a.max_score} Punkten
              </div>
            </Item>
          ))}
        </div>
      ) : (
        <Empty>Noch niemand hat das Quiz versucht.</Empty>
      )}
    </Modal>
  );
}

function QuizzesTab() {
  const list = useLoad(() => api.get<any[]>('/api/quizzes'), []);
  const [editing, setEditing] = useState<any>(null);
  const [attempts, setAttempts] = useState<any>(null);
  const open = async (q: any) => {
    const full = await act(() => api.get(`/api/quizzes/${q.id}`));
    if (full) setEditing(full);
  };
  const remove = async (q: any) => {
    if (!confirmAsk(`Das Quiz „${q.title}“ mit allen Versuchen löschen? Die Lektion bleibt leer zurück.`)) return;
    if (await act(() => api.del(`/api/quizzes/${q.id}`), 'Quiz gelöscht')) list.reload();
  };
  return (
    <Panel
      title="Quizze"
      sub="Ein Quiz ist eine Lektion mit Fragen. Es wertet selbst aus und sperrt auf Wunsch die nächste Lektion bis zum Bestehen."
      wide
      tour="quiz-list"
      actions={
        <button className="btn" data-tour="quiz-new" onClick={() => setEditing({})}>
          <Icon name="award" /> Neues Quiz
        </button>
      }
    >
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <div className="cr-list">
          {list.data.map((q) => (
            <Item
              key={q.id}
              tone={q.stats.pending ? 'warn' : undefined}
              onClick={() => open(q)}
              side={
                <>
                  {q.stats.pending > 0 && <Badge tone="yellow">{q.stats.pending} zu prüfen</Badge>}
                  <button
                    className="btn small secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAttempts(q);
                    }}
                  >
                    Versuche
                  </button>
                  <button
                    className="btn small ghost danger-text"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(q);
                    }}
                  >
                    Löschen
                  </button>
                </>
              }
            >
              <strong>{q.title}</strong>
              <div className="cr-sub">
                {q.course_title} › {q.lesson_title} · {q.question_count} Fragen · bestanden ab {q.pass_percent} % · {q.max_attempts ? `${q.max_attempts} Versuche` : 'unbegrenzt'}
                {q.gate ? ' · sperrt die nächste Lektion' : ''}
              </div>
              <div className="cr-sub">
                {q.stats.people} Person{q.stats.people === 1 ? '' : 'en'} · {q.stats.attempts} Versuche · {q.stats.passed} bestanden
              </div>
            </Item>
          ))}
        </div>
      ) : (
        <Empty action={<button className="btn" onClick={() => setEditing({})}>Erstes Quiz anlegen</button>}>Noch kein Quiz. Lege es an einer Lektion deines Kurses an.</Empty>
      )}
      {editing && <QuizDialog quiz={editing.id ? editing : undefined} onClose={() => setEditing(null)} onSaved={list.reload} />}
      {attempts && <AttemptsDialog quiz={attempts} onClose={() => setAttempts(null)} />}
    </Panel>
  );
}

export function Quizzes({ tab: tabParam }: { tab?: string }) {
  const [tab, setTab] = useState(['quizzes', 'assignments', 'reviews', 'certificates'].includes(tabParam ?? '') ? tabParam! : 'quizzes');
  const reviews = useLoad(() => api.get('/api/quizzes/reviews'), []);
  const pending = (reviews.data?.counts?.quiz_attempts ?? 0) + (reviews.data?.counts?.assignment_submissions ?? 0);
  return (
    <div className="cr cr-quizzes">
      <PageHead title="Quiz & Zertifikate" sub="Wissen prüfen, Aufgaben abnehmen und Zertifikate ausstellen – direkt in deinen Kursen.">
        <Link to="courses" className="btn secondary">
          Zu den Kursen
        </Link>
      </PageHead>
      {pending > 0 && tab !== 'reviews' && (
        <Callout tone="warn" tour="quiz-pending">
          <strong>{pending} Einreichung{pending === 1 ? '' : 'en'} warten auf deine Prüfung.</strong>{' '}
          <button className="btn small secondary" onClick={() => setTab('reviews')}>
            Jetzt prüfen
          </button>
        </Callout>
      )}
      <Tabs
        tabs={[
          ['quizzes', 'Quizze'],
          ['assignments', 'Aufgaben'],
          ['reviews', `Prüfen${pending ? ` (${pending})` : ''}`],
          ['certificates', 'Zertifikate'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'quizzes' && <QuizzesTab />}
      {tab === 'assignments' && <AssignmentsTab />}
      {tab === 'reviews' && <ReviewsTab data={reviews.data} loading={reviews.loading} reload={reviews.reload} />}
      {tab === 'certificates' && <CertificatesTab />}
    </div>
  );
}
