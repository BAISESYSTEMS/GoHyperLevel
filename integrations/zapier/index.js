'use strict';

/**
 * HyperLevel for Zapier (Zapier Platform CLI app). Instant triggers via REST hooks, actions and
 * searches against a self-hosted HyperLevel. Loads without node_modules (tests), so the platform
 * version falls back to package.json when zapier-platform-core is not installed.
 */

const pkg = require('./package.json');
const authentication = require('./authentication');
const { addAuth, handleErrors } = require('./lib/http');
const { HOOK_TRIGGERS, LIST_TRIGGERS } = require('./lib/hooks');
const { CREATES } = require('./lib/creates');
const { SEARCHES } = require('./lib/searches');

let platformVersion = String(pkg.dependencies['zapier-platform-core']).replace(/^[^\d]*/, '');
try {
  platformVersion = require('zapier-platform-core').version;
} catch (e) {
  /* not installed – fine for tests */
}

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));

module.exports = {
  version: pkg.version,
  platformVersion,
  authentication,
  beforeRequest: [addAuth],
  afterResponse: [handleErrors],
  triggers: byKey([...HOOK_TRIGGERS, ...LIST_TRIGGERS]),
  creates: byKey(CREATES),
  searches: byKey(SEARCHES),
  searchOrCreates: {
    find_contact: {
      key: 'find_contact',
      display: { label: 'Kontakt finden oder anlegen', description: 'Sucht per E-Mail und legt den Kontakt an, wenn es ihn noch nicht gibt.' },
      search: 'find_contact',
      create: 'create_contact',
    },
  },
};
