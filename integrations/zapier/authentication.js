'use strict';

const { baseUrl } = require('./lib/http');

module.exports = {
  type: 'custom',
  fields: [
    { key: 'base_url', label: 'Adresse deiner HyperLevel-Installation', required: true, type: 'string', helpText: 'z. B. https://crm.example.com – ohne /api am Ende.' },
    { key: 'api_key', label: 'API-Schlüssel', required: true, type: 'password', helpText: 'Einstellungen → API & Webhooks → „+ Schlüssel“ (pghl_…). Agentur-Schlüssel (pghla_…) gehen auch – dann die Sub-Account-ID angeben.' },
    { key: 'location_id', label: 'Sub-Account-ID (nur bei Agentur-Schlüssel)', required: false, type: 'string' },
  ],
  test: async (z, bundle) => {
    const response = await z.request({ url: `${baseUrl(bundle)}/api/hooks/me` });
    return response.data;
  },
  connectionLabel: '{{bundle.inputData.label}}',
};
