// One question at a time: moves the focus to the new question, advances after a choice, letters A, B, C … pick an option.
(function(){
var root=$.root,hint=root.querySelector('.pf-hintkey'),AUTO={radio:1,picture_choice:1,rating:1,nps:1,scale:1},
  OPEN='.pf-q:not([hidden]) ',TEXT=OPEN+'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]),'+OPEN+'textarea,'+OPEN+'select';
// a single choice that is the only question of its screen leads on by itself
$.on('pick',function(q){
  var t=q.getAttribute('data-type');
  if(!CFG.auto||!AUTO[t]||(t==='picture_choice'&&q.querySelector('input[type=checkbox]')))return;
  if($.steps[$.cur].querySelectorAll('.pf-q:not([hidden]):not([data-type=heading]):not([data-type=hidden])').length!==1)return;
  setTimeout($.next,300)});
$.on('show',function(i,dir){
  if(dir===0&&!CFG.standalone)return;
  setTimeout(function(){var s=$.steps[i],c=s.querySelector(TEXT);if(c&&c.focus){c.focus({preventScroll:true});return}
    // nothing to type into (choices, stars, scales): a focus left behind on the last question goes to this screen, so Enter and the letters keep working
    var a=document.activeElement;if(a&&a!==document.body&&!(root.contains(a)&&a.closest('[inert]')))return;
    s.tabIndex=-1;s.focus({preventScroll:true})},80)});
$.on('nav',function(){if(hint)hint.hidden=!window.matchMedia||!matchMedia('(hover:hover)').matches});
root.addEventListener('keydown',function(e){
  if($.sub)return;
  var t=e.target,tag=(t.tagName||'').toLowerCase(),type=(t.type||'').toLowerCase();
  if(e.key.length!==1||!/[a-z]/i.test(e.key)||e.ctrlKey||e.metaKey||e.altKey||tag==='textarea'||tag==='select'||(tag==='input'&&type!=='radio'&&type!=='checkbox'))return;
  var o=$.steps[$.cur].querySelectorAll(OPEN+'.pf-opt input,'+OPEN+'.pf-pic input')[e.key.toLowerCase().charCodeAt(0)-97];
  if(o){e.preventDefault();o.click();o.focus({preventScroll:true})}});
})();
