// Date range: two date fields become one answer "from/to" (the end cannot be before the start).
(function(){
[].forEach.call($.form.querySelectorAll('.pf-q'),function(q){
  if(q.getAttribute('data-type')!=='date_range')return;
  var h=q.querySelector('input[type=hidden]'),f=q.querySelector('[data-from]'),to=q.querySelector('[data-to]');
  function upd(){
    if(f.value)to.min=f.value;
    h.value=f.value&&to.value&&f.value<=to.value?f.value+'/'+to.value:'';
    $.clearErr(q);$.refresh()}
  f.addEventListener('change',upd);to.addEventListener('change',upd)})})();
