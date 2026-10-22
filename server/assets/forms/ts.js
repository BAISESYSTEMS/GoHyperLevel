// Cloudflare Turnstile: the widget appears on the last screen, the form is not sent without its token.
// (Only on forms the owner protected with their own keys; the script of Cloudflare is added to the page by form-render.ts.)
(function(){
var box=$.root.querySelector('.pf-captcha'),tok='',widget=null,tried=0;
function ensure(){
  if(widget!==null)return;
  if(!window.turnstile){if(tried++<40)setTimeout(ensure,250);return}
  widget=window.turnstile.render(box,{sitekey:CFG.ts,callback:function(t){tok=t},'expired-callback':function(){tok=''},'error-callback':function(){tok=''}})}
$.on('nav',function(last){box.hidden=!last;if(last)ensure()});
// one screen only: nothing calls "nav", the widget is there from the start
if(!$.go){box.hidden=false;ensure()}
$.on('pre',function(){
  if(tok)return;
  $.err.textContent=window.turnstile?'Bitte kurz die Sicherheitsprüfung abwarten.':'Die Sicherheitsprüfung konnte nicht geladen werden. Bitte die Seite neu laden.';
  ensure();return false});
$.on('data',function(d){if(tok)d._ts=tok});
$.on('fail',function(){if(widget!==null&&window.turnstile){try{window.turnstile.reset(widget);tok=''}catch(x){}}});
})();
