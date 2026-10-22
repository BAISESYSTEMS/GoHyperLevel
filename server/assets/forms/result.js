// The ending after submit: title, the values of the form and a text (an ending by score, a calculator result).
(function(){
$.on('result',function(res){
  var d=$.done,h=document.createElement('h2');
  d.textContent='';
  h.textContent=res.title||'Dein Ergebnis';d.appendChild(h);
  if(res.values){
    var box=document.createElement('div');
    box.className='pf-vals';
    Object.keys(res.values).forEach(function(n){var s=document.createElement('span');s.textContent=n+': '+res.values[n];box.appendChild(s)});
    d.appendChild(box)}
  if(res.text){var p=document.createElement('p');p.textContent=res.text;d.appendChild(p)}})})();
