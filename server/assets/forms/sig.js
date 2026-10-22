// Signature: drawing with finger, pen or mouse on a canvas; the picture (PNG, 600 x 200) becomes the answer.
(function(){
[].forEach.call($.form.querySelectorAll('.pf-q'),function(q){
  if(q.getAttribute('data-type')!=='signature')return;
  var h=q.querySelector('input[type=hidden]'),cv=q.querySelector('canvas'),cx=null,drawing=false,sized=false,lx=0,ly=0;
  // the canvas gets its pixel size when the first stroke starts (it may be hidden before)
  function size(){
    var r=cv.getBoundingClientRect(),d=window.devicePixelRatio||1;
    cv.width=Math.round(r.width*d);cv.height=Math.round(180*d);
    cx=cv.getContext('2d');cx.scale(d,d);cx.lineWidth=2.4;cx.lineCap='round';cx.lineJoin='round';cx.strokeStyle='#111';sized=true}
  function pos(e){var r=cv.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top]}
  cv.addEventListener('pointerdown',function(e){
    if(!sized)size();
    drawing=true;cv.setPointerCapture(e.pointerId);
    var p=pos(e);lx=p[0];ly=p[1];
    cx.beginPath();cx.moveTo(lx,ly);cx.lineTo(lx+0.01,ly);cx.stroke();e.preventDefault()});
  cv.addEventListener('pointermove',function(e){
    if(!drawing)return;
    var p=pos(e);
    cx.beginPath();cx.moveTo(lx,ly);cx.lineTo(p[0],p[1]);cx.stroke();lx=p[0];ly=p[1]});
  function end(){
    if(!drawing)return;
    drawing=false;
    var s=document.createElement('canvas');
    s.width=600;s.height=200;
    var c=s.getContext('2d');
    c.fillStyle='#fff';c.fillRect(0,0,600,200);c.drawImage(cv,0,0,600,200);
    h.value=s.toDataURL('image/png');$.clearErr(q);$.refresh()}
  cv.addEventListener('pointerup',end);
  cv.addEventListener('pointercancel',end);
  q.querySelector('.pf-clear').addEventListener('click',function(){if(cx)cx.clearRect(0,0,cv.width,cv.height);h.value='';$.refresh()})})})();
