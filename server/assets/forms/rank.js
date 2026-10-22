// Ranking: the visitor moves options up and down; the order becomes the answer (nothing is sent until something was moved).
(function(){
[].forEach.call($.form.querySelectorAll('.pf-q'),function(q){
  if(q.getAttribute('data-type')!=='ranking')return;
  var name=q.getAttribute('data-name'),ol=q.querySelector('.pf-rank'),box=q.querySelector('.pf-rank-in'),touched=false;
  function sync(){
    box.innerHTML='';
    if(!touched)return;
    [].forEach.call(ol.children,function(li){var i=document.createElement('input');i.type='hidden';i.name=name;i.value=li.getAttribute('data-v');box.appendChild(i)});
    $.refresh()}
  ol.addEventListener('click',function(e){
    var b=e.target.closest('button');
    if(!b)return;
    var li=b.closest('li');
    if(b.hasAttribute('data-up')&&li.previousElementSibling)ol.insertBefore(li,li.previousElementSibling);
    else if(b.hasAttribute('data-down')&&li.nextElementSibling)ol.insertBefore(li.nextElementSibling,li);
    touched=true;$.clearErr(q);sync();b.focus()})})})();
