// The rules of a form in the browser: who sees which question (show_if) and where an answer leads (logic jumps).
// The same rules as matchRule / nextShown in server/services/form-logic.ts; tests/form-logic.test.ts runs both side by side.
// Plain ES5 functions without dependencies: that test also evaluates this file on its own.
function pfVals(v){
  var a=Array.isArray(v)?v:(v===undefined||v===null?[]:[v]),o=[];
  for(var i=0;i<a.length;i++){var s=String(a[i]).trim().toLowerCase();if(s)o.push(s)}
  return o}
function pfNum(s){
  s=String(s).trim();
  if(s==='')return NaN;
  var n=Number(s.replace(',','.'));
  return isFinite(n)?n:NaN}
function pfMatch(r,ans){
  var v=pfVals(ans),w=String(r.value===undefined||r.value===null?'':r.value).trim().toLowerCase();
  switch(r.op){
    case'filled':return v.length>0;
    case'empty':return v.length===0;
    case'neq':return v.indexOf(w)<0;
    case'contains':for(var i=0;i<v.length;i++){if(v[i].indexOf(w)>=0)return true}return false;
    case'gt':case'gte':case'lt':case'lte':
      var a=pfNum(v.length?v[0]:''),b=pfNum(w);
      if(isNaN(a)||isNaN(b))return false;
      return r.op==='gt'?a>b:r.op==='gte'?a>=b:r.op==='lt'?a<b:a<=b;
    default:return v.indexOf(w)>=0}}
function pfShown(q,raw){return !q.s||pfMatch(q.s,raw[q.s.field])}
function pfAnyShown(sc,raw){
  for(var k=0;k<sc.length;k++){var q=sc[k];if(q.h)continue;if(pfShown(q,raw))return true}
  return false}
function pfNextScreen(S,raw,i){
  var sc=S[i]||[];
  for(var k=0;k<sc.length;k++){
    var q=sc[k];
    if(!pfShown(q,raw))continue;
    var js=q.j||[];
    for(var m=0;m<js.length;m++){if(pfMatch(js[m],raw[q.n])&&js[m].to>i)return js[m].to}}
  return i+1}
function pfNextShown(S,raw,i){
  var n=pfNextScreen(S,raw,i);
  while(n<S.length&&!pfAnyShown(S[n],raw))n=pfNextScreen(S,raw,n);
  return n}
