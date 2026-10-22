// Show-if: a question appears (and counts, and is required) only while another answer matches. Needs the rules part.
(function(){
$.on('refresh',function(){
  var r=$.raw();
  SPEC.S.forEach(function(sc){sc.forEach(function(e){
    var q=e.s&&$.q(e.i);
    if(!q)return;
    var on=$.shown(e,r);
    // a hidden question stops sending its answer: its fields are disabled
    if(q.hidden===on){q.hidden=!on;[].forEach.call(q.querySelectorAll('input,select,textarea'),function(x){x.disabled=!on})}})})})})();
