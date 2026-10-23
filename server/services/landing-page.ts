import { createHash } from 'node:crypto';
import { escapeHtml as h } from '../core/template.js';
import { yearlyCents } from './cloud.js';
import { COPY, type Copy, type Lang } from './landing-copy.js';
import { CALC_DEFAULT, EUR_USD, HL_AS_OF, HL_PRICES, HL_SOURCE, SUBS_MAX, calcQuery, calculate, shareLinks, type CalcInput, type OurPrices } from './landing-calc.js';
import { OUR_ID, matrixCss, matrixHtml, mixTools, type Matrix, type MixTool } from './landing-compare.js';
import { WHY_SWITCH } from './landing-switch.js';
import { stackFoot, stackHtml, type Stack } from './landing-stack.js';
import { WAITLIST_ANCHOR, waitlistFormHtml, wlText, type WaitlistView, type WlClasses } from './cloud-waitlist.js';
import { waitlistNote, whyWaitlist, withWaitlist } from './landing-waitlist-copy.js';
import { AGENTIC, type AgenticCopy, type ShotKey } from './landing-agentic-copy.js';
import { AGENTIC_CSS, academySection, designsSection, jarvisSection, ossSection, ssotSection, uspSection, xrSection, type AgenticCtx, type Shot } from './landing-agentic.js';
import { LOGOS_CSS, logosHtml } from './landing-logos.js';

/**
 * Launch landing page (PGHL_LANDING=1), the HTML: `/` (English), `/de`, `/vergleich` and `/vergleich/highlevel` (each also
 * under /de). Server-rendered, no cookies, nothing from third parties; one small inline script (allowed by its hash) makes the
 * calculator live and the copy button work – without it everything still works (the calculator is a GET form whose URL
 * carries the result). Pure: the module passes everything in.
 * Cloud waitlist mode (`LandingData.waitlist`): self-hosting is the main call to action, the cloud plans are marked as planned, every
 * cloud button scrolls to the waitlist form (#warteliste) and the texts come from landing-waitlist-copy.ts.
 * The home page leads with the agentic side: the integrations row (landing-logos.ts) under the hero, then one source of truth, Jarvis,
 * what makes the product different, the agents, the Academy, designs and XR (landing-agentic.ts, texts in landing-agentic-copy.ts).
 */

export const GITHUB_URL = 'https://github.com/BAISESYSTEMS/hyperlevel';
/** `/demo` signs the visitor in and opens the app – no login page in between (see modules/demo.ts). */
export const DEMO_URL = 'https://demo.gohyperlevel.com/demo';
export const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/BAISESYSTEMS/hyperlevel/main/scripts/install.sh | bash';
export const FONT_FILE = '/landing/inter-tight-latin-wght-normal.woff2';

export type PageKind = 'home' | 'compare' | 'highlevel';
export type { Shot };
export interface LandingData {
  kind: PageKind;
  lang: Lang;
  brand: string;
  /** Absolute origin for canonical links, og:image and share links (no trailing slash). */
  base: string;
  prices: OurPrices;
  yearlyDiscount: number;
  /** /cloud with cloud mode, else the pricing section. */
  cloudUrl: string;
  stars?: number;
  /** Counted from the running code (tests: from the build); themes and icon packs from the appearance model. */
  stats: { areas: number; tools: number; integrations: number; triggers: number; actions: number; themes: number; iconPacks: number; tests?: number };
  apk?: { version: string; size: number; sha256: string };
  qr: { android: string; ios: string };
  matrix?: Matrix;
  /** "Replaces your stack" (web/public/landing/replaces.json); the section is left out without it. */
  stack?: Stack;
  calc: { input: CalcInput; mode: 'mix' | 'hl'; mix: string[]; shared: boolean };
  legal: { imprint?: string; privacy?: string };
  /** Screenshots that exist on disk, by key (the hero shows up to four, the spotlights their own). */
  shots: Shot[];
  /** Cloud waitlist mode: the form to render (services/cloud-waitlist.ts); absent = the cloud is open (or not offered here). */
  waitlist?: WaitlistView;
}

/** The waitlist form in the look of this page. */
const WL_CLASSES: WlClasses = { form: 'wlf', row: 'wlf-row', label: 'wlf-l', input: 'wlf-in', check: 'wlf-chk', button: 'btn primary wlf-btn', note: 'wlf-note', ok: 'wlf-ok', err: 'wlf-err', hp: 'wlf-hp' };

/** English is the primary page (X, Reddit, HN link to `/`), German lives under /de. */
const LANG_PREFIX: Record<Lang, string> = { en: '', de: '/de' };
export const pagePath = (kind: PageKind, lang: Lang) => `${LANG_PREFIX[lang]}${kind === 'home' ? '' : kind === 'compare' ? '/vergleich' : '/vergleich/highlevel'}` || '/';

/** The copy with the product name filled in (strings and the strings functions return). */
function branded<T>(c: T, brand: string): T {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{b\}/g, brand);
    if (typeof v === 'function') return (...a: unknown[]) => fill((v as (...x: unknown[]) => unknown)(...a));
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(c) as T;
}

const money = (locale: string, currency: string, amount: number, frac?: number) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: frac ?? (amount % 1 ? 2 : 0), maximumFractionDigits: frac ?? 2 }).format(amount);
const eurC = (c: Copy, cents: number) => money(c.locale, 'EUR', cents / 100);
const eur0 = (c: Copy, euros: number) => money(c.locale, 'EUR', Math.round(euros), 0);
const usd0 = (c: Copy, n: number) => money(c.locale, 'USD', n, 0);
const num = (c: Copy, n: number) => n.toLocaleString(c.locale);
const dateText = (c: Copy, iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(c.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// --- icons (inline SVG; Android robot CC BY 3.0 Google, others lucide ISC) ----------------------------------------------

const svg = (body: string, cls = 'ic', vb = '0 0 24 24') => `<svg class="${cls}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;
const stroke = (d: string, cls?: string) => svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</g>`, cls);
const ICON = {
  android: svg('<path fill="currentColor" d="M17.6 9.48 19.44 6.3a.38.38 0 1 0-.66-.38l-1.86 3.22a11.46 11.46 0 0 0-9.84 0L5.22 5.92a.38.38 0 1 0-.66.38L6.4 9.48A10.78 10.78 0 0 0 1 18h22a10.78 10.78 0 0 0-5.4-8.52ZM7 15.25A1.25 1.25 0 1 1 8.25 14 1.25 1.25 0 0 1 7 15.25Zm10 0A1.25 1.25 0 1 1 18.25 14 1.25 1.25 0 0 1 17 15.25Z"/>', 'ic droid'),
  headset: stroke('<path d="M3 9a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-3l-2-2.5h-2L9 18H6a3 3 0 0 1-3-3z"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/>'),
  devices: stroke('<rect width="10" height="14" x="3" y="8" rx="2"/><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4"/><path d="M8 18h.01"/>'),
  share: stroke('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>', 'ic sm'),
  star: svg('<path fill="currentColor" d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.53L12 17.5l-5.87 3.07 1.12-6.53L2.5 9.41l6.56-.95L12 2.5Z"/>', 'ic sm'),
  copy: stroke('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', 'ic sm'),
  check: stroke('<path d="M20 6 9 17l-5-5"/>', 'ic sm'),
  arrow: stroke('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', 'ic sm'),
  play: stroke('<polygon points="6 3 20 12 6 21 6 3"/>', 'ic sm'),
};

// --- the inline script ---------------------------------------------------------------------------------------------------

/**
 * Live calculator (same maths as landing-calc.ts – tests/landing.test.ts runs both against each other), share links that follow,
 * the copy button, and a spotlight picture that fails to load hides its figure. Data comes from the JSON block #calc-data; the CSP allows exactly this script by its hash.
 */
export const SCRIPT = `(()=>{const $=s=>document.querySelector(s);const d=JSON.parse(($('#calc-data')||{}).textContent||'null');
const f=$('#calc');if(d&&f){const fm=(v,c,fr)=>new Intl.NumberFormat(d.locale,{style:'currency',currency:c,currencyDisplay:'narrowSymbol',minimumFractionDigits:fr,maximumFractionDigits:fr}).format(v);
const run=()=>{const v=new FormData(f);const mode=v.get('m')==='hl'?'hl':'mix';const host=v.get('h')==='cloud'?'cloud':'self';f.dataset.mode=mode;
let them,themTxt,our='self',note='';if(mode==='mix'){const sel=d.mix.filter(t=>v.getAll('t').includes(t.key));const c=sel.reduce((a,t)=>a+t.cents,0);them=Math.round(c*12/100);themTxt=d.t.mix.replace('{eur}',fm(c/100,'EUR',2)).replace('{n}',sel.length);if(host==='cloud')our='solo'}
else{const n=Math.min(d.subsMax,Math.max(1,Math.round(+v.get('n')||1)));$('#calc-n-out').textContent=n;let p=v.get('p');p=p==='starter'||p==='pro'?p:'unlimited';const bump=p==='starter'&&n>3;if(bump)p='unlimited';
const app=v.get('app')==='1';const usd=d.hl[p]+(app?d.hl.wlApp:0);them=Math.round(usd*12/d.rate);themTxt=d.t.hl.replace('{usd}',fm(usd,'USD',0)).replace('{plan}',d.t.plans[p]);
const saas=host==='cloud'&&p==='pro';if(host==='cloud'&&!saas)our=n>1||app?'agency':'team';note=[bump?d.t.bumped:'',saas?d.t.saas:''].filter(Boolean).join(' ')}
const oc=our==='self'?0:d.ours[our];const ourY=Math.round(oc*12/100);const save=Math.max(0,them-ourY);
$('#calc-save').textContent=d.t.save.replace('{eur}',fm(save,'EUR',0));$('#calc-them').textContent=themTxt;
$('#calc-us').textContent=d.t.us.replace('{what}',our==='self'?d.t.our.self:d.t.our[our]+' · '+fm(oc/100,'EUR',oc%100?2:0)+' '+d.t.perMonth);$('#calc-note').textContent=note;
const q=new URLSearchParams();q.set('m',mode);if(mode==='mix')v.getAll('t').forEach(t=>q.append('t',t));else{q.set('p',v.get('p'));q.set('n',v.get('n'));q.set('app',v.get('app')==='1'?'1':'0')}q.set('h',host);
const url=d.base+d.path+'?'+q+'#rechner';history.replaceState(null,'',d.path+'?'+q+'#rechner');const txt=d.t.share.replace('{eur}',fm(save,'EUR',0));const u=encodeURIComponent(url),tx=encodeURIComponent(txt);
$('#share-x').href='https://x.com/intent/post?text='+tx+'&url='+u;$('#share-li').href='https://www.linkedin.com/sharing/share-offsite/?url='+u;$('#share-rd').href='https://www.reddit.com/submit?url='+u+'&title='+tx;};
f.addEventListener('input',run);f.addEventListener('change',run);f.classList.add('live');}
document.querySelectorAll('img[data-hide]').forEach(i=>{const f=()=>{const p=i.closest('[data-fig]');if(p)p.hidden=true};if(i.complete&&!i.naturalWidth)f();else i.addEventListener('error',f)});
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',()=>{const t=document.getElementById(b.dataset.copy);if(!t||!navigator.clipboard)return;navigator.clipboard.writeText(t.textContent.trim()).then(()=>{const l=b.querySelector('.lbl');const o=l.textContent;l.textContent=b.dataset.done;setTimeout(()=>l.textContent=o,1800)})}));})();`;
export const SCRIPT_HASH = `sha256-${createHash('sha256').update(SCRIPT).digest('base64')}`;
export const CSP = `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; script-src '${SCRIPT_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

// --- CSS -----------------------------------------------------------------------------------------------------------------

export const CSS = `
@font-face{font-family:"Inter Tight";src:url(${FONT_FILE}) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{--ink:#0a1430;--ink2:#12204a;--paper:#f6f5ef;--card:#ffffff;--line:#dedcd2;--muted:#545a66;--accent:#ffb547;--accent2:#f59e0b;--on-dark:#f4f4ef;--muted-dark:#aeb4c2;--ok:#16794a;--no:#a23b2a;--part:#8a5a00;--display:"Inter Tight",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 var(--display);font-weight:400;letter-spacing:.012em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:inherit;text-underline-offset:3px}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent2);outline-offset:3px;border-radius:6px}
.skip{position:absolute;left:12px;top:-60px;background:var(--accent);color:var(--ink);padding:10px 14px;border-radius:10px;font-weight:600;z-index:10}
.skip:focus{top:12px}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
@media(min-width:720px){.wrap{padding:0 28px}}
.ic{width:24px;height:24px;flex:none}.ic.sm{width:18px;height:18px}
.droid{color:#3ddc84}

/* the hero: rotating words in a soft gold (systeme.io style, pure CSS, one word at a time, reduced motion shows the first), who it is for as a smaller line */
.hero h1{max-width:24ch}
.rot{display:inline-block;height:1.22em;overflow:hidden;vertical-align:top;color:var(--accent)}
.rot-in{display:flex;flex-direction:column;animation:rot calc(var(--n) * 2.2s) cubic-bezier(.7,0,.2,1) infinite}
.rot-in b{font-weight:inherit;height:1.22em;line-height:1.22em;white-space:nowrap;background:linear-gradient(92deg,#ffe3ad,#ffb547 55%,#f59e0b);-webkit-background-clip:text;background-clip:text;color:transparent}
${rotFrames(COPY.de.hero.rotate.length)}
@media (prefers-reduced-motion:reduce){.rot-in{animation:none}}
.hero h1 .tail{display:block;max-width:30ch;margin-top:.45em;font-size:clamp(21px,2.5vw,31px);line-height:1.2;font-weight:500;letter-spacing:-.012em;color:#dfe3ec}
/* a slow aurora behind the hero */
.dark{position:relative;isolation:isolate;overflow:hidden}
.dark::before{content:"";position:absolute;inset:-20% -10% auto;height:620px;z-index:-1;background:radial-gradient(40% 50% at 20% 30%,#1d4ed855,transparent 70%),radial-gradient(35% 45% at 80% 20%,#ffb54733,transparent 70%),radial-gradient(30% 40% at 60% 70%,#0ea5e944,transparent 70%);filter:blur(10px);animation:aur 18s ease-in-out infinite alternate}
@keyframes aur{to{transform:translate3d(0,24px,0) scale(1.06)}}
@media (prefers-reduced-motion:reduce){.dark::before{animation:none}}
/* top + hero (dark) */
.dark{background:radial-gradient(1200px 520px at 85% -10%,#1d3a8a 0%,rgba(29,58,138,0) 60%),var(--ink);color:var(--on-dark)}
.top{display:flex;align-items:center;gap:12px;padding:14px 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--display);font-weight:600;font-size:20px;letter-spacing:-.01em;text-decoration:none}
.brand .mk{width:34px;height:34px;border-radius:9px;display:block}
.nav{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap;align-items:center}
.nav a{color:var(--muted-dark);text-decoration:none;font-weight:500;font-size:15px;padding:10px 10px;border-radius:9px;min-height:44px;display:inline-flex;align-items:center}
.nav a:hover{color:var(--on-dark);background:#ffffff14}
.nav .lang{border:1px solid #ffffff2e;color:var(--on-dark)}
@media(max-width:860px){.nav .opt{display:none}}
.gh{display:inline-flex;align-items:center;gap:7px;color:var(--muted-dark);text-decoration:none;font-weight:500;font-size:15px;min-height:44px;padding:0 4px}
.gh:hover{color:var(--on-dark)}
.gh .ic{color:#f3c983;width:18px;height:18px}
.hero{padding:30px 0 40px;display:grid;gap:40px}
@media(min-width:1000px){.hero{padding:56px 0 64px}}
.kicker{color:#f3c983;font-weight:500;font-size:14px;letter-spacing:.04em;margin:18px 0 18px;text-transform:none}
h1,.h1{font-family:var(--display);font-weight:600;font-size:clamp(36px,5.6vw,68px);line-height:1.06;letter-spacing:-.022em;margin:0 0 24px;max-width:16ch;text-wrap:balance}
h1 .hl{color:var(--accent)}
.sub{font-size:clamp(17px,1.9vw,20px);line-height:1.6;color:var(--muted-dark);max-width:640px;margin:0 0 32px}
.sub strong{color:var(--on-dark);font-weight:500}
.badges{display:flex;flex-wrap:wrap;gap:6px 0;margin:30px 0 0;padding:0;list-style:none}
.badges li{font-weight:400;font-size:14px;color:var(--muted-dark)}
.badges li+li::before{content:"·";margin:0 12px;opacity:.55}
@media(max-width:600px){.badges{gap:4px 16px}.badges li+li::before{content:none}}
.ctas{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;border-radius:10px;padding:12px 20px;font:inherit;font-size:16px;font-weight:550;letter-spacing:.01em;text-decoration:none;min-height:48px;border:1px solid transparent;cursor:pointer;transition:transform .15s ease,background-color .15s ease,box-shadow .15s ease}
.btn:hover{transform:translateY(-1px)}
.btn.primary{background:linear-gradient(180deg,#ffc56a,#ffb547);color:var(--ink);box-shadow:0 1px 0 #ffffff55 inset,0 8px 24px #ffb5472e}
.btn.primary:hover{box-shadow:0 1px 0 #ffffff55 inset,0 10px 30px #ffb54740}
.btn.ghost{border-color:#ffffff33;color:var(--on-dark);background:#ffffff08}
.btn.ghost:hover{background:#ffffff14}
.btn.ink{background:var(--ink);color:var(--on-dark)}
.btn.line{border-color:#0a143040;color:var(--ink);background:transparent}
.btn.line:hover{background:#0b0d120d}
@media(max-width:520px){.ctas .btn{flex:1 1 100%}}
/* mockup */
.mockfig{max-width:1120px}
.mock{position:relative;border-radius:16px;background:#1b2130;border:1px solid #ffffff1f;box-shadow:0 30px 80px #0008;overflow:hidden}
.mock .bar{display:flex;gap:6px;padding:10px 12px;background:#121722;border-bottom:1px solid #ffffff14;align-items:center}
.mock .bar i{width:11px;height:11px;border-radius:50%;background:#ffffff2a;display:block}
.mock .bar span{margin-left:10px;font-size:12px;color:var(--muted-dark)}
.mock .stage{position:relative;aspect-ratio:16/10;background:#f3f4f7}
.mock img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top left;opacity:0;animation:fade 20s infinite}
.mock img:first-child{opacity:1}
.mock img:nth-child(2){animation-delay:5s}.mock img:nth-child(3){animation-delay:10s}.mock img:nth-child(4){animation-delay:15s}
@keyframes fade{0%{opacity:0}4%{opacity:1}25%{opacity:1}29%{opacity:0}100%{opacity:0}}
.mock .stage.solo img{animation:none;opacity:1}
@media(prefers-reduced-motion:reduce){.mock img{opacity:0}.mock img:first-child{opacity:1}}
.mockcap{font-size:13px;color:var(--muted-dark);margin:10px 2px 0}
/* light body */
section{padding:64px 0}
section.alt{background:#efede4}
h2{font-family:var(--display);font-weight:600;font-size:clamp(28px,3.8vw,44px);line-height:1.12;letter-spacing:-.018em;margin:0 0 14px}
h3{font-size:18px;font-weight:600;letter-spacing:0;margin:0 0 6px;line-height:1.35}
h3.small{font-size:15px;margin:22px 0 6px}
.lead{color:var(--muted);font-size:clamp(17px,1.8vw,19px);max-width:760px;margin:0 0 28px}
.muted{color:var(--muted)}
.proof{padding:26px 0;border-bottom:1px solid #ffffff14}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:18px;margin:0;padding:0;list-style:none}
.stats li{display:flex;flex-direction:column}
.stats b{font-family:var(--display);font-weight:600;font-size:clamp(30px,4vw,44px);line-height:1;color:var(--accent)}
.stats span{color:var(--muted-dark);font-size:14px;margin-top:6px}
.proofnote{font-size:12px;color:var(--muted-dark);margin:14px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 24px}
.card p{margin:0;color:var(--muted)}
.feat .card h3::before{content:"";display:block;width:22px;height:2px;border-radius:2px;background:var(--accent2);margin:0 0 14px}
.morelink{display:inline-flex;gap:8px;align-items:center;margin-top:22px;font-weight:600}
/* calculator */
.calcbox{display:grid;gap:18px;background:var(--ink);color:var(--on-dark);border-radius:24px;padding:22px}
@media(min-width:900px){.calcbox{grid-template-columns:minmax(0,1fr) minmax(0,1fr);padding:34px;gap:34px}}
.calcbox fieldset{border:0;margin:0 0 18px;padding:0;min-width:0}
.calcbox legend,.calcbox .lbl2{font-weight:600;font-size:15px;margin:0 0 10px;display:block;color:var(--on-dark)}
.seg{display:flex;flex-wrap:wrap;gap:8px}
.seg label{position:relative;cursor:pointer}
.seg input{position:absolute;opacity:0;width:1px;height:1px}
.seg span{display:inline-flex;align-items:center;min-height:44px;padding:9px 14px;border-radius:12px;border:1px solid #ffffff33;font-weight:600;font-size:15px}
.seg input:checked+span{background:var(--accent);color:var(--ink);border-color:var(--accent)}
.seg input:focus-visible+span{outline:3px solid var(--accent);outline-offset:2px}
.tools{display:grid;gap:8px}
.tools label{display:flex;gap:12px;align-items:center;justify-content:space-between;border:1px solid #ffffff26;border-radius:12px;padding:10px 14px;min-height:48px;cursor:pointer}
.tools label span.p{color:var(--muted-dark);font-size:14px;white-space:nowrap}
.tools input,.chk input{width:22px;height:22px;accent-color:var(--accent);flex:none;margin:0}
.chk{display:flex;gap:12px;align-items:flex-start;cursor:pointer}
.chk small{display:block;color:var(--muted-dark)}
.calcbox select{width:100%;min-height:48px;border-radius:12px;border:1px solid #ffffff33;background:var(--ink2);color:var(--on-dark);font:inherit;padding:10px 12px}
.range{display:flex;gap:14px;align-items:center}
.range input{flex:1;accent-color:var(--accent);min-height:44px}
.range output{font-family:var(--display);font-weight:600;font-size:26px;min-width:56px;text-align:right}
.calc[data-mode=mix] .hlonly,.calc[data-mode=hl] .mixonly{display:none}
.calc.live .nojs{display:none}
.result{background:var(--ink2);border:1px solid #ffffff1f;border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:10px;align-self:start}
.save{font-family:var(--display);font-weight:600;font-size:clamp(32px,5vw,54px);line-height:1.02;color:var(--accent);margin:0}
.result p{margin:0}.result .them{color:var(--muted-dark)}.result .note{font-size:14px;color:var(--muted-dark)}
.share{margin-top:6px}
.share summary{list-style:none;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;background:var(--accent);color:var(--ink);border-radius:12px;padding:12px 18px;min-height:48px}
.share summary::-webkit-details-marker{display:none}
.share ul{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-wrap:wrap;gap:8px}
.share a{display:inline-flex;align-items:center;min-height:44px;padding:8px 14px;border:1px solid #ffffff38;border-radius:10px;text-decoration:none;font-weight:600}
.calcfoot{font-size:13px;color:var(--muted);margin:14px 0 0;max-width:900px}
/* AI agents */
.aigrid{display:grid;gap:18px;margin:0 0 18px}
@media(min-width:960px){.aigrid{grid-template-columns:minmax(0,.55fr) minmax(0,1.45fr);align-items:center;gap:34px}}
.aicards{grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr))}
.aicards h3{font-size:16.5px}.aicards p{font-size:15.5px}
.aitools{font-family:var(--display);font-weight:600;font-size:clamp(48px,7vw,88px);line-height:1;margin:0 0 8px}
.aitools span{color:var(--accent2)}
.snip{background:var(--ink);color:var(--on-dark);border-radius:18px;padding:18px;overflow:hidden}
.snip .hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px;font-weight:600;font-size:14px;color:var(--muted-dark)}
.snip pre{margin:0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-x:auto;white-space:pre}
.snip .cm{color:#8f97a8}.snip .pr{color:var(--accent)}
.snip p{font-size:13px;color:var(--muted-dark);margin:12px 0 0}
/* replaces your stack */
.stackw{border-radius:18px;overflow:hidden;border:1px solid var(--line);background:var(--card);box-shadow:0 12px 40px #0a143012}
.stackscroll{position:relative;overflow-x:auto}
table.stack{width:100%;border-collapse:collapse;min-width:720px}
.stack thead th{background:var(--ink);color:var(--muted-dark);text-align:left;font-size:13px;font-weight:500;letter-spacing:.02em;padding:14px 18px}
.stack thead th.us{background:var(--ink2);color:#f3c983;font-weight:600}
.stack th,.stack td{padding:11px 16px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--line)}
.stack tbody th{width:22%}.stack td:nth-child(2){width:36%}.stack td.pr{width:13%}
.stack tbody th{font-weight:550;font-size:15.5px}
.stack tr.odd{background:#fbfaf6}
.stack td.pr{font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums;color:#2a3247}
.stack td.us{background:#ffb5470a;min-width:200px}
.stack td.us small{display:block;font-size:12.5px;color:var(--muted);margin-top:4px}
.tchips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.tchips li{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:2px 10px;font-size:13px;font-weight:450;color:#3a4256;white-space:nowrap}
.cov{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 0;font-weight:550;font-size:14px;white-space:nowrap}
.cov.full{color:var(--ok)}
.cov.part{color:#8a5a00}
.cov.uniq{color:#b26b00}
.stacktotal{display:grid;grid-template-columns:1fr auto 1fr;align-items:stretch;background:var(--ink);color:var(--on-dark)}
.stacktotal p.arrow{font-family:var(--display);font-weight:600;font-size:40px;color:var(--accent);justify-content:center;padding:0 6px}
.stacktotal em{font-style:normal;font-weight:600;font-size:15px}
.stacktotal p:first-child em{color:var(--muted-dark);font-size:14px}
.stack .np{color:#6b7180}
.stacktotal p{margin:0;padding:20px 22px;display:flex;flex-direction:column;gap:4px}
.stacktotal span{font-size:14px;color:var(--muted-dark);font-weight:600}
.stacktotal b{font-family:var(--display);font-weight:600;font-size:clamp(24px,3.4vw,40px);line-height:1.05}
.stacktotal b small{font-weight:500;font-size:14px}
.stacktotal p.ours{background:var(--ink2);color:var(--on-dark)}
.stacktotal p.ours b{color:#f3c983}
.stacktotal p.ours span{color:var(--muted-dark)}
@media(max-width:720px){
  table.stack{min-width:0}
  .stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .stack,.stack tbody,.stack tr,.stack th,.stack td{display:block;width:100%}
  .stack tr{padding:14px 16px;border-bottom:1px solid var(--line)}
  .stack th,.stack td{border:0;padding:4px 0}
  .stack tbody th,.stack tbody td:nth-child(2),.stack tbody td.pr{width:auto}
  .stack tbody th{font-size:18px;margin-bottom:6px}
  .stack td[data-l]::before{content:attr(data-l);display:block;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
  .stack td.us{background:transparent;min-width:0}
  .stacktotal{grid-template-columns:1fr}
  .stacktotal p.arrow{display:none}
}
/* DACH */
.dachgrid .card{border-left:6px solid var(--ink)}
/* steps */
.steps{list-style:none;padding:0;margin:0;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));counter-reset:s}
.steps li{counter-increment:s;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;position:relative}
.steps li::before{content:counter(s);font-family:var(--display);font-weight:600;font-size:44px;line-height:1;color:var(--accent2);display:block;margin-bottom:10px}
.steps p{margin:0;color:var(--muted)}
/* tables */
.tscroll{position:relative;overflow-x:auto;border:1px solid var(--line);border-radius:18px;background:var(--card)}
table.vs{width:100%;border-collapse:collapse;min-width:640px}
.vs th,.vs td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line);vertical-align:top}
.vs thead th{font-size:14px;color:var(--muted)}
.vs tbody tr:last-child th,.vs tbody tr:last-child td{border-bottom:0}
.vs td.us{background:#ffb54726;font-weight:600}
.fine{font-size:13px;color:var(--muted);margin:12px 0 0;max-width:900px}
/* matrix */
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.chip{position:relative;cursor:pointer}
.chip input{position:absolute;opacity:0;width:1px;height:1px}
.chip span{display:inline-flex;align-items:center;min-height:40px;padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);font-weight:600;font-size:14px}
.chip input:checked+span{background:var(--ink);color:var(--on-dark);border-color:var(--ink)}
.chip input:focus-visible+span{outline:3px solid var(--accent2);outline-offset:2px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:14px;color:var(--muted);margin:0 0 12px}
.cmpscroll{position:relative;overflow:auto;max-height:78vh;border:1px solid var(--line);border-radius:16px;background:var(--card)}
table.cmp{border-collapse:separate;border-spacing:0;min-width:760px;width:100%;font-size:14px}
.cmp th,.cmp td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:center;white-space:nowrap}
.cmp thead th{position:sticky;top:0;background:var(--card);z-index:2;font-size:13px}
.cmp .fcol{position:sticky;left:0;background:var(--card);text-align:left;white-space:normal;min-width:180px;max-width:240px;z-index:1;font-weight:600}
.cmp thead .fcol{z-index:3}
.cmp tr.cat th{background:#efede4;font-family:var(--display);font-weight:600;font-size:15px;text-align:left}
.cmp tr.price td,.cmp tr.price th{font-weight:600;background:#faf9f4}
.cmp .ours{background:#ffb54722}
.cmp thead .ours{background:#e9f7b8}
.v-yes{color:var(--ok)}.v-no{color:var(--no)}.v-partial,.v-addon{color:var(--part)}.v-unlisted{color:#6b7180}
.cmp td.na{color:#6b7180}
.cmpw.full .cmp td{white-space:normal;min-width:150px;vertical-align:top;text-align:left}
.cmp .cn{display:block;font-size:12px;line-height:1.35;color:var(--muted);margin-top:4px}
.cmp .cn a{color:inherit;text-decoration-color:#c9c6ba}
.why{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))}
.why .card p{color:var(--ink)}
.cmp td .sym{font-size:17px;font-weight:600}
.asof{font-size:13px;color:var(--muted);margin:12px 0 0}
.fns{font-size:13px;color:var(--muted);padding-left:22px;margin:0}
.srcs{margin-top:10px;font-size:13px;color:var(--muted)}.srcs summary{cursor:pointer;min-height:40px;display:flex;align-items:center;font-weight:600}
.srcs ul{columns:2 260px;padding-left:18px}.srcs a{overflow-wrap:anywhere}
/* choose */
.two{display:grid;gap:16px}
@media(min-width:860px){.two{grid-template-columns:1fr 1fr}}
.col{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:24px;display:flex;flex-direction:column}
.col.cloud{border:2px solid var(--ink)}
.col .pr{font-weight:600;color:var(--muted);margin:0 0 14px}
.ticks{list-style:none;padding:0;margin:0 0 16px;display:grid;gap:9px;flex:1}
.ticks li{padding-left:28px;position:relative}
.ticks li::before{content:"✓";position:absolute;left:0;top:0;font-weight:650;color:var(--ok)}
.verdict{margin:0;padding:14px 16px;border-radius:14px;background:#efede4;font-weight:600}
.col.cloud .verdict{background:var(--accent)}
.switchnote{margin:16px 0 0;color:var(--muted);font-size:15px}
/* pricing */
.plans{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));align-items:stretch}
.plan{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:22px;display:flex;flex-direction:column;position:relative}
.plan.wl{background:var(--ink);color:var(--on-dark);border-color:var(--ink)}
.plan.wl .muted,.plan.wl .yr{color:var(--muted-dark)}
.plan .badge{position:absolute;top:-12px;left:20px;background:var(--accent);color:var(--ink);font-weight:600;font-size:12px;padding:4px 11px;border-radius:999px}
.plan h3{font-size:18px}
.plan .amt{font-family:var(--display);font-weight:600;font-size:40px;line-height:1;margin:14px 0 4px}
.plan .amt small{font-weight:500;font-size:15px;font-weight:600}
.plan .yr{font-size:13px;color:var(--muted);margin:0 0 14px;min-height:20px}
.plan ul{list-style:none;padding:0;margin:0 0 18px;display:grid;gap:7px;flex:1;font-size:15px}
.plan li{padding-left:24px;position:relative}
.plan li::before{content:"✓";position:absolute;left:0;font-weight:650;color:var(--ok)}
.plan.wl li::before{color:var(--accent)}
.plan .btn{width:100%}
.plan.wl .btn.line{border-color:var(--accent);color:var(--on-dark)}
.vat{font-size:14px;color:var(--muted);margin:16px 0 0}
/* white-label */
.wlbox{background:var(--ink);color:var(--on-dark);border-radius:24px;padding:26px}
.wlbox .lead{color:var(--muted-dark)}
.wlbox .card{background:var(--ink2);border-color:#ffffff1f}
.wlbox .card p{color:var(--muted-dark)}
.wlbox .card h3{color:var(--accent)}
.wlbox .fine{color:var(--muted-dark)}
/* apps */
.apps{display:grid;gap:16px}
@media(min-width:900px){.apps{grid-template-columns:1fr 1fr}.app.xr{grid-column:1/-1}}
.app.xr h3{display:flex;align-items:center;gap:10px}.app.xr h3 .ic{color:var(--accent2)}
.app{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:22px;display:flex;flex-direction:column;gap:14px}
.dl{display:flex;align-items:center;gap:14px;border:2px solid var(--ink);border-radius:16px;padding:12px 18px;min-height:72px;text-decoration:none;color:var(--ink);background:var(--card);width:100%;max-width:420px;transition:background-color .15s}
.dl:hover{background:#0b0d1209}
.dl .ic{width:34px;height:34px}
.dl .appic{width:44px;height:44px;border-radius:11px;flex:none;display:block}
.dl small .ic{width:15px;height:15px;vertical-align:-2px;margin-right:3px}
.dl b{display:block;font-size:17px;line-height:1.25}
.dl small{display:block;color:var(--muted);font-size:13px;font-weight:600}
.dl.off{border-style:dashed;color:var(--muted)}
.qrrow{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.qr{width:132px;flex:none;text-align:center;font-size:12px;color:var(--muted)}
.qr svg{width:132px;height:132px;display:block;border-radius:10px;border:1px solid var(--line);background:#fff}
.app ol{margin:0;padding-left:22px;flex:1;min-width:220px}
.app li{margin:4px 0}
.sha{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--muted);margin:0}
.works{display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0;list-style:none}
.works li{background:#efede4;border-radius:999px;padding:5px 12px;font-size:14px;font-weight:500}
.agencyapps{margin:18px 0 0;padding:16px 18px;border-radius:16px;background:#fff8ec;border:1px solid #f1d9ab;font-weight:500}
/* install */
.term{background:var(--ink);color:var(--on-dark);border-radius:18px;padding:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.term code{font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;flex:1;min-width:0;overflow-x:auto;white-space:pre;padding:6px 2px}
.term code::before{content:"$ ";color:var(--accent)}
.copyb{display:inline-flex;align-items:center;gap:8px;border-radius:10px;border:1px solid #ffffff40;background:transparent;color:var(--on-dark);font:inherit;font-weight:600;padding:10px 14px;min-height:44px;cursor:pointer}
.links{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 0}
/* faq */
.faq details{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:4px 20px;margin:0 0 10px}
.faq summary{cursor:pointer;font-weight:600;padding:14px 0;min-height:48px;display:flex;align-items:center}
.faq details p{margin:0 0 16px;color:var(--muted)}
/* footer */
.foot{background:var(--ink);color:var(--muted-dark);padding:34px 0 46px;font-size:14px}
.foot .row{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center}
.foot .fbrand{display:inline-flex;align-items:center;gap:10px}.foot .fbrand img{width:28px;height:28px;border-radius:7px;display:block}
.foot a{color:var(--on-dark);padding:10px 0;display:inline-block}
.foot p{margin:12px 0 0;max-width:900px}
.msg{max-width:760px}
.hlmsg{background:var(--ink);color:var(--on-dark);border-radius:22px;padding:24px;margin:0 0 26px}
.hlmsg p{margin:0}.hlmsg .big{font-family:var(--display);font-weight:600;font-size:clamp(22px,3vw,32px);line-height:1.15;margin:0 0 12px;color:var(--accent)}
.hlmsg .muted{color:var(--muted-dark);font-size:15px}
.facts{padding-left:20px}.facts li{margin:6px 0}
/* cloud waitlist mode */
.wait{display:grid;gap:22px;background:var(--ink);color:var(--on-dark);border-radius:24px;padding:24px}
@media(min-width:900px){.wait{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);padding:36px;gap:36px;align-items:start}}
.wait .lead{color:var(--muted-dark);margin-bottom:18px}
.wlf{background:var(--card);color:var(--ink);border-radius:18px;padding:22px}
.wlf-row{display:grid;gap:0 12px}
@media(min-width:620px){.wlf-row{grid-template-columns:1fr 1fr}}
.wlf-l{display:block;font-weight:600;font-size:15px;margin:0 0 6px}
.wlf-in{display:block;width:100%;min-height:48px;border-radius:12px;border:1px solid #0a143059;background:#fff;color:var(--ink);font:inherit;padding:10px 12px;margin:0 0 16px}
.wlf-chk{display:flex;gap:12px;align-items:flex-start;margin:2px 0 18px;font-size:15px;line-height:1.5;cursor:pointer}
.wlf-chk input{width:22px;height:22px;flex:none;margin:2px 0 0;accent-color:var(--ink)}
.wlf-chk a{color:var(--ink);font-weight:600}
.wlf-btn{width:100%}
.wlf-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.wlf-note{font-size:13px;color:var(--muted);margin:12px 0 0}
.wlf-ok{background:#e3f3ea;color:#0f4d2c;border-radius:18px;padding:22px;font-weight:600;font-size:18px}
.wlf-err{background:#fdecea;color:#7a1f12;border-radius:12px;padding:12px 14px;margin:0 0 16px;font-weight:500}
.soon{display:inline-block;align-self:flex-start;background:#fff1d6;color:#6b4100;font-size:12px;font-weight:600;letter-spacing:.02em;border-radius:999px;padding:3px 10px;margin:0 0 10px}
.plan .planned{font-size:13px;color:var(--muted);font-weight:500;margin:14px 0 -10px}
.plan.wl .planned{color:var(--muted-dark)}
.col.prime{border:2px solid var(--ink)}.col.prime .verdict{background:var(--accent)}
.col.cloud.planned{border:1px solid var(--line)}.col.cloud.planned .verdict{background:#efede4}
`;

// --- sections ------------------------------------------------------------------------------------------------------------

interface Ctx {
  d: LandingData;
  c: Copy;
  /** The agentic sections' copy (product name filled in). */
  a: AgenticCopy;
  mix: MixTool[];
}

/** The hero's crossfade, in this order: Jarvis first when its screenshot exists, then the classic screens (four at most). */
const HERO_SHOTS: ShotKey[] = ['jarvis', 'pipeline', 'inbox', 'workflow', 'funnel'];

function header(x: Ctx): string {
  const { d, c } = x;
  const home = pagePath('home', d.lang);
  const other = d.lang === 'de' ? 'en' : 'de';
  const sec = (id: string) => (d.kind === 'home' ? `#${id}` : `${home === '/' ? '' : home}/#${id}`.replace(/^\/#/, '/#'));
  return `<header class="top"><a class="brand" href="${home}"><img class="mk" src="/icon.svg" alt="" width="34" height="34"><span>${h(d.brand)}</span></a>
<nav class="nav" aria-label="${d.lang === 'de' ? 'Hauptmenü' : 'Main menu'}"><a class="opt" href="${sec('agentisch')}">${h(c.nav.agents)}</a><a class="opt" href="${sec('warum')}">${h(c.nav.why)}</a><a class="opt" href="${sec('funktionen')}">${h(c.nav.features)}</a><a class="opt" href="${sec('akademie')}">${h(c.nav.academy)}</a><a class="opt" href="${sec('rechner')}">${h(c.nav.calc)}</a><a class="opt" href="${pagePath('compare', d.lang)}">${h(c.nav.compare)}</a><a href="${sec('preise')}">${h(c.nav.pricing)}</a><a class="opt" href="/app">${h(c.nav.login)}</a><a class="lang" href="${pagePath(d.kind, other)}" hreflang="${other}" lang="${other}" aria-label="${h(c.nav.switchLangLabel)}">${h(c.nav.switchLang)}</a></nav></header>`;
}

function starLink(x: Ctx): string {
  const { d, c } = x;
  return `<a class="gh" href="${GITHUB_URL}" rel="noopener">${ICON.star}<span>${h(c.hero.star)}</span>${d.stars !== undefined ? `<span class="cnt">· ${h(c.hero.starCount(num(c, d.stars)))}</span>` : ''}</a>`;
}

/** The rotation: each word holds for most of its slot, then slides up; the first word comes again at the end (n + 1 rows). */
function rotFrames(n: number): string {
  const slot = 100 / n;
  const step = 100 / (n + 1);
  const at = (i: number) => `{transform:translateY(-${(i * step).toFixed(1)}%)}`;
  const holds = Array.from({ length: n }, (_, i) => `${(i * slot).toFixed(2)}%,${(i * slot + slot * 0.72).toFixed(2)}%${at(i)}`).join('');
  return `@keyframes rot{${holds}100%${at(n)}}`;
}

/** The headline as one sentence for screen readers and the social card. */
export function heroLabel(c: Copy): string {
  return `${c.hero.h1} ${c.hero.rotate.join(', ')} – ${c.hero.h1Tail}`;
}

/** `h1` with the rotating words in the accent, `h1Tail` as the smaller line below. */
function tagline(c: Copy): string {
  const { h1, rotate, h1Tail } = c.hero;
  const words = [...rotate, rotate[0]].map((w) => `<b>${h(w)}</b>`).join('');
  return `<span aria-hidden="true">${h(h1)}<br><span class="rot"><span class="rot-in" style="--n:${rotate.length}">${words}</span></span><span class="tail">${h(h1Tail)}</span></span>`;
}

function hero(x: Ctx): string {
  const { d, c, a } = x;
  const shots = HERO_SHOTS.map((k) => d.shots.find((s) => s.key === k)).filter((s): s is Shot => !!s).slice(0, 4);
  const imgs = shots
    .map((s, i) => `<img src="${h(s.src)}" width="${s.w}" height="${s.h}" alt="${h(a.shots[s.key])}" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`)
    .join('');
  const mock = shots.length
    ? `<figure class="mockfig" style="margin:0"><div class="mock"><div class="bar" aria-hidden="true"><i></i><i></i><i></i><span>${h(d.base.replace(/^https?:\/\//, ''))}/app</span></div><div class="stage${shots.length === 1 ? ' solo' : ''}">${imgs}</div></div><figcaption class="mockcap">${h(c.hero.mockLabel)}</figcaption></figure>`
    : '';
  return `<div class="hero"><div>
<p class="kicker">${h(c.hero.eyebrow)}</p>
<h1 aria-label="${h(heroLabel(c))}">${tagline(c)}</h1>
<p class="sub">${h(c.hero.sub)} <strong>${h(c.hero.subStrong)}</strong></p>
<div class="ctas">${
    d.waitlist
      ? `<a class="btn primary" href="#installieren">${h(c.hero.ctaSelf)}</a><a class="btn ghost" href="${DEMO_URL}" rel="noopener">${ICON.play}${h(c.hero.ctaDemo)}</a>`
      : `<a class="btn primary" href="${DEMO_URL}" rel="noopener">${ICON.play}${h(c.hero.ctaDemo)}</a><a class="btn ghost" href="#installieren">${h(c.hero.ctaSelf)}</a>`
  }<a class="gh" href="${h(d.cloudUrl)}">${h(c.hero.ctaCloud)} →</a>${starLink(x)}</div>
<ul class="badges">${c.hero.badges.map((b) => `<li>${h(b)}</li>`).join('')}</ul>
</div>${mock}</div>`;
}

const CODEX_SNIPPET = (host: string) => [
  ['cm', '# Codex (CLI and IDE extension)'],
  ['pr', `codex mcp add gohyperlevel --url https://${host}/mcp --bearer-token-env-var GOHYPERLEVEL_API_KEY`],
  ['cm', '# or sign in via OAuth'],
  ['pr', 'codex mcp login gohyperlevel'],
  ['', ''],
  ['cm', '# Claude Code (OAuth: /mcp → Authenticate)'],
  ['pr', `claude mcp add --transport http gohyperlevel https://${host}/mcp`],
];

function aiAgents(x: Ctx): string {
  const { d, c } = x;
  const host = d.base.replace(/^https?:\/\//, '') || 'your-domain';
  const code = CODEX_SNIPPET(host)
    .map(([k, t]) => (k ? `<span class="${k}">${h(t)}</span>` : ''))
    .join('\n');
  return `<section id="ki-agenten" class="alt" aria-labelledby="ai-h"><div class="wrap"><h2 id="ai-h">${h(c.ai.h2)}</h2><p class="lead">${h(c.ai.lead)}</p>
<div class="aigrid"><div><p class="aitools"><span>${h(num(c, d.stats.tools))}</span></p><p class="muted" style="margin:0 0 10px;font-weight:600">${h(c.ai.tools(num(c, d.stats.tools)).replace(/^[\d.,\s]+/, ''))}</p><p class="muted" style="margin:0;font-size:15px">${h(c.ai.toolsNote)}</p></div>
<div class="snip"><div class="hd"><span>${h(c.ai.snippetLabel)}</span><button class="copyb" type="button" data-copy="mcpcode" data-done="${h(c.install.copied)}">${ICON.copy}<span class="lbl">${h(c.install.copy)}</span></button></div><pre id="mcpcode">${code}</pre><p>${h(c.ai.snippetNote)} <a href="${GITHUB_URL}/blob/main/docs/ai-tools.md" rel="noopener" style="color:var(--on-dark)">${h(c.ai.docs)}</a></p></div></div>
<div class="grid aicards">${c.ai.items.map(([t, p]) => `<div class="card"><h3>${h(t)}</h3><p>${h(p)}</p></div>`).join('')}</div></div></section>`;
}

function proof(x: Ctx): string {
  const { d, c } = x;
  const items = [
    [d.stats.tools, c.proof.tools],
    [d.stats.triggers, c.proof.triggers],
    [d.stats.actions, c.proof.actions],
    [d.stats.integrations, c.proof.integrations],
    ...(d.stats.tests ? [[d.stats.tests, c.proof.tests] as [number, string]] : []),
  ] as [number, string][];
  return `<div class="proof"><h2 class="sr">${h(c.proof.title)}</h2><ul class="stats">${items.map(([n, l]) => `<li><b>${h(num(c, n))}</b><span>${h(l)}</span></li>`).join('')}</ul><p class="proofnote">${h(c.proof.note)}</p></div>`;
}

/** The calculator: a GET form (works without the script), the result rendered by the server for the URL it carries. */
function calculator(x: Ctx): string {
  const { d, c, mix } = x;
  const i = d.calc.input;
  const mode = mix.length ? d.calc.mode : 'hl';
  const path = pagePath('home', d.lang);
  const chosen = new Set(d.calc.mix);
  const sel = mix.filter((t) => chosen.has(t.key));
  const r = calculate(i, d.prices);
  let themTxt: string;
  let ourPlan: 'self' | 'solo' | 'team' | 'agency';
  let themYear: number;
  let note = '';
  if (mode === 'mix') {
    const cents = sel.reduce((a, t) => a + t.cents, 0);
    themYear = Math.round((cents * 12) / 100);
    themTxt = c.calc.resultMix(eurC(c, cents), sel.length);
    ourPlan = i.hosting === 'cloud' ? 'solo' : 'self';
  } else {
    themYear = r.hlYearEur;
    themTxt = c.calc.resultHl(usd0(c, r.hlMonthUsd), c.calc.plans[r.hlPlan].split(' · ')[0]);
    ourPlan = r.ourPlan;
    note = [r.hlBumped ? c.calc.bumped : '', r.saasSelfOnly ? c.calc.saasSelf : ''].filter(Boolean).join(' ');
  }
  const ourCents = ourPlan === 'self' ? 0 : d.prices[ourPlan];
  const save = Math.max(0, themYear - Math.round((ourCents * 12) / 100));
  const usTxt = c.calc.resultUs(ourPlan === 'self' ? c.calc.ourPlan.self : `${c.calc.ourPlan[ourPlan]} · ${eurC(c, ourCents)} ${c.calc.perMonth}`);
  const q = mode === 'mix' ? `m=mix${[...chosen].map((t) => `&t=${encodeURIComponent(t)}`).join('')}&h=${i.hosting}` : `m=hl&${calcQuery(i)}`;
  const share = shareLinks(`${d.base}${path}?${q}#rechner`, c.calc.shareText(eur0(c, save)));
  const data = {
    locale: c.locale,
    base: d.base,
    path,
    subsMax: SUBS_MAX,
    hl: HL_PRICES,
    rate: EUR_USD,
    ours: d.prices,
    mix: mix.map((t) => ({ key: t.key, cents: t.cents })),
    t: {
      mix: c.calc.resultMix('{eur}', 0).replace(/\b0\b/, '{n}'),
      hl: c.calc.resultHl('{usd}', '{plan}'),
      plans: { starter: 'Starter', unlimited: 'Unlimited', pro: 'Agency Pro' },
      save: c.calc.save('{eur}'),
      us: c.calc.resultUs('{what}'),
      our: c.calc.ourPlan,
      perMonth: c.calc.perMonth,
      bumped: c.calc.bumped,
      saas: c.calc.saasSelf,
      share: c.calc.shareText('{eur}'),
    },
  };
  const radio = (name: string, value: string, label: string, on: boolean) => `<label><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${h(label)}</span></label>`;
  const mixFields = mix.length
    ? `<fieldset class="mixonly"><legend>${h(c.calc.mixLead)}</legend><div class="tools">${mix
        .map((t) => `<label><span><input type="checkbox" name="t" value="${h(t.key)}"${chosen.has(t.key) ? ' checked' : ''}> ${h(t.vendor)}${t.plan ? ` ${h(t.plan)}` : ''}</span><span class="p">${h(money(c.locale, t.currency, t.price))}</span></label>`)
        .join('')}</div><p class="note" style="font-size:13px;color:var(--muted-dark);margin:8px 0 0">${h(c.calc.mixPerSeat)}</p></fieldset>`
    : '';
  return `<section id="rechner" aria-labelledby="calc-h"><div class="wrap">
<h2 id="calc-h">${h(c.calc.h2)}</h2><p class="lead">${h(c.calc.lead)}</p>
<form id="calc" class="calc calcbox" method="get" action="${path}#rechner" data-mode="${mode}">
<div>
${mix.length ? `<fieldset><legend>${h(c.calc.modes)}</legend><div class="seg">${radio('m', 'mix', c.calc.modeMix, mode === 'mix')}${radio('m', 'hl', c.calc.modeHl, mode === 'hl')}</div></fieldset>` : '<input type="hidden" name="m" value="hl">'}
${mixFields}
<div class="hlonly">
<label class="lbl2" for="calc-p">${h(c.calc.plan)}</label>
<select id="calc-p" name="p">${(['starter', 'unlimited', 'pro'] as const).map((p) => `<option value="${p}"${i.plan === p ? ' selected' : ''}>${h(c.calc.plans[p])}</option>`).join('')}</select>
<div style="height:16px"></div>
<label class="lbl2" for="calc-n">${h(c.calc.subs)}</label>
<div class="range"><input id="calc-n" name="n" type="range" min="1" max="${SUBS_MAX}" value="${i.subs}" aria-describedby="calc-n-out"><output id="calc-n-out" for="calc-n">${i.subs}</output></div>
<div style="height:12px"></div>
<label class="chk"><input type="checkbox" name="app" value="1"${i.wlApp ? ' checked' : ''}><span>${h(c.calc.wlApp)}<small>${h(c.calc.wlAppHint)}</small></span></label>
<div style="height:18px"></div>
</div>
<fieldset><legend>${h(c.calc.hosting)}</legend><div class="seg">${radio('h', 'self', c.calc.self, i.hosting === 'self')}${radio('h', 'cloud', c.calc.cloud, i.hosting === 'cloud')}</div></fieldset>
<button class="btn primary nojs" type="submit">${h(c.calc.submit)}</button>
</div>
<div class="result" aria-live="polite">
<p class="save" id="calc-save">${h(c.calc.save(eur0(c, save)))}</p>
<p class="them" id="calc-them">${h(themTxt)}</p>
<p id="calc-us">${h(usTxt)}</p>
<p class="note" id="calc-note">${h(note)}</p>
<details class="share"><summary>${ICON.share}${h(c.calc.share)}</summary><ul><li><a id="share-x" href="${h(share.x)}" rel="noopener nofollow" target="_blank">X</a></li><li><a id="share-li" href="${h(share.linkedin)}" rel="noopener nofollow" target="_blank">LinkedIn</a></li><li><a id="share-rd" href="${h(share.reddit)}" rel="noopener nofollow" target="_blank">Reddit</a></li></ul></details>
</div>
</form>
<script type="application/json" id="calc-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<p class="calcfoot">${h(mode === 'mix' || mix.length ? `${c.calc.mixFoot(dateText(c, d.matrix?.as_of ?? HL_AS_OF), String(EUR_USD).replace('.', c.lang === 'de' ? ',' : '.'))} ` : '')}${h(c.calc.foot(dateText(c, HL_AS_OF), String(EUR_USD).replace('.', c.lang === 'de' ? ',' : '.')))}</p>
</div></section>`;
}

function stackSection(x: Ctx): string {
  const { d, c } = x;
  if (!d.stack) return '';
  // Waitlist mode: a note that speaks of our cloud says that it is planned.
  const stack = d.waitlist ? { ...d.stack, rows: d.stack.rows.map((r) => ({ ...r, note_de: waitlistNote(r.note_de, 'de'), note_en: waitlistNote(r.note_en, 'en') })) } : d.stack;
  return `<section id="tool-stack" class="alt" aria-labelledby="stack-h"><div class="wrap"><h2 id="stack-h">${h(c.stack.h2)}</h2><p class="lead">${h(c.stack.lead)}</p>
${stackHtml(stack, c, d.lang, d.brand)}
${stackFoot(d.stack, c, d.brand)}</div></section>`;
}

function features(x: Ctx): string {
  const { d, c } = x;
  const items = c.features.items({ triggers: num(c, d.stats.triggers), actions: num(c, d.stats.actions) });
  return `<section id="funktionen" class="feat alt" aria-labelledby="feat-h"><div class="wrap"><h2 id="feat-h">${h(c.features.h2)}</h2><p class="lead">${h(c.features.lead)}</p>
<div class="grid">${items.map(([t, p]) => `<div class="card"><h3>${h(t)}</h3><p>${h(p)}</p></div>`).join('')}</div>
<a class="morelink" href="${GITHUB_URL}#features" rel="noopener">${h(c.features.more)} ${ICON.arrow}</a></div></section>`;
}

function dach(x: Ctx): string {
  const { c } = x;
  return `<section id="dach" aria-labelledby="dach-h"><div class="wrap"><h2 id="dach-h">${h(c.dach.h2)}</h2><p class="lead">${h(c.dach.lead)}</p>
<div class="grid dachgrid">${c.dach.items.map(([t, p]) => `<div class="card"><h3>${h(t)}</h3><p>${h(p)}</p></div>`).join('')}</div></div></section>`;
}

function move(x: Ctx, tag: 'h2' | 'h3' = 'h2'): string {
  const { c } = x;
  return `<${tag} id="umzug-h">${h(tag === 'h2' ? c.move.h2 : c.hlPage.importH2)}</${tag}><p class="lead">${h(c.move.lead)}</p>
<ol class="steps">${c.move.steps.map(([t, p]) => `<li><h3>${h(t)}</h3><p>${h(p)}</p></li>`).join('')}</ol><p class="fine">${h(c.move.note)}</p>`;
}

function vsTable(x: Ctx): string {
  const { c } = x;
  return `<div class="tscroll" tabindex="0" role="region" aria-label="${h(c.vsHl.h2)}"><table class="vs"><thead><tr><th scope="col">${h(c.vsHl.colFeature)}</th><th scope="col">${h(c.vsHl.colHl)}</th><th scope="col">${h(c.vsHl.colUs)}</th></tr></thead><tbody>${c.vsHl.rows
    .map(([a, b, u]) => `<tr><th scope="row">${h(a)}</th><td>${h(b)}</td><td class="us">${h(u)}</td></tr>`)
    .join('')}</tbody></table></div>
<p class="fine">${h(c.vsHl.appNote)}</p>
<p class="fine">${h(c.vsHl.foot(dateText(c, HL_AS_OF)))} <a href="${HL_SOURCE}" rel="noopener nofollow">${h(HL_SOURCE.replace('https://', ''))}</a></p>
<p class="fine">${h(c.disclaimer(dateText(c, HL_AS_OF)))}</p>`;
}

function vsSection(x: Ctx): string {
  const { d, c } = x;
  return `<section id="highlevel" class="alt" aria-labelledby="vs-h"><div class="wrap"><h2 id="vs-h">${h(c.vsHl.h2)}</h2><p class="lead">${h(c.vsHl.lead)}</p>${vsTable(x)}
<a class="morelink" href="${pagePath('highlevel', d.lang)}">${h(c.matrix.hlMore)} ${ICON.arrow}</a></div></section>`;
}

/** Waitlist mode: our own cells' research notes that speak of the cloud say that it is planned. */
function markOurNotes(m: Matrix | undefined, lang: Lang): Matrix | undefined {
  if (!m) return m;
  const mark = (cells: Matrix['categories'][number]['features'][number]['cells']) => {
    const ours = cells[OUR_ID];
    return ours?.note ? { ...cells, [OUR_ID]: { ...ours, note: waitlistNote(ours.note, lang) } } : cells;
  };
  return { ...m, categories: m.categories.map((cat) => ({ ...cat, features: cat.features.map((f) => ({ ...f, cells: mark(f.cells) })) })) };
}

function matrixSection(x: Ctx, standalone = false): string {
  const { d, c } = x;
  return `<section id="vergleich" aria-labelledby="cmp-h"><div class="wrap">${standalone ? '' : `<h2 id="cmp-h">${h(c.matrix.h2)}</h2><p class="lead">${h(c.matrix.lead)}</p>`}
${matrixHtml(d.waitlist ? markOurNotes(d.matrix, d.lang) : d.matrix, c, d.lang, d.brand, { full: standalone })}
${standalone ? '' : `<a class="morelink" href="${pagePath('compare', d.lang)}">${h(c.matrix.more)} ${ICON.arrow}</a>`}</div></section>`;
}

function whySwitch(x: Ctx): string {
  const { d, c } = x;
  const vendors = (d.matrix?.vendors ?? []).filter((v) => v.id !== OUR_ID && WHY_SWITCH[v.id]);
  if (!vendors.length) return '';
  return `<section id="warum-wechseln" class="alt" aria-labelledby="why-h"><div class="wrap"><h2 id="why-h">${h(c.matrix.whyH2)}</h2><p class="lead">${h(c.matrix.whyLead)}</p>
<div class="why">${vendors.map((v) => `<div class="card" id="von-${h(v.id)}"><h3>${h(v.name)}</h3><p>${h((d.waitlist ? whyWaitlist(v.id, d.lang, WHY_SWITCH[v.id][d.lang]) : WHY_SWITCH[v.id][d.lang]).replace(/\{b\}/g, d.brand))}</p></div>`).join('')}</div>
<p class="fine">${h(c.disclaimer(dateText(c, d.matrix!.as_of)))}</p></div></section>`;
}

function choose(x: Ctx): string {
  const { d, c } = x;
  const wl = d.waitlist ? wlText(d.lang, d.brand) : undefined;
  const col = (k: 'cloud' | 'self') => {
    const v = c.choose[k];
    // Waitlist mode: self-hosting is the column that works today; the cloud one is marked and leads to the waitlist.
    const cls = wl ? (k === 'self' ? ' prime' : ' planned') : '';
    const verdict = wl && k === 'cloud' ? `${h(v.verdict)} <a href="#${WAITLIST_ANCHOR}">${h(wl.join)}</a>` : h(v.verdict);
    return `<div class="col ${k}${cls}">${wl && k === 'cloud' ? `<span class="soon">${h(wl.soon)}</span>` : ''}<h3 style="font-size:24px">${h(v.title)}</h3><p class="pr">${h(v.price)}</p><ul class="ticks">${v.items.map((t) => `<li>${h(t)}</li>`).join('')}</ul><p class="verdict">${verdict}</p></div>`;
  };
  return `<section id="cloud-oder-selbst" class="alt" aria-labelledby="choose-h"><div class="wrap"><h2 id="choose-h">${h(c.choose.h2)}</h2><p class="lead">${h(c.choose.lead)}</p>
<div class="two">${wl ? `${col('self')}${col('cloud')}` : `${col('cloud')}${col('self')}`}</div><p class="switchnote">${h(c.choose.switch)}</p></div></section>`;
}

function pricing(x: Ctx): string {
  const { d, c } = x;
  const wl = d.waitlist ? wlText(d.lang, d.brand) : undefined;
  const home = pagePath('home', d.lang);
  const card = (k: 'solo' | 'team' | 'agency') => {
    const p = c.pricing[k];
    const cents = d.prices[k];
    const yr = d.yearlyDiscount > 0 ? c.pricing.yearly(eurC(c, yearlyCents(cents, d.yearlyDiscount))) : '';
    // Waitlist mode: "coming soon", the price as planned, and the button preselects the plan in the waitlist form.
    const href = wl ? `${home}?plan=${k}#${WAITLIST_ANCHOR}` : d.cloudUrl;
    return `<div class="plan${k === 'agency' ? ' wl' : ''}">${k === 'agency' ? `<span class="badge">${h(c.pricing.agency.badge)}</span>` : ''}${wl ? `<span class="soon">${h(wl.soon)}</span>` : ''}<h3>${h(p.name)}</h3><p class="muted" style="margin:0">${h(p.tag)}</p>
${wl ? `<p class="planned">${h(wl.planned)}</p>` : ''}<p class="amt">${h(eurC(c, cents))}<small> ${h(c.pricing.perMonth)}</small></p><p class="yr">${h(yr)}</p>
<ul>${p.items.map((t) => `<li>${h(t)}</li>`).join('')}</ul>${k === 'agency' ? `<p class="fine" style="margin:0 0 14px"><a href="#white-label">White-Label</a> · <a href="#apps">${h(c.wl.appsLink)}</a></p>` : ''}<a class="btn line" href="${h(href)}">${h(c.pricing.ctaCloud)}</a></div>`;
  };
  return `<section id="preise" aria-labelledby="price-h"><div class="wrap"><h2 id="price-h">${h(c.pricing.h2)}</h2><p class="lead">${h(c.pricing.lead)}</p>
<div class="plans"><div class="plan"><h3>${h(c.pricing.self.name)}</h3><p class="muted" style="margin:0">${h(c.pricing.self.tag)}</p><p class="amt">${h(c.pricing.self.price)}</p><p class="yr"></p><ul>${c.pricing.self.items.map((t) => `<li>${h(t)}</li>`).join('')}</ul><a class="btn ${wl ? 'primary' : 'ink'}" href="#installieren">${h(c.pricing.self.cta)}</a></div>${card('solo')}${card('team')}${card('agency')}</div>
<p class="vat">${h(c.pricing.vat)}</p></div></section>`;
}

/** Cloud waitlist mode: the form (works without the page's script), next to the way to start today. */
function waitlistSection(x: Ctx): string {
  const { d } = x;
  if (!d.waitlist) return '';
  const t = wlText(d.lang, d.brand);
  return `<section id="${WAITLIST_ANCHOR}" aria-labelledby="wait-h" style="padding-top:0"><div class="wrap"><div class="wait"><div><h2 id="wait-h">${h(t.h2)}</h2><p class="lead">${h(t.lead)}</p><p class="lead">${h(t.selfLead)}</p><div class="ctas"><a class="btn ghost" href="#installieren">${h(t.selfCta)}</a></div></div>
${waitlistFormHtml(d.waitlist, WL_CLASSES)}</div></div></section>`;
}

function whiteLabel(x: Ctx): string {
  const { c } = x;
  return `<section id="white-label" aria-labelledby="wl-h" style="padding-top:0"><div class="wrap"><div class="wlbox"><h2 id="wl-h">${h(c.wl.h2)}</h2><p class="lead">${h(c.wl.lead)}</p>
<div class="grid">${c.wl.items.map(([t, p]) => `<div class="card"><h3>${h(t)}</h3><p>${h(p)}</p></div>`).join('')}</div>
<p class="fine">${h(c.wl.saas)} <a href="#apps">${h(c.wl.appsLink)}</a></p></div></div></section>`;
}

function apps(x: Ctx): string {
  const { d, c } = x;
  const a = c.apps.android;
  const i = c.apps.ios;
  const mb = d.apk ? (d.apk.size / 1024 / 1024).toFixed(1).replace('.', c.lang === 'de' ? ',' : '.') : '';
  const android = d.apk
    ? `<a class="dl" href="/downloads/hyperlevel.apk" download><img class="appic" src="/icon.svg" alt="" width="44" height="44"><span><b>${h(a.button)}</b><small>${ICON.android}${h(a.sub(d.apk.version, mb))}</small></span></a><p class="sha"><span class="muted">${h(a.sha)}:</span> ${h(d.apk.sha256)}</p>`
    : `<span class="dl off" role="note"><img class="appic" src="/icon.svg" alt="" width="44" height="44"><span><b>${h(a.title)}</b><small>${ICON.android}${h(a.subNone)}</small></span></span><p class="muted" style="margin:0">${h(a.none)}</p>`;
  return `<section id="apps" class="alt" aria-labelledby="apps-h"><div class="wrap"><h2 id="apps-h">${h(c.apps.h2)}</h2><p class="lead">${h(c.apps.lead)}</p>
<div class="apps">
<div class="app"><h3>${h(a.title)}</h3>${android}
<div class="qrrow"><div class="qr" role="img" aria-label="${h(a.qr)}">${d.qr.android}<span>${h(a.qr)}</span></div><ol>${a.steps.map((s) => `<li>${h(s)}</li>`).join('')}</ol></div>
<p class="fine" style="margin:0">${h(a.firstStart)}</p></div>
<div class="app"><h3>${h(i.title)}</h3><a class="dl" href="/app"><img class="appic" src="/icon.svg" alt="" width="44" height="44"><span><b>${h(i.button)}</b><small>${ICON.devices}${h(i.sub)}</small></span></a>
<div class="qrrow"><div class="qr" role="img" aria-label="${h(i.qr)}">${d.qr.ios}<span>${h(i.qr)}</span></div><ol>${i.steps.map((s, n) => `<li>${h(s)}${n === 1 ? ` ${ICON.share}` : ''}</li>`).join('')}</ol></div>
<h4 style="margin:0;font-size:15px">${h(i.works)}</h4><ul class="works">${i.worksItems.map((w) => `<li>${h(w)}</li>`).join('')}</ul><p class="fine" style="margin:0">${h(i.note)}</p></div>
<div class="app xr"><h3>${ICON.headset}${h(c.apps.xr.title)}</h3><p class="muted" style="margin:0">${h(c.apps.xr.sub)}</p><p style="margin:0">${h(c.apps.xr.text)} <a href="#xr">${h(c.apps.xr.more)}</a> · <a href="${GITHUB_URL}/blob/main/docs/xr.md" rel="noopener">${h(c.apps.xr.docs)}</a></p></div>
</div><p class="agencyapps">${h(c.apps.agency)}</p></div></section>`;
}

function install(x: Ctx): string {
  const { c } = x;
  return `<section id="installieren" aria-labelledby="inst-h"><div class="wrap"><h2 id="inst-h">${h(c.install.h2)}</h2><p class="lead">${h(c.install.lead)}</p>
<div class="term"><code id="cmd">${h(INSTALL_CMD)}</code><button class="copyb" type="button" data-copy="cmd" data-done="${h(c.install.copied)}">${ICON.copy}<span class="lbl">${h(c.install.copy)}</span></button></div>
<p class="fine">${h(c.install.note)}</p>
<div class="links"><a class="btn ink" href="${GITHUB_URL}" rel="noopener">${ICON.star}${h(c.install.github)}</a><a class="btn line" href="${GITHUB_URL}#quick-start" rel="noopener">${h(c.install.docs)}</a><a class="btn line" href="${DEMO_URL}" rel="noopener">${h(c.hero.ctaDemo)}</a></div></div></section>`;
}

function faq(x: Ctx): string {
  const { c } = x;
  return `<section id="faq" class="faq alt" aria-labelledby="faq-h"><div class="wrap msg"><h2 id="faq-h">${h(c.faq.h2)}</h2>${c.faq.items.map(([q, a]) => `<details><summary>${h(q)}</summary><p>${h(a)}</p></details>`).join('')}</div></section>`;
}

function footer(x: Ctx): string {
  const { d, c } = x;
  const asOf = dateText(c, d.matrix?.as_of && d.matrix.as_of > HL_AS_OF ? d.matrix.as_of : HL_AS_OF);
  const links = [
    d.legal.imprint ? `<a href="${h(d.legal.imprint)}">${h(c.foot.imprint)}</a>` : '',
    d.legal.privacy ? `<a href="${h(d.legal.privacy)}">${h(c.foot.privacy)}</a>` : '',
    `<a href="${GITHUB_URL}" rel="noopener">${h(c.foot.source)}</a>`,
    `<a href="${pagePath('compare', d.lang)}">${h(c.nav.compare)}</a>`,
    `<a href="/app">${h(c.nav.login)}</a>`,
  ].filter(Boolean);
  return `<footer class="foot"><div class="wrap"><div class="row"><span class="fbrand"><img src="/icon.svg" alt="" width="28" height="28" loading="lazy"><span>© ${new Date().getFullYear()} ${h(d.brand)} · ${h(c.foot.madeIn)} · ${h(x.a.builtWith)}</span></span>${links.join('')}</div>
<p>${h(c.disclaimer(asOf))}</p><p>${h(c.foot.noTracking)}</p><p lang="en">${h(c.foot.robot)}</p></div></footer>`;
}

// --- pages ---------------------------------------------------------------------------------------------------------------

function head(x: Ctx, o: { title: string; description: string; path: string; ogTitle?: string; ogDescription?: string; extraCss?: string }): string {
  const { d, c } = x;
  const alt = (l: Lang) => `${d.base}${pagePath(d.kind, l)}`;
  // Waitlist mode: the social card without a cloud price on offer (scripts/landing-assets.mjs renders both).
  const og = `${d.base}/landing/og-${d.waitlist ? 'waitlist-' : ''}${d.lang}.png`;
  return `<!doctype html>
<html lang="${d.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(o.title)}</title>
<meta name="description" content="${h(o.description)}">
<link rel="canonical" href="${h(`${d.base}${o.path}`)}">
<link rel="alternate" hreflang="de" href="${h(alt('de'))}"><link rel="alternate" hreflang="en" href="${h(alt('en'))}"><link rel="alternate" hreflang="x-default" href="${h(alt('en'))}">
<meta name="theme-color" content="#0b0d12">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta property="og:type" content="website"><meta property="og:site_name" content="${h(d.brand)}"><meta property="og:locale" content="${c.locale.replace('-', '_')}">
<meta property="og:title" content="${h(o.ogTitle ?? o.title)}"><meta property="og:description" content="${h(o.ogDescription ?? o.description)}">
<meta property="og:url" content="${h(`${d.base}${o.path}`)}"><meta property="og:image" content="${h(og)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${h(heroLabel(c))}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${h(o.ogTitle ?? o.title)}"><meta name="twitter:description" content="${h(o.ogDescription ?? o.description)}"><meta name="twitter:image" content="${h(og)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="${FONT_FILE}" as="font" type="font/woff2" crossorigin>
<style>${CSS}${o.extraCss ?? ''}</style>
</head>`;
}

export function renderLanding(d: LandingData, mixAvailable: MixTool[] = mixTools(d.matrix)): string {
  const c = branded(d.waitlist ? withWaitlist(COPY[d.lang], d.lang) : COPY[d.lang], d.brand);
  const x: Ctx = { d, c, a: branded(AGENTIC[d.lang], d.brand), mix: mixAvailable };
  const path = pagePath(d.kind, d.lang);
  const darkTop = (inner: string) => `<div class="dark"><div class="wrap">${header(x)}${inner}</div></div>`;
  const tail = `${footer(x)}\n<script>${SCRIPT}</script>\n</body>\n</html>`;
  const skip = `<a class="skip" href="#inhalt">${d.lang === 'de' ? 'Zum Inhalt springen' : 'Skip to content'}</a>`;
  if (d.kind === 'compare') {
    return `${head(x, { title: c.matrix.pageTitle, description: c.matrix.pageLead, path, extraCss: matrixCss(d.matrix) })}
<body>${skip}${darkTop(`<div style="padding:30px 0 44px"><p class="kicker">${h(c.hero.eyebrow)}</p><h1 style="font-size:clamp(34px,5.4vw,64px);max-width:22ch">${h(c.matrix.pageTitle)}</h1><p class="sub">${h(c.matrix.pageLead)}</p><p>${starLink(x)}</p></div>`)}
<main id="inhalt">${matrixSection(x, true)}${whySwitch(x)}${vsSection(x)}</main>
${tail}`;
  }
  if (d.kind === 'highlevel') {
    return `${head(x, { title: c.hlPage.title, description: c.hlPage.description, path })}
<body>${skip}${darkTop(`<div style="padding:30px 0 44px"><p class="kicker">${h(c.hero.eyebrow)}</p><h1 style="font-size:clamp(34px,5.4vw,68px);max-width:20ch">${h(c.hlPage.h1)}</h1><p class="sub">${h(c.hlPage.lead)}</p><div class="ctas"><a class="btn primary" href="${DEMO_URL}" rel="noopener">${ICON.play}${h(c.hlPage.cta)}</a><a class="btn ghost" href="${pagePath('home', d.lang) === '/' ? '' : pagePath('home', d.lang)}/#installieren">${h(c.hero.ctaSelf)}</a></div></div>`)}
<main id="inhalt"><section aria-labelledby="hl-facts"><div class="wrap">
<div class="hlmsg"><p class="big">${h(c.hlPage.message)}</p><p class="muted">${h(c.hlPage.messageNote)}</p></div>
<h2 id="hl-facts">${h(c.hlPage.factsH2)}</h2><ul class="facts">${c.hlPage.facts.map((f) => `<li>${h(f)}</li>`).join('')}</ul>
<p class="fine">${h(c.vsHl.foot(dateText(c, HL_AS_OF)))} <a href="${HL_SOURCE}" rel="noopener nofollow">${h(HL_SOURCE.replace('https://', ''))}</a></p>
<div style="height:30px"></div><h2>${h(c.vsHl.h2)}</h2>${vsTable(x)}</div></section>
<section class="alt" aria-labelledby="umzug-h"><div class="wrap">${move(x)}</div></section>
${calculator(x)}</main>
${tail}`;
  }
  // home
  const shared = d.calc.shared;
  const sc = shared ? summary(x) : undefined;
  const ax: AgenticCtx = { a: x.a, shots: d.shots, gh: GITHUB_URL, nums: { tools: num(c, d.stats.tools), themes: num(c, d.stats.themes), iconPacks: num(c, d.stats.iconPacks) } };
  return `${head(x, { title: c.title, description: c.description, path, ogTitle: sc?.title, ogDescription: sc?.description, extraCss: `${LOGOS_CSS}${AGENTIC_CSS}${matrixCss(d.matrix)}` })}
<body>${skip}${darkTop(`${hero(x)}${logosHtml(x.a.logos, `${GITHUB_URL}/blob/main/docs/integrations.md`)}${proof(x)}`)}
<main id="inhalt">
${ssotSection(ax)}
${jarvisSection(ax)}
${uspSection(ax)}
${aiAgents(x)}
${academySection(ax)}
${designsSection(ax)}
${xrSection(ax)}
${stackSection(x)}
${calculator(x)}
${features(x)}
${dach(x)}
<section id="umzug" class="alt" aria-labelledby="umzug-h"><div class="wrap">${move(x)}</div></section>
${vsSection({ ...x })}
${matrixSection(x)}
${choose(x)}
${pricing(x)}
${waitlistSection(x)}
${whiteLabel(x)}
${apps(x)}
${ossSection(ax)}
${install(x)}
${faq(x)}
</main>
${tail}`;
}

/** og:title / og:description of a shared calculator link: the number the sharer saw. */
function summary(x: Ctx): { title: string; description: string } {
  const { d, c, mix } = x;
  const i = d.calc.input;
  if ((mix.length ? d.calc.mode : 'hl') === 'mix') {
    const sel = mix.filter((t) => d.calc.mix.includes(t.key));
    const cents = sel.reduce((a, t) => a + t.cents, 0);
    const ours = i.hosting === 'cloud' ? d.prices.solo : 0;
    const save = Math.max(0, Math.round(((cents - ours) * 12) / 100));
    return { title: c.calc.shareText(eur0(c, save)), description: c.calc.resultMix(eurC(c, cents), sel.length) };
  }
  const r = calculate(i, d.prices);
  return { title: c.calc.shareText(eur0(c, r.saveYearEur)), description: c.calc.resultHl(usd0(c, r.hlMonthUsd), c.calc.plans[r.hlPlan].split(' · ')[0]) };
}

/** Defaults of the calculator when the URL carries nothing (every tool of the mix ticked). */
export const defaultCalc = (mix: MixTool[]) => ({ input: CALC_DEFAULT, mode: (mix.length ? 'mix' : 'hl') as 'mix' | 'hl', mix: mix.map((t) => t.key), shared: false });

/** sitemap.xml of the landing pages (plus /cloud when the cloud mode is on). */
export function sitemapXml(base: string, extra: string[] = []): string {
  const kinds: PageKind[] = ['home', 'compare', 'highlevel'];
  const urls = kinds.flatMap((k) => (['de', 'en'] as Lang[]).map((l) => ({ k, l, loc: `${base}${pagePath(k, l)}` })));
  const alt = (k: PageKind) => (['de', 'en'] as Lang[]).map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${h(`${base}${pagePath(k, l)}`)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.map((u) => `<url><loc>${h(u.loc)}</loc>${alt(u.k)}</url>`).join('\n')}
${extra.map((p) => `<url><loc>${h(`${base}${p}`)}</loc></url>`).join('\n')}
</urlset>
`;
}
