**English** · [Deutsch](video-studio.de.md)

# Video studio (OpenShorts)

A long video (podcast, webinar, interview, livestream) becomes AI-picked 9:16 shorts with subtitles and hook text. In the sub-account under **Marketing → Video studio**: paste a link or upload a file, review and adjust the clips, then schedule them directly in the **Social Planner** (Postiz) on this sub-account's channels.

[OpenShorts](https://github.com/mutonby/openshorts) (MIT) does the cutting: Whisper transcription, Gemini (or an LLM of your own) finds the moments, face tracking and layouts for 9:16, burned-in subtitles. HyperLevel contains no OpenShorts code but talks to its REST API – with a **self-hosted instance** next to HyperLevel or the **hosted API** of openshorts.app.

## Setup

### A) Self-hosted next to HyperLevel

The easiest way is the profile in HyperLevel's [`docker-compose.yml`](../docker-compose.yml) – same network, nothing more to enter: `docker compose --profile openshorts up -d` (variables `GEMINI_API_KEY`, `OPENSHORTS_CPUS` … in `.env`). Alternatively as a Compose project of its own – the template is in [`deploy/openshorts/docker-compose.yml`](../deploy/openshorts/docker-compose.yml) and nothing starts it automatically:

```bash
cd deploy/openshorts
cp .env.example .env        # enter GEMINI_API_KEY or LLM_BASE_URL, check GOHIGH_NETWORK
docker network ls           # HyperLevel's network, e.g. gohigh_default
docker compose up -d --build
```

- **CPU image**, one job at a time (`MAX_CONCURRENT_JOBS=1`), hard limits (default 3 CPUs, 6 GB RAM) and lower CPU priority than the CRM – a long video does not slow HyperLevel down.
- **No open port:** self-hosted OpenShorts has no sign-in. It sits only in HyperLevel's Docker network and is reachable there as `http://openshorts:8000`.
- **Duration:** about 5–8 minutes per 8 minutes of video on the CPU (about 1 minute with an NVIDIA GPU, see the OpenShorts README).
- **Storage:** image about 4 GB, models about 1 GB (volume `openshorts-models`), per hour of 1080p source about 1–2 GB plus 20–60 MB per clip. `OUTPUT_MAX_GB`/`UPLOADS_MAX_GB` limit the working folders; old jobs are removed first.
- **Retention:** HyperLevel stores no videos but streams the clips from OpenShorts. The template keeps jobs for 7 days (`JOB_RETENTION_SECONDS=604800`, the OpenShorts default is 24 hours). Scheduled posts are safe: Postiz fetches the video when it is scheduled.
- **Server:** together with HyperLevel at least 4 CPU cores and 8 GB RAM.

OpenShorts environment (`.env`):

| Variable | What for |
| --- | --- |
| `GEMINI_API_KEY` | Finds the moments (free at [Google AI Studio](https://aistudio.google.com/app/apikey)); also automatic layout, silent videos, YouTube Studio and AI shorts |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | An OpenAI-compatible server (Ollama, vLLM, OpenRouter …) instead of Gemini. Anthropic also offers an OpenAI-compatible interface: `LLM_BASE_URL=https://api.anthropic.com/v1`, `LLM_MODEL=claude-haiku-4-5`, `LLM_API_KEY=sk-ant-…`. Automatic layout and silent videos still need Gemini |
| `WHISPER_MODEL` | Transcription on the CPU: `base` (fast), `small` (default), `medium` (more accurate, slow) |
| `OPENSHORTS_CPUS`, `OPENSHORTS_MEMORY` | Resource limits of the container |
| `JOB_RETENTION_SECONDS`, `OUTPUT_MAX_GB`, `UPLOADS_MAX_GB` | Retention and disk limits |
| `YOUTUBE_COOKIES` | Optional, if YouTube blocks the server's downloads |

**Not needed:** an Upload-Post key – HyperLevel publishes through its own Social Planner (Postiz).

### B) Hosted at openshorts.app

Create an account at [openshorts.app](https://www.openshorts.app/) and generate a key (`osk_…`) under *Account → API keys*. In HyperLevel, enter `https://api.openshorts.app` as the address, plus the key. Gemini is included there, the GPU cuts an 8-minute video in about a minute; the free plan has 20 minutes per month and a watermark, paid plans do not.

### Connecting in HyperLevel

**Agency → Integrations → Setup → OpenShorts (Video studio):**

| Field | Contents |
| --- | --- |
| Address | Self-hosted `http://openshorts:8000` (the backend, not the dashboard on port 5175) · hosted `https://api.openshorts.app` |
| API key | Hosted only: `osk_…` |
| ElevenLabs key (optional) | AI dubbing into other languages, voices for AI shorts |
| fal.ai key (optional) | AI shorts (actors, lip-sync video, B-roll) |
| Max. file size, running jobs per sub-account | Default 2048 MB (OpenShorts' limit) and 3 |

“Save & test” checks `/health`, detects self-hosted or hosted (`/api/config`), checks the key (`/api/me`, shows the plan and remaining minutes) and reads from `/openapi.json` what the instance can do (uploads, YouTube Studio, AI shorts, dubbing …). If something is missing, the video studio hides that part. All keys are stored encrypted in HyperLevel and never go to the browser. Alternatively via environment: `PGHL_OPENSHORTS_URL`, `PGHL_OPENSHORTS_KEY`.

**Where which key belongs:** Gemini or `LLM_*` go in OpenShorts' environment (self-hosted; Gemini is included when hosted). OpenShorts accepts ElevenLabs and fal.ai only per request as a header – on openshorts.app too (“BYOK” there) –, so you enter them in HyperLevel; HyperLevel sends them along only for dubbing and AI shorts.

| | Self-hosted | openshorts.app |
| --- | --- | --- |
| Sign-in | none – run it only in the internal network | `Authorization: Bearer osk_…` |
| Gemini | own key or `LLM_BASE_URL` in OpenShorts | included |
| ElevenLabs, fal.ai | in HyperLevel (per request) | in HyperLevel (per request) |
| Speed | 5–8 min per 8 min of video (CPU) | about 1 min (GPU) |
| Limits | none | minutes per plan, watermark on the free plan |
| Progress | detailed log → fine progress bar | shortened log → coarser steps |

## In the sub-account

**Marketing → Video studio** (permission “Social Planner”; in SaaS mode only with plans that include the Social Planner).

1. **New shorts:** YouTube link / direct MP4 address or file (MP4, MOV, WebM, MKV, AVI). Files go to HyperLevel in 8 MB parts (robust behind proxies, never held completely in memory) and are then streamed from disk into OpenShorts' upload slot; the intermediate file is deleted afterwards. For older OpenShorts versions without an upload slot, HyperLevel hands over a short-lived, signed download link instead.
2. **Options:**

| Option | Effect in OpenShorts |
| --- | --- |
| Number of clips | `target_clips` (1–15; a target, not a guarantee) |
| Clip length | `clip_min_seconds`/`clip_max_seconds` (default 15–60 s) |
| Layout | Automatic → `layouts: ["auto"]` (AI chooses per video) · Track face → `["none"]` · Two speakers → `["split"]` · Screen + speaker → `["screencast"]` · Full frame → afterwards per clip `framing: "full"` |
| Subtitles | Default → burned in while rendering · other styles (word by word, purple/green box, one word, subtle) → afterwards per clip `POST /api/subtitle` with `preset` · None → `captions: false` |
| Hook text, hook style | `auto_hook`, `auto_hook_style` |
| Format | `output_format` (portrait, square, landscape) |
| AI dubbing | afterwards per clip `POST /api/translate` (ElevenLabs), then subtitles on the dubbed audio |
| Language | OpenShorts detects it itself (Whisper); titles and texts come in the language of the video |

3. **Progress:** Each job gets a webhook address of its own, `https://<domain>/hooks/openshorts/<secret>`, with its own signing key (`X-OpenShorts-Signature: sha256=…`, HMAC-SHA256 over the body). In addition, HyperLevel polls every 20 s (every 60 s with a webhook) – without a public https address, by polling only. Finished clips appear while cutting is still going on. If a YouTube source has only a low resolution, the studio asks (“Process anyway”).
4. **Review:** a gallery with a player (clips are passed through from OpenShorts with range requests), virality score 0–100 with a reason, AI title, description and hashtags to edit, download, remove. **Post-editing:** subtitle style, dubbing, framing (full frame / track person) – runs in the background in OpenShorts, and the clip is replaced afterwards.
5. **Schedule in the Social Planner:** this sub-account's channels (YouTube Shorts and TikTok too, which otherwise only go through Postiz), schedule / now / draft, text pre-filled with description and hashtags, YouTube title. Postiz fetches the video directly from HyperLevel through a signed link (valid for 2 hours) – HyperLevel has to be reachable via https for this.
6. **Save as a document in the project:** creates an entry under *Project → Documents* with a link to the clip, description, hashtags and score.

### YouTube Studio (optional)

For a long video: analysis (download + transcription in OpenShorts), 10 title ideas with a recommendation and refining on request (“shorter, with a number”), a description with chapter marks, AI thumbnails (Gemini image model) to download. It appears only if the instance has the endpoints; analysis and thumbnails need Gemini.

### AI shorts (optional)

From a product link or description, OpenShorts writes scripts (hook – problem – solution – CTA, currently English or Spanish) and creates a video with an AI actor, voice, B-roll and subtitles at the push of a button (cheap about $0.65, premium about $2 at fal.ai). The finished video lands as a job with one clip in the normal list – same review and scheduling. Scripts need Gemini, the video additionally fal.ai and ElevenLabs keys. Publishing to the public OpenShorts gallery is always off (`share_to_gallery: false`).

## Content recycling & autopilot

### Recycling: “Make this video into …”

Besides **Clips**, every finished job has the **Recycling** tab. The AI assistant (Settings → AI assistant; every piece of content is an AI call and counts toward the sub-account's monthly limit) writes from the OpenShorts transcript and the best clips:

| Content | When you click **Apply** it becomes … |
| --- | --- |
| Blog post (title, short description, Markdown with `##` sections, SEO title/description, tags) | … a **draft** in the blog of the chosen website. The video sits after the introduction: for YouTube sources the YouTube video, otherwise the best clip; cover image = YouTube thumbnail. |
| Newsletter (subject, preview text, introduction, 3 key points, button) | … a **campaign draft** in the e-mail designer: “Hallo {{contact.first_name\|du}},”, video block, key points, the best clips (with a thumbnail as soon as the browser has captured one) and footer – who gets it and when is up to you in the campaign. |
| LinkedIn post, X thread, Instagram caption, Facebook post | … a **draft in the Social Planner** on the matching channels of the sub-account (approve it in Postiz). The X thread goes out as a thread (replies), Instagram gets the best clip as a Reel. |
| YouTube description with chapters + 10 title ideas | … an entry in the **YouTube Studio** tab (choose a title, copy the description). |
| Podcast show notes (summary, chapters, key points, quotes) | … a document under *Project → Documents* (needs an https address of HyperLevel); otherwise copy. |
| Community post | … **published** in the chosen group (with a confirmation prompt – the community has no drafts). |
| Lesson teaser (only with course lessons) | … in the chosen lesson: the best clip becomes the lesson video (or sits above the text if there already is one), the teaser before it. |

Each piece of content can be edited, copied, regenerated or removed beforehand; until you click, it remains a suggestion. Clips that are linked in a blog, newsletter or lesson are copied once to HyperLevel's own disk (`data/video-studio/public/`) and served under a permanent, signed link `/hooks/openshorts/clip/<id>.<signature>.mp4` – they stay when OpenShorts deletes the job after its retention time, and go only with the job in HyperLevel. The browser captures thumbnails while you watch the clips (`/hooks/openshorts/thumb/…`).

The transcript comes from `GET /api/clip/{job_id}/{index}/edl` (word list of the whole video); if that is missing, HyperLevel assembles it from the clips' `GET /api/clip/{job_id}/{index}/transcript`. It is stored once per job. If the AI assistant is off, has no key or the limit is reached, the tab says so and generates nothing; if the limit is hit in the middle of a run, the remaining content stops immediately (no further costs).

### Autopilot

**Autopilot** tab in the video studio, per sub-account:

- **Sources** (up to 5): a YouTube channel (channel ID `UC…` or `youtube.com/channel/UC…`; HyperLevel reads `https://www.youtube.com/feeds/videos.xml?channel_id=…`) or a podcast RSS feed with video episodes or YouTube links. Pure audio episodes are skipped (OpenShorts needs picture). Fetched every 10 minutes through the hardened fetch (no internal addresses, size and time limit); on the first fetch the autopilot remembers the existing videos, and only new ones are processed. At most *n* videos per day (default 3).
- For every new video a shorts job starts (origin “Autopilot”, its own options for clips, subtitles, layout). When it is finished:
  - the **best N clips** (by score) go to the chosen channels with video, spread across the next free **time slots** (times × weekdays in the sub-account's time zone; the next video continues after the last slot). Channels whose character limit the caption exceeds (X: 280) are left out by the autopilot for that clip.
  - the **recycling set** is generated; newsletter and social texts are taken over as drafts, the blog post into the chosen website. YouTube, show notes, community and lesson wait in the Recycling tab.
  - the team gets a **push notification** and/or **e-mail** to the company address with a summary and notes.
- **Drafts for approval** (default): everything lands as a draft in the Social Planner. **Schedule automatically** (turn on explicitly): clips and social texts are scheduled into the time slots without approval. Blog and newsletter always stay drafts.
- “Check now” fetches the sources immediately; the **log** shows what happened.

### Workflows, MCP, reports

- **Action “Recycle video”** (`video_recycle`): `job_id` (default `{{event.jobId}}` – fits right after “Shorts ready”) or a video link (shorts first, then recycling), choice of content. The result waits in the Recycling tab.
- **MCP `ghl_recycle_video`:** `job_id` or `url`, `kinds`, `language`; `list: true` shows the state with texts.
- **Report “Video studio: recycled content”:** kind, status, applied yes/no, edited, started via (manual, workflow, MCP, autopilot), adoption rate.

## Automations, MCP, reports

- **Trigger “Shorts ready (Video Studio)”** (`shorts.ready`): data `jobId`, `title`, `clips`, `bestClipId`, `bestClipTitle`, `bestScore`, `url`. Workflows start for the job's contact – jobs from the action below or with `contact_id` (API/MCP); REST hooks and webhooks always receive the event.
- **Action “Create shorts from video”** (`shorts_create`): video link with placeholders (e.g. `{{contact.custom.video_url}}`), title, number of clips, layout, subtitles, hook. The job belongs to the workflow's contact.
- **MCP:** `ghl_create_shorts` (job from a link), `ghl_list_shorts_jobs` (jobs; with `job_id` the clips including score), `ghl_schedule_clip` (schedule a clip on channels, default draft).
- **Reports:** sources “Video studio: jobs” (status, source, clips, duration, success rate, contact), “Video studio: clips” (score, length, scheduled, edited) and “Video studio: published clips” (date, kind, channels).

## API (HyperLevel)

| Endpoint | |
| --- | --- |
| `GET/PATCH /api/agency/video-studio`, `POST /api/agency/video-studio/test` | Connection (admins only; key masked) |
| `GET /api/video-studio` | Status, features, options for the interface |
| `GET/POST /api/video-studio/jobs`, `GET/DELETE /api/video-studio/jobs/:id` | Jobs (`{url \| upload_id, title, contact_id, options: {clips, layout, subtitles, hook, hook_style, dub_language, format}}`) |
| `POST /api/video-studio/jobs/:id/refresh`, `…/confirm` | Fetch status immediately, confirm low resolution |
| `POST /api/video-studio/uploads`, `PUT /api/video-studio/uploads/:id?offset=N`, `DELETE …` | Upload in parts (raw data, max. 8 MB per part) |
| `GET /api/video-studio/clips/:id/video[?download=1]` | Stream a clip (Range) / download |
| `PATCH/DELETE /api/video-studio/clips/:id`, `POST …/edit` | Change texts, remove, post-editing (`{op: subtitles\|dub\|framing}`) |
| `POST /api/video-studio/clips/:id/schedule`, `POST …/doc` | Schedule (`{integration_ids, type, date, caption, title}`), save as a document |
| `GET /api/video-studio/tasks`, `POST /api/video-studio/youtube…`, `POST /api/video-studio/ugc…` | YouTube Studio and AI shorts |
| `GET/POST /api/video-studio/jobs/:id/recycle` | Recycling: state, targets (websites, groups, lessons, channels) / generate (`{kinds, language}`) |
| `POST /api/video-studio/recycle` | Link instead of a job: start shorts, then recycle (`{url, kinds}`) |
| `PATCH/DELETE /api/video-studio/recycle/:id`, `POST …/apply` | Change content (`{content}`), remove, apply (`{funnel_id, embed}` · `{integration_ids}` · `{group_id}` · `{course_id, lesson_id}`) |
| `GET/PUT /api/video-studio/autopilot`, `POST …/autopilot/check` | Autopilot settings and log, check immediately |
| `POST /api/video-studio/clips/:id/thumb` | Thumbnail (JPEG as a data: URL, max. 600 KB) |
| `POST /hooks/openshorts/:secret` | Webhook from OpenShorts (signed) |
| `GET /hooks/openshorts/media/:token`, `GET /hooks/openshorts/source/:token` | Signed, short-lived links for Postiz and OpenShorts respectively |
| `GET /hooks/openshorts/clip/:token`, `GET /hooks/openshorts/thumb/:token` | Permanent, signed links to HyperLevel's copy of a clip / thumbnail (blog, newsletter, lesson) |

### OpenShorts endpoints used

`GET /health`, `GET /api/config`, `GET /api/me` (hosted), `GET /openapi.json`, `GET /api/translate/languages` · `POST /api/uploads` + `PUT /api/uploads/{upload_id}` · `POST /api/process` (`url` or `upload_id`, `acknowledged`, `layouts`, `output_format`, `target_clips`, `captions`, `auto_hook`, `auto_hook_style`, `webhook_url`, `webhook_secret`, `force_low_quality`) · `GET /api/status/{job_id}` · `GET /api/clip/{job_id}/{index}/edl` and `…/transcript` (recycling) · `GET /videos/{job_id}/{file}` (with `Range`) · `POST /api/subtitle`, `POST /api/translate` (`X-ElevenLabs-Key`), `POST /api/clip/rerender` · `POST /api/thumbnail/upload|analyze|titles|describe|generate`, `GET /thumbnails/…` · `POST /api/saasshorts/analyze|generate` (`X-Fal-Key`, `X-ElevenLabs-Key`), `GET /api/saasshorts/status/{job_id}`, `GET /api/saasshorts/voices`. Webhook from OpenShorts: once per job at the end, `{"event": "job.completed"|"job.failed", "job_id", "status", "clips": [{index, title, video_url}], "error"?}`, three attempts (immediately, after 10 s, after 60 s).

## Security

- Webhooks: a secret address of its own and an HMAC key of its own per job, constant-time comparison, a wrong job ID is rejected; the status afterwards always comes from OpenShorts itself.
- Proxy only for `/videos/…` and `/thumbnails/…` of the configured instance (no `..`, only media extensions); public links only signed and time-limited.
- Uploads: video files only (file extension + signature of the first bytes), size and space check, at most 3 open uploads per sub-account.
- Self-hosted OpenShorts has no sign-in: never expose it publicly (the template publishes no port).
- Recycling applies content through the normal routes of blog, campaigns, Social Planner, community and courses – with the permissions of the person who clicks. The autopilot acts as the person who set it up (otherwise the first admin); the log says “Autopilot (Video studio)”. Feeds are loaded only through the hardened fetch; permanent clip links are HMAC-signed (without a signature: 404).

## Limits

- OpenShorts has no cancel endpoint: “Delete” removes the job in HyperLevel; OpenShorts cleans up after its retention time.
- After the retention time has passed, the player shows “no longer available” – schedule or download in time.
- OpenShorts keeps YouTube Studio sessions and AI shorts jobs only in memory; start them again after an OpenShorts restart.
- HyperLevel reads the clip index for post-editing from the file name (`…_clip_N.mp4`), the way OpenShorts assigns it.
- Recycling texts are produced from the transcript – check the facts before applying. For the transcript, the job must still exist in OpenShorts (retention); after that HyperLevel uses the stored one.
- YouTube @handles cannot be translated into a feed – give the channel ID.
