// Calculator fields: the answers become numbers, the formulas are worked out as the visitor types (the server counts again).
// Needs the rules part (pfShown); pfCompute, pfEval and the rest are in logic-formula.js.
(function(){
var pfShown=$.shown;
/*@include logic-formula.js*/
function fmt(v,f){
  var n=Math.round(v*100)/100,s=new Intl.NumberFormat('de-DE',{minimumFractionDigits:f==='currency'?2:0,maximumFractionDigits:2}).format(n);
  return f==='currency'?s+' €':f==='percent'?s+' %':s}
$.on('refresh',function(){
  var vars=pfCompute(SPEC,$.raw());
  SPEC.f.forEach(function(e){
    if(e.k!=='calc')return;
    var q=$.q(e.id);
    if(!q||q.hidden)return;
    var v=vars[e.vn],out=q.querySelector('.pf-calc-v'),h=q.querySelector('input[type=hidden]');
    if(out)out.textContent=fmt(v,q.getAttribute('data-fmt'));
    if(h)h.value=String(Math.round(v*100)/100)})});
})();
