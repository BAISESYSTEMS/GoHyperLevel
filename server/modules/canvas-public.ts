import { createHash } from 'node:crypto';
import type { Module } from '../core/app.js';
import { notFound, type Ctx, type RawResult } from '../core/http.js';
import { now, sha256 } from '../core/util.js';
import { renderSvg, esc } from '../services/canvas-render.js';
import { resolveCards, areaAllowed } from '../services/canvas-cards.js';
import { type BoardRow, accessOf, boardElements } from '../services/canvas-store.js';
import { visibleLocations } from '../services/mobile.js';

/**
 * Canvas outside the editor:
 * - public read-only links `/canvas/s/<token>` (unguessable token, only its SHA-256 is looked up,
 *   revocable; CRM cards never show live data there) and their JSON `/api/public/canvas/<token>`
 *   for the page's auto-refresh;
 * - the mobile API `/api/mobile/canvases` and `/api/mobile/canvases/:id/svg` for the Android app
 *   (device token, same rights as the web app).
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** Pan/zoom + auto-refresh of the public page (inline, allowed by its hash in the CSP). */
const VIEWER_JS = `(function(){
var wrap=document.getElementById('wrap'),stage=document.getElementById('stage'),tok=document.body.getAttribute('data-token'),seq=Number(document.body.getAttribute('data-seq'));
var s=1,x=0,y=0,drag=null,pts={};
function svg(){return stage.querySelector('svg');}
function apply(){stage.style.transform='translate('+x+'px,'+y+'px) scale('+s+')';}
function fit(){var g=svg();if(!g)return;var w=Number(g.getAttribute('width')),h=Number(g.getAttribute('height')),W=wrap.clientWidth,H=wrap.clientHeight;s=Math.min(W/w,H/h,2)*0.94;x=(W-w*s)/2;y=(H-h*s)/2;apply();}
function zoom(f,cx,cy){var ns=Math.min(8,Math.max(0.05,s*f));x=cx-(cx-x)*ns/s;y=cy-(cy-y)*ns/s;s=ns;apply();}
wrap.addEventListener('wheel',function(e){e.preventDefault();var r=wrap.getBoundingClientRect();if(e.ctrlKey||e.metaKey||Math.abs(e.deltaY)>=50&&!e.deltaX)zoom(Math.exp(-e.deltaY*0.0015),e.clientX-r.left,e.clientY-r.top);else{x-=e.deltaX;y-=e.deltaY;apply();}},{passive:false});
wrap.addEventListener('pointerdown',function(e){wrap.setPointerCapture(e.pointerId);pts[e.pointerId]={x:e.clientX,y:e.clientY};drag={x:e.clientX,y:e.clientY};});
wrap.addEventListener('pointermove',function(e){if(!pts[e.pointerId])return;var ids=Object.keys(pts);if(ids.length===2){var a=pts[ids[0]],b=pts[ids[1]],d0=Math.hypot(a.x-b.x,a.y-b.y);pts[e.pointerId]={x:e.clientX,y:e.clientY};a=pts[ids[0]];b=pts[ids[1]];var d1=Math.hypot(a.x-b.x,a.y-b.y),r=wrap.getBoundingClientRect();if(d0>0)zoom(d1/d0,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);return;}pts[e.pointerId]={x:e.clientX,y:e.clientY};if(drag){x+=e.clientX-drag.x;y+=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};apply();}});
function up(e){delete pts[e.pointerId];drag=Object.keys(pts).length===1?pts[Object.keys(pts)[0]]:null;}
wrap.addEventListener('pointerup',up);wrap.addEventListener('pointercancel',up);
document.getElementById('zin').onclick=function(){zoom(1.25,wrap.clientWidth/2,wrap.clientHeight/2);};
document.getElementById('zout').onclick=function(){zoom(0.8,wrap.clientWidth/2,wrap.clientHeight/2);};
document.getElementById('zfit').onclick=fit;
window.addEventListener('resize',fit);fit();
setInterval(function(){if(document.hidden)return;fetch('/api/public/canvas/'+tok+'?seq='+seq).then(function(r){return r.ok?r.json():null;}).then(function(d){if(!d){document.getElementById('state').textContent='Link nicht mehr gültig';return;}if(d.unchanged)return;seq=d.seq;stage.innerHTML=d.svg;document.getElementById('state').textContent='aktualisiert';}).catch(function(){});},15000);
})();`;
const VIEWER_HASH = `sha256-${createHash('sha256').update(VIEWER_JS).digest('base64')}`;

function page(title: string, body: string, opts: { token?: string; seq?: number; brand: string }): RawResult {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} – ${esc(opts.brand)}</title>
<style>
:root{--bg:#f4f6fa;--panel:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--panel:#121a2e;--text:#e5e7eb;--muted:#94a3b8;--line:#233049}#stage svg{filter:invert(.93) hue-rotate(180deg)}#stage svg image{filter:invert(.93) hue-rotate(180deg)}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);height:52px;box-sizing:border-box}
header h1{font-size:16px;margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 9px;white-space:nowrap}
#wrap{position:absolute;top:52px;left:0;right:0;bottom:0;overflow:hidden;touch-action:none;cursor:grab}
#stage{transform-origin:0 0;position:absolute;left:0;top:0}
#stage svg{display:block;box-shadow:0 4px 30px rgba(0,0,0,.08);border-radius:6px}
.tools{position:absolute;right:16px;bottom:16px;display:flex;gap:6px}
.tools button{width:38px;height:38px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:18px;cursor:pointer}
.msg{max-width:420px;margin:15vh auto;text-align:center;padding:24px}
</style></head><body${opts.token ? ` data-token="${esc(opts.token)}" data-seq="${opts.seq ?? 0}"` : ''}>${body}${opts.token ? `<script>${VIEWER_JS}</script>` : ''}</body></html>`;
  return {
    __raw: true,
    status: opts.token ? 200 : 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src '${VIEWER_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
    },
    body: html,
  };
}

export const canvasPublicModule: Module = {
  name: 'canvas-public',
  register(app) {
    const { db, router } = app;
    const brand = () => String(app.services.brandName?.() ?? 'HyperLevel');

    /** The share and its board for a token (revoked or unknown → undefined). */
    const shared = (tok: string) => {
      if (!TOKEN_RE.test(tok)) return undefined;
      const s = db.get<{ id: string; board_id: string; location_id: string }>('SELECT id, board_id, location_id FROM canvas_shares WHERE token_hash = ? AND revoked_at IS NULL', sha256(tok));
      const b = s && db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ? AND location_id = ?', s.board_id, s.location_id);
      return s && b ? { share: s, board: b } : undefined;
    };
    const publicSvg = (b: BoardRow) => renderSvg(boardElements(app, b.id), { publicView: true, imageHref: (src) => src, background: '#ffffff', title: b.name, idPrefix: 'pub' }).svg;

    router.get('/canvas/s/:token', 'public', (ctx) => {
      const hit = shared(ctx.params.token);
      if (!hit) return page('Link ungültig', `<div class="msg"><h1>Link ungültig</h1><p>Dieser Link ist abgelaufen oder wurde widerrufen.</p></div>`, { brand: brand() });
      db.run('UPDATE canvas_shares SET views = views + 1, last_used_at = ? WHERE id = ?', now(), hit.share.id);
      const b = hit.board;
      return page(
        b.name,
        `<header><h1>${esc(b.name)}</h1><span class="badge">Nur ansehen</span><span class="badge" id="state">live</span></header><div id="wrap"><div id="stage">${publicSvg(b)}</div><div class="tools"><button id="zout" aria-label="Verkleinern">−</button><button id="zfit" aria-label="Einpassen">⤢</button><button id="zin" aria-label="Vergrößern">+</button></div></div>`,
        { token: ctx.params.token, seq: b.seq, brand: brand() },
      );
    });

    router.get('/api/public/canvas/:token', 'public', (ctx) => {
      const hit = shared(ctx.params.token);
      if (!hit) throw notFound('Link ungültig oder widerrufen');
      const b = hit.board;
      if (String(b.seq) === ctx.query.get('seq')) return { name: b.name, seq: b.seq, unchanged: true };
      return { name: b.name, seq: b.seq, updated_at: b.updated_at, svg: publicSvg(b) };
    });

    // --- mobile API ------------------------------------------------------------------------------------
    const inLocation = (ctx: Ctx, locationId: string): Ctx => ({ ...ctx, locationId });
    const canvasAllowed = (ctx: Ctx, locationId: string) => areaAllowed(app, inLocation(ctx, locationId), '/api/canvas');

    router.get('/api/mobile/canvases', 'user', (ctx) => {
      const out: Record<string, unknown>[] = [];
      for (const l of visibleLocations(app, ctx)) {
        if (!canvasAllowed(ctx, l.id)) continue;
        const lc = inLocation(ctx, l.id);
        for (const b of db.all<BoardRow>('SELECT * FROM canvas_boards WHERE location_id = ? ORDER BY updated_at DESC LIMIT 200', l.id)) {
          const access = accessOf(app, lc, b);
          if (!access) continue;
          out.push({ id: b.id, name: b.name, location_id: l.id, location_name: l.name, access, element_count: b.element_count, updated_at: b.updated_at, updated_by: b.updated_by, svg_url: `/api/mobile/canvases/${b.id}/svg`, web_url: `${app.baseUrl()}/app/canvas/${b.id}?loc=${l.id}` });
        }
      }
      out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return out.slice(0, 300);
    });

    router.get('/api/mobile/canvases/:id/svg', 'user', async (ctx) => {
      const b = db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ?', ctx.params.id);
      // unknown, foreign or not shared with this user: the same "not found"
      if (!b || !visibleLocations(app, ctx).some((l) => l.id === b.location_id) || !canvasAllowed(ctx, b.location_id) || !accessOf(app, inLocation(ctx, b.location_id), b)) throw notFound('Board nicht gefunden');
      const els = boardElements(app, b.id);
      const cards = await resolveCards(app, inLocation(ctx, b.location_id), els.filter((e) => e.type === 'card' && e.card).map((e) => e.card!));
      const theme = ctx.query.get('theme') === 'dark' ? 'dark' : 'light';
      const max = Math.min(4096, Math.max(0, Number(ctx.query.get('max')) || 0)) || undefined;
      const svg = renderSvg(els, { cards, imageHref: (src) => `${app.baseUrl()}${src}`, background: '#ffffff', theme, maxSize: max, title: b.name }).svg;
      return { __raw: true, status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'" }, body: svg };
    });
  },
};
