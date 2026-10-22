/**
 * The browser side of the webinar room (/w/<slug>/watch and /replay): one script, no libraries. It is served inline with the
 * page (nonce) and reads its settings from <script type="application/json" id="wb-cfg">. All text it shows is set with
 * textContent – nothing the team or an attendee wrote is ever interpreted as HTML.
 *
 *  live     the schedule is the clock: waiting room with countdown → video from the viewer's second → end. The video cannot
 *           be skipped (no scrubber; a jump is undone), the server's clock decides where the video should be.
 *  replay   free playback with a scrubber, resumes where the viewer stopped.
 *  preview  like live, for the team: starts at a chosen second, nothing is counted or stored.
 */
export const ROOM_SCRIPT = String.raw`(function () {
  'use strict';
  var C = JSON.parse(document.getElementById('wb-cfg').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var live = C.mode !== 'replay';
  var preview = C.mode === 'preview';
  var t0 = performance.now(), s0 = C.server_now;
  var now = function () { return s0 + (performance.now() - t0); };
  var startMs = Date.parse(C.start);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var fmt = function (s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60); };
  var offset = function () { return (now() - startMs) / 1000; };
  var video = $('video'), frame = null, view = '', ended = false, tapShown = false;
  var shown = {}, answersShown = 0, openPoll = null, offerOpen = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Fehler'); e.status = r.status; throw e; } return j; });
    });
  }
  function show(v) {
    view = v;
    ['waiting', 'player', 'ended', 'late'].forEach(function (n) { var e = $('v-' + n); if (e) e.hidden = n !== v; });
    document.body.setAttribute('data-view', v);
  }
  function toast(t) { var e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { e.hidden = true; }, 3500); }

  // --- the player -------------------------------------------------------------------------------------
  function loadHls(src, done) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; return done(); }
    var s = document.createElement('script');
    s.src = '/w/_hls.js';
    s.onload = function () {
      if (window.Hls && window.Hls.isSupported()) { var h = new window.Hls(); h.loadSource(src); h.attachMedia(video); done(); } else fail('Dein Browser kann dieses Videoformat (HLS) nicht abspielen.');
    };
    s.onerror = function () { fail('Dein Browser kann dieses Videoformat (HLS) nicht abspielen. Bitte nimm Safari oder wende dich an das Team.'); };
    document.head.appendChild(s);
  }
  function fail(t) { $('player-msg').textContent = t; $('player-msg').hidden = false; }
  function seekTo(t) {
    try { var d = video.duration; video.currentTime = isFinite(d) && d > 1 ? Math.max(0, Math.min(t, d - 0.25)) : Math.max(0, t); } catch (e) { /* not seekable yet */ }
  }
  function playFrom(t) {
    video.muted = true; $('mute').setAttribute('aria-pressed', 'true'); $('mute').textContent = 'Ton an';
    var go = function () { seekTo(t); var p = video.play(); if (p && p.catch) p.catch(function () { tapShown = true; $('tap').hidden = false; }); };
    if (video.readyState >= 1) go(); else video.addEventListener('loadedmetadata', go, { once: true });
  }
  function startPlayer() {
    var pb = C.playback;
    var at = live ? offset() : C.resume_s || 0;
    $('stage').classList.toggle('replay', !live);
    if (pb.kind === 'file') { video.hidden = false; video.src = pb.src; playFrom(at); }
    else if (pb.kind === 'hls') { video.hidden = false; loadHls(pb.src, function () { playFrom(at); }); }
    else if (pb.kind === 'embed') {
      var src = pb.src, s = Math.max(0, Math.floor(at));
      if (!live) src = src.replace('controls=0', 'controls=1').replace('&disablekb=1', '').replace('&fs=0', '');
      src += pb.provider === 'youtube' ? '&enablejsapi=1&mute=1' + (s ? '&start=' + s : '') : (s ? '#t=' + s + 's' : '');
      frame = document.createElement('iframe');
      frame.src = src; frame.title = C.title; frame.allow = 'autoplay; fullscreen; picture-in-picture'; frame.setAttribute('allowfullscreen', '');
      $('embed').appendChild(frame); $('embed').hidden = false;
      $('shield').hidden = !live;
    } else fail('Für dieses Webinar ist noch kein Video hinterlegt.');
    $('mute').hidden = pb.kind === 'none';
    $('fs').hidden = !($('stage').requestFullscreen);
  }
  function toggleMute() {
    if (frame) {
      var p = frame.src.indexOf('vimeo') > -1;
      frame.contentWindow.postMessage(p ? JSON.stringify({ method: 'setMuted', value: false }) : JSON.stringify({ event: 'command', func: 'unMute', args: [] }), '*');
      $('mute').hidden = true;
      return;
    }
    video.muted = !video.muted;
    $('mute').setAttribute('aria-pressed', String(video.muted));
    $('mute').textContent = video.muted ? 'Ton an' : 'Ton aus';
  }
  $('mute').addEventListener('click', toggleMute);
  $('tap').addEventListener('click', function () { $('tap').hidden = true; tapShown = false; if (live) seekTo(offset()); video.play(); });
  $('fs').addEventListener('click', function () { if (document.fullscreenElement) document.exitFullscreen(); else $('stage').requestFullscreen(); });

  // The schedule is the clock: undo jumps and drift, keep playing.
  video.addEventListener('seeking', function () { if (live && view === 'player' && Math.abs(video.currentTime - offset()) > 3) seekTo(offset()); });
  video.addEventListener('ratechange', function () { if (live && video.playbackRate !== 1) video.playbackRate = 1; });
  setInterval(function () {
    if (!live || view !== 'player' || !video || video.hidden) return;
    var want = offset();
    if (want >= C.duration_s) return;
    if (Math.abs(video.currentTime - want) > 2.5 && video.readyState >= 2) seekTo(want);
    if (video.paused && !tapShown && !video.ended) { var p = video.play(); if (p && p.catch) p.catch(function () { tapShown = true; $('tap').hidden = false; }); }
  }, 2000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && live && view === 'player' && video && !video.hidden) { seekTo(offset()); beat(); } });

  // --- states -----------------------------------------------------------------------------------------
  function countdown(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (d ? d + ' T ' : '') + (d || h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
  }
  function enterWaiting() {
    show('waiting');
    var tick = function () {
      var left = (startMs - now()) / 1000;
      $('count').textContent = countdown(left);
      if (left <= 0) { clearInterval(timer); begin(); }
    };
    var timer = setInterval(tick, 250);
    tick();
  }
  function begin() {
    if (!live) { show('player'); startPlayer(); watchLoop(); return; }
    var off = offset();
    if (off >= C.duration_s) return endSession();
    show('player'); startPlayer(); watchLoop();
  }
  function endSession() {
    if (ended) return;
    ended = true;
    show('ended');
    try { video.pause(); } catch (e) { /* none */ }
    if (frame) { frame.remove(); frame = null; $('embed').hidden = true; }
    $('offer').hidden = !offerEndedVisible();
    beat();
  }
  function offerEndedVisible() { var o = C.offer; return live && o.enabled && offerOpen && !offerExpired(); }

  // --- things at a time (chat messages, polls, the offer) ---------------------------------------------
  function position() { return live ? offset() : (video && !video.hidden ? video.currentTime : 0); }
  function watchLoop() {
    if (watchLoop.on) return; watchLoop.on = true;
    setInterval(function () {
      if (view !== 'player' && !(view === 'ended' && offerOpen)) return;
      var pos = position();
      if (live && pos >= C.duration_s && view === 'player') return endSession();
      if (C.features.scripted) C.scripted.forEach(function (m) { if (!shown['m' + m.id] && m.at_s <= pos) { shown['m' + m.id] = 1; addChat('scr', m.name, m.text, true); } });
      C.polls.forEach(function (p) { if (!shown['p' + p.id] && p.at_s <= pos && !openPoll && !(p.mine && p.mine.length)) { shown['p' + p.id] = 1; showPoll(p); } });
      var o = C.offer;
      if (o.enabled && !offerOpen && o.at_s <= pos && (live || o.replay_ok) && !offerExpired()) showOffer();
      if (offerOpen) tickOffer();
      if (!live && video && !video.hidden) { var sc = $('scrub'); if (sc && document.activeElement !== sc) sc.value = String(Math.floor(video.currentTime)); $('pos').textContent = fmt(video.currentTime) + ' / ' + fmt(C.duration_s); }
    }, 500);
  }
  function addChat(kind, name, text, scripted) {
    var li = el('li', kind);
    var head = el('div', 'who');
    head.appendChild(el('b', '', name));
    if (scripted) head.appendChild(el('span', 'tag', C.scripted_label));
    li.appendChild(head); li.appendChild(el('p', '', text));
    var ul = $('chat'); ul.appendChild(li); ul.scrollTop = ul.scrollHeight;
    $('chat-empty').hidden = true;
  }

  function showPoll(p) {
    openPoll = p;
    var box = $('poll'); box.textContent = '';
    var head = el('div', 'bar'); head.appendChild(el('b', '', 'Umfrage')); var x = el('button', 'x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Umfrage schließen'); x.addEventListener('click', closePoll); head.appendChild(x);
    box.appendChild(head); box.appendChild(el('p', 'q', p.question));
    var form = el('form'), picked = [];
    var results = function (counts) {
      form.textContent = '';
      var total = counts.reduce(function (a, b) { return a + b; }, 0) || 1;
      p.options.forEach(function (o, i) {
        var row = el('div', 'res'); var bar = el('span', 'fill'); bar.style.width = Math.round((counts[i] / total) * 100) + '%';
        row.appendChild(bar); row.appendChild(el('span', 'lbl', o + ' – ' + Math.round((counts[i] / total) * 100) + ' %'));
        form.appendChild(row);
      });
    };
    if (p.mine && p.mine.length) { if (p.counts && p.show_results) results(p.counts); else form.appendChild(el('p', 'muted', 'Danke für deine Antwort!')); }
    else {
      p.options.forEach(function (o, i) {
        var lab = el('label', 'opt'); var inp = document.createElement('input'); inp.type = p.multiple ? 'checkbox' : 'radio'; inp.name = 'o'; inp.value = String(i);
        inp.addEventListener('change', function () { picked = [].slice.call(form.querySelectorAll('input:checked')).map(function (c) { return Number(c.value); }); });
        lab.appendChild(inp); lab.appendChild(document.createTextNode(' ' + o)); form.appendChild(lab);
      });
      var send = el('button', 'btn', 'Abschicken'); send.type = 'submit'; form.appendChild(send);
      var err = el('div', 'err'); form.appendChild(err);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!picked.length) { err.textContent = 'Bitte eine Antwort wählen.'; return; }
        if (preview) { toast('Vorschau: Antworten werden nicht gespeichert.'); return closePoll(); }
        post(C.urls.vote, { t: C.token, poll_id: p.id, choice: picked }).then(function (r) { p.mine = r.mine; if (p.show_results) results(r.counts); else { form.textContent = ''; form.appendChild(el('p', 'muted', 'Danke für deine Antwort!')); } setTimeout(closePoll, 6000); }).catch(function (e2) { err.textContent = e2.message; });
      });
    }
    box.appendChild(form); box.hidden = false;
  }
  function closePoll() { $('poll').hidden = true; openPoll = null; }

  function offerExpired() { var d = C.offer.deadline_ms; return d !== null && d !== undefined && now() > d; }
  function showOffer() {
    offerOpen = true;
    var o = C.offer, box = $('offer'); box.textContent = '';
    var head = el('div', 'bar'); head.appendChild(el('b', '', o.title || 'Angebot')); var x = el('button', 'x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Angebot schließen'); x.addEventListener('click', function () { box.hidden = true; }); head.appendChild(x);
    box.appendChild(head);
    if (o.text) box.appendChild(el('p', '', o.text));
    var a = el('a', 'btn', o.button_text); a.id = 'offer-btn'; a.target = '_blank'; a.rel = 'noopener';
    if (preview) { a.href = '#'; a.addEventListener('click', function (e) { e.preventDefault(); toast('Vorschau: Hier ginge es weiter zu ' + (o.preview_url || 'deinem Angebot') + '.'); }); } else a.href = C.urls.go;
    box.appendChild(a);
    if (o.deadline_ms !== null && o.deadline_ms !== undefined) { var c = el('div', 'deadline'); c.id = 'offer-count'; box.appendChild(c); }
    box.hidden = false; tickOffer();
  }
  function tickOffer() {
    var c = $('offer-count'); if (!c) return;
    var left = (C.offer.deadline_ms - now()) / 1000;
    if (left > 0) { c.textContent = 'Das Angebot gilt noch ' + countdown(left); return; }
    c.textContent = 'Das Angebot ist beendet.';
    var b = $('offer-btn'); if (b) b.hidden = true;
  }

  // --- questions ---------------------------------------------------------------------------------------
  var qf = $('q-form');
  if (qf) qf.addEventListener('submit', function (e) {
    e.preventDefault();
    var ta = $('q-text'), err = $('q-err'), text = ta.value.trim(); err.textContent = '';
    if (!text) return;
    if (preview) { toast('Vorschau: Fragen werden nicht gesendet.'); return; }
    $('q-send').disabled = true;
    post(C.urls.question, { t: C.token, text: text }).then(function () { addChat('me', 'Du', text, false); ta.value = ''; toast('Danke! Deine Frage ist beim Team angekommen.'); }).catch(function (e2) { err.textContent = e2.message; }).then(function () { $('q-send').disabled = false; });
  });
  function renderAnswers(list) {
    if (!list || list.length <= answersShown) return;
    for (var i = answersShown; i < list.length; i++) addChat('team', 'Antwort vom Team', list[i].body, false);
    answersShown = list.length;
  }

  // --- heartbeat ---------------------------------------------------------------------------------------
  function body() {
    var b = { t: C.token, mode: live ? 'live' : 'replay' };
    if (!live) { b.pos = video && !video.hidden ? Math.floor(video.currentTime) : 0; b.playing = !!(video && !video.hidden && !video.paused); }
    return b;
  }
  function beat() {
    if (preview) return Promise.resolve();
    return post(C.urls.ping, body()).then(function (r) {
      if (r.server_now) { s0 = r.server_now; t0 = performance.now(); }
      if (r.counter !== undefined) { $('counter').textContent = r.counter + (r.counter === 1 ? ' Person im Raum' : ' Personen im Raum'); $('counter').hidden = false; }
      if (r.replay) { C.replay = r.replay; renderReplay(); }
      renderAnswers(r.answers);
      if (live && r.clock) {
        if (r.clock.state === 'ended') endSession();
        else if (r.clock.state === 'late' && view !== 'player') show('late');
      }
    }).catch(function (e) { if (e.status === 410 || e.status === 404) { fail(e.message); } });
  }
  function renderReplay() {
    var r = C.replay, links = document.querySelectorAll('[data-replay]');
    [].forEach.call(links, function (a) { a.hidden = !r.available; if (r.available) a.href = r.url; });
    ['replay-note', 'replay-note-late'].forEach(function (id) { var note = $(id); if (note) note.textContent = r.available ? '' : r.reason === 'expired' ? 'Die Aufzeichnung ist leider nicht mehr verfügbar.' : r.reason === 'not_yet' ? 'Die Aufzeichnung steht nach dem Webinar bereit.' : ''; });
  }
  window.addEventListener('pagehide', function () { if (preview) return; try { navigator.sendBeacon(C.urls.ping, new Blob([JSON.stringify(body())], { type: 'application/json' })); } catch (e) { /* none */ } });

  // --- replay controls -----------------------------------------------------------------------------------
  if (!live) {
    var sc = $('scrub'); sc.max = String(C.duration_s);
    sc.addEventListener('input', function () { seekTo(Number(sc.value)); });
    $('pp').addEventListener('click', function () { if (video.paused) video.play(); else video.pause(); });
    video.addEventListener('play', function () { $('pp').textContent = 'Pause'; });
    video.addEventListener('pause', function () { $('pp').textContent = 'Weiter'; });
    video.addEventListener('ended', function () { $('pp').textContent = 'Nochmal'; beat(); });
  }

  // --- go -----------------------------------------------------------------------------------------------------
  (C.conversation && C.conversation.questions || []).forEach(function (q) { addChat('me', 'Du', q.body, false); });
  renderAnswers(C.conversation && C.conversation.answers);
  renderReplay();
  var st = C.clock.state;
  if (!live) { show('player'); startPlayer(); watchLoop(); }
  else if (st === 'waiting') enterWaiting();
  else if (st === 'running') begin();
  else if (st === 'late') show('late');
  else { ended = false; endSession(); }
  setInterval(function () { if (view === 'player' || view === 'waiting' || view === 'late' || view === 'ended') beat(); }, 20000);
  if (view === 'player') beat();
})();`;

export const ROOM_CSS = `
:root{--bg:#0b1020;--panel:#121a2e;--text:#e5e7eb;--muted:#94a3b8;--line:#233049;--brand:#3b82f6;--on:#fff;--red:#f87171;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
[hidden]{display:none!important}
a{color:inherit}
.rb{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
.rb .title{font-weight:600;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{display:inline-block;background:color-mix(in srgb,var(--brand) 22%,transparent);border:1px solid color-mix(in srgb,var(--brand) 55%,transparent);color:var(--text);border-radius:99px;padding:2px 12px;font-size:13px;font-weight:600;white-space:nowrap}
#counter{color:var(--muted);font-size:13px}
.room-main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;padding:16px;max-width:1280px;margin:0 auto}
@media (max-width:900px){.room-main{grid-template-columns:minmax(0,1fr);padding:10px}}
#stage{position:relative;width:100%;background:#000;border-radius:14px;overflow:hidden;aspect-ratio:16/9;min-height:220px;border:1px solid var(--line)}
#stage video,#stage #embed,#stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}
#stage video{object-fit:contain}
#shield{position:absolute;inset:0;z-index:3;background:transparent;cursor:default}
.view{position:absolute;inset:0}
.center{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px;padding:48px 20px 20px;background:linear-gradient(160deg,#111b36,#0b1020)}
.center h2{margin:0;font-size:clamp(18px,3vw,28px)}
.center .muted{color:var(--muted);max-width:520px;margin:0}
.presenter{display:flex;align-items:center;gap:10px}
.presenter img{width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid var(--line)}
#count{font-size:clamp(32px,8vw,64px);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.badge{position:absolute;left:12px;top:12px;z-index:4;background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:99px;padding:2px 12px;font-size:12px;font-weight:600;pointer-events:none}
.bar-ctl{position:absolute;right:10px;bottom:10px;z-index:5;display:flex;gap:6px;align-items:center}
.btn,button.btn{display:inline-block;background:var(--brand);color:var(--on);border:0;border-radius:9px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.small,.ctl{background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:8px;padding:5px 11px;font:inherit;font-size:13px;cursor:pointer}
.btn:focus-visible,.ctl:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #fff;outline-offset:2px}
#tap{position:absolute;inset:0;z-index:6;background:rgba(0,0,0,.55);border:0;color:#fff;font:inherit;font-size:20px;font-weight:600;cursor:pointer}
#player-msg{position:absolute;left:12px;right:12px;bottom:56px;z-index:6;background:rgba(0,0,0,.75);padding:10px 14px;border-radius:10px;font-size:14px}
.replay-ctl{position:absolute;left:0;right:0;bottom:0;z-index:5;display:flex;gap:10px;align-items:center;padding:8px 10px;background:linear-gradient(transparent,rgba(0,0,0,.75))}
.replay-ctl input[type=range]{flex:1}
#pos{font-size:12px;font-variant-numeric:tabular-nums;color:#e5e7eb}
#stage:not(.replay) .replay-ctl{display:none}
#stage.replay .bar-ctl{bottom:44px}
.over{position:absolute;z-index:7;background:rgba(15,23,42,.94);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#offer{left:12px;right:12px;bottom:12px;max-width:520px}
#poll{left:12px;top:48px;width:min(340px,calc(100% - 24px))}
@media (max-width:900px){
#stage{min-height:0}
body:not([data-view=player]) #stage{aspect-ratio:auto;min-height:340px}
.over{position:fixed;max-height:75vh;overflow:auto;background:#0f172a}
#offer,#poll{left:10px;right:10px;top:auto;bottom:10px;width:auto;max-width:none}
}
.over .bar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}
.over .x{background:none;border:0;color:var(--muted);font-size:16px;cursor:pointer;border-radius:6px;padding:2px 6px}
.over p{margin:4px 0 10px}
.deadline{margin-top:8px;font-size:13px;color:#fbbf24;font-variant-numeric:tabular-nums}
.opt{display:block;margin:4px 0;cursor:pointer}
.res{position:relative;border:1px solid var(--line);border-radius:8px;margin:6px 0;overflow:hidden;padding:4px 10px;min-height:28px}
.res .fill{position:absolute;inset:0 auto 0 0;background:color-mix(in srgb,var(--brand) 40%,transparent)}
.res .lbl{position:relative;font-size:14px}
.err{color:var(--red);font-size:13px;margin-top:6px}
aside{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:14px;min-height:260px;max-height:calc(100vh - 110px)}
aside h3{margin:0;padding:12px 14px;font-size:15px;border-bottom:1px solid var(--line)}
#chat{list-style:none;margin:0;padding:10px 14px;overflow-y:auto;flex:1;min-height:120px}
#chat li{margin:0 0 12px}
#chat .who{display:flex;gap:8px;align-items:center;font-size:13px}
#chat .tag{font-size:11px;border:1px solid var(--line);border-radius:99px;padding:0 8px;color:var(--muted)}
#chat p{margin:2px 0 0;font-size:14px;overflow-wrap:anywhere}
#chat li.me .who b{color:#93c5fd}#chat li.team .who b{color:#86efac}
#chat-empty{padding:10px 14px;color:var(--muted);font-size:14px}
#q-form{border-top:1px solid var(--line);padding:10px 14px}
#q-form textarea{width:100%;min-height:64px;resize:vertical;background:#0b1020;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}
#q-form .row{display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:8px}
.hint{color:var(--muted);font-size:12px}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#111827;border:1px solid var(--line);padding:9px 16px;border-radius:10px;z-index:30;max-width:90vw}
.below{max-width:1280px;margin:0 auto;padding:0 16px 24px;color:var(--muted);font-size:14px}
@media (prefers-reduced-motion:no-preference){.res .fill{transition:width .4s}}
`;
