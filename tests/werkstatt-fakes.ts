import type { Manifest } from '../server/services/werkstatt/manifest.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';

/** The AI's answer for one of the example plugins, in the shape of the Werkstatt's structured output (PLUGIN_SCHEMA). */
export function pluginAnswer(key: string, patch: { ui_html?: string; server_js?: string; manifest?: Partial<Manifest> } = {}) {
  const e = EXAMPLES[key];
  const m = { ...e.manifest, ...(patch.manifest ?? {}) };
  return {
    manifest: {
      name: m.name,
      slug: m.slug,
      icon: m.icon,
      description: m.description,
      category: m.category,
      scopes: m.scopes,
      page_title: m.entries.page?.title ?? '',
      panels: (m.entries.panels ?? []).map((p) => ({ id: p.id, on: p.on, title: p.title, height: p.height ?? 220 })),
      widgets: (m.entries.widgets ?? []).map((w) => ({ id: w.id, title: w.title, size: w.size ?? 'm' })),
      actions: (m.entries.actions ?? []).map((a) => ({ id: a.id, label: a.label, fields: (a.fields ?? []).map((f) => ({ key: f.key, label: f.label })) })),
      jobs: (m.entries.jobs ?? []).map((j) => ({ id: j.id, label: j.label, every: j.every, at: j.at ?? '' })),
      server_mode: m.server?.mode ?? 'none',
    },
    ui_html: patch.ui_html ?? e.ui_html,
    server_js: patch.server_js ?? e.server_js,
    steps_json: e.steps ? JSON.stringify(e.steps) : '',
    changelog: 'Erste Version',
    notes: [],
  };
}

export const usage = { input_tokens: 4000, output_tokens: 2000, cache_read_tokens: 0, cache_write_tokens: 0 };

/** A plan for stage 1: a workflow, a custom object and a tag. */
export const stage1Plan = (tag = '') => ({
  stage: 1,
  title: 'Rückruf-Wünsche verwalten',
  summary: 'Ein Formular, ein eigenes Objekt für Rückrufe und eine Automation, die eine Aufgabe anlegt.',
  rationale: 'Alles lässt sich mit vorhandenen Bausteinen lösen.',
  steps: [
    { block: 'object_type', title: 'Objekt „Rückrufe“', params_json: JSON.stringify({ singular: `Rückruf${tag}`, plural: `Rückrufe${tag}`, properties: [{ key: 'grund', label: 'Grund', type: 'text' }] }) },
    { block: 'workflow', title: 'Aufgabe bei neuer Anfrage', params_json: JSON.stringify({ name: `Rückruf: Aufgabe anlegen${tag}`, trigger: { type: 'form.submitted', config: {} }, steps: [{ type: 'create_task', title: '{{contact.name}} zurückrufen', due_in_days: 1 }] }) },
    { block: 'tag', title: 'Tag „rückruf“', params_json: JSON.stringify({ name: `rückruf${tag}` }) },
  ],
  manifest_json: '',
  notes: ['Die Automation ist ein Entwurf – bitte prüfen und einschalten.'],
});

export const stage2Plan = (key: string) => {
  const e = EXAMPLES[key];
  return { stage: 2, title: e.manifest.name, summary: e.manifest.description, rationale: 'Eine eigene Ansicht ist nötig.', steps: [], manifest_json: JSON.stringify(e.manifest), notes: [] };
};
