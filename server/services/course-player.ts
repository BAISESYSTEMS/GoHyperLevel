import { escapeHtml } from '../core/template.js';
import { SPEEDS, formatTimestamp, type Chapter } from './course-media.js';

/**
 * The video player of a hosted lesson video: server-rendered markup, a little CSS and one script file (`/portal-course.js`, served
 * by the course-video module – the member portal allows no inline scripts). The script does resume, playback speed, chapters, the
 * "watched" bookkeeping and the progress reports; everything else is the browser's own <video>.
 */

export interface PlayerConfig {
  title: string;
  /** Signed MP4 (range requests). */
  video: string;
  /** Signed HLS master playlist when the video was transcoded (Safari plays it natively, others take the MP4). */
  hls?: string;
  poster?: string;
  captions: { lang: string; label: string; src: string }[];
  chapters: Chapter[];
  /** Where to continue (seconds, 0 = from the start). */
  resume: number;
  speed: number;
  /** Where the player reports to. */
  post: string;
  /** "Complete at X %" (0 = off). */
  completePercent: number;
  duration: number;
  watched: number;
  furthest: number;
  done: boolean;
}

export function playerHtml(c: PlayerConfig): string {
  const data = escapeHtml(JSON.stringify({ post: c.post, resume: c.resume, speed: c.speed, pct: c.completePercent, duration: c.duration, watched: c.watched, furthest: c.furthest, done: c.done }));
  const tracks = c.captions.map((t, i) => `<track kind="captions" srclang="${escapeHtml(t.lang)}" label="${escapeHtml(t.label)}" src="${escapeHtml(t.src)}"${i === 0 ? ' default' : ''}>`).join('');
  const sources = `${c.hls ? `<source src="${escapeHtml(c.hls)}" type="application/vnd.apple.mpegurl">` : ''}<source src="${escapeHtml(c.video)}" type="video/mp4">`;
  const chapters = c.chapters.length
    ? `<ol class="cvp-ch" aria-label="Kapitel">${c.chapters.map((ch) => `<li><button type="button" data-t="${ch.t}"><span class="t">${formatTimestamp(ch.t)}</span><span>${escapeHtml(ch.title)}</span></button></li>`).join('')}</ol>`
    : '';
  const speeds = SPEEDS.map((s) => `<option value="${s}"${s === c.speed ? ' selected' : ''}>${String(s).replace('.', ',')}×</option>`).join('');
  return `<div class="cvp" data-cvp="${data}">
<div class="md-video"><video controls preload="metadata" playsinline controlslist="nodownload" disablepictureinpicture${c.poster ? ` poster="${escapeHtml(c.poster)}"` : ''} aria-label="${escapeHtml(c.title)}">${sources}${tracks}</video></div>
<div class="cvp-bar"><label class="cvp-sp">Geschwindigkeit <select class="cvp-speed" aria-label="Wiedergabegeschwindigkeit">${speeds}</select></label>${c.completePercent ? `<span class="cvp-hint small muted">Die Lektion gilt als erledigt, sobald du ${c.completePercent} % gesehen hast.</span>` : ''}<span class="cvp-note" role="status" aria-live="polite"></span></div>
${chapters}</div>`;
}

export const PLAYER_CSS = `<style>
.cvp{margin:18px 0 22px}.cvp .md-video{margin:0}.cvp video{background:#000}
.cvp-bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin-top:10px;font-size:14px}
.cvp-sp{display:flex;gap:8px;align-items:center;color:var(--muted)}.cvp-speed{min-height:44px;padding:0 10px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);font:inherit}
.cvp-speed:focus-visible,.cvp-ch button:focus-visible,.cvp-note button:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
.cvp-note{margin-left:auto;display:inline-flex;gap:10px;align-items:center;color:var(--text)}.cvp-note:empty{display:none}
.cvp-note button{min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--brand);font:inherit;font-weight:600;cursor:pointer}
.cvp-ch{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:6px}.cvp-ch button{width:100%;min-height:44px;display:flex;gap:12px;align-items:center;padding:6px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);font:inherit;text-align:left;cursor:pointer}
.cvp-ch button:hover{border-color:var(--brand)}.cvp-ch .t{font-variant-numeric:tabular-nums;color:var(--brand);font-weight:700;min-width:52px}.cvp-ch .on button{background:var(--soft);border-color:var(--brand);font-weight:600}
@media (max-width:560px){.cvp-note{margin-left:0;width:100%}}
</style>`;

/** The page script. ES5, no template strings (it lives inside a TS string). */
export const PLAYER_JS = `(function(){
function fmt(s){s=Math.max(0,Math.floor(s));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return(h?h+':'+(m<10?'0':''):'')+m+':'+(r<10?'0':'')+r}
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){}return null}
function init(el){
  var cfg;try{cfg=JSON.parse(el.getAttribute('data-cvp')||'{}')}catch(e){return}
  var v=el.querySelector('video');if(!v||!cfg.post)return;
  var sel=el.querySelector('.cvp-speed'),note=el.querySelector('.cvp-note'),items=el.querySelectorAll('.cvp-ch li');
  var watched=cfg.watched||0,furthest=cfg.furthest||0,lastT=null,lastSent=0,done=!!cfg.done,timer=0;
  var speed=cfg.speed&&cfg.speed!==1?cfg.speed:parseFloat(ls('cvp-speed'))||cfg.speed||1;
  function setSpeed(s){speed=s;v.defaultPlaybackRate=s;v.playbackRate=s}
  setSpeed(speed);if(sel){sel.value=String(speed);if(sel.value!==String(speed))sel.value='1';sel.addEventListener('change',function(){var s=parseFloat(sel.value)||1;setSpeed(s);ls('cvp-speed',String(s));send(false)})}
  function say(text,label,fn){if(!note)return;note.textContent='';var t=document.createElement('span');t.textContent=text;note.appendChild(t);if(label){var b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',function(){fn();note.textContent=''});note.appendChild(b)}clearTimeout(timer);timer=setTimeout(function(){note.textContent=''},9000)}
  var resumed=false;function resume(){if(resumed)return;resumed=true;if(cfg.resume>0){try{v.currentTime=cfg.resume}catch(e){}say('Weiter bei '+fmt(cfg.resume),'Von vorn',function(){v.currentTime=0})}}
  if(v.readyState>=1)resume();else v.addEventListener('loadedmetadata',resume);
  function mark(t){var on=-1;for(var i=0;i<items.length;i++){var b=items[i].querySelector('button');if(b&&parseFloat(b.getAttribute('data-t'))<=t+0.25)on=i}for(var j=0;j<items.length;j++){if(j===on)items[j].className='on';else items[j].className=''}}
  for(var i=0;i<items.length;i++)(function(b){if(!b)return;b.addEventListener('click',function(){var t=parseFloat(b.getAttribute('data-t'))||0;try{v.currentTime=t}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){})})})(items[i].querySelector('button'));
  function send(keep){lastSent=Date.now();var dur=v.duration;if(!isFinite(dur)||dur<=0)dur=cfg.duration||0;
    var body=JSON.stringify({position:v.currentTime||0,duration:dur,furthest:furthest,watched:watched,speed:speed});
    try{fetch(cfg.post,{method:'POST',headers:{'content-type':'application/json','x-course-player':'1'},body:body,keepalive:!!keep,credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.completed&&!done){done=true;say('✓ Lektion als erledigt gespeichert')}}).catch(function(){})}catch(e){}}
  v.addEventListener('timeupdate',function(){var t=v.currentTime;if(!v.paused&&!v.seeking&&lastT!==null){var d=t-lastT;if(d>0&&d<=3*v.playbackRate+1)watched+=d}lastT=t;if(t>furthest)furthest=t;mark(t);if(!v.paused&&Date.now()-lastSent>10000)send(false)});
  v.addEventListener('seeking',function(){lastT=null});v.addEventListener('seeked',function(){lastT=v.currentTime});v.addEventListener('play',function(){lastT=v.currentTime});
  v.addEventListener('pause',function(){send(false)});v.addEventListener('ended',function(){send(false)});
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')send(true)});window.addEventListener('pagehide',function(){send(true)});
}
var els=document.querySelectorAll('.cvp');for(var k=0;k<els.length;k++)init(els[k]);
})();`;
