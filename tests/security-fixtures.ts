import type { App } from '../server/core/app.js';
import { sealWith } from '../server/core/secrets.js';
import { blankFile } from '../server/services/office-blank.js';
import { seedSites } from './site-fixtures.js';

/**
 * Shared fixtures for the security tests: two sub-accounts (A and B) filled through the regular API,
 * a member login that only belongs to A, and helpers that know which database rows belong to B.
 * Every name/text written into B carries MARK, so a response that contains it leaked B's data.
 */

export const MARK = 'LEAKMARKB';

export type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; text: string; data: any; headers: Headers }>;

/** A tiny client with its own cookie jar (the shared test client keeps only one). */
export function client(base: string, defaults: Record<string, string> = {}): Call & { cookie: () => string } {
  let cookie = '';
  const call = (async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...defaults, ...headers },
      body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const set = r.headers.get('set-cookie');
    if (set) {
      const c = set.split(';')[0];
      if (c.startsWith('pghl_session=')) cookie = c.endsWith('=') ? '' : c;
    }
    const text = await r.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, text, data, headers: r.headers };
  }) as Call & { cookie: () => string };
  call.cookie = () => cookie;
  return call;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));

/** Fills one sub-account through the API; `tag` goes into every name. Failing steps are collected, not fatal. */
export async function seedLocation(call: Call, loc: string, tag: string) {
  const h = { 'x-location-id': loc, 'x-pghl': '1' };
  const failed: string[] = [];
  const ids: Record<string, string> = {};
  const mk = async (key: string, method: string, path: string, body: any, pick: (d: any) => any = (d) => d?.id) => {
    const r = await call(method, path, body, h);
    if (r.status >= 300) {
      failed.push(`${key}: ${method} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
      return undefined;
    }
    const v = pick(r.data);
    if (typeof v === 'string') ids[key] = v;
    return r.data;
  };
  const low = tag.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  await mk('contact', 'POST', '/api/contacts', { email: `${low}@example.com`, first_name: tag, last_name: `${tag}Last`, phone: '+491701234567', company: `${tag} GmbH`, address: 'Teststraße 1', postal_code: '10115', city: 'Berlin', tags: [`${low}-tag`] }, (d) => d?.id ?? d?.contact?.id);
  await mk('contact2', 'POST', '/api/contacts', { email: `${low}2@example.com`, first_name: `${tag}Zwei` }, (d) => d?.id ?? d?.contact?.id);
  const c = ids.contact;
  await mk('note', 'POST', `/api/contacts/${c}/notes`, { body: `${tag} note` });
  await mk('noteplus', 'POST', '/api/notes', { contact_id: c, title: `${tag} Titel`, body: `${tag} **Markdown**`, color: 'yellow', pinned: true });
  await mk('task', 'POST', '/api/tasks', { title: `${tag} task`, description: tag, contact_id: c });
  await mk('tag', 'POST', '/api/tags', { name: `${low}-label` });
  await mk('tagcategory', 'POST', '/api/tag-categories', { name: `${tag} Kategorie`, color: '#22c55e' });
  await mk('field', 'POST', '/api/custom-fields', { label: `${tag} Feld`, type: 'text' });
  await mk('smartlist', 'POST', '/api/smart-lists', { name: `${tag} Liste`, filter: { tags: [`${low}-tag`] } });
  const pipe = await mk('pipeline', 'POST', '/api/pipelines', { name: `${tag} Pipeline`, stages: [{ name: `${tag} Lead` }, { name: `${tag} Deal` }] });
  await mk('opportunity', 'POST', '/api/opportunities', { pipeline_id: pipe?.id, contact_id: c, name: `${tag} Deal`, value: 1000, expected_close_date: '2031-06-30', currency: 'CHF' });
  // A lost deal with its reason and a pipeline with its own list of reasons: both carry the tag, so a leak shows.
  const lostDeal = await mk('lostopportunity', 'POST', '/api/opportunities', { pipeline_id: pipe?.id, contact_id: c, name: `${tag} Verlorener Deal`, value: 500 });
  if (lostDeal?.id) await mk('lostopportunityset', 'PATCH', `/api/opportunities/${lostDeal.id}`, { status: 'lost', lost_reason: `${tag} Verlustgrund` }, () => undefined);
  if (pipe?.id) await mk('lostreasons', 'PATCH', `/api/pipelines/${pipe.id}`, { lost_reasons: [`${tag} Grund eins`, `${tag} Grund zwei`] }, () => undefined);
  // Booking rules (limits, date-specific hours, reminders, follow-up, no-show) carry the tag in their texts, so a leak shows.
  const cal = await mk('calendar', 'POST', '/api/calendars', {
    name: `${tag} Kalender`,
    duration: 30,
    min_notice: 0,
    availability: every,
    settings: {
      confirmation_email: false,
      notify_team: false,
      limit_day: 4,
      limit_week: 12,
      date_overrides: { '2031-12-24': [], '2031-12-27': [['10:00', '12:00']] },
      reminders: [{ hours: 24, email: true, sms: false, subject: `${tag} Erinnerung 24h` }, { hours: 1, email: true, sms: false, subject: `${tag} Erinnerung 1h` }],
      followup: { enabled: true, hours: 2, email: true, subject: `${tag} Danke nach dem Termin` },
      noshow: { enabled: true, email: true, subject: `${tag} Nicht erschienen` },
    },
  });
  await mk('appointment', 'POST', '/api/appointments', { calendar_id: cal?.id, contact_id: c, start: `${new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)}T${tag === 'Alpha' ? '08' : '09'}:00:00.000Z`, title: `${tag} Termin` });
  const form = await mk('form', 'POST', '/api/forms', { name: `${tag} Formular` });
  if (form?.id) await call('POST', `/api/public/forms/${form.id}/submit`, { email: `${low}-lead@example.com`, first_name: `${tag}Lead`, message: `${tag} message` });
  const funnel = await mk('funnel', 'POST', '/api/funnels', { name: `${tag} Funnel`, template: 'leadmagnet' });
  if (funnel?.id) {
    await mk('post', 'POST', `/api/funnels/${funnel.id}/posts`, { title: `${tag} Artikel`, content: `# ${tag}`, status: 'published' });
    await mk('page', 'POST', `/api/funnels/${funnel.id}/pages`, { name: `${tag} Seite`, title: `${tag} Seite` });
  }
  await mk('message', 'POST', '/api/messages', { contact_id: c, channel: 'email', subject: `${tag} Betreff`, body: `${tag} Nachricht` });
  // Error handling: a workflow with its error workflow, notices and a step that ignores errors; its failed run is written in seedCreatorRows.
  const errWf = await mk('errworkflow', 'POST', '/api/workflows', { name: `${tag} Fehler-Workflow`, trigger: { type: 'manual', config: {} }, steps: [{ type: 'add_tag', tags: [`${low}-fehler`] }] });
  await mk('workflow', 'POST', '/api/workflows', { name: `${tag} Workflow`, trigger: { type: 'contact.tag_added', config: { tag: `${low}-wf` } }, steps: [{ type: 'add_tag', tag: `${low}-done` }, { type: 'webhook', url: '', continue_on_error: true }], settings: { stop_on_error: true, error_bell: true, error_email: true, on_error_workflow_id: errWf?.id ?? '' } });
  await mk('campaign', 'POST', '/api/campaigns', { name: `${tag} Kampagne`, subject: `${tag} Betreff`, body: `${tag} Text`, speed_per_hour: 120 });
  await mk('template', 'POST', '/api/templates', { name: `${tag} Vorlage`, subject: tag, body: tag });
  // E-mail marketing: a behaviour segment (watched), an A/B campaign with a follow-up and send-time optimisation, a WhatsApp campaign,
  // the warm-up plan, the sub-account's settings and a template copied from the gallery.
  await mk('segment', 'POST', '/api/segments', { name: `${tag} Segment`, description: `${tag} Zielgruppe`, watch: true, definition: { type: 'group', op: 'and', items: [{ type: 'tag', tag: `${low}-tag` }, { type: 'field', field: 'city', op: 'contains', value: `${tag}-Stadt` }] } });
  await mk('abcampaign', 'POST', '/api/campaigns', { name: `${tag} A/B-Kampagne`, subject: `${tag} Betreff A`, body: `${tag} Text`, send_mode: 'sto', sender_name: `${tag} Absender`, ab: { variants: [{}, { subject: `${tag} Betreff B` }], test_percent: 30 }, resend: { subject: `${tag} Erinnerung`, after_hours: 48 } });
  await mk('wacampaign', 'POST', '/api/campaigns', { name: `${tag} WhatsApp`, channel: 'whatsapp', wa_template: { name: `${tag}_vorlage`, language: 'de', values: { 'body.1': `${tag} Wert` } } });
  await mk('warmup', 'POST', '/api/deliverability/warmup', { plan: 'standard', domain: `${low}.example.com` }, () => undefined);
  await mk('mksettings', 'PUT', '/api/deliverability/settings', { hygiene: { soft_bounce_limit: 4 }, sto: { default_hour: 8 } }, () => undefined);
  await mk('gallerytemplate', 'POST', '/api/email-gallery/newsletter-klassisch/use', { name: `${tag} Galerie-Vorlage` }, (d) => d?.template?.id);
  await mk('product', 'POST', '/api/products', { name: `${tag} Produkt`, price_cents: 1000 });
  await mk('invoice', 'POST', '/api/invoices', { contact_id: c, title: `${tag} Rechnung`, items: [{ name: `${tag} Posten`, qty: 1, price_cents: 1000 }] });
  // Invoicing: seller data, a finalised invoice with a part payment, its archived XRechnung and a credit note, a Stornorechnung, a quote that became an invoice
  await mk('invoicesettings', 'PUT', '/api/invoice-settings', { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: `${tag} Kontakt`, contact_phone: '+49301234567', contact_email: `${low}-re@example.com`, iban: 'DE02120300000000202051', bic: 'BYLADEM1001' }, () => undefined);
  const fin = await mk('finalinvoice', 'POST', '/api/invoices', { contact_id: c, title: `${tag} Festgeschrieben`, items: [{ name: `${tag} Leistung`, qty: 2, price_cents: 5000, tax_rate: 19 }], buyer_ref: `${tag}-REF` });
  if (fin?.id) {
    await mk('finalised', 'POST', `/api/invoices/${fin.id}/finalise`, {}, () => undefined);
    await mk('invoicepayment', 'POST', `/api/invoices/${fin.id}/payments`, { amount_cents: 500, method: `${tag} Überweisung` }, () => undefined);
    await mk('xrechnung', 'GET', `/api/invoices/${fin.id}/xrechnung`, undefined, () => undefined);
    await mk('zugferd', 'GET', `/api/invoices/${fin.id}/zugferd`, undefined, () => undefined);
    await mk('creditnote', 'POST', `/api/invoices/${fin.id}/credit-note`, { items: [{ name: `${tag} Nachlass`, qty: 1, price_cents: 100, tax_rate: 19 }], reason: `${tag} Kulanz` });
  }
  const gone = await mk('stornosource', 'POST', '/api/invoices', { contact_id: c, title: `${tag} Storno-Quelle`, items: [{ name: `${tag} Falsch`, qty: 1, price_cents: 700, tax_rate: 19 }] });
  if (gone?.id) {
    await mk('stornofinal', 'POST', `/api/invoices/${gone.id}/finalise`, {}, () => undefined);
    await mk('storno', 'POST', `/api/invoices/${gone.id}/storno`, { reason: `${tag} Irrtum` }, () => undefined);
  }
  const quote = await mk('quote', 'POST', '/api/invoices', { kind: 'estimate', contact_id: c, title: `${tag} Angebot`, items: [{ name: `${tag} Paket`, qty: 1, price_cents: 3000, tax_rate: 19 }] });
  if (quote?.id) {
    await mk('quotesent', 'PATCH', `/api/invoices/${quote.id}`, { status: 'sent' }, () => undefined);
    await mk('quoteinvoice', 'POST', `/api/invoices/${quote.id}/convert`, {}, () => undefined);
  }
  // Creator & Commerce: payment plan, overdue invoice with a dunning notice, billing page settings, comment-to-DM rule
  await mk('plan', 'POST', '/api/payment-plans', { product_id: ids.product, name: `${tag} Raten`, installments: 3, amount_cents: 400 });
  await mk('aboproduct', 'POST', '/api/products', { name: `${tag} Abo`, price_cents: 1500, recurring: 'month' });
  await mk('billingsetting', 'PUT', `/api/dunning/products/${ids.aboproduct}`, { allow_pause: true, allow_cancel: true }, () => undefined);
  const overdue = await mk('dunninginvoice', 'POST', '/api/invoices', { contact_id: c, title: `${tag} Mahnrechnung`, items: [{ name: `${tag} Beratung`, qty: 1, price_cents: 11900, tax_rate: 0 }], due_at: new Date(Date.now() - 20 * 864e5).toISOString() });
  if (overdue?.id) {
    await mk('dunninginvoicesent', 'PATCH', `/api/invoices/${overdue.id}`, { status: 'sent' }, () => undefined);
    await mk('dunningnotice', 'POST', `/api/dunning/invoices/${overdue.id}/notice`, { send: false }, () => undefined);
    await mk('dunninghold', 'POST', `/api/dunning/invoices/${overdue.id}/hold`, { on: true, reason: `${tag} Mahnstopp` }, () => undefined);
  }
  // SEPA: creditor data, a paper mandate, an online mandate (its link token is a key the harness tries), a submitted collection run with a
  // return, and a transfer file – names, notes and texts carry the tag.
  await mk('sepasettings', 'PUT', '/api/sepa/settings', { creditor_id: 'DE98ZZZ09999999999', creditor_name: `${tag} Glaeubiger` }, () => undefined);
  const sepaMandate = await mk('sepamandate', 'POST', '/api/sepa/mandates', { contact_id: c, holder: `${tag} Inhaber`, iban: 'DE89370400440532013000', signed_at: '2026-01-15', note: `${tag} Mandat` });
  await mk('sepaonline', 'POST', '/api/sepa/mandates/request', { contact_id: ids.contact2, note: `${tag} Online-Mandat` });
  const sepaInvoice = await mk('sepainvoice', 'POST', '/api/invoices', { contact_id: c, title: `${tag} Lastschrift`, items: [{ name: `${tag} Abo`, qty: 1, price_cents: 2000, tax_rate: 19 }] });
  if (sepaInvoice?.id && sepaMandate?.id) {
    await mk('sepafinal', 'POST', `/api/invoices/${sepaInvoice.id}/finalise`, {}, () => undefined);
    const due = (await call('GET', '/api/sepa/candidates', undefined, h)).data?.earliest;
    const sepaRun = await mk('separun', 'POST', '/api/sepa/runs', { invoice_ids: [sepaInvoice.id], collection_date: due, note: `${tag} Lauf` });
    if (sepaRun?.id) {
      await mk('separunsubmit', 'POST', `/api/sepa/runs/${sepaRun.id}/submit`, {}, () => undefined);
      await mk('separeturn', 'POST', `/api/sepa/items/${sepaRun.items?.[0]?.id}/return`, { code: 'AM04', note: `${tag} Rueckgabe` }, () => undefined);
    }
  }
  await mk('sepatransfer', 'POST', '/api/sepa/transfers', { lines: [{ name: `${tag} Empfaenger`, iban: 'DE89370400440532013000', amount_cents: 1234, reference: `${tag} Auszahlung` }], note: `${tag} Ueberweisung` });
  // Online store and gift cards: settings, a collection, a published product, a gift card of the person, and an order the person paid
  // with a second gift card (no payment provider needed) – names and notes carry the tag.
  await mk('storesettings', 'PUT', '/api/store/settings', { enabled: true, slug: `${low}-laden`, name: `${tag} Laden`, countries: ['DE'] }, () => undefined);
  await mk('storecollection', 'POST', '/api/store/collections', { name: `${tag} Kollektion` });
  if (ids.product) await mk('storeproduct', 'PUT', `/api/store/products/${ids.product}`, { published: true, kind: 'digital', collection_ids: ids.storecollection ? [ids.storecollection] : [] }, () => undefined);
  await mk('giftcard', 'POST', '/api/gift-cards', { amount_cents: 5000, contact_id: c, note: `${tag} Gutschein` });
  const payCard = await mk('paycard', 'POST', '/api/gift-cards', { amount_cents: 5000, note: `${tag} Zahlkarte` });
  if (ids.product && payCard?.code) {
    const r = await call('POST', `/api/public/store/${low}-laden/checkout`, { items: [{ product_id: ids.product, qty: 1 }], email: `${low}@example.com`, first_name: tag, last_name: `${tag}Last`, country: 'DE', gift_code: payCard.code, accept_terms: true, note: `${tag} Anmerkung` }, {});
    if (r.status >= 300) failed.push(`storeorder: POST /api/public/store/…/checkout → ${r.status} ${r.text.slice(0, 120)}`);
    const orders = (await call('GET', '/api/store/orders', undefined, h)).data;
    if (Array.isArray(orders) && orders[0]?.id) ids.storeorder = orders[0].id;
  }
  await mk('igrule', 'POST', '/api/ig-comments/rules', { name: `${tag} Kommentar-Regel`, keywords: [`${low}guide`], dm_text: `${tag} Hier ist dein Guide`, link_url: `https://example.com/${low}-guide`, public_replies: [`${tag} Schau in deine DMs`], tags: [`${low}-igc`] });
  await mk('triggerlink', 'POST', '/api/trigger-links', { name: `${tag} Link`, url: 'https://example.com/x', tags: [`${low}-click`] });
  await mk('contract', 'POST', '/api/contracts', { kind: 'template', title: `${tag} Vertrag`, content: `# ${tag}` });
  await mk('doc', 'POST', '/api/docs', { url: `https://example.com/doc-${low}`, title: `${tag} Doku` });
  const course = await mk('course', 'POST', '/api/courses', { title: `${tag} Kurs`, description: tag });
  if (course?.id) {
    const mod = await mk('module', 'POST', `/api/courses/${course.id}/modules`, { title: `${tag} Modul` });
    await mk('lesson', 'POST', `/api/courses/${course.id}/lessons`, { module_id: mod?.id, title: `${tag} Lektion`, content: tag });
    await mk('enrollment', 'POST', `/api/courses/${course.id}/enrollments`, { contact_id: c });
    // Quiz, assignment and certificate on further lessons of the course
    const lq = await mk('lessonquiz', 'POST', `/api/courses/${course.id}/lessons`, { module_id: mod?.id, title: `${tag} Test-Lektion` });
    const la = await mk('lessonassignment', 'POST', `/api/courses/${course.id}/lessons`, { module_id: mod?.id, title: `${tag} Aufgaben-Lektion` });
    await mk('quiz', 'POST', '/api/quizzes', { course_id: course.id, lesson_id: lq?.id, title: `${tag} Quiz`, pass_percent: 70, questions: [{ kind: 'single', text: `${tag} Frage?`, options: [{ text: 'Ja', correct: true }, { text: 'Nein' }] }] });
    await mk('assignment', 'POST', '/api/assignments', { course_id: course.id, lesson_id: la?.id, title: `${tag} Aufgabe`, instructions: `${tag} Anleitung`, kind: 'text', gate: false });
    await mk('certtemplate', 'POST', '/api/certificates/templates', { name: `${tag} Zertifikat`, course_id: course.id, issue_on: 'completion', config: { title: `${tag} Zertifikat`, issuer: `${tag} Akademie` } });
    await mk('certificate', 'POST', '/api/certificates/issue', { contact_id: c, course_id: course.id });
  }
  const group = await mk('group', 'POST', '/api/community/groups', { name: `${tag} Gruppe`, description: tag });
  if (group?.id) {
    const post = await mk('cpost', 'POST', `/api/community/groups/${group.id}/posts`, { title: `${tag} Beitrag`, body: tag });
    if (post?.id) await mk('ccomment', 'POST', `/api/community/posts/${post.id}/comments`, { body: `${tag} Kommentar` });
    const cev = await mk('cevent', 'POST', `/api/community/groups/${group.id}/events`, { title: `${tag} Event`, starts_at: new Date(Date.now() + 864e5).toISOString() });
    // Community extras: public page with a tier, invite and coupon, badge, perk, challenge, live call, message from the team.
    await mk('cpage', 'PUT', `/api/community/groups/${group.id}/join/page`, { slug: `${low}-community`, enabled: true, tagline: `${tag} Tagline`, about: tag, questions: [{ label: `${tag} Frage?` }] }, () => undefined);
    await mk('cinvite', 'POST', `/api/community/groups/${group.id}/invites`, { label: `${tag} Einladung` });
    await mk('ccoupon', 'POST', `/api/community/groups/${group.id}/coupons`, { code: `${low.toUpperCase()}10`, percent_off: 10 });
    await mk('cbadge', 'POST', `/api/community/groups/${group.id}/badges`, { name: `${tag} Abzeichen`, emoji: '🏅' });
    await mk('cperk', 'POST', `/api/community/groups/${group.id}/perks`, { kind: 'text', title: `${tag} Vorteil`, body: `${tag} Geheimtipp`, level: 2 });
    await mk('cchallenge', 'POST', `/api/community/groups/${group.id}/challenges`, { title: `${tag} Challenge`, starts_on: '2030-01-01', ends_on: '2030-01-05', tasks: [{ day: 1, title: `${tag} Aufgabe` }] });
    if (cev?.id) await mk('clive', 'PUT', `/api/community/events/${cev.id}/live`, { enabled: true }, () => undefined);
    await mk('cdm', 'POST', `/api/community/messages/${c}`, { body: `${tag} Nachricht vom Team` }, (d) => d?.id);
  }
  const program = await mk('program', 'POST', '/api/affiliates/programs', { name: `${tag} Partner`, commission_value: 100 });
  if (program?.id) {
    const aff = await mk('affiliate', 'POST', '/api/affiliates', { program_id: program.id, name: `${tag} Affiliate`, email: `${low}-aff@example.com` });
    if (aff?.id) await mk('commission', 'POST', '/api/affiliates/commissions', { affiliate_id: aff.id, amount_cents: 500, note: tag });
  }
  const company = await mk('company', 'POST', '/api/companies', { name: `${tag} Firma`, domain: `${low}.example.com` });
  if (company?.id) {
    await mk('cnote', 'POST', `/api/companies/${company.id}/notes`, { body: `${tag} Firmennotiz` });
    await mk('association', 'POST', '/api/associations', { from_type: 'contact', from_id: c, to_type: 'company', to_id: company.id });
  }
  const type = await mk('objtype', 'POST', '/api/object-types', { singular: `${tag}Objekt`, plural: `${tag}Objekte`, primary_label: 'Name' }, (d) => d?.id ?? d?.key);
  if (type?.key) await mk('record', 'POST', `/api/objects/${type.key}/records`, { properties: { name: `${tag} Datensatz` } });
  await mk('scoring', 'POST', '/api/lead-scoring/models', { name: `${tag} Score`, rules: [] });
  const ticket = await mk('ticket', 'POST', '/api/tickets', { subject: `${tag} Ticket`, description: `${tag} Beschreibung`, contact_id: c });
  if (ticket?.id) {
    await mk('treply', 'POST', `/api/tickets/${ticket.id}/reply`, { body: `${tag} Antwort` });
    await mk('tnote', 'POST', `/api/tickets/${ticket.id}/notes`, { body: `${tag} interne Notiz` });
  }
  await mk('canned', 'POST', '/api/helpdesk/canned', { name: `${tag} Baustein`, body: tag });
  await mk('team', 'POST', '/api/helpdesk/teams', { name: `${tag} Team`, members: [] });
  await mk('view', 'POST', '/api/helpdesk/views', { name: `${tag} Ansicht`, filters: {} });
  const kbcat = await mk('kbcat', 'POST', '/api/kb/categories', { name: `${tag} Kategorie` });
  await mk('kbarticle', 'POST', '/api/kb/articles', { title: `${tag} Artikel`, body: tag, category_id: kbcat?.id, status: 'draft' });
  await mk('nps', 'POST', '/api/surveys/nps', { name: `${tag} NPS`, tags: [] });
  await mk('report', 'POST', '/api/reports/library', { name: `${tag} Bericht`, config: { viz: 'kpi', query: { source: 'contacts', measures: ['count'], range: 'all' } }, visibility: 'team' });
  await mk('dashboard', 'POST', '/api/reports/dashboards', { name: `${tag} Dashboard` });
  await mk('resthook', 'POST', '/api/hooks', { name: `${tag} Hook`, event: 'contact.created', target_url: 'https://example.com/hook' });
  await mk('webhook', 'POST', '/api/webhooks', { url: `https://example.com/webhook-${low}`, events: ['*'] });
  await mk('apikey', 'POST', '/api/api-keys', { name: `${tag} Key` });
  await mk('upload', 'POST', '/api/uploads', { name: `${low}.png`, data: PNG });
  await mk('section', 'POST', '/api/email-builder/sections', { name: `${tag} Abschnitt`, section: { columns: [{ blocks: [{ type: 'text', props: { text: tag } }] }] } });
  const board = await mk('canvas', 'POST', '/api/canvas', { name: `${tag} Board`, elements: [{ id: `${low}sticky`, type: 'sticky', text: `${tag} Notiz` }, { type: 'card', card: { kind: 'contact', id: c } }] });
  if (board?.id) {
    await mk('canvascomment', 'POST', `/api/canvas/${board.id}/comments`, { body: `${tag} Kommentar`, element_id: `${low}sticky` });
    await mk('canvasshare', 'POST', `/api/canvas/${board.id}/shares`, { label: `${tag} Link` });
    await mk('canvassnapshot', 'POST', `/api/canvas/${board.id}/snapshots`, { name: `${tag} Version` });
    // XR: where this person hung the plane in their headset (personal, per canvas)
    await mk('canvasxr', 'PUT', `/api/canvas/${board.id}/xr-layout`, { layout: { plane: { x: 0, y: 0.1, z: -2.4, scale: 1.4, curve: 0.3 } } }, () => undefined);
  }
  // Back-Office: bookkeeping, stock and HR rows that must never reach another sub-account.
  await mk('accsetup', 'POST', '/api/accounting/setup', { standard: 'skr03' }, () => undefined);
  await mk('accentry', 'POST', '/api/accounting/entries', { date: new Date().toISOString().slice(0, 10), text: `${tag} Buchung`, doc_ref: `${tag}-R1`, party_name: `${tag} Lieferant`, postings: [{ debit: '4930', credit: '1200', amount_cents: 1190, tax_code: 'vst19' }] });
  await mk('accreceipt', 'POST', '/api/accounting/receipts', { name: `${low}-beleg.png`, data: PNG, note: `${tag} Beleg` }, (d) => d?.receipt?.id);
  await mk('article', 'POST', '/api/inventory/articles', { sku: `${low.toUpperCase()}-1`, name: `${tag} Artikel`, min_stock: 1, initial_qty: 3, supplier_name: `${tag} Lieferant` });
  const emp = await mk('employee', 'POST', '/api/hr/employees', { first_name: tag, last_name: `${tag}Mitarbeiter`, email: `${low}-ma@example.com`, position: `${tag} Rolle`, start_date: '2020-01-01', notes: `${tag} interne Notiz` });
  if (emp?.id) {
    await mk('hrsensitive', 'PUT', `/api/hr/employees/${emp.id}/sensitive`, { health_insurance: `${tag} Krankenkasse`, salary_cents: 123456 }, () => undefined);
    await mk('absence', 'POST', '/api/hr/absences', { employee_id: emp.id, type: 'other', label: `${tag} Termin`, start_date: '2030-05-14', approved: true });
    await mk('hrdoc', 'POST', `/api/hr/employees/${emp.id}/documents`, { name: `${low}-vertrag.txt`, data: `data:text/plain;base64,${Buffer.from(`${tag} Vertrag`).toString('base64')}` });
  }
  // Project planner: project, nested tasks, dependency, comment, link, time entry, rule, saved view, template
  const proj = await mk('pmproject', 'POST', '/api/pm/projects', { name: `${tag} Projekt`, contact_id: c, portal_visible: true });
  if (proj?.id) {
    const root = await mk('pmtask', 'POST', '/api/pm/tasks', { title: `${tag} Planaufgabe`, project_id: proj.id, due_at: '2026-11-10', start_at: '2026-11-02', subtasks: [`${tag} Unteraufgabe`] });
    const next = await mk('pmtask2', 'POST', '/api/pm/tasks', { title: `${tag} Folgeaufgabe`, project_id: proj.id, due_at: '2026-11-20', start_at: '2026-11-12' });
    if (root?.id && next?.id) {
      await mk('pmdep', 'POST', `/api/pm/tasks/${next.id}/dependencies`, { depends_on: root.id }, () => undefined);
      await mk('pmcomment', 'POST', `/api/pm/tasks/${root.id}/comments`, { body: `${tag} Planer-Kommentar` });
      await mk('pmattachment', 'POST', `/api/pm/tasks/${root.id}/attachments`, { url: `https://example.com/pm-${low}`, name: `${tag} Anhang` });
      await mk('pmtime', 'POST', '/api/pm/time', { task_id: root.id, minutes: 45, date: '2026-10-01', note: `${tag} Zeit` });
    }
    await mk('pmsection', 'POST', `/api/pm/projects/${proj.id}/sections`, { name: `${tag} Abschnitt PM` });
    await mk('pmtemplate', 'POST', `/api/pm/projects/${proj.id}/save-template`, { name: `${tag} Projektvorlage` });
  }
  await mk('pmrule', 'POST', '/api/pm/automations', { name: `${tag} Planer-Regel`, trigger: 'task.created', actions: [{ type: 'add_tag', tag: `${low}-pm` }] });
  await mk('pmview', 'POST', '/api/pm/views', { name: `${tag} Planer-Ansicht`, shared: true, config: {} });
  await mk('pmfield', 'POST', '/api/pm/custom-fields', { label: `${tag} Planer-Feld`, type: 'text' });
  // Job costing & retainers: a budget, an external cost, a retainer with one closed month (invoice draft, period) and cost rates.
  if (proj?.id) {
    await mk('pmbudget', 'PUT', `/api/pm/billing/budgets/${proj.id}`, { hours: 40, amount_cents: 500000, thresholds: [75, 100] }, () => undefined);
    await mk('pmcost', 'POST', '/api/pm/billing/costs', { project_id: proj.id, description: `${tag} Fremdkosten`, category: `${tag} Kategorie`, amount_cents: 4200 });
    const prev = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const ret = await mk('pmretainer', 'POST', '/api/pm/billing/retainers', { name: `${tag} Retainer`, project_id: proj.id, hours_per_month: 10, price_cents: 100000, overage_rate_cents: 9000, rollover: 'capped', rollover_max_hours: 4, start_month: prev, notes: `${tag} Retainer-Hinweis` });
    if (ret?.id) await mk('pmretainerclose', 'POST', `/api/pm/billing/retainers/${ret.id}/close`, {}, (d) => d?.period?.id);
  }
  const wspace = await mk('wikispace', 'POST', '/api/wiki/spaces', { name: `${tag} Wiki` });
  if (wspace?.id) {
    const wpage = await mk('wikipage', 'POST', '/api/wiki/pages', { space_id: wspace.id, title: `${tag} Seite`, body: `${tag} Text mit [Kontakt](card:contact:${c})` });
    if (wpage?.id) {
      await mk('wikicomment', 'POST', `/api/wiki/pages/${wpage.id}/comments`, { body: `${tag} Wiki-Kommentar` });
      await mk('wikishare', 'POST', `/api/wiki/pages/${wpage.id}/shares`, { label: `${tag} Link` });
      await call('POST', `/api/wiki/pages/${wpage.id}/favorite`, {}, h);
      await call('PATCH', `/api/wiki/pages/${wpage.id}`, { body: `${tag} Text, geändert` }, h);
    }
  }
  // Office: a document of the contact and the deal, with a second version and a comment (the texts carry the tag).
  const ofile = await mk('officefile', 'POST', '/api/office/files', { kind: 'docx', name: `${tag} Office-Angebot`, text: `${tag} Angebotstext`, contact_id: c, deal_id: ids.opportunity });
  if (ofile?.id) {
    await mk('officeversion', 'POST', `/api/office/files/${ofile.id}/versions`, { data: blankFile('docx', { text: `${tag} Fassung zwei` }).toString('base64'), message: `${tag} Fassung` }, () => undefined);
    await mk('officecomment', 'POST', `/api/office/files/${ofile.id}/comments`, { body: `${tag} Office-Kommentar` });
  }
  const chan = await mk('chatchannel', 'POST', '/api/team-chat/channels', { name: `${low}-kanal`, kind: 'public', topic: tag });
  if (chan?.id) await mk('chatmessage', 'POST', `/api/team-chat/channels/${chan.id}/messages`, { body: `${tag} Nachricht an @alle` });
  // Wissensgedächtnis (Cognee): sharing switched on with a remembered note (its text carries the tag), so the harness has rows to protect.
  await mk('cogneesettings', 'PUT', '/api/cognee/admin/settings', { enabled: true, types: { wiki: true, notes: true, memory: true } }, () => undefined);
  await mk('cogneememory', 'POST', '/api/cognee/remember', { text: `${tag} Gedächtnis-Hinweis` });
  await mk('calcscenario', 'POST', '/api/calc/scenarios', { name: `${tag} Szenario`, note: `${tag} Notiz`, preset: 'handwerk' });
  // Living Boards: a shared board with a note, versions, a saved template; its widgets read this sub-account's data
  const lboard = await mk('lboard', 'POST', '/api/boards', { name: `${tag} Living Board`, scope: 'shared', team_access: 'edit' });
  if (lboard?.id) {
    await mk('lboardpatch', 'POST', `/api/boards/${lboard.id}/patch`, { ops: [{ op: 'add', type: 'notes', title: `${tag} Notiz`, config: { text: `${tag} Text` } }, { op: 'add', type: 'list', config: { entity: 'deals' } }, { op: 'add', type: 'kpi' }] }, () => undefined);
    // XR: the panels of that board as this person arranged them in their headset (personal, per board)
    const lfull = await call('GET', `/api/boards/${lboard.id}`, undefined, h);
    const firstWidget = lfull.data?.spec?.widgets?.[0]?.id;
    if (firstWidget) await mk('lboardxr', 'PUT', `/api/boards/${lboard.id}/xr-layout`, { layout: { radius: 2.4, panels: { [firstWidget]: { x: -1, y: 0.2, z: -2, yaw: 0.3, scale: 1.2 } } } }, () => undefined);
    await mk('lboardtemplate', 'POST', '/api/board-templates', { board_id: lboard.id, name: `${tag} Board-Vorlage`, description: `${tag} Beschreibung` });
    await mk('lboardpersonal', 'POST', '/api/boards', { name: `${tag} Persönliches Board`, template: 'solo-cockpit' });
  }
  // XR: the Arbeitsfläche (pages side by side) of the person doing the seeding
  await mk('xrworkspace', 'PUT', '/api/xr/workspace', { layout: { panels: [{ route: 'conversations', size: 2 }, { route: 'contacts', size: 1 }, { route: 'boards', size: 1 }] } }, () => undefined);
  // Webinare: a published webinar with a registration and a question, so the isolation harness has rows to protect.
  const webinar = await mk('webinar', 'POST', '/api/webinars', { title: `${tag} Webinar`, description: `${tag} Beschreibung`, presenter_name: `${tag} Referent`, duration_s: 600, video: { type: 'url', url: `https://example.com/${low}.mp4` }, schedule: { ondemand: { enabled: true } } });
  if (webinar?.id) {
    await mk('webinarpub', 'PATCH', `/api/webinars/${webinar.id}`, { status: 'published' });
    const reg = await mk('webinarreg', 'POST', `/api/webinars/${webinar.id}/registrations`, { email: `${low}-teilnehmer@example.com`, first_name: `${tag}Teilnehmer`, session: 'ondemand' });
    const t = reg?.join_url ? new URL(reg.join_url).searchParams.get('t') : '';
    if (t) await call('POST', `/api/public/webinars/${webinar.slug}/question`, { t, text: `${tag} Frage an das Team` });
  }
  // E-Mail-Zustellung: a domain to check (adding one does not query DNS). Umzug: an uploaded export (the body goes in as sent; the file name carries the tag).
  await mk('maildomain', 'POST', '/api/mail-domains', { domain: `${low}-versand.de`, selector: low });
  await mk('umzugfile', 'POST', `/api/umzug/files?source=mailchimp&name=${encodeURIComponent(`${tag}-Export.csv`)}`, `E-Mail,Vorname\n${low}-umzug@example.com,${tag}`, (d) => d?.id);
  // Team-Posteingang: owner, internal note, a rule, availability with an out-of-office entry.
  const meUser = await call('GET', '/api/me', undefined, h);
  const myId = meUser.data?.user?.id as string | undefined;
  const convs = await call('GET', '/api/conversations', undefined, h);
  const conv = Array.isArray(convs.data) ? convs.data.find((x: any) => x.contact_id === c) : undefined;
  if (conv?.id) {
    await mk('inboxassign', 'POST', `/api/inbox/conversations/${conv.id}/assign`, { user_id: 'me' }, () => undefined);
    await mk('inboxprio', 'POST', `/api/inbox/conversations/${conv.id}/priority`, { priority: 'high' }, () => undefined);
    await mk('inboxnote', 'POST', `/api/inbox/conversations/${conv.id}/notes`, { body: `${tag} interne Teamnotiz` });
  }
  await mk('inboxsettings', 'PUT', '/api/inbox/settings', { assignment: { mode: 'round_robin', rules: [{ name: `${tag} Regel`, channels: ['email'], tags: [`${low}-tag`], target: { type: 'pool', id: '' } }] }, sla: { enabled: true }, holidays: ['2030-12-24'] }, () => undefined);
  await mk('away', 'POST', '/api/team-people/me/away', { start_at: new Date(Date.now() + 40 * 864e5).toISOString(), end_at: new Date(Date.now() + 45 * 864e5).toISOString(), note: `${tag} Urlaub` }, (d) => d?.created?.id);
  // Team-Kalender: type, questions and members of the calendar above, a routing form, a full class with somebody on the waiting list.
  if (cal?.id && myId) {
    await mk('teamcal', 'PUT', `/api/team-calendars/${cal.id}`, { config: { kind: 'round_robin', video: 'static', policy_text: `${tag} Hinweis`, questions: [{ label: `${tag} Frage`, type: 'text', required: false }] }, members: [{ user_id: myId, weight: 2 }] }, () => undefined);
    await mk('teamroute', 'POST', '/api/team-routing', { name: `${tag} Routing`, question: `${tag} Anliegen?`, options: [{ label: `${tag} Option`, calendar_id: cal.id }] });
  }
  const klasse = await mk('teamclass', 'POST', '/api/calendars', { name: `${tag} Klasse`, duration: 30, min_notice: 0, availability: every, settings: { confirmation_email: false, notify_team: false } });
  if (klasse?.id) {
    await mk('teamclasscfg', 'PUT', `/api/team-calendars/${klasse.id}`, { config: { kind: 'group', capacity: 1, waitlist: true } }, () => undefined);
    const start = `${new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10)}T10:00:00.000Z`;
    await mk('teamclassbook', 'POST', `/api/team-calendars/${klasse.id}/book`, { start, email: `${low}-klasse@example.com`, first_name: `${tag}Klasse` }, () => undefined);
    await call('POST', `/api/public/team-calendars/${klasse.slug}/book`, { start, email: `${low}-warte@example.com`, first_name: `${tag}Warte`, consent: true, waitlist: true });
  }
  // Einwilligung & Recht: a consent with proof and a Double-Opt-in request (token and proof link are keys the harness tries), plus the settings of the banner, the legal pages and the checkout.
  await mk('consentgrant', 'POST', `/api/contacts/${c}/consent`, { action: 'granted', channel: 'email', purposes: ['newsletter'], note: `${tag} Nachweis`, text: `${tag} Einwilligungstext`, proof_url: `https://example.com/${low}-consent` }, () => undefined);
  await mk('consentdoi', 'POST', `/api/contacts/${ids.contact2}/consent/doi`, { purposes: ['newsletter'] }, () => undefined);
  await mk('consentsettings', 'PUT', '/api/consent/settings', { doi: { subject: `${tag} Bitte bestätigen` } }, () => undefined);
  await mk('cmpsettings', 'PUT', '/api/cmp/settings', { title: `${tag} Banner`, policy_url: `https://example.com/${low}-datenschutz` }, () => undefined);
  await mk('legalprofile', 'PUT', '/api/legal/profile', { company: `${tag} Rechtsfirma`, owner: `${tag} Chef`, street: `${tag}straße 1`, zip: '10115', city: 'Berlin', email: `${low}-recht@example.com`, hosting: `${tag} Hosting` }, () => undefined);
  await mk('checkoutlaw', 'PUT', '/api/checkout-law/settings', { withdrawal_url: `https://example.com/${low}-widerruf` }, () => undefined);
  // Telefonie & Gesprächs-Intelligenz: numbers, menu, ring group, tracking pool, dialer list, scorecard (see seedTelephony below).
  failed.push(...(await seedTelephony(call, loc, tag, ids)));
  // Website builder 2.0: components, collections, redirects, design settings, counted page views (tests/site-fixtures.ts).
  await seedSites((m, p, b, hh) => call(m, p, b, { ...h, ...hh }), mk, tag);
  // Vertrieb: positions on the deal, a sent quote (its page token is a key the harness tries), a sequence with a running enrolment,
  // a sales team with a quota, a call summary on the deal and a pair of contacts marked "not the same person" – all carry the tag.
  if (ids.opportunity) {
    await mk('dealline', 'PUT', `/api/opportunities/${ids.opportunity}/lines`, { lines: [{ name: `${tag} Position`, description: `${tag} Beschreibung`, qty: 2, price_cents: 50000, discount_type: 'percent', discount_value: 10 }] }, () => undefined);
    const quote = await mk('quote', 'POST', '/api/quotes', { deal_id: ids.opportunity, title: `${tag} Angebot`, intro: `${tag} Einleitung`, terms: `${tag} Bedingungen`, options: [{ name: `${tag} Variante`, description: `${tag} Beschreibung`, items: [{ name: `${tag} Extra`, qty: 1, price_cents: 1000, tax_rate: 19 }] }] });
    if (quote?.id) await mk('quotesent', 'POST', `/api/quotes/${quote.id}/send`, { deliver: false }, () => undefined);
    // Internal approval of quotes: a rule (only big quotes) and a pending request with a comment on a second, big quote.
    await mk('quoterule', 'PUT', '/api/quote-approvals/settings', { enabled: true, min_net_cents: 800000, approver_role: 'leitung', self_approve: true }, () => undefined);
    const big = await mk('quotebig', 'POST', '/api/quotes', { deal_id: ids.opportunity, title: `${tag} Großangebot`, items: [{ name: `${tag} Großpaket`, qty: 1, price_cents: 900000, tax_rate: 19 }] });
    if (big?.id) await mk('quoteapproval', 'POST', `/api/quote-approvals/quotes/${big.id}/request`, { comment: `${tag} Bitte genehmigen` }, (d) => d?.current?.id);
    await mk('meetingnote', 'POST', '/api/meeting-notes', { contact_id: c, deal_id: ids.opportunity, title: `${tag} Gespräch`, summary: `${tag} Zusammenfassung des Gesprächs`, action_items: [`${tag} Folgeschritt`], source: `${tag} Quelle` });
  }
  const sequence = await mk('sequence', 'POST', '/api/sequences', { name: `${tag} Sequenz`, description: `${tag} Beschreibung`, steps: [{ type: 'task', title: `${tag} Anrufen`, delay_days: 3, note: `${tag} Notiz` }] });
  if (sequence?.id) {
    await mk('sequenceon', 'PATCH', `/api/sequences/${sequence.id}`, { status: 'active' }, () => undefined);
    await mk('sequenceenroll', 'POST', `/api/sequences/${sequence.id}/enroll`, { contact_ids: [c] }, () => undefined);
  }
  await mk('sequencesettings', 'PUT', '/api/sequence-settings', { daily_limit: 77 }, () => undefined);
  const team = await mk('salesteam', 'POST', '/api/sales/teams', { name: `${tag} Vertriebsteam`, description: `${tag} Team`, members: myId ? [{ user_id: myId, role: 'lead' }] : [] });
  if (myId) await mk('pmcostrate', 'PUT', '/api/pm/billing/cost-rates', { user_id: myId, cost_cents: 3500, default_cost_cents: 2000 }, () => undefined);
  if (myId) await mk('quota', 'PUT', '/api/quotas', { quotas: [{ scope: 'user', subject_id: myId, target: 4321 }, ...(team?.id ? [{ scope: 'team', subject_id: team.id, target: 8765 }] : [])] }, () => undefined);
  if (ids.contact2) await mk('dupeignore', 'POST', '/api/contact-duplicates/ignore', { contact_ids: [c, ids.contact2] }, () => undefined);
  await mk('callscript', 'POST', '/api/call-scripts', { name: `${tag} Leitfaden`, steps: [{ title: `${tag} Begrüßung`, text: `${tag} Text {{contact.first_name}}` }] });
  // A blocked sender (modules/inbox-spam.ts) – a contact of its own, so the others' conversations stay in the inbox.
  const spam = await mk('spamcontact', 'POST', '/api/contacts', { email: `${low}spam@example.com`, first_name: `${tag}Spam` }, (d) => d?.id ?? d?.contact?.id);
  if (spam) await mk('blockedcontact', 'POST', '/api/blocked-contacts', { contact_id: ids.spamcontact, reason: 'spam', note: `${tag} Werbung` });
  return { ids, failed };
}

/**
 * Rows of the Creator & Commerce package that only exist after a real Stripe, Meta or AI call (plan purchases, dunning cases,
 * comment events, AI drafts, quiz attempts, hand-ins), written straight into the tables so the harness has them to protect.
 * `ids` are the ids seedLocation returned for the same sub-account.
 */
export function seedCreatorRows(app: App, loc: string, ids: Record<string, string>, tag: string) {
  const low = tag.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  const at = new Date().toISOString();
  const db = app.db;
  const c = ids.contact;
  db.insert('plan_subscriptions', { id: `${low}plansub`, location_id: loc, plan_id: ids.plan ?? null, product_id: ids.product, contact_id: c, checkout_id: `cs_${low}`, stripe_subscription: `sub_${low}`, stripe_customer: `cus_${low}`, plan_name: `${tag} Raten`, installments: 3, amount_cents: 400, currency: 'EUR', interval: 'month', interval_count: 1, on_default: 'pause', tag: `${low}-plan`, tax_rate: 0, status: 'active', access: 'active', paid_count: 1, paid_cents: 400, failed_count: 0, started_at: at, created_at: at, updated_at: at });
  db.insert('dunning_cases', { id: `${low}case`, location_id: loc, contact_id: c, product_id: ids.product, product_name: `${tag} Produkt`, stripe_subscription: `sub_${low}`, stripe_customer: `cus_${low}`, stripe_invoice: `in_${low}`, plan_subscription_id: `${low}plansub`, status: 'open', amount_cents: 4900, currency: 'EUR', attempts: 1, first_failed_at: at, last_failed_at: at, reason: `${tag} Karte abgelehnt`, tag: `${low}-dunning`, created_at: at, updated_at: at });
  db.insert('igc_events', { id: `${low}igevent`, location_id: loc, rule_id: ids.igrule ?? null, platform: 'instagram', kind: 'comment', comment_id: `c_${low}`, media_id: `m_${low}`, from_id: `ig_${low}`, from_name: tag, from_username: `${low}user`, text: `${tag} guide bitte`, keyword: `${low}guide`, status: 'done', dm_status: 'sent', public_status: 'sent', contact_id: c, created_at: at, done_at: at });
  db.insert('igc_story_pending', { location_id: loc, external_id: `ig:${low}story`, story_id: `st_${low}`, text: `${tag} Story-Antwort`, from_id: `ig_${low}`, created_at: at });
  db.insert('wfai_runs', { id: `${low}wfai`, location_id: loc, user_id: null, user_name: tag, workflow_id: ids.workflow ?? null, mode: 'create', prompt: `${tag} baue einen Workflow`, status: 'ok', attempts: 1, error: '', model: 'test', tokens: 10, result: JSON.stringify({ workflow: { name: `${tag} KI-Workflow`, trigger: { type: 'manual', config: {} }, steps: [], settings: {} }, summary: `${tag} Zusammenfassung`, notes: [], warnings: [] }), applied_workflow_id: null, applied_at: null, created_at: at });
  const enr = db.get<any>('SELECT id FROM course_enrollments WHERE location_id = ? LIMIT 1', loc);
  if (enr && ids.quiz) db.insert('quiz_attempts', { id: `${low}attempt`, location_id: loc, quiz_id: ids.quiz, enrollment_id: enr.id, contact_id: c, attempt_no: 1, status: 'graded', answers: JSON.stringify({ 0: 0 }), reviews: '{}', score: 1, max_score: 1, percent: 100, passed: 1, comment: `${tag} Kommentar`, submitted_at: at, reviewed_at: at, reviewer: tag });
  if (enr && ids.assignment) db.insert('assignment_submissions', { id: `${low}submission`, location_id: loc, assignment_id: ids.assignment, enrollment_id: enr.id, contact_id: c, attempt_no: 1, text: `${tag} Abgabe`, status: 'submitted', feedback: '', reviewer: '', submitted_at: at });
  // A stopped workflow run with its error in the log (repeating it needs the failed step).
  if (ids.workflow) db.insert('workflow_runs', { id: `${low}failedrun`, workflow_id: ids.workflow, location_id: loc, contact_id: c, status: 'failed', cursor: JSON.stringify([1]), event: '{}', vars: '{}', log: JSON.stringify([{ at, step: 's1', type: 'webhook', error: `${tag} Webhook-Fehler` }]), created_at: at, updated_at: at });
  // Google review with a KI reply draft and the reply settings (a review only exists after a real Google sync): the harness must not leak them.
  db.insert('google_reviews', { id: `${low}greview`, location_id: loc, place_id: `ChIJ${low}place`, review_key: `places/${low}/reviews/1`, author: `${tag} Gast`, rating: 2, text: `${tag} Bewertungstext`, link: `https://example.com/${low}-review`, first_seen_at: at, updated_at: at, reply_draft: `${tag} Entwurf der Antwort`, reply_draft_at: at, reply_draft_source: 'ai' });
  db.insert('review_reply_settings', { location_id: loc, tone: 'herzlich', formality: 'sie', instructions: `${tag} Hinweise zur Antwort`, signature: `${tag} Grußformel`, auto_draft: 0, updated_at: at });
  // E-mail tracking: the seeded message was opened by a person and by a proxy, one link was clicked by a scanner; the campaign report
  // (/api/campaigns/:id/engagement) reads all of it, so a leak across sub-accounts would show the link with the marker.
  if (ids.message && ids.campaign) {
    db.run('UPDATE messages SET opened_at = ?, open_count = 1, machine_open_count = 1, machine_click_count = 1 WHERE id = ?', at, ids.message);
    db.insert('tracked_links', { id: `${low}tlink`, location_id: loc, message_id: ids.message, contact_id: c, url: `https://example.com/${tag}-engage`, clicks: 0, machine_clicks: 1, created_at: at });
    for (const [kind, classification, reason, applied] of [['open', 'human', 'human', 1], ['open', 'proxy', 'apple-mpp', 1], ['click', 'scanner', 'head-request', 1]] as const) {
      db.insert('email_events', { id: `${low}evt${kind}${reason}`.slice(0, 40), location_id: loc, message_id: ids.message, contact_id: c, link_id: kind === 'click' ? `${low}tlink` : null, kind, at, method: 'GET', ua_class: 'bare', ua_hash: 'abcdef012345', ip_prefix: '203.0.113.0/24', classification, reason, applied });
    }
    db.insert('campaign_recipients', { campaign_id: ids.campaign, contact_id: c, status: 'sent', message_id: ids.message, sent_at: at });
  }
  // Creator depth (hosted course video, discussion, reviews, paths, cohorts, form analytics and the CAPTCHA keys): written straight into
  // the tables – the real routes need an upload, a logged-in member or a browser.
  if (ids.course) {
    const course = ids.course;
    db.insert('course_videos', { id: `${low}video0123456789`, location_id: loc, name: `${tag} Video.mp4`, file: `${low}video0123456789.mp4`, size: 10, received: 10, status: 'complete', mime: 'video/mp4', duration_sec: 60, poster: '', hls: '', hls_note: '', ai_status: '', ai_note: '', created_at: at });
    db.insert('course_captions', { id: `${low}caption0123456789`, location_id: loc, video_id: `${low}video0123456789`, lang: 'de', label: `${tag} Deutsch`, vtt: `WEBVTT\n\n00:00.000 --> 00:02.000\n${tag} Untertitel`, source: 'upload', created_at: at });
    if (ids.lesson) db.run('UPDATE course_lessons SET video_id = ?, chapters = ? WHERE id = ?', `${low}video0123456789`, JSON.stringify([{ at: 0, title: `${tag} Kapitel` }]), ids.lesson);
    if (enr && ids.lesson) db.insert('course_playback', { enrollment_id: enr.id, lesson_id: ids.lesson, position_sec: 12, duration_sec: 60, furthest_sec: 12, watched_sec: 12, speed: 1, updated_at: at });
    if (ids.lesson) db.insert('course_comments', { id: `${low}comment0123456789`, location_id: loc, course_id: course, lesson_id: ids.lesson, parent_id: null, contact_id: c, author_name: `${tag} Autor`, staff: 0, user_id: null, body: `${tag} Frage zur Lektion`, status: 'visible', created_at: at, edited_at: null });
    db.insert('course_reviews', { id: `${low}review0123456789`, location_id: loc, course_id: course, contact_id: c, author_name: `${tag} Rezensent`, rating: 4, title: `${tag} Bewertung`, body: `${tag} Rezensionstext`, status: 'published', reply: `${tag} Antwort`, replied_at: at, created_at: at, updated_at: at });
    db.insert('course_paths', { id: `${low}path0123456789`, location_id: loc, title: `${tag} Lernpfad`, slug: `${low}-lernpfad`, description: `${tag} Pfadtext`, status: 'published', sequential: 1, unlock_percent: 100, access: JSON.stringify({ tags: [`pfad:${low}`] }), position: 0, created_at: at, updated_at: at });
    db.insert('course_path_items', { path_id: `${low}path0123456789`, course_id: course, position: 0 });
    db.insert('course_path_members', { path_id: `${low}path0123456789`, contact_id: c, location_id: loc, source: 'manual', source_ref: '', enrolled_at: at, completed_at: null });
    db.insert('course_cohorts', { id: `${low}cohort0123456789`, location_id: loc, course_id: course, name: `${tag} Cohort`, starts_at: '2030-01-15', ends_at: null, capacity: 0, group_id: null, channel_id: null, created_at: at, updated_at: at });
  }
  if (ids.form) {
    db.insert('form_events', { location_id: loc, form_id: ids.form, session: `${low}session`, kind: 'o', field: '', ms: 0, at });
    db.insert('form_events', { location_id: loc, form_id: ids.form, session: `${low}session`, kind: 'v', field: `${low}field`, ms: 1200, at });
  }
  db.insert('form_captcha', { location_id: loc, site_key: `0x4AAA${low}sitekey`, secret_sealed: sealWith(app.config, `${tag}-turnstile-secret`), hint: '…cret', updated_at: at });
  // Cookie banner log (a visitor's choice) and the stored acceptance of the terms and the waiver at a purchase.
  db.insert('cmp_log', { id: `${low}cmplog`, location_id: loc, cid: `${low}visitor`, version: 1, choice: 'custom', statistics: 1, marketing: 0, external_media: 0, page: `${low}.example.com/p/${low}`, ip_net: '203.0.113.0/24', ua_digest: 'abcdef0123456789', created_at: at });
  db.insert('checkout_acceptances', { id: `${low}accept`, location_id: loc, product_id: ids.product ?? null, session_id: `cs_${low}`, invoice_id: null, contact_id: c, email: `${low}@example.com`, terms_url: `https://example.com/${low}-agb`, terms_version: 1, waiver_kind: 'digital', waiver_version: 1, withdrawal_url: `https://example.com/${low}-widerruf`, button_text: 'zahlungspflichtig bestellen', ip_net: '203.0.113.0/24', ua_digest: 'abcdef0123456789', created_at: at });
}

/**
 * Rows of the e-mail marketing extras that need history or a worker to exist: the verdict of an address check, the members the segment
 * watcher remembers, the variant and send time of a campaign recipient and a human open the send-time hours are read from.
 */
export function seedMarketingRows(app: App, loc: string, ids: Record<string, string>, tag: string) {
  const low = tag.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  const at = new Date().toISOString();
  const db = app.db;
  const c = ids.contact;
  if (c) db.insert('mk_email_checks', { contact_id: c, location_id: loc, email: `${low}@example.com`, verdict: 'risky', issues: JSON.stringify([{ code: 'reserved', level: 'warn', text: `${tag} Hinweis zur Adresse` }]), role: 0, disposable: 0, mx: null, checked_at: at });
  if (ids.segment && c) db.insert('mk_segment_members', { segment_id: ids.segment, contact_id: c });
  if (ids.abcampaign && c) db.insert('campaign_recipients', { campaign_id: ids.abcampaign, contact_id: c, status: 'held', variant: 'A', send_at: at });
  if (ids.message && c) db.insert('email_events', { id: `${low}stoopen`, location_id: loc, message_id: ids.message, contact_id: c, kind: 'open', at, method: 'GET', ua_class: 'desktop', ua_hash: 'abcdef012345', ip_prefix: '203.0.113.0/24', classification: 'human', reason: 'human', applied: 1 });
}

/**
 * Telefonie & Gesprächs-Intelligenz through the API: the account's numbers, a telephone menu with a schedule, a ring group, a tracking
 * pool, a power-dialer list and a scorecard. Their names and texts carry the tag, so a leak shows. Returns the failed steps.
 */
export async function seedTelephony(call: Call, loc: string, tag: string, ids: Record<string, string>): Promise<string[]> {
  const h = { 'x-location-id': loc, 'x-pghl': '1' };
  const failed: string[] = [];
  const mk = async (key: string, method: string, path: string, body: any, pick: (d: any) => any = (d) => d?.id) => {
    const r = await call(method, path, body, h);
    if (r.status >= 300) {
      failed.push(`${key}: ${method} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
      return undefined;
    }
    const v = pick(r.data);
    if (typeof v === 'string') ids[key] = v;
    return r.data;
  };
  const n = ([...tag].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 800) + 100;
  const main = `+4930${n}001`;
  await mk('telsettings', 'PUT', '/api/telephony/settings', { account_sid: `AC${'0'.repeat(31)}${n % 10}`, auth_token: 'f'.repeat(32), numbers: main, forward_to: `+491512${n}0001`, hours_mode: 'always', greeting: `${tag} Begrüßung`, record_announce_text: `${tag} Aufzeichnungshinweis`, retention_recordings_days: 365 }, () => undefined);
  const reg = await mk('numberregistry', 'GET', '/api/telephony/registry', undefined, () => undefined);
  const mainRow = reg?.numbers?.find((x: any) => x.number === main);
  if (mainRow) await mk('numberlabel', 'PATCH', `/api/telephony/registry/${mainRow.id}`, { label: `${tag} Hauptnummer` }, () => undefined);
  const sched = await mk('callschedule', 'POST', '/api/telephony/schedules', { name: `${tag} Zeitplan`, german_holidays: { enabled: true, state: 'BE' }, holidays: [{ date: '12-24', name: `${tag} Heiligabend`, closed: true }] });
  const group = await mk('callgroup', 'POST', '/api/telephony/groups', { name: `${tag} Support`, kind: 'queue', strategy: 'round_robin', members: [{ type: 'number', id: `+491513${n}0002`, name: `${tag} Anna` }], welcome: `${tag} Willkommen in der Warteschlange`, overflow: { kind: 'voicemail', box: `${tag} Box`, say: `${tag} Alle Leitungen sind belegt.` } });
  const flow = await mk('ivrflow', 'POST', '/api/telephony/ivr', {
    name: `${tag} Telefonmenü`,
    flow: {
      start: 'n1',
      nodes: [
        { id: 'n1', type: 'schedule', label: `${tag} Öffnungszeiten`, schedule_id: sched?.id ?? '', open: 'n2', closed: 'n4', holiday: 'n4' },
        { id: 'n2', type: 'menu', label: `${tag} Hauptmenü`, say: `${tag} Drücken Sie die 1 für den Support.`, options: { '1': 'n3' }, on_timeout: 'n3', on_invalid: 'n3' },
        { id: 'n3', type: 'group', label: `${tag} Support-Gruppe`, group_id: group?.id ?? '', on_fail: 'n4' },
        { id: 'n4', type: 'voicemail', label: `${tag} Mailbox`, box: `${tag} Box`, say: `${tag} Bitte hinterlassen Sie eine Nachricht.` },
      ],
    },
  });
  if (flow?.id && mainRow) await mk('numberroute', 'PATCH', `/api/telephony/registry/${mainRow.id}`, { route_kind: 'ivr', route_id: flow.id }, () => undefined);
  await mk('dnipool', 'POST', '/api/telephony/dni/pools', { name: `${tag} Website`, default_number: main, fallback_number: main, sources: ['google/cpc'] });
  await mk('dialersettings', 'PUT', '/api/dialer/settings', { from: '09:00', to: '18:00', max_attempts: 4 }, () => undefined);
  await mk('dialerlist', 'POST', '/api/dialer/lists', { name: `${tag} Anrufliste`, source: 'manual', contact_ids: [ids.contact, ids.contact2].filter(Boolean), notes: `${tag} Notiz zur Liste` });
  await mk('scorecard', 'POST', '/api/call-scorecards', { name: `${tag} Scorecard`, description: `${tag} Beschreibung`, criteria: [{ id: 'gruss', label: `${tag} Begrüßung`, weight: 2, scale: 'five' }, { id: 'schritt', label: `${tag} Nächster Schritt`, weight: 3, scale: 'yesno' }] });
  return failed;
}

/**
 * Rows of the telephony package that only exist after a real call or a real Twilio / STT / AI answer (a call with its attribution, a
 * queue entry, a tracking number and its visitor session, notes and a hand-over, an uploaded audio file, an analysed conversation with its
 * score), written straight into the tables so the harness has them to protect. `ids` are the ones seedLocation returned.
 */
export function seedTelephonyRows(app: App, loc: string, ids: Record<string, string>, tag: string) {
  const low = tag.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  const n = ([...tag].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 800) + 100;
  const at = new Date().toISOString();
  const db = app.db;
  const c = ids.contact;
  const tracking = `+4930${n}002`;
  db.insert('phone_numbers', { id: `${low}trackingnum`, location_id: loc, number: tracking, sid: `PN${'a'.repeat(32)}`, label: `${tag} Anzeigen-Nummer`, kind: 'tracking', country: 'DE', number_type: 'local', route_kind: 'default', route_id: '', pool_id: ids.dnipool ?? null, source: 'google', medium: 'cpc', campaign: `${tag} Herbst`, status: 'active', purchased_at: at, created_at: at, updated_at: at });
  db.insert('calls', { id: `${low}telcall`, location_id: loc, contact_id: c, sid: `CA${'1'.repeat(30)}${n % 100}`, direction: 'in', from_number: '+491701234567', to_number: tracking, status: 'completed', answered: 1, answered_at: at, ended_at: at, duration: 95, started_at: at, updated_at: at, route_kind: 'ivr', route_id: ids.ivrflow ?? '', route_node: 'n3', route_path: `${tag} Hauptmenü > ${tag} Support-Gruppe`, voicemail_box: `${tag} Box`, tracking_number_id: `${low}trackingnum`, attr_source: 'google', attr_medium: 'cpc', attr_campaign: `${tag} Herbst`, consent_announced: 1, recording_channels: 2, wait_seconds: 12 });
  db.insert('call_notes', { id: `${low}callnote`, location_id: loc, call_id: `${low}telcall`, contact_id: c, user_id: null, note_id: null, body: `${tag} Notiz während des Gesprächs`, at_second: 40, created_at: at });
  db.insert('call_transfers', { id: `${low}transfer`, location_id: loc, call_id: `${low}telcall`, user_id: null, mode: 'warm', target_type: 'number', target_id: `+491514${n}0003`, target_label: `${tag} Kollegin`, note: `${tag} Rückfrage`, status: 'done', error: '', created_at: at, updated_at: at });
  if (ids.callgroup) db.insert('queue_calls', { id: `${low}queuecall`, location_id: loc, group_id: ids.callgroup, call_id: `${low}telcall`, status: 'answered', outcome: 'answered', tried: '[]', attempts: 1, attempt_member: '', chain: 0, enqueued_at: at, answered_at: at, answered_by: `${tag} Anna`, ended_at: at, wait_seconds: 12 });
  if (ids.dnipool) db.insert('dni_sessions', { id: `${low}dnisession`, location_id: loc, pool_id: ids.dnipool, number_id: `${low}trackingnum`, number: tracking, visitor_id: `${low}visitor`, channel: 'paid', source: 'google', medium: 'cpc', campaign: `${tag} Herbst`, content: '', term: `${tag} Suchbegriff`, gclid: `${low}gclid`, fbclid: '', landing_page: `https://example.com/${low}-landing`, referrer: 'https://www.google.com/', created_at: at, last_seen_at: at, expires_at: new Date(Date.now() + 36e5).toISOString(), calls: 1 });
  db.insert('call_audio', { id: `${low}audio`, location_id: loc, name: `${tag} Wartemusik`, kind: 'hold', mime: 'audio/wav', bytes: 1000, file: `${low}-audio.wav`, text: '', duration_s: 30, created_at: at });
  db.insert('call_intel', { id: `${low}intel`, location_id: loc, source: 'call', call_id: `${low}telcall`, contact_id: c, user_id: null, title: `${tag} Gespräch`, status: 'done', language: 'de', provider: 'test', transcript: `${tag} Kunde: Guten Tag. ${tag} Agent: Gerne, wir schicken das Angebot.`, summary: `${tag} Zusammenfassung des Gesprächs`, next_step: `${tag} Angebot senden`, action_items: JSON.stringify([{ text: `${tag} Angebot senden`, owner: 'agent' }]), topics: JSON.stringify([`${tag} Angebot`]), objections: '[]', sentiment: 'positive', metrics: JSON.stringify({ talk: { agent_pct: 55 } }), created_at: at, analyzed_at: at });
  if (ids.scorecard) {
    db.insert('call_scores', { id: `${low}score`, location_id: loc, intel_id: `${low}intel`, scorecard_id: ids.scorecard, status: 'reviewed', ai_scores: JSON.stringify({ gruss: { score: 4, reason: `${tag} Grund`, quote: `${tag} Zitat` } }), review: JSON.stringify({ gruss: { score: 3, comment: `${tag} Korrektur` } }), comment: `${tag} Gesamtkommentar`, ai_total: 70, final_total: 60, created_at: at, updated_at: at });
  }
}

/**
 * Rows of the Wissensgedächtnis that only exist after a real sync with Cognee (dataset ids, the mapping record → data item, a
 * queued deletion, a sub-account's own Cognee login), written straight into the tables so the harness has them to protect.
 */
export function seedCogneeRows(app: App, loc: string, ids: Record<string, string>, tag: string) {
  const low = tag.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  const at = new Date().toISOString();
  const uuid = (n: number) => `00000000-0000-4000-8000-${low.slice(0, 6).padEnd(6, '0')}${String(n).padStart(6, '0')}`;
  const db = app.db;
  // (a failed sync of the settings seed may already have written the state row)
  db.run(`INSERT OR REPLACE INTO cognee_state (location_id, type, dataset_id, cursor, dirty, phase, last_sync_at, last_error, attempts, skipped, updated_at) VALUES (?, 'wiki', ?, '{}', 0, 'idle', ?, ?, 0, 0, ?)`, loc, uuid(1), at, `${tag} Fehler`, at);
  db.insert('cognee_items', { id: `${low}cogneeitem`, location_id: loc, type: 'wiki', kind: 'page', record_id: ids.wikipage ?? `${low}page`, parent_id: null, contact_id: ids.contact ?? null, data_id: uuid(2), content_hash: `${low}hash`, source_rev: at, chars: 10, synced_at: at });
  db.insert('cognee_deletions', { id: `${low}cogneedel`, location_id: loc, type: 'wiki', dataset_id: uuid(1), data_id: uuid(3), reason: 'record_deleted', after_cognify: 0, attempts: 1, next_attempt_at: at, last_error: `${tag} Löschung offen`, created_at: at });
  db.insert('cognee_accounts', { location_id: loc, auth_mode: 'password', email: `${low}-cognee@example.com`, secret_sealed: sealWith(app.config, `${tag}-cognee-own`), hint: '…own', created_at: at, updated_at: at });
}

/**
 * Lexware Office / sevDesk live sync and Google Ads offline conversions: settings (no API key, so no route reaches the outside), a
 * failed push job with its log line, a contact link, conversion settings and a queued conversion – each carries the tag.
 */
export function seedBooksSyncRows(app: App, loc: string, ids: Record<string, string>, tag: string) {
  const low = tag.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  const at = new Date().toISOString();
  const db = app.db;
  db.run(`INSERT OR REPLACE INTO books_sync_settings (location_id, provider, enabled, secret_sealed, hint, options, updated_at) VALUES (?, 'lexware', 1, '', '', ?, ?)`, loc, JSON.stringify({ customer_number_field: `${low}_kdnr` }), at);
  if (ids.finalinvoice) db.insert('books_sync_jobs', { id: `${low}booksjob`, location_id: loc, invoice_id: ids.finalinvoice, provider: 'lexware', action: 'push', status: 'failed', attempts: 1, next_at: at, stage: '', remote_id: '', remote_total_cents: 0, last_error: `${tag} Lexware lehnt ab`, created_at: at, updated_at: at });
  db.insert('books_sync_log', { id: `${low}bookslog`, location_id: loc, invoice_id: ids.finalinvoice ?? null, provider: 'lexware', level: 'error', action: 'push', message: `${tag} Fehler beim Übertragen`, created_at: at });
  if (ids.contact) db.insert('books_sync_contacts', { location_id: loc, provider: 'lexware', contact_id: ids.contact, remote_id: `${low}-remote-contact`, updated_at: at });
  db.run(`INSERT OR REPLACE INTO ads_gconv_settings (location_id, enabled, config, updated_at) VALUES (?, 0, ?, ?)`, loc, JSON.stringify({ events: { form_submitted: { enabled: true, action: 'customers/1234567890/conversionActions/4711', value: 0, form_ids: [`${low}form`] } } }), at);
  if (ids.contact) db.insert('ads_gconv_queue', { id: `${low}gconv`, location_id: loc, event: 'deal_won', order_id: `deal_${low}`, contact_id: ids.contact, conversion_action: 'customers/1234567890/conversionActions/4711', value: 99, currency: 'EUR', occurred_at: at, status: 'failed', attempts: 1, next_at: at, error: `${tag} Google lehnt ab`, created_at: at });
}

/** Columns of every table, read once. */
export function tableColumns(app: App): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of app.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`)) {
    out.set(
      t.name,
      app.db.all<{ name: string }>(`PRAGMA table_info("${t.name}")`).map((c) => c.name),
    );
  }
  return out;
}

/**
 * Every row that belongs to "the other side": rows of sub-account B, plus rows that point at them,
 * plus personal rows (devices, connections…) of another user. Returns ids with their table.
 */
export function foreignIds(app: App, locB: string, otherUserId: string): { id: string; table: string; kind: 'id' | 'key' }[] {
  const cols = tableColumns(app);
  const out = new Map<string, { table: string; kind: 'id' | 'key' }>();
  const add = (v: unknown, table: string, kind: 'id' | 'key' = 'id') => {
    // Slugs made from B's names would only echo the attacker's own path back (audit log), so they are left out.
    if (typeof v === 'string' && v.length >= 2 && !out.has(v) && !v.toUpperCase().includes(MARK)) out.set(v, { table, kind });
  };
  for (const [t, cs] of cols) {
    if (!cs.includes('location_id')) continue;
    for (const r of app.db.all(`SELECT * FROM "${t}" WHERE location_id = ?`, locB)) {
      add(r.id, t);
      for (const k of ['key', 'token', 'slug', 'number']) if (k in r && (typeof r[k] === 'string' || typeof r[k] === 'number')) add(String(r[k]), t, 'key');
    }
  }
  // Child rows without a location column (notes, lessons…) that reference one of B's rows.
  for (let pass = 0; pass < 2; pass++) {
    const known = new Set(out.keys());
    for (const [t, cs] of cols) {
      if (cs.includes('location_id') || !cs.includes('id')) continue;
      const refs = cs.filter((c) => c.endsWith('_id') || c === 'user_id');
      if (!refs.length) continue;
      for (const r of app.db.all(`SELECT * FROM "${t}"`)) {
        if (refs.some((c) => known.has(r[c]) || (c === 'user_id' && r[c] === otherUserId))) add(r.id, t);
      }
    }
  }
  out.delete(locB);
  return [...out].map(([id, v]) => ({ id, ...v }));
}

const VOLATILE = new Set(['audit_log', 'sessions', 'api_keys', 'agency_api_keys', 'mobile_devices', 'mobile_feed', '_migrations', 'rate_limits', 'event_log']);

/** Rows that mention B (its location id or one of its row ids), keyed by table → row JSON. */
export function foreignSnapshot(app: App, needles: string[]): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>();
  const re = new RegExp(needles.filter((n) => n.length >= 6).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  for (const [t] of tableColumns(app)) {
    if (VOLATILE.has(t)) continue;
    const rows = new Set<string>();
    for (const r of app.db.all(`SELECT * FROM "${t}"`)) {
      const j = JSON.stringify(r);
      if (re.test(j)) rows.add(j);
    }
    snap.set(t, rows);
  }
  return snap;
}

export function diffSnapshots(a: Map<string, Set<string>>, b: Map<string, Set<string>>): string[] {
  const out: string[] = [];
  for (const [t, rows] of b) {
    const before = a.get(t) ?? new Set();
    for (const r of rows) if (!before.has(r)) out.push(`${t} +${r.slice(0, 200)}`);
    for (const r of before) if (!rows.has(r)) out.push(`${t} -${r.slice(0, 200)}`);
  }
  return out;
}

const NATURAL = ['url', 'email', 'slug', 'domain', 'code', 'handle', 'phone', 'key', 'name', 'title'];

/** Natural keys of B's rows (url, email, slug, domain…) by table, for bodies that look records up by value instead of id. */
export function foreignNaturalKeys(app: App, locB: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [t, cs] of tableColumns(app)) {
    if (!cs.includes('location_id')) continue;
    const nat = cs.filter((c) => NATURAL.includes(c));
    if (!nat.length) continue;
    const r = app.db.get(`SELECT ${nat.map((c) => `"${c}"`).join(', ')} FROM "${t}" WHERE location_id = ? LIMIT 1`, locB);
    if (!r) continue;
    const vals: Record<string, string> = {};
    for (const c of nat) if (typeof r[c] === 'string' && r[c]) vals[c] = r[c];
    if (Object.keys(vals).length) out.set(t, vals);
  }
  return out;
}

// --- cross-tenant attack (shared by the cloud isolation test) ----------------------------------------------------------

import type { Route } from '../server/core/http.js';

/** Routes that end the principal's own session or need a fresh second factor – nothing cross-tenant to test. */
export const SELF_ROUTES = [/^POST \/api\/auth\/logout$/, /^POST \/api\/me\/password$/, /^\w+ \/api\/me\/2fa/, /^\w+ \/api\/me\/sessions/, /^POST \/api\/mobile\/logout$/];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/(ies)$/, 'y')
    .replace(/(es|s)$/, '');

type Foreign = { id: string; table: string; kind: 'id' | 'key' };

function candidates(foreign: Foreign[], route: Route, i: number): string[] {
  const p = route.parts[i].slice(1);
  const hints = [p.replace(/(Id|_id)$/, '')];
  if (/^(id|lid|n)$/.test(p) || hints[0] === p) hints.push(route.parts[i - 1] ?? '');
  const want = hints.map(norm).filter((h) => h.length >= 3 && h !== 'id');
  const matched = foreign.filter((f) => want.some((h) => norm(f.table).includes(h) || h.includes(norm(f.table))));
  if (matched.length) return [...new Set(matched.map((f) => f.id))].slice(0, 25);
  const perTable = new Map<string, string[]>();
  for (const f of foreign) {
    const l = perTable.get(f.table) ?? [];
    if (l.length < 2) l.push(f.id);
    perTable.set(f.table, l);
  }
  return [...perTable.values()].flat();
}

function referenceBody(foreign: Foreign[], target: string): Record<string, any> {
  const body: Record<string, any> = { location_id: target, locationId: target, target_location_id: target, name: 'harness', title: 'harness', body: 'harness', email: 'harness@example.com' };
  for (const f of foreign.filter((x) => x.kind === 'id')) {
    const one = norm(f.table);
    for (const k of [`${one}_id`, `${one}Id`]) if (!(k in body)) body[k] = f.id;
  }
  const contacts = foreign.filter((f) => f.table === 'contacts' && f.kind === 'id').map((f) => f.id);
  Object.assign(body, { contact_id: contacts[0], contactId: contacts[0], contact_ids: contacts, contactIds: contacts, ids: foreign.filter((f) => f.kind === 'id').slice(0, 50).map((f) => f.id) });
  return body;
}

/**
 * `call` (a signed-in customer, a key …) tries every given route with the ids of `target`'s records in every path
 * parameter and with references to it in query and body. Returns the leaks: a response that contains MARK, or a row of the
 * target (or pointing at it) that changed. `target` must have been seeded with MARK (seedLocation(call, target, MARK)).
 */
export async function crossTenantAttack(o: { app: App; who: string; call: Call; target: string; targetOwnerId: string; routes: Route[]; also?: { target: string; ownerId: string }[]; variants?: number }): Promise<string[]> {
  // `also`: more sub-accounts seeded with MARK whose records are attacked and watched in the same run.
  const foreign = [...foreignIds(o.app, o.target, o.targetOwnerId), ...(o.also ?? []).flatMap((x) => foreignIds(o.app, x.target, x.ownerId))];
  const leaks: string[] = [];
  const needles = [o.target, ...(o.also ?? []).map((x) => x.target), ...foreign.filter((f) => f.kind === 'id' && f.id.length >= 12).map((f) => f.id)];
  let snap = foreignSnapshot(o.app, needles);
  const body = referenceBody(foreign, o.target);
  const c = body.contact_id;
  const query = `?contact_id=${c}&contactId=${c}&locationId=${o.target}&location_id=${o.target}`;
  for (const route of o.routes) {
    const sig = `${route.method} ${route.pattern}`;
    if (SELF_ROUTES.some((r) => r.test(sig))) continue;
    const slots = route.parts.map((p, i) => (p.startsWith(':') ? candidates(foreign, route, i).slice(0, o.variants ?? 25) : null));
    const n = Math.max(1, ...slots.map((s) => s?.length ?? 0));
    for (let v = 0; v < n; v++) {
      const path = '/' + route.parts.map((p, i) => (slots[i] ? encodeURIComponent(slots[i]![v % slots[i]!.length]) : p)).join('/');
      const r = await o.call(route.method, path + query, route.method === 'GET' ? undefined : body);
      const hit = r.text.toUpperCase().indexOf(MARK);
      if (hit >= 0) leaks.push(`${o.who} READ ${route.method} ${path} → ${r.status} ${r.text.slice(Math.max(0, hit - 80), hit + 40)}`);
    }
    if (route.method !== 'GET') {
      const next = foreignSnapshot(o.app, needles);
      const d = diffSnapshots(snap, next);
      if (d.length) leaks.push(`${o.who} WRITE ${sig}: ${d.slice(0, 3).join(' | ')}`);
      snap = next;
    }
  }
  return leaks;
}
