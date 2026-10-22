import type { App, Module } from '../core/app.js';
import { HttpError, html, notFound, redirect, type Ctx } from '../core/http.js';
import { jsonForScript, messagePage, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { centsToMoney } from '../core/util.js';
import { getSession, refreshSession } from '../services/pay-registry.js';
import { afterConfirmed, cleanBuyer, orderByToken, orderUrl, placeOrder, startPayment, ticketUrl, ticketsOfOrder, typesWithState, type OrderRow } from '../services/ticket-events-core.js';
import type { TicketEventRow } from '../services/ticket-events-model.js';
import { renderQr } from './qr.js';

/**
 * The buyer's side of event tickets (docs/booking.md#ticket-types): `/book/event/<slug>` (pick ticket types and quantities, name
 * and e-mail – a plain form, works without JavaScript), `/book/event-order/<token>` (the order with every ticket's QR code, "Jetzt
 * bezahlen" while open) and `/book/event-ticket/<token>` (one ticket: type, QR code, code, team check-in). JSON for own front ends:
 * `GET /api/public/ticket-events/:slug`, `POST /api/public/ticket-events/:slug/order`.
 */

const hits = new Map<string, number[]>();
function throttled(key: string, max: number, windowMs = 10 * 60_000): boolean {
  const t = Date.now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  hits.set(key, list);
  if (hits.size > 20_000) hits.clear();
  return list.length > max;
}

const noIndex = '<meta name="robots" content="noindex">';

export const ticketEventsPublicModule: Module = {
  name: 'ticket-events-public',
  register(app: App) {
    const { db, router } = app;
    const activeEvent = (slug: string) => db.get<TicketEventRow>('SELECT * FROM tix_events WHERE slug = ? AND active = 1', slug);
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';
    const money = (c: number, cur: string) => (c ? centsToMoney(c, cur) : 'kostenlos');
    const page = (ev: TicketEventRow, title: string, body: string, status = 200) => {
      const r = html(publicPage({ title, body, color: app.location(ev.location_id)?.settings?.branding?.color || undefined, head: noIndex }), status);
      r.headers['cache-control'] = 'no-store';
      return r;
    };

    /** Places the order and says where the buyer goes: the tickets (free) or the payment. */
    async function order(ctx: Ctx, ev: TicketEventRow) {
      if (throttled(`${ctx.ip}:${ev.id}`, 40)) throw new HttpError(429, 'Zu viele Bestellungen – bitte später noch einmal versuchen');
      const b = ctx.body ?? {};
      const buyer = cleanBuyer(b);
      const o = placeOrder(app, ev, b, buyer);
      if (o.status === 'paid') {
        afterConfirmed(app, ev, o);
        return { o, next: orderUrl(app, o) };
      }
      return { o, next: await startPayment(app, ev, o) };
    }
    const ticketsOut = (o: OrderRow) => ticketsOfOrder(app, o.id).map((t) => ({ id: t.id, type: t.type_name, type_id: t.type_id, code: t.code, status: t.status, url: ticketUrl(app, t.token) }));

    function eventPage(ev: TicketEventRow, error = '', values: Record<string, any> = {}, status = 200) {
      const loc = app.location(ev.location_id)!;
      const types = typesWithState(app, ev).filter((t) => t.state !== 'inactive');
      const onSale = types.some((t) => t.max_pick > 0);
      const rows = types
        .map((t) => {
          const note = t.state === 'on_sale' ? (t.left !== null && t.left <= 10 ? `noch ${t.left}` : '') : t.state === 'not_yet' && t.sale_start ? `Verkauf ab ${formatInTz(t.sale_start, tzOf(ev.location_id))} Uhr` : t.state_label;
          const opts = Array.from({ length: t.max_pick + 1 }, (_, i) => `<option value="${i}"${Number(values[`qty_${t.id}`] ?? 0) === i ? ' selected' : ''}>${i}</option>`).join('');
          return `<tr><td><strong>${escapeHtml(t.name)}</strong>${t.description ? `<br><span class="muted" style="font-size:14px">${escapeHtml(t.description)}</span>` : ''}${note ? `<br><span class="muted" style="font-size:13px">${escapeHtml(note)}</span>` : ''}</td>
<td style="white-space:nowrap">${escapeHtml(money(t.price_cents, ev.currency))}</td>
<td style="width:90px">${t.max_pick > 0 ? `<label for="q_${escapeHtml(t.id)}" style="position:absolute;left:-9999px">Anzahl ${escapeHtml(t.name)}</label><select id="q_${escapeHtml(t.id)}" name="qty_${escapeHtml(t.id)}">${opts}</select>` : '–'}</td></tr>`;
        })
        .join('');
      const body = `<div class="wrap" style="max-width:640px"><div class="card">
<p class="muted" style="margin:0">${escapeHtml(loc.name)}</p>
<h1>${escapeHtml(ev.name)}</h1>
<p style="margin:0 0 4px"><strong>${escapeHtml(formatInTz(ev.starts_at, tzOf(ev.location_id)))} Uhr</strong>${ev.venue ? ` · ${escapeHtml(ev.venue)}` : ''}</p>
${ev.description ? `<p class="muted" style="white-space:pre-line">${escapeHtml(ev.description)}</p>` : ''}
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
${
  types.length
    ? `<form method="post" action="/book/event/${escapeHtml(ev.slug)}">
<table><thead><tr><th>Ticket</th><th>Preis</th><th>Anzahl</th></tr></thead><tbody>${rows}</tbody></table>
${
  onSale
    ? `<label for="tn">Name</label><input id="tn" name="name" autocomplete="name" required maxlength="200" value="${escapeHtml(String(values.name ?? ''))}">
<label for="te">E-Mail</label><input id="te" name="email" type="email" autocomplete="email" required maxlength="200" value="${escapeHtml(String(values.email ?? ''))}">
<p class="muted" style="font-size:13px">Deine Tickets mit QR-Code bekommst du per E-Mail und auf der nächsten Seite.</p>
<button type="submit" style="width:100%">Tickets bestellen</button>`
    : '<p class="muted">Gerade sind keine Tickets im Verkauf.</p>'
}
</form>`
    : '<p class="muted">Für dieses Event gibt es noch keine Tickets.</p>'
}
</div></div>`;
      return page(ev, ev.name, body, status);
    }

    router.get('/book/event/:slug', 'public', (ctx) => {
      const ev = activeEvent(ctx.params.slug);
      if (!ev) return html(messagePage('Nicht gefunden', 'Dieses Event gibt es nicht (mehr).'), 404);
      return eventPage(ev);
    });
    router.post('/book/event/:slug', 'public', async (ctx) => {
      const ev = activeEvent(ctx.params.slug);
      if (!ev) return html(messagePage('Nicht gefunden', 'Dieses Event gibt es nicht (mehr).'), 404);
      try {
        const r = await order(ctx, ev);
        return redirect(r.next, 303);
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) return eventPage(ev, e.message, ctx.body ?? {}, e.status);
        throw e;
      }
    });

    router.get('/api/public/ticket-events/:slug', 'public', (ctx) => {
      const ev = activeEvent(ctx.params.slug);
      if (!ev) throw notFound('Event nicht gefunden');
      return {
        name: ev.name,
        starts_at: ev.starts_at,
        ends_at: ev.ends_at,
        venue: ev.venue,
        description: ev.description,
        currency: ev.currency,
        types: typesWithState(app, ev)
          .filter((t) => t.state !== 'inactive')
          .map((t) => ({ id: t.id, name: t.name, description: t.description, price_cents: t.price_cents, state: t.state, left: t.left, max_per_order: t.max_pick, sale_start: t.sale_start, sale_end: t.sale_end })),
      };
    });
    router.post('/api/public/ticket-events/:slug/order', 'public', async (ctx) => {
      const ev = activeEvent(ctx.params.slug);
      if (!ev) throw notFound('Event nicht gefunden');
      const { o, next } = await order(ctx, ev);
      return { status: o.status, order_token: o.token, order_url: orderUrl(app, o), total_cents: o.total_cents, currency: o.currency, pay_url: o.status === 'pending' ? next : null, tickets: ticketsOut(o) };
    });

    router.get('/book/event-order/:token', 'public', async (ctx) => {
      let o = orderByToken(app, ctx.params.token);
      if (!o) return html(messagePage('Nicht gefunden', 'Diese Bestellung gibt es nicht.'), 404);
      // Back from the provider before its webhook: ask once in a while.
      if (o.status === 'pending' && o.pay_session_id && !throttled(`ord:${ctx.ip}`, 120)) {
        const s = getSession(app, o.pay_session_id);
        if (s && s.provider_ref) await refreshSession(app, s).catch((e) => console.error('[tickets] refresh', (e as Error).message));
        o = orderByToken(app, ctx.params.token)!;
      }
      const ev = db.get<TicketEventRow>('SELECT * FROM tix_events WHERE id = ?', o.event_id)!;
      const s = o.pay_session_id ? getSession(app, o.pay_session_id) : undefined;
      const tickets = ticketsOfOrder(app, o.id);
      let list = '';
      if (o.status === 'paid') {
        const cards = await Promise.all(
          tickets.map(async (t) => {
            const svg = String(await renderQr(ticketUrl(app, t.token), { format: 'svg', size: 180, margin: 2, ec: 'M', fg: '#111827', bg: '#ffffff' }));
            return `<div style="border:1px solid var(--line);border-radius:12px;padding:12px;text-align:center;margin:10px 0"><strong>${escapeHtml(t.type_name)}</strong>
<div style="display:inline-block;background:#fff;padding:6px;margin-top:6px" role="img" aria-label="QR-Code: ${escapeHtml(t.type_name)}">${svg}</div>
<p style="font-family:ui-monospace,monospace;font-size:18px;letter-spacing:2px;margin:6px 0">${escapeHtml(t.code)}</p>
<a href="/book/event-ticket/${encodeURIComponent(t.token)}">Einzelnes Ticket öffnen</a></div>`;
          }),
        );
        list = cards.join('');
      }
      const state =
        o.status === 'paid'
          ? '<p class="ok">Deine Tickets sind bestätigt. Zeig beim Einlass den QR-Code oder den Code.</p>'
          : o.status === 'pending'
            ? s?.status === 'pending'
              ? '<p>Deine Zahlung wird bearbeitet. Sobald sie bestätigt ist, bekommst du deine Tickets per E-Mail.</p>'
              : `<p>Die Zahlung steht noch aus – die Tickets sind bis ${escapeHtml(formatInTz(o.expires_at, tzOf(o.location_id), { weekday: undefined }))} Uhr für dich reserviert.</p>${s && s.status === 'open' ? `<p><a class="btn" href="/pay/${escapeHtml(s.id)}">Jetzt bezahlen</a></p>` : ''}`
            : `<p class="muted">Diese Bestellung ist ${o.status === 'refunded' ? 'erstattet' : 'abgelaufen oder abgebrochen'}.</p><p><a class="btn secondary" href="/book/event/${escapeHtml(ev.slug)}">Neu bestellen</a></p>`;
      const body = `<div class="wrap" style="max-width:520px"><div class="card">
<p class="muted" style="margin:0">${escapeHtml(app.location(o.location_id)?.name ?? '')}</p>
<h1>${escapeHtml(ev.name)}</h1>
<p style="margin:0 0 10px"><strong>${escapeHtml(formatInTz(ev.starts_at, tzOf(o.location_id)))} Uhr</strong>${ev.venue ? ` · ${escapeHtml(ev.venue)}` : ''}</p>
${state}
<p class="muted">${tickets.length} Ticket(s) · ${escapeHtml(money(o.total_cents, o.currency))}</p>
${list}
</div></div>`;
      return page(ev, `Tickets: ${ev.name}`, body);
    });

    router.get('/book/event-ticket/:token', 'public', async (ctx) => {
      const t = db.get<any>(
        `SELECT t.*, y.name AS type_name, e.name AS event_name, e.starts_at, e.venue, e.location_id AS loc, o.name AS holder FROM tix_tickets t
         JOIN tix_types y ON y.id = t.type_id JOIN tix_events e ON e.id = t.event_id JOIN tix_orders o ON o.id = t.order_id WHERE t.token = ?`,
        ctx.params.token,
      );
      if (!t || t.status === 'held') return html(messagePage('Nicht gefunden', 'Dieses Ticket gibt es nicht (oder es ist noch nicht bezahlt).'), 404);
      const ev = db.get<TicketEventRow>('SELECT * FROM tix_events WHERE id = ?', t.event_id)!;
      const tz = tzOf(t.loc);
      const svg = String(await renderQr(ticketUrl(app, t.token), { format: 'svg', size: 260, margin: 2, ec: 'M', fg: '#111827', bg: '#ffffff' }));
      const state = t.status !== 'valid' ? '<p class="error">Dieses Ticket wurde storniert.</p>' : t.checked_in_at ? `<p class="muted">Eingecheckt am ${escapeHtml(formatInTz(t.checked_in_at, tz))} Uhr</p>` : '';
      const team =
        t.status === 'valid'
          ? `<details style="margin-top:14px;text-align:left"><summary class="muted" style="cursor:pointer;font-size:13px">Für das Team: einchecken</summary><p class="muted" style="font-size:13px">Angemeldet mit dem Team-Konto (im selben Browser) checkst du hier ein.</p><button type="button" id="ci">Einchecken</button><p id="ci-msg" role="status"></p></details>
<script>(function(){var b=document.getElementById('ci');if(!b)return;b.onclick=function(){var m=document.getElementById('ci-msg');m.textContent='';fetch('/api/ticket-events/checkin',{method:'POST',headers:{'content-type':'application/json','x-pghl':'1','x-location-id':${jsonForScript(t.loc)}},body:JSON.stringify({code:${jsonForScript(t.token)}})}).then(function(r){return r.json().then(function(j){if(r.status===401)throw new Error('Bitte zuerst in HyperLevel anmelden.');if(!r.ok)throw new Error(j.error||'Fehler');m.textContent=(j.status==='already'?'Schon eingecheckt: ':'Eingecheckt ✓ ')+(j.type||'')+' · '+(j.name||'')})}).catch(function(e){m.textContent=e.message})}})();</script>`
          : '';
      const body = `<div class="wrap" style="max-width:420px"><div class="card" style="text-align:center">
  <p class="muted" style="margin:0">${escapeHtml(app.location(t.loc)?.name ?? '')}</p>
  <h1 style="margin:6px 0 4px">${escapeHtml(t.event_name)}</h1>
  <p style="margin:0 0 6px"><strong>${escapeHtml(formatInTz(t.starts_at, tz))} Uhr</strong>${t.venue ? `<br>${escapeHtml(t.venue)}` : ''}</p>
  <p style="margin:0 0 12px;font-size:18px"><strong>${escapeHtml(t.type_name)}</strong>${t.holder ? ` · ${escapeHtml(t.holder)}` : ''}</p>
  <div style="display:inline-block;background:#fff;padding:8px;border-radius:12px" role="img" aria-label="QR-Code des Tickets">${svg}</div>
  <p style="font-family:ui-monospace,monospace;font-size:20px;letter-spacing:2px;margin:10px 0 4px">${escapeHtml(t.code)}</p>
  <p class="muted" style="font-size:13px;margin:0">Zeig diesen Code beim Einlass.</p>
  ${state}
  ${team}
</div></div>`;
      return page(ev, `Ticket: ${t.event_name}`, body);
    });
  },
};
