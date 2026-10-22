import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, type RawResult } from '../core/http.js';
import { jsonForScript } from '../core/page.js';
import { textToHtml } from '../core/template.js';
import { normalizeEmail, now, sha256, token } from '../core/util.js';
import { deliverEmail } from '../services/messaging.js';

/**
 * Save progress and continue later (HighLevel parity, docs/forms.md#save-progress): a form with `settings.save_progress` offers
 * "Später weitermachen": the answers are stored for 30 days and a link `/f/<id>?resume=<token>` goes to the visitor's e-mail address,
 * or – only when the visitor chooses "Auf diesem Gerät merken" – they are kept in this browser (nothing is stored on the device while
 * somebody merely types, so the next person on a shared device does not get them). The script is added to the form's own page
 * (`/f/:id`) through a router wrapper, so the forms runtime stays untouched; a submitted form removes its draft. Files, signatures,
 * payment, consent and hidden fields are never kept in drafts nor filled in again. No contact is made from a draft.
 */

const DAYS = 30;
const MAX_BYTES = 50_000;
/** Never kept in a draft nor filled in again: consent must be given anew, the rest is not the visitor's typing (or sensitive). */
const NOT_KEPT = new Set(['file', 'signature', 'payment', 'consent', 'hidden', 'calculator', 'heading', 'page_break']);
const keptNames = (fields: any[]) => [...new Set(fields.filter((x) => !NOT_KEPT.has(String(x?.type ?? ''))).map((x) => String(x?.name ?? '')).filter(Boolean))];

const stamp = new Map<string, number[]>();
function throttled(ip: string, max = 10, windowMs = 10 * 60_000): boolean {
  const t = Date.now();
  const list = (stamp.get(ip) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  stamp.set(ip, list);
  if (stamp.size > 20_000) stamp.clear();
  return list.length > max;
}

/**
 * The browser part: the "Später weitermachen" box (link by e-mail, or "Auf diesem Gerät merken"), restore from a link or – only after
 * the visitor chose to – from this browser, forget after sending. Only the fields in `names` are collected and filled in.
 */
const script = (formId: string, names: string[]) => `<script>(function(){
var ID=${jsonForScript(formId)},N=${jsonForScript(names)},F=document.getElementById('pf_'+ID);if(!F)return;
var K='pghl_draft_'+ID,q=new URLSearchParams(location.search),tok=q.get('resume')||'',keep=false;
function each(fn){Array.prototype.forEach.call(F.elements,function(e){if(!e.name||N.indexOf(e.name)<0||e.type==='file'||e.type==='hidden'||e.type==='password'||e.type==='submit'||e.type==='button')return;fn(e)})}
function collect(){var o={};each(function(e){if(e.type==='checkbox'){o[e.name]=o[e.name]||[];if(e.checked)o[e.name].push(e.value)}else if(e.type==='radio'){if(e.checked)o[e.name]=e.value}else if(e.value)o[e.name]=e.value});return o}
function fill(o){each(function(e){if(!(e.name in o))return;var v=o[e.name];if(e.type==='checkbox')e.checked=[].concat(v).indexOf(e.value)>=0;else if(e.type==='radio')e.checked=v===e.value;else e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})}
function save(){try{localStorage.setItem(K,JSON.stringify({at:Date.now(),keep:1,v:collect()}))}catch(x){}}
var t;function later(){if(!keep)return;clearTimeout(t);t=setTimeout(save,600)}F.addEventListener('input',later);F.addEventListener('change',later);
var box=document.createElement('div');box.className='pf-resume';box.style.cssText='margin:0 0 14px;font-size:14px';F.parentNode.insertBefore(box,F);
function note(msg,reset){box.innerHTML='';var p=document.createElement('p');p.setAttribute('role','status');p.textContent=msg+' ';if(reset){var a=document.createElement('a');a.href='#';a.textContent='Neu beginnen';a.onclick=function(e){e.preventDefault();try{localStorage.removeItem(K)}catch(x){}location.replace(location.pathname+(q.get('embed')?'?embed=1':''))};p.appendChild(a)}box.appendChild(p)}
if(tok){fetch('/api/public/forms/'+ID+'/draft/'+encodeURIComponent(tok)).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.data){fill(j.data);note('Deine gespeicherten Antworten sind wieder da.',false)}else note('Dieser Link ist abgelaufen – bitte neu ausfüllen.',false)}).catch(function(){})}
else{try{var s=JSON.parse(localStorage.getItem(K)||'null');if(s&&!s.keep){localStorage.removeItem(K);s=null}if(s&&s.v&&Date.now()-s.at<${DAYS}*864e5&&Object.keys(s.v).some(function(k){return [].concat(s.v[k]).length})){keep=true;fill(s.v);note('Deine auf diesem Gerät gemerkten Antworten sind wieder da.',true)}}catch(x){}}
var d=document.createElement('details');d.className='pf-later';d.style.cssText='margin:14px 0 0;font-size:14px';d.innerHTML='<summary style="cursor:pointer">Später weitermachen</summary><p style="margin:8px 0">Wir schicken dir einen Link, mit dem du hier weitermachst (${DAYS} Tage gültig).</p><label for="pf-later-'+ID+'">E-Mail</label><input id="pf-later-'+ID+'" type="email" autocomplete="email" style="max-width:320px"> <button type="button" data-act="link">Link schicken</button><p style="margin:8px 0 0">Oder ohne E-Mail: <button type="button" data-act="device">Auf diesem Gerät merken</button> (nur auf deinem eigenen Gerät)</p><p role="status" style="margin:6px 0 0"></p>';
F.parentNode.insertBefore(d,F.nextSibling);
var em=d.querySelector('input'),st=d.querySelector('p[role=status]'),em0=F.querySelector('input[type=email]');if(em0&&em0.value)em.value=em0.value;
d.querySelector('button[data-act=link]').onclick=function(){st.textContent='';fetch('/api/public/forms/'+ID+'/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:em.value,data:collect()})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Fehler');st.textContent='Gesendet – schau in dein Postfach.'})}).catch(function(e){st.textContent=e.message})};
d.querySelector('button[data-act=device]').onclick=function(){keep=true;save();st.textContent='Gemerkt – auf diesem Gerät sind deine Antworten beim nächsten Besuch wieder da (${DAYS} Tage).'};
var done=document.getElementById('pf_'+ID+'_done');if(done&&window.MutationObserver)new MutationObserver(function(){if(!done.hidden){try{localStorage.removeItem(K)}catch(x){}keep=false;d.hidden=true;box.hidden=true;if(tok)fetch('/api/public/forms/'+ID+'/draft/'+encodeURIComponent(tok),{method:'DELETE'}).catch(function(){})}}).observe(done,{attributes:true});
})();</script>`;

export const formDraftsModule: Module = {
  name: 'form-drafts',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE form_drafts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE, email TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX form_drafts_expiry ON form_drafts(expires_at);
      CREATE INDEX form_drafts_email ON form_drafts(location_id, email);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const formOf = (fid: string) => {
      const f = db.get<{ id: string; location_id: string; name: string; fields: string; settings: string }>('SELECT id, location_id, name, fields, settings FROM forms WHERE id = ?', fid);
      if (!f) return undefined;
      let settings: any = {};
      let fields: any[] = [];
      try {
        settings = JSON.parse(f.settings || '{}');
        fields = JSON.parse(f.fields || '[]');
      } catch {
        /* broken row */
      }
      return { ...f, settings, fields };
    };
    const enabled = (f: ReturnType<typeof formOf>) => !!f && f.settings?.save_progress === true;

    router.wrappers.push((route, next) => {
      if (route.method !== 'GET' || route.pattern !== '/f/:id') return next;
      return async (ctx) => {
        const res = (await next(ctx)) as RawResult;
        const f = formOf(ctx.params.id);
        if (!enabled(f) || !res || typeof res !== 'object' || !(res as any).__raw || res.status !== 200 || typeof res.body !== 'string' || !res.body.includes('</body>')) return res;
        return { ...res, body: res.body.replace('</body>', `${script(f!.id, keptNames(f!.fields))}</body>`) };
      };
    });

    router.post('/api/public/forms/:id/draft', 'public', async (ctx) => {
      if (throttled(ctx.ip)) throw new HttpError(429, 'Zu viele Anfragen – bitte in ein paar Minuten noch einmal');
      const f = formOf(ctx.params.id);
      if (!enabled(f)) throw notFound();
      const email = normalizeEmail(ctx.body?.email);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
      const names = new Set(keptNames(f!.fields));
      const raw = ctx.body?.data && typeof ctx.body.data === 'object' && !Array.isArray(ctx.body.data) ? ctx.body.data : {};
      const data: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!names.has(k)) continue;
        if (typeof v === 'string') data[k] = v.slice(0, 10_000);
        else if (Array.isArray(v)) data[k] = v.slice(0, 50).map((x) => String(x).slice(0, 500));
      }
      const json = JSON.stringify(data);
      if (json.length > MAX_BYTES) throw bad('Zu viele Angaben für einen Entwurf');
      const tok = token(24);
      db.insert('form_drafts', { id: sha256(tok), location_id: f!.location_id, form_id: f!.id, email, data: json, created_at: now(), expires_at: new Date(Date.now() + DAYS * 86_400_000).toISOString() });
      const loc = app.location(f!.location_id)!;
      const title = f!.settings?.title || f!.name;
      const text = `Hallo,\n\nhier ist dein Link, um „${title}“ weiter auszufüllen – deine bisherigen Antworten sind gespeichert:\n${app.baseUrl()}/f/${f!.id}?resume=${tok}\n\nDer Link gilt ${DAYS} Tage. Wenn du das nicht angefordert hast, ignoriere diese E-Mail einfach.\n\nViele Grüße\n${loc.name}`;
      const r = await deliverEmail(loc, { to: email, subject: `Später weitermachen: ${title}`, text, html: textToHtml(text) });
      return { ok: true, status: r.status, expires_in_days: DAYS };
    });
    const draftOf = (fid: string, tok: string) => db.get<any>('SELECT * FROM form_drafts WHERE id = ? AND form_id = ? AND expires_at > ?', sha256(tok), fid, now());
    router.get('/api/public/forms/:id/draft/:token', 'public', (ctx) => {
      const d = draftOf(ctx.params.id, ctx.params.token);
      if (!d) throw notFound('Dieser Link ist abgelaufen');
      return { data: JSON.parse(d.data), expires_at: d.expires_at };
    });
    router.delete('/api/public/forms/:id/draft/:token', 'public', (ctx) => {
      db.run('DELETE FROM form_drafts WHERE id = ? AND form_id = ?', sha256(ctx.params.token), ctx.params.id);
      return { ok: true };
    });

    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 3600_000) return;
      last = Date.now();
      db.run('DELETE FROM form_drafts WHERE expires_at <= ?', now());
    });

    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (email) db.run('DELETE FROM form_drafts WHERE location_id = ? AND email = ?', loc, email);
      },
    ];
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (!email) return {};
        const rows = db.all('SELECT d.email, d.data, d.created_at, d.expires_at, f.name AS form FROM form_drafts d JOIN forms f ON f.id = d.form_id WHERE d.location_id = ? AND d.email = ?', loc, email);
        return rows.length ? { 'form_drafts (E-Mail)': rows } : {};
      },
    ];
  },
};
