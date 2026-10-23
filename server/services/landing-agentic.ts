import { escapeHtml as h } from '../core/template.js';
import type { AgenticCopy, Nums, ShotKey, UspIcon } from './landing-agentic-copy.js';

/**
 * Launch landing page: the agentic sections, server-rendered like the rest of landing-page.ts – one source of truth (agents fill the
 * CRM), Jarvis, what makes the product different, the Academy, designs, XR, open source. Pure: the page passes the copy (product name
 * already filled in), the screenshots that exist and the numbers. A screenshot that is missing on disk is simply not rendered; one
 * that fails to load anyway is hidden by the page's script (`data-hide`), and the text then takes the full width.
 */

export interface Shot {
  key: ShotKey;
  src: string;
  w: number;
  h: number;
}

export interface AgenticCtx {
  a: AgenticCopy;
  shots: Shot[];
  nums: Nums;
  /** The repository (https://github.com/…), for docs links. */
  gh: string;
}

/** lucide icons (ISC), stroke style like the rest of the page. */
const line = (d: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</g></svg>`;
const USP_ICON: Record<UspIcon, string> = {
  seat: line('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  db: line('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>'),
  jarvis: line('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>'),
  key: line('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  xr: line('<path d="M3 9a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-3l-2-2.5h-2L9 18H6a3 3 0 0 1-3-3z"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/>'),
  palette: line('<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>'),
  cap: line('<path d="M22 10v6"/><path d="M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>'),
  code: line('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  flag: line('<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>'),
};
const ARROW = line('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>').replace('class="ic"', 'class="ic sm"');
const STAR = '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.53L12 17.5l-5.87 3.07 1.12-6.53L2.5 9.41l6.56-.95L12 2.5Z"/></svg>';

const docLink = (x: AgenticCtx, path: string, text: string) => `<a class="morelink" href="${h(`${x.gh}/blob/main/${path}`)}" rel="noopener">${h(text)} ${ARROW}</a>`;

/** One source of truth: agents and people on the same database – the first thing after the hero. */
export function ssotSection(x: AgenticCtx): string {
  const s = x.a.ssot;
  const pills = (items: string[], cls = '') => `<ul class="pills${cls}">${items.map((t) => `<li>${h(t)}</li>`).join('')}</ul>`;
  return `<section id="agentisch" aria-labelledby="ssot-h"><div class="wrap"><div class="ssot">
<div class="ssot-t"><p class="kick">${h(s.kicker)}</p><h2 id="ssot-h">${h(s.h2)}</h2><p class="lead">${h(s.lead)}</p>
<ul class="guards">${s.guards.map((g) => `<li>${h(g)}</li>`).join('')}</ul>
<p class="fine">${h(s.fine)} <a href="${h(`${x.gh}/blob/main/docs/ai-tools.md`)}" rel="noopener">${h(s.docs)}</a></p></div>
<div class="flow" role="group" aria-label="${h(s.flowLabel)}"><p class="flow-l">${h(s.agentsLabel)}</p>${pills(s.agents)}<span class="flow-ar" aria-hidden="true"></span>
<p class="hub"><b>${h(s.hub)}</b><span>${h(s.hubSub)}</span></p><span class="flow-ar" aria-hidden="true"></span><p class="flow-l">${h(s.dataLabel)}</p>${pills(s.data, ' data')}</div>
</div></div></section>`;
}

/** Jarvis: what the companion does, with a small example conversation (no numbers, no data – an illustration). */
export function jarvisSection(x: AgenticCtx): string {
  const j = x.a.jarvis;
  const d = j.demo;
  return `<section id="jarvis" class="alt" aria-labelledby="jv-h"><div class="wrap"><div class="jv">
<div class="jv-t"><h2 id="jv-h">${h(j.h2)}</h2><p class="lead">${h(j.lead)}</p>
<ul class="jv-items">${j.items.map(([t, p]) => `<li><h3>${h(t)}</h3><p>${h(p)}</p></li>`).join('')}</ul></div>
<figure class="chat"><p class="chat-l">${h(d.label)}</p><p class="bub you">${h(d.you)}</p><p class="bub jv-b"><b>Jarvis</b>${h(d.jarvis)}</p>
<div class="ccard"><p>${h(d.card)}</p><p class="ccard-b"><span class="fb run">${h(d.run)}</span><span class="fb">${h(d.reject)}</span></p></div><figcaption>${h(d.note)}</figcaption></figure>
</div><p class="fine">${h(j.fine)}</p>${docLink(x, 'docs/living-boards.md#fokus-modus-mit-companion', j.docs)}</div></section>`;
}

/** Where each reason leads (a section of the page or a docs page). */
const USP_HREF: Record<UspIcon, string> = {
  seat: '#preise',
  db: '#agentisch',
  jarvis: '#jarvis',
  key: 'docs/ai-providers.md#subscription-sign-in-mit-chatgpt-anmelden-mit-claude-verbinden',
  xr: '#xr',
  palette: '#designs',
  cap: '#akademie',
  code: '#open-source',
  flag: '#dach',
};

export function uspSection(x: AgenticCtx): string {
  const u = x.a.usp;
  const href = (k: UspIcon) => (USP_HREF[k].startsWith('#') ? USP_HREF[k] : `${x.gh}/blob/main/${USP_HREF[k]}`);
  return `<section id="warum" aria-labelledby="usp-h"><div class="wrap"><h2 id="usp-h">${h(u.h2)}</h2><p class="lead">${h(u.lead)}</p>
<ul class="usp">${u
    .items(x.nums)
    .map(([k, t, p]) => `<li class="card"><span class="usp-i">${USP_ICON[k]}</span><h3><a href="${h(href(k))}"${href(k).startsWith('#') ? '' : ' rel="noopener"'}>${h(t)}</a></h3><p>${h(p)}</p></li>`)
    .join('')}</ul></div></section>`;
}

/** A spotlight: text and, when the screenshot exists, the picture beside it. */
function spot(x: AgenticCtx, o: { id: string; shot: ShotKey; alt?: boolean; rev?: boolean; h2: string; lead: string; stats?: [string, string][]; items: string[]; extra?: string[]; docs: [string, string] }): string {
  const s = x.shots.find((v) => v.key === o.shot);
  const fig = s
    ? `<figure class="spot-f" data-fig><img src="${h(s.src)}" width="${s.w}" height="${s.h}" alt="${h(x.a.shots[o.shot])}" loading="lazy" decoding="async" data-hide></figure>`
    : '';
  return `<section id="${o.id}"${o.alt ? ' class="alt"' : ''} aria-labelledby="${o.id}-h"><div class="wrap"><div class="spot${o.rev ? ' rev' : ''}${s ? '' : ' nofig'}">
<div class="spot-t"><h2 id="${o.id}-h">${h(o.h2)}</h2><p class="lead">${h(o.lead)}</p>${o.stats ? `<ul class="spot-n">${o.stats.map(([n, l]) => `<li><b>${h(n)}</b><span>${h(l)}</span></li>`).join('')}</ul>` : ''}<ul class="ticks">${o.items.map((t) => `<li>${h(t)}</li>`).join('')}</ul>${(o.extra ?? []).map((t) => `<p class="fine">${h(t)}</p>`).join('')}${docLink(x, o.docs[0], o.docs[1])}</div>${fig}
</div></div></section>`;
}

export const academySection = (x: AgenticCtx) => spot(x, { id: 'akademie', shot: 'academy', h2: x.a.academy.h2, lead: x.a.academy.lead, stats: x.a.academy.stats, items: x.a.academy.items, docs: ['docs/academy.md', x.a.academy.docs] });
export const designsSection = (x: AgenticCtx) => spot(x, { id: 'designs', shot: 'themes', alt: true, rev: true, h2: x.a.designs.h2, lead: x.a.designs.lead, items: x.a.designs.items(x.nums), docs: ['docs/theming.md', x.a.designs.docs] });
export const xrSection = (x: AgenticCtx) => spot(x, { id: 'xr', shot: 'xr', h2: x.a.xr.h2, lead: x.a.xr.lead, items: x.a.xr.items, extra: [x.a.xr.devices, x.a.xr.note], docs: ['docs/xr.md', x.a.xr.docs] });

export function ossSection(x: AgenticCtx): string {
  const o = x.a.oss;
  return `<section id="open-source" aria-labelledby="oss-h"><div class="wrap"><div class="oss"><h2 id="oss-h">${h(o.h2)}</h2><p class="lead">${h(o.lead)}</p>
<div class="links"><a class="btn ink" href="${h(`${x.gh}/blob/main/CONTRIBUTING.md`)}" rel="noopener">${h(o.contrib)}</a><a class="btn line" href="${h(`${x.gh}/issues?q=is%3Aopen+label%3A%22good+first+issue%22`)}" rel="noopener">${h(o.issues)}</a><a class="btn line" href="${h(x.gh)}" rel="noopener">${STAR}${h(o.star)}</a></div>
<p class="fine">${h(o.fine)}</p></div></div></section>`;
}

export const AGENTIC_CSS = `
/* agentic sections (landing-agentic.ts) */
.kick{color:#f3c983;font-weight:600;font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 12px}
.ssot{display:grid;gap:28px;background:radial-gradient(900px 420px at 100% 0,#1d3a8a 0,rgba(29,58,138,0) 60%),var(--ink);color:var(--on-dark);border-radius:28px;padding:26px 20px}
@media(min-width:960px){.ssot{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);padding:44px;gap:44px;align-items:center}}
.ssot h2{max-width:20ch}
.ssot .lead{color:var(--muted-dark);margin-bottom:20px}
.ssot .fine{color:var(--muted-dark)}.ssot .fine a{color:var(--on-dark)}
.guards{list-style:none;margin:0;padding:0;display:grid;gap:8px 20px;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))}
.guards li{position:relative;padding-left:26px;font-weight:500}
.guards li::before{content:"✓";position:absolute;left:0;color:var(--accent);font-weight:700}
.flow{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;background:#ffffff08;border:1px solid #ffffff1f;border-radius:22px;padding:22px 16px}
.flow-l{margin:0;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-dark)}
.pills{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin:0;padding:0;list-style:none}
.pills li{border:1px solid #ffffff33;border-radius:999px;padding:4px 12px;font-size:14px;font-weight:500;background:#ffffff0a}
.pills.data li{border-color:#ffb54766;color:#ffe3ad}
.flow-ar{display:block;width:2px;height:26px;background:linear-gradient(#ffffff10,var(--accent));position:relative}
.flow-ar::after{content:"";position:absolute;left:50%;bottom:-2px;width:8px;height:8px;border-right:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:translateX(-50%) rotate(45deg)}
.hub{margin:2px 0;display:flex;flex-direction:column;gap:2px;padding:14px 26px;border-radius:18px;background:linear-gradient(180deg,#ffc56a,#ffb547);color:var(--ink);box-shadow:0 10px 30px #ffb54733}
.hub b{font-size:20px;font-weight:650;line-height:1.2}.hub span{font-size:13px;font-weight:500}
.jv{display:grid;gap:26px}
@media(min-width:960px){.jv{grid-template-columns:minmax(0,1.35fr) minmax(0,.65fr);gap:40px;align-items:start}.chat{position:sticky;top:24px}}
.jv-items{list-style:none;margin:0;padding:0;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr))}
.jv-items li{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.jv-items h3{font-size:16.5px}.jv-items p{margin:0;color:var(--muted);font-size:15.5px}
.chat{margin:0;background:var(--ink);color:var(--on-dark);border-radius:22px;padding:20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 60px #0a143033}
.chat-l{margin:0;align-self:flex-start;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-dark);border:1px solid #ffffff2e;border-radius:999px;padding:2px 10px}
.bub{margin:0;padding:12px 14px;border-radius:16px;font-size:15.5px;line-height:1.5;max-width:92%}
.bub.you{align-self:flex-end;background:var(--accent);color:var(--ink);border-bottom-right-radius:4px;font-weight:500}
.bub.jv-b{align-self:flex-start;background:var(--ink2);border:1px solid #ffffff1f;border-bottom-left-radius:4px}
.bub.jv-b b{display:block;font-size:12px;letter-spacing:.04em;color:#f3c983;margin-bottom:2px}
.ccard{background:var(--card);color:var(--ink);border-radius:14px;padding:12px 14px;font-size:15px}
.ccard p{margin:0;font-weight:600}.ccard .ccard-b{display:flex;gap:8px;margin-top:10px}
.fb{display:inline-flex;align-items:center;border-radius:9px;padding:6px 12px;font-size:14px;font-weight:600;border:1px solid #0a143040}
.fb.run{background:var(--ink);color:var(--on-dark);border-color:var(--ink)}
.chat figcaption{font-size:13px;color:var(--muted-dark)}
#jarvis .fine{margin-top:18px}
.usp{list-style:none;margin:0;padding:0;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.usp .card{display:flex;flex-direction:column;gap:6px}
.usp-i{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:12px;background:#fff1d6;color:#8a5a00;margin-bottom:8px}
.usp h3 a{text-decoration:none}.usp h3 a:hover{text-decoration:underline}
.spot{display:grid;gap:28px;align-items:center}
@media(min-width:960px){.spot{grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:48px}.spot.rev .spot-t{order:2}.spot.nofig{grid-template-columns:1fr}.spot.nofig .ticks{columns:2;column-gap:40px;display:block}.spot.nofig .ticks li{break-inside:avoid;margin:0 0 9px}}
.spot:has(>.spot-f[hidden]){grid-template-columns:1fr}
.spot:not(.nofig) h2{font-size:clamp(28px,3.3vw,40px)}
.spot-f{margin:0;border-radius:18px;overflow:hidden;border:1px solid var(--line);background:var(--card);box-shadow:0 24px 60px #0a14301f}
.spot-f img{display:block;width:100%;height:auto}
.spot .morelink{margin-top:10px}
.spot-n{list-style:none;margin:0 0 24px;padding:0;display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr));max-width:720px}
.spot-n li{background:var(--ink);color:var(--on-dark);border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;gap:4px}
.spot-n b{font-family:var(--display);font-weight:600;font-size:clamp(30px,4vw,44px);line-height:1;color:var(--accent)}
.spot-n span{font-size:14px;color:var(--muted-dark);line-height:1.35}
@media(max-width:520px){.spot-n{gap:8px}.spot-n li{padding:12px}.spot-n span{font-size:12.5px}}
.oss{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:26px}
@media(min-width:900px){.oss{padding:38px}}
.oss .links{margin:0 0 14px}
.btn .ic.sm{color:var(--accent2)}
`;
