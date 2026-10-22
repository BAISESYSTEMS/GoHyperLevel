import type { App } from '../core/app.js';
import { jsonForScript, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney } from '../core/util.js';
import { contractHtml } from '../modules/contracts.js';
import { contactName, getContact } from './contacts.js';
import { deYmd, openCents, unitCode, UNITS } from './invoice-model.js';
import { loadInvoice } from './invoice-flow.js';
import { dueOnAccept, type QuoteRow } from './quote-engine.js';
import { isExpired, quoteTotals, resolveSelection, type QuoteItem, type Selection } from './quote-model.js';
import { discountText, lineAmounts } from './sales-lines.js';
import { ymdInTz } from '../core/time.js';

/**
 * The page a customer gets: the offer on one screen – positions, alternative options to choose from, optional positions to tick, a
 * total that follows the choice (the server calculates it, the page only asks), what is due at acceptance, and a signature field.
 * Everything the customer sees is rendered here; modules/quotes.ts only serves it. Prices on the page mean nothing at acceptance:
 * the server recalculates from the stored quote and the choice (quote-engine.acceptQuote).
 */

const e = escapeHtml;

const CSS = `
.q{max-width:860px;margin:0 auto;padding:28px 16px 64px}
.q *{box-sizing:border-box}
.q-head{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:18px}
.q-head img{max-height:44px;max-width:200px}
.q-meta{text-align:right;font-size:13px;color:var(--muted);line-height:1.5}
.q-meta strong{display:block;color:var(--text);font-size:15px}
.q-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:26px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.q-card h1{font-size:28px;line-height:1.2;margin:0 0 6px;overflow-wrap:anywhere;hyphens:auto}
.q-card h2{font-size:18px;margin:0 0 12px}
.q-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 12px;font-size:13px;font-weight:600;background:#eef2ff;color:#3730a3}
.q-badge.warn{background:#fffbeb;color:#92400e}.q-badge.bad{background:#fef2f2;color:#991b1b}.q-badge.good{background:#ecfdf5;color:#065f46}
.q-text{font-size:15px;color:#374151}.q-text p{margin:8px 0}.q-text h2,.q-text h3{margin:16px 0 6px}
.q-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.q-opt{position:relative;display:flex;flex-direction:column;gap:6px;border:2px solid var(--line);border-radius:14px;padding:16px 16px 14px;cursor:pointer;min-height:44px;background:#fff;font-weight:400;margin:0;transition:border-color .12s,box-shadow .12s}
.q-opt:hover{border-color:#c7d2fe}
.q-opt input{position:absolute;opacity:0;width:1px;height:1px}
.q-opt:has(input:checked){border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 18%,transparent)}
.q-opt:has(input:focus-visible){outline:3px solid var(--brand);outline-offset:2px}
.q-opt b{font-size:16px}.q-opt .q-price{font-size:20px;font-weight:700}.q-opt .q-sub{font-size:13px;color:var(--muted)}
.q-opt .q-rec{position:absolute;top:-11px;right:12px;background:var(--brand);color:#fff;border-radius:999px;font-size:11px;font-weight:700;padding:3px 10px;letter-spacing:.02em}
.q-tab{display:none}.q-tab.on{display:block}
.q-tbl{width:100%;border-collapse:collapse;font-size:14px}
.q-tbl th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);padding:8px 6px}
.q-tbl td{padding:12px 6px;border-bottom:1px solid #f3f4f6;vertical-align:top}
.q-tbl .r{text-align:right;white-space:nowrap}
.q-tbl .n{overflow-wrap:anywhere;hyphens:auto}
.q-tbl .n small{display:block;color:var(--muted);font-size:13px;margin-top:2px;white-space:pre-line}
.q-tbl .off{color:#047857;font-size:12px}
.q-tbl tr.opt td{background:#fafafa}
.q-pick{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:0;min-height:44px;cursor:pointer}
.q-pick input{width:22px;height:22px;margin-top:2px;flex:none}
.q-sec{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 4px}
.q-tot{margin-top:14px;margin-left:auto;max-width:380px;font-size:14px}
.q-tot div{display:flex;justify-content:space-between;gap:12px;padding:5px 0}
.q-tot .big{font-size:20px;font-weight:700;border-top:2px solid var(--text);margin-top:6px;padding-top:10px}
.q-tot .muted{color:var(--muted)}
.q-due{margin-top:14px;border-radius:12px;background:#f5f3ff;border:1px solid #ddd6fe;padding:12px 14px;font-size:14px}
.q-sign label{font-weight:600}
.q-sign canvas{width:100%;max-width:620px;height:180px;border:1px dashed #9ca3af;border-radius:10px;background:#fff;touch-action:none;display:block}
.q-sign .btn,.q-sign button{min-height:46px}
.q-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}
.q-actions .grow{flex:1 1 260px}
.q-btn2{background:#fff!important;color:var(--text)!important;border:1px solid var(--line)!important}
.q-foot{font-size:12px;color:var(--muted);text-align:center;margin-top:20px}
.q-ok{background:#ecfdf5;border:1px solid #a7f3d0;border-radius:14px;padding:20px}
.q-ok h2{color:#065f46}
@media (max-width:560px){.q{padding:16px 12px 48px}.q-card{padding:18px}.q-card h1{font-size:23px}.q-meta{text-align:left}.q-tbl .hide-s{display:none}}
@media print{body{background:#fff}.q-noprint{display:none!important}.q-card{box-shadow:none;border:0;padding:0}.q-tab{display:block!important}.q-opt:not(:has(input:checked)){display:none}}
`;

const qtyText = (it: QuoteItem) => `${String(it.qty).replace('.', ',')}${it.unit ? ` ${UNITS[unitCode(it.unit)] ?? ''}` : ''}`;

function rowsHtml(items: QuoteItem[], q: QuoteRow, selected: Selection, optionId = ''): string {
  const money = (c: number) => centsToMoney(c, q.currency);
  const ticked = new Set(selected.optional_ids);
  const row = (it: QuoteItem) => {
    const a = lineAmounts(it);
    const off = discountText(it, money);
    const name = `<b>${e(it.name)}</b>${it.description ? `<small>${e(it.description)}</small>` : ''}`;
    const cell = it.optional
      ? `<label class="q-pick"><input type="checkbox" class="q-optional" value="${e(it.id)}" data-option="${e(optionId)}"${ticked.has(it.id) ? ' checked' : ''}><span class="n">${name}<small>Optional – nach Wunsch dazunehmen</small></span></label>`
      : `<span class="n">${name}</span>`;
    return `<tr class="${it.optional ? 'opt' : ''}"><td class="n">${cell}</td><td class="r hide-s">${e(qtyText(it))}</td><td class="r hide-s">${money(it.price_cents)}</td><td class="r">${money(a.net_cents)}${off ? `<div class="off">– ${e(off)} Rabatt</div>` : ''}</td></tr>`;
  };
  return items.map(row).join('');
}

/** The sums box and what is due at acceptance for a choice – also what the preview endpoint answers with. */
export function totalsHtml(q: QuoteRow, sel: Selection): string {
  const money = (c: number) => centsToMoney(c, q.currency);
  const t = quoteTotals(q.doc, sel, q.tax_mode);
  const rows: string[] = [];
  if (t.discount_cents > 0) rows.push(`<div class="muted"><span>Positionen</span><span>${money(t.list_cents)}</span></div>`, `<div class="muted"><span>Rabatte</span><span>– ${money(t.discount_cents)}</span></div>`);
  rows.push(`<div><span>Summe netto</span><span>${money(t.subtotal_cents)}</span></div>`);
  for (const g of t.groups) if (g.rate > 0) rows.push(`<div class="muted"><span>Umsatzsteuer ${e(String(g.rate).replace('.', ','))} %</span><span>${money(g.tax_cents)}</span></div>`);
  rows.push(`<div class="big"><span>Gesamtbetrag</span><span>${money(t.total_cents)}</span></div>`);
  let due = '';
  try {
    const d = dueOnAccept(q, t);
    if (d) due = `<div class="q-due"><b>${d.kind === 'full' ? 'Mit der Annahme zahlbar' : `Bei Annahme fällig: ${e(d.label)}`}</b> – ${money(d.total_cents)}<br><span class="muted">Sie erhalten die Rechnung sofort per E-Mail und können gleich online bezahlen.</span></div>`;
  } catch {
    /* a deposit that does not fit this choice is caught when the quote is edited */
  }
  return `<div class="q-tot">${rows.join('')}</div>${due}`;
}

function seller(app: App, q: QuoteRow) {
  const loc = app.location(q.location_id)!;
  const logo = loc.logo_url ? `<img src="${e(loc.logo_url)}" alt="${e(loc.name)}">` : `<strong style="font-size:20px">${e(loc.name)}</strong>`;
  return { loc, logo };
}

function frame(app: App, q: QuoteRow, inner: string, head = ''): string {
  const { loc, logo } = seller(app, q);
  const body = `<div class="q"><div class="q-head"><div>${logo}</div><div class="q-meta"><strong>Angebot ${e(q.number)}</strong>${q.sent_at ? `vom ${e(deYmd(q.sent_at))}<br>` : ''}${q.valid_until ? `gültig bis ${e(deYmd(q.valid_until))}` : ''}</div></div>${inner}<div class="q-foot">${e(loc.name)}${loc.address ? ` · ${e(loc.address)}` : ''}${loc.email ? ` · <a href="mailto:${e(loc.email)}">${e(loc.email)}</a>` : ''}</div></div>`;
  return publicPage({ title: `Angebot ${q.number} – ${loc.name}`, body, head: `<style>${CSS}</style><meta name="robots" content="noindex">`, color: loc.settings?.branding?.color || undefined });
}

const notice = (title: string, text: string, kind = '') => `<div class="q-card"><h1>${e(title)}</h1><p class="q-badge ${kind}">${e(kind === 'bad' ? 'Nicht mehr verfügbar' : 'Status')}</p><p class="q-text">${e(text)}</p></div>`;

function acceptedPage(app: App, q: QuoteRow): string {
  const money = (c: number) => centsToMoney(c, q.currency);
  const contract = q.contract_id ? app.db.get<{ public_token: string }>('SELECT public_token FROM contracts WHERE id = ?', q.contract_id) : undefined;
  const inv = q.invoice_id ? loadInvoice(app, q.location_id, q.invoice_id) : undefined;
  const est = q.estimate_id ? loadInvoice(app, q.location_id, q.estimate_id) : undefined;
  const parts: string[] = [];
  if (inv && inv.status !== 'draft') {
    const label = inv.inv_type === 'partial' ? 'Anzahlungsrechnung' : 'Rechnung';
    const paid = inv.status === 'paid';
    // what is still open (a part payment or a credit note is not asked for again); cancelled or credited: nothing
    const open = inv.status === 'void' ? 0 : openCents(inv);
    const due = !paid && open > 0;
    parts.push(
      `<div class="q-card"><h2>${paid ? `${label} bezahlt` : `${label} ${e(inv.number)}`}</h2><p class="q-text">${paid ? 'Vielen Dank – Ihre Zahlung ist bei uns eingegangen.' : due ? `Offener Betrag: <b>${money(open)}</b>. Sie können gleich online bezahlen:` : 'Für diese Rechnung ist nichts mehr offen.'}</p>${due ? String(app.services.invoicePayHtml?.(inv) ?? '') : ''}<p><a class="btn q-btn2" href="/i/${e(inv.public_token)}">${due ? 'Rechnung ansehen / andere Zahlungswege' : 'Rechnung ansehen'}</a></p></div>`,
    );
  }
  const links = [
    contract ? `<a class="btn q-btn2" href="/s/${e(contract.public_token)}">Unterschriebene Kopie</a>` : '',
    est ? `<a class="btn q-btn2" href="/i/${e(est.public_token)}/pdf">Angebot als PDF</a>` : '',
  ].filter(Boolean);
  return frame(
    app,
    q,
    `<div class="q-card q-ok"><h2>Vielen Dank – das Angebot ist angenommen</h2><p class="q-text">Sie haben „${e(q.title)}“ am ${e(deYmd(q.accepted_at))} unterschrieben (${e(q.signer_name)}). Wir melden uns bei Ihnen.${q.accepted_total_cents ? ` Auftragswert: <b>${money(q.accepted_total_cents)}</b>.` : ''}</p>${links.length ? `<div class="q-actions">${links.join('')}</div>` : ''}</div>${parts.join('')}`,
  );
}

/** The page for the quote's token, whatever state it is in. */
export function quoteHtml(app: App, q: QuoteRow): string {
  const { loc } = seller(app, q);
  if (q.status === 'accepted') return acceptedPage(app, q);
  if (q.status === 'declined') return frame(app, q, notice('Angebot abgelehnt', 'Sie haben dieses Angebot abgelehnt. Wenn Sie es sich anders überlegen, melden Sie sich gern bei uns.'));
  if (q.status === 'void') return frame(app, q, notice('Angebot zurückgezogen', `Dieses Angebot wurde zurückgezogen${q.note ? ` (${q.note})` : ''}. Bitte melden Sie sich bei uns – wir senden Ihnen gern ein aktuelles.`, 'bad'));
  const today = ymdInTz(new Date(), loc.timezone || 'Europe/Berlin');
  if (q.status === 'expired' || isExpired(q.valid_until, today)) return frame(app, q, notice('Angebot abgelaufen', `Dieses Angebot war bis ${deYmd(q.valid_until)} gültig. Melden Sie sich bei uns – wir verlängern es gern oder machen ein neues.`, 'bad'));

  const sel = resolveSelection(q.doc);
  const contact = getContact(app, q.location_id, q.contact_id);
  const money = (c: number) => centsToMoney(c, q.currency);
  const many = q.doc.options.length > 1;
  const options = many
    ? `<div class="q-card"><h2>Wählen Sie Ihre Variante</h2><div class="q-opts" role="radiogroup" aria-label="Variante">${q.doc.options
        .map((o) => {
          const t = quoteTotals(q.doc, resolveSelection(q.doc, { option_id: o.id }), q.tax_mode);
          return `<label class="q-opt">${o.recommended ? '<span class="q-rec">EMPFOHLEN</span>' : ''}<input type="radio" name="option" value="${e(o.id)}"${o.id === sel.option_id ? ' checked' : ''}><b>${e(o.name)}</b>${o.description ? `<span class="q-sub">${e(o.description)}</span>` : ''}<span class="q-price">${money(t.subtotal_cents)} <span class="q-sub">netto</span></span></label>`;
        })
        .join('')}</div></div>`
    : '';
  const tbl = (id: string, items: QuoteItem[], title = '') =>
    items.length ? `${title ? `<div class="q-sec">${e(title)}</div>` : ''}<table class="q-tbl"><thead><tr><th>Position</th><th class="r hide-s">Menge</th><th class="r hide-s">Einzelpreis</th><th class="r">Betrag</th></tr></thead><tbody>${rowsHtml(items, q, sel, id)}</tbody></table>` : '';
  const optionTabs = q.doc.options.map((o) => `<div class="q-tab${o.id === sel.option_id ? ' on' : ''}" data-tab="${e(o.id)}">${tbl(o.id, o.items, many ? o.name : '')}</div>`).join('');

  const body = `
<div class="q-card">
  <h1>${e(q.title)}</h1>
  <p class="muted" style="margin:0 0 12px">Für ${e(contactName(contact))}</p>
  ${q.valid_until ? `<span class="q-badge warn">Gültig bis ${e(deYmd(q.valid_until))}</span>` : ''}
  ${q.intro.trim() ? `<div class="q-text" style="margin-top:14px">${contractHtml(q.intro)}</div>` : ''}
</div>
${options}
<div class="q-card">
  <h2>Ihr Angebot</h2>
  ${tbl('', q.doc.items)}
  ${optionTabs}
  <div id="q-totals">${totalsHtml(q, sel)}</div>
</div>
${q.terms.trim() ? `<div class="q-card"><h2>Bedingungen</h2><div class="q-text">${contractHtml(q.terms)}</div></div>` : ''}
<form id="q-form" class="q-card q-sign q-noprint" autocomplete="on">
  <h2>Annehmen und unterschreiben</h2>
  <label for="q-name">Vollständiger Name</label>
  <input id="q-name" name="name" required autocomplete="name" value="${e(contactName(contact) === 'Unbekannt' ? '' : [contact?.first_name, contact?.last_name].filter(Boolean).join(' '))}">
  <label style="margin-top:14px">Unterschrift <span class="muted" style="font-weight:400">(mit Maus oder Finger zeichnen)</span></label>
  <canvas id="q-pad" width="620" height="180" aria-label="Unterschriftsfeld"></canvas>
  <p style="margin:8px 0"><button type="button" class="btn q-btn2" id="q-clear">Löschen</button></p>
  <label class="check" style="margin-top:10px"><input type="checkbox" id="q-agree" required> <span>Ich habe das Angebot gelesen und nehme es mit meiner elektronischen Unterschrift verbindlich an.</span></label>
  <div class="q-actions"><button type="submit" class="grow" id="q-go">Verbindlich annehmen und unterschreiben</button><button type="button" class="btn q-btn2" id="q-no">Ablehnen</button><button type="button" class="btn q-btn2" onclick="print()">Drucken / als PDF</button></div>
  <div class="error" id="q-err" role="alert"></div>
</form>
<script>
(function(){
  var T=${jsonForScript(q.public_token)};
  var form=document.getElementById('q-form'),err=document.getElementById('q-err'),tot=document.getElementById('q-totals');
  function pick(){
    var r=document.querySelector('input[name=option]:checked');var opt=r?r.value:'';
    var ids=[].slice.call(document.querySelectorAll('.q-optional')).filter(function(c){return c.checked&&(c.dataset.option===''||c.dataset.option===opt)}).map(function(c){return c.value});
    return {option_id:opt||null,optional_ids:ids};
  }
  function tabs(){var r=document.querySelector('input[name=option]:checked');[].slice.call(document.querySelectorAll('.q-tab')).forEach(function(t){t.classList.toggle('on',!r||t.dataset.tab===r.value)})}
  var seq=0;
  async function preview(){
    tabs();var n=++seq;
    try{var res=await fetch('/api/public/quotes/'+T+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(pick())});var j=await res.json();if(n===seq&&res.ok)tot.innerHTML=j.html}catch(x){}
  }
  document.addEventListener('change',function(e){if(e.target.name==='option'||(e.target.classList&&e.target.classList.contains('q-optional')))preview()});
  tabs();
  var cv=document.getElementById('q-pad'),x=cv.getContext('2d'),draw=false,ink=false;
  x.lineWidth=2.4;x.lineCap='round';x.lineJoin='round';x.strokeStyle='#111';
  function pos(e){var r=cv.getBoundingClientRect();return [(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height]}
  cv.addEventListener('pointerdown',function(e){draw=true;cv.setPointerCapture(e.pointerId);var p=pos(e);x.beginPath();x.moveTo(p[0],p[1])});
  cv.addEventListener('pointermove',function(e){if(!draw)return;var p=pos(e);x.lineTo(p[0],p[1]);x.stroke();ink=true});
  cv.addEventListener('pointerup',function(){draw=false});
  document.getElementById('q-clear').onclick=function(){x.clearRect(0,0,cv.width,cv.height);ink=false};
  async function post(path,data){var r=await fetch('/api/public/quotes/'+T+'/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});var j=await r.json();if(!r.ok)throw new Error(j.error||'Fehler');return j}
  form.onsubmit=async function(e){
    e.preventDefault();err.textContent='';
    if(!ink){err.textContent='Bitte unterschreiben.';return}
    var b=document.getElementById('q-go');b.disabled=true;
    try{var d=pick();d.name=form.name.value;d.agree=document.getElementById('q-agree').checked;d.signature=cv.toDataURL('image/png');await post('accept',d);location.reload()}
    catch(x){err.textContent=x.message;b.disabled=false}
  };
  document.getElementById('q-no').onclick=async function(){var why=prompt('Angebot ablehnen – möchten Sie uns einen Grund nennen? (optional)');if(why===null)return;try{await post('decline',{reason:why});location.reload()}catch(x){err.textContent=x.message}};
})();
</script>`;
  return frame(app, q, body);
}
