import { jsonForScript } from '../core/page.js';
import { E164 } from './twilio.js';

/**
 * Pure building blocks of dynamic number insertion: which number a visitor gets from a pool, whether a visit's source
 * qualifies for a pool, how a number is shown, and the JavaScript snippet that swaps the number on a page. No database.
 */

export interface PoolNumber {
  id: string;
  number: string;
}
export interface ActiveSession {
  id: string;
  number_id: string;
  visitor_id: string;
  last_seen_ms: number;
}

export interface Pick {
  /** The number to show; null = show the pool's fallback number. */
  number: PoolNumber | null;
  /** An already running session that continues (same browser tab or same visitor). */
  reuse: ActiveSession | null;
  /** The pool was used up and the oldest session's number is shared: attribution is less exact. */
  shared: boolean;
}

/**
 * The number for a visit. A visitor who already has a running session keeps the number (so the number does not change from
 * page to page); a new one gets a number nobody is using right now – the one that has been quiet the longest, so a call that
 * comes in a little late still belongs to the session that had it. When all numbers are in use: `fallback` shows the
 * fallback number (exact but incomplete), `oldest` shares the number of the quietest session (complete but less exact).
 */
export function pickNumber(o: { numbers: PoolNumber[]; active: ActiveSession[]; lastUsed: Map<string, number>; sid?: string; visitorId?: string; exhausted: 'fallback' | 'oldest' }): Pick {
  const own = o.active.find((s) => (o.sid && s.id === o.sid) || (o.visitorId && s.visitor_id === o.visitorId));
  if (own) {
    const n = o.numbers.find((x) => x.id === own.number_id);
    if (n) return { number: n, reuse: own, shared: false };
  }
  const busy = new Set(o.active.map((s) => s.number_id));
  const free = o.numbers.filter((n) => !busy.has(n.id)).sort((a, b) => (o.lastUsed.get(a.id) ?? 0) - (o.lastUsed.get(b.id) ?? 0));
  if (free.length) return { number: free[0], reuse: null, shared: false };
  if (o.exhausted === 'oldest' && o.active.length) {
    const quiet = [...o.active].sort((a, b) => a.last_seen_ms - b.last_seen_ms).find((s) => o.numbers.some((n) => n.id === s.number_id));
    const n = quiet && o.numbers.find((x) => x.id === quiet.number_id);
    if (n) return { number: n, reuse: null, shared: true };
  }
  return { number: null, reuse: null, shared: false };
}

/**
 * Whether a visit qualifies for a pool. Patterns: `google/cpc` (source and medium), `google` (source only), a star for
 * either part (`star/cpc`: any source, medium cpc), or a channel name (`campaign`, `referral`, `direct`). An empty list
 * qualifies everybody.
 */
export function matchesSources(patterns: string[], t: { source: string; medium: string; channel: string }): boolean {
  if (!patterns.length) return true;
  const src = t.source.toLowerCase();
  const med = t.medium.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    if (p === t.channel) return true;
    const [ps, pm] = p.split('/');
    if (pm === undefined) return ps === src;
    return (ps === '*' || ps === src) && (pm === '*' || pm === med);
  });
}

/** The number as people read it: German numbers as 030 1234567, others internationally (+43 1 234567). */
export function formatDisplay(e164: string): string {
  if (!E164.test(e164)) return e164;
  if (e164.startsWith('+49')) {
    const nsn = e164.slice(3);
    // Mobile (15x, 16x, 17x) and free numbers (800) have three-digit prefixes; the big cities two; the rest three.
    const area = /^(30|40|69|89)/.test(nsn) ? 2 : 3;
    return `0${nsn.slice(0, area)} ${nsn.slice(area)}`;
  }
  const cc = e164.slice(1).match(/^(1|7|2(?!0|7)\d\d|3[578]\d|42\d|50\d|59\d|6[789]\d|8[58]\d|88\d|9[679]\d|\d\d)/)?.[1] ?? e164.slice(1, 3);
  const rest = e164.slice(1 + cc.length);
  return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3)}`.trim();
}

/** The tel: link of a number. */
export const telHref = (e164: string) => `tel:${e164}`;

// --- the page snippet ---------------------------------------------------------------------------------------------------

/**
 * The JavaScript that swaps the number: one request per visit to /api/public/dni/<loc>/session, then every
 * `[data-pghl-phone]`, every tel: link and every text that contains the number printed on the site (any common way of
 * writing it) is replaced – also text that appears later (single-page sites). It respects the visitor's cookie choice
 * exactly like the tracking snippet and keeps the session id in the tab (sessionStorage) so the number does not change on
 * the next page.
 */
export function dniScript(o: { locationId: string; poolId: string; consentCookie: string; visitorCookie: string }): string {
  return `(function(){if(window.__pghlDni)return;window.__pghlDni=1;
var cur=document.currentScript,base=cur?new URL(cur.src).origin:'',loc=${jsonForScript(o.locationId)},pool=${jsonForScript(o.poolId)},K=${jsonForScript(o.visitorCookie)},S='pghl_dni';
function ck(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):''}
function consent(){var c=window.pghlConsent;if(c===true||c===false)return c?'granted':'denied';c=ck(${jsonForScript(o.consentCookie)});if(/^(0|no|false|denied|deny|none|necessary)$/i.test(c))return'denied';if(/^(1|yes|true|granted|all|marketing|statistics|analytics)$/i.test(c))return'granted';return navigator.globalPrivacyControl?'denied':'unknown'}
function digits(s){return String(s||'').replace(/\\D/g,'')}
function national(s){var d=digits(s);if(d.indexOf('0049')===0)d=d.slice(4);else if(d.indexOf('49')===0&&String(s).indexOf('+')>=0)d=d.slice(2);else if(d.indexOf('0')===0)d=d.slice(1);return d}
function regexFor(n){var d=national(n);if(d.length<5)return null;var sep='[\\\\s\\\\-/.()\\\\u00a0]*';return new RegExp('(^|[^\\\\d])((?:(?:\\\\+49|0049)'+sep+'(?:\\\\(0\\\\)'+sep+')?|\\\\(?0'+sep+')'+d.split('').join(sep)+')(?!\\\\d)','g')}
function swapText(t,re,rep,intl){return t.replace(re,function(m,pre,num){return pre+(num.charAt(0)==='+'||num.indexOf('0049')===0?intl:rep)})}
var st=consent();if(st==='denied')return;
var sid='';try{sid=sessionStorage.getItem(S)||''}catch(e){}
function run(j){
 var re=j.default_number?regexFor(j.default_number):null,rep=j.display,intl=j.display_intl||j.number,href='tel:'+j.number,defNat=j.default_number?national(j.default_number):'';
 function el(e){if(e.textContent!==rep)e.textContent=rep;if(e.tagName==='A'&&e.getAttribute('href')!==href)e.setAttribute('href',href)}
 function walk(root){
  if(!root||root.nodeType!==1&&root.nodeType!==9&&root.nodeType!==11)return;
  var q=[];try{q=root.querySelectorAll?root.querySelectorAll('[data-pghl-phone]'+(j.selector?','+j.selector:'')):[]}catch(e){q=root.querySelectorAll?root.querySelectorAll('[data-pghl-phone]'):[]}for(var i=0;i<q.length;i++)el(q[i]);
  var a=root.querySelectorAll?root.querySelectorAll('a[href^="tel:"]'):[];for(var k=0;k<a.length;k++){var d=national(a[k].getAttribute('href'));if((defNat&&d===defNat||a[k].hasAttribute('data-pghl-phone'))&&a[k].getAttribute('href')!==href){a[k].setAttribute('href',href)}}
  if(!re||!document.createTreeWalker)return;
  var w=document.createTreeWalker(root,4,null),n,list=[];while(n=w.nextNode()){var p=n.parentNode&&n.parentNode.nodeName;if(p==='SCRIPT'||p==='STYLE'||p==='NOSCRIPT'||p==='TEXTAREA')continue;re.lastIndex=0;if(re.test(n.nodeValue))list.push(n)}
  for(var x=0;x<list.length;x++){re.lastIndex=0;list[x].nodeValue=swapText(list[x].nodeValue,re,rep,intl)}
 }
 var go=function(){walk(document);if(window.MutationObserver&&document.body){var busy=0;new MutationObserver(function(ms){if(busy)return;busy=1;setTimeout(function(){busy=0;walk(document)},150)}).observe(document.body,{childList:true,subtree:true})}};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();
 window.pghlPhone=j.number;
}
window.__pghlDniSwap={regexFor:regexFor,swapText:swapText,national:national};
fetch(base+'/api/public/dni/'+encodeURIComponent(loc)+'/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pool:pool,sid:sid,token:window.pghlAttr||ck(K),url:location.href,referrer:document.referrer,consent:st}),keepalive:true})
.then(function(r){return r.json()}).then(function(j){if(!j||!j.number)return;try{if(j.sid)sessionStorage.setItem(S,j.sid)}catch(e){}run(j)}).catch(function(){});
})();`;
}
