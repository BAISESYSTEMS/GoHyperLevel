// Browser runtime of a form, base part (every form has it): answers, validation, submit. The other parts (nav, cond, tf, calc, …)
// are added by server/services/form-runtime.ts only when the form uses them and talk to this one through `$`.
// Free variables: CFG (settings of this form), SPEC (rules as data, only when a part needs them) and `$` (shared by all parts).
(function(){
var id='pf_'+CFG.id,form=document.getElementById(id),root=document.getElementById('pfr_'+CFG.id),H={},t0=Date.now(),
  steps=[].slice.call(form.querySelectorAll('.pghl-step')),btn=form.querySelector('.pf-next'),err=form.querySelector('[data-err]');
$.root=root;$.form=form;$.steps=steps;$.btn=btn;$.err=err;$.done=document.getElementById(id+'_done');
// state: the screen shown, the answer sent, a first move made (a submit in flight = the button is disabled)
$.cur=0;$.sub=false;$.started=false;
// small event bus: parts listen with $.on, the base part announces with emit (a listener answering false vetoes the rest)
$.on=function(n,f){(H[n]=H[n]||[]).push(f)};
function emit(n,a,b){return(H[n]||[]).every(function(f){return f(a,b)!==false})}
function refresh(){emit('refresh')}
$.emit=emit;$.refresh=refresh;
$.run=function(){refresh();emit('show',0,0)};

// the answers by field name; internal fields (_hp, _ts …) and the captcha token stay out, a chosen file counts as 'datei'
function raw(){
  var o={};
  new FormData(form).forEach(function(v,k){
    if(k.charAt(0)==='_'||k==='cf-turnstile-response')return;
    if(typeof v!=='string')v=v.size?'datei':'';
    if(k in o)o[k]=[].concat(o[k],v);else o[k]=v});
  return o}
$.raw=raw;

function check(q,r){
  var t=q.getAttribute('data-type');
  if(q.hidden||t==='heading')return'';
  var v=r[q.getAttribute('data-name')];
  if(v===undefined||v===''||(Array.isArray(v)&&!v.length))return q.getAttribute('data-req')==='1'?'Bitte ausfüllen.':'';
  if(t==='email'&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v)))return'Bitte eine gültige E-Mail-Adresse angeben.';
  if(t==='number'){
    var n=Number(String(v).replace(',','.'));
    if(!isFinite(n))return'Bitte eine Zahl angeben.';
    var lo=q.getAttribute('data-min'),hi=q.getAttribute('data-max');
    if(lo!==null&&n<Number(lo))return'Mindestens '+lo+'.';
    if(hi!==null&&n>Number(hi))return'Höchstens '+hi+'.'}
  return''}
function clearErr(q){q.removeAttribute('data-bad');var e=q.querySelector('.pf-err');if(e)e.textContent=''}
$.clearErr=clearErr;
// checks the questions of a screen, marks the wrong ones and moves the focus to the first
function stepErr(i){
  var bad,r=raw();
  [].forEach.call(steps[i].querySelectorAll('.pf-q'),function(q){
    var m=check(q,r),e=q.querySelector('.pf-err');
    if(m){q.setAttribute('data-bad','1');if(e)e.textContent=m;if(!bad)bad=q}else clearErr(q)});
  if(bad){var c=bad.querySelector('input:not([type=hidden]),select,textarea,button');if(c&&c.focus)c.focus({preventScroll:true});return true}}

function next(){
  if(btn.disabled||$.sub||stepErr($.cur))return;
  $.started=true;emit('leave',$.cur);
  if(!$.go||!$.go())submit()}
$.next=next;
btn.addEventListener('click',next);
form.addEventListener('submit',function(e){e.preventDefault();next()});
form.addEventListener('input',refresh);
form.addEventListener('change',function(e){
  var q=e.target.closest&&e.target.closest('.pf-q');
  refresh();
  if(q){clearErr(q);if(e.target.type==='radio')emit('pick',q)}
  $.started=true});
root.addEventListener('keydown',function(e){
  if($.sub)return;
  var t=e.target,tag=(t.tagName||'').toLowerCase();
  if(e.key!=='Enter'||tag==='button'||(tag==='textarea'&&!(e.ctrlKey||e.metaKey)))return;
  e.preventDefault();next()});

async function submit(){
  if(!emit('pre'))return;
  btn.disabled=true;err.textContent='';refresh();
  try{
    var data={};
    for(var pair of new FormData(form).entries()){
      var k=pair[0],v=pair[1];
      if(k==='cf-turnstile-response')continue;
      if(v instanceof File){if(!v.size)continue;v=await $.file(v)}
      if(k in data)data[k]=[].concat(data[k],v);else data[k]=v}
    var params=new URLSearchParams(location.search);
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','ref'].forEach(function(p){if(params.get(p))data['_'+p]=params.get(p)});
    if(params.get('_a')&&!data._attr)data._attr=params.get('_a');
    data._page=(window.top===window?location.href:document.referrer)||'';
    if(window.top===window)data._referrer=document.referrer||'';
    data._dur=Date.now()-t0;
    emit('data',data);
    var r=await fetch('/api/public/forms/'+CFG.id+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    var j=await r.json();
    if(!r.ok)throw new Error(j.error||'Fehler');
    $.sub=true;emit('sent',Date.now()-t0);
    var top=window.top||window,res=j.result;
    // on to the payment, the ending's address or the form's thank-you address
    var go=j.pay_url||(res?res.redirect_url:CFG.redirect);
    if(go){top.location.href=go;return}
    form.hidden=true;
    if(res)emit('result',res);
    $.done.hidden=false
  }catch(x){err.textContent=x.message;btn.disabled=false;emit('fail')}}
})();
