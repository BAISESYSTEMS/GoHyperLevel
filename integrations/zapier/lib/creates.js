'use strict';

const { baseUrl, compact } = require('./http');
const { ACTIONS, CONTACT_SAMPLE } = require('./definitions');

/** Zapier field from our definition (types: string, text, number, datetime; list/dict/children). */
const field = (f) => {
  const out = { key: f.key, label: f.label, required: !!f.required };
  for (const k of ['helpText', 'dynamic', 'choices', 'list', 'dict', 'default']) if (f[k] !== undefined) out[k] = f[k];
  if (f.type) out.type = f.type;
  if (f.children) out.children = f.children.map(field);
  return out;
};

/** Each action posts to /api/hooks/actions/<key>; the server relays onto the normal REST API. */
const create = (a) => ({
  key: a.key,
  noun: a.noun,
  display: { label: a.label, description: a.description },
  operation: {
    inputFields: a.fields.map(field),
    perform: async (z, bundle) => {
      const response = await z.request({ url: `${baseUrl(bundle)}/api/hooks/actions/${a.key}`, method: 'POST', body: compact(bundle.inputData) });
      return response.data;
    },
    sample: a.noun === 'Kontakt' ? CONTACT_SAMPLE : { id: `${a.key}_1` },
  },
});

module.exports = { CREATES: ACTIONS.map(create), field };
