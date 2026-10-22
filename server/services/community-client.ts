/**
 * The one script of the community pages (/portal-community-ext.js). Everything works without it – the forms are plain forms –
 * it only adds comfort: video upload in parts, "online now" signals, live messages. It talks to this server only (CSP connect-src 'self').
 */

const VIDEO = `
document.querySelectorAll('[data-video-pick]').forEach(function(lab){
  var form=lab.closest('form');if(!form)return;
  var input=lab.querySelector('input[type=file]'),hid=form.querySelector('input[name=video_upload]'),st=form.querySelector('[data-video-state]'),link=form.querySelector('input[name=video_url]');
  var token=(form.querySelector('input[name=csrf]')||{}).value||'';
  var base=(form.getAttribute('action')||'').replace(/\\/posts$/,'/video/upload');
  lab.hidden=false;
  function say(t){if(st)st.textContent=t}
  function busy(on){form.querySelectorAll('button.btn').forEach(function(b){b.disabled=on})}
  input.addEventListener('change',function(){
    var f=input.files&&input.files[0];input.value='';if(!f)return;
    busy(true);say('Upload startet …');hid.value='';
    fetch(base,{method:'POST',headers:{'content-type':'application/json','x-community-csrf':token},body:JSON.stringify({name:f.name,size:f.size})})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Upload nicht möglich');return j})})
    .then(function(j){
      var size=f.size,chunk=j.chunk_size,id=j.id;
      function next(off){
        if(off>=size)return Promise.resolve();
        return fetch(base+'/'+id+'?offset='+off,{method:'PUT',headers:{'x-community-csrf':token,'content-type':'application/octet-stream'},body:f.slice(off,Math.min(off+chunk,size))})
        .then(function(r){return r.json().then(function(x){if(!r.ok)throw new Error(x.error||'Upload abgebrochen');return x})})
        .then(function(x){say('Lädt hoch … '+Math.round(x.received/size*100)+' %');return x.complete?x:next(x.received)});
      }
      return next(0).then(function(){hid.value=id;if(link)link.value='';say('✓ '+f.name+' ist hochgeladen und wird mit dem Beitrag veröffentlicht.');busy(false)});
    })
    .catch(function(e){say(e&&e.message?e.message:'Upload fehlgeschlagen');busy(false)});
  });
});
`;

const PRESENCE = `
(function(){
  var m=location.pathname.match(/^\\/portal\\/[^/]+\\/community/);if(!m)return;
  var t=document.querySelector('input[name=csrf]');var token=window.__cmCsrf||(t&&t.value)||'';if(!token)return;
  function ping(){if(document.hidden)return;fetch(m[0]+'/ping',{method:'POST',headers:{'x-community-csrf':token}}).catch(function(){})}
  setInterval(ping,90000);document.addEventListener('visibilitychange',function(){if(!document.hidden)ping()});
})();
`;

const LIVE_MESSAGES = `
(function(){
  var box=document.querySelector('[data-dm-thread]');if(!box)return;
  var list=box.querySelector('[data-dm-list]'),url=box.getAttribute('data-poll'),last=box.getAttribute('data-last')||'';
  function down(){window.scrollTo(0,document.body.scrollHeight)}
  if(box.hasAttribute('data-scroll'))down();
  function poll(){
    if(document.hidden)return;
    fetch(url+'?since='+encodeURIComponent(last),{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(j){
      if(!j||!j.html)return;last=j.last||last;var atEnd=(window.innerHeight+window.scrollY)>=document.body.scrollHeight-80;
      list.insertAdjacentHTML('beforeend',j.html);if(atEnd)down();
    }).catch(function(){});
  }
  setInterval(poll,6000);document.addEventListener('visibilitychange',function(){if(!document.hidden)poll()});
  var ta=box.querySelector('textarea');if(ta)ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ta.form.requestSubmit()}});
})();
`;

/** Parts other modules appended (name → code). */
const extra: string[] = [];
export function addClientScript(code: string) {
  extra.push(code);
}

export const clientJs = () => `(function(){${VIDEO}${PRESENCE}${LIVE_MESSAGES}${extra.join('\n')}})();`;
/** Kept for importers that want the static part only. */
export const CLIENT_JS = clientJs();
