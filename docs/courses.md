# Courses in depth (video, discussion, paths, cohorts)

**Kurse** (Mitgliederbereich) already had modules, lessons, drip and a passwordless member portal. This page covers what was added on top, in the style of Kajabi and Teachable: your **own hosted video**, **discussion and reviews**, **learning paths**, **cohorts**, **analytics** and an **installable member app**. Everything is per sub-account, German UI.

- [Hosted video](#hosted-video)
- [The player](#the-player)
- [Discussion and reviews](#discussion-and-reviews)
- [Learning paths](#learning-paths)
- [Cohorts](#cohorts)
- [Analytics](#analytics)
- [Member app](#member-app)
- [Automations](#automations)
- [Settings and environment](#settings-and-environment)
- [API](#api)
- [Data protection](#data-protection)
- [Limits](#limits)
- [For developers](#for-developers)

## Hosted video

**Kurse → Video-Bibliothek** (also *Video wählen oder hochladen* inside a lesson). Upload MP4, MOV, WebM, MKV or Ogg.

| What | How it works |
| --- | --- |
| Upload | In parts of 8 MB (the same chunk protocol as the community and webinar uploads: `PUT …/upload?offset=`). A broken connection resumes where the server stopped: choose the same file again, or let the browser retry on its own. At most three unfinished uploads per sub-account; unfinished ones disappear after a day. |
| Size | Up to `PGHL_COURSE_VIDEO_MB` (default 2048 MB). The first bytes are checked – a renamed file is refused. |
| Storage | `<data dir>/course-videos/<id>.<ext>`, the poster `<id>.jpg`, renditions in `<id>/hls/`. Nothing is public: there is no static route to these files. |
| Delivery | Through **signed, expiring links** that are issued per member when the lesson page is rendered (`PGHL_COURSE_URL_TTL_MIN`, default 360 minutes). A link only works with the member's own session, from the member area (same origin; a request from another site is refused), and only while the member is enrolled in a course that uses the video. A copied link is useless; embedding on other sites does not work. |
| Streaming | The MP4 is served with **HTTP range requests** (seeking, resuming). Without ffmpeg that is all. |
| ffmpeg (optional) | **Feature-detected** at run time (`PGHL_FFMPEG`, `PGHL_FFPROBE` for other paths, `PGHL_COURSE_NO_FFMPEG=1` to ignore it). With it: duration and size from the file, a **poster frame** at upload, *faststart* (the MP4 starts playing before it is fully loaded), poster at any second from the preview, **HLS transcoding** (360p/720p/1080p, only the sizes the source has) and **AI captions** (it cuts the audio). The upload screen says plainly when ffmpeg is missing. |
| HLS | *In HLS umwandeln* (or automatically after every upload with `PGHL_COURSE_HLS=1`). Safari and iOS play the signed HLS master playlist natively with adaptive quality; other browsers play the MP4. Playlists are re-signed per request, so segments carry the same expiring token. |
| Poster | From the video at a chosen second (needs ffmpeg) or your own JPEG/PNG/WebP (up to 2 MB). |
| Captions | **WebVTT or SRT upload** per language (markup other than bold/italic/underline is stripped, up to 1 MB), shown as a CC menu in the player. **AI captions** (*Untertitel per KI erzeugen*) use the speech-to-text provider from *Einstellungen → KI-Anbieter* (capability *Spracherkennung*, the same engine as the voice features) and ffmpeg; they run in the background, are stored like an uploaded file (so you can download and correct them in any editor and upload again) and cost whatever your speech provider charges. |
| Lesson | In the lesson editor: *Gehostetes Video* (takes precedence over the *Video-Link*), *Kapitel* and *Lektion gilt als erledigt ab … % gesehen*. |

Deleting a video removes the file, poster, renditions and captions and unlinks it from lessons (they fall back to the *Video-Link*).

## The player

Native `<video>` controls plus what members expect from a course platform:

- **Resume** – the position is saved every ten seconds, on pause and when the page is left. The next visit shows *Weiter bei 12:40* with *Von vorn*. Per student and lesson.
- **Playback speed** 0.5× – 2×, remembered in the browser and per student.
- **Chapters** – a list under the video ("0:00 Einleitung"), the current one is highlighted, a click jumps there. Write them one per line, `0:00 Titel`, `1:02:30 Titel`; up to 60.
- **Captions** – the browser's own CC menu, German first if present.
- **Completion at X % watched** – counts only time actually played (seeking forward does not count; the server limits the growth of the watched time to what the elapsed time and speed allow). When the share is reached the lesson is marked done, exactly as if the member had clicked *Abschließen*. Quiz lessons and gates still apply.
- Accessible: 44 px targets, visible focus, labels, captions.

The player is a small same-origin script (`/portal-course.js`, no third-party code). The member pages stay script-free except where a page carries the player or the app helper; there the content security policy allows scripts from the page's own origin only.

## Discussion and reviews

**Under every lesson**, *Fragen & Diskussion*: members write comments and replies (threaded, at most three levels – deeper replies sit next to their parent), the course team answers with the badge **Kursleitung**, members can delete their own comments. Rate-limited, text only (no HTML), 2–2000 characters.

- **Team:** *Kurse → (Kurs) → Diskussion*: filters *Unbeantwortete Fragen* / *Alle* / *Ausgeblendet*, by lesson and text; reply, edit your own replies, hide or delete (with the replies below).
- **Notifications:** the team gets an in-app/push notification (topic *Kurse*, adjustable per person) and an e-mail to the sub-account's notification address – at most one mail per course per ten minutes. A member whose comment is answered gets a transactional e-mail.
- **Reviews:** a course page shows the average and the published reviews; members rate 1–5 stars with an optional title and text once they reached *Bewerten ab … % Fortschritt* (default 30 %). Moderation is on by default (*Bewertungen erst nach meiner Freigabe anzeigen*): *Kurse → (Kurs) → Bewertungen* lets you publish, reject, answer publicly or delete. One review per member and course; editing it sends it back to moderation if that is on.
- Both can be switched off per course (*Einstellungen & Zugang → Diskussion, Bewertungen, Cohorts*).

## Learning paths

**Kurse → Lernpfade**: a **bundle of courses in an order** ("Grundlagen → Aufbau → Praxis").

- **Access** by tag (default `pfad:<name>`, you can add others), by buying a product, from the *Teilnehmer* list or the API. Granting a path enrols the person in all its courses (access source *Lernpfad*); removing the path removes only the access that came from it. A course the person got separately (purchase, tag) is never touched or locked.
- **Unlock rule:** *Der Reihe nach* – the next course opens when the one before reached *N %* (default 100 = completed). Locked courses show what is missing ("Schließe zuerst den Kurs „B“ ab (40 % von 100 %)"). Free order is possible too.
- **Member dashboard:** a *Lernpfade* section with progress per path and the state of each step. Finishing the last course fires `course.path_completed`.
- Drafts are invisible to members; deleting a path keeps courses and access.

## Cohorts

**(Kurs) → Cohorts**: a group with a **start date** (and optional end and seat limit).

- **Cohort drip:** module and lesson drip ("nach N Tagen") counts from the cohort's start (midnight in the sub-account's time zone) instead of the day of enrolment. A cohort that has not started keeps even the first lesson closed and says when it opens; a cohort that started ten days ago opens week 1 right away.
- **Assignment:** by hand (*Teilnehmer* of the cohort, which also grants course access), or **automatically** (*Neue Teilnehmer automatisch dem nächsten offenen Cohort zuweisen*): the running or next upcoming cohort with free seats.
- **Community link:** choose a community group (and channel); the course page shows *Dein Cohort: …*, the start date and a button *Zum Cohort-Chat*.
- Everyone without a cohort keeps the normal drip.

## Analytics

**(Kurs) → Auswertung**, optionally for one cohort, as CSV too (`…/analytics.csv`, spreadsheet-formula safe):

- Participants, started, completed, completion rate, average progress, **watch time** (total and per person), reviews, comments.
- **Per lesson:** opened, completed, **drop-off** (share of those who opened the lesson before that did not open this one), average share of the video watched, watch minutes and a small **retention curve** (how far into the video people get). The biggest drop-off is called out.
- **Quiz results** per quiz: takers, attempts, average and best result, pass rate.
- The last twelve weeks of new participants and completions.

Playback figures come from members' players; they are sums for the course, not a record of who watched what second.

## Member app

The member area is installable like the community app (same approach: web manifest `start_url` = member home, icons from the white-label settings). Installed, it opens on the member home with the courses and the community; the manifest adds the shortcut *Meine Kurse* when published courses exist. No extra login, no extra keys.

## Create a course with AI

*Kurse → ✨ Mit KI erstellen*: enter the topic (under *Weitere Felder*: audience, number of modules 2–8 and lessons per module 1–6). The KI-Assistent writes an outline with lesson texts in Markdown (purpose `course_ai`, same key, budget and log); you see modules and lessons, can change the title and click **Kurs anlegen** – the course is created as a **draft** with **unpublished** lessons through the normal course routes, ready to edit, add videos and publish. API `POST /api/course-ai/outline` `{topic, audience?, modules?, lessons_per_module?}` (saves nothing), `POST /api/course-ai/create` `{outline}`; MCP `ghl_course_ai_outline`, `ghl_course_ai_create`. Module `server/modules/course-ai.ts`.

## Appointments in the portal

The customer portal has a **Meine Termine** link and, on its start page, the next appointment. `/portal/<id>/appointments` lists the member's upcoming appointments with **Verschieben oder absagen** (the existing manage page of the booking), the last ten past ones, and the sub-account's booking pages (active calendars) to book a new one. Members only ever see their own appointments. Module `server/modules/portal-appointments.ts` (portal hooks `portalHeader`, `portalDashboard`, `portalNextPrefixes`).

**Meine Dateien:** documents the team shares on a contact (*Im Portal freigeben*) show under `/portal/<id>/documents`; optionally customers upload files back (*Mitgliederbereich → Dateien im Portal*). See [sales.md](sales.md#files-in-the-customer-portal). Module `server/modules/portal-files.ts`.

## Automations

New workflow triggers (all with filters in the editor): **Kommentar in einer Lektion** (`course.comment_posted`, members only), **Kurs bewertet** (`course.review_posted`, with a minimum-stars filter), **Lernpfad freigeschaltet** (`course.path_enrolled`), **Lernpfad abgeschlossen** (`course.path_completed`) and **Cohort beigetreten** (`course.cohort_joined`). The existing course triggers and the action *Kurszugang geben* are unchanged.

## Settings and environment

| Variable | Default | What |
| --- | --- | --- |
| `PGHL_COURSE_VIDEO_MB` | `2048` | Largest video upload in MB. |
| `PGHL_COURSE_URL_TTL_MIN` | `360` | How long a member's video links stay valid (minutes, at least 5). They are issued again on every page load. |
| `PGHL_COURSE_HLS` | off | `1`: transcode every upload to HLS in the background (needs ffmpeg). |
| `PGHL_FFMPEG`, `PGHL_FFPROBE` | `ffmpeg`, `ffprobe` | Paths of the binaries. |
| `PGHL_COURSE_NO_FFMPEG` | off | `1`: behave as if ffmpeg were not installed. |

ffmpeg is **optional**. The Docker image of the server install can add it (`apt-get install ffmpeg`); the app notices on its own and the library says what is available. Disk: plan for the video size plus about 1.5× for HLS renditions.

Per course (*Einstellungen & Zugang*): discussion on/off, reviews on/off, moderation on/off, minimum progress to review, cohort assignment *aus / automatisch*.

## API

Team routes need the area *Kurse* (agency admins, members with the right, API keys).

| Area | Routes |
| --- | --- |
| Videos | `GET /api/courses/media/info` (`{ffmpeg, stt, max_mb, chunk_size, url_ttl_min, auto_hls}`), `GET/POST /api/courses/videos` (`{name, size}` → `{id, chunk_size}`), `PUT /api/courses/videos/:id/upload?offset=N` (raw body; `409 {received}` to resume), `GET/PATCH/DELETE /api/courses/videos/:id`, `GET …/file` (preview), `GET/POST …/poster` (`{at}` or `{data: "data:image/…"}`), `POST …/captions` (`{vtt, lang, label}`), `GET/DELETE …/captions/:cid`, `POST …/captions/ai` (`{language}`), `POST …/hls` |
| Lessons | `PATCH /api/courses/:id/lessons/:lid` also takes `video_id`, `chapters` (text or `[{t, title}]`) and `complete_percent` |
| Discussion | `GET/POST /api/courses/:id/comments` (`?status=hidden`, `?lesson_id=`, `?q=`, `?needs_reply=1`; POST `{lesson_id, parent_id?, body}`), `PATCH/DELETE …/comments/:cid` |
| Reviews | `GET /api/courses/:id/reviews` (`?status=pending|published|rejected`), `PATCH …/reviews/:rid` (`{status, reply}`), `DELETE …/reviews/:rid` |
| Paths | `GET/POST /api/courses/paths`, `GET/PATCH/DELETE …/paths/:pid` (`{title, description, status, sequential, unlock_percent, access: {tags, product_ids}, items: [courseId…]}`), `GET/POST …/paths/:pid/members` (`{contact_id}` or `{email, name}`), `DELETE …/members/:contactId` |
| Cohorts | `GET/POST /api/courses/:id/cohorts` (`{name, starts_at, ends_at?, capacity?, group_id?, channel_id?}`), `PATCH/DELETE …/cohorts/:cid`, `GET/POST …/cohorts/:cid/members`, `DELETE …/members/:contactId` |
| Analytics | `GET /api/courses/:id/analytics?cohort=`, `GET …/analytics.csv?cohort=` |

Member routes (portal, session cookie): `/portal/:p/media/:video/…` (signed), `POST /portal/:p/c/:course/:lesson/playback`, `…/comments`, `…/review`, and the helper scripts `/portal-course.js` and `/portal-pwa.js`.

## Data protection

- Videos are only reachable through the expiring, session-bound links described above; they are not indexed and not embeddable elsewhere.
- **Playback position and watched time** are stored per enrolment (needed for resume and completion). They are part of the *Auskunft* export of a contact and are deleted with the contact (*Löschen nach DSGVO*) or the enrolment.
- **Comments and reviews** carry the member's first name and the initial of the last name (shown to other members, e.g. *Anna M.*). Erasing a contact deletes their reviews and comments; a comment that others replied to stays as the neutral stub *[Kommentar gelöscht]* so the thread still reads, with no name and no link to the person.
- The video folder is part of the customer data export and of the erasure of a sub-account.
- Course analytics are sums over enrolments; no tracking beyond the player's own reports.

## Limits

- The *quiz* portal pages (`quiz-portal.ts`) still count their own unlock check from the enrolment date; for **members who joined a cohort late** a quiz lesson can open on the enrolment-based date. Lesson pages follow the cohort.
- **Copy to another sub-account and snapshots** carry lessons, text and downloads but not hosted videos (the files belong to their sub-account); link the video again there.
- HLS is played natively by Safari/iOS; other browsers use the MP4. There is no hls.js in the member area (no extra third-party script). Adaptive quality therefore matters mostly on iPhones and iPads.
- Captions are per video, not per lesson; AI captions are cut in one-minute pieces (long videos up to about four hours).
- No DRM and no download blocking beyond the browser setting (`nodownload`, expiring links): a determined member can record the screen.

## For developers

- Services: `course-media.ts` (pure: timestamps, chapters, VTT/SRT, playback maths, ffmpeg arguments), `course-video.ts` (files, tokens, upload, probe, poster, HLS, captions, playback rows), `course-player.ts` (player HTML/CSS/JS), `course-community.ts` (threads, ratings), `course-paths.ts` (path steps, cohort rules).
- Modules (registries, none of this lives in `portal.ts`/`courses.ts` beyond hooks): `course-video`, `course-discuss`, `course-paths` (paths and cohorts), `course-analytics`, `course-pwa`. Hooks on `app.services`: `lessonVideo`, `lessonCompleteBlock`, `lessonExtras`, `courseExtras`, `courseScripts`, `courseHead`, `lessonGates`, `portalDashboard`, `memberAppManifest`, `privacyErase`, `privacyExport`; `app.services.courseKit` exposes the portal's seat/unlock helpers.
- Tests: `course-media`, `course-video` (upload, resume, signing, ranges, captions, HLS, playback), `course-community`, `course-cohorts` (cohorts, analytics, app), `course-privacy`. `app.services.courseMediaRun` replaces ffmpeg in tests; `app.services.courseVideoJobs.flush()` waits for background jobs.
