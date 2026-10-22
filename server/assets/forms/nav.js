// Screens: several pages, one question at a time, a welcome screen. Next/back, progress bar, jumps (rules part), the button text.
(function(){
var root=$.root,form=$.form,steps=$.steps,S=SPEC.S,hist=[],prog=root.querySelector('.pf-progress'),back=root.querySelector('.pf-back'),
  bar=prog&&prog.querySelector('.pf-bar i'),cnt=prog&&prog.querySelector('.pf-count'),welcome=root.querySelector('.pf-welcome');
function progress(){
  if(!prog)return;
  bar.style.width=Math.round(hist.length/Math.max(S.length,1)*100)+'%';
  cnt.textContent=(CFG.tf?'Frage ':'Schritt ')+Math.min($.cur+1,S.length)+' von '+S.length}
// the button says what comes next; the last screen submits
function nav(){
  var last=$.nextShown(S,$.raw(),$.cur)>=S.length;
  $.btn.textContent=last?(CFG.submit||'Absenden'):(CFG.tf?'OK':'Weiter');
  if(back)back.hidden=!hist.length;
  $.emit('nav',last)}
function show(i,dir){
  $.cur=i;
  steps.forEach(function(s,j){s.setAttribute('data-state',j===i?'active':(j<i?'before':'after'));s.inert=j!==i;s.setAttribute('aria-hidden',j===i?'false':'true')});
  $.refresh();nav();progress();$.emit('show',i,dir)}
// to the next screen (the first rule of a visible question that matches may skip some); false when this was the last one
$.go=function(){
  var n=$.nextShown(S,$.raw(),$.cur);
  if(n>=S.length)return false;
  hist.push($.cur);show(n,1);return true};
function goBack(){if(hist.length&&!$.btn.disabled)show(hist.pop(),-1)}
if(back)back.addEventListener('click',goBack);
// Alt + arrow up/down: back and next
$.root.addEventListener('keydown',function(e){
  if($.sub||!e.altKey||(e.key!=='ArrowUp'&&e.key!=='ArrowDown'))return;
  e.preventDefault();
  if(e.key==='ArrowUp')goBack();else $.next()});
form.addEventListener('change',nav);
// Enter on the last field of a page: that field is gone, the focus moves on to the new page instead of falling out of the form
if(!CFG.tf)$.on('show',function(i,dir){
  var a=document.activeElement;if(!dir||(a&&a!==document.body&&!(root.contains(a)&&a.closest('[inert]'))))return;
  var s=steps[i],c=s.querySelector('.pf-q:not([hidden]) input:not([type=hidden]),.pf-q:not([hidden]) select,.pf-q:not([hidden]) textarea');
  if(c)c.focus({preventScroll:true});else{s.tabIndex=-1;s.focus({preventScroll:true})}});
$.on('sent',function(){if(prog)prog.hidden=true});
$.run=function(){
  if(!welcome){show(0,0);return}
  form.hidden=true;if(prog)prog.hidden=true;
  welcome.querySelector('.pf-start').addEventListener('click',function(){
    welcome.hidden=true;form.hidden=false;if(prog)prog.hidden=false;$.started=true;show(0,1)})}
})();
