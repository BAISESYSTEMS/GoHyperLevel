import type { App, Module } from '../core/app.js';
import { HttpError, bad, html, notFound, num, str } from '../core/http.js';
import { jsonForScript, messagePage, noscriptNotice, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { busyFor, computeSlots, type CalendarRow } from './calendars.js';
import type { Tool } from './mcp.js';
import { getConfig, membersOf, slotsOfDay } from '../services/teamcal-engine.js';
import { bookTeam, calendarById } from '../services/teamcal-book.js';

/**
 * Leistungsmenü (HighLevel "Service Menu" / services booking, docs/booking.md#service-menu): one public page `/book/s/<slug>` that
 * lists the sub-account's booking calendars as services in categories – name, description, duration, price – and walks the visitor
 * through service → person (round-robin calendars: "any" or a chosen team member) → day and time → details. Booking goes through the
 * team-calendar pipeline (`bookTeam` with `hostId`), so questions, consent, payment holds, video links, reminders and workflows are
 * the calendar's own. A service is a calendar; the menu only groups and presents them.
 */

const MAX_CATS = 20;
const MAX_ITEMS = 30;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

type Category = { name: string; calendar_ids: string[] };

const stamp = new Map<string, number[]>();
function throttled(ip: string, max = 15, windowMs = 10 * 60_000): boolean {
  const t = Date.now();
  const list = (stamp.get(ip) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  stamp.set(ip, list);
  if (stamp.size > 20_000) stamp.clear();
  return list.length > max;
}

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

export const SERVICE_MENU_TOOLS: Tool[] = [
  {
    name: 'ghl_service_menus',
    title: 'Leistungsmenüs (Buchung nach Leistung)',
    description: 'Die Leistungsmenüs eines Sub-Accounts: öffentliche Seiten /book/s/<slug>, auf denen Besucher eine Leistung (= ein Buchungskalender), dann eine Person und einen Termin wählen. Mit Kategorien, Leistungen (Name, Dauer, Preis) und Link.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', '/api/service-menus', { location: a.location_id }),
  },
  {
    name: 'ghl_service_menu_save',
    title: 'Leistungsmenü anlegen oder ändern',
    description: `Legt ein Leistungsmenü an (ohne menu_id) oder ändert es: Name, Kurzname für den Link, Einleitung und Kategorien mit den IDs der Buchungskalender (aus ghl_calendar_types; höchstens ${MAX_CATS} Kategorien mit je ${MAX_ITEMS} Leistungen). staff_choice=false blendet die Personenwahl aus.`,
    inputSchema: obj(
      {
        ...LOC,
        menu_id: { type: 'string', description: 'Vorhandenes Menü ändern' },
        name: { type: 'string' },
        slug: { type: 'string', description: 'Kurzname für /book/s/<slug> (a–z, 0–9, -)' },
        intro: { type: 'string' },
        staff_choice: { type: 'boolean' },
        active: { type: 'boolean' },
        categories: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, calendar_ids: { type: 'array', items: { type: 'string' } } }, required: ['name', 'calendar_ids'], additionalProperties: false } },
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const body = { name: a.name, slug: a.slug, intro: a.intro, staff_choice: a.staff_choice, active: a.active, categories: a.categories };
      const r = a.menu_id ? await call.api('PATCH', `/api/service-menus/${encodeURIComponent(a.menu_id)}`, { location: a.location_id, body }) : await call.api('POST', '/api/service-menus', { location: a.location_id, body });
      return { ...r, link: '/app/calendars' };
    },
  },
];

export const serviceMenuModule: Module = {
  name: 'service-menu',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE service_menus (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, intro TEXT NOT NULL DEFAULT '', categories TEXT NOT NULL DEFAULT '[]',
        staff_choice INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX service_menus_loc ON service_menus(location_id);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...SERVICE_MENU_TOOLS];

    const parseCats = (v: string): Category[] => {
      try {
        const x = JSON.parse(v);
        return Array.isArray(x) ? x : [];
      } catch {
        return [];
      }
    };
    const url = (m: any) => `${app.baseUrl()}/book/s/${m.slug}`;
    const out = (m: any) => ({ ...m, categories: parseCats(m.categories), staff_choice: !!m.staff_choice, active: !!m.active, url: url(m) });
    const load = (locationId: string, mid: string) => db.get<any>('SELECT * FROM service_menus WHERE id = ? AND location_id = ?', mid, locationId);

    function cleanCats(locationId: string, raw: unknown): Category[] {
      if (!Array.isArray(raw)) throw bad('Kategorien fehlen');
      if (raw.length > MAX_CATS) throw bad(`Höchstens ${MAX_CATS} Kategorien`);
      return raw.map((c: any, i) => {
        if (!c || typeof c !== 'object') throw bad(`Kategorie ${i + 1}: ungültig`);
        const ids: string[] = Array.isArray(c.calendar_ids) ? [...new Set<string>(c.calendar_ids.map(String))] : [];
        if (ids.length > MAX_ITEMS) throw bad(`Kategorie ${i + 1}: höchstens ${MAX_ITEMS} Leistungen`);
        for (const cid of ids) if (!db.get('SELECT 1 FROM calendars WHERE id = ? AND location_id = ?', cid, locationId)) throw bad(`Kategorie ${i + 1}: Kalender „${cid}“ gibt es nicht`);
        return { name: str(c.name, `Kategorie ${i + 1}: Name`, { required: true, max: 80 }), calendar_ids: ids as string[] };
      });
    }
    function cleanSlug(raw: unknown, except?: string): string {
      const slug = String(raw ?? '').trim().toLowerCase();
      if (!SLUG.test(slug)) throw bad('Kurzname: nur a–z, 0–9 und Bindestrich (bis 60 Zeichen)');
      if (db.get('SELECT 1 FROM service_menus WHERE slug = ? AND id != ?', slug, except ?? '')) throw new HttpError(409, 'Dieser Kurzname ist schon vergeben');
      return slug;
    }
    const slugify = (s: string) =>
      s
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'leistungen';

    router.get('/api/service-menus', 'location', (ctx) => db.all<any>('SELECT * FROM service_menus WHERE location_id = ? ORDER BY name', ctx.locationId).map(out));
    router.get('/api/service-menus/:id', 'location', (ctx) => {
      const m = load(ctx.locationId, ctx.params.id);
      if (!m) throw notFound();
      return out(m);
    });
    router.post('/api/service-menus', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const name = str(b.name, 'Name', { required: true, max: 120 });
      let slug = b.slug ? cleanSlug(b.slug) : '';
      if (!slug) {
        const base = slugify(name);
        slug = base;
        for (let i = 2; db.get('SELECT 1 FROM service_menus WHERE slug = ?', slug); i++) slug = `${base}-${i}`;
      }
      const row = {
        id: id(),
        location_id: ctx.locationId,
        slug,
        name,
        intro: str(b.intro, 'Einleitung', { max: 2000 }),
        categories: JSON.stringify(b.categories === undefined ? [] : cleanCats(ctx.locationId, b.categories)),
        staff_choice: b.staff_choice === false ? 0 : 1,
        active: b.active === false ? 0 : 1,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('service_menus', row);
      return out(row);
    });
    router.patch('/api/service-menus/:id', 'location', (ctx) => {
      const m = load(ctx.locationId, ctx.params.id);
      if (!m) throw notFound();
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 120 });
      if (b.slug !== undefined) patch.slug = cleanSlug(b.slug, m.id);
      if (b.intro !== undefined) patch.intro = str(b.intro, 'Einleitung', { max: 2000 });
      if (b.categories !== undefined) patch.categories = JSON.stringify(cleanCats(ctx.locationId, b.categories));
      if (b.staff_choice !== undefined) patch.staff_choice = b.staff_choice ? 1 : 0;
      if (b.active !== undefined) patch.active = b.active ? 1 : 0;
      db.update('service_menus', m.id, patch);
      return out(load(ctx.locationId, m.id));
    });
    router.delete('/api/service-menus/:id', 'location', (ctx) => {
      const m = load(ctx.locationId, ctx.params.id);
      if (!m) throw notFound();
      db.run('DELETE FROM service_menus WHERE id = ?', m.id);
      return { ok: true };
    });

    // --- public -------------------------------------------------------------------------------------------------------------
    const activeMenu = (slug: string) => {
      const m = db.get<any>('SELECT * FROM service_menus WHERE slug = ? AND active = 1', slug);
      if (!m) throw notFound('Dieses Leistungsmenü gibt es nicht (mehr)');
      return m;
    };
    /** The services of a menu: active calendars of its sub-account, with what the visitor needs to choose. */
    function services(m: any) {
      const cats = parseCats(m.categories);
      return cats
        .map((c) => ({
          name: c.name,
          services: c.calendar_ids
            .map((cid) => calendarById(app, cid))
            .filter((cal): cal is CalendarRow => !!cal && cal.location_id === m.location_id && !!cal.active)
            .map((cal) => {
              const cfg = getConfig(app, cal.id);
              const team = cfg.kind === 'round_robin' && m.staff_choice && cfg.show_hosts ? membersOf(app, cal.id).map((x) => ({ id: x.user_id, name: x.name })) : [];
              return {
                id: cal.id,
                name: cal.name,
                description: cal.description,
                duration: cal.duration,
                kind: cfg.kind,
                price_cents: cfg.payment.mode === 'none' ? 0 : cfg.payment.amount_cents,
                deposit_cents: cfg.payment.mode === 'deposit' ? cfg.payment.deposit_cents : 0,
                currency: cfg.payment.currency,
                team,
                questions: cfg.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, required: q.required, options: q.options, help: q.help, show_if: q.show_if ?? null })),
                consent_text: cfg.consent_text,
                policy_text: cfg.policy_text,
              };
            }),
        }))
        .filter((c) => c.services.length);
    }
    const serviceOf = (m: any, cid: string) => {
      const inMenu = parseCats(m.categories).some((c) => c.calendar_ids.includes(cid));
      const cal = inMenu ? calendarById(app, cid) : undefined;
      if (!cal || cal.location_id !== m.location_id || !cal.active) throw notFound('Diese Leistung gibt es hier nicht');
      return cal;
    };
    const hostOf = (m: any, cal: CalendarRow, hostId: unknown) => {
      const h = String(hostId ?? '');
      if (!h) return undefined;
      const cfg = getConfig(app, cal.id);
      if (!m.staff_choice || cfg.kind !== 'round_robin' || !membersOf(app, cal.id).some((x) => x.user_id === h)) throw bad('Diese Person bietet die Leistung nicht an');
      return h;
    };

    router.get('/api/public/service-menus/:slug', 'public', (ctx) => {
      const m = activeMenu(ctx.params.slug);
      const loc = app.location(m.location_id)!;
      return { name: m.name, intro: m.intro, company: loc.name, categories: services(m) };
    });
    router.get('/api/public/service-menus/:slug/slots', 'public', (ctx) => {
      const m = activeMenu(ctx.params.slug);
      const cal = serviceOf(m, String(ctx.query.get('calendar_id') ?? ''));
      const hostId = hostOf(m, cal, ctx.query.get('host_id'));
      const cfg = getConfig(app, cal.id);
      const today = ymdInTz(new Date(), cal.timezone);
      const fromParam = ctx.query.get('from') ?? '';
      const from = /^\d{4}-\d\d-\d\d$/.test(fromParam) && fromParam > today ? fromParam : today;
      const days = Math.min(Math.max(num(ctx.query.get('days'), 7), 1), 14);
      const out = [];
      for (let i = 0; i < days; i++) {
        const d = addDaysYmd(from, i);
        const day = slotsOfDay(app, cal, cfg, d);
        const slots = day ? day.slots.filter((s) => !hostId || s.hosts.includes(hostId)).map((s) => s.start) : computeSlots(cal, d, busyFor(app, cal, d));
        out.push({ date: d, slots });
      }
      return { timezone: cal.timezone, duration: cal.duration, days: out };
    });
    router.post('/api/public/service-menus/:slug/book', 'public', async (ctx) => {
      const m = activeMenu(ctx.params.slug);
      const b = ctx.body ?? {};
      if (String(b.website ?? '').trim()) throw bad('Das hat nicht geklappt – bitte noch einmal versuchen');
      if (throttled(ctx.ip)) throw new HttpError(429, 'Zu viele Buchungsversuche – bitte in ein paar Minuten noch einmal');
      const cal = serviceOf(m, String(b.calendar_id ?? ''));
      const hostId = hostOf(m, cal, b.host_id);
      const r = await bookTeam(
        app,
        cal,
        { start: String(b.start ?? ''), first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, notes: b.notes, answers: b.answers, consent: b.consent === true, meta: { service_menu: m.slug } },
        { hostId, source: 'Leistungsmenü' },
      );
      if (r.status === 'confirmed') return { status: 'confirmed', start_at: r.appointment.start_at, manageUrl: r.manage_url, icsUrl: r.ics_url, meetingUrl: r.meeting_url, hosts: r.hosts.map((h) => h.name) };
      if (r.status === 'payment_required') return { status: r.status, checkout_url: r.checkout_url, expires_at: r.expires_at, due_cents: r.due_cents, currency: r.currency };
      throw bad('Diese Leistung ist ausgebucht');
    });

    router.get('/book/s/:slug', 'public', (ctx) => {
      const m = db.get<any>('SELECT * FROM service_menus WHERE slug = ? AND active = 1', ctx.params.slug);
      if (!m) return html(messagePage('Nicht gefunden', 'Dieses Leistungsmenü gibt es nicht (mehr).'), 404);
      const loc = app.location(m.location_id)!;
      return html(menuPage(m, loc, ctx.query.get('embed') === '1'));
    });

    function menuPage(m: any, loc: any, embed: boolean) {
      const body = `<div class="wrap" style="max-width:760px"><div class="card">
  <h1>${escapeHtml(m.name)}</h1>
  ${m.intro ? `<p class="muted">${escapeHtml(m.intro)}</p>` : ''}
  ${noscriptNotice('einen Termin zu buchen')}
  <div id="steps" aria-live="polite"></div>
  <p class="error" id="err" role="alert"></p>
</div></div>
<script>
(function(){
  var SLUG=${jsonForScript(m.slug)},S={},data=null,el=document.getElementById('steps'),err=document.getElementById('err');
  function h(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function money(c,cur){return (c/100).toLocaleString('de-DE',{style:'currency',currency:cur||'EUR'})}
  function api(p,o){return fetch('/api/public/service-menus/'+SLUG+p,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Fehler');return j})})}
  function back(to){return '<p><button type="button" class="btn secondary" data-back="'+to+'">← Zurück</button></p>'}
  function wire(){el.querySelectorAll('[data-back]').forEach(function(b){b.onclick=function(){render(b.getAttribute('data-back'))}})}
  function fmtT(iso,tz){return new Date(iso).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',timeZone:tz})}
  function fmtD(ymd){var p=ymd.split('-');return new Date(Date.UTC(+p[0],+p[1]-1,+p[2],12)).toLocaleDateString('de-DE',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'})}
  function render(step){err.textContent='';
    if(step==='service'){var out='';data.categories.forEach(function(c){out+='<h2>'+h(c.name)+'</h2>';c.services.forEach(function(s){
      out+='<button type="button" class="svc" data-svc="'+h(s.id)+'" style="display:block;width:100%;text-align:left;margin:8px 0;padding:12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;cursor:pointer"><strong>'+h(s.name)+'</strong><span style="float:right">'+(s.price_cents?money(s.price_cents,s.currency):'')+'</span><br><span class="muted">'+s.duration+' Min.'+(s.description?' · '+h(s.description):'')+'</span></button>'})});
      el.innerHTML=out||'<p class="muted">Gerade sind keine Leistungen buchbar.</p>';
      el.querySelectorAll('[data-svc]').forEach(function(b){b.onclick=function(){data.categories.forEach(function(c){c.services.forEach(function(s){if(s.id===b.getAttribute('data-svc'))S.svc=s})});S.host='';render(S.svc.team.length>1?'staff':'slot')}});return}
    if(step==='staff'){var o='<h2>'+h(S.svc.name)+': Wer soll es sein?</h2><fieldset style="border:0;padding:0"><legend class="muted">Person wählen</legend><label class="check"><input type="radio" name="host" value="" checked> Egal – nächste freie Person</label>';
      S.svc.team.forEach(function(p){o+='<label class="check"><input type="radio" name="host" value="'+h(p.id)+'"> '+h(p.name)+'</label>'});
      el.innerHTML=o+'</fieldset><p><button type="button" id="next">Weiter</button></p>'+back('service');wire();
      document.getElementById('next').onclick=function(){var c=el.querySelector('input[name=host]:checked');S.host=c?c.value:'';render('slot')};return}
    if(step==='slot'){el.innerHTML='<h2>'+h(S.svc.name)+': Termin wählen</h2><p class="muted">Lädt…</p>'+back(S.svc.team.length>1?'staff':'service');wire();
      api('/slots?calendar_id='+encodeURIComponent(S.svc.id)+'&host_id='+encodeURIComponent(S.host)+'&days=14').then(function(r){var o='<h2>'+h(S.svc.name)+': Termin wählen</h2>',any=false;
        var chips='',panels='';r.days.forEach(function(d,i){if(!d.slots.length)return;var first=!any;any=true;chips+='<button type="button" class="btn secondary" data-day="'+i+'" aria-pressed="'+first+'" style="flex:0 0 auto">'+h(fmtD(d.date))+'</button>';panels+='<div class="row" data-panel="'+i+'" role="group" aria-label="'+h(fmtD(d.date))+'" style="flex-wrap:wrap;gap:6px;margin-top:12px;display:'+(first?'flex':'none')+'">';d.slots.forEach(function(t){panels+='<button type="button" class="btn secondary" data-t="'+h(t)+'" style="flex:0 0 auto">'+h(fmtT(t,r.timezone))+'</button>'});panels+='</div>'});
        o+='<div class="row" role="group" aria-label="Tage" style="flex-wrap:wrap;gap:6px">'+chips+'</div>'+panels;
        el.innerHTML=o+(any?'':'<p class="muted">In den nächsten zwei Wochen ist nichts frei.</p>')+back(S.svc.team.length>1?'staff':'service');wire();
        el.querySelectorAll('[data-day]').forEach(function(b){b.onclick=function(){el.querySelectorAll('[data-day]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));x.style.outline=x===b?'2px solid currentColor':''});el.querySelectorAll('[data-panel]').forEach(function(p){p.style.display=p.getAttribute('data-panel')===b.getAttribute('data-day')?'flex':'none'})}});
        var f0=el.querySelector('[data-day]');if(f0)f0.style.outline='2px solid currentColor';
        el.querySelectorAll('[data-t]').forEach(function(b){b.onclick=function(){S.start=b.getAttribute('data-t');S.label=fmtD(r.days.filter(function(d){return d.slots.indexOf(S.start)>=0})[0].date)+', '+fmtT(S.start,r.timezone);render('details')}})}).catch(function(e){err.textContent=e.message});return}
    if(step==='details'){var q='';S.svc.questions.forEach(function(x){var req=x.required?' required':'',lab='<label for="q_'+h(x.id)+'">'+h(x.label)+(x.required?' *':'')+'</label>';q+='<div data-qbox="'+h(x.id)+'">';
        if(x.type==='textarea')q+=lab+'<textarea id="q_'+h(x.id)+'" data-q="'+h(x.id)+'"'+req+'></textarea>';
        else if(x.type==='choice')q+=lab+'<select id="q_'+h(x.id)+'" data-q="'+h(x.id)+'"'+req+'><option value=""></option>'+x.options.map(function(o){return '<option>'+h(o)+'</option>'}).join('')+'</select>';
        else if(x.type==='multi')q+='<fieldset style="border:0;padding:0"><legend>'+h(x.label)+'</legend>'+x.options.map(function(o){return '<label class="check"><input type="checkbox" data-qm="'+h(x.id)+'" value="'+h(o)+'"> '+h(o)+'</label>'}).join('')+'</fieldset>';
        else if(x.type==='checkbox')q+='<label class="check"><input type="checkbox" data-qc="'+h(x.id)+'"'+req+'> '+h(x.label)+'</label>';
        else q+=lab+'<input id="q_'+h(x.id)+'" data-q="'+h(x.id)+'"'+req+'>';
        if(x.help)q+='<p class="muted" style="margin:2px 0 8px;font-size:13px">'+h(x.help)+'</p>';q+='</div>'});
      el.innerHTML='<h2>'+h(S.svc.name)+'</h2><p>'+h(S.label)+'</p><form id="f"><label for="fn">Vorname *</label><input id="fn" name="first_name" required autocomplete="given-name"><label for="ln">Nachname</label><input id="ln" name="last_name" autocomplete="family-name"><label for="em">E-Mail *</label><input id="em" name="email" type="email" required autocomplete="email"><label for="ph">Telefon</label><input id="ph" name="phone" type="tel" autocomplete="tel"><label for="no">Anmerkung</label><textarea id="no" name="notes"></textarea>'+q+
        '<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true"><label class="check" style="margin-top:12px"><input type="checkbox" name="consent" required> '+h(S.svc.consent_text)+'</label>'+(S.svc.policy_text?'<p class="muted" style="font-size:13px">'+h(S.svc.policy_text)+'</p>':'')+
        '<p><button type="submit">'+(S.svc.price_cents?'Weiter zur Zahlung':'Verbindlich buchen')+'</button></p></form>'+back('slot');wire();
      var f=document.getElementById('f');
      function answersOf(){var ans={};
        f.querySelectorAll('[data-q]').forEach(function(i){if(!i.disabled)ans[i.getAttribute('data-q')]=i.value});
        f.querySelectorAll('[data-qc]').forEach(function(i){if(!i.disabled)ans[i.getAttribute('data-qc')]=i.checked});
        f.querySelectorAll('[data-qm]').forEach(function(i){if(i.disabled)return;var k=i.getAttribute('data-qm');ans[k]=ans[k]||[];if(i.checked)ans[k].push(i.value)});return ans}
      // conditional questions (same rule as the server): shown only when an earlier answer matches
      function cond(){var a=answersOf();S.svc.questions.forEach(function(x){if(!x.show_if)return;var v=a[x.show_if.id];v=typeof v==='boolean'?[v?'Ja':'Nein']:v===undefined||v===''?[]:[].concat(v);var on=v.some(function(y){return x.show_if.values.indexOf(y)>=0});var box=f.querySelector('[data-qbox="'+x.id+'"]');if(!box)return;box.style.display=on?'':'none';box.querySelectorAll('input,select,textarea').forEach(function(i){i.disabled=!on})});}
      f.addEventListener('change',function(){cond();cond()});f.addEventListener('input',function(){cond();cond()});cond();cond();
      f.onsubmit=function(e){e.preventDefault();var ans=answersOf();
        api('/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({calendar_id:S.svc.id,host_id:S.host,start:S.start,first_name:f.first_name.value,last_name:f.last_name.value,email:f.email.value,phone:f.phone.value,notes:f.notes.value,answers:ans,consent:f.consent.checked,website:f.website.value})})
          .then(function(r){if(r.status==='payment_required'){location.href=r.checkout_url;return}
            el.innerHTML='<h2>Gebucht!</h2><p>'+h(S.svc.name)+' · '+h(S.label)+(r.hosts&&r.hosts.length?' · '+h(r.hosts.join(', ')):'')+'</p><p>Die Bestätigung kommt per E-Mail.</p><p><a class="btn secondary" href="'+h(r.icsUrl)+'">In den Kalender</a> <a class="btn secondary" href="'+h(r.manageUrl)+'">Verschieben oder absagen</a></p>'})
          .catch(function(e){err.textContent=e.message})};return}
  }
  api('').then(function(j){data=j;render('service')}).catch(function(e){err.textContent=e.message});
})();
</script>`;
      return publicPage({ title: m.name, body, embed, color: loc.settings?.branding?.color || undefined, head: '<meta name="robots" content="index">' });
    }
  },
};
