import { FakeVendor, json, type Req } from './umzug-fakes.js';

/**
 * Recorded-style fakes of the vendors added in "Umzug Welle 2": in-memory copies of the public REST APIs with the payload shapes the
 * real ones return (taken from the vendors' API references). Pages are deliberately tiny (`pageCap`) so every importer's pagination
 * is exercised. They never touch the network: tests set app.services.umzugFetch to `fake.fetch`.
 */

// ---------------------------------------------------------------------------------------------------------------
// systeme.io public API (https://api.systeme.io/api, X-API-Key, startingAfter / hasMore)
// ---------------------------------------------------------------------------------------------------------------

export const SYS_KEY = 'sio_9d2f4c7a1b6e48d3a0c5e7f1b2d94a68';

export class FakeSysteme extends FakeVendor {
  pageCap = 2;
  domains = [{ id: 1, name: 'meinshop.systeme.io', status: 'active', type: 'platform_subdomain', default: true }];
  tags = [
    { id: 1, name: 'Kunde', createdAt: '2024-01-01T10:00:00.000Z' },
    { id: 2, name: 'VIP', createdAt: '2024-01-02T10:00:00.000Z' },
    { id: 3, name: 'Webinar', createdAt: '2024-01-03T10:00:00.000Z' },
  ];
  contactFields = [
    { slug: 'first_name', fieldName: 'First name' },
    { slug: 'surname', fieldName: 'Surname' },
    { slug: 'phone_number', fieldName: 'Phone number' },
    { slug: 'company_name', fieldName: 'Company name' },
    { slug: 'city', fieldName: 'City' },
    { slug: 'lieblingsfarbe', fieldName: 'Lieblingsfarbe' },
  ];
  contacts: any[] = [
    {
      id: 101,
      email: 'anna@example.com',
      registeredAt: '2024-01-05T10:00:00+00:00',
      locale: 'de',
      sourceURL: 'https://meinshop.systeme.io/webinar-anmeldung',
      unsubscribed: false,
      bounced: false,
      needsConfirmation: false,
      fields: [
        { fieldName: 'First name', slug: 'first_name', value: 'Anna' },
        { fieldName: 'Surname', slug: 'surname', value: 'Alt' },
        { fieldName: 'Phone number', slug: 'phone_number', value: '030 1234567' },
        { fieldName: 'Company name', slug: 'company_name', value: 'Muster GmbH' },
        { fieldName: 'City', slug: 'city', value: 'Berlin' },
        { fieldName: 'Lieblingsfarbe', slug: 'lieblingsfarbe', value: 'Blau' },
      ],
      tags: [{ id: 1, name: 'Kunde' }, { id: 2, name: 'VIP' }],
    },
    { id: 102, email: 'ben@example.com', registeredAt: '2024-02-01T10:00:00+00:00', locale: 'de', sourceURL: null, unsubscribed: true, bounced: false, needsConfirmation: false, fields: [{ fieldName: 'First name', slug: 'first_name', value: 'Ben' }], tags: [{ id: 3, name: 'Webinar' }] },
    { id: 103, email: 'cleo@example.com', registeredAt: '2024-03-01T10:00:00+00:00', locale: 'en', sourceURL: null, unsubscribed: false, bounced: true, needsConfirmation: false, fields: [], tags: [] },
    { id: 104, email: 'dirk@example.com', registeredAt: '2024-04-01T10:00:00+00:00', locale: 'de', sourceURL: 'https://meinshop.systeme.io/ebook', unsubscribed: false, bounced: false, needsConfirmation: true, fields: [{ fieldName: 'First name', slug: 'first_name', value: 'Dirk' }], tags: [] },
    { id: 105, email: 'emil@example.com', registeredAt: '2024-05-01T10:00:00+00:00', locale: 'de', sourceURL: null, unsubscribed: false, bounced: false, needsConfirmation: false, fields: [], tags: [{ id: 1, name: 'Kunde' }] },
  ];
  products = [
    { id: 201, name: 'Kurs-Paket', source: 'funnel', createdAt: '2024-01-01T10:00:00Z', pricePlansCount: 3, resourcesCount: 2, confirmationEmailId: null },
    { id: 202, name: 'Coaching', source: 'digital-store', createdAt: '2024-02-01T10:00:00Z', pricePlansCount: 1, resourcesCount: 0, confirmationEmailId: null },
  ];
  productDetail: Record<string, any> = {
    '201': {
      id: 201,
      name: 'Kurs-Paket',
      source: 'funnel',
      createdAt: '2024-01-01T10:00:00Z',
      resources: [
        { id: 1, type: 'membership_course', courseId: 401, value: null, createdAt: '2024-01-01T10:00:00Z' },
        { id: 2, type: 'systemeio_tag', value: 'Kunde', createdAt: '2024-01-01T10:00:00Z' },
      ],
      pricePlans: [
        { id: 301, name: 'Einmalzahlung', innerName: 'einmal', type: 'one_shot', amount: 19900, currency: 'eur', recurringOptions: null, category: 'digital', taxBehavior: 'inclusive' },
        { id: 302, name: 'Monatlich', innerName: 'monat', type: 'subscription', amount: 2900, currency: 'eur', recurringOptions: { id: 1, trialPeriod: 0, trialInterval: 'day', interval: 'month', intervalCount: 1, limitOfPayments: null }, category: 'digital', taxBehavior: 'inclusive' },
        { id: 303, name: 'Quartal', innerName: 'quartal', type: 'subscription', amount: 7900, currency: 'eur', recurringOptions: { id: 2, trialPeriod: 0, trialInterval: 'day', interval: 'month', intervalCount: 3, limitOfPayments: null }, category: 'digital', taxBehavior: 'inclusive' },
      ],
    },
    '202': {
      id: 202,
      name: 'Coaching',
      source: 'digital-store',
      createdAt: '2024-02-01T10:00:00Z',
      resources: [],
      pricePlans: [{ id: 304, name: 'Raten', innerName: 'raten', type: 'limited_subscription', amount: 5000, currency: 'eur', recurringOptions: { id: 3, trialPeriod: 7, trialInterval: 'day', interval: 'month', intervalCount: 1, limitOfPayments: 6 }, category: 'digital', taxBehavior: 'exclusive' }],
    },
  };
  courses = [{ id: 401, locale: 'de', domainName: 'meinshop.systeme.io', path: 'fotokurs', active: true, name: 'Fotokurs', description: '<p>Lerne <b>Licht</b></p>', modules: [{ id: 41, name: 'Start' }, { id: 42, name: 'Praxis' }] }];
  curriculum: Record<string, any> = {
    '401': {
      items: [
        {
          courseId: 401,
          courseType: 'classic_course',
          modules: [
            { id: 42, name: 'Praxis', position: 2, lectures: [{ id: 423, name: 'Übung', active: true, position: 1, delayBeforePreviousLecture: 0 }] },
            {
              id: 41,
              name: 'Start',
              position: 1,
              lectures: [
                { id: 412, name: 'Blende', active: true, position: 2, delayBeforePreviousLecture: 2 },
                { id: 411, name: 'Willkommen', active: true, position: 1, delayBeforePreviousLecture: 0 },
                { id: 413, name: 'Entwurf', active: false, position: 3, delayBeforePreviousLecture: 0 },
              ],
            },
          ],
        },
      ],
      hasMore: false,
    },
  };
  enrollments = [
    { id: 1, contact: { id: 101, email: 'anna@example.com', registeredAt: '2024-01-05T10:00:00+00:00', locale: 'de', sourceURL: null, unsubscribed: false, bounced: false, needsConfirmation: false }, course: { id: 401, name: 'Fotokurs', path: 'fotokurs', locale: 'de', active: true }, accessType: 'full', active: true },
    { id: 2, contact: { id: 102, email: 'ben@example.com', registeredAt: '2024-02-01T10:00:00+00:00', locale: 'de', sourceURL: null, unsubscribed: true, bounced: false, needsConfirmation: false }, course: { id: 401, name: 'Fotokurs', path: 'fotokurs', locale: 'de', active: true }, accessType: 'full', active: false },
    { id: 3, contact: { id: 999, email: 'fremd@example.com', registeredAt: '2024-06-01T10:00:00+00:00', locale: 'de', sourceURL: null, unsubscribed: false, bounced: false, needsConfirmation: false }, course: { id: 401, name: 'Fotokurs', path: 'fotokurs', locale: 'de', active: true }, accessType: 'full', active: true },
  ];
  communities = [{ id: 501, name: 'Foto-Club', domainName: 'meinshop.systeme.io', path: 'club' }];
  memberships = [{ id: 1, community: { id: 501, name: 'Foto-Club', domainName: 'meinshop.systeme.io', path: 'club' }, contact: { id: 101 } }];
  newsletters = [
    { id: 601, type: 'regular', content: { subject: 'Neuigkeiten im Mai', previewText: 'Was neu ist', editorType: 'classic', senderEmail: 'chef@meinshop.de', senderName: 'Chef' }, state: { isSent: true } },
    { id: 602, type: 'regular', content: { subject: 'Visuell gebaut', previewText: null, editorType: 'visual', senderEmail: 'chef@meinshop.de', senderName: 'Chef' }, state: { isSent: false } },
  ];
  newsletterBody: Record<string, string | null> = { '601': '<p>Hallo {{contact.first_name}}, bis bald. {{contact.hobby}}</p>', '602': null };
  campaigns = [{ id: 701, name: 'Willkommensfolge', senderEmail: 'chef@meinshop.de' }];
  campaignSteps: Record<string, any[]> = {
    '701': [
      { id: 7012, campaignId: 701, content: { subject: 'Tipp 1', previewText: null, editorType: 'classic', senderEmail: 'chef@meinshop.de', senderName: 'Chef' }, state: { isActive: true, position: 2 } },
      { id: 7011, campaignId: 701, content: { subject: 'Willkommen', previewText: null, editorType: 'classic', senderEmail: 'chef@meinshop.de', senderName: 'Chef' }, state: { isActive: true, position: 1 } },
    ],
  };
  campaignStepDetail: Record<string, any> = {
    '7011': { id: 7011, campaignId: 701, comment: null, content: { subject: 'Willkommen', previewText: null, editorType: 'classic', bodyHtml: '<p>Hi {{contact.first_name}}</p>', bodyJson: null, senderEmail: 'chef@meinshop.de', senderName: 'Chef' }, state: { isActive: true, position: 1 }, activation: { afterStepId: null, delay: null, sendAtLocalTime: null, skipWeekdays: [] } },
    '7012': { id: 7012, campaignId: 701, comment: null, content: { subject: 'Tipp 1', previewText: null, editorType: 'visual', bodyHtml: null, bodyJson: ['x'], senderEmail: 'chef@meinshop.de', senderName: 'Chef' }, state: { isActive: true, position: 2 }, activation: { afterStepId: 7011, delay: { value: 2, unit: 'day' }, sendAtLocalTime: '09:00', skipWeekdays: [] } },
  };
  rules = [
    { id: 801, triggers: [{ type: 'tag_added' }], actions: [{ type: 'add_tag' }], state: { isActive: true } },
    { id: 802, triggers: [{ type: 'new_sale' }], actions: [{ type: 'enroll_in_course' }], state: { isActive: false } },
    { id: 803, triggers: [{ type: 'page_visited' }], actions: [{ type: 'send_sms' }], state: { isActive: true } },
  ];
  ruleDetail: Record<string, any> = {
    '801': { id: 801, triggers: [{ type: 'tag_added', tagId: 1 }], actions: [{ type: 'add_tag', tagId: 2 }, { type: 'subscribe_to_campaign', campaignId: 701 }], state: { isActive: true } },
    '802': { id: 802, triggers: [{ type: 'new_sale' }], actions: [{ type: 'enroll_in_course', courseId: 401 }, { type: 'send_webhook', url: 'https://hooks.example.com/x' }], state: { isActive: false } },
    '803': { id: 803, triggers: [{ type: 'page_visited' }], actions: [{ type: 'send_sms', message: 'Hallo!' }], state: { isActive: true } },
  };
  funnels = [
    { id: 901, name: 'Webinar-Funnel', isActive: true, saleSettingsId: 'ss-1' },
    { id: 902, name: 'Alter Funnel', isActive: false, saleSettingsId: null },
  ];
  funnelSteps: Record<string, any[]> = {
    '901': [
      { id: 9012, name: 'Danke', type: 'opt_in_thank_you_page', pageId: 2, url: 'https://meinshop.systeme.io/danke', position: 2, offerId: null },
      { id: 9011, name: 'Anmeldung', type: 'squeeze', pageId: 1, url: 'https://meinshop.systeme.io/webinar-anmeldung', position: 1, offerId: null },
    ],
    '902': [],
  };

  authOk(r: Req) {
    return r.headers['x-api-key'] === SYS_KEY && r.url.hostname === 'api.systeme.io' && !r.url.searchParams.has('api_key');
  }

  /** limit (10–100 in reality; capped here so every list needs several pages) + startingAfter + order. */
  private page<T extends { id: number }>(list: T[], u: URL) {
    const asc = u.searchParams.get('order') === 'asc';
    const sorted = [...list].sort((a, b) => (asc ? a.id - b.id : b.id - a.id));
    const after = Number(u.searchParams.get('startingAfter') ?? 0);
    const rest = after ? sorted.filter((x) => (asc ? x.id > after : x.id < after)) : sorted;
    const size = Math.min(Number(u.searchParams.get('limit') ?? 10), this.pageCap);
    return json(200, { items: rest.slice(0, size), hasMore: rest.length > size });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/api/, '');
    const u = r.url;
    if (p === '/contacts') return this.page(this.contacts, u);
    if (p === '/contact_fields') return json(200, { items: this.contactFields, hasMore: false });
    if (p === '/tags') return this.page(this.tags, u);
    if (p === '/domains') return this.page(this.domains, u);
    if (p === '/payment/digital-products') return this.page(this.products, u);
    let m = /^\/payment\/digital-products\/(\d+)$/.exec(p);
    if (m) return this.productDetail[m[1]] ? json(200, this.productDetail[m[1]]) : json(404, { detail: 'Not found' });
    if (p === '/school/courses') return this.page(this.courses, u);
    m = /^\/school\/courses\/(\d+)\/modules-with-lectures$/.exec(p);
    if (m) return this.curriculum[m[1]] ? json(200, this.curriculum[m[1]]) : json(404, { detail: 'Not found' });
    if (p === '/school/enrollments') return this.page(this.enrollments, u);
    if (p === '/community/communities') return this.page(this.communities, u);
    if (p === '/community/memberships') return this.page(this.memberships, u);
    if (p === '/mailing/newsletters') return this.page(this.newsletters, u);
    m = /^\/mailing\/newsletters\/(\d+)$/.exec(p);
    if (m) {
      const n = this.newsletters.find((x) => x.id === Number(m![1]));
      return n ? json(200, { ...n, content: { ...n.content, bodyHtml: this.newsletterBody[m[1]], bodyJson: null } }) : json(404, { detail: 'Not found' });
    }
    if (p === '/mailing/campaigns') return this.page(this.campaigns, u);
    m = /^\/mailing\/campaigns\/(\d+)\/steps$/.exec(p);
    if (m) return this.page(this.campaignSteps[m[1]] ?? [], u);
    m = /^\/mailing\/campaign-steps\/(\d+)$/.exec(p);
    if (m) return this.campaignStepDetail[m[1]] ? json(200, this.campaignStepDetail[m[1]]) : json(404, { detail: 'Not found' });
    if (p === '/automation/rules') return this.page(this.rules, u);
    m = /^\/automation\/rules\/(\d+)$/.exec(p);
    if (m) return this.ruleDetail[m[1]] ? json(200, this.ruleDetail[m[1]]) : json(404, { detail: 'Not found' });
    if (p === '/funnels') return this.page(this.funnels, u);
    m = /^\/funnels\/(\d+)\/steps$/.exec(p);
    if (m) return this.page(this.funnelSteps[m[1]] ?? [], u);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Klaviyo REST API (https://a.klaviyo.com/api, revision header, JSON:API with page[cursor] and links.next)
// ---------------------------------------------------------------------------------------------------------------

export const KLAVIYO_KEY = 'pk_4f8a1c7e92b05d3a6e1f8c4b7d2a90e53b';

const cursorOf = (n: number) => Buffer.from(`o:${n}`).toString('base64url');
const offsetOf = (c: string | null) => (c ? Number(Buffer.from(c, 'base64url').toString().slice(2)) : 0);

const kProfile = (id: string, a: Record<string, any>) => ({
  type: 'profile',
  id,
  attributes: { email: null, phone_number: null, external_id: null, first_name: null, last_name: null, organization: null, locale: null, title: null, image: null, created: '2024-01-10T10:00:00+00:00', updated: '2024-06-10T10:00:00+00:00', last_event_date: null, location: {}, properties: {}, ...a },
  links: { self: `https://a.klaviyo.com/api/profiles/${id}/` },
});
const sub = (consent: string, o: Record<string, any> = {}) => ({ can_receive_email_marketing: consent === 'SUBSCRIBED', consent, consent_timestamp: consent === 'NEVER_SUBSCRIBED' ? null : '2024-02-01T09:00:00+00:00', last_updated: '2024-02-01T09:00:00+00:00', method: null, method_detail: '', custom_method_detail: null, double_optin: null, suppression: [], list_suppressions: [], ...o });

export class FakeKlaviyo extends FakeVendor {
  pageCap = 2;
  profiles = [
    kProfile('01HANNA', { email: 'anna@example.com', phone_number: '+4930123456', first_name: 'Anna', last_name: 'Alt', organization: 'Muster GmbH', title: 'Inhaberin', locale: 'de-DE', created: '2024-01-10T10:00:00+00:00', location: { address1: 'Hauptstr. 1', address2: null, city: 'Berlin', country: 'Germany', region: 'BE', zip: '10115' }, properties: { lieblingsfarbe: 'Blau', kundennummer: 1042, $source: 'Shopify', letzter_kauf: '2024-05-01T10:00:00+00:00' }, subscriptions: { email: { marketing: sub('SUBSCRIBED', { method: 'Klaviyo Form', method_detail: 'Footer-Formular', double_optin: true }) }, sms: { marketing: { can_receive_sms_marketing: true, consent: 'SUBSCRIBED', consent_timestamp: '2024-03-01T09:00:00+00:00', method: 'Klaviyo Form', method_detail: 'SMS-Popup' } } } }),
    kProfile('01HBEN', { email: 'ben@example.com', first_name: 'Ben', last_name: 'Bau', created: '2024-01-11T10:00:00+00:00', subscriptions: { email: { marketing: sub('SUBSCRIBED', { method: 'API', consent_timestamp: '2024-01-11T10:00:00+00:00' }) } } }),
    kProfile('01HCLEO', { email: 'cleo@example.com', first_name: 'Cleo', created: '2024-01-12T10:00:00+00:00', subscriptions: { email: { marketing: sub('UNSUBSCRIBED', { consent_timestamp: '2024-04-01T09:00:00+00:00' }) } } }),
    kProfile('01HDORA', { email: 'dora@example.com', first_name: 'Dora', created: '2024-01-13T10:00:00+00:00', subscriptions: { email: { marketing: sub('SUBSCRIBED', { can_receive_email_marketing: false, method: 'Klaviyo Form', suppression: [{ reason: 'SPAM_COMPLAINT', timestamp: '2024-05-05T09:00:00+00:00' }] }) } } }),
    kProfile('01HEMIL', { email: 'emil@example.com', first_name: 'Emil', created: '2024-01-14T10:00:00+00:00', subscriptions: { email: { marketing: sub('NEVER_SUBSCRIBED') } } }),
    kProfile('01HFRIDA', { phone_number: '+4915112345678', first_name: 'Frida', created: '2024-01-15T10:00:00+00:00', subscriptions: { sms: { marketing: { can_receive_sms_marketing: true, consent: 'SUBSCRIBED', consent_timestamp: '2024-03-02T09:00:00+00:00', method: 'API' } } } }),
  ];
  lists = [
    { type: 'list', id: 'LNEWS', attributes: { name: 'Newsletter', created: '2024-01-01T00:00:00+00:00', updated: '2024-01-01T00:00:00+00:00', opt_in_process: 'double_opt_in' } },
    { type: 'list', id: 'LVIP', attributes: { name: 'VIP', created: '2024-01-01T00:00:00+00:00', updated: '2024-01-01T00:00:00+00:00', opt_in_process: 'single_opt_in' } },
  ];
  listMembers: Record<string, string[]> = { LNEWS: ['01HANNA', '01HBEN', '01HCLEO'], LVIP: ['01HANNA'] };
  segments = [{ type: 'segment', id: 'SKAEUFER', attributes: { name: 'Aktive Käufer', created: '2024-01-01T00:00:00+00:00', updated: '2024-01-01T00:00:00+00:00', is_active: true, is_processing: false, is_starred: false } }];
  segmentMembers: Record<string, string[]> = { SKAEUFER: ['01HANNA', '01HEMIL'] };
  flowActions: Record<string, any> = {
    A1: { type: 'flow-action', id: 'A1', attributes: { action_type: 'SEND_EMAIL', status: 'live' } },
    A2: { type: 'flow-action', id: 'A2', attributes: { action_type: 'TIME_DELAY', status: 'live' } },
    A3: { type: 'flow-action', id: 'A3', attributes: { action_type: 'SEND_EMAIL', status: 'live' } },
    A4: { type: 'flow-action', id: 'A4', attributes: { action_type: 'SEND_EMAIL', status: 'draft' } },
    A5: { type: 'flow-action', id: 'A5', attributes: { action_type: 'CONDITIONAL_SPLIT', status: 'draft' } },
  };
  flows = [
    { type: 'flow', id: 'FWELCOME', attributes: { name: 'Willkommens-Serie', status: 'live', archived: false, trigger_type: 'List', created: '2024-01-01T00:00:00+00:00', updated: '2024-02-01T00:00:00+00:00' }, relationships: { 'flow-actions': { data: [{ type: 'flow-action', id: 'A1' }, { type: 'flow-action', id: 'A2' }, { type: 'flow-action', id: 'A3' }] } } },
    { type: 'flow', id: 'FCART', attributes: { name: 'Warenkorb | Abbruch', status: 'draft', archived: false, trigger_type: 'Metric', created: '2024-01-01T00:00:00+00:00', updated: '2024-02-01T00:00:00+00:00' }, relationships: { 'flow-actions': { data: [{ type: 'flow-action', id: 'A4' }, { type: 'flow-action', id: 'A5' }] } } },
  ];
  templates = [
    { type: 'template', id: 'TNEWS', attributes: { name: 'Newsletter Vorlage', editor_type: 'CODE', html: '<html><body><p>Hallo {{ first_name|default:"du" }}, {% if person.city %}in {{ person.city }}{% endif %}</p><a href="{% unsubscribe_link %}">abmelden</a></body></html>', text: 'Hallo' } },
    { type: 'template', id: 'TEMPTY', attributes: { name: 'Drag-and-drop ohne HTML', editor_type: 'USER_DRAGGABLE', html: '', text: '' } },
    { type: 'template', id: 'TPLAIN', attributes: { name: 'Schlicht', editor_type: 'SIMPLE', html: '<p>{{ email }}</p>', text: '' } },
  ];

  authOk(r: Req) {
    return r.headers.authorization === `Klaviyo-API-Key ${KLAVIYO_KEY}` && /^\d{4}-\d{2}-\d{2}/.test(r.headers.revision ?? '') && r.url.hostname === 'a.klaviyo.com';
  }

  private page(items: any[], r: Req, opts: { included?: (page: any[]) => any[]; only?: string[] } = {}) {
    const size = Math.min(Number(r.url.searchParams.get('page[size]') ?? 20), this.pageCap);
    const at = offsetOf(r.url.searchParams.get('page[cursor]'));
    const slice = items.slice(at, at + size);
    const next = at + size < items.length ? new URL(r.url.toString()) : undefined;
    next?.searchParams.set('page[cursor]', cursorOf(at + size));
    const data = opts.only ? slice.map((x) => ({ ...x, attributes: Object.fromEntries(Object.entries(x.attributes).filter(([k]) => opts.only!.includes(k))) })) : slice;
    return json(200, { data, ...(opts.included ? { included: opts.included(slice) } : {}), links: { self: r.url.toString(), next: next?.toString() ?? null, prev: null } });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/api/, '').replace(/\/$/, '');
    if (p === '/accounts') return json(200, { data: [{ type: 'account', id: 'AbC123', attributes: { contact_information: { organization_name: 'Muster GmbH', default_sender_name: 'Muster' }, timezone: 'Europe/Berlin' } }], links: { self: r.url.toString() } });
    if (p === '/profiles') {
      const only = r.url.searchParams.get('fields[profile]');
      return this.page(this.profiles, r, only ? { only: only.split(',') } : {});
    }
    if (p === '/lists') return this.page(this.lists, r);
    let m = /^\/lists\/([A-Z]+)\/profiles$/.exec(p);
    if (m) return this.page(this.profiles.filter((x) => (this.listMembers[m![1]] ?? []).includes(x.id)), r, { only: ['email'] });
    if (p === '/segments') return this.page(this.segments, r);
    m = /^\/segments\/([A-Z]+)\/profiles$/.exec(p);
    if (m) return this.page(this.profiles.filter((x) => (this.segmentMembers[m![1]] ?? []).includes(x.id)), r, { only: ['email'] });
    if (p === '/flows') return this.page(this.flows, r, r.url.searchParams.get('include') === 'flow-actions' ? { included: (slice) => slice.flatMap((f) => f.relationships['flow-actions'].data.map((a: any) => this.flowActions[a.id])) } : {});
    if (p === '/templates') return this.page(this.templates, r);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Brevo API v3 (https://api.brevo.com/v3, api-key header, limit/offset, count)
// ---------------------------------------------------------------------------------------------------------------

export const BREVO_KEY = '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';

export class FakeBrevo extends FakeVendor {
  pageCap = 2;
  attributes = [
    { name: 'FIRSTNAME', category: 'normal', type: 'text' },
    { name: 'LASTNAME', category: 'normal', type: 'text' },
    { name: 'SMS', category: 'normal', type: 'text' },
    { name: 'COMPANY', category: 'normal', type: 'text' },
    { name: 'GEBURTSTAG', category: 'normal', type: 'date' },
    { name: 'ANZAHL_KAEUFE', category: 'normal', type: 'float' },
    { name: 'GESCHLECHT', category: 'category', type: 'category', enumeration: [{ value: 1, label: 'Weiblich', valueStr: '1' }, { value: 2, label: 'Männlich', valueStr: '2' }] },
    { name: 'DOUBLE_OPT-IN', category: 'category', type: 'category', enumeration: [{ value: 1, label: 'Yes', valueStr: '1' }, { value: 2, label: 'No', valueStr: '2' }] },
    { name: 'OPT_IN_ID', category: 'normal', type: 'id' },
    { name: 'GEWICHTET', category: 'calculated', type: 'float', calculatedValue: 'a*b' },
    { name: 'ORDER_ID', category: 'transactional', type: 'id' },
  ];
  contacts: any[] = [
    { id: 1, email: 'anna@example.com', emailBlacklisted: false, smsBlacklisted: false, createdAt: '2024-01-05T10:00:00.000+01:00', modifiedAt: '2024-06-05T10:00:00.000+01:00', listIds: [1, 2], listUnsubscribed: null, attributes: { FIRSTNAME: 'Anna', LASTNAME: 'Alt', SMS: '+4915112345678', COMPANY: 'Muster GmbH', GEBURTSTAG: '1985-05-17', ANZAHL_KAEUFE: 3, GESCHLECHT: 1, 'DOUBLE_OPT-IN': 'Yes' } },
    { id: 2, email: 'ben@example.com', emailBlacklisted: true, smsBlacklisted: false, createdAt: '2024-02-05T10:00:00.000+01:00', modifiedAt: '2024-03-05T10:00:00.000+01:00', listIds: [1], listUnsubscribed: null, attributes: { FIRSTNAME: 'Ben' } },
    { id: 3, email: 'cleo@example.com', emailBlacklisted: false, smsBlacklisted: false, createdAt: '2024-03-05T10:00:00.000+01:00', modifiedAt: '2024-03-05T10:00:00.000+01:00', listIds: [1, 2], listUnsubscribed: [2], attributes: { FIRSTNAME: 'Cleo', 'DOUBLE_OPT-IN': 'No' } },
    { id: 4, email: 'dora@example.com', emailBlacklisted: false, smsBlacklisted: true, createdAt: '2024-04-05T10:00:00.000+01:00', modifiedAt: '2024-05-05T10:00:00.000+01:00', listIds: [1], listUnsubscribed: null, attributes: { FIRSTNAME: 'Dora', SMS: '+4915198765432' } },
    { id: 5, email: 'emil@example.com', emailBlacklisted: false, smsBlacklisted: false, createdAt: '2024-05-05T10:00:00.000+01:00', modifiedAt: '2024-05-05T10:00:00.000+01:00', listIds: [], listUnsubscribed: null, attributes: {} },
  ];
  lists = [
    { id: 1, name: 'Newsletter', totalBlacklisted: 0, totalSubscribers: 0, uniqueSubscribers: 4, folderId: 1 },
    { id: 2, name: 'Kunden', totalBlacklisted: 0, totalSubscribers: 0, uniqueSubscribers: 2, folderId: 1 },
  ];
  segments = [{ id: 7, segmentName: 'Aktive', categoryName: 'Standard', updatedAt: '2024-06-01T10:00:00.000Z' }];
  segmentMembers: Record<string, number[]> = { '7': [1, 4] };
  templates = [
    { id: 3, name: 'Willkommen', subject: 'Hallo {{ contact.FIRSTNAME }}', isActive: true, testSent: false, sender: { id: 1, name: 'Chef', email: 'chef@example.com' }, replyTo: 'chef@example.com', toField: '{FIRSTNAME}', tag: '', htmlContent: '<html><body><p>Hallo {{ contact.FIRSTNAME }} aus {{ contact.CITY }}</p><a href="{{ unsubscribe }}">abmelden</a></body></html>', createdAt: '2024-01-01T10:00:00.000Z', modifiedAt: '2024-01-01T10:00:00.000Z' },
    { id: 4, name: 'Leer', subject: 'Leer', isActive: true, htmlContent: '', createdAt: '2024-01-02T10:00:00.000Z', modifiedAt: '2024-01-02T10:00:00.000Z' },
    { id: 5, name: 'Schlicht', subject: 'Schlicht', isActive: false, htmlContent: '<p>{{ contact.EMAIL }}</p>', createdAt: '2024-01-03T10:00:00.000Z', modifiedAt: '2024-01-03T10:00:00.000Z' },
  ];

  authOk(r: Req) {
    return r.headers['api-key'] === BREVO_KEY && r.url.hostname === 'api.brevo.com';
  }

  private page(list: any[], r: Req, key: string) {
    const size = Math.min(Number(r.url.searchParams.get('limit') ?? 50), this.pageCap);
    const off = Number(r.url.searchParams.get('offset') ?? 0);
    const sorted = r.url.searchParams.get('sort') === 'asc' ? [...list].sort((a, b) => a.id - b.id) : [...list].sort((a, b) => b.id - a.id);
    return json(200, { [key]: sorted.slice(off, off + size), count: list.length });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/v3/, '');
    if (p === '/account') return json(200, { email: 'chef@example.com', firstName: 'Chef', lastName: 'Muster', companyName: 'Muster GmbH', plan: [{ type: 'free', credits: 300 }] });
    if (p === '/contacts/attributes') return json(200, { attributes: this.attributes });
    if (p === '/contacts/lists') return this.page(this.lists, r, 'lists');
    if (p === '/contacts/segments') return this.page(this.segments, r, 'segments');
    if (p === '/contacts') {
      const seg = r.url.searchParams.get('segmentId');
      return this.page(seg ? this.contacts.filter((c) => (this.segmentMembers[seg] ?? []).includes(c.id)) : this.contacts, r, 'contacts');
    }
    if (p === '/smtp/templates') return this.page(this.templates, r, 'templates');
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// KlickTipp REST API (https://api.klicktipp.com, session cookie after POST /account/login, JSON)
// ---------------------------------------------------------------------------------------------------------------

export const KT_USER = 'umzug@example.com';
export const KT_PASS = 'geheim mit Leerzeichen 9x!';
const KT_SESS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

export class FakeKlickTipp extends FakeVendor {
  /** Some accounts have no bulk call: it answers 404 and the importer reads one subscriber at a time. */
  noBulk = false;
  subscribers: any[] = [
    { id: 1, email: 'anna@example.com', status: 'Subscribed', bounce: 'Not Bounced', optin: 1706778000, date: 1706778000, fieldFirstName: 'Anna', fieldLastName: 'Alt', fieldCompanyName: 'Muster GmbH', fieldStreet1: 'Hauptstr. 1', fieldZip: '10115', fieldCity: 'Berlin', fieldCountry: 'DE', fieldMobilePhone: '+49 151 1234567', fieldBirthday: 484099200, field101: 'Blau', field102: 1042, field103: 1699920000, field104: 1999 },
    { id: 2, email: 'ben@example.com', status: 'Subscribed', bounce: 'Not Bounced', date: 1709290000, fieldFirstName: 'Ben' },
    { id: 3, email: 'cleo@example.com', status: 'Pending', bounce: 'Not Bounced', date: 1711968400, fieldFirstName: 'Cleo' },
    { id: 4, email: 'dora@example.com', status: 'Subscribed', bounce: 'Hard Bounce', date: 1714560400, fieldFirstName: 'Dora' },
    { id: 5, email: 'emil@example.com', status: 'Unsubscribed', bounce: 'Not Bounced', date: 1717238800, unsubscribed: 1719000000, fieldFirstName: 'Emil' },
  ];
  /** Only these are in the account's list (KlickTipp lists the active subscribers). */
  listed = [1, 2, 3, 4];
  tags: Record<string, string> = { '11': 'Käufer', '12': 'Webinar' };
  tagged: Record<string, Record<string, number>> = { '11': { '1': 1706778000 }, '12': { '1': 1706778100, '2': 1709290100, '99': 1709290200 } };
  fields: Record<string, string> = { field101: 'Lieblingsfarbe', field102: 'Kundennummer', field103: 'Kunde seit', field104: 'Preis (Dezimal)' };

  authOk(r: Req) {
    return r.path === '/account/login' || (r.headers.cookie ?? '') === `SESSklick=${KT_SESS}`;
  }

  handle(r: Req): Response | undefined {
    if (r.path === '/account/login') {
      const b = r.body ?? {};
      if (b.username === KT_USER && b.password === KT_PASS) return json(200, { sessid: KT_SESS, session_name: 'SESSklick', user: { uid: '7', name: KT_USER } });
      return json(406, ['Wrong username or password.']);
    }
    if (r.path === '/subscriber' && r.method === 'GET') return json(200, this.listed);
    let m = /^\/subscriber\/bulk\/([\d,]+)$/.exec(r.path);
    if (m) {
      if (this.noBulk) return json(404, ['Not found']);
      const ids = m[1].split(',').map(Number);
      return json(200, this.subscribers.filter((s) => ids.includes(s.id)));
    }
    m = /^\/subscriber\/(\d+)$/.exec(r.path);
    if (m) {
      const s = this.subscribers.find((x) => x.id === Number(m![1]));
      return s ? json(200, s) : json(404, ['Not found']);
    }
    if (r.path === '/tag') return json(200, this.tags);
    if (r.path === '/field') return json(200, this.fields);
    if (r.path === '/subscriber/tagged' && r.method === 'POST') return json(200, this.tagged[String(r.body?.tagid)] ?? {});
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ManyChat Page API (https://api.manychat.com, Bearer <page id>:<token>, { status, data })
// ---------------------------------------------------------------------------------------------------------------

export const MANYCHAT_KEY = '1234567890123:9f3a7c1e5b2d48a6c0e9f1b3d5a7c924';

export class FakeManyChat extends FakeVendor {
  tags = [{ id: 101, name: 'Lead' }, { id: 102, name: 'Kunde' }, { id: 103, name: 'Webinar | Mai' }];
  customFields = [
    { id: 201, name: 'Lieblingsfarbe', type: 'text', description: 'Aus dem Quiz' },
    { id: 202, name: 'Budget', type: 'number', description: '' },
  ];
  botFields = [{ id: 301, name: 'stripe_key', type: 'text', description: '', value: 'sk_live_GEHEIM_4711' }, { id: 302, name: 'angebot_bis', type: 'date', description: '', value: '2025-01-01' }];
  flows = [
    { ns: 'content20240101120000_111111', name: 'Willkommen', folder_id: null },
    { ns: 'content20240102120000_222222', name: 'Quiz Auswertung', folder_id: 7 },
  ];
  folders = [{ id: 7, name: 'Funnel A', parent_id: null }];

  authOk(r: Req) {
    return r.headers.authorization === `Bearer ${MANYCHAT_KEY}` && r.url.hostname === 'api.manychat.com';
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/fb/, '');
    if (p === '/page/getInfo') return json(200, { status: 'success', data: { id: '1234567890123', name: 'Muster Coaching', category: 'Business', username: 'muster', is_pro: true, timezone: 'UTC+01:00' } });
    if (p === '/page/getTags') return json(200, { status: 'success', data: this.tags });
    if (p === '/page/getCustomFields') return json(200, { status: 'success', data: this.customFields });
    if (p === '/page/getBotFields') return json(200, { status: 'success', data: this.botFields });
    if (p === '/page/getFlows') return json(200, { status: 'success', data: { flows: this.flows, folders: this.folders } });
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Zendesk Support + Guide API v2 (https://<subdomain>.zendesk.com/api/v2, Basic <email>/token:<token>, cursor pagination)
// ---------------------------------------------------------------------------------------------------------------

export const ZD_EMAIL = 'admin@muster.example.com';
export const ZD_TOKEN = 'fake-zd-9f3a7c1e5b2d48a6c0e9f1b3d5a7c92Qw';

const zdc = (n: number) => Buffer.from(`c:${n}`).toString('base64url');
const zdo = (c: string | null) => (c ? Number(Buffer.from(c, 'base64url').toString().slice(2)) : 0);

export class FakeZendesk extends FakeVendor {
  pageCap = 2;
  users: any[] = [
    { id: 1, name: 'Anna Alt', email: 'anna@example.com', phone: '+49 30 1234567', role: 'end-user', organization_id: 10, tags: ['vip'], notes: 'Wichtige Kundin', details: '', time_zone: 'Berlin', locale: 'de', created_at: '2023-01-05T10:00:00Z', user_fields: { kundennummer: 'K-1042', geburtstag: '1985-05-05' } },
    { id: 2, name: 'Ben Bau', email: 'ben@example.com', phone: null, role: 'end-user', organization_id: null, tags: [], notes: '', details: '', time_zone: 'Berlin', locale: 'de', created_at: '2023-02-05T10:00:00Z', user_fields: {} },
    { id: 90, name: 'Agnes Agent', email: 'agnes@muster.example.com', role: 'agent', created_at: '2022-01-01T10:00:00Z' },
    { id: 91, name: 'Chef Admin', email: ZD_EMAIL, role: 'admin', created_at: '2022-01-01T10:00:00Z' },
  ];
  /** Requesters of tickets who are not in the user list the import reads (people who wrote once). */
  extraUsers: any[] = [{ id: 77, name: 'Fremd Person', email: 'fremd@example.com', role: 'end-user' }];
  organizations = [{ id: 10, name: 'Muster GmbH', domain_names: ['muster.example.com'], details: '', notes: '', tags: [], created_at: '2022-05-01T10:00:00Z' }];
  userFields = [
    { id: 1, key: 'kundennummer', type: 'text', title: 'Kundennummer', active: true },
    { id: 2, key: 'geburtstag', type: 'date', title: 'Geburtstag', active: true },
    { id: 3, key: 'alt', type: 'text', title: 'Veraltet', active: false },
  ];
  tickets: any[] = [
    { id: 500, subject: 'Rechnung fehlt', description: 'Hallo, wo ist meine Rechnung?', status: 'open', priority: 'high', type: 'question', requester_id: 1, assignee_id: 90, organization_id: 10, tags: ['rechnung', 'vip'], via: { channel: 'email' }, created_at: '2024-03-01T09:00:00Z', updated_at: '2024-03-02T09:00:00Z' },
    { id: 501, subject: 'Passwort vergessen', description: 'Ich komme nicht mehr rein', status: 'solved', priority: null, type: 'incident', requester_id: 2, assignee_id: 90, tags: [], via: { channel: 'web' }, created_at: '2024-03-03T09:00:00Z', updated_at: '2024-03-04T09:00:00Z' },
    { id: 502, subject: 'Frage zur Lieferung', description: 'Wann kommt das Paket?', status: 'pending', priority: 'urgent', requester_id: 77, assignee_id: null, tags: [], via: { channel: 'chat' }, created_at: '2024-03-05T09:00:00Z', updated_at: '2024-03-05T09:00:00Z' },
    { id: 503, subject: 'Intern: Server prüfen', description: 'Bitte Backup prüfen', status: 'hold', priority: 'normal', requester_id: 91, assignee_id: 90, tags: ['intern'], via: { channel: 'web' }, created_at: '2024-03-06T09:00:00Z', updated_at: '2024-03-06T09:00:00Z' },
  ];
  comments: Record<string, any[]> = {
    '500': [
      { id: 5001, type: 'Comment', author_id: 1, body: 'Hallo, wo ist meine Rechnung?', plain_body: 'Hallo, wo ist meine Rechnung?', public: true, created_at: '2024-03-01T09:00:00Z', attachments: [] },
      { id: 5002, type: 'Comment', author_id: 90, body: 'Wir schauen nach.', plain_body: 'Wir schauen nach.', public: true, created_at: '2024-03-01T10:00:00Z', attachments: [] },
      { id: 5003, type: 'Comment', author_id: 90, body: 'Buchhaltung fragen', plain_body: 'Buchhaltung fragen', public: false, created_at: '2024-03-01T10:30:00Z', attachments: [] },
      { id: 5004, type: 'Comment', author_id: 1, body: 'Danke, hier die Bestellung', plain_body: 'Danke, hier die Bestellung', public: true, created_at: '2024-03-02T09:00:00Z', attachments: [{ id: 1, file_name: 'bestellung.pdf', content_url: 'https://muster.zendesk.com/attachments/token/abc/?name=bestellung.pdf' }] },
    ],
    '501': [
      { id: 5011, type: 'Comment', author_id: 2, body: 'Ich komme nicht mehr rein', plain_body: 'Ich komme nicht mehr rein', public: true, created_at: '2024-03-03T09:00:00Z', attachments: [] },
      { id: 5012, type: 'Comment', author_id: 90, html_body: '<p>Link zum <b>Zurücksetzen</b> ist unterwegs.</p>', body: 'Link zum Zurücksetzen ist unterwegs.', public: true, created_at: '2024-03-03T11:00:00Z', attachments: [] },
    ],
    '502': [{ id: 5021, type: 'Comment', author_id: 77, body: 'Wann kommt das Paket?', plain_body: 'Wann kommt das Paket?', public: true, created_at: '2024-03-05T09:00:00Z', attachments: [] }],
    '503': [{ id: 5031, type: 'Comment', author_id: 91, body: 'Bitte Backup prüfen', plain_body: 'Bitte Backup prüfen', public: false, created_at: '2024-03-06T09:00:00Z', attachments: [] }],
  };
  categories = [{ id: 20, name: 'Hilfe', description: '' }, { id: 21, name: 'Produkt', description: 'Funktionen' }];
  sections = [
    { id: 30, category_id: 20, name: 'Erste Schritte', description: '<p>Los geht’s</p>' },
    { id: 31, category_id: 20, name: 'Abrechnung', description: '' },
    { id: 32, category_id: 21, name: 'Funktionen', description: '' },
  ];
  articles = [
    { id: 40, title: 'Konto anlegen', draft: false, section_id: 30, label_names: ['konto', 'start'], body: '<h2>Schritt 1</h2><p>Gehe auf <a href="https://muster.example.com/signup">Anmelden</a>.</p><img src="https://theme.zdassets.com/hc/x.png">', created_at: '2023-06-01T10:00:00Z', updated_at: '2023-06-02T10:00:00Z', locale: 'de' },
    { id: 41, title: 'Rechnung herunterladen', draft: false, section_id: 31, label_names: [], body: '<p>Unter <b>Konto</b> → Rechnungen.</p>', created_at: '2023-06-03T10:00:00Z', updated_at: '2023-06-03T10:00:00Z', locale: 'de' },
    { id: 42, title: 'Entwurf zur API', draft: true, section_id: 32, label_names: ['api'], body: '<ul><li>eins</li><li>zwei</li></ul>', created_at: '2023-06-04T10:00:00Z', updated_at: '2023-06-04T10:00:00Z', locale: 'de' },
  ];

  authOk(r: Req) {
    return r.headers.authorization === `Basic ${Buffer.from(`${ZD_EMAIL}/token:${ZD_TOKEN}`).toString('base64')}` && r.url.hostname === 'muster.zendesk.com';
  }

  private cursor(list: any[], r: Req, key: string, extra: Record<string, unknown> = {}) {
    const size = Math.min(Number(r.url.searchParams.get('page[size]') ?? 100), this.pageCap);
    const at = zdo(r.url.searchParams.get('page[after]'));
    const slice = list.slice(at, at + size);
    const more = at + size < list.length;
    return json(200, { [key]: slice, meta: { has_more: more, after_cursor: more ? zdc(at + size) : null, before_cursor: null }, links: { next: more ? `https://muster.zendesk.com${r.path}?page%5Bafter%5D=${zdc(at + size)}` : null }, ...extra });
  }

  handle(r: Req): Response | undefined {
    const p = r.path.replace(/^\/api\/v2/, '');
    if (p === '/users/me.json') return json(200, { user: this.users[3] });
    if (p === '/users/count.json') return json(200, { count: { value: this.users.length, refreshed_at: '2024-06-01T10:00:00Z' } });
    if (p === '/organizations/count.json') return json(200, { count: { value: this.organizations.length } });
    if (p === '/tickets/count.json') return json(200, { count: { value: this.tickets.length } });
    if (p === '/users.json') {
      const role = r.url.searchParams.get('role');
      return this.cursor(role ? this.users.filter((u) => u.role === role) : this.users, r, 'users');
    }
    if (p === '/organizations.json') return this.cursor(this.organizations, r, 'organizations');
    if (p === '/user_fields.json') return this.cursor(this.userFields, r, 'user_fields');
    if (p === '/tickets.json') {
      const size = Math.min(Number(r.url.searchParams.get('page[size]') ?? 100), this.pageCap);
      const at = zdo(r.url.searchParams.get('page[after]'));
      const slice = this.tickets.slice(at, at + size);
      const everyone = [...this.users, ...this.extraUsers];
      const ids = new Set(slice.flatMap((t) => [t.requester_id, t.assignee_id].filter(Boolean)));
      return this.cursor(this.tickets, r, 'tickets', { users: everyone.filter((u) => ids.has(u.id)) });
    }
    const m = /^\/tickets\/(\d+)\/comments\.json$/.exec(p);
    if (m) {
      const list = this.comments[m[1]] ?? [];
      const everyone = [...this.users, ...this.extraUsers];
      const ids = new Set(list.map((c) => c.author_id));
      return this.cursor(list, r, 'comments', { users: everyone.filter((u) => ids.has(u.id)) });
    }
    if (p === '/help_center/categories.json') return this.cursor(this.categories, r, 'categories');
    if (p === '/help_center/sections.json') return this.cursor(this.sections, r, 'sections');
    if (p === '/help_center/articles.json') {
      if (r.url.searchParams.get('per_page')) return json(200, { articles: this.articles.slice(0, 1), count: this.articles.length });
      return this.cursor(this.articles, r, 'articles', { count: this.articles.length });
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Intercom REST API (https://api.eu.intercom.io, Bearer + Intercom-Version, cursor and page pagination)
// ---------------------------------------------------------------------------------------------------------------

export const IC_TOKEN = 'fake-ic-dG9rOjRmOGExYzdlOTJiMDVkM2E2ZTFmOGM0YjdkMmE5MGU1M2I=';
const icc = (n: number) => Buffer.from(`ic:${n}`).toString('base64url');
const ico = (c: string | null) => (c ? Number(Buffer.from(c, 'base64url').toString().slice(3)) : 0);

const icContact = (id: string, o: Record<string, any>) => ({
  type: 'contact', id, workspace_id: 'abc123', external_id: null, role: 'user', email: null, phone: null, name: null, owner_id: null,
  has_hard_bounced: false, marked_email_as_spam: false, unsubscribed_from_emails: false,
  created_at: 1704448800, updated_at: 1717237200, signed_up_at: 1704448800, last_seen_at: 1717237200, language_override: null,
  location: { type: 'location', country: null, region: null, city: null }, custom_attributes: {},
  tags: { type: 'list', data: [], url: `/contacts/${id}/tags`, total_count: 0, has_more: false },
  companies: { type: 'list', data: [], url: `/contacts/${id}/companies`, total_count: 0, has_more: false },
  ...o,
});

export class FakeIntercom extends FakeVendor {
  pageCap = 2;
  contacts = [
    icContact('c1', { email: 'anna@example.com', name: 'Anna Alt', phone: '+49 30 1234567', external_id: 'u-1042', language_override: 'de', location: { type: 'location', country: 'Germany', region: 'Berlin', city: 'Berlin' }, custom_attributes: { plan: 'Pro', mrr: 49, beta: true, leer: '' }, tags: { type: 'list', data: [{ type: 'tag', id: 't1', url: '/tags/t1' }, { type: 'tag', id: 't2', url: '/tags/t2' }], total_count: 2, has_more: false }, companies: { type: 'list', data: [{ type: 'company', id: 'co1', url: '/companies/co1' }], total_count: 1, has_more: false } }),
    icContact('c2', { email: 'ben@example.com', name: 'Ben Bau', unsubscribed_from_emails: true }),
    icContact('c3', { role: 'lead', email: 'cleo@example.com', name: 'Cleo', has_hard_bounced: true }),
    icContact('c4', { role: 'lead', email: 'dora@example.com', name: 'Dora', marked_email_as_spam: true }),
    icContact('c5', { role: 'lead', email: 'emil@example.com', name: 'Emil Neu' }),
  ];
  tags = [{ type: 'tag', id: 't1', name: 'Kunde' }, { type: 'tag', id: 't2', name: 'Beta-Tester' }];
  companies = [{ type: 'company', id: 'co1', company_id: 'muster', name: 'Muster GmbH', website: 'https://muster.example.com', industry: 'Software', size: 12, created_at: 1704448800 }];
  attributes = [
    { type: 'data_attribute', name: 'plan', full_name: 'custom_attributes.plan', label: 'Tarif', data_type: 'string', custom: true, archived: false },
    { type: 'data_attribute', name: 'mrr', full_name: 'custom_attributes.mrr', label: 'MRR', data_type: 'integer', custom: true, archived: false },
    { type: 'data_attribute', name: 'beta', full_name: 'custom_attributes.beta', label: 'Beta', data_type: 'boolean', custom: true, archived: false },
    { type: 'data_attribute', name: 'email', full_name: 'email', label: 'Email', data_type: 'string', custom: false, archived: false },
    { type: 'data_attribute', name: 'alt', full_name: 'custom_attributes.alt', label: 'Alt', data_type: 'string', custom: true, archived: true },
  ];
  conversations: any[] = [
    { id: '9001', created_at: 1709290000, updated_at: 1709293600, state: 'closed', title: null, source: { type: 'conversation', delivered_as: 'customer_initiated', subject: '', body: '<p>Hallo, ich habe eine Frage</p>', author: { type: 'user', id: 'c1', name: 'Anna Alt', email: 'anna@example.com' } }, contacts: { type: 'contact.list', contacts: [{ type: 'contact', id: 'c1' }] } },
    { id: '9002', created_at: 1709400000, updated_at: 1709403600, state: 'open', title: 'Rechnung', source: { type: 'email', delivered_as: 'customer_initiated', subject: 'Rechnung', body: '<p>Wo ist die <b>Rechnung</b>?</p>', author: { type: 'user', id: 'c2', name: 'Ben Bau', email: 'ben@example.com' } }, contacts: { type: 'contact.list', contacts: [{ type: 'contact', id: 'c2' }] } },
    { id: '9003', created_at: 1709500000, updated_at: 1709503600, state: 'closed', title: null, source: { type: 'conversation', delivered_as: 'customer_initiated', subject: '', body: '<p>Funktioniert der Export?</p>', author: { type: 'lead', id: 'zzz', name: 'Neu Interessent', email: 'neu@example.com' } }, contacts: { type: 'contact.list', contacts: [{ type: 'contact', id: 'zzz' }] } },
  ];
  parts: Record<string, any[]> = {
    '9001': [
      { type: 'conversation_part', id: '1', part_type: 'comment', body: '<p>Gerne – was möchtest du wissen?</p>', created_at: 1709290600, author: { type: 'admin', id: '991', name: 'Agnes Agent' } },
      { type: 'conversation_part', id: '2', part_type: 'note', body: '<p>Rabatt prüfen</p>', created_at: 1709291000, author: { type: 'admin', id: '991', name: 'Agnes Agent' } },
      { type: 'conversation_part', id: '3', part_type: 'comment', body: '<p>Danke, das hilft.</p>', created_at: 1709292000, author: { type: 'user', id: 'c1', name: 'Anna Alt' } },
      { type: 'conversation_part', id: '4', part_type: 'assignment', body: null, created_at: 1709292100, author: { type: 'admin', id: '991', name: 'Agnes Agent' } },
      { type: 'conversation_part', id: '5', part_type: 'close', body: null, created_at: 1709293000, author: { type: 'admin', id: '991', name: 'Agnes Agent' } },
    ],
    '9002': [{ type: 'conversation_part', id: '6', part_type: 'comment', body: '<p>Die kommt heute per Post.</p>', created_at: 1709401000, author: { type: 'bot', id: 'b1', name: 'Fin' } }],
    '9003': [],
  };
  collections = [
    { type: 'collection', id: 'col1', name: 'Start', description: '<p>Erste Schritte</p>', parent_id: null },
    { type: 'collection', id: 'col2', name: 'Konto', description: '', parent_id: 'col1' },
  ];
  articles = [
    { type: 'article', id: 'a1', title: 'Konto anlegen', description: '', body: '<h2>Los</h2><p>Siehe <a href="https://muster.example.com/docs">Doku</a>.</p><img src="https://downloads.intercomcdn.com/i/o/1/x.png">', author_id: 991, state: 'published', created_at: 1690000000, updated_at: 1690000100, parent_id: 'col2', parent_type: 'collection' },
    { type: 'article', id: 'a2', title: 'Entwurf', description: '', body: '<ul><li>eins</li></ul>', author_id: 991, state: 'draft', created_at: 1690000200, updated_at: 1690000300, parent_id: null, parent_type: null },
  ];

  authOk(r: Req) {
    return r.headers.authorization === `Bearer ${IC_TOKEN}` && r.url.hostname === 'api.eu.intercom.io' && !!r.headers['intercom-version'];
  }

  private cursor(list: any[], r: Req, key: string) {
    const size = Math.min(Number(r.url.searchParams.get('per_page') ?? 50), this.pageCap);
    const at = ico(r.url.searchParams.get('starting_after'));
    const slice = list.slice(at, at + size);
    const more = at + size < list.length;
    return json(200, { type: key === 'data' ? 'list' : 'conversation.list', [key]: slice, total_count: list.length, pages: { type: 'pages', page: 1, per_page: size, total_pages: Math.ceil(list.length / size), ...(more ? { next: { page: 2, starting_after: icc(at + size) } } : {}) } });
  }
  private paged(list: any[], r: Req) {
    const size = Math.min(Number(r.url.searchParams.get('per_page') ?? 15), this.pageCap);
    const page = Number(r.url.searchParams.get('page') ?? 1);
    return json(200, { type: 'list', data: list.slice((page - 1) * size, page * size), total_count: list.length, pages: { type: 'pages', page, per_page: size, total_pages: Math.max(1, Math.ceil(list.length / size)) } });
  }

  handle(r: Req): Response | undefined {
    const p = r.path;
    if (p === '/me') return json(200, { type: 'admin', id: '991', name: 'Chef', email: 'chef@muster.example.com', app: { type: 'app', id_code: 'abc123', name: 'Muster App', region: 'EU', timezone: 'Europe/Berlin' } });
    if (p === '/contacts') return this.cursor(this.contacts, r, 'data');
    if (p === '/tags') return json(200, { type: 'list', data: this.tags });
    if (p === '/data_attributes') return json(200, { type: 'list', data: this.attributes });
    if (p === '/companies') return this.paged(this.companies, r);
    if (p === '/conversations') return this.cursor(this.conversations, r, 'conversations');
    const m = /^\/conversations\/(\d+)$/.exec(p);
    if (m) {
      const cv = this.conversations.find((c) => c.id === m[1]);
      return cv ? json(200, { ...cv, conversation_parts: { type: 'conversation_part.list', conversation_parts: this.parts[m[1]] ?? [], total_count: (this.parts[m[1]] ?? []).length } }) : json(404, { type: 'error.list', errors: [{ code: 'not_found', message: 'Resource Not Found' }] });
    }
    if (p === '/help_center/collections') return this.paged(this.collections, r);
    if (p === '/articles') return this.paged(this.articles, r);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Salesforce REST API (https://<org>.my.salesforce.com/services/data/v62.0, SOQL, client-credentials token)
// ---------------------------------------------------------------------------------------------------------------

export const SF_ORG = 'https://muster.my.salesforce.com';
export const SF_CLIENT_ID = '3MVG9pRzvMkjMb6kx4Qf0hcg1LwJ0cE3uA1e5l8Zr2yq7XvYm9nV5dK4b8cT1pR6sW3fH2jL0aGq';
export const SF_CLIENT_SECRET = 'fake-sf-9F4C2A71B3D86E05A1C7F39B2D4E6A8C0B5F7D1E3A9C2B4D6F8A0E1C3B5D7F92';
export const SF_TOKEN = '00DxxXXXXXXXXXX!AQ4AQJ5v8Zr2yq7XvYm9nV5dK4b8cT1pR6sW3fH2jL0aGqUwXe';

/** A very small SOQL reader: only what the importer asks for (COUNT(), WHERE with =, >, IN joined by AND, ORDER BY, LIMIT). */
function runSoql(rows: Record<string, any[]>, query: string): { records: any[]; total: number } {
  const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (\w+) (ASC|DESC))?(?: LIMIT (\d+))?$/.exec(query.trim());
  if (!m) throw new Error(`fake SOQL cannot read: ${query}`);
  const [, select, object, where, order, dir, limit] = m;
  let list = [...(rows[object] ?? [])];
  for (const cond of where ? where.split(' AND ') : []) {
    const gt = /^Id > '(.+)'$/.exec(cond);
    const eq = /^(\w+) = (true|false)$/.exec(cond);
    const inn = /^(\w+) IN \((.+)\)$/.exec(cond);
    if (gt) list = list.filter((r) => String(r.Id) > gt[1].replace(/\\'/g, "'"));
    else if (eq) list = list.filter((r) => Boolean(r[eq[1]]) === (eq[2] === 'true'));
    else if (inn) {
      const set = new Set([...inn[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]));
      list = list.filter((r) => set.has(String(r[inn[1]])));
    } else throw new Error(`fake SOQL cannot read condition: ${cond}`);
  }
  const total = list.length;
  if (order) list.sort((a, b) => (String(a[order]) < String(b[order]) ? -1 : String(a[order]) > String(b[order]) ? 1 : 0) * (dir === 'DESC' ? -1 : 1));
  if (limit) list = list.slice(0, Number(limit));
  if (/^COUNT\(\)$/i.test(select.trim())) return { records: [], total };
  return { records: list, total };
}

export class FakeSalesforce extends FakeVendor {
  tokenCalls = 0;
  /** Answer queries with the daily-limit error once this many have been served (0 = never). */
  limitAfter = 0;
  private served = 0;
  rows: Record<string, any[]> = {
    Account: [
      { attributes: { type: 'Account' }, Id: '001A', Name: 'Muster GmbH', Website: 'https://muster.example.com', Phone: '+49 30 111', BillingStreet: 'Hauptstr. 1', BillingCity: 'Berlin', BillingPostalCode: '10115', BillingCountry: 'Germany', Industry: 'Software' },
      { attributes: { type: 'Account' }, Id: '001B', Name: 'Beispiel AG', Website: null, Phone: null, BillingStreet: null, BillingCity: 'Hamburg', BillingPostalCode: null, BillingCountry: null, Industry: null },
    ],
    Contact: [
      { attributes: { type: 'Contact' }, Id: '003A', FirstName: 'Anna', LastName: 'Alt', Email: 'anna@example.com', Phone: '030 1234567', MobilePhone: '0151 1234567', Title: 'Leiterin', Department: 'Einkauf', MailingStreet: 'Hauptstr. 1', MailingCity: 'Berlin', MailingPostalCode: '10115', MailingCountry: 'Germany', AccountId: '001A', Account: { Name: 'Muster GmbH' }, HasOptedOutOfEmail: false, DoNotCall: false, Birthdate: '1985-05-05', LeadSource: 'Web', Description: 'Wichtig', CreatedDate: '2023-01-05T10:00:00.000+0000', Kundennummer__c: 'K-1', Interesse__c: 'SEO' },
      { attributes: { type: 'Contact' }, Id: '003B', FirstName: 'Ben', LastName: 'Bau', Email: 'ben@example.com', Phone: null, MobilePhone: null, Title: null, Department: null, MailingStreet: null, MailingCity: null, MailingPostalCode: null, MailingCountry: null, AccountId: null, Account: null, HasOptedOutOfEmail: true, DoNotCall: false, Birthdate: null, LeadSource: null, Description: null, CreatedDate: '2023-02-05T10:00:00.000+0000', Kundennummer__c: null, Interesse__c: null },
      { attributes: { type: 'Contact' }, Id: '003C', FirstName: 'Cleo', LastName: 'Cool', Email: 'cleo@example.com', Phone: null, MobilePhone: null, Title: null, Department: null, MailingStreet: null, MailingCity: null, MailingPostalCode: null, MailingCountry: null, AccountId: '001A', Account: { Name: 'Muster GmbH' }, HasOptedOutOfEmail: false, DoNotCall: true, Birthdate: null, LeadSource: null, Description: null, CreatedDate: '2023-03-05T10:00:00.000+0000', Kundennummer__c: null, Interesse__c: null },
    ],
    Lead: [
      { attributes: { type: 'Lead' }, Id: '00QA', FirstName: 'Lea', LastName: 'Lead', Company: 'Lead GmbH', Title: null, Email: 'lea@example.com', Phone: null, MobilePhone: null, Street: 'Weg 3', City: 'Köln', PostalCode: '50667', Country: 'Germany', Website: 'https://lead.example.com', Status: 'Open - Not Contacted', LeadSource: 'Messe', IsConverted: false, HasOptedOutOfEmail: false, DoNotCall: false, Description: null, CreatedDate: '2024-01-05T10:00:00.000+0000', Kundennummer__c: null, Interesse__c: 'Ads' },
      { attributes: { type: 'Lead' }, Id: '00QB', FirstName: 'Konrad', LastName: 'Konvertiert', Company: 'Muster GmbH', Email: 'konrad@example.com', IsConverted: true, HasOptedOutOfEmail: false, CreatedDate: '2024-01-06T10:00:00.000+0000' },
    ],
    OpportunityStage: [
      { MasterLabel: 'Prospecting', SortOrder: 1, DefaultProbability: 10, IsActive: true },
      { MasterLabel: 'Negotiation', SortOrder: 2, DefaultProbability: 60, IsActive: true },
      { MasterLabel: 'Closed Won', SortOrder: 3, DefaultProbability: 100, IsActive: true },
      { MasterLabel: 'Closed Lost', SortOrder: 4, DefaultProbability: 0, IsActive: true },
    ],
    Opportunity: [
      { attributes: { type: 'Opportunity' }, Id: '006A', Name: 'Website', Amount: 4500, StageName: 'Negotiation', CloseDate: '2024-06-01', IsClosed: false, IsWon: false, AccountId: '001A', CreatedDate: '2024-01-10T10:00:00.000+0000', CurrencyIsoCode: 'EUR' },
      { attributes: { type: 'Opportunity' }, Id: '006B', Name: 'Gewonnener Deal', Amount: 12000.4, StageName: 'Closed Won', CloseDate: '2024-03-01', IsClosed: true, IsWon: true, AccountId: '001A', CreatedDate: '2024-01-11T10:00:00.000+0000', CurrencyIsoCode: 'USD' },
      { attributes: { type: 'Opportunity' }, Id: '006C', Name: 'Ohne Kontakt', Amount: 100, StageName: 'Alte Phase', CloseDate: '2024-03-01', IsClosed: false, IsWon: false, AccountId: null, CreatedDate: '2024-01-12T10:00:00.000+0000', CurrencyIsoCode: 'EUR' },
    ],
    OpportunityContactRole: [{ Id: '00KA', OpportunityId: '006A', ContactId: '003A', IsPrimary: true }, { Id: '00KB', OpportunityId: '006A', ContactId: '003C', IsPrimary: false }],
    Task: [
      { attributes: { type: 'Task' }, Id: '00TA', Subject: 'Angebot nachfassen', Status: 'Not Started', ActivityDate: '2024-04-01', Description: 'Anrufen', IsClosed: false, WhoId: '003A', WhatId: '006A', Type: 'Call', CreatedDate: '2024-03-01T10:00:00.000+0000' },
      { attributes: { type: 'Task' }, Id: '00TB', Subject: 'Lead qualifiziert', Status: 'Completed', ActivityDate: '2024-02-01', Description: null, IsClosed: true, WhoId: '00QA', WhatId: null, Type: 'Email', CreatedDate: '2024-01-20T10:00:00.000+0000' },
    ],
  };
  describes: Record<string, any[]> = {
    Contact: [...['Id', 'FirstName', 'LastName', 'Email', 'Phone', 'MobilePhone', 'Title', 'Department', 'MailingStreet', 'MailingCity', 'MailingPostalCode', 'MailingCountry', 'AccountId', 'HasOptedOutOfEmail', 'DoNotCall', 'Birthdate', 'LeadSource', 'Description', 'CreatedDate'].map((name) => ({ name, label: name, type: 'string', custom: false })), { name: 'MailingAddress', label: 'Mailing Address', type: 'address', custom: false }, { name: 'Kundennummer__c', label: 'Kundennummer', type: 'string', custom: true }, { name: 'Interesse__c', label: 'Interesse', type: 'picklist', custom: true }],
    Lead: [...['Id', 'FirstName', 'LastName', 'Company', 'Title', 'Email', 'Phone', 'MobilePhone', 'Street', 'City', 'PostalCode', 'Country', 'Website', 'Status', 'LeadSource', 'IsConverted', 'HasOptedOutOfEmail', 'DoNotCall', 'Description', 'CreatedDate'].map((name) => ({ name, label: name, type: 'string', custom: false })), { name: 'Interesse__c', label: 'Interesse', type: 'picklist', custom: true }],
    Account: ['Id', 'Name', 'Website', 'Phone', 'BillingStreet', 'BillingCity', 'BillingPostalCode', 'BillingCountry', 'Industry'].map((name) => ({ name, label: name, type: 'string', custom: false })),
    Opportunity: [...['Id', 'Name', 'Amount', 'StageName', 'CloseDate', 'IsClosed', 'IsWon', 'AccountId', 'CreatedDate', 'CurrencyIsoCode'].map((name) => ({ name, label: name, type: 'string', custom: false }))],
    Task: ['Id', 'Subject', 'Status', 'ActivityDate', 'Description', 'IsClosed', 'WhoId', 'WhatId', 'Type', 'CreatedDate'].map((name) => ({ name, label: name, type: 'string', custom: false })),
  };

  authOk(r: Req) {
    if (r.path === '/services/oauth2/token') return true;
    return r.headers.authorization === `Bearer ${SF_TOKEN}` && r.url.hostname === 'muster.my.salesforce.com';
  }

  handle(r: Req): Response | undefined {
    if (r.path === '/services/oauth2/token') {
      this.tokenCalls++;
      const b = r.body ?? {};
      if (b.grant_type === 'client_credentials' && b.client_id === SF_CLIENT_ID && b.client_secret === SF_CLIENT_SECRET) return json(200, { access_token: SF_TOKEN, instance_url: SF_ORG, token_type: 'Bearer', issued_at: String(Date.now()) });
      return json(400, { error: 'invalid_client', error_description: 'invalid client credentials' });
    }
    const p = r.path.replace(/^\/services\/data\/v62\.0/, '');
    if (p === '/limits') return json(200, { DailyApiRequests: { Max: 15000, Remaining: 14876 } });
    let m = /^\/sobjects\/(\w+)\/describe$/.exec(p);
    if (m) return this.describes[m[1]] ? json(200, { name: m[1], fields: this.describes[m[1]] }) : json(404, [{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }]);
    if (p === '/query') {
      this.served++;
      if (this.limitAfter && this.served > this.limitAfter) return json(403, [{ message: 'TotalRequests Limit exceeded.', errorCode: 'REQUEST_LIMIT_EXCEEDED' }]);
      try {
        const out = runSoql(this.rows, String(r.url.searchParams.get('q')));
        return json(200, { totalSize: out.total, done: true, records: out.records });
      } catch (e) {
        return json(400, [{ message: (e as Error).message, errorCode: 'MALFORMED_QUERY' }]);
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Zoho CRM API v6 (https://www.zohoapis.eu/crm/v6, OAuth refresh token from accounts.zoho.eu, page_token)
// ---------------------------------------------------------------------------------------------------------------

export const ZOHO_CLIENT_ID = '1000.4F8A1C7E92B05D3A6E1F8C4B7D2A90E5';
export const ZOHO_CLIENT_SECRET = 'fake-zoho-b3d9a7c1e5f20481b6a9c3d7e1f5a2c4b8d0e6f9a1';
export const ZOHO_CODE = '1000.9d2f4c7a1b6e48d3a0c5e7f1b2d94a68.7c3a9e5b1d8f4062a1c7e3b9d5f2a804';
export const ZOHO_REFRESH = '1000.refresh8e1f5a2c4b9d0e6f3a7c1b5d9e2f4a68.0b4d8f1a3c7e5902b6d1f9a3c5e7b248';
const ZOHO_ACCESS = '1000.access5d3a1f9b7c2e4086a1c5e9b3d7f0a248.3e9b1d7f5a2c8406e1b9d3f7a5c2e048';

const zhc = (n: number) => Buffer.from(`z:${n}`).toString('base64url');
const zho = (c: string | null) => (c ? Number(Buffer.from(c, 'base64url').toString().slice(2)) : 0);

export class FakeZoho extends FakeVendor {
  pageCap = 2;
  codeUsed = 0;
  refreshCalls = 0;
  accounts = [
    { id: '4001', Account_Name: 'Muster GmbH', Website: 'https://muster.example.com', Phone: '+49 30 111', Billing_Street: 'Hauptstr. 1', Billing_City: 'Berlin', Billing_Code: '10115', Billing_Country: 'Germany', Industry: 'Software' },
    { id: '4002', Account_Name: 'Beispiel AG', Website: null, Phone: null, Billing_Street: null, Billing_City: 'Hamburg', Billing_Code: null, Billing_Country: null, Industry: null },
  ];
  contacts = [
    { id: '5001', First_Name: 'Anna', Last_Name: 'Alt', Email: 'anna@example.com', Phone: '030 1234567', Mobile: '0151 1234567', Title: 'Leiterin', Department: 'Einkauf', Mailing_Street: 'Hauptstr. 1', Mailing_City: 'Berlin', Mailing_Zip: '10115', Mailing_Country: 'Germany', Email_Opt_Out: false, Date_of_Birth: '1985-05-05', Lead_Source: 'Web', Description: 'Wichtig', Account_Name: { id: '4001', name: 'Muster GmbH' }, Created_Time: '2023-01-05T10:00:00+01:00', Kundennummer: 'K-1', Interesse: 'SEO', Owner: { id: '1', name: 'Chef' } },
    { id: '5002', First_Name: 'Ben', Last_Name: 'Bau', Email: 'ben@example.com', Email_Opt_Out: true, Account_Name: null, Created_Time: '2023-02-05T10:00:00+01:00' },
    { id: '5003', First_Name: 'Cleo', Last_Name: 'Cool', Email: 'cleo@example.com', Email_Opt_Out: false, Account_Name: { id: '4001', name: 'Muster GmbH' }, Created_Time: '2023-03-05T10:00:00+01:00' },
  ];
  leads = [
    { id: '6001', First_Name: 'Lea', Last_Name: 'Lead', Company: 'Lead GmbH', Email: 'lea@example.com', Phone: null, Street: 'Weg 3', City: 'Köln', Zip_Code: '50667', Country: 'Germany', Website: 'https://lead.example.com', Lead_Status: 'Contacted', Lead_Source: 'Messe', Email_Opt_Out: false, Converted__s: false, Created_Time: '2024-01-05T10:00:00+01:00' },
    { id: '6002', First_Name: 'Konrad', Last_Name: 'Konvertiert', Company: 'Muster GmbH', Email: 'konrad@example.com', Converted__s: true, Created_Time: '2024-01-06T10:00:00+01:00' },
  ];
  deals = [
    { id: '7001', Deal_Name: 'Website', Amount: 4500, Stage: 'Negotiation/Review', Pipeline: 'Standard', Closing_Date: '2024-06-01', Account_Name: { id: '4001', name: 'Muster GmbH' }, Contact_Name: { id: '5001', name: 'Anna Alt' }, Probability: 60, Currency: 'EUR', Created_Time: '2024-01-10T10:00:00+01:00' },
    { id: '7002', Deal_Name: 'Gewonnen', Amount: 12000, Stage: 'Closed Won', Pipeline: 'Standard', Account_Name: { id: '4001', name: 'Muster GmbH' }, Contact_Name: { id: '5003', name: 'Cleo Cool' }, Currency: 'EUR', Created_Time: '2024-01-11T10:00:00+01:00' },
    { id: '7003', Deal_Name: 'Abo-Upsell', Amount: 900, Stage: 'Demo', Pipeline: 'Abos', Account_Name: null, Contact_Name: { id: '5001', name: 'Anna Alt' }, Currency: 'EUR', Created_Time: '2024-01-12T10:00:00+01:00' },
  ];
  tasks = [
    { id: '8001', Subject: 'Angebot nachfassen', Due_Date: '2024-04-01', Status: 'Not Started', Description: 'Anrufen', Who_Id: { id: '5001', name: 'Anna Alt' }, What_Id: { id: '7001', name: 'Website' }, $se_module: 'Deals', Created_Time: '2024-03-01T10:00:00+01:00' },
    { id: '8002', Subject: 'Erledigt', Due_Date: '2024-02-01', Status: 'Completed', Description: null, Who_Id: null, What_Id: { id: '4001', name: 'Muster GmbH' }, $se_module: 'Accounts', Created_Time: '2024-01-20T10:00:00+01:00' },
  ];
  notes = [
    { id: '9001', Note_Title: 'Erstgespräch', Note_Content: 'Sehr interessiert', Parent_Id: { id: '5001', name: 'Anna Alt' }, $se_module: 'Contacts', Created_Time: '2024-01-15T10:00:00+01:00' },
    { id: '9002', Note_Title: null, Note_Content: 'Rabatt möglich', Parent_Id: { id: '7001', name: 'Website' }, $se_module: 'Deals', Created_Time: '2024-01-16T10:00:00+01:00' },
    { id: '9003', Note_Title: 'Firma', Note_Content: 'Account-Notiz bleibt bei Zoho', Parent_Id: { id: '4001', name: 'Muster GmbH' }, $se_module: 'Accounts', Created_Time: '2024-01-17T10:00:00+01:00' },
  ];
  fieldDefs: Record<string, any[]> = {
    Contacts: [...['First_Name', 'Last_Name', 'Email', 'Phone', 'Mobile', 'Title', 'Department', 'Mailing_Street', 'Mailing_City', 'Mailing_Zip', 'Mailing_Country', 'Email_Opt_Out', 'Date_of_Birth', 'Lead_Source', 'Description'].map((api_name) => ({ api_name, field_label: api_name, data_type: 'text', custom_field: false })), { api_name: 'Account_Name', field_label: 'Account Name', data_type: 'lookup', custom_field: false }, { api_name: 'Kundennummer', field_label: 'Kundennummer', data_type: 'text', custom_field: true }, { api_name: 'Interesse', field_label: 'Interesse', data_type: 'picklist', custom_field: true, pick_list_values: [{ display_value: 'SEO' }, { display_value: 'Ads' }] }, { api_name: 'Konto_Ref', field_label: 'Konto-Referenz', data_type: 'lookup', custom_field: true }],
    Leads: [...['First_Name', 'Last_Name', 'Company', 'Email', 'Phone', 'Street', 'City', 'Zip_Code', 'Country', 'Website', 'Lead_Status', 'Lead_Source', 'Email_Opt_Out', 'Description'].map((api_name) => ({ api_name, field_label: api_name, data_type: 'text', custom_field: false }))],
  };

  authOk(r: Req) {
    if (r.path === '/oauth/v2/token') return r.url.hostname === 'accounts.zoho.eu';
    return r.headers.authorization === `Zoho-oauthtoken ${ZOHO_ACCESS}` && r.url.hostname === 'www.zohoapis.eu';
  }

  private module(name: string): any[] | undefined {
    return ({ Accounts: this.accounts, Contacts: this.contacts, Leads: this.leads, Deals: this.deals, Tasks: this.tasks, Notes: this.notes } as Record<string, any[]>)[name];
  }

  handle(r: Req): Response | undefined {
    if (r.path === '/oauth/v2/token') {
      const b = r.body ?? {};
      const okClient = b.client_id === ZOHO_CLIENT_ID && b.client_secret === ZOHO_CLIENT_SECRET;
      if (okClient && b.grant_type === 'authorization_code' && b.code === ZOHO_CODE && !this.codeUsed++) return json(200, { access_token: ZOHO_ACCESS, refresh_token: ZOHO_REFRESH, api_domain: 'https://www.zohoapis.eu', token_type: 'Bearer', expires_in: 3600 });
      if (okClient && b.grant_type === 'refresh_token' && b.refresh_token === ZOHO_REFRESH) {
        this.refreshCalls++;
        return json(200, { access_token: ZOHO_ACCESS, api_domain: 'https://www.zohoapis.eu', token_type: 'Bearer', expires_in: 3600 });
      }
      return json(400, { error: 'invalid_code' });
    }
    const p = r.path.replace(/^\/crm\/v6/, '');
    if (p === '/org') return json(200, { org: [{ company_name: 'Muster GmbH', id: '12345678901', zgid: '20012345678', country: 'DE' }] });
    if (p === '/settings/fields') return this.fieldDefs[String(r.url.searchParams.get('module'))] ? json(200, { fields: this.fieldDefs[String(r.url.searchParams.get('module'))] }) : json(400, { code: 'INVALID_MODULE', message: 'the module name given seems to be invalid' });
    if (p === '/settings/layouts') return json(200, { layouts: [{ id: 'L1', name: 'Standard' }] });
    if (p === '/settings/pipeline')
      return json(200, {
        pipeline: [
          { id: 'P1', display_value: 'Standard', default: true, maps: [{ id: 'S3', display_value: 'Closed Won', sequence_number: 3, forecast_type: 'Closed Won' }, { id: 'S1', display_value: 'Qualification', sequence_number: 1, forecast_type: 'Open' }, { id: 'S2', display_value: 'Negotiation/Review', sequence_number: 2, forecast_type: 'Open' }, { id: 'S4', display_value: 'Closed Lost', sequence_number: 4, forecast_type: 'Closed Lost' }] },
        ],
      });
    const c = /^\/(\w+)\/actions\/count$/.exec(p);
    if (c) return this.module(c[1]) ? json(200, { count: this.module(c[1])!.length }) : json(400, { code: 'INVALID_MODULE', message: 'invalid module' });
    const m = /^\/(\w+)$/.exec(p);
    if (m && this.module(m[1])) {
      if (!r.url.searchParams.get('fields')) return json(400, { code: 'REQUIRED_PARAM_MISSING', message: 'one of the expected parameter is missing', details: { param: 'fields' } });
      const list = this.module(m[1])!;
      const size = Math.min(Number(r.url.searchParams.get('per_page') ?? 200), this.pageCap);
      const at = zho(r.url.searchParams.get('page_token'));
      const slice = list.slice(at, at + size);
      const more = at + size < list.length;
      return json(200, { data: slice, info: { per_page: size, count: slice.length, page: 1, more_records: more, ...(more ? { next_page_token: zhc(at + size) } : {}) } });
    }
    return undefined;
  }
}
