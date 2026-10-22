# Quizzes, assignments and certificates

**Seiten → Quiz & Zertifikate** turns a course into a path with proof of learning: **quizzes** that grade themselves, **assignments** with a text or file hand-in that you review, and **certificates** (PDF with a public verification page) when the course is completed or a quiz is passed. Quizzes and assignments are lesson types of the existing **Kurse** and run in the member area; certificates are made on the server without any extra library.

Everything is per sub-account and belongs to the area **Kurse** (`courses`).

- [Quizzes](#quizzes)
- [Assignments](#assignments)
- [The review queue](#the-review-queue)
- [Certificates](#certificates)
- [In the member area](#in-the-member-area)
- [Workflows, API and MCP](#workflows-api-and-mcp)
- [Limits and good to know](#limits-and-good-to-know)

## Quizzes

*Quiz & Zertifikate → Quizze → Neues Quiz.* Pick the **course and lesson** the quiz belongs to (a lesson holds either a quiz or an assignment, not both; create the lesson in the course first). The quiz replaces the lesson's content.

| Setting | Meaning |
| --- | --- |
| Bestanden ab (%) | Pass mark, 1–100 (default 70). |
| Versuche | 0 = unlimited, otherwise 1–50 attempts per person. |
| Lösungen zeigen | After passing (default), after every attempt, or never. |
| Nächste Lektion sperren | **Gate:** the following lessons stay closed until the quiz is passed. |
| Mischen | Questions and answers in random order for each attempt. |

Questions (up to 60, each with points and an optional explanation shown after the attempt):

- **Eine richtige Antwort** (single choice) and **mehrere richtige Antworten** (multiple choice – all correct options and no wrong one earn the points).
- **Wahr oder falsch.**
- **Kurzantwort** (text): compared with the accepted answers after normalising (case, spaces, quotes and punctuation at the end are ignored: " Paris! " equals "paris"). With no accepted answer – or *Immer von Hand prüfen* – the answer goes to the [review queue](#the-review-queue) and the attempt stays *wartet auf Prüfung* until you decide.

Passing a quiz **completes the lesson** (and the course, if it was the last lesson) – progress, `lesson.completed`/`course.completed` and the course certificate follow as for any lesson. *Versuche* shows every attempt per person (score, time) and lets you **reset** one person's attempts. Answers are graded on the server; the browser never gets the correct answers of a quiz that is still open.

## Assignments

*Aufgaben → Neue Aufgabe:* course and lesson, title, instructions (Markdown), and what to hand in: **Text**, **Datei** or **beides**. Two switches: *Die Lektion gilt erst als abgeschlossen, wenn die Abgabe bestanden ist* and *Die nächste Lektion bleibt gesperrt, bis die Aufgabe bestanden ist*.

A learner hands in text and/or one file (PDF, PNG, JPG, ZIP, Word, Excel, PowerPoint or text, up to 5 MB; the content is checked against the type). A new hand-in is possible only after the last one was reviewed as *bitte überarbeiten* or *nicht bestanden*. **Files are private:** they live in `data/assignment-files/` outside the public uploads, are never served by a public link, and only team members of the sub-account (and the learner on their own page) can open them. Back that folder up with the rest of `data/`.

## The review queue

*Prüfen* collects everything that waits for you (a counter on the tab and a hint on the page): short answers of quiz attempts and assignment hand-ins.

- **Short answers:** mark each as *richtig* or *falsch* (optionally a comment), then finish. The attempt gets its final score, `quiz.passed` or `quiz.failed` runs, the lesson completes if passed.
- **Hand-ins:** choose *Bestanden*, *Bitte überarbeiten* or *Nicht bestanden* and write feedback. The learner sees the result and the feedback in the member area and gets an e-mail; `assignment.reviewed` runs.

New hand-ins and answers waiting for review reach you as a push message and in the app (*Mobile: reviews*).

## Certificates

*Zertifikate → Vorlagen → Vorlage.* A template per course (or one for all courses without their own):

| Field | |
| --- | --- |
| Ausstellen | **When the course is completed**, **when a chosen quiz is passed**, or **by hand only**. |
| Gestaltung | Title, line above the name, text below (`{{course}}`, `{{name}}`, `{{date}}`, `{{score}}`), issuer, signer name and role, colours, portrait or landscape, number prefix, footer. |
| Logo, Unterschrift | PNG or JPG images from your media library (upload in the dialog). |
| Quiz-Ergebnis nennen | Print the percentage. |
| Per E-Mail senden | The person gets the PDF link and the verification page. |

*Vorschau (PDF)* builds a sample from the template you are editing without saving or issuing anything. A person gets **one valid certificate per course**; issuing again returns the existing one. Each certificate has a number (`ZERT-2026-0001`), the PDF (`/zertifikat/<id>/pdf`) and a public **verification page** (`/zertifikat/<id>`) showing name, course, date, number and whether it is valid – the id is unguessable, and the page carries `noindex`.

*Ausgestellte Zertifikate* lists them with *PDF*, *Prüfseite*, *Erneut senden* and **Widerrufen** (the verification page then shows *ungültig*). *Von Hand ausstellen* issues one for a contact and course.

## In the member area

On the lesson page of the member portal a learner sees the quiz form (one question per card, attempts left, result with the per-question outcome according to *Lösungen zeigen*) or the assignment status and its own hand-in page. Locked lessons show *gesperrt* and the reason ("Schließe zuerst das Quiz … ab"). The dashboard lists the person's certificates with PDF and verification link. The pages follow the portal's rules: only a person with an active, published course seat, an unlocked lesson and an open attempt can submit; the pages need no inline script beyond one small script of ours (`/portal-assignments.js`) for reading the file in the browser.

## Workflows, API and MCP

**Triggers** (*Kurse, Community & Bewertungen*): *Quiz bestanden* (`quiz.passed`), *Quiz nicht bestanden* (`quiz.failed`, with `{{event.attempts_left}}`), *Aufgabe abgegeben* (`assignment.submitted`), *Aufgabe geprüft* (`assignment.reviewed`, filter for the result), *Zertifikat ausgestellt* (`certificate.issued`, with `{{event.certificate.url}}`, `{{event.certificate.number}}`). **Action:** *Zertifikat ausstellen* (`certificate_issue`; sets `{{var.certificate_url}}`, `{{var.certificate_pdf_url}}`, `{{var.certificate_number}}`).

**API** (area `courses`):

| Route | |
| --- | --- |
| `GET/POST /api/quizzes`, `GET/PUT/DELETE /api/quizzes/:id` | Quizzes (`POST` needs `course_id`, `lesson_id`, `questions`). |
| `GET /api/quizzes/:id/attempts`, `POST …/:id/reset` | Attempts; reset one person's (`{contact_id}`). |
| `GET /api/quizzes/reviews`, `POST /api/quizzes/attempts/:id/review` | The queue (quiz answers and hand-ins) and a quiz review (`{answers: {<question id>: {correct, comment?}}, comment?}`). |
| `GET/POST /api/assignments`, `GET/PUT/DELETE /api/assignments/:id` | Assignments. |
| `GET /api/assignments/:id/submissions`, `POST /api/assignments/submissions/:id/review`, `GET …/submissions/:id/file` | Hand-ins; review `{status: passed\|failed\|revision, feedback?}`; the file. |
| `GET/POST /api/certificates/templates`, `PATCH/DELETE …/:id`, `POST …/templates/preview` | Templates and the PDF preview (`{pdf_base64}`). |
| `GET /api/certificates`, `POST /api/certificates/issue`, `GET …/:id/pdf`, `POST …/:id/revoke \| resend` | Issued certificates. |

**MCP tools:** `ghl_quiz_list`, `ghl_quiz_save`, `ghl_quiz_reviews`, `ghl_quiz_review`, `ghl_certificate_issue`, `ghl_certificate_list`. **Mobile (read-only):** `GET /api/mobile/creator/reviews` ([docs/api.md](api.md)).

## Limits and good to know

- A quiz or assignment is part of a course: deleting the course deletes them, with attempts and hand-ins. Deleting a quiz leaves an empty lesson.
- Short answers compare text only – synonyms need either several accepted answers or a manual review.
- A certificate is a convenience document, **not** an accredited qualification; wording and legal effect are yours.
- Personal data (names, answers, files) stays in your sub-account and is deleted with the contact; revoked certificates keep their number.
- The certificate PDF is drawn by the same small PDF writer as the Canvas export: Latin text (including German umlauts) works; other scripts are replaced by a placeholder character.
