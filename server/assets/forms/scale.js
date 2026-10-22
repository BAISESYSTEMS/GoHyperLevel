// Rating stars, NPS and scale buttons (arrow keys move, a click picks) and the slider of a scale.
(function(){
[].forEach.call($.form.querySelectorAll('.pf-q'),function(q){
  var t=q.getAttribute('data-type'),h=q.querySelector('input[type=hidden]');
  if(t==='rating'||t==='nps'||(t==='scale'&&q.querySelector('.pf-scale'))){
    var btns=[].slice.call(q.querySelectorAll('[data-v]'));
    var mark=function(){
      var v=h.value;
      btns.forEach(function(b){
        var val=b.getAttribute('data-v'),on=t==='rating'?(v!==''&&Number(val)<=Number(v)):val===v;
        b.classList.toggle('on',on);b.setAttribute('aria-checked',String(val===v))})};
    btns.forEach(function(b){
      b.addEventListener('click',function(){h.value=b.getAttribute('data-v');mark();$.refresh();$.clearErr(q);$.emit('pick',q)});
      b.addEventListener('keydown',function(e){
        var i=btns.indexOf(b),d=e.key==='ArrowRight'||e.key==='ArrowUp'?1:e.key==='ArrowLeft'||e.key==='ArrowDown'?-1:0;
        if(d&&!e.altKey){e.preventDefault();var n=btns[Math.min(Math.max(i+d,0),btns.length-1)];n.focus();n.click()}})})}
  if(t==='scale'&&q.querySelector('[data-slider]')){
    var sl=q.querySelector('[data-slider]'),out=q.querySelector('.pf-out');
    sl.addEventListener('input',function(){h.value=sl.value;out.textContent=sl.value;$.refresh();$.clearErr(q)})}})})();
