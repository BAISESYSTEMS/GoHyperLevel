import type { App } from '../core/app.js';
import { jsonForScript, noscriptNotice, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney } from '../core/util.js';
import { formatInTz } from '../core/time.js';
import type { CalendarRow } from '../modules/calendars.js';
import { durationChoices, guestsAllowed, mayChange, multiAllowed, VIDEO_LABEL, type TeamCalConfig } from './teamcal-model.js';

/**
 * The public pages of the Team-Kalender, rendered on the server like the plain booking page: booking (with questions, price,
 * policy), the page of a booked appointment (cancel, reschedule, link), the return page after paying, routing forms and the
 * waiting-list offer. Plain HTML plus a little script; labels belong to their fields, status changes are announced to screen
 * readers, targets are at least 44 px high, everything works on a phone.
 */

const CSS = `
<style>
.tc :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
.tc h1:focus { outline: none; }
.tc h2 { font-size: 17px; margin: 22px 0 10px; }
.tc .meta { list-style: none; padding: 0; margin: 4px 0 14px; display: flex; flex-wrap: wrap; gap: 8px; }
.tc .meta li { background: #f3f4f6; border-radius: 999px; padding: 6px 14px; font-size: 14px; }
.tc .price { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; border-radius: 12px; padding: 12px 14px; margin: 0 0 14px; }
.tc details.policy { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin: 0 0 14px; }
.tc details.policy summary { cursor: pointer; font-weight: 600; min-height: 32px; display: flex; align-items: center; }
.tc .days { display: flex; gap: 8px; overflow-x: auto; padding: 6px 2px 12px; }
.tc .day { flex: 0 0 auto; min-width: 68px; min-height: 58px; padding: 8px 12px; background: #fff; color: var(--text); border: 1px solid #d1d5db; border-radius: 12px; font-weight: 600; line-height: 1.25; }
.tc .day:hover { border-color: var(--brand); }
.tc .day[aria-pressed="true"] { background: var(--brand); border-color: var(--brand); color: #fff; }
.tc .day.none { opacity: .7; border-style: dashed; }
.tc .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 10px; margin-top: 8px; }
.tc .slot { min-height: 52px; padding: 8px; background: #fff; color: var(--brand); border: 2px solid var(--brand); border-radius: 12px; font-weight: 700; font-size: 16px; }
.tc .slot:hover, .tc .slot:focus-visible { background: var(--brand); color: #fff; }
.tc .slot small { display: block; font-weight: 500; font-size: 12px; }
.tc .slot.full { border-style: dashed; border-color: #6b7280; color: #374151; }
.tc .nav { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.tc .nav button, .tc button.secondary, .tc a.btn { min-height: 48px; }
.tc button.secondary { background: #fff; color: var(--text); border: 1px solid #d1d5db; }
.tc button.danger { background: #b91c1c; }
.tc fieldset { border: 0; padding: 0; margin: 14px 0 0; }
.tc legend { font-weight: 600; font-size: 14px; padding: 0; margin-bottom: 6px; }
.tc .opt { display: flex; gap: 10px; align-items: center; min-height: 44px; padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 10px; margin: 0 0 8px; font-weight: 400; cursor: pointer; }
.tc .opt input { width: 22px; height: 22px; margin: 0; flex: 0 0 auto; }
.tc .opt:has(input:checked) { border-color: var(--brand); background: #eff6ff; }
.tc .help { font-size: 13px; color: var(--muted); margin: 4px 0 0; }
.tc .live { min-height: 24px; }
.tc .status { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 700; font-size: 14px; }
.tc .status.ok { background: #dcfce7; color: #166534; } .tc .status.off { background: #fee2e2; color: #991b1b; }
.tc .sr { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.tc .linkbox { background: #f3f4f6; border-radius: 12px; padding: 12px 14px; word-break: break-all; margin: 10px 0; }
@media (max-width: 560px) { .tc .slots { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); } .tc .nav > * { flex: 1 1 100%; text-align: center; } }
</style>`;

/** The slot picker shared by the booking page and the page of a booked appointment (reschedule). */
const PICKER_JS = `
function makePicker(o) {
  var $ = function (id) { return document.getElementById(id); };
  var from = new Date().toISOString().slice(0, 10), days = [], sel = null;
  var fmtDay = function (d) { var dt = new Date(d + 'T12:00:00'); return dt.toLocaleDateString('de-DE', { weekday: 'short' }) + '<br>' + dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); };
  var hm = function (s) { return new Date(s).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); };
  function draw() {
    var box = $(o.days); box.innerHTML = '';
    days.forEach(function (d) {
      var n = d.slots.length + (d.full ? d.full.length : 0);
      var b = document.createElement('button'); b.type = 'button'; b.className = 'day' + (n ? '' : ' none');
      b.setAttribute('aria-pressed', d === sel ? 'true' : 'false'); b.innerHTML = fmtDay(d.date);
      b.setAttribute('aria-label', new Date(d.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) + (d.slots.length ? ', ' + d.slots.length + ' freie Zeiten' : ', keine freien Zeiten'));
      b.onclick = function () { sel = d; draw(); $(o.slots).focus(); };
      box.appendChild(b);
    });
    var sl = $(o.slots); sl.innerHTML = '';
    var list = sel ? sel.slots.map(function (s) { return { s: s, full: false }; }).concat((sel.full || []).map(function (s) { return { s: s, full: true }; })).sort(function (a, b) { return a.s < b.s ? -1 : 1; }) : [];
    if (!list.length) { var p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Keine freien Zeiten an diesem Tag.'; sl.appendChild(p); }
    list.forEach(function (x) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'slot' + (x.full ? ' full' : '');
      b.textContent = hm(x.s);
      if (x.full) { var sm = document.createElement('small'); sm.textContent = 'ausgebucht – Warteliste'; b.appendChild(sm); }
      else if (sel.left && sel.left[x.s] && o.seats) { var sm2 = document.createElement('small'); sm2.textContent = sel.left[x.s] + (sel.left[x.s] === 1 ? ' Platz frei' : ' Plätze frei'); b.appendChild(sm2); }
      b.setAttribute('aria-label', new Date(x.s).toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + (x.full ? ', ausgebucht, Warteliste' : ''));
      b.onclick = function () { o.onPick(x.s, x.full); };
      sl.appendChild(b);
    });
    $(o.live).textContent = sel ? (sel.slots.length ? sel.slots.length + ' freie Zeiten am ' + new Date(sel.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Keine freien Zeiten an diesem Tag') : '';
  }
  function load() {
    $(o.live).textContent = 'Lade freie Zeiten …';
    return fetch(o.url + (o.url.indexOf('?') > -1 ? '&' : '?') + 'from=' + from + '&days=7').then(function (r) { return r.json(); }).then(function (j) {
      days = j.days || []; sel = days.filter(function (d) { return d.slots.length; })[0] || days[0] || null; draw();
    }).catch(function () { $(o.live).textContent = 'Die freien Zeiten konnten nicht geladen werden.'; });
  }
  $(o.prev).onclick = function () { var d = new Date(from + 'T12:00:00'); d.setDate(d.getDate() - 7); var t = new Date().toISOString().slice(0, 10); var n = d.toISOString().slice(0, 10); from = n < t ? t : n; load(); };
  $(o.next).onclick = function () { var d = new Date(from + 'T12:00:00'); d.setDate(d.getDate() + 7); from = d.toISOString().slice(0, 10); load(); };
  return { load: load };
}`;

const money = (c: number, cur: string) => centsToMoney(c, cur);

const nl = (s: string) => escapeHtml(s).replace(/\n/g, '<br>');

/** The booking page of a team calendar. */
export function bookingPage(app: App, cal: CalendarRow, cfg: TeamCalConfig, o: { embed: boolean }): string {
  const loc = app.location(cal.location_id)!;
  const s = cal.settings;
  const pay = cfg.payment;
  const durs = cfg.kind === 'group' ? [cal.duration] : durationChoices(cal.duration, cfg);
  const meta: string[] = [`⏱ ${durs.join(' / ')} Minuten`];
  if (cfg.video !== 'none') meta.push(`🎥 ${cfg.video === 'static' && s.meeting_location ? escapeHtml(String(s.meeting_location)) : VIDEO_LABEL[cfg.video]}`);
  else if (s.meeting_location) meta.push(`📍 ${escapeHtml(String(s.meeting_location))}`);
  if (cfg.kind === 'group') meta.push(`👥 Gruppe · bis ${cfg.capacity} Plätze`);
  if (cfg.kind === 'collective') meta.push('👥 Gespräch mit dem ganzen Team');
  const price =
    pay.mode === 'none'
      ? ''
      : `<p class="price" role="note"><strong>${pay.mode === 'deposit' ? `Anzahlung ${money(pay.deposit_cents, pay.currency)}` : `Preis ${money(pay.amount_cents, pay.currency)}`}</strong> – du bezahlst direkt bei der Buchung (Karte, SEPA, Apple Pay …) und der Termin gilt nach der Zahlung.${pay.mode === 'deposit' ? ` Der Gesamtpreis beträgt ${money(pay.amount_cents, pay.currency)}, den Rest bezahlst du vor Ort.` : ''} Wir reservieren deine Zeit ${pay.hold_minutes} Minuten.</p>`;
  const policy = cfg.policy_text || !cfg.allow_cancel || cfg.cancel_cutoff_hours
    ? `<details class="policy"><summary>Absage- und Erstattungsregeln</summary><p>${cfg.policy_text ? nl(cfg.policy_text) : ''}</p>${cfg.cancel_cutoff_hours ? `<p class="muted">Online absagen oder verschieben geht bis ${cfg.cancel_cutoff_hours} Stunden vor dem Termin.</p>` : ''}${cfg.allow_cancel ? '' : '<p class="muted">Dieser Termin kann online nicht abgesagt werden.</p>'}</details>`
    : '';
  const submitLabel = pay.mode === 'none' ? 'Termin buchen' : `Weiter zur Zahlung (${money(pay.mode === 'deposit' ? pay.deposit_cents : pay.amount_cents, pay.currency)})`;
  const body = `
<main class="wrap tc" id="main">
  <div class="card">
    <p class="muted" style="margin:0 0 4px">${escapeHtml(loc.name)}</p>
    <h1 id="title" tabindex="-1">${escapeHtml(cal.name)}</h1>
    <ul class="meta" aria-label="Details">${meta.map((m) => `<li>${m}</li>`).join('')}</ul>
    ${cal.description ? `<p>${nl(cal.description)}</p>` : ''}
    ${price}${policy}
    <section id="step1" aria-labelledby="h-pick">
      <h2 id="h-pick">Termin wählen</h2>
      ${durs.length > 1 ? `<fieldset class="durs" id="durs" style="border:0;padding:0;margin:0 0 12px"><legend>Dauer</legend>${durs.map((d, i) => `<label class="opt" style="display:inline-flex;margin-right:12px"><input type="radio" name="duration" value="${d}"${i === 0 ? ' checked' : ''}> <span>${d} Minuten</span></label>`).join('')}</fieldset>` : ''}
      ${noscriptNotice('einen Termin zu buchen')}
      <div class="days" id="days" role="group" aria-label="Tage"></div>
      <div class="slots" id="slots" role="group" aria-label="Freie Zeiten" tabindex="-1"></div>
      <div class="nav"><button class="secondary" id="prev" type="button">← Früher</button><button class="secondary" id="next" type="button">Später →</button></div>
      <p class="muted" style="font-size:13px">Zeiten in deiner Zeitzone: <span id="tz"></span></p>
      <p class="live sr" id="live" role="status" aria-live="polite"></p>
    </section>
    <form id="step2" hidden novalidate aria-labelledby="h-data">
      <h2 id="h-data" tabindex="-1">Deine Angaben</h2>
      <p><strong id="chosen"></strong> <a href="#" id="back">Zeit ändern</a>${multiAllowed(cfg) > 1 ? ` · <a href="#" id="more">Weitere Zeit hinzufügen</a>` : ''}</p>
      <div class="row">
        <div><label for="f-first">Vorname *</label><input id="f-first" name="first_name" required autocomplete="given-name"></div>
        <div><label for="f-last">Nachname</label><input id="f-last" name="last_name" autocomplete="family-name"></div>
      </div>
      <label for="f-email">E-Mail *</label><input id="f-email" name="email" type="email" required autocomplete="email" inputmode="email">
      ${s.ask_phone !== false ? '<label for="f-phone">Telefon</label><input id="f-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel">' : ''}
      <div id="questions"></div>
      ${guestsAllowed(cfg) ? `<label for="f-guests">Gäste (optional)</label><textarea id="f-guests" name="guests" rows="2" inputmode="email" placeholder="E-Mail-Adressen, eine pro Zeile"></textarea><p class="help">Bis zu ${guestsAllowed(cfg)} ${guestsAllowed(cfg) === 1 ? 'Person bekommt' : 'Personen bekommen'} eine Einladung mit dem Termin.</p>` : ''}
      ${s.ask_notes !== false ? `<label for="f-notes">${cfg.questions.length ? 'Weitere Anmerkungen (optional)' : 'Worum geht es?'}</label><textarea id="f-notes" name="notes"></textarea>` : ''}
      <div style="position:absolute;left:-9999px" aria-hidden="true"><label for="f-hp">Webseite</label><input id="f-hp" name="website" tabindex="-1" autocomplete="off"></div>
      <label class="check" for="f-consent"><input id="f-consent" type="checkbox" required> <span>${escapeHtml(cfg.consent_text)}</span></label>
      <div class="nav"><button type="submit" id="submit">${escapeHtml(submitLabel)}</button></div>
      <div class="error" id="err" role="alert"></div>
    </form>
    <div id="done" hidden class="ok" role="status" tabindex="-1"></div>
  </div>
</main>${CSS}
<script>
${PICKER_JS}
(function () {
const CFG = ${jsonForScript({ slug: cal.slug, redirect: s.redirect_url || '', questions: cfg.questions, kind: cfg.kind, payment: pay.mode, waitlist: cfg.waitlist, multi: multiAllowed(cfg) })};
const $ = function (id) { return document.getElementById(id); };
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; $('tz').textContent = tz;
const q = new URLSearchParams(location.search);
let chosen = null, chosenFull = false;
const longDate = function (s) { return new Date(s).toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' }) + ' Uhr'; };
// the questions of this calendar
const qbox = $('questions');
CFG.questions.forEach(function (qq) {
  const id = 'q-' + qq.id;
  const qbox = document.createElement('div'); qbox.id = 'qb-' + qq.id; $('questions').appendChild(qbox);
  if (qq.type === 'text' || qq.type === 'textarea') {
    const l = document.createElement('label'); l.htmlFor = id; l.textContent = qq.label + (qq.required ? ' *' : '');
    const f = document.createElement(qq.type === 'text' ? 'input' : 'textarea'); f.id = id; f.name = id; if (qq.required) f.required = true; f.maxLength = qq.type === 'text' ? 500 : 5000;
    qbox.appendChild(l); qbox.appendChild(f);
  } else if (qq.type === 'checkbox') {
    const l = document.createElement('label'); l.className = 'check'; l.htmlFor = id;
    const f = document.createElement('input'); f.type = 'checkbox'; f.id = id; f.name = id; if (qq.required) f.required = true;
    const sp = document.createElement('span'); sp.textContent = qq.label + (qq.required ? ' *' : ''); l.appendChild(f); l.appendChild(sp); qbox.appendChild(l);
  } else {
    const fs = document.createElement('fieldset'); fs.id = id; const lg = document.createElement('legend'); lg.textContent = qq.label + (qq.required ? ' *' : ''); fs.appendChild(lg);
    qq.options.forEach(function (opt, i) {
      const l = document.createElement('label'); l.className = 'opt';
      const f = document.createElement('input'); f.type = qq.type === 'multi' ? 'checkbox' : 'radio'; f.name = id; f.value = opt; f.id = id + '-' + i;
      const sp = document.createElement('span'); sp.textContent = opt; l.appendChild(f); l.appendChild(sp); fs.appendChild(l);
    });
    qbox.appendChild(fs);
  }
  if (qq.help) { const h = document.createElement('p'); h.className = 'help'; h.textContent = qq.help; qbox.appendChild(h); }
});
// conditional questions: shown only when an earlier answer matches (the server checks the same)
function shownQ(qq) { return !$('qb-' + qq.id).hidden; }
function refreshQ() {
  const a = answers(true);
  CFG.questions.forEach(function (qq) {
    if (!qq.show_if) return;
    const ref = CFG.questions.filter(function (x) { return x.id === qq.show_if.id; })[0];
    let vals = ref && shownQ(ref) ? a[ref.id] : null;
    if (ref && ref.type === 'checkbox') vals = vals === null ? [] : [vals ? 'Ja' : 'Nein'];
    vals = vals === null || vals === undefined ? [] : Array.isArray(vals) ? vals : [vals];
    $('qb-' + qq.id).hidden = !vals.some(function (v) { return qq.show_if.values.indexOf(v) >= 0; });
  });
}
qbox.addEventListener('change', refreshQ); qbox.addEventListener('input', refreshQ); refreshQ();
const PO = { url: '/api/public/team-calendars/' + CFG.slug + '/slots', days: 'days', slots: 'slots', live: 'live', prev: 'prev', next: 'next', seats: CFG.kind === 'group',
  onPick: function (s, full) {
    if (adding && !full) { if (picked.indexOf(s) < 0) picked.push(s); picked.sort(); } else picked = [s];
    adding = false; chosen = picked[0]; chosenFull = full; $('chosen').textContent = picked.map(longDate).join(' · ') + (full ? ' – Warteliste' : '');
    if ($('more')) $('more').hidden = full || picked.length >= CFG.multi;
    $('step1').hidden = true; $('step2').hidden = false; $('h-data').focus();
    if (full) $('submit').textContent = 'Auf die Warteliste setzen';
  } };
let picked = [], adding = false;
const picker = makePicker(PO);
let duration = 0;
if ($('more')) $('more').onclick = function (e) { e.preventDefault(); adding = true; $('step2').hidden = true; $('step1').hidden = false; $('title').focus(); };
if ($('durs')) $('durs').addEventListener('change', function (e) { duration = Number(e.target.value) || 0; PO.url = '/api/public/team-calendars/' + CFG.slug + '/slots?duration=' + duration; picker.load(); });
$('back').onclick = function (e) { e.preventDefault(); $('step2').hidden = true; $('step1').hidden = false; $('title').focus(); };
function answers(all) {
  const out = {};
  CFG.questions.forEach(function (qq) {
    if (!all && !shownQ(qq)) return;
    const id = 'q-' + qq.id;
    if (qq.type === 'checkbox') out[qq.id] = $(id).checked;
    else if (qq.type === 'multi') out[qq.id] = Array.prototype.map.call(document.querySelectorAll('input[name="' + id + '"]:checked'), function (x) { return x.value; });
    else if (qq.type === 'choice') { const c = document.querySelector('input[name="' + id + '"]:checked'); out[qq.id] = c ? c.value : ''; }
    else out[qq.id] = $(id).value;
  });
  return out;
}
$('step2').onsubmit = function (e) {
  e.preventDefault();
  const btn = $('submit'), err = $('err'); err.textContent = '';
  if ($('f-hp').value) { err.textContent = 'Das hat nicht geklappt.'; return; }
  if (!$('f-first').value.trim()) { err.textContent = 'Bitte den Vornamen angeben.'; $('f-first').focus(); return; }
  if (!$('f-email').validity.valid || !$('f-email').value) { err.textContent = 'Bitte eine gültige E-Mail-Adresse angeben.'; $('f-email').focus(); return; }
  for (let i = 0; i < CFG.questions.length; i++) {
    const qq = CFG.questions[i]; if (!qq.required || !shownQ(qq)) continue; const a = answers()[qq.id];
    if (!a || (Array.isArray(a) && !a.length)) { err.textContent = 'Bitte beantworten: ' + qq.label; const t = document.getElementById('q-' + qq.id) || document.getElementById('q-' + qq.id + '-0'); if (t) t.focus(); return; }
  }
  if (!$('f-consent').checked) { err.textContent = 'Bitte stimme der Speicherung deiner Angaben zu.'; $('f-consent').focus(); return; }
  btn.disabled = true;
  const data = { start: chosen, waitlist: chosenFull, first_name: $('f-first').value, last_name: $('f-last').value, email: $('f-email').value, phone: $('f-phone') ? $('f-phone').value : '', notes: $('f-notes') ? $('f-notes').value : '', answers: answers(), consent: true, timezone: tz, via: q.get('via') || '', duration: duration || undefined, guests: $('f-guests') ? $('f-guests').value.split(/[\\s,;]+/).filter(Boolean) : [] };
  const ab = q.get('ab'); if (ab) data._ab = ab;
  q.forEach(function (v, k) { if (/^(utm_[a-z]+|gclid|fbclid|ref)$/.test(k)) data['_' + k] = v; }); if (q.get('_a')) data._attr = q.get('_a');
  data._page = (window.top === window ? location.href : document.referrer) || '';
  if (picked.length > 1) data.starts = picked;
  fetch('/api/public/team-calendars/' + CFG.slug + (picked.length > 1 ? '/book-many' : '/book'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
    .then(function (x) {
      btn.disabled = false;
      if (!x.ok) { err.textContent = x.j.error || 'Das hat nicht geklappt.'; if (x.status === 409) { $('step2').hidden = true; $('step1').hidden = false; picker.load(); $('live').textContent = err.textContent; } return; }
      const j = x.j;
      if (j.status === 'payment_required') { $('err').textContent = ''; btn.disabled = true; btn.textContent = 'Weiter zu Stripe …'; location.href = j.checkout_url; return; }
      if (CFG.redirect && j.status === 'confirmed') { location.href = CFG.redirect; return; }
      $('step2').hidden = true; const d = $('done'); d.hidden = false; d.innerHTML = '';
      const h = document.createElement('strong'); h.textContent = j.status === 'waitlisted' ? 'Du stehst auf der Warteliste.' : 'Termin gebucht! ✅'; d.appendChild(h); d.appendChild(document.createElement('br'));
      const t = document.createElement('span'); t.textContent = j.appointments ? j.appointments.map(function (a) { return longDate(a.start_at); }).join(' · ') : longDate(chosen); d.appendChild(t); d.appendChild(document.createElement('br'));
      if (j.appointments) { j.manageUrl = ''; j.icsUrl = j.appointments[0].icsUrl; j.meetingUrl = j.appointments[0].meetingUrl; }
      const m = document.createElement('span'); m.textContent = j.status === 'waitlisted' ? 'Wird ein Platz frei, bekommst du eine E-Mail mit einem Link, der ihn 24 Stunden für dich reserviert.' : 'Eine Bestätigung kommt per E-Mail.'; d.appendChild(m);
      if (j.hosts && j.hosts.length) { d.appendChild(document.createElement('br')); const hs = document.createElement('span'); hs.textContent = 'Mit ' + j.hosts.join(' und '); d.appendChild(hs); }
      const links = document.createElement('p'); d.appendChild(links);
      if (j.meetingUrl) { const a = document.createElement('a'); a.href = j.meetingUrl; a.textContent = 'Zum Video-Gespräch'; a.className = 'btn'; links.appendChild(a); links.appendChild(document.createTextNode(' ')); }
      if (j.icsUrl) { const a = document.createElement('a'); a.href = j.icsUrl; a.textContent = 'In Kalender eintragen'; a.className = 'btn secondary'; links.appendChild(a); links.appendChild(document.createTextNode(' ')); }
      if (j.manageUrl) { const a = document.createElement('a'); a.href = j.manageUrl; a.textContent = 'Termin verwalten'; a.className = 'btn secondary'; links.appendChild(a); }
      d.focus();
    })
    .catch(function () { btn.disabled = false; err.textContent = 'Keine Verbindung – bitte noch einmal versuchen.'; });
};
picker.load();
})();
</script>`;
  return publicPage({ title: `${cal.name} – ${loc.name}`, body, color: cal.color, embed: o.embed });
}

/** The page of a booked appointment: details, link, add to calendar, reschedule, cancel (with the calendar's rules). */
export function managePage(app: App, appt: any, cal: CalendarRow, cfg: TeamCalConfig, hosts: string[]): string {
  const cancelled = appt.status === 'cancelled';
  const started = Date.parse(appt.start_at) <= Date.now();
  const canCancel = !cancelled && !started && cfg.allow_cancel && mayChange(cfg.cancel_cutoff_hours, appt.start_at);
  const canMove = !cancelled && !started && appt.status === 'confirmed' && cfg.allow_reschedule && mayChange(cfg.reschedule_cutoff_hours, appt.start_at);
  let pay: any = null;
  try {
    pay = appt.payment ? JSON.parse(appt.payment) : null;
  } catch {
    pay = null;
  }
  const payLine = pay?.status === 'paid' ? `Bezahlt: ${money(pay.due_cents ?? pay.amount_cents, pay.currency)}${pay.mode === 'deposit' ? ` (Anzahlung, Rest ${money(pay.amount_cents - pay.due_cents, pay.currency)} vor Ort)` : ''}` : pay?.status === 'refunded' ? 'Die Zahlung wurde erstattet.' : pay?.status === 'refund_pending' ? 'Die Erstattung wird geprüft – wir melden uns.' : '';
  const token = escapeHtml(appt.manage_token);
  const body = `
<main class="wrap tc" id="main"><div class="card">
  <h1 id="title" tabindex="-1">${escapeHtml(cal.name)}</h1>
  <p><strong>${escapeHtml(formatInTz(appt.start_at, cal.timezone))}</strong> <span class="muted">(${escapeHtml(cal.timezone)})</span></p>
  <p>Status: <span class="status ${cancelled ? 'off' : 'ok'}">${cancelled ? 'abgesagt' : appt.status === 'confirmed' ? 'bestätigt' : escapeHtml(appt.status)}</span></p>
  ${hosts.length && cfg.show_hosts ? `<p>Mit ${escapeHtml(hosts.join(' und '))}</p>` : ''}
  ${appt.meeting_url && !cancelled ? `<p><a class="btn" href="${escapeHtml(/^https?:\/\//.test(appt.meeting_url) ? appt.meeting_url : '#')}" target="_blank" rel="noopener">${/^https?:\/\//.test(appt.meeting_url) ? 'Zum Video-Gespräch' : escapeHtml(appt.meeting_url)}</a></p>` : ''}
  ${payLine ? `<p class="price">${escapeHtml(payLine)}</p>` : ''}
  ${cfg.policy_text ? `<details class="policy"><summary>Absage- und Erstattungsregeln</summary><p>${nl(cfg.policy_text)}</p></details>` : ''}
  ${
    cancelled
      ? `<p><a class="btn" href="/book/${escapeHtml(cal.slug)}">Neuen Termin buchen</a></p>`
      : `<div class="nav"><a class="btn secondary" href="/book/ics/${token}">In Kalender eintragen</a> <a class="btn secondary" href="/book/ticket/${token}">Ticket (QR-Code)</a>
         ${canMove ? '<button type="button" class="secondary" id="move">Termin verschieben</button>' : ''}
         ${canCancel ? '<button type="button" class="danger" id="cancel">Termin absagen</button>' : ''}</div>
         ${!canMove && !cancelled && !started ? `<p class="muted">${cfg.allow_reschedule ? `Online verschieben geht bis ${cfg.reschedule_cutoff_hours} Stunden vor dem Termin.` : 'Dieser Termin kann online nicht verschoben werden.'} Bitte melde dich direkt, wenn etwas dazwischenkommt.</p>` : ''}
         ${!canCancel && !cancelled && !started ? `<p class="muted">${cfg.allow_cancel ? `Online absagen geht bis ${cfg.cancel_cutoff_hours} Stunden vor dem Termin.` : 'Dieser Termin kann online nicht abgesagt werden.'}</p>` : ''}`
  }
  ${canMove || canCancel ? noscriptNotice('den Termin zu verschieben oder abzusagen') : ''}
  <div id="confirm" hidden role="alertdialog" aria-labelledby="cq"><p id="cq"><strong>Termin wirklich absagen?</strong>${pay?.status === 'paid' ? (cfg.payment.refund === 'auto' ? ' Deine Zahlung wird erstattet.' : ' Über eine Erstattung entscheiden wir nach den oben genannten Regeln.') : ''}</p>
    <label for="reason">Grund (optional)</label><input id="reason" maxlength="300">
    <div class="nav"><button type="button" class="danger" id="yes">Ja, absagen</button><button type="button" class="secondary" id="no">Doch nicht</button></div></div>
  <section id="mv" hidden aria-labelledby="h-mv"><h2 id="h-mv" tabindex="-1">Neue Zeit wählen</h2>
    <div class="days" id="days" role="group" aria-label="Tage"></div><div class="slots" id="slots" role="group" aria-label="Freie Zeiten" tabindex="-1"></div>
    <div class="nav"><button class="secondary" id="prev" type="button">← Früher</button><button class="secondary" id="next" type="button">Später →</button><button class="secondary" id="mvx" type="button">Abbrechen</button></div>
    <p class="live sr" id="live" role="status" aria-live="polite"></p></section>
  <p class="live" id="msg" role="status" aria-live="polite"></p>
</div></main>${CSS}
<script>
${PICKER_JS}
(function () {
const TOKEN = ${jsonForScript(appt.manage_token)};
const $ = function (id) { return document.getElementById(id); };
const say = function (t, bad) { $('msg').textContent = t; $('msg').style.color = bad ? '#b91c1c' : ''; };
const post = function (path, body) { return fetch('/api/public/team-calendars/manage/' + TOKEN + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }); };
if ($('cancel')) {
  $('cancel').onclick = function () { $('confirm').hidden = false; $('yes').focus(); };
  $('no').onclick = function () { $('confirm').hidden = true; $('cancel').focus(); };
  $('yes').onclick = function () { $('yes').disabled = true; post('cancel', { reason: $('reason').value }).then(function (x) { if (x.ok) location.reload(); else { $('yes').disabled = false; say(x.j.error || 'Absagen ging nicht.', true); } }); };
}
if ($('move')) {
  const picker = makePicker({ url: '/api/public/team-calendars/manage/' + TOKEN + '/slots', days: 'days', slots: 'slots', live: 'live', prev: 'prev', next: 'next',
    onPick: function (s) { post('reschedule', { start: s }).then(function (x) { if (x.ok) location.reload(); else say(x.j.error || 'Verschieben ging nicht.', true); }); } });
  $('move').onclick = function () { $('mv').hidden = false; picker.load().then(function () { $('h-mv').focus(); }); };
  $('mvx').onclick = function () { $('mv').hidden = true; $('move').focus(); };
}
})();
</script>`;
  return publicPage({ title: 'Termin verwalten', body, color: cal.color });
}

/** After Stripe: waits for the payment to be confirmed, then shows the booked appointment. */
export function paidPage(app: App, hold: { token: string; start_at: string }, cal: CalendarRow, cancelled: boolean, sessionId: string): string {
  const body = `
<main class="wrap tc" id="main"><div class="card">
  <h1 id="title" tabindex="-1">${escapeHtml(cal.name)}</h1>
  <p><strong>${escapeHtml(formatInTz(hold.start_at, cal.timezone))}</strong> <span class="muted">(${escapeHtml(cal.timezone)})</span></p>
  <div id="state" role="status" aria-live="polite" tabindex="-1">${cancelled ? 'Die Zahlung wurde abgebrochen.' : 'Wir bestätigen deine Zahlung …'}</div>
  <p class="nav" id="actions"></p>
</div></main>${CSS}
<script>
(function () {
const TOKEN = ${jsonForScript(hold.token)}, SESSION = ${jsonForScript(sessionId)};
const $ = function (id) { return document.getElementById(id); };
let tries = 0;
function link(href, text, cls) { const a = document.createElement('a'); a.href = href; a.textContent = text; a.className = cls; $('actions').appendChild(a); $('actions').appendChild(document.createTextNode(' ')); }
function render(j) {
  $('actions').innerHTML = '';
  if (j.status === 'confirmed') { $('state').textContent = 'Zahlung erhalten – dein Termin ist bestätigt! ✅ Die Bestätigung kommt per E-Mail.'; if (j.meetingUrl) link(j.meetingUrl, 'Zum Video-Gespräch', 'btn'); link(j.icsUrl, 'In Kalender eintragen', 'btn secondary'); link(j.manageUrl, 'Termin verwalten', 'btn secondary'); $('state').focus(); return true; }
  if (j.status === 'expired' || j.status === 'cancelled') { $('state').textContent = 'Die Reservierung ist abgelaufen. Bitte wähle eine neue Zeit.'; link('/book/' + j.slug, 'Neuen Termin wählen', 'btn'); $('state').focus(); return true; }
  if (j.status === 'refunded') { $('state').textContent = 'Der Termin war inzwischen vergeben – deine Zahlung wird erstattet.'; link('/book/' + j.slug, 'Neuen Termin wählen', 'btn'); return true; }
  if (j.checkoutUrl && ${cancelled ? 'true' : 'false'}) { $('state').textContent = 'Die Zahlung wurde abgebrochen. Deine Zeit ist noch bis ' + new Date(j.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr reserviert.'; link(j.checkoutUrl, 'Jetzt bezahlen', 'btn'); link('/book/' + j.slug, 'Andere Zeit wählen', 'btn secondary'); return true; }
  return false;
}
function poll() {
  fetch('/api/public/team-calendars/hold/' + TOKEN + (SESSION ? '?session_id=' + encodeURIComponent(SESSION) : '')).then(function (r) { return r.json(); }).then(function (j) {
    if (render(j)) return;
    if (++tries < 40) setTimeout(poll, 1500); else { $('state').textContent = 'Die Bestätigung dauert länger als gewöhnlich. Du bekommst eine E-Mail, sobald die Zahlung angekommen ist.'; }
  }).catch(function () { if (++tries < 40) setTimeout(poll, 2500); });
}
poll();
})();
</script>`;
  return publicPage({ title: 'Zahlung', body, color: cal.color });
}

/** A routing form: one question, each answer leads to a calendar. */
export function routingPage(r: { slug: string; name: string; question: string; intro: string; color: string; options: { id: string; label: string; calendar_id: string }[] }, slugs: Record<string, string>, embed: boolean): string {
  const body = `
<main class="wrap tc" id="main"><div class="card">
  <h1 id="title" tabindex="-1">${escapeHtml(r.name)}</h1>
  ${r.intro ? `<p>${nl(r.intro)}</p>` : ''}
  ${noscriptNotice('weiterzugehen')}
  <form id="f" novalidate><fieldset><legend>${escapeHtml(r.question)}</legend>
    ${r.options.map((o, i) => `<label class="opt" for="o${i}"><input type="radio" name="o" id="o${i}" value="${escapeHtml(o.id)}" data-cal="${escapeHtml(slugs[o.calendar_id] ?? '')}"><span>${escapeHtml(o.label)}</span></label>`).join('')}
  </fieldset>
  <div class="nav"><button type="submit">Weiter</button></div><div class="error" id="err" role="alert"></div></form>
</div></main>${CSS}
<script>
document.getElementById('f').onsubmit = function (e) {
  e.preventDefault();
  var c = document.querySelector('input[name=o]:checked');
  if (!c) { document.getElementById('err').textContent = 'Bitte eine Antwort wählen.'; return; }
  var q = new URLSearchParams(location.search); var out = new URLSearchParams(); out.set('via', ${jsonForScript(r.slug)} + ':' + c.value);
  ['embed', 'ab', '_a', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref'].forEach(function (k) { if (q.get(k)) out.set(k, q.get(k)); });
  location.href = '/book/' + c.dataset.cal + '?' + out.toString();
};
</script>`;
  return publicPage({ title: r.name, body, color: r.color, embed });
}

/** The offer of a freed seat: a button that books it. */
export function waitlistPage(app: App, w: { token: string; start_at: string; status: string }, cal: CalendarRow, state: 'offer' | 'expired' | 'booked'): string {
  const body = `
<main class="wrap tc" id="main"><div class="card">
  <h1 id="title" tabindex="-1">${escapeHtml(cal.name)}</h1>
  <p><strong>${escapeHtml(formatInTz(w.start_at, cal.timezone))}</strong> <span class="muted">(${escapeHtml(cal.timezone)})</span></p>
  ${state === 'offer' ? `<p>Ein Platz ist frei geworden. Wer zuerst bucht, bekommt ihn.</p>${noscriptNotice('den Platz zu buchen')}<div class="nav"><button type="button" id="book">Platz jetzt buchen</button></div>` : state === 'booked' ? '<p class="ok">Du hast den Platz gebucht – die Bestätigung kommt per E-Mail.</p>' : '<p>Das Angebot ist abgelaufen oder wurde schon benutzt.</p>'}
  <p class="live" id="msg" role="status" aria-live="polite"></p>
</div></main>${CSS}
<script>
var b = document.getElementById('book');
if (b) b.onclick = function () { b.disabled = true; fetch('/api/public/team-calendars/waitlist/' + ${jsonForScript(w.token)} + '/book', { method: 'POST' }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (x) { var m = document.getElementById('msg'); if (x.ok && x.j.checkout_url) { m.textContent = 'Weiter zur Zahlung …'; location.href = x.j.checkout_url; } else if (x.ok) { m.textContent = 'Gebucht! Die Bestätigung kommt per E-Mail.'; if (x.j.manageUrl) { var a = document.createElement('a'); a.href = x.j.manageUrl; a.className = 'btn secondary'; a.textContent = 'Termin verwalten'; m.appendChild(document.createElement('br')); m.appendChild(a); } } else { b.disabled = false; m.textContent = x.j.error || 'Der Platz ist leider nicht mehr frei.'; m.style.color = '#b91c1c'; } }); };
</script>`;
  return publicPage({ title: 'Platz frei', body, color: cal.color });
}
