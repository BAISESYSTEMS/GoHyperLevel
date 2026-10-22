'use strict';

const { baseUrl, compact } = require('./http');
const { TRIGGERS, FILTER_FIELDS } = require('./definitions');

/** One REST-hook trigger: Zapier subscribes its target URL, HyperLevel POSTs every matching event. */
const hookTrigger = (t) => ({
  key: t.key,
  noun: t.noun,
  display: { label: t.label, description: t.description },
  operation: {
    type: 'hook',
    inputFields: t.filters.map((f) => ({ ...FILTER_FIELDS[f], required: false })),
    performSubscribe: async (z, bundle) => {
      const filters = compact(Object.fromEntries(t.filters.map((f) => [f, bundle.inputData[f]])));
      const response = await z.request({
        url: `${baseUrl(bundle)}/api/hooks`,
        method: 'POST',
        body: { target_url: bundle.targetUrl, event: t.event, source: 'zapier', label: `Zapier: ${t.label}`, filters },
      });
      return response.data;
    },
    performUnsubscribe: async (z, bundle) => {
      const id = bundle.subscribeData && bundle.subscribeData.id;
      if (!id) return {};
      const response = await z.request({ url: `${baseUrl(bundle)}/api/hooks/${encodeURIComponent(id)}`, method: 'DELETE', skipThrowForStatus: true });
      // Already gone on our side is fine for Zapier.
      return response.status === 404 ? {} : response.data;
    },
    perform: (z, bundle) => [bundle.cleanedRequest],
    performList: async (z, bundle) => {
      const response = await z.request({ url: `${baseUrl(bundle)}/api/hooks/triggers/${encodeURIComponent(t.event)}/sample` });
      return response.data;
    },
    sample: t.sample,
  },
});

/** Hidden polling triggers that fill dropdowns (pipelines, stages, tags …). */
const listTrigger = (key, noun, path, map) => ({
  key,
  noun,
  display: { label: `${noun} (Liste)`, description: `Für Auswahllisten: ${noun}.`, hidden: true },
  operation: {
    perform: async (z, bundle) => {
      const response = await z.request({ url: `${baseUrl(bundle)}${path}` });
      return map(response.data);
    },
    sample: { id: 'x1', name: 'Beispiel' },
  },
});

const LIST_TRIGGERS = [
  listTrigger('pipeline_list', 'Pipeline', '/api/pipelines', (d) => d.map((p) => ({ id: p.id, name: p.name }))),
  listTrigger('stage_list', 'Stufe', '/api/pipelines', (d) => d.flatMap((p) => (p.stages || []).map((s) => ({ id: s.id, name: `${p.name} → ${s.name}` })))),
  listTrigger('tag_list', 'Tag', '/api/tags', (d) => d.map((t) => ({ id: t.name, name: t.name }))),
  listTrigger('form_list', 'Formular', '/api/forms', (d) => d.map((f) => ({ id: f.id, name: f.name }))),
  listTrigger('calendar_list', 'Kalender', '/api/calendars', (d) => d.map((c) => ({ id: c.id, name: c.name }))),
  listTrigger('product_list', 'Produkt', '/api/products', (d) => d.map((p) => ({ id: p.id, name: p.name }))),
];

const HOOK_TRIGGERS = TRIGGERS.map(hookTrigger);

module.exports = { HOOK_TRIGGERS, LIST_TRIGGERS, hookTrigger };
