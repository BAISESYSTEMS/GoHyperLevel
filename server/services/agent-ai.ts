import { MODEL_RE } from './ai-presets.js';
import { MODES, type Mode } from './agent-safety.js';

/**
 * "KI-Agent mit KI erstellen" (pure), like HighLevel's Agent Studio "Build with AI": a description in plain words becomes the
 * config of a custom agent – checked against the custom-agent schema (modules/agent-custom.ts) and the agent's real tool
 * catalogue. The module (modules/agent-ai.ts) asks the AI with the same ask-check-retry loop as the Funnel & Website AI.
 */

export const KNOWLEDGE = ['agent', 'ai', 'kb', 'docs', 'project'] as const;
const CADENCE = ['daily', 'weekdays', 'weekly', 'monthly'] as const;
const DELIVER = ['notification', 'email', 'task'] as const;

export interface CatalogTool {
  name: string;
  title: string;
  group: string;
  klass: string;
}
export interface AgentDraft {
  name: string;
  emoji: string;
  description: string;
  instructions: string;
  model: string;
  tools: string[];
  knowledge: { sources: string[]; text: string };
  mode: Mode;
  max_steps: number;
  starters: string[];
  web_fetch: boolean;
  schedule: { cadence: string; weekday: number; day: number; time: string; prompt: string; deliver: string } | null;
}

export const RULES = `Du entwirfst einen eigenen KI-Agenten („KI-Mitarbeiter“) für HyperLevel, ein CRM. Antworte ausschließlich mit EINEM JSON-Objekt:
{"name": "≤ 60 Zeichen", "emoji": "ein Emoji", "description": "Rolle in einem Satz", "instructions": "Anweisungen in Du-Form: Aufgabe, Vorgehen, Ton, Grenzen", "model": "", "tools": ["werkzeug_name", …], "knowledge": {"sources": [${KNOWLEDGE.map((k) => `"${k}"`).join(', ')}], "text": "festes Wissen, optional"}, "mode": "read|ask|auto", "max_steps": 1–30, "starters": ["Startfrage", …], "web_fetch": false, "schedule": null oder {"cadence": "${CADENCE.join('|')}", "weekday": 0–6, "day": 1–28, "time": "HH:MM", "prompt": "Auftrag für den Lauf", "deliver": "${DELIVER.join('|')}"}, "summary": "ein Satz", "notes": ["was die Person noch tun muss"]}
- tools: nur Namen aus dem WERKZEUG-KATALOG, nur was der Agent wirklich braucht (meist 4–15). Lesende Werkzeuge reichen für Berichte.
- mode: "read" nur lesen, "ask" fragt vor jeder Änderung (Standard), "auto" nur, wenn der Auftrag es ausdrücklich verlangt. Werkzeuge, die versenden, löschen oder bezahlen, fragen ohnehin nach.
- knowledge.sources: agent = Agent-Wissen, ai = Wissen des KI-Assistenten, kb = Hilfe-Artikel, docs = Dokumente, project = Projektprofil.
- schedule nur, wenn die Beschreibung einen wiederkehrenden Lauf nennt (z. B. „jeden Montag um 8 Uhr“); weekday 0 = Montag.
- model leer lassen (Standard der Verbindung), außer die Beschreibung nennt eine Modell-ID.
- Keine erfundenen Fakten über das Unternehmen; Unbekanntes als [Platzhalter] in den Anweisungen.`;

/** The tool catalogue for the prompt, grouped, one line per tool: `name · title (klass)`. */
export function catalogText(tools: CatalogTool[]): string {
  const groups = new Map<string, CatalogTool[]>();
  for (const t of tools) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  return [...groups.entries()].map(([g, list]) => `## ${g}\n${list.map((t) => `${t.name} · ${t.title} (${t.klass})`).join('\n')}`).join('\n');
}

const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.trim() : '').slice(0, max);

export function checkAgent(raw: any, catalog: Map<string, CatalogTool>): { draft?: AgentDraft; summary: string; notes: string[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { errors: ['Die Antwort war kein JSON-Objekt.'], warnings, summary: '', notes: [] };
  const name = txt(raw.name, 200);
  if (!name) errors.push('„name“ fehlt');
  else if (name.length > 60) errors.push(`„name“ ist ${name.length} Zeichen lang, höchstens 60`);
  const instructions = txt(raw.instructions, 30_000);
  if (instructions.length < 40) errors.push('„instructions“ fehlt oder ist zu kurz – beschreibe Aufgabe, Vorgehen und Grenzen');
  if (instructions.length > 20_000) errors.push('„instructions“ ist zu lang (höchstens 20 000 Zeichen)');
  const toolList = Array.isArray(raw.tools) ? raw.tools.map(String) : null;
  if (!toolList) errors.push('„tools“ muss eine Liste von Werkzeug-Namen sein');
  const unknown = (toolList ?? []).filter((t: string) => !catalog.has(t));
  if (unknown.length) errors.push(`Unbekannte Werkzeuge: ${unknown.slice(0, 10).join(', ')} – nur Namen aus dem WERKZEUG-KATALOG`);
  const tools = [...new Set((toolList ?? []).filter((t: string) => catalog.has(t)))] as string[];
  if (toolList && !tools.length && !unknown.length) errors.push('Mindestens ein Werkzeug wählen');
  if (tools.length > 60) errors.push('Höchstens 60 Werkzeuge – nur was der Agent braucht');
  const mode = (MODES as readonly string[]).includes(raw.mode) ? (raw.mode as Mode) : (errors.push('„mode“ muss read, ask oder auto sein'), 'ask' as Mode);
  if (mode === 'read' && tools.some((t) => catalog.get(t)!.klass !== 'read' && catalog.get(t)!.klass !== 'internal')) warnings.push('Modus „nur lesen“: schreibende Werkzeuge werden blockiert');
  const steps = Number(raw.max_steps ?? 12);
  if (!Number.isInteger(steps) || steps < 1 || steps > 30) errors.push('„max_steps“ muss eine ganze Zahl von 1 bis 30 sein');
  const model = txt(raw.model, 160);
  if (model && !MODEL_RE.test(model)) warnings.push(`Modell „${model.slice(0, 40)}“ ist keine gültige Modell-ID – Standard der Verbindung`);
  const k = raw.knowledge && typeof raw.knowledge === 'object' ? raw.knowledge : {};
  const sources = (Array.isArray(k.sources) ? k.sources.map(String) : []) as string[];
  const badSources = sources.filter((s) => !(KNOWLEDGE as readonly string[]).includes(s));
  if (badSources.length) errors.push(`Unbekannte Wissensquellen: ${badSources.join(', ')} – erlaubt: ${KNOWLEDGE.join(', ')}`);
  let schedule: AgentDraft['schedule'] = null;
  if (raw.schedule) {
    const s = raw.schedule;
    if (!(CADENCE as readonly string[]).includes(s.cadence)) errors.push(`schedule.cadence muss ${CADENCE.join(', ')} sein`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time ?? ''))) errors.push('schedule.time als HH:MM');
    if (txt(s.prompt, 4000).length < 8) errors.push('schedule.prompt fehlt – was soll der Agent bei jedem Lauf tun?');
    if (s.deliver !== undefined && !(DELIVER as readonly string[]).includes(s.deliver)) errors.push(`schedule.deliver muss ${DELIVER.join(', ')} sein`);
    schedule = { cadence: String(s.cadence), weekday: Math.min(6, Math.max(0, Number(s.weekday) || 0)), day: Math.min(28, Math.max(1, Number(s.day) || 1)), time: String(s.time), prompt: txt(s.prompt, 4000), deliver: (DELIVER as readonly string[]).includes(s.deliver) ? s.deliver : 'notification' };
  }
  const draft: AgentDraft = {
    name,
    emoji: txt(raw.emoji, 16) || '🤖',
    description: txt(raw.description, 1000),
    instructions,
    model: model && MODEL_RE.test(model) ? model : '',
    tools,
    knowledge: { sources: [...new Set(sources.filter((s) => (KNOWLEDGE as readonly string[]).includes(s)))], text: txt(k.text, 30_000) },
    mode,
    max_steps: Number.isInteger(steps) ? Math.min(30, Math.max(1, steps)) : 12,
    starters: (Array.isArray(raw.starters) ? raw.starters : []).map((x: unknown) => txt(x, 200)).filter(Boolean).slice(0, 8),
    web_fetch: raw.web_fetch === true,
    schedule,
  };
  return { draft: errors.length ? undefined : draft, summary: txt(raw.summary, 300), notes: (Array.isArray(raw.notes) ? raw.notes : []).map((n: unknown) => txt(n, 240)).filter(Boolean).slice(0, 6), errors, warnings };
}
