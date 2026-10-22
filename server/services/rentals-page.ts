import type { App } from '../core/app.js';
import { jsonForScript, noscriptNotice, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney } from '../core/util.js';
import type { CalendarRow } from '../modules/calendars.js';
import type { BookingRow, RentalRow } from './rentals-book.js';
import { rangeText } from './rentals-model.js';

/**
 * Public pages of the Vermietung (docs/booking.md#rentals): the booking page with a date-range picker (`/book/rent/<slug>`, also the
 * calendar's own `/book/<slug>`), the page after paying, and the booking's own page (cancel until the start).
 */

const CSS = `<style>
.rg-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:16px 0 8px; }
.rg-head h2 { margin:0; font-size:18px; }
.rg-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; }
.rg-dow { text-align:center; font-size:12px; color:var(--muted); padding:2px 0; }
.rg-day { padding:6px 0; border-radius:8px; border:1px solid var(--line); background:#fff; color:var(--text); font-weight:600; font-size:14px; line-height:1.15; }
.rg-day small { display:block; font-weight:400; font-size:11px; color:var(--muted); }
.rg-day[disabled] { opacity:.35; }
.rg-day.in { background:color-mix(in srgb, var(--brand) 18%, #fff); border-color:var(--brand); }
.rg-day.edge { background:var(--brand); color:#fff; } .rg-day.edge small { color:#fff; }
.rg-sum { margin:14px 0 0; padding:12px 14px; border-radius:10px; background:var(--bg); }
.rg-nav { padding:6px 12px; }
</style>`;

export function rentalBookingPage(app: App, cal: CalendarRow, r: RentalRow, embed: boolean) {
  const loc = app.location(cal.location_id)!;
  const per = r.unit === 'night' ? 'pro Nacht' : 'pro Tag';
  const cfg = { slug: cal.slug, unit: r.unit, quantity: r.quantity, currency: r.currency, price: r.price_cents, deposit: r.deposit_cents, min: r.min_units, max: r.max_units, redirect: cal.settings.redirect_url || '' };
  const body = `${CSS}<div class="wrap"><div class="card">
  <p class="muted" style="margin:0 0 4px">${escapeHtml(loc.name)}</p>
  <h1>${escapeHtml(cal.name)}</h1>
  <p class="muted">${r.price_cents ? `${escapeHtml(centsToMoney(r.price_cents, r.currency))} ${per}` : 'kostenlos'}${r.deposit_cents ? ` · Kaution ${escapeHtml(centsToMoney(r.deposit_cents, r.currency))}${r.quantity > 1 ? ' je Stück' : ''}` : ''}${r.min_units > 1 ? ` · mindestens ${r.min_units} ${r.unit === 'night' ? 'Nächte' : 'Tage'}` : ''}</p>
  ${cal.description ? `<p>${escapeHtml(cal.description).replace(/\n/g, '<br>')}</p>` : ''}
  ${noscriptNotice('zu buchen')}
  <div class="row">
    <div><label for="rg-from">${r.unit === 'night' ? 'Anreise' : 'Erster Tag'}</label><input id="rg-from" type="date"></div>
    <div><label for="rg-to">${r.unit === 'night' ? 'Abreise' : 'Letzter Tag'}</label><input id="rg-to" type="date"></div>
    ${r.quantity > 1 ? `<div><label for="rg-qty">Anzahl</label><select id="rg-qty"></select></div>` : ''}
  </div>
  <div class="rg-head"><button type="button" class="btn secondary rg-nav" id="rg-prev" aria-label="Vorheriger Monat">←</button><h2 id="rg-month" aria-live="polite"></h2><button type="button" class="btn secondary rg-nav" id="rg-next" aria-label="Nächster Monat">→</button></div>
  <div class="rg-grid" id="rg-grid" role="grid" aria-label="Freie Tage"></div>
  <p class="muted" style="font-size:13px;margin:6px 0 0">${r.unit === 'night' ? 'Anreise und Abreise antippen. Die Zahl zeigt, wie viele für diese Nacht frei sind.' : 'Ersten und letzten Tag antippen. Die Zahl zeigt, wie viele an dem Tag frei sind.'}</p>
  <div class="rg-sum" id="rg-sum" aria-live="polite">Bitte einen Zeitraum wählen.</div>
  <form id="rg-form" hidden>
    <div class="row"><div><label for="rg-fn">Vorname *</label><input id="rg-fn" name="first_name" required autocomplete="given-name"></div><div><label for="rg-ln">Nachname</label><input id="rg-ln" name="last_name" autocomplete="family-name"></div></div>
    <label for="rg-em">E-Mail *</label><input id="rg-em" name="email" type="email" required autocomplete="email">
    ${cal.settings.ask_phone === false ? '' : '<label for="rg-ph">Telefon</label><input id="rg-ph" name="phone" type="tel" autocomplete="tel">'}
    ${cal.settings.ask_notes === false ? '' : '<label for="rg-no">Anmerkung</label><textarea id="rg-no" name="notes"></textarea>'}
    <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <label class="check"><input type="checkbox" name="consent" required> Ich bin einverstanden, dass meine Angaben zur Buchung gespeichert werden.</label>
    <p><button type="submit" id="rg-go">Verbindlich buchen</button></p>
  </form>
  <p class="error" id="rg-err" role="alert"></p>
  <div id="rg-done" class="ok" role="status" hidden></div>
</div></div>
<script>
(function(){
  var C=${jsonForScript(cfg)},$=function(i){return document.getElementById(i)},avail={},win=null,from='',to='',month='',seq=0;
  function h(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function money(c){return (c/100).toLocaleString('de-DE',{style:'currency',currency:C.currency||'EUR'})}
  function add(ymd,n){var d=new Date(ymd+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
  function api(p,o){return fetch('/api/public/rentals/'+C.slug+p,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Fehler');return j})})}
  function qty(){var q=$('rg-qty');return q?+q.value||1:1}
  if($('rg-qty')){for(var i=1;i<=C.quantity;i++){var o=document.createElement('option');o.value=i;o.textContent=i;$('rg-qty').appendChild(o)}$('rg-qty').onchange=sum}
  function load(m){month=m;var first=m+'-01',dow=(new Date(first+'T00:00:00Z').getUTCDay()+6)%7,start=add(first,-dow);
    $('rg-month').textContent=new Date(first+'T12:00:00Z').toLocaleDateString('de-DE',{month:'long',year:'numeric',timeZone:'UTC'});
    api('/availability?from='+start+'&days=42').then(function(j){win=j;j.days.forEach(function(d){avail[d.date]=d.free});draw(start)}).catch(function(e){$('rg-err').textContent=e.message})}
  function draw(start){var g=$('rg-grid'),out='';['Mo','Di','Mi','Do','Fr','Sa','So'].forEach(function(x){out+='<div class="rg-dow" role="columnheader">'+x+'</div>'});
    for(var i=0;i<42;i++){var d=add(start,i),f=avail[d],inM=d.slice(0,7)===month,past=!win||d<win.today||d>win.last_day;
      var pick=!!from&&!to&&d>from&&C.unit==='night';
      var off=!inM||(past&&!pick)||(!pick&&!f);
      var cls='rg-day'+(from&&d===from||to&&d===last()?' edge':'')+(from&&to&&d>from&&d<last()?' in':'');
      out+='<button type="button" role="gridcell" class="'+cls+'" data-d="'+d+'"'+(off?' disabled':'')+' aria-pressed="'+(cls.indexOf('edge')>0)+'" aria-label="'+h(new Date(d+'T12:00:00Z').toLocaleDateString('de-DE',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}))+(f?', '+f+' frei':', nichts frei')+'">'+(+d.slice(8))+(inM&&!past?'<small>'+(f||0)+'</small>':'')+'</button>'}
    g.innerHTML=out;g.querySelectorAll('[data-d]').forEach(function(b){b.onclick=function(){tap(b.getAttribute('data-d'))}})}
  function last(){return to}
  function tap(d){if(!from||to||d<from||(C.unit==='night'&&d===from)){from=d;to=''}else{to=d}
    $('rg-from').value=from;$('rg-to').value=to;redraw();sum()}
  function redraw(){var first=month+'-01',dow=(new Date(first+'T00:00:00Z').getUTCDay()+6)%7;draw(add(first,-dow))}
  $('rg-from').onchange=function(){from=this.value;if(to&&to<from)to='';$('rg-to').value=to;if(from)load(from.slice(0,7));sum()};
  $('rg-to').onchange=function(){to=this.value;redraw();sum()};
  $('rg-prev').onclick=function(){var p=month.split('-').map(Number);load(new Date(Date.UTC(p[0],p[1]-2,1)).toISOString().slice(0,7))};
  $('rg-next').onclick=function(){var p=month.split('-').map(Number);load(new Date(Date.UTC(p[0],p[1],1)).toISOString().slice(0,7))};
  function sum(){$('rg-err').textContent='';if(!from||!to){$('rg-sum').textContent=from?(C.unit==='night'?'Jetzt die Abreise wählen.':'Jetzt den letzten Tag wählen (oder denselben Tag noch einmal).'):'Bitte einen Zeitraum wählen.';$('rg-form').hidden=true;return}
    var n=++seq;api('/quote?from='+from+'&to='+to+'&qty='+qty()).then(function(q){if(n!==seq)return;
      var t='<strong>'+h(q.text)+'</strong>'+(q.qty>1?' · '+q.qty+' Stück':'');
      if(q.total_cents)t+='<br>'+money(q.rent_cents)+(q.deposit_cents?' + Kaution '+money(q.deposit_cents)+' = <strong>'+money(q.total_cents)+'</strong>':'');
      if(!q.ok)t+='<br><span class="error">'+h(q.problem)+'</span>';
      $('rg-sum').innerHTML=t;$('rg-form').hidden=!q.ok;$('rg-go').textContent=q.total_cents?'Weiter zur Zahlung':'Verbindlich buchen'}).catch(function(e){$('rg-sum').textContent=e.message;$('rg-form').hidden=true})}
  $('rg-form').onsubmit=function(e){e.preventDefault();var f=e.target,b=$('rg-go');b.disabled=true;$('rg-err').textContent='';
    var data={from:from,to:to,qty:qty(),first_name:f.first_name.value,last_name:f.last_name.value,email:f.email.value,phone:f.phone?f.phone.value:'',notes:f.notes?f.notes.value:'',consent:f.consent.checked,website:f.website.value};
    api('/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(function(r){b.disabled=false;
      if(r.status==='payment_required'){location.href=r.checkout_url;return}
      if(C.redirect){location.href=C.redirect;return}
      f.hidden=true;$('rg-done').hidden=false;$('rg-done').innerHTML='<strong>Gebucht!</strong><br>'+h(r.booking.text)+(r.booking.qty>1?' · '+r.booking.qty+' Stück':'')+'<br>Die Bestätigung kommt per E-Mail. <a href="'+h(r.ics_url)+'">In den Kalender</a> · <a href="'+h(r.manage_url)+'">Buchung ansehen oder absagen</a>'})
      .catch(function(e2){b.disabled=false;$('rg-err').textContent=e2.message;load(month)})};
  fetch('/api/public/rentals/'+C.slug).then(function(r){return r.json()}).then(function(j){load((j.today||new Date().toISOString()).slice(0,7))});
})();
</script>`;
  return publicPage({ title: `${cal.name} – ${loc.name}`, body, color: cal.color, embed });
}

const statusText: Record<BookingRow['status'], string> = { pending: 'wartet auf die Zahlung', confirmed: 'bestätigt', expired: 'Reservierung abgelaufen', refunded: 'erstattet', cancelled: 'abgesagt' };

/** After the pay page: paid → booked; still open → the reservation's time; lapsed → book again. */
export function rentalPaidPage(app: App, cal: CalendarRow, r: RentalRow, b: BookingRow, cancelled: boolean) {
  const appt = b.appointment_id ? app.db.get<any>('SELECT manage_token FROM appointments WHERE id = ?', b.appointment_id) : undefined;
  const what = `${escapeHtml(cal.name)}${b.qty > 1 ? ` ×${b.qty}` : ''} · ${escapeHtml(rangeText(r.unit, { from: b.from_date, to: b.to_date, units: b.units }))}`;
  const inner =
    b.status === 'confirmed'
      ? `<h1>Bezahlt und gebucht</h1><p>${what}</p><p>Die Bestätigung kommt per E-Mail.</p>${appt ? `<p><a class="btn secondary" href="/book/ics/${escapeHtml(appt.manage_token)}">In den Kalender</a> <a class="btn secondary" href="/book/manage/${escapeHtml(appt.manage_token)}">Buchung ansehen</a></p>` : ''}`
      : b.status === 'pending'
        ? `<h1>${cancelled ? 'Zahlung abgebrochen' : 'Zahlung wird geprüft'}</h1><p>${what}</p><p class="muted">${cancelled ? 'Der Zeitraum bleibt noch kurz für dich reserviert.' : 'Das dauert meist nur einen Moment – diese Seite lädt gleich neu.'}</p>${cancelled ? `<p><a class="btn" href="/book/rent/${escapeHtml(cal.slug)}">Zurück zur Buchung</a></p>` : '<script>setTimeout(function(){location.reload()},4000)</script>'}`
        : `<h1>Nicht gebucht</h1><p>${what}</p><p class="muted">Status: ${escapeHtml(statusText[b.status])}.</p><p><a class="btn" href="/book/rent/${escapeHtml(cal.slug)}">Neu buchen</a></p>`;
  return publicPage({ title: cal.name, body: `<div class="wrap"><div class="card">${inner}</div></div>`, color: cal.color });
}

/** The booking's own page (link in the confirmation): what, when, how many, paid; cancel until the start. */
export function rentalManagePage(app: App, a: any, cal: CalendarRow, r: RentalRow, b: BookingRow | undefined) {
  const cancelled = a.status === 'cancelled';
  const started = Date.parse(a.start_at) <= Date.now();
  const what = b ? escapeHtml(rangeText(r.unit, { from: b.from_date, to: b.to_date, units: b.units })) : '';
  const body = `<div class="wrap"><div class="card">
  <h1>${escapeHtml(cal.name)}${b && b.qty > 1 ? ` ×${b.qty}` : ''}</h1>
  <p>${what}</p>
  ${b?.total_cents ? `<p class="muted">${b.paid_at ? 'Bezahlt' : 'Betrag'}: ${escapeHtml(centsToMoney(b.total_cents, b.currency))}${b.deposit_cents ? ` (davon Kaution ${escapeHtml(centsToMoney(b.deposit_cents, b.currency))})` : ''}</p>` : ''}
  <p>Status: <strong>${cancelled ? 'abgesagt' : 'bestätigt'}</strong></p>
  ${cancelled ? `<a class="btn" href="/book/rent/${escapeHtml(cal.slug)}">Neu buchen</a>` : `${noscriptNotice('die Buchung abzusagen')}<div class="row"><a class="btn secondary" href="/book/ics/${escapeHtml(a.manage_token)}">In den Kalender</a>${started ? '' : '<button id="cancel" class="btn" type="button">Buchung absagen</button>'}</div>${b?.paid_at && !started ? '<p class="muted" style="font-size:13px">Bei einer Absage meldet sich das Team wegen der Erstattung.</p>' : ''}`}
  <p id="msg" class="muted" role="status"></p></div></div>
  <script>var b=document.getElementById('cancel');if(b)b.onclick=function(){if(!confirm('Buchung wirklich absagen?'))return;fetch('/api/public/appointments/${escapeHtml(a.manage_token)}/cancel',{method:'POST'}).then(function(r){if(r.ok)location.reload();else r.json().then(function(j){document.getElementById('msg').textContent=j.error||'Absagen ging nicht.'})})};</script>`;
  return publicPage({ title: 'Buchung verwalten', body, color: cal.color });
}
