import type { Module } from '../core/app.js';
import { HttpError, bad, str } from '../core/http.js';
import { id } from '../core/util.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { type CanvasElement, CARD_SIZE, cleanText, elementBox, isId, sceneOutline, unionBox } from '../services/canvas-model.js';
import { type GraphEdge, type GraphNode, buildGraph, graphOfElements } from '../services/canvas-layout.js';
import { type OpIn, applyOps, boardElements, freeSpot, graphOps, liftZ, loadBoard, relayoutOps, type BoardRow } from '../services/canvas-store.js';
import { callRoute } from '../services/route-call.js';
import { DRAW_KINDS, DRAW_SCHEMA, EXPLAIN_SCHEMA, SYSTEM, TASKS_SCHEMA, drawToGraph, wireframeElements } from '../services/canvas-ai.js';

/**
 * Canvas ↔ CRM: sticky notes become tasks or deals (replaced by live cards), workflows are drawn as
 * diagrams and flowcharts become draft workflows, frames become funnel pages, and the AI draws
 * diagrams, mind maps and wireframes from a prompt, explains a selection or turns it into tasks.
 * Every CRM write runs the regular route in-process (callRoute) – same rights, validation and audit log.
 */

const STEP_TEXT: Record<string, string> = {
  send_email: 'E-Mail senden',
  send_sms: 'SMS senden',
  wait: 'Warten',
  if: 'Wenn / Sonst',
  goal: 'Ziel erreicht?',
  add_tag: 'Tag hinzufügen',
  remove_tag: 'Tag entfernen',
  update_field: 'Feld setzen',
  set_dnd: 'Nicht stören',
  create_opportunity: 'Opportunity anlegen',
  move_opportunity: 'Opportunity verschieben',
  set_opportunity_status: 'Opportunity-Status',
  create_task: 'Aufgabe anlegen',
  add_note: 'Notiz hinzufügen',
  notify: 'Team benachrichtigen',
  webhook: 'Webhook aufrufen',
  review_request: 'Bewertung anfragen',
  add_to_workflow: 'In anderen Workflow',
  remove_from_workflow: 'Aus Workflow entfernen',
  social_post: 'Social-Post erstellen',
  ai_text: 'KI-Text erzeugen',
  whatsapp_send: 'WhatsApp senden',
  ticket_create: 'Ticket anlegen',
  end: 'Ende',
};
const TRIGGER_TEXT: Record<string, string> = {
  'contact.created': 'Kontakt angelegt',
  'contact.tag_added': 'Tag hinzugefügt',
  'contact.tag_removed': 'Tag entfernt',
  'contact.updated': 'Kontakt geändert',
  'form.submitted': 'Formular ausgefüllt',
  'appointment.booked': 'Termin gebucht',
  'opportunity.created': 'Opportunity angelegt',
  'opportunity.stage_changed': 'Pipeline-Stufe geändert',
  'message.inbound': 'Nachricht eingegangen',
  'product.purchased': 'Produkt gekauft',
  'ticket.created': 'Ticket angelegt',
};

function stepLabel(s: any): string {
  const base = STEP_TEXT[s.type] ?? String(s.type).replace(/_/g, ' ');
  const detail =
    s.type === 'send_email' ? s.subject : s.type === 'send_sms' ? s.body : s.type === 'wait' ? (s.mode && s.mode !== 'delay' ? s.mode : `${s.amount ?? ''} ${s.unit === 'days' ? 'Tage' : s.unit === 'hours' ? 'Stunden' : 'Minuten'}`) : s.type === 'add_tag' || s.type === 'remove_tag' ? (s.tags ?? []).join(', ') : s.type === 'create_task' ? s.title : s.type === 'notify' ? s.subject : '';
  const d = String(detail ?? '').replace(/\s+/g, ' ').trim();
  return d ? `${base}: ${d.length > 60 ? `${d.slice(0, 59)}…` : d}` : base;
}

/** A workflow (trigger + nested steps) as nodes and edges, top to bottom. */
export function workflowGraph(wf: any): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let n = 0;
  const trig = wf.trigger?.type ?? '';
  const start = `n${n++}`;
  nodes.push({ id: start, label: `Auslöser: ${TRIGGER_TEXT[trig] ?? trig}`, shape: 'pill', fill: '#ebfbee', stroke: '#2f9e44' });
  /** Adds a list of steps after `from` nodes; returns the open ends (node ids + optional edge label). */
  const walk = (steps: any[], from: { id: string; label?: string }[], depth: number): { id: string; label?: string }[] => {
    let ends = from;
    for (const s of steps ?? []) {
      if (nodes.length > 200 || depth > 8) break;
      const nid = `n${n++}`;
      const isIf = s.type === 'if' || s.type === 'goal';
      nodes.push({ id: nid, label: stepLabel(s), shape: isIf ? 'diamond' : s.type === 'end' ? 'ellipse' : s.type === 'wait' ? 'round' : 'rect', ...(s.type === 'end' ? { fill: '#fff5f5', stroke: '#e03131' } : {}) });
      for (const e of ends) edges.push({ from: e.id, to: nid, ...(e.label ? { label: e.label } : {}) });
      if (s.type === 'end') return [];
      if (s.type === 'if') {
        const yes = (s.then ?? []).length ? walk(s.then, [{ id: nid, label: 'Ja' }], depth + 1) : [{ id: nid, label: 'Ja' }];
        const no = (s.else ?? []).length ? walk(s.else, [{ id: nid, label: 'Nein' }], depth + 1) : [{ id: nid, label: 'Nein' }];
        ends = [...yes, ...no];
      } else if (s.type === 'goal') {
        const endId = `n${n++}`;
        nodes.push({ id: endId, label: 'Ziel erreicht → Ende', shape: 'ellipse', fill: '#fff5f5', stroke: '#e03131' });
        edges.push({ from: nid, to: endId, label: 'Ja' });
        ends = [{ id: nid, label: 'Nein' }];
      } else ends = [{ id: nid }];
    }
    return ends;
  };
  walk(wf.steps ?? [], [{ id: start }], 0);
  return { nodes, edges };
}

const has = (t: string, re: RegExp) => re.test(t.toLowerCase());

/** One flowchart node's text → a workflow step (drafts: people check them in the editor). */
function stepFor(text: string): Record<string, any> {
  const t = text.replace(/\s+/g, ' ').trim();
  const num = Number(t.match(/(\d+)/)?.[1] ?? 1) || 1;
  if (has(t, /\b(warte|warten|wait|pause)\b/)) return { type: 'wait', mode: 'delay', amount: num, unit: has(t, /stunde|hour/) ? 'hours' : has(t, /minute/) ? 'minutes' : 'days' };
  if (has(t, /\bsms\b/)) return { type: 'send_sms', body: t };
  if (has(t, /e-?mail|newsletter|mail\b/)) return { type: 'send_email', subject: t, body: `Hallo {{contact.first_name|du}},\n\n${t}` };
  if (has(t, /\btag\b|taggen|markier/)) return { type: 'add_tag', tags: [t.replace(/^.*?tag\s*:?\s*/i, '').slice(0, 40) || 'canvas'] };
  if (has(t, /notiz|note/)) return { type: 'add_note', body: t };
  if (has(t, /benachrichtig|informier|notify/)) return { type: 'notify', subject: t, body: 'Aus einem Canvas-Flussdiagramm' };
  if (has(t, /^(ende|end|fertig|abschluss)$/)) return { type: 'end' };
  return { type: 'create_task', title: t.slice(0, 200), description: 'Aus einem Canvas-Flussdiagramm' };
}

function triggerFor(text: string): { type: string; config: Record<string, unknown> } {
  const t = text.toLowerCase();
  if (/formular|form/.test(t)) return { type: 'form.submitted', config: {} };
  if (/termin|buchung|gebucht|appointment/.test(t)) return { type: 'appointment.booked', config: {} };
  if (/\btag\b/.test(t)) return { type: 'contact.tag_added', config: {} };
  if (/deal|opportunit/.test(t)) return { type: 'opportunity.created', config: {} };
  if (/nachricht|anfrage|message|chat/.test(t)) return { type: 'message.inbound', config: {} };
  if (/kauf|bezahlt|purchase|bestellung/.test(t)) return { type: 'product.purchased', config: {} };
  return { type: 'contact.created', config: {} };
}

/** Flowchart elements → {trigger, steps} (depth-first from the start node; loops are left out). */
export function flowchartToWorkflow(els: CanvasElement[]): { trigger: { type: string; config: Record<string, unknown> }; steps: any[]; notes: string[] } {
  const notes: string[] = [];
  const g = graphOfElements(els);
  const byId = new Map(els.map((e) => [e.id, e]));
  const label = (eid: string) => (byId.get(eid)?.text ?? '').trim();
  const out = new Map<string, { to: string; label: string }[]>();
  const indeg = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (const a of g.arrows) {
    (out.get(a.start!.id) ?? out.set(a.start!.id, []).get(a.start!.id)!).push({ to: a.end!.id, label: (a.text ?? '').toLowerCase() });
    indeg.set(a.end!.id, (indeg.get(a.end!.id) ?? 0) + 1);
  }
  const candidates = g.nodes.filter((n) => !indeg.get(n.id) && out.has(n.id));
  if (!candidates.length) throw bad('Kein Startpunkt gefunden – das Flussdiagramm braucht Formen mit Pfeilen und einen Start ohne eingehenden Pfeil');
  const start = candidates.find((n) => byId.get(n.id)?.type === 'ellipse') ?? candidates[0];
  const seen = new Set<string>([start.id]);
  const chain = (from: string, depth: number): any[] => {
    const steps: any[] = [];
    let cur: string | undefined = from;
    while (cur && steps.length < 100 && depth < 8) {
      const next: { to: string; label: string }[] = out.get(cur) ?? [];
      if (!next.length) break;
      const el = byId.get(cur);
      if (el?.type === 'diamond' && next.length > 1 && cur !== from) break;
      const target = next[0].to;
      if (seen.has(target)) {
        notes.push(`Schleife zu „${label(target) || target}“ ausgelassen`);
        break;
      }
      seen.add(target);
      const t = byId.get(target);
      if (t?.type === 'diamond') {
        const outs = out.get(target) ?? [];
        const yes = outs.find((o) => /^(ja|yes|true|wahr|ok)/.test(o.label)) ?? outs[0];
        const no = outs.find((o) => o !== yes);
        const branch = (o?: { to: string }) => {
          if (!o || seen.has(o.to)) return [];
          seen.add(o.to);
          return [stepFor(label(o.to)), ...chain(o.to, depth + 1)];
        };
        steps.push({ type: 'if', conditions: [], match: 'all', note: label(target), then: branch(yes), else: branch(no) });
        notes.push(`Bedingung „${label(target) || 'Entscheidung'}“ bitte im Workflow festlegen`);
        break;
      }
      steps.push(stepFor(label(target)));
      cur = target;
    }
    return steps;
  };
  const steps = chain(start.id, 0);
  if (!steps.length) throw bad('Das Flussdiagramm hat nach dem Start keine Schritte');
  return { trigger: triggerFor(label(start.id)), steps, notes };
}

/** Funnel blocks from a frame's content (top to bottom). */
function frameBlocks(frame: CanvasElement, els: CanvasElement[], base: string): any[] {
  const kids = els.filter((e) => e.frameId === frame.id && !e.hidden).sort((a, b) => a.y - b.y || a.x - b.x);
  const blocks: any[] = [];
  for (const e of kids) {
    const text = (e.text ?? '').trim();
    if (e.type === 'image' && e.src) blocks.push({ type: 'image', src: `${base}${e.src}`, alt: e.name ?? '' });
    else if (e.type === 'text' && text) {
      const size = e.fontSize ?? 20;
      if (size >= 26 || e.bold) blocks.push({ type: 'heading', text, level: size >= 40 ? 1 : 2 });
      else blocks.push({ type: 'text', text });
    } else if ((e.type === 'rect' || e.type === 'ellipse') && text && e.h <= 100 && e.fill && e.fill !== 'transparent' && e.fill !== '#ffffff') blocks.push({ type: 'button', text, url: '' });
    else if ((e.type === 'sticky' || e.type === 'rect') && text) blocks.push({ type: 'text', text });
  }
  return blocks.length ? blocks : [{ type: 'hero', heading: frame.name ?? 'Seite', subheading: '', align: 'center' }];
}

export const canvasIntegrationsModule: Module = {
  name: 'canvas-integrations',
  register(app) {
    const { router } = app;
    const pick = (els: CanvasElement[], ids: unknown): CanvasElement[] => {
      const want = new Set((Array.isArray(ids) ? ids : []).filter(isId));
      return els.filter((e) => want.has(e.id));
    };
    const besideSelection = (els: CanvasElement[], sel: CanvasElement[]) => {
      const box = unionBox(sel.map(elementBox));
      return box ? { x: Math.round(box.x + box.w + 80), y: Math.round(box.y) } : freeSpot(els);
    };
    const result = (board: BoardRow, extra: Record<string, unknown>) => ({ id: board.id, name: board.name, ...extra });

    // --- sticky notes → tasks / deals (replaced by live cards) ------------------------------------------
    router.post('/api/canvas/:id/convert', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const to = b.to === 'deal' ? 'deal' : b.to === 'task' ? 'task' : '';
      if (!to) throw bad('to: task oder deal');
      const els = boardElements(app, board.id);
      const sel = pick(els, b.element_ids).filter((e) => (e.text ?? '').trim());
      if (!sel.length) throw bad('Bitte Notizen oder Formen mit Text auswählen');
      if (sel.length > 50) throw bad('Höchstens 50 auf einmal');
      if (to === 'deal' && !b.pipeline_id) throw bad('pipeline_id fehlt');
      const created: { element_id: string; kind: string; id: string; title: string }[] = [];
      const list: OpIn[] = [];
      for (const e of sel) {
        const [first, ...rest] = (e.text ?? '').trim().split('\n');
        const title = first.trim().slice(0, 200);
        const description = rest.join('\n').trim().slice(0, 5000);
        let rec: any;
        if (to === 'task') rec = await callRoute(app, ctx, 'POST', '/api/tasks', { title, description: description || `Aus dem Canvas „${board.name}“`, due_at: b.due_at ?? null, contact_id: b.contact_id ?? null });
        else {
          const value = Number((e.text ?? '').match(/(\d[\d.]*)\s*(?:€|eur)/i)?.[1]?.replace(/\./g, '') ?? b.value ?? 0) || 0;
          rec = await callRoute(app, ctx, 'POST', '/api/opportunities', { pipeline_id: b.pipeline_id, stage_id: b.stage_id, name: title, value, contact_id: b.contact_id, contact: b.contact_id ? undefined : b.contact ?? (b.create_contact ? { company: title, first_name: title.slice(0, 80) } : undefined), source: 'Canvas' });
        }
        created.push({ element_id: e.id, kind: to, id: rec.id, title });
        if (b.keep !== true) {
          const [w, h] = CARD_SIZE[to];
          list.push({ op: 'delete', id: e.id }, { op: 'add', element: { type: 'card', card: { kind: to, id: rec.id }, x: e.x, y: e.y, w, h, z: e.z, frameId: e.frameId ?? undefined, name: title } });
        }
      }
      const r = list.length ? applyOps(app, ctx, board, list, { clientId: b.clientId }) : null;
      return result(board, { created, seq: r?.seq ?? board.seq });
    });

    // --- workflow → diagram -----------------------------------------------------------------------------------
    router.post('/api/canvas/:id/workflow-diagram', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const wfId = str(ctx.body?.workflow_id, 'workflow_id', { required: true, max: 64 });
      const wf = await callRoute(app, ctx, 'GET', `/api/workflows/${encodeURIComponent(wfId)}`);
      const els = boardElements(app, board.id);
      const g = workflowGraph(wf);
      const origin = ctx.body?.x !== undefined ? { x: Number(ctx.body.x) || 0, y: Number(ctx.body.y) || 0 } : freeSpot(els);
      const built = buildGraph({ nodes: g.nodes.map((n) => ({ ...n, group: 'wf' })), edges: g.edges, groups: [{ id: 'wf', title: `Workflow: ${wf.name}` }], layout: 'flow', direction: 'down', style: 'flowchart' }, () => id(12), origin);
      const frame = built.elements.find((e) => e.type === 'frame');
      if (frame) {
        frame.link = `/app/workflows/${wf.id}`;
        frame.meta = { workflowId: wf.id };
        frame.y -= 10;
      }
      const r = applyOps(app, ctx, board, liftZ(els, built.elements).map((e) => ({ op: 'add', element: e })), { clientId: ctx.body?.clientId });
      return result(board, { seq: r.seq, workflow: { id: wf.id, name: wf.name, status: wf.status }, frame_id: frame?.id, created: r.elements.length });
    });

    // --- flowchart → draft workflow ------------------------------------------------------------------------------
    router.post('/api/canvas/:id/workflow-draft', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const b = ctx.body ?? {};
      const els = boardElements(app, board.id);
      let scope = Array.isArray(b.element_ids) && b.element_ids.length ? pick(els, b.element_ids) : els;
      if (isId(b.frame_id)) scope = els.filter((e) => e.frameId === b.frame_id);
      const { trigger, steps, notes } = flowchartToWorkflow(scope);
      const name = str(b.name, 'Name', { max: 120 }) || `${board.name} (aus Canvas)`;
      let wf: any;
      try {
        wf = await callRoute(app, ctx, 'POST', '/api/workflows', { name, trigger, steps });
      } catch (e) {
        if (e instanceof HttpError && /Auslöser/.test(e.message)) wf = await callRoute(app, ctx, 'POST', '/api/workflows', { name, trigger: { type: 'contact.tag_added', config: {} }, steps });
        else throw e;
      }
      return result(board, { workflow_id: wf.id, workflow_name: wf.name, status: wf.status, steps: steps.length, notes, url: `/app/workflows/${wf.id}` });
    });

    // --- frames → funnel pages ----------------------------------------------------------------------------------------
    router.post('/api/canvas/:id/funnel-pages', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const els = boardElements(app, board.id);
      let frames = els.filter((e) => e.type === 'frame' && !e.hidden);
      if (Array.isArray(b.frame_ids) && b.frame_ids.length) frames = pick(frames, b.frame_ids);
      if (!frames.length) throw bad('Keine Rahmen gefunden – lege Rahmen (z. B. „Mobile 390“) für jede Seite an');
      if (frames.length > 20) throw bad('Höchstens 20 Seiten auf einmal');
      frames.sort((p, q) => p.x - q.x || p.y - q.y);
      const base = app.baseUrl();
      let funnelId = isId(b.funnel_id) ? b.funnel_id : '';
      let firstPage: string | undefined;
      if (!funnelId) {
        const f = await callRoute(app, ctx, 'POST', '/api/funnels', { name: str(b.funnel_name, 'Name', { max: 120 }) || board.name, template: 'blank' });
        funnelId = f.id;
        firstPage = f.pages?.[0]?.id;
      }
      const pages: { frame_id: string; page_id: string; name: string; url?: string }[] = [];
      for (const [i, fr] of frames.entries()) {
        const blocks = frameBlocks(fr, els, base);
        const name = (fr.name ?? `Seite ${i + 1}`).slice(0, 120);
        let p: any;
        if (i === 0 && firstPage) p = await callRoute(app, ctx, 'PATCH', `/api/funnel-pages/${firstPage}`, { name, blocks });
        else p = await callRoute(app, ctx, 'POST', `/api/funnels/${funnelId}/pages`, { name, blocks });
        pages.push({ frame_id: fr.id, page_id: p.id, name, url: p.url });
      }
      // frames remember their page
      applyOps(app, ctx, board, pages.map((p) => ({ op: 'update', id: p.frame_id, props: { link: `/app/funnels/${funnelId}`, meta: { funnelId, funnelPageId: p.page_id } } })), { force: true });
      return result(board, { funnel_id: funnelId, url: `/app/funnels/${funnelId}`, pages });
    });

    // --- AI: draw, explain, tasks, tidy -------------------------------------------------------------------------------
    router.post('/api/canvas/:id/ai', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const mode = ['draw', 'explain', 'tasks', 'tidy'].includes(b.mode) ? String(b.mode) : 'draw';
      const { board } = loadBoard(app, ctx, ctx.params.id, mode === 'explain' ? 'view' : 'edit');
      const els = boardElements(app, board.id);
      const sel = pick(els, b.ids);
      const userId = ctx.user?.id ?? null;
      const run = async (user: string, schema: Record<string, unknown>, maxTokens = 4000): Promise<any> => {
        if (!app.services.aiRun) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar');
        const r = await app.services.aiRun({ locationId: ctx.locationId, purpose: 'canvas', user, system: [{ text: SYSTEM }], schema, maxTokens, userId, timeoutMs: 120_000 });
        try {
          return JSON.parse(r.text);
        } catch {
          throw new HttpError(502, 'Die KI hat keine gültige Antwort geliefert – bitte noch einmal versuchen');
        }
      };
      if (mode === 'tidy') {
        const scope = sel.length > 1 ? sel : els;
        const g = graphOfElements(scope);
        const indeg = new Map<string, number>();
        for (const e of g.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
        const tree = g.edges.length > 0 && [...indeg.values()].every((v) => v <= 1);
        const kind = b.kind && ['flow', 'tree', 'mindmap', 'radial', 'grid'].includes(b.kind) ? b.kind : !g.edges.length ? 'grid' : tree ? 'tree' : 'flow';
        const r = applyOps(app, ctx, board, relayoutOps(els, sel.length > 1 ? sel.map((e) => e.id) : undefined, { kind, direction: kind === 'flow' ? 'right' : undefined }), { clientId: b.clientId });
        return result(board, { mode, kind, seq: r.seq, changed: r.elements.length, summary: `Layout aufgeräumt (${kind === 'grid' ? 'Raster' : kind === 'tree' ? 'Baum' : 'Fluss'})` });
      }
      if (mode === 'explain' || mode === 'tasks') {
        const scope = sel.length ? sel : els;
        if (!scope.length) throw bad('Das Board ist leer');
        const outline = sceneOutline(scope, board.name).slice(0, 30_000);
        if (mode === 'explain') {
          const d = await run(`Erkläre und fasse diese Auswahl eines Whiteboards zusammen (2–3 Sätze Zusammenfassung, dann 3–6 Stichpunkte mit den wichtigsten Aussagen oder nächsten Schritten).${b.prompt ? `\nHinweis: ${cleanText(b.prompt, 1000)}` : ''}\n\n${outline}`, EXPLAIN_SCHEMA, 1500);
          const text = [String(d.summary ?? ''), ...(Array.isArray(d.bullets) ? d.bullets.map((x: unknown) => `• ${String(x)}`) : [])].filter(Boolean).join('\n');
          let seq = board.seq;
          let created: string[] = [];
          if (b.place !== false && ctx.scope !== 'read') {
            const { access } = loadBoard(app, ctx, board.id);
            if (access !== 'view') {
              const pos = besideSelection(els, scope);
              const r = applyOps(app, ctx, board, [{ op: 'add', element: { type: 'sticky', x: pos.x, y: pos.y, w: 320, h: Math.min(520, 120 + text.split('\n').length * 34), text, fill: '#e5dbff', fontSize: 16, align: 'left', valign: 'top', meta: { ai: 'explain' } } }], { clientId: b.clientId });
              seq = r.seq;
              created = r.elements.map((e) => e.id);
            }
          }
          return result(board, { mode, summary: String(d.summary ?? ''), bullets: d.bullets ?? [], text, seq, created });
        }
        const d = await run(`Leite aus dieser Auswahl eines Whiteboards konkrete Aufgaben ab (höchstens 15, jede mit klarem Titel, kurzer Beschreibung und realistischer Fälligkeit in Tagen).${b.prompt ? `\nHinweis: ${cleanText(b.prompt, 1000)}` : ''}\n\n${outline}`, TASKS_SCHEMA, 2500);
        const tasks: any[] = (Array.isArray(d.tasks) ? d.tasks : []).slice(0, 15);
        const created: { id: string; title: string }[] = [];
        const list: OpIn[] = [];
        const pos = besideSelection(els, scope);
        // "In N days" counts from today in the sub-account's time zone (the UTC date is still yesterday after midnight in Berlin).
        const today = ymdInTz(new Date(), app.location(ctx.locationId)?.timezone || 'Europe/Berlin');
        for (const [i, t] of tasks.entries()) {
          const due = Number(t.due_in_days) >= 0 ? `${addDaysYmd(today, Math.trunc(Number(t.due_in_days)))}T00:00:00.000Z` : null;
          const rec = await callRoute(app, ctx, 'POST', '/api/tasks', { title: String(t.title ?? '').slice(0, 200) || 'Aufgabe', description: String(t.description ?? '').slice(0, 5000), due_at: due });
          created.push({ id: rec.id, title: rec.title });
          const [w, h] = CARD_SIZE.task;
          list.push({ op: 'add', element: { type: 'card', card: { kind: 'task', id: rec.id }, x: pos.x + (i % 3) * (w + 24), y: pos.y + Math.floor(i / 3) * (h + 24), w, h, name: rec.title } });
        }
        const r = list.length ? applyOps(app, ctx, board, list, { clientId: b.clientId }) : null;
        return result(board, { mode, tasks: created, seq: r?.seq ?? board.seq, summary: `${created.length} Aufgaben angelegt` });
      }
      // draw
      const prompt = str(b.prompt, 'Beschreibung', { required: true, max: 4000 });
      const kind = (DRAW_KINDS as readonly string[]).includes(b.kind) ? b.kind : 'auto';
      const context = sel.length ? `\n\nBezug (ausgewählte Elemente):\n${sceneOutline(sel, board.name).slice(0, 8000)}` : '';
      const d = await run(`Zeichne: ${prompt}\nArt: ${kind === 'auto' ? 'wähle die passendste (flowchart, mindmap, orgchart, diagram oder wireframe)' : kind}${context}`, DRAW_SCHEMA, 6000);
      const origin = b.x !== undefined && b.y !== undefined ? { x: Number(b.x) || 0, y: Number(b.y) || 0 } : freeSpot(els);
      let list: OpIn[];
      if (d.kind === 'wireframe' || kind === 'wireframe') {
        const w = wireframeElements(d.screens ?? [], () => id(12), { x: origin.x, y: origin.y + 70 });
        if (!w.length) throw new HttpError(502, 'Die KI hat keinen Bildschirm geliefert – bitte genauer beschreiben');
        list = liftZ(els, w).map((e) => ({ op: 'add', element: e }));
      } else {
        const spec = drawToGraph(d);
        if (!spec.nodes.length) throw new HttpError(502, 'Die KI hat nichts gezeichnet – bitte genauer beschreiben');
        list = graphOps(els, { ...spec, sketch: !!b.sketch }, { x: origin.x, y: origin.y + 70 }).ops;
      }
      if (d.title) list.unshift({ op: 'add', element: { type: 'text', x: origin.x, y: origin.y, text: String(d.title).slice(0, 200), fontSize: 30, bold: true, meta: { ai: 'draw' } } });
      const r = applyOps(app, ctx, board, list, { clientId: b.clientId });
      return result(board, { mode, kind: d.kind, seq: r.seq, created: r.elements.map((e) => e.id), summary: String(d.summary ?? d.title ?? '') });
    });
  },
};
