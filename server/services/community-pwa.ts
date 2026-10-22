import { escapeHtml } from '../core/template.js';

/**
 * The member app as a progressive web app: manifest (client name and icon), service worker (offline page, push) and the page script
 * (registering, "install" banner, switching push on). The strings are built per portal because the paths contain its address.
 */

export interface PwaPortal {
  base: string;
  name: string;
  color: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function manifestOf(p: PwaPortal, lang = 'de') {
  const name = p.name.trim() || 'Mitgliederbereich';
  return {
    id: `${p.base}/community`,
    name,
    short_name: [...name].slice(0, 12).join(''),
    description: `Die Community von ${name}`,
    lang,
    dir: 'ltr',
    start_url: `${p.base}/community?source=app`,
    scope: `${p.base}/`,
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: HEX.test(p.color) ? p.color : '#2563eb',
    categories: ['education', 'social'],
    icons: [
      { src: `${p.base}/icon/192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${p.base}/icon/512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${p.base}/icon/maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Nachrichten', url: `${p.base}/community/messages`, icons: [{ src: `${p.base}/icon/192.png`, sizes: '192x192', type: 'image/png' }] },
      { name: 'Benachrichtigungen', url: `${p.base}/community/notifications`, icons: [{ src: `${p.base}/icon/192.png`, sizes: '192x192', type: 'image/png' }] },
    ],
  };
}

/** <head> lines of every community page: manifest, colours, iPhone home-screen meta, icon, push key. */
export function headOf(p: PwaPortal, pushKey?: string): string {
  const color = HEX.test(p.color) ? p.color : '#2563eb';
  return `<link rel="manifest" href="${escapeHtml(p.base)}/manifest.webmanifest"><link rel="icon" type="image/png" sizes="64x64" href="${escapeHtml(p.base)}/icon/favicon.png"><link rel="apple-touch-icon" href="${escapeHtml(p.base)}/icon/apple.png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${escapeHtml([...p.name].slice(0, 12).join(''))}"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="theme-color" content="${color}">
<meta name="community-pwa" content="${escapeHtml(p.base)}">${pushKey ? `<meta name="community-push-key" content="${escapeHtml(pushKey)}">` : ''}`;
}

export const OFFLINE_PATH = 'offline';

export function offlineHtml(p: PwaPortal): string {
  const color = HEX.test(p.color) ? p.color : '#2563eb';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Offline · ${escapeHtml(p.name)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7fb;color:#0f172a;text-align:center}
.c{max-width:360px}.i{font-size:54px}h1{font-size:22px;margin:10px 0 6px}p{color:#475569;line-height:1.5;margin:0 0 20px}
a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 26px;border-radius:12px;background:${color};color:#fff;font-weight:700;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#0f1218;color:#e5e7eb}p{color:#9ca3af}}</style></head>
<body><div class="c"><div class="i" aria-hidden="true">📡</div><h1>Du bist gerade offline</h1><p>${escapeHtml(p.name)} braucht eine Internetverbindung, um Beiträge und Nachrichten zu laden. Sobald du wieder Empfang hast, geht es hier weiter.</p><a href="${escapeHtml(p.base)}/community">Erneut versuchen</a></div></body></html>`;
}

export function swJs(p: PwaPortal): string {
  const base = JSON.stringify(p.base);
  return `/* Member app service worker: offline page for navigations, push notifications. Pages themselves are never cached. */
var BASE=${base},CACHE='cm-shell-v1',OFFLINE=BASE+'/${OFFLINE_PATH}';
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll([OFFLINE,BASE+'/icon/192.png']);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('cm-')===0&&k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  var r=e.request;
  if(r.method!=='GET'||r.mode!=='navigate')return;
  var u=new URL(r.url);
  if(u.origin!==self.location.origin||u.pathname.indexOf(BASE+'/')!==0)return;
  e.respondWith(fetch(r).catch(function(){return caches.match(OFFLINE).then(function(m){return m||new Response('Offline',{status:503,headers:{'content-type':'text/plain; charset=utf-8'}});});}));
});
self.addEventListener('push',function(e){
  var d={};try{d=e.data?e.data.json():{};}catch(x){d={body:e.data&&e.data.text()};}
  e.waitUntil(self.registration.showNotification(d.title||'Neuigkeit',{body:d.body||'',tag:d.tag||undefined,icon:BASE+'/icon/192.png',badge:BASE+'/icon/favicon.png',data:{url:d.url||''}}));
});
self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var to=BASE+'/community';
  try{var u=new URL(e.notification.data&&e.notification.data.url||'',self.location.origin);if(u.origin===self.location.origin&&u.pathname.indexOf(BASE+'/')===0)to=u.pathname+u.search+u.hash;}catch(x){}
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(function(ws){
    for(var i=0;i<ws.length;i++){var w=ws[i];if(w.url.indexOf(BASE+'/')>=0&&'focus' in w){return w.focus().then(function(c){return c.navigate?c.navigate(to):c;});}}
    return clients.openWindow(to);
  }));
});
`;
}

/** The page script: register the worker, offer the install banner, switch push on (the profile page has a placeholder for it). */
export const PWA_JS = `(function(){
  var m=document.querySelector('meta[name="community-pwa"]');if(!m)return;
  var base=m.content,keyMeta=document.querySelector('meta[name="community-push-key"]');
  var standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  var ios=/iphone|ipad|ipod/i.test(navigator.userAgent)&&!window.MSStream;
  var reg=null;
  function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){}return null;}
  if('serviceWorker' in navigator){navigator.serviceWorker.register(base+'/community-sw.js',{scope:base+'/'}).then(function(r){reg=r;box();}).catch(function(){});}

  // --- install banner ---------------------------------------------------------------------------------------------------------
  var deferred=null,shown=false;
  function recent(){var t=Number(ls('cm-install-closed')||0);return t&&Date.now()-t<14*864e5;}
  function banner(html,onGo,goLabel){
    if(shown||standalone||recent())return;shown=true;
    var b=document.createElement('div');b.className='cm-install';b.setAttribute('role','region');b.setAttribute('aria-label','App installieren');
    b.innerHTML='<span class="ic" aria-hidden="true">📲</span><div class="tx"></div>'+(onGo?'<button type="button" class="go"></button>':'')+'<button type="button" class="x" aria-label="Schließen">✕</button>';
    b.querySelector('.tx').innerHTML=html;
    if(onGo){var g=b.querySelector('.go');g.textContent=goLabel;g.onclick=function(){onGo();b.remove();};}
    function close(){ls('cm-install-closed',String(Date.now()));b.remove();}
    b.querySelector('.x').onclick=close;
    document.addEventListener('keydown',function k(e){if(e.key==='Escape'&&b.parentNode){close();document.removeEventListener('keydown',k);}});
    document.body.appendChild(b);
  }
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();deferred=e;setTimeout(function(){banner('<strong>Als App installieren</strong><br><span>Schneller öffnen, Benachrichtigungen erhalten.</span>',function(){deferred.prompt();deferred=null;},'Installieren');},4000);});
  window.addEventListener('appinstalled',function(){var b=document.querySelector('.cm-install');if(b)b.remove();});
  if(ios&&!standalone){setTimeout(function(){banner('<strong>Als App auf dem iPhone</strong><br><span>Tippe auf <b>Teilen</b> und dann auf <b>„Zum Home-Bildschirm“</b>.</span>');},5000);}

  // --- push ----------------------------------------------------------------------------------------------------------------------
  function b64(s){s=s.replace(/-/g,'+').replace(/_/g,'/');var r=atob(s+'==='.slice((s.length+3)%4)),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
  function send(path,body){return fetch(base+'/community/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-community-pwa':'1'},body:JSON.stringify(body)});}
  function box(){
    var el=document.querySelector('[data-push-box]');if(!el||el.dataset.ready)return;el.dataset.ready='1';
    if(!keyMeta||!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)){el.innerHTML='<p class="cm-hint" style="margin:0 0 6px">'+(ios&&!standalone?'Auf dem iPhone: erst „Zum Home-Bildschirm“ hinzufügen, dann kannst du Benachrichtigungen einschalten.':'Dieses Gerät unterstützt keine Benachrichtigungen.')+'</p>';return;}
    var btn=document.createElement('button'),st=document.createElement('p');btn.type='button';btn.className='btn ghost';st.className='cm-hint';st.style.margin='6px 0 8px';
    el.appendChild(btn);el.appendChild(st);
    function paint(on){btn.textContent=on?'Auf diesem Gerät ausschalten':'Auf diesem Gerät einschalten';btn.dataset.on=on?'1':'';st.textContent=on?'Benachrichtigungen sind auf diesem Gerät an.':(Notification.permission==='denied'?'Du hast Benachrichtigungen im Browser gesperrt – bitte in den Browser-Einstellungen erlauben.':'');}
    function state(){return navigator.serviceWorker.ready.then(function(r){return r.pushManager.getSubscription();});}
    state().then(function(s){paint(!!s);});
    btn.onclick=function(){
      btn.disabled=true;
      state().then(function(s){
        if(s){return send('push/unsubscribe',{endpoint:s.endpoint}).then(function(){return s.unsubscribe();}).then(function(){paint(false);});}
        return Notification.requestPermission().then(function(p){
          if(p!=='granted'){paint(false);return;}
          return navigator.serviceWorker.ready.then(function(r){return r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(keyMeta.content)});}).then(function(sub){return send('push',{subscription:sub.toJSON()});}).then(function(r){if(!r.ok)throw new Error();paint(true);});
        });
      }).catch(function(){st.textContent='Hat nicht geklappt – bitte noch einmal versuchen.';}).then(function(){btn.disabled=false;});
    };
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',box);else box();
})();`;
