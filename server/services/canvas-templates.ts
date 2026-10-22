/**
 * Canvas templates: mind map, flowchart, customer journey, funnel plan, sales process, org chart,
 * SWOT, kanban, wireframe kit and social post layouts. Each one builds plain elements at an origin,
 * so the editor, the API (`template` on create) and agents use the same set.
 *
 * Pure code (also used in the browser).
 */

import { type CanvasElement, STICKY_COLORS } from './canvas-model.js';
import { buildGraph } from './canvas-layout.js';
import { mermaidToElements } from './canvas-mermaid.js';

export interface TemplateInfo {
  key: string;
  name: string;
  description: string;
  category: 'Brainstorming' | 'Prozesse' | 'Strategie' | 'Design';
}

type Build = (newId: () => string, o: { x: number; y: number }) => CanvasElement[];

const T = (id: string, el: Partial<CanvasElement> & Pick<CanvasElement, 'type' | 'x' | 'y' | 'w' | 'h'>): CanvasElement => ({ id, ...el }) as CanvasElement;

function frame(newId: () => string, x: number, y: number, w: number, h: number, name: string, extra: Partial<CanvasElement> = {}): CanvasElement {
  return T(newId(), { type: 'frame', x, y, w, h, name, fill: '#ffffff', z: -1000, ...extra });
}

const sticky = (newId: () => string, x: number, y: number, text: string, color = STICKY_COLORS.gelb, size = 180, frameId?: string): CanvasElement =>
  T(newId(), { type: 'sticky', x, y, w: size, h: size, text, fill: color, fontSize: 18, frameId: frameId ?? undefined });

const heading = (newId: () => string, x: number, y: number, text: string, size = 32, w = 900, frameId?: string): CanvasElement =>
  T(newId(), { type: 'text', x, y, w, h: size * 1.3, text, fontSize: size, bold: true, color: '#1e1e1e', frameId: frameId ?? undefined });

const BUILDERS: Record<string, [TemplateInfo, Build]> = {
  mindmap: [
    { key: 'mindmap', name: 'Mindmap', description: 'Zentrales Thema mit Ästen – zum Sammeln von Ideen.', category: 'Brainstorming' },
    (newId, o) =>
      mermaidToElements(
        `mindmap
  root((Kampagne Q4))
    Zielgruppe
      Bestandskunden
      Neue Leads
    Kanäle
      E-Mail
      Instagram
      Webinar
    Angebot
      Rabatt 15 %
      Bonus-Workshop
    Messen
      Leads
      Umsatz`,
        newId,
        o,
      ).elements,
  ],
  flowchart: [
    { key: 'flowchart', name: 'Flussdiagramm', description: 'Ablauf mit Entscheidungen – Start, Schritte, Ja/Nein.', category: 'Prozesse' },
    (newId, o) =>
      mermaidToElements(
        `flowchart LR
  A([Anfrage geht ein]) --> B[Daten prüfen]
  B --> C{Passt das Budget?}
  C -->|Ja| D[Angebot senden]
  C -->|Nein| E[Nurture-Sequenz]
  D --> F([Termin vereinbart])
  E --> B`,
        newId,
        o,
      ).elements,
  ],
  journey: [
    { key: 'journey', name: 'Customer Journey', description: 'Phasen, Berührungspunkte, Gefühle und Chancen.', category: 'Strategie' },
    (newId, o) => {
      const out: CanvasElement[] = [];
      const phases = ['Aufmerksamkeit', 'Interesse', 'Entscheidung', 'Kauf', 'Bindung'];
      const rows: [string, string][] = [
        ['Berührungspunkte', STICKY_COLORS.blau],
        ['Was denkt/fühlt der Kunde?', STICKY_COLORS.rosa],
        ['Probleme', STICKY_COLORS.orange],
        ['Chancen', STICKY_COLORS.gruen],
      ];
      const f = frame(newId, o.x, o.y, 220 + phases.length * 230 + 40, 140 + rows.length * 220 + 30, 'Customer Journey');
      out.push(f);
      out.push(heading(newId, o.x + 40, o.y + 30, 'Customer Journey', 34, 800, f.id));
      phases.forEach((p, i) => out.push(T(newId(), { type: 'rect', x: o.x + 240 + i * 230, y: o.y + 90, w: 210, h: 44, radius: 22, fill: '#4263eb', stroke: 'transparent', strokeWidth: 0, text: `${i + 1}. ${p}`, color: '#ffffff', bold: true, fontSize: 16, frameId: f.id })));
      rows.forEach(([label, color], r) => {
        const y = o.y + 160 + r * 220;
        out.push(T(newId(), { type: 'text', x: o.x + 40, y: y + 70, w: 180, h: 50, text: label, fontSize: 18, bold: true, color: '#495057', frameId: f.id }));
        phases.forEach((_, i) => out.push({ ...sticky(newId, o.x + 255 + i * 230, y + 10, '', color, 180), frameId: f.id }));
      });
      return out;
    },
  ],
  funnel: [
    { key: 'funnel', name: 'Funnel-Plan', description: 'Seiten des Funnels als Rahmen – daraus lassen sich Funnel-Seiten anlegen.', category: 'Strategie' },
    (newId, o) => {
      const out: CanvasElement[] = [];
      const pages: [string, string, string][] = [
        ['Opt-in', 'Der kostenlose Leitfaden für dein Ziel', 'Jetzt kostenlos sichern'],
        ['Danke', 'Danke! Schau in dein Postfach', 'Zum Webinar anmelden'],
        ['Angebot', 'Das Komplettpaket für 30 % weniger', 'Jetzt kaufen'],
        ['Bestätigung', 'Willkommen an Bord 🎉', 'Zum Mitgliederbereich'],
      ];
      out.push(heading(newId, o.x, o.y - 80, 'Funnel-Plan', 34));
      let prev: CanvasElement | null = null;
      pages.forEach(([name, h, cta], i) => {
        const x = o.x + i * 520;
        const f = frame(newId, x, o.y, 390, 700, name, { preset: 'mobile' });
        out.push(f);
        out.push(T(newId(), { type: 'rect', x: x + 20, y: o.y + 20, w: 350, h: 220, radius: 12, fill: '#e7f5ff', stroke: 'transparent', strokeWidth: 0, frameId: f.id }));
        out.push(T(newId(), { type: 'icon', x: x + 165, y: o.y + 100, w: 60, h: 60, icon: 'image', stroke: '#74c0fc', frameId: f.id }));
        out.push(T(newId(), { type: 'text', x: x + 24, y: o.y + 270, w: 342, h: 80, text: h, fontSize: 28, bold: true, align: 'center', color: '#1e1e1e', frameId: f.id }));
        out.push(T(newId(), { type: 'text', x: x + 24, y: o.y + 380, w: 342, h: 60, text: 'Kurzer Text: Nutzen in einem Satz, ohne Fachbegriffe.', fontSize: 16, align: 'center', color: '#495057', frameId: f.id }));
        out.push(T(newId(), { type: 'rect', x: x + 45, y: o.y + 480, w: 300, h: 56, radius: 28, fill: '#2f9e44', stroke: 'transparent', strokeWidth: 0, text: cta, color: '#ffffff', bold: true, fontSize: 18, frameId: f.id }));
        if (prev) out.push(T(newId(), { type: 'arrow', x: prev.x + prev.w, y: o.y + 350, w: 130, h: 0, points: [[0, 0], [130, 0]], start: { id: prev.id }, end: { id: f.id }, stroke: '#868e96', strokeWidth: 2.5, endHead: 'triangle', z: 10 }));
        prev = f;
      });
      return out;
    },
  ],
  sales: [
    { key: 'sales', name: 'Vertriebsprozess', description: 'Vom Lead bis zum Abschluss mit Verantwortlichen.', category: 'Prozesse' },
    (newId, o) =>
      buildGraph(
        {
          nodes: [
            { id: 'lead', label: 'Neuer Lead\n(Formular, Anruf)', shape: 'pill' },
            { id: 'qual', label: 'Qualifizieren\n(BANT-Fragen)' },
            { id: 'fit', label: 'Passt der Kunde?', shape: 'diamond' },
            { id: 'demo', label: 'Demo / Beratung' },
            { id: 'offer', label: 'Angebot senden' },
            { id: 'follow', label: 'Follow-up nach 3 Tagen' },
            { id: 'won', label: 'Gewonnen 🎉', shape: 'ellipse' },
            { id: 'nurture', label: 'Nurture-Newsletter', shape: 'round' },
          ],
          edges: [
            { from: 'lead', to: 'qual' },
            { from: 'qual', to: 'fit' },
            { from: 'fit', to: 'demo', label: 'Ja' },
            { from: 'fit', to: 'nurture', label: 'Nein', dashed: true },
            { from: 'demo', to: 'offer' },
            { from: 'offer', to: 'follow' },
            { from: 'follow', to: 'won' },
          ],
          layout: 'flow',
          direction: 'right',
        },
        newId,
        o,
      ).elements,
  ],
  org: [
    { key: 'org', name: 'Organigramm', description: 'Team-Struktur von oben nach unten.', category: 'Strategie' },
    (newId, o) =>
      buildGraph(
        {
          nodes: [
            { id: 'ceo', label: 'Geschäftsführung', fill: '#4263eb', stroke: '#364fc7', color: '#ffffff' },
            { id: 'sales', label: 'Vertrieb' },
            { id: 'mkt', label: 'Marketing' },
            { id: 'ops', label: 'Service' },
            { id: 's1', label: 'Account Manager' },
            { id: 's2', label: 'SDR' },
            { id: 'm1', label: 'Content' },
            { id: 'm2', label: 'Performance' },
            { id: 'o1', label: 'Support' },
          ],
          edges: [
            { from: 'ceo', to: 'sales' },
            { from: 'ceo', to: 'mkt' },
            { from: 'ceo', to: 'ops' },
            { from: 'sales', to: 's1' },
            { from: 'sales', to: 's2' },
            { from: 'mkt', to: 'm1' },
            { from: 'mkt', to: 'm2' },
            { from: 'ops', to: 'o1' },
          ].map((e) => ({ ...e, head: 'none' as const })),
          layout: 'tree',
          direction: 'down',
        },
        newId,
        o,
      ).elements,
  ],
  swot: [
    { key: 'swot', name: 'SWOT-Analyse', description: 'Stärken, Schwächen, Chancen, Risiken.', category: 'Strategie' },
    (newId, o) => {
      const out: CanvasElement[] = [];
      const f = frame(newId, o.x, o.y, 1040, 900, 'SWOT-Analyse');
      out.push(f);
      out.push(heading(newId, o.x + 40, o.y + 28, 'SWOT-Analyse', 34, 600, f.id));
      const q: [string, string, string, string][] = [
        ['Stärken', 'Was können wir besonders gut?', '#d3f9d8', '#2f9e44'],
        ['Schwächen', 'Wo verlieren wir Kunden?', '#ffe3e3', '#e03131'],
        ['Chancen', 'Welche Trends helfen uns?', '#dbe4ff', '#4263eb'],
        ['Risiken', 'Was könnte uns gefährlich werden?', '#fff3bf', '#f08c00'],
      ];
      q.forEach(([title, hint, fill, stroke], i) => {
        const x = o.x + 40 + (i % 2) * 490;
        const y = o.y + 100 + Math.floor(i / 2) * 390;
        out.push(T(newId(), { type: 'rect', x, y, w: 470, h: 370, radius: 16, fill, stroke, strokeWidth: 2, frameId: f.id }));
        out.push(T(newId(), { type: 'text', x: x + 24, y: y + 20, w: 420, h: 36, text: title, fontSize: 26, bold: true, color: stroke, frameId: f.id }));
        out.push(T(newId(), { type: 'text', x: x + 24, y: y + 60, w: 420, h: 24, text: hint, fontSize: 15, color: '#495057', frameId: f.id }));
        out.push({ ...sticky(newId, x + 24, y + 110, '', STICKY_COLORS.gelb, 140), frameId: f.id });
      });
      return out;
    },
  ],
  kanban: [
    { key: 'kanban', name: 'Kanban', description: 'Offen, In Arbeit, Erledigt – mit Notizen, die zu Aufgaben werden.', category: 'Prozesse' },
    (newId, o) => {
      const out: CanvasElement[] = [];
      const cols: [string, string][] = [
        ['Offen', '#e9ecef'],
        ['In Arbeit', '#dbe4ff'],
        ['Prüfen', '#fff3bf'],
        ['Erledigt', '#d3f9d8'],
      ];
      out.push(heading(newId, o.x, o.y - 70, 'Kanban-Board', 34));
      cols.forEach(([name, fill], i) => {
        const x = o.x + i * 300;
        out.push(T(newId(), { type: 'rect', x, y: o.y, w: 280, h: 760, radius: 14, fill, stroke: 'transparent', strokeWidth: 0, z: -10 }));
        out.push(T(newId(), { type: 'text', x: x + 20, y: o.y + 18, w: 240, h: 30, text: name, fontSize: 22, bold: true, color: '#343a40' }));
        if (i === 0) {
          out.push(sticky(newId, x + 30, o.y + 70, 'Landingpage-Texte schreiben', STICKY_COLORS.gelb, 220));
          out.push(sticky(newId, x + 30, o.y + 310, 'Newsletter planen', STICKY_COLORS.rosa, 220));
        }
        if (i === 1) out.push(sticky(newId, x + 30, o.y + 70, 'Webinar-Folien', STICKY_COLORS.blau, 220));
      });
      return out;
    },
  ],
  wireframe: [
    { key: 'wireframe', name: 'Wireframe-Kit', description: 'Desktop- und Mobile-Rahmen mit Navigation, Hero, Karten und Formular.', category: 'Design' },
    (newId, o) => {
      const out: CanvasElement[] = [];
      const gray = '#e9ecef';
      const ink = '#495057';
      const block = (x: number, y: number, w: number, h: number, text: string, f: string, extra: Partial<CanvasElement> = {}) =>
        out.push(T(newId(), { type: 'rect', x, y, w, h, radius: 8, fill: gray, stroke: '#ced4da', strokeWidth: 1, text, fontSize: 16, color: ink, frameId: f, ...extra }));
      const d = frame(newId, o.x, o.y, 1440, 1024, 'Desktop – Startseite', { preset: 'desktop' });
      out.push(d);
      block(o.x, o.y, 1440, 72, '', d.id, { radius: 0, fill: '#f8f9fa' });
      out.push(T(newId(), { type: 'text', x: o.x + 48, y: o.y + 22, w: 200, h: 28, text: 'LOGO', fontSize: 22, bold: true, color: ink, frameId: d.id }));
      ['Leistungen', 'Preise', 'Über uns', 'Kontakt'].forEach((n, i) => out.push(T(newId(), { type: 'text', x: o.x + 860 + i * 120, y: o.y + 26, w: 110, h: 22, text: n, fontSize: 16, color: ink, frameId: d.id })));
      out.push(T(newId(), { type: 'text', x: o.x + 120, y: o.y + 180, w: 620, h: 130, text: 'Große Überschrift mit dem wichtigsten Nutzen', fontSize: 48, bold: true, color: '#212529', frameId: d.id }));
      out.push(T(newId(), { type: 'text', x: o.x + 120, y: o.y + 330, w: 560, h: 60, text: 'Ein Satz, der erklärt, für wen das Angebot ist und was sich verbessert.', fontSize: 20, color: ink, frameId: d.id }));
      block(o.x + 120, o.y + 420, 220, 60, 'Jetzt starten', d.id, { fill: '#1971c2', stroke: 'transparent', color: '#ffffff', bold: true, radius: 30 });
      block(o.x + 800, o.y + 150, 520, 380, '', d.id);
      out.push(T(newId(), { type: 'icon', x: o.x + 1030, y: o.y + 310, w: 60, h: 60, icon: 'image', stroke: '#adb5bd', frameId: d.id }));
      [0, 1, 2].forEach((i) => {
        block(o.x + 120 + i * 410, o.y + 620, 380, 300, '', d.id, { fill: '#ffffff' });
        out.push(T(newId(), { type: 'icon', x: o.x + 150 + i * 410, y: o.y + 650, w: 44, h: 44, icon: ['zap', 'shield-check', 'heart'][i], stroke: '#1971c2', frameId: d.id }));
        out.push(T(newId(), { type: 'text', x: o.x + 150 + i * 410, y: o.y + 720, w: 320, h: 30, text: ['Schnell', 'Sicher', 'Persönlich'][i], fontSize: 22, bold: true, color: '#212529', frameId: d.id }));
        out.push(T(newId(), { type: 'text', x: o.x + 150 + i * 410, y: o.y + 760, w: 320, h: 60, text: 'Zwei Zeilen Text zum Vorteil.', fontSize: 16, color: ink, frameId: d.id }));
      });
      const m = frame(newId, o.x + 1540, o.y, 390, 844, 'Mobile – Formular', { preset: 'mobile' });
      out.push(m);
      block(o.x + 1540, o.y, 390, 64, '☰   LOGO', m.id, { radius: 0, fill: '#f8f9fa', align: 'left' });
      out.push(T(newId(), { type: 'text', x: o.x + 1564, y: o.y + 110, w: 342, h: 80, text: 'Kostenloses Erstgespräch', fontSize: 30, bold: true, color: '#212529', frameId: m.id }));
      ['Name', 'E-Mail', 'Telefon'].forEach((n, i) => block(o.x + 1564, o.y + 230 + i * 80, 342, 56, n, m.id, { fill: '#ffffff', align: 'left' }));
      block(o.x + 1564, o.y + 480, 342, 56, 'Absenden', m.id, { fill: '#2f9e44', stroke: 'transparent', color: '#ffffff', bold: true });
      return out;
    },
  ],
  social: [
    { key: 'social', name: 'Social-Post-Layouts', description: 'Quadrat, Hochformat und Querformat – fertig für den Social Planner.', category: 'Design' },
    (newId, o) => {
      const out: CanvasElement[] = [];
      const sizes: [string, number, number, string][] = [
        ['Instagram 1080×1080', 1080, 1080, 'social-square'],
        ['Instagram 1080×1350', 1080, 1350, 'social-portrait'],
        ['LinkedIn/X 1200×675', 1200, 675, 'social-landscape'],
      ];
      let x = o.x;
      sizes.forEach(([name, w, h, preset], i) => {
        const bg = ['#4263eb', '#f76707', '#0c8599'][i];
        const f = frame(newId, x, o.y, w, h, name, { preset, fill: bg });
        out.push(f);
        out.push(T(newId(), { type: 'ellipse', x: x + w - 380, y: o.y - 120, w: 520, h: 520, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, opacity: 0.12, frameId: f.id }));
        out.push(T(newId(), { type: 'text', x: x + 80, y: o.y + 90, w: w - 160, h: 40, text: 'TIPP DER WOCHE', fontSize: 32, bold: true, color: '#ffffff', opacity: 0.8, frameId: f.id }));
        out.push(T(newId(), { type: 'text', x: x + 80, y: o.y + 160, w: w - 200, h: 260, text: '3 Fehler, die dich Kunden kosten', fontSize: h > 800 ? 96 : 76, bold: true, color: '#ffffff', frameId: f.id }));
        out.push(T(newId(), { type: 'rect', x: x + 80, y: o.y + h - 170, w: 360, h: 80, radius: 40, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, text: 'Mehr im Link →', fontSize: 30, bold: true, color: bg, frameId: f.id }));
        x += w + 120;
      });
      return out;
    },
  ],
};

export const TEMPLATES: TemplateInfo[] = Object.values(BUILDERS).map(([info]) => info);

/** Elements of a template at `origin` (top-left), or null for an unknown key. */
export function buildTemplate(key: string, newId: () => string, origin = { x: 0, y: 0 }): CanvasElement[] | null {
  const b = BUILDERS[key];
  if (!b) return null;
  return b[1](newId, origin).map((e, i) => ({ ...e, z: (e.z ?? 0) + i / 1000 }));
}
