import { createHash } from 'node:crypto';
import type { Module } from '../core/app.js';
import { redirect, text as textResult, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { clip, deDate, limiter } from '../services/creator-kit.js';
import { gradeAttempt, type Answers, type Question } from '../services/creator-quiz.js';
import { completedLessonIds, courseOutline, flatLessons, getCourse, isUnlocked } from '../services/courses.js';
import { renderMarkdown } from '../services/markdown.js';
import type { AttemptRow, QuizRow } from './quiz.js';
import type { AssignmentRow, SubmissionRow } from './quiz-assignments.js';

/**
 * The learner's side of quizzes and assignments, inside the member portal's lesson page (hooks lessonExtras, lessonGates):
 * the quiz form and its result, the assignment status and its own hand-in page (text and/or a file, read in the browser by a
 * small script of ours because the portal pages allow no inline scripts). Rights are the member's: only a person with an
 * active, published course seat, an unlocked lesson and an open attempt can submit. Docs: docs/quizzes-certificates.md.
 */

const SCRIPT = `(function(){var MAX=5*1024*1024;document.addEventListener('change',function(e){var i=e.target;if(!i||!i.matches||!i.matches('input[type=file][data-assign]'))return;var f=i.files&&i.files[0];var d=document.getElementById('a-data'),n=document.getElementById('a-name'),m=document.getElementById('a-msg');if(d)d.value='';if(n)n.value='';if(m)m.textContent='';if(!f)return;if(f.size>MAX){if(m)m.textContent='Die Datei ist größer als 5 MB.';i.value='';return}var r=new FileReader();r.onload=function(){if(d)d.value=String(r.result);if(n)n.value=f.name;if(m)m.textContent=f.name+' ist bereit.'};r.onerror=function(){if(m)m.textContent='Die Datei konnte nicht gelesen werden.'};r.readAsDataURL(f)})})();`;

const CSS = `<style>
.qz{margin-top:30px}.qz h2{margin:0 0 6px}.qz .q{border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 12px;background:var(--panel)}
.qz .q h3{font-size:17px;margin:0 0 10px}.qz label.o{display:flex;gap:12px;align-items:center;min-height:48px;padding:6px 12px;border:1px solid var(--line);border-radius:12px;margin:0 0 8px;cursor:pointer;font-weight:400}
.qz label.o:hover{border-color:var(--brand)}.qz label.o:focus-within{outline:3px solid var(--brand);outline-offset:1px}.qz input[type=radio],.qz input[type=checkbox]{width:22px;height:22px;flex:none}
.qz input[type=text],.qz textarea{width:100%;padding:12px;border:1px solid var(--line);border-radius:12px;font:inherit;background:var(--panel);color:var(--text)}.qz textarea{min-height:160px}
.qz .ok{color:var(--ok);font-weight:600}.qz .bad{color:#dc2626;font-weight:600}.qz .box{border-radius:14px;padding:14px 18px;margin:0 0 14px;background:var(--soft)}.qz .box.pass{background:rgba(5,150,105,.12)}.qz .box.fail{background:rgba(220,38,38,.10)}
.qz .sol{font-size:14px;color:var(--muted);margin-top:6px}.qz .btn{min-height:48px}.qz .fb{white-space:pre-wrap}
</style>`;

const shuffleSeeded = <T extends { id: string }>(list: T[], seed: string): T[] => [...list].sort((a, b) => createHash('sha256').update(`${seed}:${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`${seed}:${b.id}`).digest('hex')));

export const quizPortalModule: Module = {
  name: 'quiz-portal',
  register(app) {
    const { db, router } = app;
    const kit = () => app.services.portalKit;
    const quizzes = () => app.services.quizKit;
    const assignments = () => app.services.assignmentKit;
    const submitLimit = limiter(30, 60 * 60_000);

    /** The member's seat in a course, the lesson, and whether it is open (drip and gates). */
    function lessonContext(portal: { locationId: string }, contactId: string, slug: string, lessonId: string) {
      const row = db.get<any>(
        `SELECT e.*, c.id AS cid FROM course_enrollments e JOIN courses c ON c.id = e.course_id WHERE e.location_id = ? AND e.contact_id = ? AND e.status = 'active' AND c.status = 'published' AND c.slug = ?`,
        portal.locationId,
        contactId,
        slug,
      );
      if (!row) return undefined;
      const course = getCourse(app, portal.locationId, row.cid);
      if (!course) return undefined;
      const lessons = flatLessons(courseOutline(app, course.id, { publishedOnly: true }));
      const lesson = lessons.find((l) => l.id === lessonId);
      if (!lesson) return undefined;
      const seat = { enrollment: row, course, lessons, done: completedLessonIds(app, row.id) };
      const gated = ((app.services.lessonGates ?? []) as ((s: unknown, l: unknown) => string | undefined)[]).some((fn) => fn(seat, lesson));
      return { seat, lesson, open: isUnlocked(row.enrolled_at, lesson.module.drip_days, lesson.drip_days) && !gated };
    }
    const lessonUrl = (p: { base: string }, slug: string, lessonId: string) => `${p.base}/c/${encodeURIComponent(slug)}/${encodeURIComponent(lessonId)}`;

    // --- the lesson page: quiz or assignment below the lesson text --------------------------------------------------------
    app.services.lessonExtras = [
      ...(app.services.lessonExtras ?? []),
      (p: any, m: any, s: any, l: any) => {
        const quiz = quizzes()?.quizOf(p.locationId, db.get<any>('SELECT id FROM quizzes WHERE lesson_id = ?', l.id)?.id ?? '') as QuizRow | undefined;
        if (quiz) return { html: quizBlock(p, m, s, l, quiz), hideMark: true };
        const a = db.get<AssignmentRow>('SELECT * FROM assignments WHERE lesson_id = ? AND location_id = ?', l.id, p.locationId);
        if (a) return { html: assignmentBlock(p, m, s, l, a), hideMark: !!a.pass_required };
        return undefined;
      },
    ];

    function review(q: Question, a: AttemptRow, quiz: QuizRow, reveal: boolean, i: number) {
      const g = gradeAttempt([q], a.answers, a.reviews).graded[0];
      const given = a.answers[q.id];
      const mark = g.pending ? '<span class="muted">wartet auf Prüfung</span>' : g.correct ? '<span class="ok">✓ richtig</span>' : '<span class="bad">✗ falsch</span>';
      let sol = '';
      if (reveal && g.correct !== true) {
        sol =
          q.kind === 'short'
            ? q.accepted.length ? `Richtig wäre z. B.: ${escapeHtml(q.accepted[0])}` : ''
            : `Richtig: ${q.options.filter((o) => o.correct).map((o) => escapeHtml(o.text)).join(', ')}`;
        if (q.explanation) sol += `${sol ? ' – ' : ''}${escapeHtml(q.explanation)}`;
      }
      const note = a.reviews[q.id]?.comment ? `<div class="sol">Kursleitung: ${escapeHtml(a.reviews[q.id].comment!)}</div>` : '';
      const text = q.kind === 'short' ? String(given ?? '') : (Array.isArray(given) ? given : [given]).map((v) => q.options.find((o) => o.id === v)?.text ?? '').filter(Boolean).join(', ');
      return `<li style="margin:0 0 8px"><b>${i + 1}. ${escapeHtml(q.text)}</b> ${mark}<div class="sol">Deine Antwort: ${escapeHtml(text || '–')}</div>${sol ? `<div class="sol">${sol}</div>` : ''}${note}</li>`;
    }

    function quizBlock(p: any, m: any, s: any, l: any, quiz: QuizRow): string {
      const st = quizzes().standing(quiz, m.contact.id);
      const last = st.last as AttemptRow | undefined;
      const parts: string[] = [`<section class="qz" id="quiz"><h2>${escapeHtml(quiz.title || 'Quiz')}</h2>`];
      if (quiz.intro) parts.push(`<div class="prose muted" style="margin:0 0 12px">${renderMarkdown(quiz.intro)}</div>`);
      parts.push(`<p class="muted small">${quiz.questions.length} Fragen · bestanden ab ${quiz.pass_percent} %${quiz.max_attempts ? ` · ${quiz.max_attempts} Versuche${st.left !== null ? ` (noch ${st.left})` : ''}` : ''}</p>`);
      if (last) {
        const reveal = quiz.show_answers === 'always' || (quiz.show_answers === 'after_pass' && (!!last.passed || st.left === 0));
        if (last.status === 'pending') parts.push(`<div class="box">Deine Antworten sind angekommen. Einige Fragen prüft die Kursleitung – du bekommst eine E-Mail, sobald das Ergebnis da ist.</div>`);
        else parts.push(`<div class="box ${last.passed ? 'pass' : 'fail'}"><b>${last.passed ? `Bestanden – ${last.percent} %` : `Noch nicht bestanden – ${last.percent} %`}</b> <span class="muted small">(Versuch ${last.attempt_no}, ${last.score} von ${last.max_score} Punkten)</span>${last.comment ? `<div class="fb small" style="margin-top:8px">${escapeHtml(last.comment)}</div>` : ''}</div>`);
        if (quiz.show_answers !== 'never') parts.push(`<ol class="small" style="padding-left:20px">${quiz.questions.map((q, i) => review(q, last, quiz, reveal, i)).join('')}</ol>`);
      }
      if (st.passed) parts.push(`<p class="ok">✓ Dieses Quiz ist abgeschlossen.</p>`);
      else if (st.canTry) {
        const seed = `${m.contact.id}:${quiz.id}`;
        const form = quiz.questions
          .map((q, i) => {
            const opts = quiz.shuffle ? shuffleSeeded(q.options, seed) : q.options;
            const body =
              q.kind === 'short'
                ? `<input type="text" name="q_${q.id}" maxlength="300" autocomplete="off" aria-label="Antwort zu Frage ${i + 1}">`
                : opts.map((o) => `<label class="o"><input type="${q.kind === 'multiple' ? 'checkbox' : 'radio'}" name="${q.kind === 'multiple' ? `q_${q.id}_${o.id}` : `q_${q.id}`}" value="${q.kind === 'multiple' ? '1' : escapeHtml(o.id)}"> <span>${escapeHtml(o.text)}</span></label>`).join('');
            return `<div class="q"><h3>${i + 1}. ${escapeHtml(q.text)}</h3>${q.kind === 'multiple' ? '<div class="muted small" style="margin:-6px 0 8px">Mehrere Antworten möglich</div>' : ''}${body}</div>`;
          })
          .join('');
        parts.push(`<form method="post" action="${lessonUrl(p, s.course.slug, l.id)}/quiz">${last ? '<p class="muted">Du kannst es noch einmal versuchen:</p>' : ''}${form}<button class="btn ok">Antworten abgeben</button></form>`);
      } else if (!st.pending) parts.push(`<p class="muted">Alle Versuche sind verbraucht. Bitte melde dich bei der Kursleitung.</p>`);
      parts.push('</section>');
      return CSS + parts.join('');
    }

    function assignmentBlock(p: any, m: any, s: any, l: any, a: AssignmentRow): string {
      const st = assignments().standing(a, m.contact.id) as { last?: SubmissionRow; passed: boolean; waiting: boolean; canSubmit: boolean };
      const tz = p.loc.timezone;
      const parts: string[] = [`<section class="qz" id="aufgabe"><h2>${escapeHtml(a.title || 'Aufgabe')}</h2>`];
      if (a.instructions) parts.push(`<div class="prose" style="margin:0 0 12px">${renderMarkdown(a.instructions)}</div>`);
      const last = st.last;
      if (last) {
        const label = last.status === 'passed' ? 'Bestanden' : last.status === 'failed' ? 'Nicht bestanden' : last.status === 'revision' ? 'Bitte überarbeiten' : 'Abgegeben – wird geprüft';
        parts.push(`<div class="box ${last.status === 'passed' ? 'pass' : last.status === 'submitted' ? '' : 'fail'}"><b>${label}</b> <span class="muted small">(Abgabe ${last.attempt_no} vom ${escapeHtml(deDate(last.submitted_at, tz))})</span>${last.feedback ? `<div class="fb small" style="margin-top:8px"><b>Rückmeldung:</b>\n${escapeHtml(last.feedback)}</div>` : ''}${last.file_name ? `<div class="small" style="margin-top:8px"><a href="${lessonUrl(p, s.course.slug, l.id)}/aufgabe/datei/${encodeURIComponent(last.id)}">${escapeHtml(last.file_name)}</a></div>` : ''}</div>`);
      }
      if (st.passed) parts.push('<p class="ok">✓ Diese Aufgabe ist abgeschlossen.</p>');
      else if (st.canSubmit) parts.push(`<p><a class="btn ok" href="${lessonUrl(p, s.course.slug, l.id)}/aufgabe">${last ? 'Erneut abgeben' : 'Aufgabe bearbeiten und abgeben'}</a></p>`);
      parts.push('</section>');
      return CSS + parts.join('');
    }

    // --- taking the quiz --------------------------------------------------------------------------------------------------------
    router.post('/portal/:p/c/:course/:lesson/quiz', 'public', (ctx): RawResult => {
      const k = kit();
      const p = k?.resolve(ctx.params.p);
      if (!k || !p) return k?.unknownPortal() ?? redirect('/', 303);
      const m = k.memberOf(ctx, p);
      if (!m) return redirect(p.base, 303);
      if (!k.sameOrigin(ctx)) return k.notFoundPage(p, m);
      const c = lessonContext(p, m.contact.id, ctx.params.course, ctx.params.lesson);
      const quiz = c && (quizzes().quizOf(p.locationId, db.get<any>('SELECT id FROM quizzes WHERE lesson_id = ?', c.lesson.id)?.id ?? '') as QuizRow | undefined);
      if (!c || !c.open || !quiz) return k.notFoundPage(p, m);
      if (submitLimit(m.contact.id)) return notice(k, p, m, 'Zu viele Versuche – bitte warte etwas.', lessonUrl(p, ctx.params.course, ctx.params.lesson));
      const body = ctx.body ?? {};
      const answers: Answers = {};
      for (const q of quiz.questions) {
        if (q.kind === 'multiple') answers[q.id] = q.options.filter((o) => body[`q_${q.id}_${o.id}`] === '1' || body[`q_${q.id}_${o.id}`] === 'on').map((o) => o.id);
        else answers[q.id] = clip(body[`q_${q.id}`], 300);
      }
      try {
        quizzes().submit(quiz, c.seat.enrollment.id, m.contact.id, answers);
      } catch (e) {
        return notice(k, p, m, (e as Error).message, lessonUrl(p, ctx.params.course, ctx.params.lesson));
      }
      return redirect(`${lessonUrl(p, ctx.params.course, ctx.params.lesson)}#quiz`, 303);
    });

    const notice = (k: any, p: any, m: any, message: string, back: string) =>
      k.page(p, { title: 'Hinweis', member: m, status: 400, body: `<div class="panel empty"><h2>${escapeHtml(message)}</h2><p><a class="btn" href="${escapeHtml(back)}">Zurück zur Lektion</a></p></div>` }) as RawResult;

    // --- assignments --------------------------------------------------------------------------------------------------------------
    const withAssignment = (ctx: Ctx, fn: (k: any, p: any, m: any, c: NonNullable<ReturnType<typeof lessonContext>>, a: AssignmentRow) => RawResult): RawResult => {
      const k = kit();
      const p = k?.resolve(ctx.params.p);
      if (!k || !p) return k?.unknownPortal() ?? redirect('/', 303);
      const m = k.memberOf(ctx, p);
      if (!m) return redirect(p.base, 303);
      const c = lessonContext(p, m.contact.id, ctx.params.course, ctx.params.lesson);
      const a = c && db.get<AssignmentRow>('SELECT * FROM assignments WHERE lesson_id = ? AND location_id = ?', c.lesson.id, p.locationId);
      if (!c || !c.open || !a) return k.notFoundPage(p, m);
      return fn(k, p, m, c, a);
    };
    const withScript = (r: RawResult): RawResult => {
      r.headers['content-security-policy'] = String(r.headers['content-security-policy']).replace("default-src 'none';", "default-src 'none'; script-src 'self';");
      return r;
    };
    router.get('/portal-assignments.js', 'public', () => {
      const r = textResult(SCRIPT, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=3600';
      return r;
    });
    router.get('/portal/:p/c/:course/:lesson/aufgabe', 'public', (ctx) =>
      withAssignment(ctx, (k, p, m, c, a) => {
        const st = assignments().standing(a, m.contact.id) as { passed: boolean; canSubmit: boolean };
        const back = lessonUrl(p, ctx.params.course, ctx.params.lesson);
        if (!st.canSubmit || st.passed) return redirect(`${back}#aufgabe`, 303);
        const err = String(ctx.query.get('fehler') ?? '');
        const text = a.kind === 'file' ? '' : `<label for="a-text" style="display:block;font-weight:600;margin:0 0 6px">Dein Text</label><textarea id="a-text" name="text" maxlength="20000"></textarea>`;
        const file = a.kind === 'text' ? '' : `<label for="a-file" style="display:block;font-weight:600;margin:14px 0 6px">Datei (optional, bis 5 MB: PDF, Bild, Word, Excel, ZIP, Text)</label><input id="a-file" type="file" data-assign accept=".pdf,.png,.jpg,.jpeg,.zip,.txt,.csv,.docx,.xlsx,.pptx"><input type="hidden" id="a-data" name="data"><input type="hidden" id="a-name" name="file_name"><div id="a-msg" class="muted small" role="status"></div>`;
        return withScript(
          k.page(p, {
            title: a.title,
            member: m,
            head: `${CSS}<script src="/portal-assignments.js" defer></script>`,
            body: `<div class="qz"><div class="crumb"><a href="${escapeHtml(back)}">← Zur Lektion</a></div><h1>${escapeHtml(a.title)}</h1>${a.instructions ? `<div class="prose" style="margin:0 0 16px">${renderMarkdown(a.instructions)}</div>` : ''}${err ? `<div class="box fail">${escapeHtml(MSG[err] ?? 'Das hat nicht geklappt.')}</div>` : ''}<form method="post" action="${escapeHtml(back)}/aufgabe">${text}${file}<p style="margin-top:18px"><button class="btn ok">Abgeben</button></p></form></div>`,
          }),
        );
      }),
    );
    const MSG: Record<string, string> = { leer: 'Bitte einen Text eingeben oder eine Datei auswählen.', datei: 'Die Datei konnte nicht angenommen werden (PDF, Bild, Word, Excel, ZIP oder Text, bis 5 MB).', viel: 'Zu viele Abgaben – bitte warte etwas.', status: 'Diese Aufgabe lässt sich gerade nicht abgeben.' };
    router.post('/portal/:p/c/:course/:lesson/aufgabe', 'public', (ctx) =>
      withAssignment(ctx, (k, p, m, c, a) => {
        if (!k.sameOrigin(ctx)) return k.notFoundPage(p, m);
        const back = lessonUrl(p, ctx.params.course, ctx.params.lesson);
        if (submitLimit(m.contact.id)) return redirect(`${back}/aufgabe?fehler=viel`, 303);
        try {
          assignments().submit(a, c.seat.enrollment.id, m.contact.id, { text: String(ctx.body?.text ?? ''), data: ctx.body?.data, fileName: ctx.body?.file_name });
        } catch (e) {
          const msg = (e as Error).message;
          return redirect(`${back}/aufgabe?fehler=${/^Bitte/.test(msg) ? 'leer' : /bestanden|geprüft/.test(msg) ? 'status' : 'datei'}`, 303);
        }
        return redirect(`${back}#aufgabe`, 303);
      }),
    );
    router.get('/portal/:p/c/:course/:lesson/aufgabe/datei/:sid', 'public', (ctx) =>
      withAssignment(ctx, (k, p, m, _c, a) => {
        const s = db.get<SubmissionRow>('SELECT * FROM assignment_submissions WHERE id = ? AND assignment_id = ? AND contact_id = ? AND location_id = ?', ctx.params.sid, a.id, m.contact.id, p.locationId);
        return s?.file_path ? assignments().fileResult(s) : k.notFoundPage(p, m);
      }),
    );
  },
};
