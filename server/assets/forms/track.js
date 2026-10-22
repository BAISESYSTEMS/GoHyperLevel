// Per-field analytics (docs/forms.md): which questions were seen, answered and how long it took, where people left.
// No cookie, no address: a random id per visit; nothing is sent when the browser says "do not track".
(function(){
if(navigator.doNotTrack==='1'||window.doNotTrack==='1'||navigator.globalPrivacyControl===true)return;
var SESS=Math.random().toString(36).slice(2,12)+Date.now().toString(36).slice(-4),viewed={},viewAt=0,evq=[];
function ev(k,f,ms){evq.push([k,f||'',Math.max(0,Math.min(Math.round(ms||0),600000))]);if(evq.length>=24)flush()}
function flush(){
  if(!evq.length)return;
  var body=JSON.stringify({s:SESS,e:evq.splice(0,60)});
  try{navigator.sendBeacon('/api/public/forms/'+CFG.id+'/track',new Blob([body],{type:'application/json'}))}catch(x){}}
// the questions of a screen the visitor can answer
function inputs(i){return [].slice.call($.steps[i].querySelectorAll('.pf-q:not([hidden]):not([data-type=heading]):not([data-type=hidden])'))}
function left(){
  if($.sub||!$.started)return;
  var q=inputs($.cur)[0];
  ev('l',q?q.getAttribute('data-id'):'',Date.now()-viewAt)}
// time spent in a question (one question at a time: time on the screen)
[].forEach.call($.form.querySelectorAll('.pf-q'),function(q){
  q.addEventListener('focusin',function(){q.__f=Date.now()});
  q.addEventListener('focusout',function(){if(q.__f){q.__t=(q.__t||0)+Date.now()-q.__f;q.__f=0}})});
$.on('show',function(i){
  viewAt=Date.now();
  inputs(i).forEach(function(q){var id=q.getAttribute('data-id');if(!viewed[id]){viewed[id]=1;ev('v',id)}})});
$.on('leave',function(i){
  var r=$.raw(),now=Date.now();
  inputs(i).forEach(function(q){
    var v=r[q.getAttribute('data-name')];
    if(v===undefined||v===''||(Array.isArray(v)&&!v.length))return;
    ev('a',q.getAttribute('data-id'),CFG.tf?now-viewAt:(q.__t||0))})});
$.on('sent',function(ms){ev('s','',ms);flush()});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){left();flush()}});
window.addEventListener('pagehide',function(){left();flush()});
setInterval(flush,8000);
ev('o','',0);
})();
