import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, redirect, text, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { safeEqual, sha256 } from '../core/util.js';
import { getContact, type Contact } from '../services/contacts.js';
import { icsFeed } from '../services/ical.js';
import { excerptOf, renderMarkdown, stripMarkdown } from '../services/markdown.js';
import {
  accessibleGroups,
  groupAccess,
  groupSettings,
  isPortalMember,
  levelFor,
  memberPoints,
  nextLevel,
  relTime,
  stripMarkdownImages,
  MAX_POST_IMAGES,
} from '../services/community.js';
import {
  addComment,
  createPost,
  deleteComment,
  deletePost,
  editPost,
  ensureProfile,
  fileResponse,
  getPost,
  joinGroup,
  markRead,
  profileOf,
  report,
  toggleFollow,
  toggleLike,
  updateProfile,
  type Profile,
} from '../services/community-actions.js';
import { communityUi, type CommunityKit } from '../services/community-ui.js';
import { boardOf, type BoardPeriod } from '../services/community-gamify.js';
import { inRegion, mapSvg, pointsOf, type Region } from '../services/community-geo.js';
import { CAN, onlineIds, profileExt, roleOf, touchActive, touchPresence, extOf } from '../services/community-ext.js';
import type { Member, Portal } from './portal.js';

/**
 * The community inside the member portal (/portal/<key>/community): groups → channels → posts with
 * threaded comments, likes, follows, mentions, notifications (bell), profiles, leaderboard and the
 * group calendar. Server-rendered and mobile friendly like the rest of the portal; a small script
 * only adds image picking (resized in the browser) and confirmations. Every form carries a token
 * tied to the member session on top of the portal's same-origin check.
 */

interface Kit {
  resolve(key: string): Portal | undefined;
  memberOf(ctx: Ctx, p: Portal): Member | undefined;
  page(p: Portal, opts: { title: string; body: string; member?: Member; status?: number; head?: string }): RawResult;
  loginPage(p: Portal, opts?: { error?: string; status?: number; next?: string }): RawResult;
  notFoundPage(p: Portal, m?: Member): RawResult;
  unknownPortal(): RawResult;
  sameOrigin(ctx: Ctx): boolean;
}

const PER_PAGE = 20;

const I = {
  heart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  users: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/></svg>',
};

/** Styles for the top bar link and bell – on every portal page. */
const HEAD_CSS = `<style>
.pn-link{color:var(--text);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px}
.pn-link:hover{color:var(--brand)}
.pn-bell{position:relative;color:var(--text);display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;text-decoration:none}
.pn-bell:hover{background:var(--soft);color:var(--brand)}
.pn-bell b{position:absolute;top:2px;right:0;background:#e11d48;color:#fff;border-radius:99px;font-size:10px;line-height:16px;min-width:16px;padding:0 4px;text-align:center}
.cm-dash{margin-top:34px}.cm-dash h2{display:flex;align-items:center;gap:8px}
.cm-groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}
.cm-group{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;display:flex;flex-direction:column}
.cm-group:hover{border-color:var(--brand)}
.cm-group .cv{aspect-ratio:3/1;background:linear-gradient(135deg,var(--brand),#0f172a) center/cover no-repeat;color:#fff;display:grid;place-items:center;font-size:34px;font-weight:800}
.cm-group .b{padding:14px 16px 16px;display:flex;flex-direction:column;gap:6px}
.cm-group h3{margin:0;font-size:18px;display:flex;gap:8px;align-items:center}
.cm-n{margin-left:auto;background:var(--brand);color:#fff;border-radius:99px;font-size:11px;font-weight:700;padding:1px 7px;line-height:17px;white-space:nowrap}
.cm-group .cm-n{margin-left:0}.cm-group .muted{display:inline-flex;gap:5px;align-items:center}
@media (max-width:560px){.pn-link span{display:none}}
</style>`;

const CSS = `<style>
.cm-head{display:flex;gap:18px;align-items:center;margin-bottom:18px}
.cm-head .cm-cover{width:76px;height:76px;border-radius:18px;flex:none;background:linear-gradient(135deg,var(--brand),#0f172a) center/cover no-repeat;display:grid;place-items:center;color:#fff;font-size:30px;font-weight:800}
.cm-head h1{margin:0}.cm-head p{margin:2px 0 0}
.cm-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:14px;color:var(--muted);margin-top:6px}.cm-stats span{display:inline-flex;gap:5px;align-items:center}
.cm-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 0 20px;overflow-x:auto;scrollbar-width:none}
.cm-tabs a{padding:10px 14px;color:var(--muted);text-decoration:none;font-weight:600;border-bottom:2px solid transparent;white-space:nowrap;display:inline-flex;gap:6px;align-items:center}
.cm-tabs a:hover{color:var(--text)}.cm-tabs a.on{color:var(--text);border-color:var(--brand)}
.cm-grid{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:24px;align-items:start}
.cm-side{position:sticky;top:80px;display:flex;flex-direction:column;gap:14px}
.cm-box{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px}
.cm-box h3{margin:0 0 10px;font-size:15px}
.cm-chlist{padding:8px}
.cm-ch{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;color:inherit;text-decoration:none;font-size:15px}
.cm-ch:hover{background:var(--soft)}.cm-ch.on{background:var(--soft);color:var(--brand);font-weight:600}
.cm-ch .e{width:20px;text-align:center}
.cm-cat{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:12px 10px 4px;font-weight:700}
.cm-chips{display:none;gap:8px;overflow-x:auto;padding-bottom:8px;margin-bottom:10px;scrollbar-width:none}
.cm-chips a{flex:none;padding:7px 13px;border-radius:99px;border:1px solid var(--line);background:var(--panel);color:inherit;text-decoration:none;font-size:14px;font-weight:600;display:inline-flex;gap:6px;align-items:center}
.cm-chips a.on{background:var(--brand);border-color:var(--brand);color:#fff}.cm-chips a.on .cm-n{background:#fff;color:var(--brand)}
.cm-post{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:12px;scroll-margin-top:80px}
.cm-post.pinned{border-color:var(--brand);box-shadow:0 0 0 1px var(--soft) inset}
.cm-meta{display:flex;align-items:center;gap:11px;min-width:0}
.cm-meta .who2{min-width:0;font-size:14px;color:var(--muted);line-height:1.35}
.cm-meta .who2 strong,.cm-meta .who2 a.nm{color:var(--text);font-weight:700;text-decoration:none}
.cm-meta .flags{margin-left:auto;display:flex;gap:6px;align-items:center;flex:none}
.cm-tag{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--soft);color:var(--brand)}
.cm-tag.new{background:#e11d48;color:#fff}.cm-tag.muted{background:transparent;color:var(--muted);border:1px solid var(--line)}
.avw{position:relative;flex:none;display:inline-block;line-height:0;align-self:flex-start}
.av{width:42px;height:42px;border-radius:50%;object-fit:cover;display:inline-grid;place-items:center;color:#fff;font-weight:700;font-size:15px;line-height:1;background:var(--brand)}
.av.s{width:32px;height:32px;font-size:12px}.av.l{width:96px;height:96px;font-size:34px}
.avw .lv{position:absolute;right:-5px;bottom:-4px;background:var(--brand);color:#fff;border:2px solid var(--panel);border-radius:99px;min-width:21px;height:21px;font-size:11px;font-weight:800;display:grid;place-items:center;padding:0 4px;line-height:1}
.av.s+.lv{min-width:18px;height:18px;font-size:10px;right:-6px}
.cm-title{display:block;font-size:18.5px;font-weight:700;color:var(--text);text-decoration:none;margin:12px 0 4px;line-height:1.35}
.cm-title:hover{color:var(--brand)}
.cm-excerpt{color:var(--muted);font-size:15.5px;margin:0;overflow-wrap:anywhere}
.cm-thumbs{display:flex;gap:8px;margin-top:12px}.cm-thumbs img{height:120px;max-width:100%;border-radius:10px;object-fit:cover;flex:1 1 0;min-width:0}
.cm-acts{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:14px;color:var(--muted);flex-wrap:wrap}
.cm-acts form{margin:0}.cm-acts .sp{margin-left:auto}
.cm-btn{background:var(--panel);border:1px solid var(--line);border-radius:99px;padding:5px 12px;font:inherit;font-size:14px;color:inherit;cursor:pointer;display:inline-flex;gap:6px;align-items:center;text-decoration:none;line-height:1.3}
.cm-btn:hover{border-color:var(--brand);color:var(--brand)}
.cm-btn.on{color:#e11d48;border-color:rgba(225,29,72,.35);background:rgba(225,29,72,.08)}
.cm-btn.on svg{fill:currentColor}
.cm-btn.f.on{color:var(--brand);border-color:var(--brand);background:var(--soft)}
.cm-link{background:none;border:0;padding:0;font:inherit;font-size:13.5px;color:var(--muted);cursor:pointer;text-decoration:none}
.cm-link:hover{color:var(--brand)}
.cm-compose{background:var(--panel);border:1px solid var(--line);border-radius:16px;margin-bottom:16px}
.cm-compose>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;color:var(--muted)}
.cm-compose>summary::-webkit-details-marker{display:none}
.cm-compose>summary span.ph{flex:1;border:1px solid var(--line);border-radius:99px;padding:9px 16px;background:var(--bg)}
.cm-compose[open]>summary{border-bottom:1px solid var(--line)}
.cm-form{padding:14px 16px 16px;display:flex;flex-direction:column;gap:10px}
.cm-form label{font-size:13px;font-weight:600;color:var(--muted)}
.cm-form input[type=text],.cm-form textarea,.cm-form select,.cm-in{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:16px;background:var(--panel);color:var(--text)}
.cm-form textarea{min-height:120px;resize:vertical;line-height:1.5}
.cm-form input:focus,.cm-form textarea:focus,.cm-form select:focus,.cm-in:focus{outline:2px solid var(--brand);outline-offset:-1px;border-color:transparent}
.cm-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.cm-row .grow{flex:1}
.cm-hint{font-size:13px;color:var(--muted)}
.cm-pick{display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.cm-previews{display:flex;gap:8px;flex-wrap:wrap}.cm-previews:empty{display:none}
.cm-previews span{position:relative}.cm-previews img{width:84px;height:84px;object-fit:cover;border-radius:10px;display:block}
.cm-previews button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;border:0;background:#0f172a;color:#fff;cursor:pointer;font-size:12px;line-height:22px;padding:0}
.cm-err{background:rgba(220,38,38,.1);color:#dc2626;padding:11px 14px;border-radius:12px;margin-bottom:14px;font-weight:600}
.cm-ok{background:rgba(5,150,105,.12);color:var(--ok);padding:11px 14px;border-radius:12px;margin-bottom:14px;font-weight:600}
.cm-pager{display:flex;justify-content:space-between;gap:10px;margin-top:8px}
.cm-full .prose{margin-top:6px}
.cm-full h1{font-size:clamp(23px,3vw,30px);margin:14px 0 6px}
.cm-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin:14px 0}
.cm-gallery img{width:100%;border-radius:12px;display:block;max-height:420px;object-fit:cover}
.cm-gallery.one{grid-template-columns:1fr}.cm-gallery.one img{object-fit:contain;max-height:560px;background:var(--bg)}
.cm-comments{margin-top:18px}.cm-comments>h2{font-size:18px}
.cm-c{display:flex;gap:10px;padding:12px 0;border-top:1px solid var(--line);scroll-margin-top:90px}
.cm-c .bd{flex:1;min-width:0}
.cm-c .bubble{background:var(--bg);border-radius:4px 14px 14px 14px;padding:9px 13px}
.cm-c .bubble .prose{font-size:15.5px}.cm-c .bubble .prose p{margin:4px 0}
.cm-c .hd{font-size:13.5px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;align-items:center}.cm-c .hd strong,.cm-c .hd a.nm{color:var(--text);text-decoration:none}
.cm-c .ft{display:flex;gap:14px;align-items:center;margin:5px 0 0 4px;flex-wrap:wrap}
.cm-c .ft form{margin:0}
.cm-replies{margin-left:52px}.cm-replies .cm-c{border-top:0;padding:8px 0}
.cm-c details>summary{list-style:none;cursor:pointer}.cm-c details>summary::-webkit-details-marker{display:none}
.cm-c details[open]{flex-basis:100%}
.cm-mini{display:flex;flex-direction:column;gap:8px;margin-top:8px}.cm-mini textarea{min-height:70px}
.mention{font-weight:600;color:var(--brand);text-decoration:none;background:var(--soft);padding:0 4px;border-radius:6px}
.cm-report summary{color:var(--muted);font-size:13.5px}
.cm-ev{display:flex;gap:16px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
.cm-ev .d{width:58px;flex:none;text-align:center;border-radius:12px;background:var(--soft);color:var(--brand);padding:8px 0;line-height:1.1}
.cm-ev .d b{display:block;font-size:24px}.cm-ev .d small{font-size:12px;text-transform:uppercase;font-weight:700}
.cm-ev h3{margin:0 0 2px;font-size:17px}.cm-ev .bd{flex:1;min-width:0}
.cm-mev{display:flex;gap:10px;align-items:center;font-size:14px;text-decoration:none;color:inherit;padding:6px 0}
.cm-mev .d{width:40px;text-align:center;border-radius:9px;background:var(--soft);color:var(--brand);font-weight:800;line-height:1.05;padding:4px 0;font-size:15px;flex:none}.cm-mev .d small{display:block;font-size:10px}
.cm-members{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.cm-mem{display:flex;gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;text-decoration:none;color:inherit}
.cm-mem:hover{border-color:var(--brand)}.cm-mem .t{min-width:0}.cm-mem .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-lb{list-style:none;margin:0;padding:0}
.cm-lb li{display:flex;align-items:center;gap:12px;padding:10px 4px;border-top:1px solid var(--line)}.cm-lb li:first-child{border-top:0}
.cm-lb .r{width:30px;text-align:center;font-weight:800;color:var(--muted)}.cm-lb .r.top{font-size:20px}
.cm-lb .p{margin-left:auto;font-weight:700;color:var(--brand);white-space:nowrap}
.cm-lb li.me{background:var(--soft);border-radius:12px}
.cm-lvls{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.cm-lvls div{border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14px}.cm-lvls div.on{border-color:var(--brand);background:var(--soft)}
.cm-lvls b{display:block}
.cm-me{display:flex;gap:12px;align-items:center}.cm-me .bar{margin-top:6px}
.cm-seg{display:inline-flex;border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:14px}
.cm-seg a{padding:8px 14px;text-decoration:none;color:var(--muted);font-weight:600;font-size:14px}.cm-seg a.on{background:var(--brand);color:#fff}
.cm-notes{list-style:none;margin:0;padding:0}
.cm-notes a{display:flex;gap:12px;align-items:flex-start;padding:13px 16px;border-top:1px solid var(--line);text-decoration:none;color:inherit}
.cm-notes li:first-child a{border-top:0}.cm-notes a.un{background:var(--soft)}.cm-notes a.un strong{color:var(--text)}
.cm-notes .ic{width:34px;height:34px;border-radius:50%;background:var(--soft);color:var(--brand);display:grid;place-items:center;flex:none}
.cm-prof{display:flex;gap:20px;align-items:center;margin-bottom:20px}.cm-prof h1{margin:0}
.cm-empty{text-align:center;padding:40px 20px;color:var(--muted)}
@media (max-width:900px){.cm-grid{grid-template-columns:minmax(0,1fr)}.cm-side{position:static}.cm-side .cm-chlist{display:none}.cm-chips{display:flex}.cm-replies{margin-left:30px}}
@media (max-width:560px){.cm-head .cm-cover{width:56px;height:56px;font-size:22px;border-radius:14px}.cm-post{padding:14px}.cm-thumbs img{height:90px}.cm-acts{gap:8px}.cm-prof{flex-direction:column;text-align:center}.cm-tag .tx{display:none}}
</style>`;

/** Progressive enhancement: image picking with in-browser resizing, confirmations, Ctrl+Enter. */
const SCRIPT = `(function(){
function readAs(file){return new Promise(function(ok,no){var r=new FileReader();r.onload=function(){ok(r.result)};r.onerror=no;r.readAsDataURL(file)})}
function shrink(file){
  if(file.type==='image/gif'||((file.type==='image/png'||file.type==='image/webp')&&file.size<1500000))return readAs(file);
  return readAs(file).then(function(url){return new Promise(function(ok){var img=new Image();img.onload=function(){
    var max=1600,w=img.naturalWidth,h=img.naturalHeight,s=Math.min(1,max/Math.max(w,h));
    var c=document.createElement('canvas');c.width=Math.round(w*s);c.height=Math.round(h*s);
    var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);ok(c.toDataURL('image/jpeg',0.85))};
    img.onerror=function(){ok(url)};img.src=url})})}
document.querySelectorAll('input[data-images]').forEach(function(inp){
  var form=inp.form,max=+inp.getAttribute('data-images')||1,name=inp.getAttribute('data-name')||'image';
  var box=form.querySelector('.cm-previews');var lab=inp.closest('label');if(lab)lab.hidden=false;
  inp.addEventListener('change',function(){
    var files=[].slice.call(inp.files||[]);inp.value='';
    files.forEach(function(f){
      if(form.querySelectorAll('input[name="'+name+'"]').length>=max){alert('Höchstens '+max+(max>1?' Bilder':' Bild'));return}
      if(!/^image\\/(png|jpeg|gif|webp)$/.test(f.type)){alert('Nur PNG, JPG, GIF oder WebP');return}
      shrink(f).then(function(data){
        if(data.length>4200000){alert('Bild ist zu groß (höchstens 3 MB)');return}
        var h=document.createElement('input');h.type='hidden';h.name=name;h.value=data;form.appendChild(h);
        if(box){var s=document.createElement('span'),i=document.createElement('img'),b=document.createElement('button');i.src=data;i.alt='';b.type='button';b.textContent='✕';b.setAttribute('aria-label','Bild entfernen');
          b.onclick=function(){h.remove();s.remove()};s.appendChild(i);s.appendChild(b);box.appendChild(s)}
      })})})});
document.addEventListener('submit',function(e){var m=e.target.getAttribute('data-confirm');if(m&&!confirm(m))e.preventDefault()},true);
document.addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&e.target.tagName==='TEXTAREA'&&e.target.form){e.preventDefault();e.target.form.requestSubmit()}});
})();`;

const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5', '#b45309'];
const initials = (name: string) =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export const communityPortalModule: Module = {
  name: 'community-portal',
  register(app) {
    // Member posts carry images (up to 3 MB, base64 in a form post).
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && /^\/portal\/[^/]+\/community\//.test(p), bytes: 12 * 1024 * 1024 }];
    const { db, router } = app;
    const ui = communityUi(app);
    const kit = (): Kit => {
      const k = app.services.portalKit;
      if (!k) throw new HttpError(501, 'Mitgliederbereich nicht verfügbar');
      return k;
    };

    // --- helpers -------------------------------------------------------------------------------
    const cbase = (p: Portal) => `${p.base}/community`;
    const gHref = (p: Portal, g: any) => `${cbase(p)}/g/${encodeURIComponent(g.slug)}`;
    const postHref = (p: Portal, g: any, postId: string) => `${gHref(p, g)}/p/${encodeURIComponent(postId)}`;
    const csrf = (m: Member) => sha256(`${app.config.secret}:community-form:${m.sessionHash}`).slice(0, 32);
    const tokenInput = (m: Member) => `<input type="hidden" name="csrf" value="${csrf(m)}">`;
    const tz = (p: Portal) => p.loc.timezone || 'Europe/Berlin';
    const when = (p: Portal, iso: string) => `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(formatInTz(iso, tz(p)))}">${relTime(iso)}</time>`;
    const fileUrl = (p: Portal, fid: string) => `${cbase(p)}/files/${encodeURIComponent(fid)}`;

    const profilesById = new Map<string, Profile>();
    const profile = (p: Portal, contactId: string): Profile | undefined => {
      const key = `${p.locationId}:${contactId}`;
      if (!profilesById.has(key)) {
        const pr = profileOf(app, p.locationId, contactId);
        if (!pr) return undefined;
        profilesById.set(key, pr);
      }
      return profilesById.get(key);
    };
    const avatar = (p: Portal, name: string, pr?: Profile, size = '', level?: number) => {
      const color = COLORS[parseInt(sha256(name || 'x').slice(0, 6), 16) % COLORS.length];
      const img = pr?.avatar_file_id ? `<img class="av ${size}" src="${fileUrl(p, pr.avatar_file_id)}" alt="">` : `<span class="av ${size}" style="background:${color}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
      return `<span class="avw">${img}${level ? `<span class="lv" title="Level ${level}">${level}</span>` : ''}</span>`;
    };
    const levelOf = (g: any, contactId: string | null) => (contactId ? levelFor(memberPoints(app, g.id, contactId), groupSettings(g).levels) : 0);
    const authorBits = (p: Portal, g: any, row: { contact_id: string | null; author_name: string }) => {
      const pr = row.contact_id ? profile(p, row.contact_id) : undefined;
      const name = pr?.display_name || row.author_name || 'Mitglied';
      const nameHtml = pr ? `<a class="nm" href="${cbase(p)}/u/${encodeURIComponent(pr.handle)}">${escapeHtml(name)}</a>` : `<strong>${escapeHtml(name)}</strong>`;
      return { name, nameHtml, avatar: (size = '') => avatar(p, name, pr, size, row.contact_id ? levelOf(g, row.contact_id) : 0), team: !row.contact_id };
    };

    /** Markdown for community text: members can't embed outside images; @handles become links. */
    const renderText = (p: Portal, src: string, byMember: boolean) => {
      const out = renderMarkdown(byMember ? stripMarkdownImages(src) : src, { embeds: true });
      return out.replace(/(^|[\s>(])@([a-z0-9][a-z0-9-]{1,39})\b/gi, (m, pre, handle) => {
        const pr = db.get<Profile>('SELECT * FROM community_profiles WHERE location_id = ? AND handle = ?', p.locationId, handle.toLowerCase());
        return pr ? `${pre}<a class="mention" href="${cbase(p)}/u/${encodeURIComponent(pr.handle)}">@${escapeHtml(pr.display_name)}</a>` : m;
      });
    };

    const frame = (p: Portal, m: Member, title: string, body: string, status = 200, opts: { scripts?: string[]; head?: string; frameSrc?: string[]; permissions?: string } = {}): RawResult => {
      const scripts = [...ui.scripts, ...(opts.scripts ?? [])].map((src) => `<script src="${escapeHtml(src)}" defer></script>`).join('');
      const r = kit().page(p, { title, body, member: m, status, head: `${CSS}${ui.head.map((fn) => fn(p)).join('')}${opts.head ?? ''}<script src="/portal-community.js" defer></script>${scripts}` });
      // The portal allows no scripts; community pages load our own files (and talk to this server only).
      const frameSrc = opts.frameSrc?.length ? ` ${opts.frameSrc.join(' ')}` : '';
      r.headers['content-security-policy'] = String(r.headers['content-security-policy'])
        .replace("default-src 'none';", "default-src 'none'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self';")
        .replace('frame-src ', `frame-src${frameSrc} `);
      if (opts.permissions) r.headers['permissions-policy'] = opts.permissions;
      return r;
    };
    const errorPage = (p: Portal, m: Member, msg: string, status: number) =>
      frame(p, m, 'Hinweis', `<div class="panel empty"><h1>${status === 403 ? 'Kein Zugang' : 'Hinweis'}</h1><p class="muted">${escapeHtml(msg)}</p><a class="btn" href="${cbase(p)}">Zur Community</a></div>`, status);

    /** Looks up the portal and member; members without a session go to the login. */
    const withMember = (ctx: Ctx, fn: (p: Portal, m: Member) => RawResult | Promise<RawResult>) => {
      const k = kit();
      const p = k.resolve(ctx.params.p);
      if (!p) return k.unknownPortal();
      const m = k.memberOf(ctx, p);
      if (!m) return ctx.method === 'GET' ? k.loginPage(p, { status: 401, next: ctx.path }) : redirect(p.base, 303);
      if (ctx.method !== 'GET' && (!k.sameOrigin(ctx) || !safeEqual(ctx.body?.csrf, csrf(m)))) return errorPage(p, m, 'Die Seite war zu lange offen. Bitte neu laden und noch einmal versuchen.', 403);
      return fn(p, m);
    };
    /** …and the group, if the member may see it (first visit = joining). */
    const withGroup = (ctx: Ctx, fn: (p: Portal, m: Member, g: any) => RawResult | Promise<RawResult>) =>
      withMember(ctx, (p, m) => {
        const g = parseJson(db.get(`SELECT * FROM community_groups WHERE location_id = ? AND slug = ?`, p.locationId, ctx.params.group), ['access', 'settings']);
        const a = g ? groupAccess(app, g, m.contact) : 'none';
        if (a === 'banned') return errorPage(p, m, 'Du wurdest aus dieser Gruppe ausgeschlossen. Bei Fragen wende dich an das Team.', 403);
        if (a !== 'ok' || !g) return kit().notFoundPage(p, m);
        joinGroup(app, g, m.contact);
        // Who is here right now, and on which days (the numbers of the analytics), plus whatever the extensions track.
        touchPresence(app, p.locationId, m.contact.id);
        touchActive(app, g as { id: string; location_id: string }, m.contact.id);
        for (const fn of ui.visit) fn(app, g, m.contact.id);
        return fn(p, m, g);
      });
    const back = (p: Portal, v: unknown, fallback: string) => {
      const s = String(v ?? '');
      return s.startsWith(`${cbase(p)}/`) && /^[\w\-/%.?=&#]+$/.test(s) && !s.includes('//') && !s.includes('..') ? s : fallback;
    };
    const fail = (e: unknown): { status: number; msg: string } => {
      if (e instanceof HttpError) return { status: e.status, msg: e.message };
      throw e;
    };
    const formAll = (ctx: Ctx, name: string): string[] => {
      const v = ctx.body?.[name];
      if (Array.isArray(v)) return v.map(String);
      if ((ctx.req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return new URLSearchParams(ctx.rawBody).getAll(name);
      return v ? [String(v)] : [];
    };

    const unreadBell = (p: Portal, m: Member) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_notifications WHERE location_id = ? AND contact_id = ? AND read_at IS NULL', p.locationId, m.contact.id)!.n;
    const joinedAt = (g: any, contactId: string) => db.get('SELECT joined_at FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contactId)?.joined_at ?? new Date().toISOString();
    /** Posts with activity the member hasn't seen yet (since joining), per channel. */
    const unreadByChannel = (g: any, contactId: string): Map<string, number> =>
      new Map(
        db
          .all<{ channel_id: string; n: number }>(
            `SELECT p.channel_id, COUNT(*) AS n FROM community_posts p LEFT JOIN community_reads r ON r.post_id = p.id AND r.contact_id = ?
             WHERE p.group_id = ? AND p.status = 'visible' AND p.last_activity_at > COALESCE(r.read_at, ?) GROUP BY p.channel_id`,
            contactId,
            g.id,
            joinedAt(g, contactId),
          )
          .map((r) => [r.channel_id, r.n]),
      );
    const unreadInGroup = (g: any, contactId: string) => [...unreadByChannel(g, contactId).values()].reduce((a, b) => a + b, 0);

    // --- portal hooks: top bar, start page, login ---------------------------------------------
    app.services.portalHead = [...(app.services.portalHead ?? []), () => HEAD_CSS];
    app.services.portalHeader = [
      ...(app.services.portalHeader ?? []),
      (p: Portal, m: Member) => {
        if (!accessibleGroups(app, p.locationId, m.contact).length) return '';
        const n = unreadBell(p, m);
        return `<a class="pn-link" href="${cbase(p)}">${I.users}<span>Community</span></a><a class="pn-bell" href="${cbase(p)}/notifications" aria-label="Benachrichtigungen${n ? ` (${n} neu)` : ''}">${I.bell}${n ? `<b>${n > 99 ? '99+' : n}</b>` : ''}</a>`;
      },
    ];
    app.services.portalDashboard = [
      ...(app.services.portalDashboard ?? []),
      (p: Portal, m: Member) => {
        const groups = accessibleGroups(app, p.locationId, m.contact);
        if (!groups.length) return '';
        return `<section class="cm-dash"><h2>${I.users} Community</h2><div class="cm-groups">${groups.map((g) => groupCard(p, m, g)).join('')}</div></section>`;
      },
    ];
    app.services.portalMemberCheck = [
      ...(app.services.portalMemberCheck ?? []),
      (loc: string, cid: string) => {
        const c = getContact(app, loc, cid);
        return !!c && isPortalMember(app, loc, c);
      },
    ];

    const groupCard = (p: Portal, m: Member, g: any) => {
      const members = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id)!.n;
      const unread = db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, m.contact.id) ? unreadInGroup(g, m.contact.id) : 0;
      const cover = g.cover_image ? ` style="background-image:url('${escapeHtml(String(g.cover_image).replace(/['()\\\s<>"]/g, (c) => `%${c.charCodeAt(0).toString(16)}`))}')"` : '';
      return `<a class="cm-group" href="${gHref(p, g)}"><div class="cv"${cover}>${g.cover_image ? '' : escapeHtml(initials(g.name).slice(0, 1))}</div><div class="b"><h3>${escapeHtml(g.name)}${unread ? `<span class="cm-n">${unread} neu</span>` : ''}</h3>${g.description ? `<p class="muted small" style="margin:0">${escapeHtml(excerptOf(stripMarkdown(g.description), 140))}</p>` : ''}<span class="muted small">${I.users} ${members} ${members === 1 ? 'Mitglied' : 'Mitglieder'}</span></div></a>`;
    };

    // --- group page parts -------------------------------------------------------------------------
    const channelsOf = (g: any) => db.all('SELECT * FROM community_channels WHERE group_id = ? ORDER BY position, created_at', g.id);
    const tabs = (p: Portal, m: Member, g: any, on: string) => {
      const evs = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_events WHERE group_id = ? AND ends_at >= ?', g.id, new Date().toISOString())!.n;
      const t: [string, string, string][] = [
        ['feed', gHref(p, g), `${I.chat} Community`],
        ['events', `${gHref(p, g)}/events`, `${I.cal} Kalender${evs ? ` <span class="cm-n">${evs}</span>` : ''}`],
        ['members', `${gHref(p, g)}/members`, `${I.users} Mitglieder`],
        ['leaderboard', `${gHref(p, g)}/leaderboard`, `${I.trophy} Rangliste`],
        ...ui.tabs.flatMap((fn) => fn(p, m, g).map((x): [string, string, string] => [x.key, x.href, x.label])),
      ];
      return `<nav class="cm-tabs">${t.map(([k, href, label]) => `<a href="${href}" class="${k === on ? 'on' : ''}">${label}</a>`).join('')}</nav>`;
    };
    const head = (p: Portal, g: any) => {
      const members = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id)!.n;
      const cover = g.cover_image ? ` style="background-image:url('${escapeHtml(String(g.cover_image).replace(/['()\\\s<>"]/g, (c) => `%${c.charCodeAt(0).toString(16)}`))}')"` : '';
      return `<div class="cm-head"><div class="cm-cover"${cover}>${g.cover_image ? '' : escapeHtml(initials(g.name).slice(0, 1))}</div><div><h1>${escapeHtml(g.name)}</h1><div class="cm-stats"><span>${I.users} ${members} ${members === 1 ? 'Mitglied' : 'Mitglieder'}</span><a class="cm-link" href="${cbase(p)}">Alle Gruppen</a></div></div></div>`;
    };
    const meCard = (p: Portal, m: Member, g: any) => {
      const s = groupSettings(g);
      const pts = memberPoints(app, g.id, m.contact.id);
      const lvl = levelFor(pts, s.levels);
      const nxt = nextLevel(pts, s.levels);
      const cur = s.levels[lvl - 1]?.points ?? 0;
      const pct = nxt ? Math.round(((pts - cur) / Math.max(1, nxt.missing + pts - cur)) * 100) : 100;
      const pr = ensureProfile(app, p.locationId, m.contact);
      return `<div class="cm-box"><div class="cm-me">${avatar(p, pr.display_name, pr, '', lvl)}<div style="flex:1;min-width:0"><strong>${escapeHtml(s.levels[lvl - 1]?.name ?? `Level ${lvl}`)}</strong><div class="muted small">${pts} Punkte${nxt ? ` · noch ${nxt.missing} bis ${escapeHtml(nxt.name)}` : ' · höchstes Level'}</div><div class="bar"><i style="width:${pct}%"></i></div></div></div><p class="small" style="margin:10px 0 0"><a href="${cbase(p)}/u/${encodeURIComponent(pr.handle)}">Mein Profil</a> · <a href="${cbase(p)}/profile">Bearbeiten</a></p></div>`;
    };
    const upcoming = (p: Portal, g: any, limit = 3) => {
      const evs = db.all('SELECT * FROM community_events WHERE group_id = ? AND ends_at >= ? ORDER BY starts_at LIMIT ?', g.id, new Date().toISOString(), limit);
      if (!evs.length) return '';
      return `<div class="cm-box"><h3>Nächste Termine</h3>${evs
        .map((e) => `<a class="cm-mev" href="${gHref(p, g)}/events#e-${escapeHtml(e.id)}"><span class="d">${escapeHtml(formatInTz(e.starts_at, tz(p), { weekday: undefined, day: '2-digit', month: undefined, year: undefined, hour: undefined, minute: undefined }))}<small>${escapeHtml(formatInTz(e.starts_at, tz(p), { weekday: undefined, day: undefined, month: 'short', year: undefined, hour: undefined, minute: undefined }))}</small></span><span><strong>${escapeHtml(e.title)}</strong><br><span class="muted small">${escapeHtml(formatInTz(e.starts_at, tz(p), { weekday: 'short', day: undefined, month: undefined, year: undefined }))} Uhr</span></span></a>`)
        .join('')}</div>`;
    };

    const roleIn = (g: any, contactId: string) => roleOf(app, g.id, contactId);
    /** Channels this member may not open (tier, level …) with the reason. Team roles see everything. */
    const closedFor = (g: any, contactId: string): Map<string, string> => {
      const role = roleIn(g, contactId);
      const out = new Map<string, string>();
      if (CAN.moderate(role)) return out;
      for (const fn of ui.closedChannels) for (const [cid, why] of fn(g, contactId, role)) out.set(cid, why);
      return out;
    };

    const postCard = (p: Portal, m: Member, g: any, post: any, ch: any, unread: boolean, backTo: string) => {
      const a = authorBits(p, g, post);
      const liked = !!db.get('SELECT 1 FROM community_likes WHERE target_id = ? AND contact_id = ?', post.id, m.contact.id);
      const excerpt = excerptOf(stripMarkdown(post.body), 260);
      const imgs = (post.images ?? []).slice(0, 3);
      const own = post.contact_id === m.contact.id;
      const extras = ui.postExtras.map((h) => h.card?.(p, m, g, post) ?? '').join('');
      return `<article class="cm-post${post.pinned ? ' pinned' : ''}" id="post-${escapeHtml(post.id)}">
<div class="cm-meta">${a.avatar()}<div class="who2">${a.nameHtml}${a.team ? ' <span class="cm-tag">Team</span>' : ''}<br>${when(p, post.created_at)}${ch ? ` · <a class="cm-link" href="${gHref(p, g)}?ch=${encodeURIComponent(ch.slug)}">${escapeHtml(`${ch.emoji ? `${ch.emoji} ` : ''}${ch.name}`)}</a>` : ''}</div><div class="flags">${post.pinned ? `<span class="cm-tag" title="Angeheftet">${I.pin}<span class="tx"> Angeheftet</span></span>` : ''}${unread ? '<span class="cm-tag new">Neu</span>' : ''}</div></div>
<a class="cm-title" href="${postHref(p, g, post.id)}">${escapeHtml(post.title)}</a>
${excerpt ? `<p class="cm-excerpt">${escapeHtml(excerpt)}</p>` : ''}
${extras}
${imgs.length ? `<a class="cm-thumbs" href="${postHref(p, g, post.id)}">${imgs.map((f: string) => `<img src="${fileUrl(p, f)}" alt="" loading="lazy">`).join('')}</a>` : ''}
<div class="cm-acts">${own ? `<span class="cm-btn" title="Gefällt">${I.heart} ${post.like_count}</span>` : `<form method="post" action="${postHref(p, g, post.id)}/like">${tokenInput(m)}<input type="hidden" name="back" value="${escapeHtml(backTo)}#post-${escapeHtml(post.id)}"><button class="cm-btn${liked ? ' on' : ''}" aria-pressed="${liked}" title="Gefällt mir">${I.heart} ${post.like_count}</button></form>`}<a class="cm-btn" href="${postHref(p, g, post.id)}#kommentare">${I.chat} ${post.comment_count} ${post.comment_count === 1 ? 'Kommentar' : 'Kommentare'}</a>${post.comment_count && post.last_activity_at !== post.created_at ? `<span class="sp small">Letzte Aktivität ${relTime(post.last_activity_at)}</span>` : ''}</div>
</article>`;
    };

    const composer = (p: Portal, m: Member, g: any, chans: any[], current: any, opts: { error?: string; draft?: any } = {}) => {
      const role = roleIn(g, m.contact.id);
      const writable = chans.filter((c) => !c.admin_only || CAN.writeAnnouncements(role));
      if (!writable.length) return '';
      const pr = ensureProfile(app, p.locationId, m.contact);
      const d = opts.draft ?? {};
      const sel = d.channel_id || (current && writable.some((c) => c.id === current.id) ? current.id : writable[0].id);
      const extras = ui.postExtras.map((h) => h.fields?.(p, m, g, d) ?? '').join('');
      return `<details class="cm-compose"${opts.error || d.title ? ' open' : ''}><summary>${avatar(p, pr.display_name, pr, 's')}<span class="ph">Schreib etwas …</span></summary>
<form class="cm-form" method="post" action="${gHref(p, g)}/posts">${tokenInput(m)}
${opts.error ? `<div class="cm-err" role="alert">${escapeHtml(opts.error)}</div>` : ''}
<input type="text" name="title" placeholder="Titel" maxlength="200" required value="${escapeHtml(d.title ?? '')}" aria-label="Titel">
<textarea name="body" placeholder="Was möchtest du teilen? **fett**, Listen, Links – @name erwähnt jemanden." maxlength="20000" aria-label="Text">${escapeHtml(d.body ?? '')}</textarea>
<div class="cm-previews"></div>
${extras}
<div class="cm-row"><select name="channel_id" aria-label="Kanal" style="max-width:240px">${writable.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === sel ? ' selected' : ''}>${escapeHtml(`${c.emoji ? `${c.emoji} ` : ''}${c.name}`)}</option>`).join('')}</select>
<label class="cm-pick cm-btn" hidden>${I.image} Bild<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple data-images="${MAX_POST_IMAGES}" data-name="image" hidden></label>
<span class="grow"></span><button class="btn">Veröffentlichen</button></div>
<span class="cm-hint">Bis zu ${MAX_POST_IMAGES} Bilder (PNG, JPG, GIF, WebP, je höchstens 3 MB). Strg+Enter sendet.</span>
</form></details>`;
    };

    const groupPage = (p: Portal, m: Member, g: any, q: URLSearchParams, opts: { error?: string; draft?: any; status?: number } = {}) => {
      const chans = channelsOf(g);
      const closed = closedFor(g, m.contact.id);
      const current = chans.find((c) => c.slug === q.get('ch'));
      const filters = ui.feedFilters.flatMap((fn) => fn(p, m, g));
      const filter = filters.find((f) => f.key === q.get('f') && f.where);
      const page = Math.max(1, Math.floor(Number(q.get('page')) || 1));
      const open = chans.filter((c) => !closed.has(c.id));
      const lockedHere = current && closed.has(current.id);
      const where = `group_id = ? AND status = 'visible'${current ? ' AND channel_id = ?' : ''}${closed.size ? ` AND channel_id NOT IN (${[...closed.keys()].map(() => '?').join(',')})` : ''}${filter ? ` AND (${filter.where})` : ''}`;
      const args = [g.id, ...(current ? [current.id] : []), ...closed.keys()];
      const total = lockedHere ? 0 : db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_posts WHERE ${where}`, ...args)!.n;
      const posts = lockedHere ? [] : parseRows(db.all(`SELECT * FROM community_posts WHERE ${where} ORDER BY pinned DESC, last_activity_at DESC LIMIT ? OFFSET ?`, ...args, PER_PAGE, (page - 1) * PER_PAGE), ['images']);
      const unread = unreadByChannel(g, m.contact.id);
      const since = joinedAt(g, m.contact.id);
      const reads = new Map(posts.length ? db.all<{ post_id: string; read_at: string }>(`SELECT post_id, read_at FROM community_reads WHERE contact_id = ? AND post_id IN (${posts.map(() => '?').join(',')})`, m.contact.id, ...posts.map((x) => x.id)).map((r) => [r.post_id, r.read_at]) : []);
      const byId = new Map(chans.map((c) => [c.id, c]));
      const qs = (extra: Record<string, string>) => new URLSearchParams({ ...(current ? { ch: current.slug } : {}), ...(filter ? { f: filter.key } : {}), ...extra }).toString();
      const here = `${gHref(p, g)}${qs(page > 1 ? { page: String(page) } : {}) ? `?${qs(page > 1 ? { page: String(page) } : {})}` : ''}`;
      const allUnread = [...unread.entries()].filter(([cid]) => !closed.has(cid)).reduce((a, [, n]) => a + n, 0);
      const chLink = (c: any | null, cls: string) => {
        const n = c ? unread.get(c.id) ?? 0 : allUnread;
        const on = (c?.id ?? '') === (current?.id ?? '');
        const lock = c && closed.has(c.id) ? ' <span title="Gesperrt">🔒</span>' : '';
        return `<a class="${cls}${on ? ' on' : ''}" href="${gHref(p, g)}${c ? `?ch=${encodeURIComponent(c.slug)}` : ''}">${cls === 'cm-ch' ? `<span class="e">${escapeHtml(c?.emoji || '#')}</span>` : c?.emoji ? `${escapeHtml(c.emoji)} ` : ''}${escapeHtml(c ? c.name : 'Alle Beiträge')}${lock}${n && !lock ? `<span class="cm-n">${n}</span>` : ''}</a>`;
      };
      let lastCat = '';
      const sideList = [chLink(null, 'cm-ch'), ...chans.map((c) => {
        const cat = c.category && c.category !== lastCat ? `<div class="cm-cat">${escapeHtml(c.category)}</div>` : '';
        lastCat = c.category || lastCat;
        return cat + chLink(c, 'cm-ch');
      })].join('');
      const pager = total > PER_PAGE
        ? `<div class="cm-pager">${page > 1 ? `<a class="btn ghost" href="${gHref(p, g)}?${qs({ page: String(page - 1) })}">← Neuere</a>` : '<span></span>'}${page * PER_PAGE < total ? `<a class="btn ghost" href="${gHref(p, g)}?${qs({ page: String(page + 1) })}">Ältere →</a>` : ''}</div>`
        : '';
      const feed = lockedHere
        ? `<div class="cm-box cm-empty"><p><strong>🔒 Dieser Kanal ist für dich noch gesperrt.</strong></p><p class="small">${escapeHtml(closed.get(current.id) ?? '')}</p></div>`
        : posts.length
          ? posts.map((post) => postCard(p, m, g, post, current ? null : byId.get(post.channel_id), post.contact_id !== m.contact.id && post.last_activity_at > (reads.get(post.id) ?? since), here)).join('')
          : `<div class="cm-box cm-empty"><p><strong>Noch keine Beiträge${current ? ' in diesem Kanal' : filter ? ' mit diesem Filter' : ''}.</strong></p><p class="small">Schreib den ersten – zum Beispiel eine kurze Vorstellung.</p></div>`;
      const about = g.description ? `<div class="cm-box"><h3>Über die Gruppe</h3><div class="prose small">${renderMarkdown(g.description)}</div></div>` : '';
      const chips = `<nav class="cm-chips" aria-label="Kanäle">${[chLink(null, ''), ...chans.map((c) => chLink(c, ''))].join('')}</nav>`;
      const filterBar = filters.length ? `<nav class="cm-filter" aria-label="Beiträge filtern"><a href="${gHref(p, g)}${current ? `?ch=${encodeURIComponent(current.slug)}` : ''}" class="${filter ? '' : 'on'}">Alle</a>${filters.map((f) => `<a href="${gHref(p, g)}?${new URLSearchParams({ ...(current ? { ch: current.slug } : {}), f: f.key })}" class="${filter?.key === f.key ? 'on' : ''}">${f.label}</a>`).join('')}</nav>` : '';
      const top = ui.feedTop.map((fn) => fn(p, m, g, q)).join('');
      const side = ui.side.map((fn) => fn(p, m, g)).join('');
      return frame(
        p,
        m,
        current ? `${current.name} · ${g.name}` : g.name,
        `${head(p, g)}${tabs(p, m, g, 'feed')}
<div class="cm-grid"><section>
${chips}${top}
${current?.description ? `<p class="muted" style="margin:0 0 12px">${escapeHtml(current.description)}</p>` : ''}
${lockedHere ? '' : current?.admin_only && !CAN.writeAnnouncements(roleIn(g, m.contact.id)) ? '<p class="cm-hint" style="margin:0 0 12px">In diesem Kanal schreibt nur das Team.</p>' : composer(p, m, g, open, current && !lockedHere ? current : null, opts)}
${filterBar}${feed}${pager}
</section><aside class="cm-side"><nav class="cm-box cm-chlist" aria-label="Kanäle">${sideList}</nav>${meCard(p, m, g)}${side}${upcoming(p, g)}${about}</aside></div>`,
        opts.status,
      );
    };

    // --- post page --------------------------------------------------------------------------------
    const commentHtml = (p: Portal, m: Member, g: any, post: any, c: any, replies: any[] = []): string => {
      const a = authorBits(p, g, c);
      const own = c.contact_id === m.contact.id;
      const liked = !!db.get('SELECT 1 FROM community_likes WHERE target_id = ? AND contact_id = ?', c.id, m.contact.id);
      const here = `${postHref(p, g, post.id)}#c-${c.id}`;
      const like = own || a.team ? (c.like_count ? `<span class="cm-link">${I.heart} ${c.like_count}</span>` : '') : `<form method="post" action="${gHref(p, g)}/c/${encodeURIComponent(c.id)}/like">${tokenInput(m)}<input type="hidden" name="back" value="${escapeHtml(here)}"><button class="cm-link" style="${liked ? 'color:#e11d48;font-weight:700' : ''}" aria-pressed="${liked}">${I.heart} ${liked ? 'Gefällt dir' : 'Gefällt mir'}${c.like_count ? ` · ${c.like_count}` : ''}</button></form>`;
      const reply = !c.parent_id
        ? `<details><summary class="cm-link">Antworten</summary><form class="cm-mini" method="post" action="${postHref(p, g, post.id)}/comments">${tokenInput(m)}<input type="hidden" name="parent_id" value="${escapeHtml(c.id)}"><textarea class="cm-in" name="body" required maxlength="5000" placeholder="Antwort an ${escapeHtml(a.name)} …" aria-label="Antwort"></textarea><div><button class="btn">Antworten</button></div></form></details>`
        : '';
      const tools = own
        ? `<form method="post" action="${gHref(p, g)}/c/${encodeURIComponent(c.id)}/delete" data-confirm="Kommentar löschen?">${tokenInput(m)}<button class="cm-link">Löschen</button></form>`
        : a.team
          ? ''
          : `<details class="cm-report"><summary class="cm-link">${I.flag} Melden</summary><form class="cm-mini" method="post" action="${gHref(p, g)}/c/${encodeURIComponent(c.id)}/report">${tokenInput(m)}<input class="cm-in" type="text" name="reason" maxlength="500" placeholder="Was stimmt nicht? (optional)" aria-label="Grund"><div><button class="btn ghost">Ans Team melden</button></div></form></details>`;
      const role = c.contact_id ? roleIn(g, c.contact_id) : null;
      const roleTag = role ? `<span class="cm-tag">${role === 'admin' ? 'Admin' : 'Moderator'}</span>` : '';
      const modTools = ui.commentActions.map((fn) => fn(p, m, g, post, c, csrf(m))).join('');
      const self = `<div class="cm-c" id="c-${escapeHtml(c.id)}">${a.avatar('s')}<div class="bd"><div class="bubble"><div class="hd">${a.nameHtml}${a.team ? '<span class="cm-tag">Team</span>' : ''}${roleTag}<span>· ${when(p, c.created_at)}</span></div><div class="prose">${renderText(p, c.body, !a.team)}</div></div><div class="ft">${like}${reply}${tools}${modTools}</div></div></div>`;
      return replies.length ? `${self}<div class="cm-replies">${replies.map((r): string => commentHtml(p, m, g, post, r)).join('')}</div>` : self;
    };

    const postPage = (p: Portal, m: Member, g: any, post: any, opts: { error?: string; notice?: string; draft?: string; status?: number } = {}) => {
      const ch = db.get('SELECT * FROM community_channels WHERE id = ?', post.channel_id);
      const a = authorBits(p, g, post);
      const own = post.contact_id === m.contact.id;
      const liked = !!db.get('SELECT 1 FROM community_likes WHERE target_id = ? AND contact_id = ?', post.id, m.contact.id);
      const following = !!db.get('SELECT 1 FROM community_follows WHERE post_id = ? AND contact_id = ?', post.id, m.contact.id);
      const comments = db.all(`SELECT * FROM community_comments WHERE post_id = ? AND status = 'visible' ORDER BY created_at`, post.id);
      const top = comments.filter((c) => !c.parent_id);
      const kids = (cid: string) => comments.filter((c) => c.parent_id === cid);
      const imgs: string[] = post.images ?? [];
      const here = postHref(p, g, post.id);
      const actions = `<div class="cm-acts">
${own ? `<span class="cm-btn">${I.heart} ${post.like_count}</span>` : `<form method="post" action="${here}/like">${tokenInput(m)}<input type="hidden" name="back" value="${escapeHtml(here)}"><button class="cm-btn${liked ? ' on' : ''}" aria-pressed="${liked}">${I.heart} ${liked ? 'Gefällt dir' : 'Gefällt mir'} · ${post.like_count}</button></form>`}
<form method="post" action="${here}/follow">${tokenInput(m)}<button class="cm-btn f${following ? ' on' : ''}" aria-pressed="${following}" title="Bei neuen Kommentaren benachrichtigt werden">${I.bell} ${following ? 'Du folgst' : 'Folgen'}</button></form>
<span class="sp"></span>
${own ? `<a class="cm-link" href="${here}/edit">Bearbeiten</a><form method="post" action="${here}/delete" data-confirm="Beitrag mit allen Kommentaren löschen?">${tokenInput(m)}<button class="cm-link">Löschen</button></form>` : a.team ? '' : `<details class="cm-report"><summary class="cm-link">${I.flag} Melden</summary><form class="cm-mini" method="post" action="${here}/report">${tokenInput(m)}<input class="cm-in" type="text" name="reason" maxlength="500" placeholder="Was stimmt nicht? (optional)" aria-label="Grund"><div><button class="btn ghost">Ans Team melden</button></div></form></details>`}
${ui.postActions.map((fn) => fn(p, m, g, post, csrf(m))).join('')}
</div>`;
      return frame(
        p,
        m,
        post.title,
        `${opts.notice ? `<div class="cm-ok" role="status">${escapeHtml(opts.notice)}</div>` : ''}
<div class="crumb"><a href="${gHref(p, g)}">${escapeHtml(g.name)}</a>${ch ? ` / <a href="${gHref(p, g)}?ch=${encodeURIComponent(ch.slug)}">${escapeHtml(ch.name)}</a>` : ''}</div>
<div class="cm-grid"><section>
<article class="cm-post cm-full">
<div class="cm-meta">${a.avatar()}<div class="who2">${a.nameHtml}${a.team ? ' <span class="cm-tag">Team</span>' : ''}${post.contact_id && roleIn(g, post.contact_id) ? ` <span class="cm-tag">${roleIn(g, post.contact_id) === 'admin' ? 'Admin' : 'Moderator'}</span>` : ''}<br>${when(p, post.created_at)}${post.edited_at ? ' · bearbeitet' : ''}</div><div class="flags">${post.pinned ? `<span class="cm-tag">${I.pin} Angeheftet</span>` : ''}</div></div>
<h1>${escapeHtml(post.title)}</h1>
${post.body ? `<div class="prose">${renderText(p, post.body, !a.team)}</div>` : ''}
${ui.postExtras.map((h) => h.full?.(p, m, g, post) ?? '').join('')}
${imgs.length ? `<div class="cm-gallery${imgs.length === 1 ? ' one' : ''}">${imgs.map((f) => `<a href="${fileUrl(p, f)}" target="_blank" rel="noopener"><img src="${fileUrl(p, f)}" alt="Bild zum Beitrag" loading="lazy"></a>`).join('')}</div>` : ''}
${actions}
</article>
<section class="cm-post cm-comments" id="kommentare"><h2>${comments.length} ${comments.length === 1 ? 'Kommentar' : 'Kommentare'}</h2>
<form class="cm-mini" method="post" action="${here}/comments" style="margin-bottom:6px">${tokenInput(m)}
${opts.error ? `<div class="cm-err" role="alert">${escapeHtml(opts.error)}</div>` : ''}
<textarea class="cm-in" name="body" required maxlength="5000" placeholder="Schreib einen Kommentar … (@name erwähnt jemanden)" aria-label="Kommentar">${escapeHtml(opts.draft ?? '')}</textarea><div><button class="btn">Kommentieren</button></div></form>
${top.map((c) => commentHtml(p, m, g, post, c, kids(c.id))).join('')}
</section>
</section><aside class="cm-side">${meCard(p, m, g)}${upcoming(p, g)}</aside></div>`,
        opts.status,
      );
    };

    // --- routes: script, home, groups -----------------------------------------------------------
    router.get('/portal-community.js', 'public', () => {
      const r = text(SCRIPT, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=3600';
      return r;
    });

    router.get('/portal/:p/community', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const groups = accessibleGroups(app, p.locationId, m.contact);
        if (groups.length === 1) return redirect(gHref(p, groups[0]));
        return frame(
          p,
          m,
          'Community',
          `<div class="crumb"><a href="${p.base}">Start</a></div><h1>Community</h1><p class="muted">Tausch dich mit den anderen Mitgliedern aus.</p>
${groups.length ? `<div class="cm-groups" style="margin-top:18px">${groups.map((g) => groupCard(p, m, g)).join('')}</div>` : '<div class="panel empty"><h2>Noch keine Gruppe für dich</h2><p class="muted">Sobald du Zugang zu einer Community-Gruppe hast, erscheint sie hier.</p></div>'}`,
        );
      }),
    );

    router.get('/portal/:p/community/g/:group', 'public', (ctx) => withGroup(ctx, (p, m, g) => groupPage(p, m, g, ctx.query)));

    router.post('/portal/:p/community/g/:group/posts', 'public', (ctx) =>
      withGroup(ctx, (p, m, g) => {
        const b = ctx.body ?? {};
        const ch = db.get('SELECT * FROM community_channels WHERE id = ? AND group_id = ?', String(b.channel_id ?? ''), g.id);
        // The draft keeps everything the form held (the extensions' fields too), so a refused post is not lost.
        const draft = { ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'csrf' && !k.startsWith('image')).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 20000) : v])), title: String(b.title ?? '').slice(0, 200), body: String(b.body ?? '').slice(0, 20000), channel_id: ch?.id };
        if (!ch) return groupPage(p, m, g, new URLSearchParams(), { error: 'Bitte einen Kanal wählen.', draft, status: 400 });
        try {
          if (closedFor(g, m.contact.id).has(ch.id)) throw new HttpError(403, 'Dieser Kanal ist für dich noch gesperrt.');
          const prepared = ui.postExtras.map((h) => h.fromForm?.(ctx, g, m));
          const post = createPost(app, g, ch, { kind: 'member', contact: m.contact }, { title: b.title, body: b.body, images: formAll(ctx, 'image') }, { bypassLock: CAN.writeAnnouncements(roleIn(g, m.contact.id)) });
          ui.postExtras.forEach((h, i) => h.attach?.(post, g, prepared[i], 'member'));
          return redirect(postHref(p, g, post.id), 303);
        } catch (e) {
          const f = fail(e);
          return groupPage(p, m, g, new URLSearchParams({ ch: ch.slug }), { error: f.msg, draft, status: f.status });
        }
      }),
    );

    const withPost = (ctx: Ctx, fn: (p: Portal, m: Member, g: any, post: any) => RawResult | Promise<RawResult>) =>
      withGroup(ctx, (p, m, g) => {
        const post = getPost(app, g.id, ctx.params.post);
        if (!post || post.status !== 'visible' || closedFor(g, m.contact.id).has(post.channel_id)) return kit().notFoundPage(p, m);
        return fn(p, m, g, post);
      });
    const withComment = (ctx: Ctx, fn: (p: Portal, m: Member, g: any, c: any, post: any) => RawResult | Promise<RawResult>) =>
      withGroup(ctx, (p, m, g) => {
        const c = db.get(`SELECT * FROM community_comments WHERE id = ? AND group_id = ? AND status = 'visible'`, ctx.params.comment, g.id);
        const post = c && getPost(app, g.id, c.post_id);
        if (!c || !post || post.status !== 'visible' || closedFor(g, m.contact.id).has(post.channel_id)) return kit().notFoundPage(p, m);
        return fn(p, m, g, c, post);
      });

    router.get('/portal/:p/community/g/:group/p/:post', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => {
        const r = postPage(p, m, g, post, { notice: ctx.query.get('gemeldet') === '1' ? 'Danke! Das Team schaut sich die Meldung an.' : '' });
        markRead(app, m.contact.id, post.id);
        return r;
      }),
    );
    router.post('/portal/:p/community/g/:group/p/:post/comments', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => {
        try {
          const c = addComment(app, g, post, { kind: 'member', contact: m.contact }, { body: ctx.body?.body, parent_id: ctx.body?.parent_id });
          return redirect(`${postHref(p, g, post.id)}#c-${c.id}`, 303);
        } catch (e) {
          const f = fail(e);
          return postPage(p, m, g, post, { error: f.msg, draft: String(ctx.body?.body ?? '').slice(0, 5000), status: f.status });
        }
      }),
    );
    router.post('/portal/:p/community/g/:group/p/:post/like', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => {
        try {
          toggleLike(app, g, 'post', post, m.contact);
        } catch (e) {
          return errorPage(p, m, fail(e).msg, 400);
        }
        return redirect(back(p, ctx.body?.back, postHref(p, g, post.id)), 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/c/:comment/like', 'public', (ctx) =>
      withComment(ctx, (p, m, g, c, post) => {
        try {
          toggleLike(app, g, 'comment', c, m.contact);
        } catch (e) {
          return errorPage(p, m, fail(e).msg, 400);
        }
        return redirect(back(p, ctx.body?.back, `${postHref(p, g, post.id)}#c-${c.id}`), 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/p/:post/follow', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => {
        toggleFollow(app, post.id, m.contact.id);
        return redirect(postHref(p, g, post.id), 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/p/:post/report', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => {
        try {
          const r = report(app, g, 'post', post, m.contact.id, ctx.body?.reason);
          return redirect(r.hidden ? `${gHref(p, g)}` : `${postHref(p, g, post.id)}?gemeldet=1`, 303);
        } catch (e) {
          return errorPage(p, m, fail(e).msg, 400);
        }
      }),
    );
    router.post('/portal/:p/community/g/:group/c/:comment/report', 'public', (ctx) =>
      withComment(ctx, (p, m, g, c, post) => {
        try {
          report(app, g, 'comment', c, m.contact.id, ctx.body?.reason);
        } catch (e) {
          return errorPage(p, m, fail(e).msg, 400);
        }
        return redirect(`${postHref(p, g, post.id)}?gemeldet=1`, 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/p/:post/delete', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => {
        if (post.contact_id !== m.contact.id) return errorPage(p, m, 'Nur eigene Beiträge kannst du löschen.', 403);
        deletePost(app, post);
        return redirect(gHref(p, g), 303);
      }),
    );
    router.post('/portal/:p/community/g/:group/c/:comment/delete', 'public', (ctx) =>
      withComment(ctx, (p, m, g, c, post) => {
        if (c.contact_id !== m.contact.id) return errorPage(p, m, 'Nur eigene Kommentare kannst du löschen.', 403);
        deleteComment(app, c);
        return redirect(`${postHref(p, g, post.id)}#kommentare`, 303);
      }),
    );
    const editPage = (p: Portal, m: Member, g: any, post: any, error = '', draft?: { title: string; body: string }, status = 200) =>
      frame(
        p,
        m,
        'Beitrag bearbeiten',
        `<div class="crumb"><a href="${gHref(p, g)}">${escapeHtml(g.name)}</a> / <a href="${postHref(p, g, post.id)}">${escapeHtml(post.title)}</a></div><h1>Beitrag bearbeiten</h1>
<div class="cm-compose" style="max-width:760px"><form class="cm-form" method="post" action="${postHref(p, g, post.id)}/edit">${tokenInput(m)}
${error ? `<div class="cm-err" role="alert">${escapeHtml(error)}</div>` : ''}
<label for="t">Titel</label><input id="t" type="text" name="title" maxlength="200" required value="${escapeHtml(draft?.title ?? post.title)}">
<label for="b">Text</label><textarea id="b" name="body" maxlength="20000" rows="10">${escapeHtml(draft?.body ?? post.body)}</textarea>
<div class="cm-row"><a class="btn ghost" href="${postHref(p, g, post.id)}">Abbrechen</a><span class="grow"></span><button class="btn">Speichern</button></div></form></div>`,
        status,
      );
    router.get('/portal/:p/community/g/:group/p/:post/edit', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => (post.contact_id === m.contact.id ? editPage(p, m, g, post) : errorPage(p, m, 'Nur eigene Beiträge kannst du bearbeiten.', 403))),
    );
    router.post('/portal/:p/community/g/:group/p/:post/edit', 'public', (ctx) =>
      withPost(ctx, (p, m, g, post) => {
        if (post.contact_id !== m.contact.id) return errorPage(p, m, 'Nur eigene Beiträge kannst du bearbeiten.', 403);
        try {
          editPost(app, g, post, { title: ctx.body?.title, body: ctx.body?.body }, false);
          return redirect(postHref(p, g, post.id), 303);
        } catch (e) {
          const f = fail(e);
          return editPage(p, m, g, post, f.msg, { title: String(ctx.body?.title ?? ''), body: String(ctx.body?.body ?? '') }, f.status);
        }
      }),
    );

    // --- calendar, members, leaderboard -------------------------------------------------------
    router.get('/portal/:p/community/g/:group/events', 'public', (ctx) =>
      withGroup(ctx, (p, m, g) => {
        const nowIso = new Date().toISOString();
        const next = db.all('SELECT * FROM community_events WHERE group_id = ? AND ends_at >= ? ORDER BY starts_at LIMIT 100', g.id, nowIso);
        const past = db.all('SELECT * FROM community_events WHERE group_id = ? AND ends_at < ? ORDER BY starts_at DESC LIMIT 20', g.id, nowIso);
        const ev = (e: any) => {
          const live = e.starts_at <= nowIso && e.ends_at >= nowIso;
          const day = formatInTz(e.starts_at, tz(p), { weekday: undefined, day: 'numeric', month: undefined, year: undefined, hour: undefined, minute: undefined });
          const mon = formatInTz(e.starts_at, tz(p), { weekday: undefined, day: undefined, month: 'short', year: undefined, hour: undefined, minute: undefined });
          const range = `${formatInTz(e.starts_at, tz(p), { weekday: 'long', year: undefined })} – ${formatInTz(e.ends_at, tz(p), { weekday: undefined, day: undefined, month: undefined, year: undefined })} Uhr`;
          return `<div class="cm-ev" id="e-${escapeHtml(e.id)}"><div class="d"><b>${escapeHtml(day)}</b><small>${escapeHtml(mon)}</small></div><div class="bd"><h3>${escapeHtml(e.title)} ${live ? '<span class="cm-tag new">Läuft gerade</span>' : ''}</h3><div class="muted small">${escapeHtml(range)}</div>${e.description ? `<div class="prose small" style="margin-top:6px">${renderMarkdown(e.description)}</div>` : ''}<div class="cm-acts">${e.link && e.ends_at >= nowIso ? `<a class="btn" href="${escapeHtml(e.link)}" target="_blank" rel="noopener noreferrer">Teilnehmen</a>` : ''}<a class="cm-btn" href="${gHref(p, g)}/events/${encodeURIComponent(e.id)}/ics">${I.cal} In meinen Kalender</a></div></div></div>`;
        };
        return frame(
          p,
          m,
          `Kalender · ${g.name}`,
          `${head(p, g)}${tabs(p, m, g, 'events')}<div style="max-width:820px">${next.length ? next.map(ev).join('') : '<div class="cm-box cm-empty"><p><strong>Gerade keine Termine geplant.</strong></p><p class="small">Neue Termine erscheinen hier – und auf Wunsch in deinen Benachrichtigungen.</p></div>'}
${past.length ? `<details style="margin-top:18px"><summary class="muted" style="cursor:pointer">Vergangene Termine (${past.length})</summary><div style="margin-top:12px;opacity:.75">${past.map(ev).join('')}</div></details>` : ''}</div>`,
        );
      }),
    );
    router.get('/portal/:p/community/g/:group/events/:id/ics', 'public', (ctx) =>
      withGroup(ctx, (p, m, g) => {
        const e = db.get('SELECT * FROM community_events WHERE id = ? AND group_id = ?', ctx.params.id, g.id);
        if (!e) return kit().notFoundPage(p, m);
        const r = text(icsFeed(g.name, [{ id: e.id, start_at: e.starts_at, end_at: e.ends_at, title: e.title, description: [e.description, e.link].filter(Boolean).join('\n\n') }]), 'text/calendar; charset=utf-8');
        r.headers['content-disposition'] = 'attachment; filename="termin.ics"';
        return r;
      }),
    );

    router.get('/portal/:p/community/g/:group/members', 'public', (ctx) =>
      withGroup(ctx, (p, m, g) => {
        const ext = extOf(app, g.id);
        const s = groupSettings(g);
        const q = String(ctx.query.get('q') ?? '').slice(0, 60);
        const minLevel = Math.min(Math.max(Math.floor(Number(ctx.query.get('level')) || 1), 1), s.levels.length);
        const sort = ['active', 'points', 'new'].includes(String(ctx.query.get('sort'))) ? String(ctx.query.get('sort')) : 'active';
        const onlyOnline = ctx.query.get('online') === '1' && ext.online.enabled;
        const view = ctx.query.get('view') === 'map' && ext.map.enabled ? 'map' : 'list';
        if (!ext.directory.enabled && !CAN.moderate(roleIn(g, m.contact.id)))
          return frame(p, m, `Mitglieder · ${g.name}`, `${head(p, g)}${tabs(p, m, g, 'members')}<div class="cm-box cm-empty">Das Mitgliederverzeichnis ist in dieser Gruppe ausgeschaltet.</div>`);
        const all = db.all<any>(
          `SELECT m.contact_id, m.joined_at, m.last_seen_at, pr.display_name, pr.handle, pr.bio, pr.avatar_file_id, pe.headline, pe.city, pe.country, COALESCE(pe.show_on_map, 0) AS show_on_map,
             (SELECT COALESCE(SUM(points), 0) FROM community_points WHERE group_id = m.group_id AND contact_id = m.contact_id) AS points
           FROM community_members m JOIN community_profiles pr ON pr.location_id = m.location_id AND pr.contact_id = m.contact_id
           LEFT JOIN community_profile_ext pe ON pe.location_id = m.location_id AND pe.contact_id = m.contact_id
           WHERE m.group_id = ? AND m.banned_at IS NULL${q ? ' AND (pr.display_name LIKE ? OR pr.handle LIKE ? OR pe.headline LIKE ? OR pe.city LIKE ?)' : ''}
           ORDER BY ${sort === 'points' ? 'points DESC, m.joined_at' : sort === 'new' ? 'm.joined_at DESC' : 'm.last_seen_at DESC'} LIMIT 1500`,
          g.id,
          ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : []),
        );
        const online = ext.online.enabled ? onlineIds(app, p.locationId, all.map((r) => r.contact_id)) : new Set<string>();
        const roles = new Map(db.all<{ contact_id: string; role: string }>('SELECT contact_id, role FROM community_roles WHERE group_id = ?', g.id).map((r) => [r.contact_id, r.role]));
        const rows = all.filter((r) => levelFor(r.points, s.levels) >= minLevel && (!onlyOnline || online.has(r.contact_id)));
        const nOnline = ext.online.enabled ? all.filter((r) => online.has(r.contact_id)).length : 0;
        const since = (iso: string) => escapeHtml(formatInTz(iso, tz(p), { weekday: undefined, day: undefined, month: 'long', year: 'numeric', hour: undefined, minute: undefined }));
        const card = (r: any) => {
          const lvl = levelFor(r.points, s.levels);
          const role = roles.get(r.contact_id);
          const dm = ext.dms.enabled && r.contact_id !== m.contact.id ? `<a class="cm-btn" href="${cbase(p)}/messages/${encodeURIComponent(r.handle)}" title="Nachricht schreiben" aria-label="Nachricht an ${escapeHtml(r.display_name)}">${I.chat}</a>` : '';
          return `<div class="cm-mem"><a class="cm-memlink" href="${cbase(p)}/u/${encodeURIComponent(r.handle)}">${avatar(p, r.display_name, r as Profile, '', lvl)}${online.has(r.contact_id) ? '<span class="dot on" title="Gerade online"></span>' : ''}<div class="t"><div><strong>${escapeHtml(r.display_name)}</strong>${role ? ` <span class="cm-tag">${role === 'admin' ? 'Admin' : 'Moderator'}</span>` : ''}</div><div class="muted small">@${escapeHtml(r.handle)} · ${escapeHtml(s.levels[lvl - 1]?.name ?? `Level ${lvl}`)}</div>${r.headline || r.bio ? `<div class="muted small">${escapeHtml(excerptOf(r.headline || r.bio, 60))}</div>` : ''}<div class="muted small">Mitglied seit ${since(r.joined_at)}${r.city ? ` · ${escapeHtml(r.city)}` : ''}</div></div></a>${dm}</div>`;
        };
        const qsOf = (extra: Record<string, string>) => new URLSearchParams({ ...(q ? { q } : {}), ...(minLevel > 1 ? { level: String(minLevel) } : {}), ...(sort !== 'active' ? { sort } : {}), ...(onlyOnline ? { online: '1' } : {}), ...extra }).toString();
        const toolbar = `<form method="get" class="cm-toolbar"><input class="cm-in grow" type="search" name="q" value="${escapeHtml(q)}" placeholder="Name, Stadt oder Thema suchen" aria-label="Mitglied suchen">
<select class="cm-in" name="level" aria-label="Mindestens Level">${s.levels.map((l, i) => `<option value="${i + 1}"${minLevel === i + 1 ? ' selected' : ''}>${i ? `ab ${escapeHtml(l.name)}` : 'Alle Levels'}</option>`).join('')}</select>
<select class="cm-in" name="sort" aria-label="Sortierung"><option value="active"${sort === 'active' ? ' selected' : ''}>Zuletzt aktiv</option><option value="points"${sort === 'points' ? ' selected' : ''}>Meiste Punkte</option><option value="new"${sort === 'new' ? ' selected' : ''}>Neueste</option></select>
${ext.online.enabled ? `<label class="cm-pick"><input type="checkbox" name="online" value="1"${onlyOnline ? ' checked' : ''}> Nur online (${nOnline})</label>` : ''}<input type="hidden" name="view" value="${view}"><button class="btn ghost">Filtern</button></form>`;
        const seg = ext.map.enabled ? `<div class="cm-seg"><a href="?${qsOf({ view: 'list' })}" class="${view === 'list' ? 'on' : ''}">Liste</a><a href="?${qsOf({ view: 'map' })}" class="${view === 'map' ? 'on' : ''}">Karte</a></div>` : '';
        let content = '';
        if (view === 'map') {
          const mapped = rows.filter((r) => r.show_on_map && (r.city || r.country));
          const geo = pointsOf(mapped.map((r) => ({ city: r.city, country: r.country })));
          const inEurope = geo.points.filter((x) => inRegion('europe', x.lat, x.lon)).length;
          const region: Region = ctx.query.get('region') === 'world' ? 'world' : ctx.query.get('region') === 'europe' ? 'europe' : geo.points.length && inEurope / geo.points.length >= 0.6 ? 'europe' : 'world';
          content = `<div class="cm-box"><div class="cm-row" style="margin-bottom:8px"><strong class="grow">${mapped.length} ${mapped.length === 1 ? 'Mitglied zeigt' : 'Mitglieder zeigen'} ihren Ort</strong><div class="cm-seg" style="margin:0"><a href="?${qsOf({ view: 'map', region: 'europe' })}" class="${region === 'europe' ? 'on' : ''}">Europa</a><a href="?${qsOf({ view: 'map', region: 'world' })}" class="${region === 'world' ? 'on' : ''}">Welt</a></div></div>${mapSvg(region, geo.points)}
<p class="cm-hint" style="margin:8px 0 0">Nur wer in seinem Profil „Auf der Karte zeigen“ gewählt hat, taucht auf – und immer nur mit der Stadt, nie mit der genauen Adresse.</p></div>
${geo.countries.length ? `<div class="cm-box" style="margin-top:12px"><h3>Nach Ländern</h3>${geo.countries.map((c) => `<p style="margin:0 0 6px"><strong>${escapeHtml(c.country)}</strong> · ${c.n}${c.cities.length ? ` <span class="muted small">(${c.cities.map(escapeHtml).join(', ')})</span>` : ''}</p>`).join('')}${geo.unplaced ? `<p class="muted small" style="margin:6px 0 0">${geo.unplaced} weitere Orte sind nicht auf der Karte zu finden.</p>` : ''}</div>` : ''}`;
        } else content = rows.length ? `<div class="cm-members">${rows.slice(0, 300).map(card).join('')}</div>${rows.length > 300 ? `<p class="cm-hint">Die ersten 300 von ${rows.length} – verfeinere die Suche.</p>` : ''}` : '<div class="cm-box cm-empty">Niemanden gefunden.</div>';
        return frame(
          p,
          m,
          `Mitglieder · ${g.name}`,
          `${head(p, g)}${tabs(p, m, g, 'members')}<div class="cm-row" style="margin-bottom:6px"><span class="muted grow">${all.length} ${all.length === 1 ? 'Mitglied' : 'Mitglieder'}${ext.online.enabled ? ` · <span class="dot on"></span> ${nOnline} online` : ''}</span>${seg}</div>${toolbar}${content}`,
        );
      }),
    );

    router.get('/portal/:p/community/g/:group/leaderboard', 'public', (ctx) =>
      withGroup(ctx, (p, m, g) => {
        const monthly = extOf(app, g.id).leaderboard.reset === 'monthly';
        const period = (['week', 'month', 'all', ...(monthly ? ['last'] : [])].includes(String(ctx.query.get('period'))) ? ctx.query.get('period') : 'month') as BoardPeriod;
        const s = groupSettings(g);
        const rows = boardOf(app, g, period, 30);
        const mine = memberPoints(app, g.id, m.contact.id);
        const myLvl = levelFor(mine, s.levels);
        const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id)!.n;
        const atLevel = (i: number) => {
          const all = db.all<{ pts: number }>(`SELECT (SELECT COALESCE(SUM(points), 0) FROM community_points WHERE group_id = m.group_id AND contact_id = m.contact_id) AS pts FROM community_members m WHERE m.group_id = ? AND m.banned_at IS NULL`, g.id);
          return all.filter((r) => levelFor(r.pts, s.levels) === i + 1).length;
        };
        const medal = ['🥇', '🥈', '🥉'];
        const seg = (k: string, l: string) => `<a class="${period === k ? 'on' : ''}" href="${gHref(p, g)}/leaderboard?period=${k}">${l}</a>`;
        const unlock = (lvl: number) => s.level_unlocks.filter((u) => u.level === lvl).map((u) => db.get('SELECT title FROM courses WHERE id = ?', u.course_id)?.title).filter(Boolean);
        return frame(
          p,
          m,
          `Rangliste · ${g.name}`,
          `${head(p, g)}${tabs(p, m, g, 'leaderboard')}
<div class="cm-grid"><section><div class="cm-box">
<div class="cm-seg">${seg('week', '7 Tage')}${seg('month', monthly ? 'Dieser Monat' : '30 Tage')}${monthly ? seg('last', 'Letzter Monat') : ''}${seg('all', 'Gesamt')}</div>
${rows.length ? `<ol class="cm-lb">${rows
            .map((r, i) => {
              const pr = profile(p, r.contact_id);
              const name = pr?.display_name ?? 'Mitglied';
              return `<li class="${r.contact_id === m.contact.id ? 'me' : ''}"><span class="r${i < 3 ? ' top' : ''}">${i < 3 ? medal[i] : i + 1}</span>${avatar(p, name, pr, 's', levelFor(memberPoints(app, g.id, r.contact_id), s.levels))}<a href="${pr ? `${cbase(p)}/u/${encodeURIComponent(pr.handle)}` : '#'}" style="color:inherit;text-decoration:none;font-weight:600">${escapeHtml(name)}</a><span class="p">+${r.points}</span></li>`;
            })
            .join('')}</ol>` : '<p class="cm-empty">In diesem Zeitraum hat noch niemand Punkte gesammelt.</p>'}
<p class="cm-hint" style="margin:12px 0 0">Punkte gibt es für Beiträge (${s.points.post}), Kommentare (${s.points.comment}) und jedes „Gefällt mir“, das du bekommst (${s.points.like}).</p>
</div></section>
<aside class="cm-side">${meCard(p, m, g)}<div class="cm-box"><h3>Levels</h3><div class="cm-lvls">${s.levels
            .map((l, i) => {
              const n = atLevel(i);
              const u = unlock(i + 1);
              return `<div class="${myLvl === i + 1 ? 'on' : ''}"><b>${escapeHtml(l.name)}</b><span class="muted small">ab ${l.points} Punkten · ${total ? Math.round((n / total) * 100) : 0} %</span>${u.length ? `<br><span class="small">🔓 ${escapeHtml(u.join(', '))}</span>` : ''}</div>`;
            })
            .join('')}</div></div></aside></div>`,
        );
      }),
    );

    // --- profiles ----------------------------------------------------------------------------------
    router.get('/portal/:p/community/u/:handle', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const pr = db.get<Profile>('SELECT * FROM community_profiles WHERE location_id = ? AND handle = ?', p.locationId, String(ctx.params.handle).toLowerCase());
        const them = pr && getContact(app, p.locationId, pr.contact_id);
        // Only people who share a group with the viewer can be looked at.
        const mine = accessibleGroups(app, p.locationId, m.contact);
        const shared = them ? mine.filter((g) => db.get('SELECT 1 FROM community_members WHERE group_id = ? AND contact_id = ? AND banned_at IS NULL', g.id, them.id)) : [];
        if (!pr || !them || (!shared.length && them.id !== m.contact.id)) return kit().notFoundPage(p, m);
        const posts = shared.length
          ? db.all(`SELECT * FROM community_posts WHERE contact_id = ? AND status = 'visible' AND group_id IN (${shared.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 30`, them.id, ...shared.map((g) => g.id)).filter((x) => !closedFor(shared.find((g) => g.id === x.group_id), m.contact.id).has(x.channel_id)).slice(0, 10)
          : [];
        const groups = new Map(shared.map((g) => [g.id, g]));
        const self = them.id === m.contact.id;
        const pe = profileExt(app, p.locationId, them.id);
        const joined = db.get<{ at: string }>(`SELECT MIN(joined_at) AS at FROM community_members WHERE contact_id = ? AND group_id IN (${(shared.length ? shared : [{ id: '' }]).map(() => '?').join(',')})`, them.id, ...(shared.length ? shared.map((g) => g.id) : ['']))?.at;
        const roleNames = shared.map((g) => roleIn(g, them.id)).filter(Boolean);
        const canDm = !self && shared.some((g) => extOf(app, g.id).dms.enabled);
        const online = !self && shared.some((g) => extOf(app, g.id).online.enabled) && onlineIds(app, p.locationId, [them.id]).has(them.id);
        const meta = [joined ? `Mitglied seit ${escapeHtml(formatInTz(joined, tz(p), { weekday: undefined, day: undefined, month: 'long', year: 'numeric', hour: undefined, minute: undefined }))}` : '', pe.city || pe.country ? `${escapeHtml([pe.city, pe.country].filter(Boolean).join(', '))}` : ''].filter(Boolean);
        const links = pe.links.length ? `<p class="cm-links">${pe.links.map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="nofollow ugc noopener noreferrer">${escapeHtml(l.label)} ↗</a>`).join('')}</p>` : '';
        const extra = ui.profileView.map((fn) => fn(p, m, shared, them, pr)).join('');
        return frame(
          p,
          m,
          pr.display_name,
          `<div class="cm-prof">${avatar(p, pr.display_name, pr, 'l')}<div><h1>${escapeHtml(pr.display_name)}${roleNames.includes('admin') ? ' <span class="cm-tag">Admin</span>' : roleNames.includes('moderator') ? ' <span class="cm-tag">Moderator</span>' : ''}</h1><div class="muted">@${escapeHtml(pr.handle)}${pe.headline ? ` · ${escapeHtml(pe.headline)}` : ''}${online ? ' · <span class="dot on"></span> online' : ''}</div>${pr.bio ? `<p style="margin:8px 0 0;white-space:pre-line">${escapeHtml(pr.bio)}</p>` : ''}${meta.length ? `<p class="muted small" style="margin:6px 0 0">${meta.join(' · ')}</p>` : ''}${links}<p style="margin:10px 0 0;display:flex;gap:8px;flex-wrap:wrap">${self ? `<a class="btn ghost" href="${cbase(p)}/profile">Profil bearbeiten</a>` : ''}${canDm ? `<a class="btn" href="${cbase(p)}/messages/${encodeURIComponent(pr.handle)}">${I.chat} Nachricht schreiben</a>` : ''}</p></div></div>
${extra}<div class="cm-grid"><section><h2>Beiträge</h2>${posts.length ? posts.map((x) => `<a class="cm-post" style="display:block;text-decoration:none;color:inherit" href="${postHref(p, groups.get(x.group_id), x.id)}"><div class="muted small">${escapeHtml(groups.get(x.group_id)?.name ?? '')} · ${relTime(x.created_at)}</div><strong style="font-size:17px">${escapeHtml(x.title)}</strong><p class="cm-excerpt">${escapeHtml(excerptOf(stripMarkdown(x.body), 160))}</p></a>`).join('') : '<p class="muted">Noch keine Beiträge.</p>'}</section>
<aside class="cm-side"><div class="cm-box"><h3>Gruppen</h3>${shared.map((g) => {
            const pts = memberPoints(app, g.id, them.id);
            const s = groupSettings(g);
            const l = levelFor(pts, s.levels);
            return `<p style="margin:0 0 8px"><a href="${gHref(p, g)}">${escapeHtml(g.name)}</a><br><span class="muted small">${escapeHtml(s.levels[l - 1]?.name ?? `Level ${l}`)} · ${pts} Punkte</span></p>`;
          }).join('') || '<p class="muted small">Noch in keiner Gruppe.</p>'}</div></aside></div>`,
        );
      }),
    );

    const profileForm = (p: Portal, m: Member, opts: { error?: string; notice?: string; status?: number } = {}) => {
      const pr = ensureProfile(app, p.locationId, m.contact);
      return frame(
        p,
        m,
        'Mein Profil',
        `<div class="crumb"><a href="${cbase(p)}">Community</a></div><h1>Mein Profil</h1>
${opts.notice ? `<div class="cm-ok" role="status">${escapeHtml(opts.notice)}</div>` : ''}
<div class="cm-compose" style="max-width:640px"><form class="cm-form" method="post" action="${cbase(p)}/profile">${tokenInput(m)}
${opts.error ? `<div class="cm-err" role="alert">${escapeHtml(opts.error)}</div>` : ''}
<div class="cm-row">${avatar(p, pr.display_name, pr, 'l')}<div class="cm-previews"></div><div style="display:flex;flex-direction:column;gap:8px"><label class="cm-pick cm-btn" hidden>${I.image} Neues Bild<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-images="1" data-name="avatar" hidden></label>${pr.avatar_file_id ? '<label class="small"><input type="checkbox" name="remove_avatar" value="1"> Bild entfernen</label>' : ''}</div></div>
<label for="dn">Anzeigename</label><input id="dn" type="text" name="display_name" maxlength="60" required value="${escapeHtml(pr.display_name)}">
<span class="cm-hint">Andere erwähnen dich mit <strong>@${escapeHtml(pr.handle)}</strong>. Deine E-Mail-Adresse sieht niemand.</span>
<label for="bio">Über mich</label><textarea id="bio" name="bio" maxlength="500" rows="4" placeholder="Ein, zwei Sätze über dich">${escapeHtml(pr.bio)}</textarea>
${ui.profileEdit.map((fn) => fn(p, m)).join('')}
<label class="small" style="font-weight:500;color:var(--text)"><input type="hidden" name="digest" value="0"><input type="checkbox" name="digest" value="1"${pr.digest ? ' checked' : ''}> Tägliche E-Mail mit meinen ungelesenen Benachrichtigungen</label>
<div class="cm-row"><a class="btn ghost" href="${cbase(p)}/u/${encodeURIComponent(pr.handle)}">Ansehen</a><span class="grow"></span><button class="btn">Speichern</button></div>
</form></div>`,
        opts.status,
      );
    };
    router.get('/portal/:p/community/profile', 'public', (ctx) => withMember(ctx, (p, m) => profileForm(p, m)));
    router.post('/portal/:p/community/profile', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const b = ctx.body ?? {};
        try {
          const digest = formAll(ctx, 'digest');
          updateProfile(app, p.locationId, m.contact as Contact, { display_name: b.display_name, bio: b.bio, digest: digest.length ? digest.includes('1') : undefined, avatar: formAll(ctx, 'avatar')[0], remove_avatar: b.remove_avatar === '1' });
          for (const fn of ui.profileSave) fn(p, m, b, (name) => formAll(ctx, name));
          profilesById.clear();
          return profileForm(p, m, { notice: 'Gespeichert.' });
        } catch (e) {
          const f = fail(e);
          return profileForm(p, m, { error: f.msg, status: f.status });
        }
      }),
    );

    // --- notifications ------------------------------------------------------------------------------
    router.get('/portal/:p/community/notifications', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const rows = db.all(
          `SELECT n.*, g.name AS group_name FROM community_notifications n LEFT JOIN community_groups g ON g.id = n.group_id
           WHERE n.location_id = ? AND n.contact_id = ? ORDER BY n.created_at DESC LIMIT 60`,
          p.locationId,
          m.contact.id,
        );
        const unread = rows.filter((r) => !r.read_at).length;
        const icon = (k: string) => ui.notificationIcon.map((fn) => fn(k)).find(Boolean) ?? (k === 'like' ? I.heart : k === 'event' ? I.cal : k === 'level' ? I.trophy : k === 'announcement' ? I.pin : I.chat);
        return frame(
          p,
          m,
          'Benachrichtigungen',
          `<div class="crumb"><a href="${cbase(p)}">Community</a></div><div class="cm-row" style="margin-bottom:14px;max-width:760px"><h1 class="grow" style="margin:0">Benachrichtigungen</h1>${unread ? `<form method="post" action="${cbase(p)}/notifications/read">${tokenInput(m)}<button class="btn ghost">Alle als gelesen markieren</button></form>` : ''}</div>
<div class="cm-box" style="padding:0;max-width:760px;overflow:hidden">${rows.length ? `<ul class="cm-notes">${rows.map((n) => `<li><a class="${n.read_at ? '' : 'un'}" href="${cbase(p)}/notifications/${encodeURIComponent(n.id)}"><span class="ic">${icon(n.kind)}</span><span><strong>${escapeHtml(n.text)}</strong><br><span class="muted small">${n.group_name ? `${escapeHtml(n.group_name)} · ` : ''}${relTime(n.created_at)}</span></span></a></li>`).join('')}</ul>` : '<p class="cm-empty">Noch keine Benachrichtigungen. Wenn jemand auf deine Beiträge antwortet oder dich erwähnt, siehst du es hier.</p>'}</div>
<p class="cm-hint">Die tägliche Zusammenfassung per E-Mail stellst du in deinem <a href="${cbase(p)}/profile">Profil</a> ein.</p>`,
        );
      }),
    );
    router.get('/portal/:p/community/notifications/:id', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const n = db.get('SELECT * FROM community_notifications WHERE id = ? AND location_id = ? AND contact_id = ?', ctx.params.id, p.locationId, m.contact.id);
        if (!n) return redirect(`${cbase(p)}/notifications`);
        db.run('UPDATE community_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?', new Date().toISOString(), n.id);
        const hooked = ui.notificationTarget.map((fn) => fn(p, n)).find(Boolean);
        if (hooked) return redirect(hooked);
        const g = n.group_id && db.get('SELECT slug FROM community_groups WHERE id = ?', n.group_id);
        if (g && n.post_id) return redirect(`${postHref(p, g, n.post_id)}${n.comment_id ? `#c-${n.comment_id}` : ''}`);
        if (g && n.kind === 'event') return redirect(`${gHref(p, g)}/events`);
        if (g && n.kind === 'level') return redirect(`${gHref(p, g)}/leaderboard`);
        return redirect(`${cbase(p)}/notifications`);
      }),
    );
    router.post('/portal/:p/community/notifications/read', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        db.run('UPDATE community_notifications SET read_at = ? WHERE location_id = ? AND contact_id = ? AND read_at IS NULL', new Date().toISOString(), p.locationId, m.contact.id);
        return redirect(`${cbase(p)}/notifications`, 303);
      }),
    );

    // --- what the other community modules reuse ---------------------------------------------------------
    app.services.communityKit = {
      portal: { resolve: (key: string) => kit().resolve(key), memberOf: (ctx: Ctx, p: any) => kit().memberOf(ctx, p) },
      cbase,
      gHref,
      postHref,
      csrf,
      tokenInput,
      when,
      fileUrl,
      avatar,
      profile,
      levelOf,
      renderText,
      frame,
      errorPage,
      withMember,
      withGroup,
      withPost,
      withComment,
      back,
      fail,
      formAll,
      tz,
      icons: I,
      groupHead: head,
      groupTabs: tabs,
      groupsOf: (p: Portal, m: Member) => accessibleGroups(app, p.locationId, m.contact),
      roleOf: (g: any, cid: string) => roleOf(app, g.id, cid),
    } as unknown as CommunityKit;

    // --- images -------------------------------------------------------------------------------------
    /** Avatars for any member of this portal; post images only for members of that group. */
    router.get('/portal/:p/community/files/:id', 'public', (ctx) =>
      withMember(ctx, (p, m) => {
        const f = db.get<{ file: string; mime: string; group_id: string | null; kind: string }>('SELECT * FROM community_files WHERE id = ? AND location_id = ?', ctx.params.id, p.locationId);
        if (!f) return kit().notFoundPage(p, m);
        if (f.kind === 'post') {
          const g = parseJson(db.get('SELECT * FROM community_groups WHERE id = ?', f.group_id), ['access', 'settings']);
          if (!g || groupAccess(app, g, m.contact) !== 'ok') return kit().notFoundPage(p, m);
        }
        return fileResponse(app, f) ?? kit().notFoundPage(p, m);
      }),
    );
  },
};
