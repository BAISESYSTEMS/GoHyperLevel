// A visitor who typed an e-mail address or phone number and left without sending: the details go to the server (workflow trigger
// "Formular abgebrochen"; the server keeps them only while a workflow listens).
(function(){
var form=$.form,timer,last='';
function send(){
  var fd=new FormData(form),p={};
  ['email','phone','first_name','last_name','name','company'].forEach(function(k){var v=fd.get(k);if(typeof v==='string'&&v.trim())p[k]=v.trim().slice(0,200)});
  if(!p.email&&!p.phone)return;
  var body=JSON.stringify(p);
  if(body===last)return;
  last=body;
  p._page=(window.top===window?location.href:document.referrer)||'';
  try{navigator.sendBeacon('/api/public/forms/'+CFG.id+'/partial',new Blob([JSON.stringify(p)],{type:'application/json'}))}catch(x){}}
form.addEventListener('change',function(){clearTimeout(timer);timer=setTimeout(send,1500)});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')send()});
})();
