/**
 * "KI zeichnen lassen": prompts → structured diagrams for the canvas, plus explaining a selection and
 * turning it into tasks. The model answers in a JSON schema (structured output via app.services.aiRun);
 * this file holds the schemas, the prompts and the conversion into canvas elements (layout engine,
 * wireframe builder) – the route lives in modules/canvas-integrations.ts.
 */

import type { CanvasElement } from './canvas-model.js';
import type { GraphSpec, NodeShape } from './canvas-layout.js';
import { FRAME_PRESETS } from './canvas-model.js';

export const DRAW_KINDS = ['auto', 'flowchart', 'mindmap', 'orgchart', 'diagram', 'wireframe'] as const;
export type DrawKind = (typeof DRAW_KINDS)[number];

const COLORS: Record<string, [string, string]> = {
  blue: ['#e7f5ff', '#1971c2'],
  green: ['#ebfbee', '#2f9e44'],
  yellow: ['#fff9db', '#f08c00'],
  red: ['#fff5f5', '#e03131'],
  purple: ['#f3f0ff', '#7048e8'],
  gray: ['#f8f9fa', '#495057'],
  orange: ['#fff4e6', '#e8590c'],
};

export const DRAW_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Kurzer Titel des Diagramms' },
    kind: { type: 'string', enum: ['flowchart', 'mindmap', 'orgchart', 'diagram', 'wireframe'] },
    direction: { type: 'string', enum: ['right', 'down'] },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string', description: 'Kurz, höchstens ~8 Wörter' },
          shape: { type: 'string', enum: ['rect', 'round', 'ellipse', 'diamond', 'sticky', 'pill'] },
          color: { type: 'string', enum: ['blue', 'green', 'yellow', 'red', 'purple', 'gray', 'orange'] },
          group: { type: 'string', description: 'id einer Gruppe oder leer' },
        },
        required: ['id', 'label', 'shape', 'color', 'group'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string', description: 'leer oder sehr kurz (z. B. Ja/Nein)' } },
        required: ['from', 'to', 'label'],
        additionalProperties: false,
      },
    },
    groups: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false },
    },
    screens: {
      type: 'array',
      description: 'Nur für wireframe: Bildschirme von oben nach unten',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          preset: { type: 'string', enum: ['desktop', 'mobile', 'social-square', 'slide'] },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['nav', 'hero', 'heading', 'text', 'button', 'image', 'cards', 'form', 'footer'] },
                text: { type: 'string' },
                items: { type: 'array', items: { type: 'string' } },
              },
              required: ['type', 'text', 'items'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'preset', 'blocks'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'Ein Satz, was gezeichnet wurde' },
  },
  required: ['title', 'kind', 'direction', 'nodes', 'edges', 'groups', 'screens', 'summary'],
  additionalProperties: false,
};

export const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'bullets'],
  additionalProperties: false,
};

export const TASKS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, description: { type: 'string' }, due_in_days: { type: 'integer', description: '0 = heute, -1 = ohne Fälligkeit' } },
        required: ['title', 'description', 'due_in_days'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

export const SYSTEM = `Du bist der Zeichen-Assistent im Canvas (Whiteboard) eines CRM. Du antwortest ausschließlich im vorgegebenen JSON-Schema, auf Deutsch, knapp und konkret.
Regeln:
- Knoten-Beschriftungen kurz (2–8 Wörter), keine Nummerierung, keine Emojis außer sie helfen wirklich.
- flowchart: Start/Ende als ellipse, Entscheidungen als diamond mit ausgehenden Kanten "Ja"/"Nein", Schritte als rect; direction "right" bei bis zu 8 Schritten, sonst "down".
- mindmap: der erste Knoten ist das zentrale Thema, Kanten vom Thema zu Ästen und von Ästen zu Unterpunkten; 4–7 Äste, je 2–4 Unterpunkte; shape egal.
- orgchart: Baum von oben nach unten (direction "down"), Kanten von oben nach unten.
- diagram: Systeme/Beziehungen; nutze groups für Bereiche.
- wireframe: fülle screens (1–3 Bildschirme) mit sinnvollen Blöcken in Lesereihenfolge; nodes/edges dann leer.
- Höchstens 40 Knoten. Kanten nur zwischen existierenden Knoten-ids. Leere Strings statt null.`;

/** The model's diagram → a graph for the layout engine. */
export function drawToGraph(d: any): GraphSpec {
  const nodes = (Array.isArray(d?.nodes) ? d.nodes : []).slice(0, 60).map((n: any) => {
    const [fill, stroke] = COLORS[n?.color] ?? COLORS.blue;
    const shape: NodeShape = ['rect', 'round', 'ellipse', 'diamond', 'sticky', 'pill'].includes(n?.shape) ? n.shape : 'rect';
    return { id: String(n?.id ?? ''), label: String(n?.label ?? '').slice(0, 200), shape, ...(d?.kind === 'mindmap' ? {} : { fill: shape === 'sticky' ? undefined : fill, stroke: shape === 'sticky' ? undefined : stroke }), group: n?.group ? String(n.group) : undefined };
  });
  const ids = new Set(nodes.map((n: any) => n.id));
  const edges = (Array.isArray(d?.edges) ? d.edges : []).filter((e: any) => ids.has(String(e?.from)) && ids.has(String(e?.to))).slice(0, 120).map((e: any) => ({ from: String(e.from), to: String(e.to), label: e.label ? String(e.label).slice(0, 60) : undefined }));
  const kind = d?.kind;
  return {
    nodes,
    edges,
    groups: (Array.isArray(d?.groups) ? d.groups : []).map((g: any) => ({ id: String(g?.id ?? ''), title: String(g?.title ?? '') })).filter((g: any) => g.id),
    layout: kind === 'mindmap' ? 'mindmap' : kind === 'orgchart' ? 'tree' : 'flow',
    direction: kind === 'orgchart' ? 'down' : d?.direction === 'down' ? 'down' : 'right',
    style: kind === 'mindmap' ? 'mindmap' : 'flowchart',
  };
}

/** Wireframe screens → frames with grey blocks (design mode). */
export function wireframeElements(screens: any[], newId: () => string, origin: { x: number; y: number }): CanvasElement[] {
  const out: CanvasElement[] = [];
  const gray = '#e9ecef';
  const ink = '#495057';
  let x = origin.x;
  let z = 0;
  for (const s of (Array.isArray(screens) ? screens : []).slice(0, 4)) {
    const preset = FRAME_PRESETS.find((p) => p.key === s?.preset) ?? FRAME_PRESETS.find((p) => p.key === 'desktop')!;
    const W = preset.w;
    const mobile = W < 600;
    const pad = mobile ? 20 : 80;
    const inner = W - pad * 2;
    const fid = newId();
    const blocks = Array.isArray(s?.blocks) ? s.blocks.slice(0, 14) : [];
    const kids: CanvasElement[] = [];
    let y = origin.y;
    const el = (e: Partial<CanvasElement> & Pick<CanvasElement, 'type' | 'x' | 'y' | 'w' | 'h'>) => kids.push({ id: newId(), frameId: fid, z: ++z, ...e } as CanvasElement);
    for (const b of blocks) {
      const t = String(b?.text ?? '').slice(0, 300);
      const items: string[] = (Array.isArray(b?.items) ? b.items : []).map((i: unknown) => String(i).slice(0, 80)).slice(0, 6);
      switch (b?.type) {
        case 'nav':
          el({ type: 'rect', x, y, w: W, h: 64, fill: '#f8f9fa', stroke: '#dee2e6', strokeWidth: 1 });
          el({ type: 'text', x: x + pad, y: y + 20, w: 200, h: 26, text: t || 'LOGO', fontSize: 20, bold: true, color: ink });
          if (!mobile) items.slice(0, 5).forEach((it, i) => el({ type: 'text', x: x + W - pad - (items.length - i) * 120, y: y + 22, w: 110, h: 22, text: it, fontSize: 15, color: ink }));
          y += 64 + 40;
          break;
        case 'hero': {
          const h = mobile ? 300 : 380;
          el({ type: 'text', x: x + pad, y, w: mobile ? inner : inner * 0.5, h: 120, text: t || 'Überschrift', fontSize: mobile ? 30 : 44, bold: true, color: '#212529' });
          if (items[0]) el({ type: 'text', x: x + pad, y: y + (mobile ? 130 : 150), w: mobile ? inner : inner * 0.48, h: 60, text: items[0], fontSize: 18, color: ink });
          el({ type: 'rect', x: x + pad, y: y + (mobile ? 210 : 240), w: 220, h: 54, radius: 27, fill: '#1971c2', stroke: 'transparent', strokeWidth: 0, text: items[1] || 'Jetzt starten', color: '#ffffff', bold: true, fontSize: 17 });
          if (!mobile) {
            el({ type: 'rect', x: x + pad + inner * 0.56, y, w: inner * 0.44, h: h - 40, radius: 12, fill: gray, stroke: '#ced4da', strokeWidth: 1 });
            el({ type: 'icon', x: x + pad + inner * 0.78 - 28, y: y + (h - 40) / 2 - 28, w: 56, h: 56, icon: 'image', stroke: '#adb5bd' });
          }
          y += h;
          break;
        }
        case 'heading':
          el({ type: 'text', x: x + pad, y, w: inner, h: 44, text: t, fontSize: mobile ? 24 : 32, bold: true, color: '#212529' });
          y += 64;
          break;
        case 'text':
          el({ type: 'text', x: x + pad, y, w: inner, h: 60, text: t, fontSize: 16, color: ink });
          y += 80;
          break;
        case 'button':
          el({ type: 'rect', x: x + pad, y, w: mobile ? inner : 240, h: 54, radius: 10, fill: '#2f9e44', stroke: 'transparent', strokeWidth: 0, text: t || 'Button', color: '#ffffff', bold: true, fontSize: 17 });
          y += 84;
          break;
        case 'image':
          el({ type: 'rect', x: x + pad, y, w: inner, h: mobile ? 200 : 320, radius: 12, fill: gray, stroke: '#ced4da', strokeWidth: 1, text: t, color: ink, fontSize: 14 });
          y += (mobile ? 200 : 320) + 30;
          break;
        case 'cards': {
          const list = items.length ? items : [t || 'Karte', 'Karte', 'Karte'];
          const cols = mobile ? 1 : Math.min(3, list.length);
          const cw = (inner - (cols - 1) * 24) / cols;
          list.forEach((it, i) => {
            const cx = x + pad + (i % cols) * (cw + 24);
            const cy = y + Math.floor(i / cols) * 200;
            el({ type: 'rect', x: cx, y: cy, w: cw, h: 176, radius: 12, fill: '#ffffff', stroke: '#dee2e6', strokeWidth: 1 });
            el({ type: 'icon', x: cx + 20, y: cy + 20, w: 36, h: 36, icon: ['zap', 'shield-check', 'heart', 'star', 'rocket', 'target'][i % 6], stroke: '#1971c2' });
            el({ type: 'text', x: cx + 20, y: cy + 70, w: cw - 40, h: 28, text: it, fontSize: 19, bold: true, color: '#212529' });
            el({ type: 'text', x: cx + 20, y: cy + 104, w: cw - 40, h: 44, text: 'Kurzer Nutzen in einem Satz.', fontSize: 14, color: ink });
          });
          y += Math.ceil(list.length / cols) * 200 + 20;
          break;
        }
        case 'form': {
          const fields = items.length ? items : ['Name', 'E-Mail'];
          if (t) {
            el({ type: 'text', x: x + pad, y, w: inner, h: 36, text: t, fontSize: 22, bold: true, color: '#212529' });
            y += 48;
          }
          for (const f of fields) {
            el({ type: 'rect', x: x + pad, y, w: mobile ? inner : Math.min(inner, 460), h: 50, radius: 8, fill: '#ffffff', stroke: '#ced4da', strokeWidth: 1, text: f, align: 'left', color: '#868e96', fontSize: 15 });
            y += 64;
          }
          el({ type: 'rect', x: x + pad, y, w: mobile ? inner : 220, h: 52, radius: 8, fill: '#1971c2', stroke: 'transparent', strokeWidth: 0, text: 'Absenden', color: '#ffffff', bold: true, fontSize: 16 });
          y += 84;
          break;
        }
        case 'footer':
          el({ type: 'rect', x, y, w: W, h: 90, fill: '#212529', stroke: 'transparent', strokeWidth: 0, text: t || '© Firma · Impressum · Datenschutz', color: '#adb5bd', fontSize: 14 });
          y += 90;
          break;
      }
    }
    const H = Math.max(preset.h, y - origin.y + 40);
    out.push({ id: fid, type: 'frame', x, y: origin.y, w: W, h: mobile ? Math.max(H, preset.h) : H, name: String(s?.name ?? preset.label).slice(0, 120), preset: preset.key, fill: '#ffffff', z: 0 });
    out.push(...kids);
    x += W + 120;
  }
  return out;
}
