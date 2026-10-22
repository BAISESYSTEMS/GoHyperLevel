'use strict';

const { baseUrl, compact } = require('./http');
const { CONTACT_SAMPLE } = require('./definitions');

const findContact = {
  key: 'find_contact',
  noun: 'Kontakt',
  display: { label: 'Kontakt finden', description: 'Sucht einen Kontakt per E-Mail, Telefon oder Suchtext.' },
  operation: {
    inputFields: [
      { key: 'email', label: 'E-Mail' },
      { key: 'phone', label: 'Telefon' },
      { key: 'q', label: 'Suchtext', helpText: 'Name, Firma …' },
    ],
    perform: async (z, bundle) => {
      const response = await z.request({ url: `${baseUrl(bundle)}/api/hooks/search/contacts`, params: compact(bundle.inputData) });
      return response.data;
    },
    sample: CONTACT_SAMPLE,
  },
};

const findOpportunity = {
  key: 'find_opportunity',
  noun: 'Opportunity',
  display: { label: 'Opportunity finden', description: 'Sucht einen Deal per Kontakt, E-Mail, Status oder Name.' },
  operation: {
    inputFields: [
      { key: 'contact_id', label: 'Kontakt-ID' },
      { key: 'email', label: 'E-Mail des Kontakts' },
      { key: 'status', label: 'Status', choices: { open: 'Offen', won: 'Gewonnen', lost: 'Verloren', abandoned: 'Aufgegeben' } },
      { key: 'q', label: 'Name enthält' },
    ],
    perform: async (z, bundle) => {
      const response = await z.request({ url: `${baseUrl(bundle)}/api/hooks/search/opportunities`, params: compact(bundle.inputData) });
      return response.data;
    },
    sample: { id: 'opp_123', name: 'Website-Relaunch', value: 4500, status: 'open', contact_id: 'con_123' },
  },
};

module.exports = { SEARCHES: [findContact, findOpportunity] };
