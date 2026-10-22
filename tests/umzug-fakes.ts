import { createHash } from 'node:crypto';

/**
 * In-memory copies of the vendors' public REST APIs – only what the Umzug importers call, with the payload
 * shapes the real APIs use. They never touch the network: tests set app.services.umzugFetch to `fake.fetch`.
 */

export const json = (status: number, data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
export const md5 = (s: string) => createHash('md5').update(s.trim().toLowerCase()).digest('hex');

export interface Req {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  body: any;
}

export abstract class FakeVendor {
  requests: Req[] = [];
  /** Answer the next N requests whose path starts with the key with 429 + Retry-After. */
  throttle = new Map<string, number>();
  /** Paths (prefix) that answer with a status. */
  fail = new Map<string, number>();
  abstract handle(r: Req): Response | undefined;
  abstract authOk(r: Req): boolean;

  fetch = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body: any;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = Object.fromEntries(new URLSearchParams(String(init.body)));
      }
    }
    const r: Req = { method: init.method ?? 'GET', url, path: url.pathname, headers, body };
    this.requests.push(r);
    for (const [p, n] of this.throttle) {
      if (r.path.startsWith(p) && n > 0) {
        this.throttle.set(p, n - 1);
        return json(429, { error: 'rate limit' }, { 'retry-after': '2' });
      }
    }
    for (const [p, status] of this.fail) if (r.path.startsWith(p)) return json(status, { error: `fake ${status}`, detail: `fake ${status}`, message: `fake ${status}` });
    if (!this.authOk(r)) return json(401, { error: 'bad credentials', detail: 'bad credentials', title: 'API Key Invalid', message: 'unauthorized' });
    return this.handle(r) ?? json(404, { error: 'not found', detail: `unknown path ${r.path}` });
  };

  seen(prefix: string) {
    return this.requests.filter((x) => x.path.startsWith(prefix));
  }
}

const page = <T>(list: T[], url: URL, sizeKey = 'count', offKey = 'offset', max = 1000) => {
  const size = Math.min(Number(url.searchParams.get(sizeKey) ?? 10), max);
  const off = Number(url.searchParams.get(offKey) ?? 0);
  return list.slice(off, off + size);
};

// ---------------------------------------------------------------------------------------------------------------
// Mailchimp Marketing API v3
// ---------------------------------------------------------------------------------------------------------------

export const MC_KEY = 'f3a9c1d27b8e4a60915cb2d7e0f48a13-us12';

const member = (email: string, o: Record<string, any>) => ({
  id: md5(email),
  email_address: email,
  unique_email_id: md5(`u${email}`).slice(0, 10),
  contact_id: md5(`c${email}`),
  full_name: [o.FNAME, o.LNAME].filter(Boolean).join(' '),
  web_id: 1000 + (o.n ?? 0),
  email_type: 'html',
  status: o.status ?? 'subscribed',
  consents_to_one_to_one_messaging: true,
  merge_fields: { FNAME: o.FNAME ?? '', LNAME: o.LNAME ?? '', ADDRESS: o.ADDRESS ?? '', PHONE: o.PHONE ?? '', BIRTHDAY: o.BIRTHDAY ?? '', COMPANY: o.COMPANY ?? '', FARBE: o.FARBE ?? '' },
  ip_signup: '',
  timestamp_signup: o.signup ?? '2023-01-05T10:00:00+00:00',
  ip_opt: '203.0.113.5',
  timestamp_opt: o.opt ?? '2023-01-05T10:05:00+00:00',
  member_rating: 3,
  last_changed: '2024-03-01T08:00:00+00:00',
  language: 'de',
  vip: !!o.vip,
  email_client: 'Gmail',
  tags_count: (o.tags ?? []).length,
  tags: (o.tags ?? []).map((t: string, i: number) => ({ id: 100 + i, name: t })),
  list_id: 'list1',
});

export class FakeMailchimp extends FakeVendor {
  lists = [
    { id: 'list1', name: 'Newsletter', stats: { member_count: 3, unsubscribe_count: 1, cleaned_count: 1 } },
    { id: 'list2', name: 'Kunden', stats: { member_count: 1, unsubscribe_count: 0, cleaned_count: 0 } },
  ];
  mergeFields: Record<string, any[]> = {
    list1: [
      { merge_id: 1, tag: 'FNAME', name: 'Vorname', type: 'text' },
      { merge_id: 2, tag: 'LNAME', name: 'Nachname', type: 'text' },
      { merge_id: 3, tag: 'ADDRESS', name: 'Adresse', type: 'address' },
      { merge_id: 4, tag: 'PHONE', name: 'Telefon', type: 'phone' },
      { merge_id: 5, tag: 'BIRTHDAY', name: 'Geburtstag', type: 'birthday' },
      { merge_id: 6, tag: 'COMPANY', name: 'Firma', type: 'text' },
      { merge_id: 7, tag: 'FARBE', name: 'Lieblingsfarbe', type: 'dropdown', options: { choices: ['Blau', 'Rot'] } },
    ],
    list2: [{ merge_id: 1, tag: 'FNAME', name: 'Vorname', type: 'text' }],
  };
  members: Record<string, any[]> = {
    list1: [
      member('anna@example.com', { n: 1, FNAME: 'Anna', LNAME: 'Alt', ADDRESS: { addr1: 'Hauptstr. 1', addr2: '', city: 'Berlin', state: 'BE', zip: '10115', country: 'DE' }, PHONE: '030 1234567', BIRTHDAY: '05/17', COMPANY: 'Muster GmbH', FARBE: 'Blau', tags: ['Kunde', 'VIP'], vip: true }),
      member('ben@example.com', { n: 2, FNAME: 'Ben', LNAME: 'Bau', tags: ['Interessent'] }),
      member('cleo@example.com', { n: 3, FNAME: 'Cleo', status: 'unsubscribed', tags: [] }),
      member('dirk@example.com', { n: 4, FNAME: 'Dirk', status: 'cleaned' }),
      member('emil@example.com', { n: 5, FNAME: 'Emil', status: 'subscribed', tags: ['Interessent'] }),
    ],
    list2: [member('anna@example.com', { n: 1, FNAME: 'Anna', LNAME: 'Alt', tags: ['Kunde'] })],
  };
  tags: Record<string, string[]> = { list1: ['Kunde', 'VIP', 'Interessent'], list2: ['Kunde'] };
  segments: Record<string, any[]> = {
    list1: [
      { id: 11, name: 'Aktive Kunden', member_count: 1, type: 'saved', options: { match: 'any', conditions: [{ condition_type: 'TextMerge', field: 'FNAME', op: 'contains', value: 'A' }] } },
      { id: 12, name: 'Messe 2023', member_count: 2, type: 'static' },
      { id: 13, name: 'Vorhergesagt', member_count: 0, type: 'fuzzy' },
    ],
    list2: [],
  };
  segmentMembers: Record<string, string[]> = { '11': ['anna@example.com'], '12': ['ben@example.com', 'emil@example.com'] };
  templates = [
    { id: 501, name: 'Willkommen', type: 'user', category: 'Willkommen', html: '<html><head><title>Hallo</title></head><body><h1>Hallo *|FNAME|*!</h1><p>Schön, dass du da bist. *|EMAIL|*</p><p><a href="*|UNSUB|*">Abmelden</a></p><p>*|WEIRD_TAG|*</p><script>alert(1)</script></body></html>' },
    { id: 502, name: 'Angebot', type: 'user', category: '', html: '<p>Unser Angebot für *|LIST:COMPANY|*</p>' },
  ];
  campaigns = [
    { id: 'camp1', type: 'regular', status: 'sent', send_time: '2024-02-01T09:00:00+00:00', settings: { title: 'Februar-Brief', subject_line: 'Neuigkeiten im Februar' }, recipients: { list_id: 'list1' } },
    { id: 'camp2', type: 'regular', status: 'sent', send_time: '2024-01-01T09:00:00+00:00', settings: { title: 'Januar-Brief', subject_line: 'Januar' }, recipients: { list_id: 'list1' } },
  ];

  authOk(r: Req) {
    return r.headers.authorization === `Basic ${Buffer.from(`gohigh:${MC_KEY}`).toString('base64')}`;
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/3\.0/, '') || '/';
    const u = r.url;
    if (p === '/') return json(200, { account_id: 'acc123', account_name: 'Muster Newsletter', email: 'chef@example.com', login_id: 'login1' });
    if (p === '/lists') return json(200, { lists: page(this.lists, u, 'count', 'offset'), total_items: this.lists.length });
    let m = /^\/lists\/([^/]+)\/merge-fields$/.exec(p);
    if (m) return json(200, { merge_fields: this.mergeFields[m[1]] ?? [], total_items: (this.mergeFields[m[1]] ?? []).length });
    m = /^\/lists\/([^/]+)\/members$/.exec(p);
    if (m) {
      const all = this.members[m[1]] ?? [];
      return json(200, { members: page(all, u), list_id: m[1], total_items: all.length });
    }
    m = /^\/lists\/([^/]+)\/tag-search$/.exec(p);
    if (m) return json(200, { tags: (this.tags[m[1]] ?? []).map((name, i) => ({ id: i + 1, name })), total_items: (this.tags[m[1]] ?? []).length });
    m = /^\/lists\/([^/]+)\/segments$/.exec(p);
    if (m) return json(200, { segments: page(this.segments[m[1]] ?? [], u), total_items: (this.segments[m[1]] ?? []).length });
    m = /^\/lists\/([^/]+)\/segments\/(\d+)\/members$/.exec(p);
    if (m) {
      const emails = this.segmentMembers[m[2]] ?? [];
      return json(200, { members: emails.map((e) => ({ id: md5(e), email_address: e })), total_items: emails.length });
    }
    if (p === '/templates') {
      const list = this.templates.filter((t) => t.type === (u.searchParams.get('type') ?? 'user'));
      return json(200, { templates: page(list, u).map(({ html: _h, ...t }) => t), total_items: list.length });
    }
    m = /^\/templates\/(\d+)\/default-content$/.exec(p);
    if (m) return json(200, { html: this.templates.find((t) => String(t.id) === m![1])?.html ?? '' });
    if (p === '/campaigns') return json(200, { campaigns: page(this.campaigns, u), total_items: this.campaigns.length });
    m = /^\/reports\/([^/]+)\/sent-to$/.exec(p);
    if (m) {
      const list = (this.members.list1 ?? []).filter((x) => x.status !== 'cleaned').map((x, i) => ({ email_id: x.unique_email_id, email_address: x.email_address, status: 'sent', open_count: i % 2, campaign_id: m![1], list_id: 'list1' }));
      return json(200, { sent_to: page(list, u), total_items: list.length });
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ActiveCampaign API v3
// ---------------------------------------------------------------------------------------------------------------

export const AC_URL = 'https://muster.api-us1.com';
export const AC_KEY = 'ac0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export class FakeActiveCampaign extends FakeVendor {
  /** Leave the sideloaded arrays out of /contacts (older accounts) → the importer falls back to per-contact calls. */
  noSideload = false;
  tags = [
    { id: '1', tag: 'Kunde', tagType: 'contact' },
    { id: '2', tag: 'Newsletter', tagType: 'contact' },
  ];
  lists = [
    { id: '1', name: 'Hauptliste' },
    { id: '2', name: 'Aktionen' },
  ];
  fields = [
    { id: '1', title: 'Budget', type: 'text', perstag: 'BUDGET' },
    { id: '2', title: 'Branche', type: 'dropdown', perstag: 'BRANCHE' },
  ];
  fieldOptions = [
    { field: '2', value: 'it', label: 'IT' },
    { field: '2', value: 'bau', label: 'Bau' },
  ];
  contacts = [
    { id: '10', email: 'anna@example.com', firstName: 'Anna', lastName: 'Alt', phone: '+49 30 111', cdate: '2023-05-01T10:00:00-05:00', orgid: '0' },
    { id: '11', email: 'ben@example.com', firstName: 'Ben', lastName: 'Bau', phone: '', cdate: '2023-06-01T10:00:00-05:00' },
    { id: '12', email: 'cleo@example.com', firstName: 'Cleo', lastName: '', phone: '', cdate: '2023-07-01T10:00:00-05:00' },
  ];
  contactLists = [
    { contact: '10', list: '1', status: '1' },
    { contact: '10', list: '2', status: '2' },
    { contact: '11', list: '1', status: '1' },
    { contact: '12', list: '1', status: '2' },
  ];
  contactTags = [
    { id: '1', contact: '10', tag: '1' },
    { id: '2', contact: '11', tag: '2' },
  ];
  fieldValues = [
    { contact: '10', field: '1', value: '5000' },
    { contact: '10', field: '2', value: 'it' },
  ];
  accounts = [{ id: '1', name: 'Muster GmbH', accountUrl: 'muster.de' }];
  accountContacts = [{ id: '1', account: '1', contact: '10', jobTitle: 'CEO' }];
  dealGroups = [{ id: '1', title: 'Vertrieb' }];
  dealStages = [
    { id: '2', title: 'Angebot', group: '1', order: '2' },
    { id: '1', title: 'Neu', group: '1', order: '1' },
    { id: '3', title: 'Gewonnen', group: '1', order: '3' },
  ];
  deals = [
    { id: '100', title: 'Website', value: '450000', currency: 'eur', group: '1', stage: '3', owner: '1', contact: '10', organization: '1', status: '1', cdate: '2024-01-10T10:00:00-05:00' },
    { id: '101', title: 'SEO', value: '90000', currency: 'eur', group: '1', stage: '2', contact: '11', status: '0', cdate: '2024-02-10T10:00:00-05:00' },
    { id: '102', title: 'Ohne Kontakt', value: '100', currency: 'eur', group: '1', stage: '1', status: '2', cdate: '2024-02-11T10:00:00-05:00' },
  ];
  notes = [
    { id: '1', note: '<p>Erstes <b>Gespräch</b></p>', relid: '10', reltype: 'Subscriber', cdate: '2024-02-01T09:00:00-05:00' },
    { id: '2', note: 'Deal-Notiz', relid: '101', reltype: 'Deal', cdate: '2024-02-02T09:00:00-05:00' },
  ];
  automations = [
    { id: '7', name: 'Willkommensserie', status: '1', cdate: '2023-01-01T00:00:00-05:00' },
    { id: '8', name: 'Ohne Details', status: '0', cdate: '2023-01-01T00:00:00-05:00' },
  ];
  blocks: Record<string, any[]> = {
    '7': [
      { id: 1, type: 'start', params: { type: 'subscribes to list', list: '1' } },
      { id: 2, type: 'wait', params: { duration: 1, unit: 'days' } },
      { id: 3, type: 'send email', params: { subject: 'Willkommen %FIRSTNAME%!', name: 'Welcome' } },
      { id: 4, type: 'add tag', params: { tagid: '2' } },
      { id: 5, type: 'if/else', params: { conditions: [{ field: 'email', op: 'contains', value: '@' }] } },
      { id: 6, type: 'send sms', params: { message: 'Hi!' } },
      { id: 7, type: 'machine learning', params: { model: 'x' } },
    ],
  };

  authOk(r: Req) {
    return r.headers['api-token'] === AC_KEY && r.url.hostname === 'muster.api-us1.com';
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/api\/3/, '');
    const u = r.url;
    const pg = <T>(list: T[]) => {
      const limit = Number(u.searchParams.get('limit') ?? 20);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      return list.slice(offset, offset + limit);
    };
    const meta = (n: number) => ({ meta: { total: String(n) } });
    if (p === '/users/me') return json(200, { user: { id: '1', username: 'admin', email: 'chef@example.com', firstName: 'Chef', lastName: 'Admin' } });
    if (p === '/tags') return json(200, { tags: pg(this.tags), ...meta(this.tags.length) });
    if (p === '/lists') return json(200, { lists: pg(this.lists), ...meta(this.lists.length) });
    if (p === '/fields') return json(200, { fields: pg(this.fields), fieldOptions: this.fieldOptions, ...meta(this.fields.length) });
    if (p === '/accounts') return json(200, { accounts: pg(this.accounts), ...meta(this.accounts.length) });
    if (p === '/accountContacts') return json(200, { accountContacts: pg(this.accountContacts), ...meta(this.accountContacts.length) });
    if (p === '/contacts') {
      const slice = pg(this.contacts);
      const ids = new Set(slice.map((c) => c.id));
      const side = this.noSideload ? {} : { contactLists: this.contactLists.filter((x) => ids.has(x.contact)), contactTags: this.contactTags.filter((x) => ids.has(x.contact)), fieldValues: this.fieldValues.filter((x) => ids.has(x.contact)) };
      return json(200, { contacts: slice, ...side, ...meta(this.contacts.length) });
    }
    let m = /^\/contacts\/(\d+)\/(contactTags|contactLists|fieldValues)$/.exec(p);
    if (m) {
      const src: any = { contactTags: this.contactTags, contactLists: this.contactLists, fieldValues: this.fieldValues };
      return json(200, { [m[2]]: src[m[2]].filter((x: any) => x.contact === m![1]) });
    }
    if (p === '/dealGroups') return json(200, { dealGroups: pg(this.dealGroups), ...meta(this.dealGroups.length) });
    if (p === '/dealStages') return json(200, { dealStages: pg(this.dealStages), ...meta(this.dealStages.length) });
    if (p === '/deals') return json(200, { deals: pg(this.deals), ...meta(this.deals.length) });
    if (p === '/notes') return json(200, { notes: pg(this.notes), ...meta(this.notes.length) });
    if (p === '/automations') return json(200, { automations: pg(this.automations), ...meta(this.automations.length) });
    m = /^\/automations\/(\d+)\/blocks$/.exec(p);
    if (m) return this.blocks[m[1]] ? json(200, { automationBlocks: this.blocks[m[1]] }) : json(404, { message: 'No Result found for AutomationBlocks with id ' + m[1] });
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Kit (ConvertKit) API v4
// ---------------------------------------------------------------------------------------------------------------

export const KIT_KEY = 'kit_0f4c2a9b7d1e48c5a3b6d9e2f1a07c84';

export class FakeKit extends FakeVendor {
  subscribers = [
    { id: 1, first_name: 'Anna', email_address: 'anna@example.com', state: 'active', created_at: '2023-02-01T10:00:00Z', fields: { last_name: 'Alt', Firma: 'Muster GmbH' } },
    { id: 2, first_name: 'Ben', email_address: 'ben@example.com', state: 'inactive', created_at: '2023-03-01T10:00:00Z', fields: { last_name: 'Bau' } },
    { id: 3, first_name: 'Cleo', email_address: 'cleo@example.com', state: 'bounced', created_at: '2023-04-01T10:00:00Z', fields: {} },
    { id: 4, first_name: 'Dora', email_address: 'dora@example.com', state: 'complained', created_at: '2023-05-01T10:00:00Z', fields: {} },
  ];
  tags = [
    { id: 11, name: 'Käufer', created_at: '2023-01-01T00:00:00Z' },
    { id: 12, name: 'Webinar', created_at: '2023-01-01T00:00:00Z' },
  ];
  tagSubscribers: Record<string, number[]> = { '11': [1], '12': [1, 2] };
  customFields = [
    { id: 1, name: 'ck_field_1_last_name', key: 'last_name', label: 'Last name' },
    { id: 2, name: 'ck_field_2_firma', key: 'firma', label: 'Firma' },
  ];
  forms = [
    { id: 21, name: 'Newsletter-Anmeldung', created_at: '2023-01-01T00:00:00Z', type: 'embed', format: 'inline', archived: false, uid: 'abc' },
    { id: 22, name: 'Landing: Webinar', created_at: '2023-01-01T00:00:00Z', type: 'hosted', format: 'landing_page', archived: false, uid: 'def' },
  ];
  sequences = [{ id: 31, name: 'Willkommen', hold: false, repeat: false, created_at: '2023-01-01T00:00:00Z' }];
  broadcasts = [
    { id: 41, subject: 'Neuigkeiten', description: 'Newsletter Mai', content: '<p>Hallo {{ subscriber.first_name }}, <a href="{{ unsubscribe_url }}">abmelden</a></p>', public: false, published_at: null, send_at: '2024-05-01T08:00:00Z', created_at: '2024-04-20T08:00:00Z' },
  ];

  authOk(r: Req) {
    return r.headers['x-kit-api-key'] === KIT_KEY && r.url.hostname === 'api.kit.com';
  }

  /** v4 cursor pagination: per_page + after (the end cursor is the last index). */
  private cursor<T>(list: T[], u: URL, key: string) {
    const per = Math.min(Number(u.searchParams.get('per_page') ?? 500), 500);
    const after = Number(u.searchParams.get('after') ?? 0);
    const slice = list.slice(after, after + per);
    const end = after + slice.length;
    return json(200, { [key]: slice, pagination: { has_previous_page: after > 0, has_next_page: end < list.length, start_cursor: String(after), end_cursor: String(end), per_page: per } });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/v4/, '');
    const u = r.url;
    if (p === '/account') return json(200, { user: { email: 'chef@example.com' }, account: { name: 'Muster Kurse', plan_type: 'creator', primary_email_address: 'chef@example.com' } });
    if (p === '/subscribers') {
      const status = u.searchParams.get('status');
      const list = status && status !== 'all' ? this.subscribers.filter((s) => s.state === status) : this.subscribers;
      return this.cursor(list, u, 'subscribers');
    }
    if (p === '/tags') return this.cursor(this.tags, u, 'tags');
    const m = /^\/tags\/(\d+)\/subscribers$/.exec(p);
    if (m) return this.cursor(this.subscribers.filter((s) => (this.tagSubscribers[m[1]] ?? []).includes(s.id)), u, 'subscribers');
    if (p === '/custom_fields') return this.cursor(this.customFields, u, 'custom_fields');
    if (p === '/forms') return this.cursor(this.forms, u, 'forms');
    if (p === '/sequences') return this.cursor(this.sequences, u, 'sequences');
    if (p === '/broadcasts') return this.cursor(this.broadcasts, u, 'broadcasts');
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Kajabi public API (JSON:API)
// ---------------------------------------------------------------------------------------------------------------

export const KJ_ID = 'kj_client_4f8a2c';
export const KJ_PASS = 'kj_secret_9b3d7e1a6c5f02847d9e';

export class FakeKajabi extends FakeVendor {
  token = 'kj-access-token-1';
  tokenCalls = 0;
  tags = [
    { id: '1', type: 'tags', attributes: { name: 'Kunde' } },
    { id: '2', type: 'tags', attributes: { name: 'Lead' } },
  ];
  contacts = [
    { id: '100', type: 'contacts', attributes: { name: 'Anna Alt', email: 'anna@example.com', phone_number: '+4930111', address_city: 'Berlin', address_zip: '10115', subscribed: true, created_at: '2023-01-01T10:00:00Z' }, relationships: { tags: { data: [{ id: '1', type: 'tags' }] } } },
    { id: '101', type: 'contacts', attributes: { name: 'Ben', email: 'ben@example.com', subscribed: false, created_at: '2023-02-01T10:00:00Z' }, relationships: { tags: { data: [{ id: '2', type: 'tags' }] } } },
  ];
  products = [
    { id: '200', type: 'products', attributes: { title: 'Mein Kurs', description: '<p>Alles <b>drin</b></p>', thumbnail_url: 'https://cdn.example.com/k.png', product_type_name: 'Online Course' } },
    { id: '201', type: 'products', attributes: { title: 'Podcast', description: '', product_type_name: 'Podcast' } },
  ];
  offers = [
    { id: '300', type: 'offers', attributes: { title: 'Kurs einmalig', description: 'Einmal zahlen', price_in_cents: 29700, currency: 'EUR', payment_type: 'one_time' }, relationships: { product: { data: { id: '200', type: 'products' } } } },
    { id: '301', type: 'offers', attributes: { title: 'Kurs Abo', description: '', price_in_cents: 4900, currency: 'EUR', payment_type: 'subscription', recurring_offer: true }, relationships: { product: { data: { id: '200', type: 'products' } } } },
  ];
  purchases = [
    { id: '400', type: 'purchases', attributes: { created_at: '2023-03-01T10:00:00Z', deactivated_at: null }, relationships: { customer: { data: { id: '100', type: 'customers' } }, offer: { data: { id: '300', type: 'offers' } } } },
    { id: '401', type: 'purchases', attributes: { created_at: '2023-04-01T10:00:00Z', deactivated_at: '2023-05-01T10:00:00Z' }, relationships: { customer: { data: { id: '101', type: 'customers' } }, offer: { data: { id: '301', type: 'offers' } } } },
  ];

  authOk(r: Req) {
    return r.path === '/v1/oauth/token' || r.headers.authorization === `Bearer ${this.token}`;
  }

  private jsonapi(list: any[], u: URL) {
    const size = Number(u.searchParams.get('page[size]') ?? 10);
    const num = Number(u.searchParams.get('page[number]') ?? 1);
    const pages = Math.max(1, Math.ceil(list.length / size));
    return json(200, { data: list.slice((num - 1) * size, num * size), links: num < pages ? { next: `x?page[number]=${num + 1}` } : {}, meta: { total_pages: pages, total_count: list.length, current_page: num } });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/v1/, '');
    if (p === '/oauth/token') {
      this.tokenCalls++;
      if (r.body?.client_id !== KJ_ID || r.body?.client_secret !== KJ_PASS || r.body?.grant_type !== 'client_credentials') return json(401, { error: 'invalid_client' });
      return json(200, { access_token: this.token, token_type: 'Bearer', expires_in: 7200 });
    }
    if (p === '/contacts') return this.jsonapi(this.contacts, r.url);
    if (p === '/tags') return this.jsonapi(this.tags, r.url);
    if (p === '/products') return this.jsonapi(this.products, r.url);
    if (p === '/offers') return this.jsonapi(this.offers, r.url);
    if (p === '/purchases') return this.jsonapi(this.purchases, r.url);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Teachable public API v1
// ---------------------------------------------------------------------------------------------------------------

export const TE_KEY = 'te_9c1f5a7e3b2d4806a1c9e7f2b5d30a48';

export class FakeTeachable extends FakeVendor {
  users = [
    { id: 1, email: 'anna@example.com', name: 'Anna Alt', role: 'student', src: 'direct', created_at: '2023-01-01T10:00:00Z' },
    { id: 2, email: 'ben@example.com', name: 'Ben', role: 'student', src: 'import', created_at: '2023-02-01T10:00:00Z' },
    { id: 3, email: 'cleo@example.com', name: 'Cleo Cool', role: 'author', created_at: '2023-03-01T10:00:00Z' },
  ];
  courses = [{ id: 10, name: 'Fotografie Grundlagen', heading: 'Lerne Licht', description: '<p>Ein <b>Kurs</b></p>', is_published: true, image_url: 'https://cdn.example.com/f.png' }];
  detail: Record<string, any> = {
    '10': {
      id: 10,
      name: 'Fotografie Grundlagen',
      heading: 'Lerne Licht',
      description: '<p>Ein <b>Kurs</b></p>',
      is_published: true,
      image_url: 'https://cdn.example.com/f.png',
      lecture_sections: [
        { id: 100, name: 'Start', is_published: true, position: 1, lectures: [{ id: 1001, position: 1, is_published: true }, { id: 1002, position: 2, is_published: true }] },
        { id: 101, name: 'Praxis', is_published: true, position: 2, lectures: [{ id: 1003, position: 1, is_published: false }, { id: 1004, position: 2, is_published: true }] },
      ],
    },
  };
  lectures: Record<string, any> = {
    '1001': { id: 1001, name: 'Willkommen', position: 1, is_published: true, attachments: [{ id: 1, kind: 'video', name: 'Intro', url: 'https://videos.example.com/intro.mp4', position: 1 }, { id: 2, kind: 'text', name: 'Text', text: '<h2>Hallo</h2><p>Los <b>geht</b>\'s</p>', position: 2 }] },
    '1002': { id: 1002, name: 'Material', position: 2, is_published: true, attachments: [{ id: 3, kind: 'pdf_embed', name: 'Checkliste', url: 'https://files.example.com/check.pdf', position: 1 }, { id: 4, kind: 'quiz', name: 'Quiz 1', position: 2 }] },
    '1003': { id: 1003, name: 'Entwurf', position: 1, is_published: false, attachments: [] },
    '1004': { id: 1004, name: 'Blende', position: 2, is_published: true, attachments: [{ id: 5, kind: 'video', name: 'Blende', position: 1 }] },
  };
  enrollments = [
    { user_id: 1, enrolled_at: '2023-03-01T10:00:00Z', completed_at: '2023-04-01T10:00:00Z', percent_complete: 100, is_active_enrollment: true },
    { user_id: 2, enrolled_at: '2023-03-05T10:00:00Z', completed_at: null, percent_complete: 50, is_active_enrollment: true },
  ];
  pricing = [
    { id: 1, course_id: 10, name: 'Einmalzahlung', price: 19900, currency: 'EUR', billing_type: 'one_time' },
    { id: 2, course_id: 10, name: 'Monatlich', price: 2900, currency: 'EUR', billing_type: 'subscription', interval: 'month' },
    { id: 3, course_id: 10, name: 'Raten', price: 6900, currency: 'EUR', billing_type: 'payment_plan' },
  ];

  authOk(r: Req) {
    return r.headers.apikey === TE_KEY;
  }

  private pg<T>(list: T[], u: URL, key: string) {
    const per = Number(u.searchParams.get('per') ?? 20);
    const page = Number(u.searchParams.get('page') ?? 1);
    return json(200, { [key]: list.slice((page - 1) * per, page * per), meta: { total: list.length, page, from: (page - 1) * per + 1, to: Math.min(page * per, list.length), per_page: per, number_of_pages: Math.max(1, Math.ceil(list.length / per)) } });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/v1/, '');
    if (p === '/users') return this.pg(this.users, r.url, 'users');
    if (p === '/courses') return this.pg(this.courses, r.url, 'courses');
    if (p === '/pricing_plans') return this.pg(this.pricing, r.url, 'pricing_plans');
    let m = /^\/courses\/(\d+)$/.exec(p);
    if (m) return this.detail[m[1]] ? json(200, { course: this.detail[m[1]] }) : json(404, { error: 'not found' });
    m = /^\/courses\/(\d+)\/lectures\/(\d+)$/.exec(p);
    if (m) return this.lectures[m[2]] ? json(200, { lecture: this.lectures[m[2]] }) : json(404, { error: 'not found' });
    m = /^\/courses\/(\d+)\/enrollments$/.exec(p);
    if (m) return this.pg(this.enrollments, r.url, 'enrollments');
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Keap REST v1
// ---------------------------------------------------------------------------------------------------------------

export const KEAP_KEY = 'KeapAK-5d0e7c3a91b84f26a8c1d4e9f7b2a6c3';

export class FakeKeap extends FakeVendor {
  tags = [
    { id: 1, name: 'Kunde', description: '', category: { id: 1, name: 'Segmente' } },
    { id: 2, name: 'Messe', description: '', category: null },
  ];
  tagContacts: Record<string, number[]> = { '1': [10], '2': [10, 11] };
  customFields = [
    { id: 5, label: 'Budget', field_name: '_Budget', field_type: 'Currency', options: [] },
    { id: 6, label: 'Interesse', field_name: '_Interesse', field_type: 'Dropdown', options: [{ id: 1, label: 'SEO' }] },
  ];
  contacts: any[] = [
    {
      id: 10, given_name: 'Anna', family_name: 'Alt', email_addresses: [{ email: 'anna@example.com', field: 'EMAIL1' }], phone_numbers: [{ number: '030 111', field: 'PHONE1', type: 'Work' }],
      addresses: [{ field: 'BILLING', line1: 'Hauptstr. 1', locality: 'Berlin', postal_code: '10115', country_code: 'DEU', region: 'BE' }], company: { id: 50, company_name: 'Muster GmbH' },
      custom_fields: [{ id: 5, content: 1500 }, { id: 6, content: 'SEO' }], email_status: 'Marketable', date_created: '2023-01-01T10:00:00.000Z', job_title: 'CEO', website: 'https://muster.de', birthday: '1980-05-17T00:00:00.000Z',
    },
    { id: 11, given_name: 'Ben', family_name: 'Bau', email_addresses: [{ email: 'ben@example.com', field: 'EMAIL1' }], phone_numbers: [], addresses: [], custom_fields: [], email_status: 'Unsubscribed', date_created: '2023-02-01T10:00:00.000Z' },
    { id: 12, given_name: 'Cleo', family_name: '', email_addresses: [], phone_numbers: [{ number: '0171 5551234', field: 'PHONE1' }], addresses: [], custom_fields: [], email_status: 'NonMarketable', date_created: '2023-03-01T10:00:00.000Z' },
  ];
  companies = [{ id: 50, company_name: 'Muster GmbH', email_address: 'info@muster.de', phone_number: { number: '030 999' }, website: 'https://muster.de', address: { line1: 'Hauptstr. 1', locality: 'Berlin', postal_code: '10115', country_code: 'DEU' } }];
  stagePipeline = [
    { id: 1, name: 'Neu', details: { probability: 10 } },
    { id: 2, name: 'Angebot', details: { probability: 50 } },
    { id: 3, name: 'Gewonnen', details: { probability: 100 } },
  ];
  opportunities = [
    { id: 70, opportunity_title: 'Website', contact: { id: 10, first_name: 'Anna', last_name: 'Alt', email: 'anna@example.com' }, stage: { id: 3, name: 'Gewonnen' }, projected_revenue_high: 4500, projected_revenue_low: 4000, date_created: '2024-01-01T10:00:00.000Z' },
    { id: 71, opportunity_title: 'Beratung', contact: { id: 11, first_name: 'Ben', last_name: 'Bau', email: 'ben@example.com' }, stage: { id: 2, name: 'Angebot' }, projected_revenue_high: 900, date_created: '2024-02-01T10:00:00.000Z' },
  ];
  notes = [{ id: 80, contact_id: 10, title: 'Telefonat', body: 'Interesse an SEO', type: 'Call', date_created: '2024-01-15T10:00:00.000Z' }];
  tasks = [
    { id: 90, title: 'Angebot schicken', description: 'bis Freitag', contact: { id: 10 }, due_date: '2024-03-01T10:00:00.000Z', completed: false, type: 'Call' },
    { id: 91, title: 'Rechnung prüfen', description: '', contact: { id: 11 }, due_date: '2024-02-01T10:00:00.000Z', completed: true, completion_date: '2024-02-02T10:00:00.000Z', type: 'Other' },
  ];
  products = [
    { id: 60, product_name: 'Beratung 1h', product_desc: 'Eine Stunde', product_short_desc: 'Kurz', product_price: 149.0, active: true, subscription_only: false },
    { id: 61, product_name: 'Wartung', product_desc: '', product_price: 49.5, active: true, subscription_only: true },
  ];

  authOk(r: Req) {
    return r.headers['x-keap-api-key'] === KEAP_KEY || r.headers.authorization === `Bearer ${KEAP_KEY}`;
  }

  private pg(list: any[], u: URL, key: string) {
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const offset = Number(u.searchParams.get('offset') ?? 0);
    return json(200, { [key]: list.slice(offset, offset + limit), count: list.length, next: offset + limit < list.length ? 'https://evil.example.com/next' : '', previous: '' });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/crm\/rest\/v1/, '');
    if (p === '/account/profile') return json(200, { name: 'Muster GmbH', email: 'chef@example.com', business_goals: [] });
    if (p === '/tags') return this.pg(this.tags, r.url, 'tags');
    const m = /^\/tags\/(\d+)\/contacts$/.exec(p);
    if (m) return this.pg((this.tagContacts[m[1]] ?? []).map((id) => ({ contact: { id }, date_applied: '2024-01-01T00:00:00Z' })), r.url, 'contacts');
    if (p === '/contacts/model') return json(200, { custom_fields: this.customFields, optional_properties: [] });
    if (p === '/contacts') return this.pg(this.contacts, r.url, 'contacts');
    if (p === '/companies') return this.pg(this.companies, r.url, 'companies');
    if (p === '/opportunity/stage_pipeline') return json(200, this.stagePipeline);
    if (p === '/opportunities') return this.pg(this.opportunities, r.url, 'opportunities');
    if (p === '/notes') return this.pg(this.notes, r.url, 'notes');
    if (p === '/tasks') return this.pg(this.tasks, r.url, 'tasks');
    if (p === '/products') return this.pg(this.products, r.url, 'products');
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pipedrive API v1
// ---------------------------------------------------------------------------------------------------------------

export const PD_KEY = 'pd_7a3e91c05d2b4f68a0e3c9d17b5f2a64';
const HASH = '8f3c1a9d0e5b7c2a4d6f8e1b3a5c7d9e0f2a4b6c';

export class FakePipedrive extends FakeVendor {
  personFields = [
    { id: 1, key: 'name', name: 'Name', field_type: 'varchar', edit_flag: false },
    { id: 2, key: 'label', name: 'Label', field_type: 'enum', edit_flag: false, options: [{ id: 5, label: 'Kunde' }, { id: 6, label: 'Lead' }] },
    { id: 3, key: HASH, name: 'Budget', field_type: 'monetary', edit_flag: true },
    { id: 4, key: 'abc123def456abc123def456abc123def456abcd', name: 'Interesse', field_type: 'enum', edit_flag: true, options: [{ id: 11, label: 'SEO' }, { id: 12, label: 'Ads' }] },
  ];
  persons: any[] = [
    { id: 1, name: 'Anna Alt', first_name: 'Anna', last_name: 'Alt', org_id: { name: 'Muster GmbH', value: 9 }, email: [{ value: 'anna@work.example.com', primary: false, label: 'work' }, { value: 'anna@example.com', primary: true, label: 'home' }], phone: [{ value: '030 111', primary: true }], label: 5, add_time: '2023-01-01 10:00:00', marketing_status: 'subscribed', [HASH]: 2500, abc123def456abc123def456abc123def456abcd: '11' },
    { id: 2, name: 'Ben Bau', first_name: 'Ben', last_name: 'Bau', org_id: null, email: [{ value: 'ben@example.com', primary: true }], phone: [], label: null, add_time: '2023-02-01 10:00:00', marketing_status: 'unsubscribed' },
    { id: 3, name: 'Nur Name', first_name: 'Nur', last_name: 'Name', org_id: null, email: [], phone: [], label: 6, add_time: '2023-03-01 10:00:00', marketing_status: 'no_consent' },
  ];
  organizations = [{ id: 9, name: 'Muster GmbH', address_route: 'Hauptstr. 1', address_locality: 'Berlin', address_postal_code: '10115', address_country: 'Germany' }];
  pipelines = [{ id: 1, name: 'Vertrieb', order_nr: 1, active: true }];
  stages = [
    { id: 12, name: 'Angebot', pipeline_id: 1, order_nr: 2, deal_probability: 60 },
    { id: 11, name: 'Neu', pipeline_id: 1, order_nr: 1, deal_probability: 20 },
  ];
  deals = [
    { id: 500, title: 'Website', value: 4500, currency: 'EUR', status: 'won', stage_id: 12, pipeline_id: 1, person_id: { value: 1, name: 'Anna Alt', email: [{ value: 'anna@example.com', primary: true }] }, org_id: { value: 9, name: 'Muster GmbH' }, add_time: '2024-01-01 10:00:00' },
    { id: 501, title: 'Neu-Deal', value: 100, currency: 'EUR', status: 'open', stage_id: 11, pipeline_id: 1, person_id: { value: 77, name: 'Fremd Person', email: [{ value: 'fremd@example.com', primary: true }] }, org_id: null, add_time: '2024-02-01 10:00:00' },
  ];
  activities = [
    { id: 600, type: 'call', subject: 'Rückruf', done: false, due_date: '2024-03-01', due_time: '14:00', note: '<p>Wichtig</p>', person_id: 1, deal_id: 500, add_time: '2024-02-20 10:00:00' },
    { id: 601, type: 'meeting', subject: 'Kick-off', done: true, due_date: '2024-02-01', due_time: '', note: '', person_id: 1, deal_id: null, add_time: '2024-01-20 10:00:00', marked_as_done_time: '2024-02-01 12:00:00' },
  ];
  notes = [{ id: 700, content: '<p>Gespräch <b>gut</b></p>', person_id: 1, deal_id: null, org_id: 9, add_time: '2024-02-02 09:00:00' }];

  authOk(r: Req) {
    return r.headers['x-api-token'] === PD_KEY && !r.url.searchParams.has('api_token');
  }

  private pg(list: any[], u: URL) {
    const limit = Number(u.searchParams.get('limit') ?? 100);
    const start = Number(u.searchParams.get('start') ?? 0);
    const more = start + limit < list.length;
    return json(200, { success: true, data: list.slice(start, start + limit), additional_data: { pagination: { start, limit, more_items_in_collection: more, ...(more ? { next_start: start + limit } : {}) } } });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/(api\/)?v1/, '');
    if (p === '/users/me') return json(200, { success: true, data: { id: 1, name: 'Chef', email: 'chef@example.com', company_id: 77, company_name: 'Muster GmbH', company_domain: 'muster' } });
    if (p === '/personFields') return this.pg(this.personFields, r.url);
    if (p === '/persons') return this.pg(this.persons, r.url);
    if (p === '/organizations') return this.pg(this.organizations, r.url);
    if (p === '/pipelines') return this.pg(this.pipelines, r.url);
    if (p === '/stages') return this.pg(this.stages, r.url);
    if (p === '/deals') return this.pg(this.deals, r.url);
    if (p === '/activities') return this.pg(this.activities, r.url);
    if (p === '/notes') return this.pg(this.notes, r.url);
    return undefined;
  }
}
