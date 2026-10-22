import { randomBytes } from 'node:crypto';
import type { App } from '../core/app.js';
import type { RawResult } from '../core/http.js';
import { jsonForScript, noscriptNotice, publicPage } from '../core/page.js';
import { escapeHtml as esc } from '../core/template.js';
import { SCRIPTED_LABEL } from './webinar-model.js';
import { bookable } from './webinar-register.js';
import { ROOM_CSS, ROOM_SCRIPT } from './webinar-room-client.js';
import { formatInTz } from '../core/time.js';
import { clockFor, conversationOf, offerDeadline, offerTarget, pollCounts, replayWindow } from './webinar-track.js';
import { linksOf, pageUrl, webinarTz, type Registration, type Webinar } from './webinar-store.js';
import { embedOrigin, playbackOf } from './webinar-video.js';

/**
 * The public pages of a webinar, as plain HTML with one inline script each (CSP nonce): the registration page (also as an
 * embed for funnel pages) and the room. Everything dynamic is escaped; the room reads its data from a JSON block.
 */

export const nonce = () => randomBytes(16).toString('base64url');

const headers = (csp: string): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  // The page shows personal data or leads to it: never stored by caches, never indexed, no referrer to the video hosts.
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': csp,
});
const page = (status: number, body: string, csp: string): RawResult => ({ __raw: true, status, headers: headers(csp), body });

/** A small page with a message (invalid link, not published, expired …). */
/** "1 Minute", "45 Minuten" (at least one minute). */
const minutesText = (sec: number) => {
  const m = Math.max(1, Math.round(sec / 60));
  return `${m} ${m === 1 ? 'Minute' : 'Minuten'}`;
};

export function noticePage(app: App, title: string, text: string, status = 200, link?: { href: string; label: string }): RawResult {
  const body = `<div class="wrap"><div class="card"><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p>${link ? `<p><a class="btn" href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}</div></div>`;
  return page(status, publicPage({ title, body }), "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
}

const paragraphs = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

const REG_CSS = `
.wb .pill{display:inline-block;background:color-mix(in srgb,var(--brand) 12%,#fff);border:1px solid color-mix(in srgb,var(--brand) 45%,#fff);color:#111827;border-radius:99px;padding:2px 12px;font-size:13px;font-weight:600}
.wb h1{margin:10px 0 6px}
.wb .presenter{display:flex;align-items:center;gap:12px;margin:10px 0 14px}.wb .presenter img{width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid var(--line)}
.wb fieldset{border:0;padding:0;margin:18px 0 6px}.wb legend{font-weight:700;margin-bottom:6px;padding:0}
.wb .sess{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:6px 0;cursor:pointer;font-weight:500;background:#fff}
.wb .sess input{width:auto;margin:0}.wb .sess:has(input:checked){border-color:var(--brand);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 25%,transparent)}
.wb .sess.full{opacity:.55;cursor:not-allowed}.wb .sess small{color:var(--muted);margin-left:auto;white-space:nowrap}
.wb .note{font-size:13px;color:var(--muted);margin-top:8px}
.wb .done h2{margin-top:0}.wb .done .btn{margin:4px 8px 0 0}
`;

/** The registration page: honest label, sessions in the viewer's time zone, form with consent. */
export function registrationPage(app: App, w: Webinar, opts: { embed: boolean; attr?: string }): RawResult {
  const n = nonce();
  const loc = app.location(w.location_id);
  const reg = w.settings.registration;
  const sessions = bookable(app, w);
  const tz = webinarTz(app, w);
  const anySms = w.settings.reminders.items.some((r) => r.sms);
  const when = (iso: string) => formatInTz(iso, tz, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const list = sessions.length
    ? sessions
        .map((s, i) => {
          const first = i === sessions.findIndex((x) => !x.full);
          return s.kind === 'ondemand'
            ? `<label class="sess${s.full ? ' full' : ''}"><input type="radio" name="session" value="ondemand"${first ? ' checked' : ''}> <span>Jetzt starten – du kommst sofort in den Webinar-Raum</span></label>`
            : `<label class="sess${s.full ? ' full' : ''}"><input type="radio" name="session" value="${esc(s.start)}"${s.full ? ' disabled' : first ? ' checked' : ''}> <span><time datetime="${esc(s.start)}">${esc(when(s.start))}</time></span>${s.full ? '<small>ausgebucht</small>' : w.schedule.max_per_session > 0 ? `<small>noch ${w.schedule.max_per_session - s.taken} Plätze</small>` : ''}</label>`;
        })
        .join('')
    : '<p class="muted">Zurzeit ist kein Termin buchbar. Schau bald wieder vorbei.</p>';
  const body = `<div class="wrap"><div class="card wb">
  <span class="pill">${esc(w.settings.room.label)}</span>
  <h1>${esc(reg.headline || w.title)}</h1>
  ${reg.headline ? `<p class="muted" style="margin:0 0 6px"><strong>${esc(w.title)}</strong></p>` : ''}
  ${w.presenter_name || w.presenter_photo ? `<div class="presenter">${w.presenter_photo ? `<img src="${esc(w.presenter_photo)}" alt="">` : ''}${w.presenter_name ? `<div><div class="muted" style="font-size:13px">mit</div><strong>${esc(w.presenter_name)}</strong></div>` : ''}</div>` : ''}
  ${w.description ? paragraphs(w.description) : ''}
  <p class="muted" style="font-size:14px">Dauer: ca. ${minutesText(w.duration_s)} · ${esc(w.settings.room.label)}: Das Video wird zum gewählten Termin abgespielt.</p>
  ${sessions.length ? noscriptNotice('dich anzumelden') : ''}
  <form id="wf" novalidate${sessions.length ? '' : ' hidden'}>
    <fieldset><legend>Termin wählen</legend>${list}<p class="note" id="tzn">Die Zeiten siehst du in deiner Zeitzone.</p></fieldset>
    <div class="row"><div><label for="fn">Vorname *</label><input id="fn" name="first_name" required autocomplete="given-name"></div><div><label for="ln">Nachname</label><input id="ln" name="last_name" autocomplete="family-name"></div></div>
    <label for="em">E-Mail *</label><input id="em" name="email" type="email" required autocomplete="email">
    ${reg.ask_phone ? `<label for="ph">Telefon${reg.phone_required ? ' *' : ''}</label><input id="ph" name="phone" type="tel" autocomplete="tel"${reg.phone_required ? ' required' : ''}>` : ''}
    ${anySms && reg.ask_phone ? `<label class="check" id="smsrow" hidden><input type="checkbox" name="sms_consent" id="sms"> ${esc(reg.sms_consent_text)}</label>` : ''}
    <label class="check" style="margin-top:14px"><input type="checkbox" name="consent" id="co" required> <span>${esc(reg.consent_text)}</span></label>
    <input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <div style="margin-top:16px"><button type="submit" id="go">${esc(reg.button_text)}</button></div>
    <div class="error" id="er" role="alert"></div>
  </form>
  <div class="ok done" id="ok" hidden></div>
</div></div>`;
  const cfg = { slug: w.slug, title: w.title, duration_min: Math.max(1, Math.round(w.duration_s / 60)), page: pageUrl(app, w), thanks: reg.thanks_text, redirect: reg.redirect_url, embed: opts.embed, attr: opts.attr ?? '' };
  const script = String.raw`(function(){
var C=JSON.parse(document.getElementById('wb-cfg').textContent),$=function(i){return document.getElementById(i)};
var tz='';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}
var fmt=new Intl.DateTimeFormat('de-DE',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
[].forEach.call(document.querySelectorAll('time[datetime]'),function(t){var d=new Date(t.getAttribute('datetime'));if(!isNaN(d))t.textContent=fmt.format(d)});
if($('tzn')&&tz)$('tzn').textContent='Die Zeiten siehst du in deiner Zeitzone ('+tz.replace('_',' ')+').';
var f=$('wf');if(!f)return;
var ph=$('ph'),sr=$('smsrow');if(ph&&sr)ph.addEventListener('input',function(){sr.hidden=!ph.value.trim()});
function ics(d,min){var z=function(x){return x.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')},e=function(s){return s.replace(/([,;\\])/g,'\\$1')};return['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//HyperLevel//Webinar//DE','BEGIN:VEVENT','UID:'+z(d)+'-'+C.slug+'@webinar','DTSTAMP:'+z(new Date()),'DTSTART:'+z(d),'DTEND:'+z(new Date(d.getTime()+min*60000)),'SUMMARY:'+e(C.title),'DESCRIPTION:'+e('Automatisiertes Webinar. Deinen persönlichen Link bekommst du per E-Mail. '+C.page),'URL:'+C.page,'END:VEVENT','END:VCALENDAR'].join('\r\n')}
f.addEventListener('submit',function(ev){ev.preventDefault();var er=$('er');er.textContent='';
var s=f.querySelector('input[name=session]:checked');if(!s){er.textContent='Bitte einen Termin wählen.';return}
if(!f.checkValidity()){f.reportValidity();return}
var b=$('go');b.disabled=true;var fd=new FormData(f),body={session:s.value,tz:tz,first_name:fd.get('first_name'),last_name:fd.get('last_name'),email:fd.get('email'),phone:fd.get('phone')||'',consent:!!fd.get('consent'),sms_consent:!!fd.get('sms_consent'),_hp:fd.get('_hp')||''};
var q=new URLSearchParams(location.search);['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','ref'].forEach(function(k){if(q.get(k))body['_'+k]=q.get(k)});
if(C.attr)body._a=C.attr;if(q.get('_a')&&!body._a)body._a=q.get('_a');body._page=(window.top===window?location.href:document.referrer)||'';
fetch('/api/public/webinars/'+encodeURIComponent(C.slug)+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Fehler');return j})}).then(function(j){
if(j.join_url){(window.top||window).location.href=j.join_url;return}
if(C.redirect){(window.top||window).location.href=C.redirect;return}
f.hidden=true;var ok=$('ok');ok.hidden=false;ok.textContent='';var h=document.createElement('h2');h.textContent='Du bist angemeldet';ok.appendChild(h);
var p=document.createElement('p');p.textContent=C.thanks;ok.appendChild(p);
var d=new Date(j.session.start);if(!isNaN(d)){var p2=document.createElement('p'),st=document.createElement('strong');st.textContent=fmt.format(d);p2.appendChild(st);ok.appendChild(p2);
var a=document.createElement('a');a.className='btn secondary';a.textContent='Zum Kalender hinzufügen';a.download='webinar.ics';a.href=URL.createObjectURL(new Blob([ics(d,C.duration_min)],{type:'text/calendar'}));ok.appendChild(a)}
}).catch(function(e){er.textContent=e.message;b.disabled=false})});
if(C.embed)new ResizeObserver(function(){parent.postMessage({pghlHeight:document.documentElement.scrollHeight},'*')}).observe(document.body);
})();`;
  const html = publicPage({
    title: `${w.title}${loc ? ` – ${loc.name}` : ''}`,
    body: `${body}<script type="application/json" id="wb-cfg">${jsonForScript(cfg)}</script><script nonce="${n}">${script}</script>`,
    head: `<meta name="robots" content="noindex"><style>${REG_CSS}</style>`,
    color: loc?.settings?.branding?.color || undefined,
    embed: opts.embed,
    description: w.description.slice(0, 160),
  });
  // Frames: only embedded copies (a funnel page, a website) may be shown inside another page.
  const csp = `default-src 'none'; script-src 'nonce-${n}'; style-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${opts.embed ? '*' : "'self'"}`;
  return page(200, html, csp);
}

// --- the room -------------------------------------------------------------------------------------

export type RoomMode = 'live' | 'replay' | 'preview';

/** Everything the room's script needs, for one registration (or the team's preview). */
export function roomConfig(app: App, w: Webinar, reg: Registration | undefined, mode: RoomMode, at: Date, opts: { token?: string; previewOffset?: number } = {}) {
  const token = opts.token ?? '';
  const slug = encodeURIComponent(w.slug);
  const base = `/api/public/webinars/${slug}`;
  const links = reg ? linksOf(app, w, reg.id) : undefined;
  const startIso = mode === 'preview' ? new Date(at.getTime() - (opts.previewOffset ?? 0) * 1000).toISOString() : reg!.session_start;
  const startMs = Date.parse(startIso);
  const c = mode === 'preview' ? { state: 'running' as const, starts_in_s: 0, offset_s: opts.previewOffset ?? 0, ends_in_s: Math.max(0, w.duration_s - (opts.previewOffset ?? 0)) } : clockFor(w, reg!, at);
  const mediaUrl = `/w/${slug}/media?${mode === 'preview' ? `p=${encodeURIComponent(token)}` : `t=${encodeURIComponent(token)}`}`;
  const playback = playbackOf(w.video, { mediaUrl });
  const o = w.settings.offer;
  const deadline = reg && mode !== 'preview' ? offerDeadline(w, reg) : o.countdown_s > 0 ? startMs + (o.at_s + o.countdown_s) * 1000 : null;
  const contactEmail = reg ? (app.db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ? AND location_id = ?', reg.contact_id, w.location_id)?.email ?? '') : '';
  const target = offerTarget(app, w, contactEmail);
  const replay = reg ? replayWindow(w, reg, at) : { available: false as boolean, reason: 'disabled' as string | undefined };
  const convo = reg && mode !== 'preview' ? conversationOf(app, w, reg) : { questions: [], answers: [] };
  const votes = (id: string) => (reg && mode !== 'preview' ? pollCounts(app, w, id, reg.id) : { counts: [] as number[], mine: [] as number[] });
  return {
    slug: w.slug,
    token,
    mode,
    server_now: at.getTime(),
    start: startIso,
    duration_s: w.duration_s,
    clock: c,
    title: w.title,
    label: mode === 'replay' ? w.settings.room.replay_label : w.settings.room.label,
    presenter: { name: w.presenter_name, photo: w.presenter_photo },
    texts: { waiting: w.settings.room.waiting_text, ended: w.settings.room.ended_text },
    playback,
    resume_s: mode === 'replay' && reg && reg.replay_pos_s > 5 && reg.replay_pos_s < w.duration_s - 15 ? Math.floor(reg.replay_pos_s) : 0,
    features: { counter: w.settings.room.show_counter, questions: w.settings.room.questions, scripted: w.settings.room.scripted_enabled },
    scripted_label: SCRIPTED_LABEL,
    scripted: w.settings.room.scripted_enabled ? w.settings.room.scripted : [],
    polls: w.settings.room.polls.map((p) => {
      const v = votes(p.id);
      return { ...p, mine: v.mine, counts: p.show_results && v.mine.length ? v.counts : null };
    }),
    offer: { enabled: o.enabled && !!target, at_s: o.at_s, title: o.title, text: o.text, button_text: o.button_text, deadline_ms: deadline, replay_ok: o.show_in_replay, ...(mode === 'preview' && target ? { preview_url: target } : {}) },
    replay: { available: replay.available, reason: replay.reason, until: (replay as { until?: string }).until, url: links?.replay_url ?? '' },
    conversation: convo,
    urls: { ping: `${base}/ping`, question: `${base}/question`, vote: `${base}/vote`, go: `/w/${slug}/go?t=${encodeURIComponent(token)}`, ics: links?.ics_url ?? '' },
  };
}

/** The room as a page. `hls` = whether the optional hls.js file is installed (it needs `connect-src` to the stream's host). */
export function roomPage(app: App, w: Webinar, cfg: ReturnType<typeof roomConfig>, hls: boolean): RawResult {
  const n = nonce();
  const replayMode = cfg.mode === 'replay';
  const b = cfg.presenter;
  const body = `<header class="rb"><span class="pill">${esc(cfg.label)}</span><span class="title">${esc(w.title)}</span><span id="counter" hidden></span></header>
<div class="room-main">
<section>
 <div id="stage">
  <div class="badge">${esc(cfg.label)}</div>
  <noscript><div class="view center"><h2>Bitte JavaScript einschalten</h2><p class="muted">Ohne JavaScript lässt sich das Webinar nicht abspielen.</p></div></noscript>
  <div id="v-waiting" class="view center" hidden>
   ${b.name || b.photo ? `<div class="presenter">${b.photo ? `<img src="${esc(b.photo)}" alt="">` : ''}${b.name ? `<div><div class="hint">mit</div><strong>${esc(b.name)}</strong></div>` : ''}</div>` : ''}
   <h2>Das Webinar startet in</h2><div id="count" aria-live="off">–</div>
   <p class="muted">${esc(cfg.texts.waiting)}</p>
   ${cfg.urls.ics && cfg.mode !== 'preview' ? `<a class="btn small ctl" href="${esc(cfg.urls.ics)}">Zum Kalender hinzufügen</a>` : ''}
  </div>
  <div id="v-player" class="view" hidden>
   <video id="video" playsinline preload="auto" hidden${replayMode ? '' : ' disablepictureinpicture'}></video>
   <div id="embed" hidden></div><div id="shield" hidden></div>
   <button id="tap" type="button" hidden>▶ Zum Starten tippen</button>
   <div id="player-msg" hidden role="alert"></div>
   <div class="bar-ctl"><button id="mute" class="ctl" type="button" hidden>Ton an</button><button id="fs" class="ctl" type="button">Vollbild</button></div>
   <div class="replay-ctl"><button id="pp" class="ctl" type="button">Pause</button><input id="scrub" type="range" min="0" value="0" aria-label="Position"><span id="pos"></span></div>
  </div>
  <div id="v-ended" class="view center" hidden><h2>${esc(cfg.texts.ended)}</h2>
   <a class="btn" data-replay hidden href="#">${esc(w.settings.room.replay_label)} ansehen</a><p class="muted" id="replay-note"></p></div>
  <div id="v-late" class="view center" hidden><h2>Der Einlass ist geschlossen</h2><p class="muted">Das Webinar läuft schon zu lange, um noch einzusteigen. Die ${esc(w.settings.room.replay_label)} steht nach dem Ende bereit.</p><a class="btn" data-replay hidden href="#">${esc(w.settings.room.replay_label)} ansehen</a><p class="muted" id="replay-note-late"></p></div>
  <div id="offer" class="over" hidden></div>
  <div id="poll" class="over" hidden></div>
 </div>
</section>
<aside aria-label="Fragen und Hinweise"><h3>${w.settings.room.questions ? 'Fragen an das Team' : 'Hinweise'}</h3>
 <p id="chat-empty">${w.settings.room.questions ? 'Stell deine Frage unten – das Team antwortet dir nach dem Webinar.' : 'Hier erscheinen Hinweise während des Webinars.'}</p>
 <ul id="chat" aria-live="polite"></ul>
 ${w.settings.room.questions ? `<form id="q-form"><textarea id="q-text" maxlength="1000" placeholder="Deine Frage an das Team …" aria-label="Deine Frage"></textarea><div class="row"><span class="hint">Fragen gehen nur an das Team, nicht an andere Zuschauer.</span><button class="btn small" id="q-send" type="submit">Senden</button></div><div class="err" id="q-err" role="alert"></div></form>` : ''}
</aside>
</div>
<div id="toast" hidden role="status"></div>
<script type="application/json" id="wb-cfg">${jsonForScript(cfg)}</script>
<script nonce="${n}">${ROOM_SCRIPT}</script>`;
  const doc = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(w.title)} – ${esc(cfg.label)}</title><style>${ROOM_CSS}</style></head><body data-view="">${body}</body></html>`;
  const frame = embedOrigin(w.video);
  const direct = w.video.type === 'url';
  // Media from our own server, or from the https host of a linked file; HLS segments are fetched with XHR from that host.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${n}'${hls ? " 'self'" : ''}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' https: data:",
    `media-src 'self' blob:${direct ? ' https:' : ''}`,
    `connect-src 'self'${direct && hls ? ' https:' : ''}`,
    frame ? `frame-src ${frame}` : "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return page(200, doc, csp);
}

