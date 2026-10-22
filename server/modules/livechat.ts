import type { Module } from '../core/app.js';
import { HttpError, bad, html, notFound, str, text, clampLimit } from '../core/http.js';
import { jsonForScript, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { id, now, token } from '../core/util.js';
import { logActivity, upsertContact } from '../services/contacts.js';
import { getOrCreateConversation, notifyTeam } from '../services/messaging.js';

/**
 * Live chat for any website: a bubble (widget.js) opens a small chat window (an iframe from this
 * server). Visitors' messages land in Konversationen; replies there (channel „Chat“) appear in the window.
 */

const recent = new Map<string, number[]>();
function limited(key: string, max = 30) {
  const t = Date.now();
  const list = (recent.get(key) ?? []).filter((x) => t - x < 60_000);
  list.push(t);
  recent.set(key, list);
  return list.length > max;
}

export const livechatModule: Module = {
  name: 'livechat',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE chat_visitors (
        token TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, page TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const settingsOf = (locId: string) => {
      const loc = app.location(locId);
      if (!loc) return undefined;
      return { loc, chat: { enabled: false, title: 'Fragen? Schreib uns!', greeting: 'Hallo 👋 Wie können wir helfen?', color: '#2563eb', ask_email: true, ...(loc.settings.chat ?? {}) } };
    };

    router.get('/chat/:loc/widget.js', 'public', (ctx) => {
      const s = settingsOf(ctx.params.loc);
      if (!s || !s.chat.enabled) return text('/* chat off */', 'text/javascript; charset=utf-8');
      const color = /^#[0-9a-f]{6}$/i.test(s.chat.color) ? s.chat.color : '#2563eb';
      const js = `(function(){if(window.__pghlChat)return;window.__pghlChat=1;
var cur=document.currentScript,base=cur?new URL(cur.src).origin:location.origin,loc=${jsonForScript(ctx.params.loc)};
var b=document.createElement('button');b.type='button';b.setAttribute('aria-label','Chat öffnen');b.setAttribute('aria-expanded','false');b.innerHTML='💬';
b.style.cssText='position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:${color};color:#fff;font-size:26px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:2147483646';
var f=document.createElement('iframe');f.title='Chat';
var src=function(){return base+'/chat/'+encodeURIComponent(loc)+'/frame?page='+encodeURIComponent(location.href)+'&a='+encodeURIComponent(window.pghlAttr||'')+'&r='+encodeURIComponent(document.referrer||'')};
f.style.cssText='position:fixed;right:20px;bottom:90px;width:360px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);border:0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:2147483647;display:none;background:#fff';
b.onclick=function(){if(!f.src)f.src=src();var open=f.style.display==='none';f.style.display=open?'block':'none';b.innerHTML=open?'✕':'💬';b.setAttribute('aria-label',open?'Chat schließen':'Chat öffnen');b.setAttribute('aria-expanded',String(open))};
document.body.appendChild(f);document.body.appendChild(b);})();`;
      const r = text(js, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=300';
      return r;
    });

    router.get('/chat/:loc/frame', 'public', (ctx) => {
      const s = settingsOf(ctx.params.loc);
      if (!s || !s.chat.enabled) return html('<p>Chat ist aus.</p>', 404);
      const cfg = { loc: ctx.params.loc, greeting: s.chat.greeting, askEmail: !!s.chat.ask_email, page: ctx.query.get('page') ?? '', attr: ctx.query.get('a') ?? '', ref: ctx.query.get('r') ?? '' };
      const body = `
<div id="app" style="display:flex;flex-direction:column;height:100vh">
  <div style="background:var(--brand);color:#fff;padding:14px 16px"><strong>${escapeHtml(s.chat.title)}</strong><div style="font-size:12px;opacity:.85">${escapeHtml(s.loc.name)}</div></div>
  <div id="msgs" role="log" aria-live="polite" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f9fafb"></div>
  <form id="who" style="padding:10px;border-top:1px solid var(--line)" hidden>
    <input name="name" placeholder="Dein Name" aria-label="Dein Name" autocomplete="name" style="margin-bottom:6px"><input name="email" type="email" placeholder="E-Mail (für die Antwort)" aria-label="E-Mail (für die Antwort)" autocomplete="email" style="margin-bottom:6px">
  </form>
  <form id="f" style="display:flex;gap:6px;padding:10px;border-top:1px solid var(--line)"><input id="t" placeholder="Nachricht…" aria-label="Nachricht" autocomplete="off" required><button aria-label="Senden">➤</button></form>
</div>
<style>.m{max-width:80%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word;font-size:14px}.in{align-self:flex-end;background:var(--brand);color:#fff}.out{align-self:flex-start;background:#fff;border:1px solid var(--line)}</style>
<script>
var C=${jsonForScript(cfg)},key='pghl_chat_'+C.loc,vis=null,last='';
try{vis=localStorage.getItem(key)}catch(e){}
var box=document.getElementById('msgs'),who=document.getElementById('who');
function add(dir,txt){var d=document.createElement('div');d.className='m '+dir;d.textContent=txt;box.appendChild(d);box.scrollTop=box.scrollHeight}
add('out',C.greeting);
if(C.askEmail&&!vis)who.hidden=false;
async function poll(){if(!vis)return;try{var r=await fetch('/api/public/chat/'+C.loc+'/messages?visitor='+encodeURIComponent(vis)+'&after='+encodeURIComponent(last));var j=await r.json();(j.messages||[]).forEach(function(m){last=m.created_at;add(m.direction==='in'?'in':'out',m.body)})}catch(e){}}
document.getElementById('f').onsubmit=async function(e){e.preventDefault();var t=document.getElementById('t'),txt=t.value.trim();if(!txt)return;t.value='';
var data={body:txt,visitor:vis,page:C.page,attr:C.attr,ref:C.ref};if(!who.hidden){var fd=new FormData(who);data.name=fd.get('name');data.email=fd.get('email')}
var r=await fetch('/api/public/chat/'+C.loc+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});var j=await r.json();
if(!r.ok){add('out',j.error||'Senden ging nicht.');return}
if(j.visitor&&!vis){vis=j.visitor;try{localStorage.setItem(key,vis)}catch(e){}}who.hidden=true;await poll()};
poll();setInterval(poll,4000);
</script>`;
      return html(publicPage({ title: s.chat.title, body, color: s.chat.color, embed: true, head: '<style>.wrap{padding:0!important;max-width:none}#who input,#f input{padding:9px 11px}#f button{padding:9px 14px;min-width:44px;min-height:44px}</style>' }));
    });

    router.post('/api/public/chat/:loc/messages', 'public', (ctx) => {
      if (limited(ctx.ip)) throw new HttpError(429, 'Zu viele Nachrichten – kurz warten');
      const s = settingsOf(ctx.params.loc);
      if (!s || !s.chat.enabled) throw notFound();
      const body = str(ctx.body.body, 'Nachricht', { required: true, max: 4000 });
      let visitor = ctx.body.visitor ? db.get('SELECT * FROM chat_visitors WHERE token = ? AND location_id = ?', String(ctx.body.visitor), s.loc.id) : undefined;
      if (!visitor) {
        const email = str(ctx.body.email, 'E-Mail', { max: 200 });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Bitte eine gültige E-Mail angeben');
        const { contact } = upsertContact(app, s.loc.id, { name: str(ctx.body.name, 'Name', { max: 120 }) || (email ? '' : 'Website-Besucher'), email }, { source: 'Live-Chat', tags: ['live-chat'], publicInput: true });
        visitor = { token: token(18), location_id: s.loc.id, contact_id: contact.id, page: str(ctx.body.page, 'Seite', { max: 500 }), created_at: now() };
        db.insert('chat_visitors', visitor);
        app.services.attribution?.capture(ctx, s.loc.id, contact.id, 'chat', { attr: ctx.body.attr, page: ctx.body.page, referrer: ctx.body.ref });
      }
      const conversationId = getOrCreateConversation(app, s.loc.id, visitor.contact_id);
      const wasQuiet = !db.get(`SELECT id FROM messages WHERE conversation_id = ? AND channel = 'chat' AND created_at > ?`, conversationId, new Date(Date.now() - 3600_000).toISOString());
      const msg = { id: id(), location_id: s.loc.id, conversation_id: conversationId, contact_id: visitor.contact_id, channel: 'chat', direction: 'in', subject: '', body, status: 'received', error: '', source: 'Live-Chat', created_at: now() };
      db.insert('messages', msg);
      db.run('UPDATE conversations SET last_message_at = ?, last_message = ?, unread = unread + 1 WHERE id = ?', msg.created_at, body.slice(0, 140), conversationId);
      logActivity(app, s.loc.id, visitor.contact_id, 'chat.received', 'Chat-Nachricht');
      if (wasQuiet) void notifyTeam(app, s.loc.id, 'Neue Chat-Nachricht', `${body}\n\nAntworten: ${app.baseUrl()}/app/conversations`);
      app.events.emit(s.loc.id, 'message.inbound', { contactId: visitor.contact_id, contact: db.get('SELECT * FROM contacts WHERE id = ?', visitor.contact_id), message: msg });
      return { ok: true, visitor: visitor.token };
    });

    router.get('/api/public/chat/:loc/messages', 'public', (ctx) => {
      const v = db.get('SELECT * FROM chat_visitors WHERE token = ? AND location_id = ?', String(ctx.query.get('visitor') ?? ''), ctx.params.loc);
      if (!v) return { messages: [] };
      const after = ctx.query.get('after') || '';
      return {
        messages: db.all(
          // Only from this visitor's own start: somebody who types a known address into the widget joins that contact, but never
          // reads the chats that happened before (docs/security-review-2026-10.md, O-2).
          `SELECT direction, body, created_at FROM messages WHERE contact_id = ? AND channel = 'chat' AND created_at > ? AND created_at >= ? ORDER BY created_at LIMIT ?`,
          v.contact_id,
          after,
          v.created_at,
          clampLimit(ctx.query.get('limit'), 200, 500),
        ),
      };
    });

    router.get('/api/livechat', 'location', (ctx) => {
      const s = settingsOf(ctx.locationId)!;
      return { ...s.chat, embed: `<script src="${app.baseUrl()}/chat/${ctx.locationId}/widget.js" async></script>` };
    });
  },
};
