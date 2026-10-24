import type { App } from '../core/app.js';
import type { Ctx, User } from '../core/http.js';
import { hashPassword, id, now } from '../core/util.js';
import { createLocation } from '../modules/core.js';
import { submitForm } from '../modules/forms.js';
import { FIRST, LAST, PLANS, demoPhone } from './demo-seed-data.js';
import { seedCampaigns, seedCommunity, seedCourses, seedKnowledge, seedSites, seedSupportHistory, seedWorkflowRuns } from './demo-seed-depth.js';
import { runJobs, seedDealHistory, seedRevenueHistory, seedSaasBook, seedSubscriptions, type DealRef, type Job } from './demo-seed-history.js';
import {
  seedAgencyObjects,
  seedCallScript,
  seedClientBranding,
  seedCreator,
  seedInboxExtras,
  seedOffice,
  seedProject,
  seedQuotes,
  seedReviewPlatforms,
  seedSeries,
  seedStore,
  seedWebinar,
  seedWorkflowCanvas,
  seedXRechnung,
  type Kit,
} from './demo-seed-extras.js';
import { receiveMessage, sendToContact } from './messaging.js';
import { DEFAULT_LOST_REASONS as LOST_REASONS } from './opportunities.js';
import { callRoute } from './route-call.js';

/**
 * Fills a fresh install with convincing, entirely FICTIONAL demo data: an agency login („Nordlicht Digital“, white-label)
 * with its own sub-account and five clients – a physiotherapy practice, an electrician, an online coach, a SaaS start-up
 * (built on the HQ template) and a local shop with an online store (services/demo-seed-data.ts). Each gets contacts and
 * companies with coloured tags and custom fields, deals in every stage, quotes, tasks and notes, four weeks of appointments
 * back and forth (with a recurring series), inbox threads over e-mail, SMS and WhatsApp, invoices in every state, workflows,
 * websites, forms, reviews, tickets and more; the showcases per business live in services/demo-seed-extras.ts.
 *
 * The company looks established: twelve months of history (services/demo-seed-history.ts – paid invoices that grow month by month,
 * subscriptions with real MRR for the SaaS start-up, a few cancellations, deals won and lost every month) and depth
 * (services/demo-seed-depth.ts – courses with progress, landing pages with visits, campaigns with opens and clicks, workflow runs,
 * helpdesk tickets with customer ratings, a wiki, team chat and community). Texts and numbers: services/demo-seed-content.ts.
 *
 * Everything goes through the app's own routes (in-process via callRoute, as the demo admin), so the data always matches
 * what the real screens create; only what needs a payment or an outside service (store orders, WhatsApp) is written
 * directly. Names are invented, e-mail addresses use example.com/.org/.net, phone numbers +49 30 1234 xxx. E-mail and SMS
 * stay on the "nur speichern" provider – nothing is sent, no outside API is called. The content is deterministic (seeded
 * PRNG, dates relative to `now`); a database that already holds the demo is left as it is.
 *
 * Used by demo mode (PGHL_DEMO_MODE=1, also for the nightly reset) and by `npm run demo:seed`.
 */

export const DEMO_EMAIL_DEFAULT = 'demo@example.com';
export const DEMO_PASSWORD_DEFAULT = 'demo1234';

export interface DemoSeedOptions {
  email?: string;
  password?: string;
  name?: string;
  /** Timestamps are spread backwards from here (tests pin it). */
  now?: Date;
}

export interface DemoSeedResult {
  userId: string;
  email: string;
  password: string;
  locations: { id: string; name: string }[];
  ok: number;
  failed: string[];
}

/** Small deterministic PRNG, so every reset produces the same demo. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = ['example.com', 'example.org', 'example.net'];
const ascii = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '');

/** The demo admin and its sub-accounts; route failures are collected, never thrown. */
export async function seedDemo(app: App, opts: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  const email = (opts.email || DEMO_EMAIL_DEFAULT).toLowerCase();
  const password = opts.password || DEMO_PASSWORD_DEFAULT;
  const base = opts.now ?? new Date();
  const rand = rng(20261004);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const inDays = (d: number, hour: number, minute = 0) => {
    const t = new Date(base.getTime() + d * 864e5);
    t.setHours(hour, minute, 0, 0);
    return t.toISOString();
  };
  const ymd = (d: number) => inDays(d, 12).slice(0, 10);

  let user = app.db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user) {
    const row = { id: id(), email, name: opts.name || 'Alex Demo', password_hash: hashPassword(password), role: 'admin', locations: [], created_at: now() };
    app.db.insert('users', row);
    user = app.db.get('SELECT * FROM users WHERE id = ?', row.id);
  }
  if (!user) throw new Error('Demo-Login konnte nicht angelegt werden');
  // The shared demo login is already "set up": no first-run offer of the starter profiles (modules/appearance.ts).
  app.db.run('INSERT INTO user_prefs (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', user.id, JSON.stringify({ asked: true }), now());
  const me: User = { id: user.id, email: user.email, name: user.name, role: 'admin', locations: [], permissions: null };
  const result: DemoSeedResult = { userId: me.id, email, password, locations: [], ok: 0, failed: [] };

  // Idempotent: a database that already holds the demo sub-accounts is not seeded twice.
  const existing = PLANS.map((p) => app.db.get<{ id: string; name: string }>('SELECT id, name FROM locations WHERE name = ?', p.name));
  if (existing.every(Boolean)) return { ...result, locations: existing as { id: string; name: string }[] };

  const ctxFor = (locationId: string): Ctx =>
    ({
      req: { headers: { 'user-agent': 'demo-seed' }, socket: { remoteAddress: '127.0.0.1' } },
      res: {},
      method: 'GET',
      url: new URL('http://local/'),
      path: '/',
      params: {},
      query: new URLSearchParams(),
      body: {},
      rawBody: '',
      user: me,
      locationId,
      viaApiKey: false,
      via: 'session',
      ip: '127.0.0.1',
      cookies: {},
      setCookie() {},
      // Lets the demo module's write restrictions through for the seed itself.
      demoSeed: true,
    }) as unknown as Ctx;

  // Route handlers are mostly synchronous: give the event loop a turn between steps, so a running
  // server keeps answering requests while the demo is (re)built.
  const breathe = () => new Promise<void>((r) => setImmediate(r));
  const run = async <T = any>(locationId: string, method: string, path: string, body?: Record<string, any>): Promise<T | undefined> => {
    await breathe();
    try {
      const r = await callRoute(app, ctxFor(locationId), method, path, body ?? {}, { locationId });
      result.ok++;
      return r as T;
    } catch (e) {
      result.failed.push(`${method} ${path}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const step = async (label: string, fn: () => unknown | Promise<unknown>) => {
    await breathe();
    try {
      await fn();
      result.ok++;
    } catch (e) {
      result.failed.push(`${label}: ${(e as Error).message}`);
    }
  };

  // Agency branding for the demo (PGHL_DEMO_BRAND names a public demo, e.g. "HyperLevel" → "HyperLevel Demo"; it survives the nightly reset).
  const brand = String(process.env.PGHL_DEMO_BRAND ?? '').trim().slice(0, 60) || 'HyperLevel';
  await run('', 'PATCH', '/api/agency/branding', { name: `${brand} Demo`, color: '#2563eb', login_title: `${brand} – Live-Demo`, login_text: 'Alles hier ist erfunden. Daten werden täglich zurückgesetzt.' });

  for (const [pi, plan] of PLANS.entries()) {
    const loc = createLocation(app.db, plan.name, 'Europe/Berlin', { email: plan.email, address: plan.address, website: plan.website, phone: demoPhone(900 + pi * 10) });
    result.locations.push({ id: loc.id, name: loc.name });
    const L = loc.id;
    const dated = new Set<string>();
    const call = <T = any>(method: string, path: string, body?: Record<string, any>) => run<T>(L, method, path, body);
    const contacts: any[] = [];
    const k: Kit = { app, me, L, plan, contacts, contact: (i) => contacts[i % Math.max(contacts.length, 1)], call, step, inDays, ymd, rand, nowMs: base.getTime(), dated };
    const contact = k.contact;

    // The demo websites are fictional (.example) – no uptime checks against them.
    await call('PUT', '/api/project', { ...plan.project, website: plan.website, monitor: false });
    await seedClientBranding(k);
    if (plan.hq) await call('POST', '/api/snapshot-templates/saas-hq/apply', { location_id: L });

    // --- tags (with colours), contact fields and custom values ----------------------------------
    for (const [name, color] of plan.tags) {
      const tag = await call('POST', '/api/tags', { name });
      if (tag?.id) await call('PATCH', `/api/tags/${tag.id}`, { color });
    }
    const haveFields = new Set(app.db.all<{ key: string }>('SELECT key FROM custom_fields WHERE location_id = ?', L).map((f) => f.key));
    for (const [i, f] of plan.fields.entries()) if (!haveFields.has(f.key)) await call('POST', '/api/custom-fields', { key: f.key, label: f.label, type: f.type, options: f.options ?? [], position: i });
    for (const [name, value] of plan.values) await call('POST', '/api/custom-values', { name, value, folder: 'Allgemein' });

    // --- contacts (companies come from the "Firma" field) ---------------------------------
    const tagNames = plan.tags.map(([n]) => n);
    for (let i = 0; i < plan.contacts; i++) {
      const first = FIRST[(i * 7 + pi * 5) % FIRST.length];
      const last = LAST[(i * 11 + pi * 3) % LAST.length];
      const company = plan.companies.length && rand() < 0.55 ? plan.companies[i % plan.companies.length][0] : '';
      const tags = [pick(tagNames), ...(rand() < 0.4 ? [pick(tagNames)] : [])];
      const custom = Object.fromEntries(plan.fields.map((f) => [f.key, f.options ? f.options[(i + pi) % f.options.length] : f.range ? f.range[0] + Math.floor(rand() * (f.range[1] - f.range[0])) : '']));
      const c = await call('POST', '/api/contacts', {
        first_name: first,
        last_name: last,
        email: `${ascii(first)}.${ascii(last)}${i > 20 ? i : ''}@${DOMAINS[i % DOMAINS.length]}`,
        phone: demoPhone(pi * 150 + i),
        company,
        tags: [...new Set(tags)],
        source: pick(plan.sources),
        custom,
      });
      if (c?.id) contacts.push(c);
    }
    if (!contacts.length) continue;

    // companies: industry and city
    const companies = (await call<any[]>('GET', '/api/companies')) ?? [];
    for (const [name, industry, city] of plan.companies) {
      const co = (Array.isArray(companies) ? companies : ((companies as any).companies ?? [])).find((x: any) => x.name === name);
      if (co?.id) await call('PATCH', `/api/companies/${co.id}`, { industry, city, country: 'DE', size: ['1-10', '11-50', '51-200'][name.length % 3] });
    }
    // saved lists for the contact list view
    await call('POST', '/api/smart-lists', { name: `${tagNames[0]} (alle)`, filter: { q: '', tags: [tagNames[0]] } });
    await call('POST', '/api/smart-lists', { name: `${tagNames[1]} – nachfassen`, filter: { q: '', tags: [tagNames[1]] } });

    // notes with titles, colours and pinning
    for (const [i, [title, body, color, pinned]] of ([
      ['Wichtig', 'Möchte im Frühjahr starten, Budget ist freigegeben. Ruft am liebsten vormittags an.', 'yellow', true],
      ['Empfehlung', 'Hat über eine Empfehlung von Kundin Hoffmann zu uns gefunden.', 'green', false],
      ['Angebot', 'Wünscht ein schriftliches Angebot bis Freitag.', 'blue', true],
      ['Erstgespräch', 'War beim Erstgespräch sehr gut vorbereitet – Unterlagen liegen im Ordner.', '', false],
      ['Achtung', 'Zahlt Rechnungen oft spät – Vorkasse anbieten.', 'red', false],
    ] as const).entries())
      await call('POST', '/api/notes', { contact_id: contact(i * 3).id, title, body, color, pinned });

    // --- products (the price list the invoices, subscriptions and the store are made of) ---------
    const products: any[] = [];
    for (const [name, description, price_cents] of plan.products) {
      const p = await call('POST', '/api/products', { name, description, price_cents, tax_rate: 19 });
      if (p?.id) products.push(p);
    }

    // --- pipeline & deals ----------------------------------------------------------------------
    const pipelines = (await call<any[]>('GET', '/api/pipelines')) ?? [];
    const pipe = pipelines.find((p) => p.name === plan.pipeline) ?? pipelines[0];
    const deals: DealRef[] = [];
    // invoices of the history are created oldest first (see runJobs), so the invoice numbers follow the dates
    const invoiceJobs: Job[] = [];
    if (pipe) {
      if (plan.key === 'saas') deals.push(...(await seedSaasBook(k, products, pipe, invoiceJobs)));
      else {
        for (const [i, [name, euros]] of plan.deals.entries()) {
          const stage = pipe.stages[i % pipe.stages.length];
          const o = await call('POST', '/api/opportunities', { contact_id: contact(i).id, pipeline_id: pipe.id, stage_id: stage?.id, name, value: euros, source: pick(plan.sources) });
          if (!o?.id) continue;
          let status = 'open';
          if (i % 5 === 4) status = 'won';
          else if (i % 7 === 6) status = 'lost';
          // A lost deal always says why (opportunities.ts); without it the PATCH was refused and the demo showed no lost deals at all.
          if (status !== 'open') await call('PATCH', `/api/opportunities/${o.id}`, status === 'lost' ? { status, lost_reason: LOST_REASONS[i % LOST_REASONS.length] } : { status });
          deals.push({ id: o.id, name, value: euros, status });
        }
        await seedDealHistory(k, pipe, deals);
      }
    }

    // --- tasks -------------------------------------------------------------------------------
    const taskList: [string, number, boolean][] = [
      ['Angebot nachfassen', -2, false],
      ['Rückruf: Fragen zum Vertrag', 0, false],
      ['Unterlagen für Termin vorbereiten', 1, false],
      ['Rechnung prüfen und freigeben', 3, false],
      ['Feedback-Gespräch planen', 6, false],
      ['Bewertung anfragen', 9, false],
      ['Kundenliste aufräumen', -5, true],
      ['Monatsbericht verschicken', -1, true],
    ];
    for (const [i, [title, due, done]] of taskList.entries()) {
      const t = await call('POST', '/api/tasks', { title, contact_id: i % 2 ? contact(i + 2).id : undefined, due_at: inDays(due, 10 + (i % 6)) });
      if (t?.id && done) await call('PATCH', `/api/tasks/${t.id}`, { done: true });
    }

    // --- calendars & appointments: four weeks back and forth, weekdays, plus a recurring series ---
    const cals: any[] = [];
    for (const [name, duration, description] of plan.calendars) {
      const c = await call('POST', '/api/calendars', { name, duration, description });
      if (c?.id) cals.push(c);
    }
    if (cals.length) {
      let n = 0;
      for (let d = -28; d <= 28; d++) {
        const wd = new Date(inDays(d, 12)).getDay();
        if (wd === 0 || wd === 6 || d === 0) continue;
        const per = plan.perDay > 1 ? plan.perDay - ((d + 28) % 2) : (d + 28) % 3 === 2 ? 0 : 1;
        for (let j = 0; j < per; j++, n++) {
          const start = inDays(d, 8 + ((j * 2 + (d & 1)) % 9), j % 2 ? 30 : 0);
          const a = await call('POST', '/api/appointments', { calendar_id: cals[n % cals.length].id, contact_id: contact(n + 1).id, start, notes: 'Demo-Termin', force: true });
          if (a?.id && d < 0) await call('PATCH', `/api/appointments/${a.id}`, { status: n % 9 === 4 ? 'noshow' : 'showed' });
        }
      }
      await seedSeries(k, cals[0].id);
    }

    // --- forms & submissions -------------------------------------------------------------------
    const form = await call('POST', '/api/forms', { name: plan.form });
    if (form?.id) {
      const f = app.db.get('SELECT * FROM forms WHERE id = ?', form.id);
      if (f) {
        f.fields = JSON.parse(f.fields);
        f.settings = JSON.parse(f.settings);
        f.settings.notify_team = false;
        const msgs = ['Ich hätte gern ein Angebot.', 'Habt ihr nächste Woche einen Termin frei?', 'Wie läuft die Zusammenarbeit ab?', 'Bitte um Rückruf am Nachmittag.', 'Gibt es auch Pakete für Vereine?'];
        for (let i = 0; i < 10; i++) {
          const first = FIRST[(i * 5 + 3 + pi) % FIRST.length];
          const last = LAST[(i * 3 + 17 + pi) % LAST.length];
          await step('form submit', () =>
            submitForm(app, f, { first_name: first, last_name: last, email: `${ascii(first)}.${ascii(last)}.anfrage${pi}${i}@example.org`, phone: '', message: msgs[i % msgs.length], consent: 'ja', _utm_source: pick(['google', 'instagram', 'newsletter']), _utm_medium: pick(['cpc', 'social', 'email']) }),
          );
        }
      }
    }

    // --- website / funnel & blog ----------------------------------------------------------------
    const site = await call('POST', '/api/funnels', { name: `${plan.name} Website`, kind: 'website' });
    await call('POST', '/api/funnels', { name: plan.funnel });
    if (site?.id)
      for (const [title, intro] of plan.posts)
        await call('POST', `/api/funnels/${site.id}/posts`, { title, content: `${intro}\n\n## Das Wichtigste in Kürze\n\n- Erfundener Demo-Beitrag\n- Wird täglich zurückgesetzt\n- Kann frei bearbeitet werden`, status: 'published', author: me.name, tags: ['Tipps'] });

    // --- landing pages, a booking page and a webinar funnel besides the website – all with visits ---
    await seedSites(k);

    // --- invoices (draft, sent, overdue, paid, XRechnung), subscriptions & offers -----------------------
    if (products.length) {
      // twelve months of paid invoices and the subscriptions come first (oldest first), then this quarter's invoices in every state
      seedRevenueHistory(k, products, invoiceJobs);
      seedSubscriptions(k, products, invoiceJobs);
      await runJobs(invoiceJobs);
      for (let i = 0; i < 12; i++) {
        const p = products[i % products.length];
        const qty = 1 + (i % 3 === 2 ? 1 : 0);
        // The invoice date is part of what finalising freezes: it is chosen here, not moved afterwards.
        // 0–6 paid (over the last three months), 7–8 overdue, 9–10 sent and not due yet, 11 draft.
        const due = i < 7 ? -75 + i * 11 : i < 9 ? -6 - i : 14;
        const inv = await call('POST', '/api/invoices', { contact_id: contact(i + 3).id, title: p.name, items: [{ name: p.name, qty, price_cents: p.price_cents, tax_rate: 19 }], issued_at: inDays(due - 14, 9), due_at: inDays(due, 12) });
        if (!inv?.id) continue;
        if (i < 7) await call('PATCH', `/api/invoices/${inv.id}`, { status: 'paid' });
        else if (i < 11) await call('PATCH', `/api/invoices/${inv.id}`, { status: 'sent' });
      }
      await call('POST', '/api/invoices', { kind: 'estimate', contact_id: contact(1).id, title: `Angebot: ${products[0].name}`, items: [{ name: products[0].name, qty: 1, price_cents: products[0].price_cents, tax_rate: 19 }] });
      if (plan.key === 'craft' || plan.key === 'agency') await seedXRechnung(k, products[0]);
      await seedQuotes(k, deals, products);
    }

    // --- inbox: inbound e-mail/SMS, replies (stored only), WhatsApp and internal notes ------------
    const threads: [string, 'email' | 'sms', string][] = [
      ['Frage zum Angebot', 'email', 'Hallo, kurze Frage: Ist im Paket alles enthalten, was wir besprochen haben? Viele Grüße'],
      ['Termin verschieben', 'sms', 'Hi, kann ich den Termin am Donnerstag auf 15 Uhr verschieben?'],
      ['Danke!', 'email', 'Vielen Dank für die schnelle Hilfe gestern – alles funktioniert wieder.'],
      ['Rechnung', 'email', 'Guten Tag, könnten Sie mir die Rechnung noch einmal als PDF schicken?'],
      ['Rückruf', 'sms', 'Bitte um Rückruf, bin ab 14 Uhr erreichbar.'],
      ['Neue Idee', 'email', 'Wir überlegen, das Angebot zu erweitern. Habt ihr dafür einen Vorschlag?'],
      ['Parkplatz?', 'sms', 'Gibt es bei euch Parkplätze vor der Tür?'],
      ['Preise für Gruppen', 'email', 'Guten Tag, wir sind eine Gruppe von zwölf Personen. Gibt es dafür ein Paket oder einen Rabatt?'],
      ['Erinnerung Termin', 'sms', 'Danke für die Erinnerung, ich bin morgen pünktlich da.'],
      ['Wie läuft der Ablauf?', 'email', 'Hallo, können Sie mir kurz erklären, wie die Zusammenarbeit abläuft und was ich vorbereiten muss?'],
      ['Feedback', 'email', 'Ich wollte Ihnen ein kurzes Feedback geben: alles hat bestens geklappt, wir empfehlen Sie weiter!'],
      ['Öffnungszeiten über Feiertage', 'sms', 'Habt ihr über die Feiertage geöffnet?'],
      ['Unterlagen nachgereicht', 'email', 'Anbei die fehlenden Unterlagen – geben Sie bitte kurz Bescheid, ob alles angekommen ist.'],
      ['Wechsel des Tarifs', 'email', 'Wir möchten gern auf das größere Paket wechseln. Was müssen wir dafür tun?'],
      ['Zahlung erfolgt', 'email', 'Die Überweisung ist heute rausgegangen. Bitte kurz bestätigen, wenn sie da ist.'],
    ];
    for (const [i, [subject, channel, body]] of threads.entries()) {
      const c = contact(i * 2 + 1);
      await step('inbound message', () => receiveMessage(app, L, { channel, from: channel === 'email' ? c.email : c.phone, subject, body, name: `${c.first_name} ${c.last_name}` }));
      if (i % 2 === 0) await step('reply', () => sendToContact(app, L, { contactId: c.id, channel, subject: `Re: ${subject}`, body: `Hallo ${c.first_name},\n\ndanke für deine Nachricht – wir kümmern uns heute darum.\n\nViele Grüße\n${plan.name}`, userId: me.id }));
    }
    await seedInboxExtras(k);

    // --- campaigns & templates -------------------------------------------------------------------
    await seedCampaigns(k);
    await call('POST', '/api/campaigns', { name: 'Winter-Aktion (Entwurf)', channel: 'email', subject: 'Unser Winter-Angebot', body: 'Hallo {{contact.first_name|du}},\n\nnur bis Ende Dezember …', filter: { tags: [tagNames[0]] } });
    await call('POST', '/api/templates', { name: 'Terminbestätigung', channel: 'email', subject: 'Dein Termin bei {{location.name}}', body: 'Hallo {{contact.first_name}},\n\nwir freuen uns auf dich!' });

    // --- workflows from the built-in recipes (one with a paused step on the canvas) ---------------
    const meta = await call('GET', '/api/workflows/meta');
    for (const [i, r] of (meta?.recipes ?? []).entries()) {
      const w = await call('POST', '/api/workflows', { recipe: r.key });
      if (!w?.id || i > 5) continue;
      await call('PATCH', `/api/workflows/${w.id}`, { status: 'active' });
      if (i === 0) await seedWorkflowCanvas(k, w.id);
    }
    await seedWorkflowRuns(k);

    // --- reviews: own review requests and other platforms ----------------------------------------
    const reviewCount = plan.key === 'physio' || plan.key === 'shop' ? 24 : 18;
    for (let i = 0; i < reviewCount; i++) {
      const req = await call('POST', '/api/reviews/request', { contact_id: contact(i + 4).id, channel: 'email' });
      const tokenValue = req?.token ?? app.db.get('SELECT token FROM review_requests WHERE location_id = ? ORDER BY created_at DESC LIMIT 1', L)?.token;
      if (tokenValue && i < reviewCount - 1) {
        const comments = ['Sehr freundlich und kompetent!', 'Schnell, zuverlässig, tolle Beratung.', 'Hat mir super geholfen.', 'Alles bestens, gerne wieder.', 'Etwas Wartezeit, sonst top.', 'Klare Empfehlung!', 'Immer wieder gern – das ganze Team ist klasse.', 'Fair, ehrlich und pünktlich.'];
        // mostly five stars, a few fours and one three: an average of about 4.7
        await run(L, 'POST', `/api/public/reviews/${tokenValue}`, { rating: i % 8 === 3 ? 4 : i % 17 === 9 ? 3 : 5, comment: comments[i % comments.length], public: true });
      }
    }
    await seedReviewPlatforms(k);

    // --- service: tickets & help center -------------------------------------------------------------
    const ticketSpecs: [string, string, string][] = [
      ['Login funktioniert nicht', 'Seit heute Morgen komme ich nicht mehr in den Kundenbereich.', 'hoch'],
      ['Rechnung doppelt erhalten', 'Ich habe die Rechnung vom letzten Monat zweimal bekommen.', 'normal'],
      ['Frage zur Kündigungsfrist', 'Wie lange läuft mein Vertrag noch?', 'niedrig'],
      ['Website lädt langsam', 'Die Startseite braucht seit gestern sehr lange.', 'dringend'],
    ];
    for (const [i, [subject, description, priority]] of ticketSpecs.slice(0, plan.tickets).entries()) await call('POST', '/api/tickets', { subject, description, contact_id: contact(i + 6).id, priority });
    await seedSupportHistory(k);
    if (!plan.hq) {
      const kb = await call('POST', '/api/kb/categories', { name: 'Erste Schritte', description: 'Antworten auf die häufigsten Fragen.' });
      for (const [title, body] of [
        ['So buchst du einen Termin', '## Termin buchen\n\n1. Öffne die Buchungsseite.\n2. Wähle einen freien Termin.\n3. Trag Name und E-Mail ein – fertig.'],
        ['Rechnung herunterladen', 'Jede Rechnung hat einen Link zum Drucken oder Speichern als PDF.'],
        ['Termin absagen oder verschieben', 'In der Bestätigungs-Mail findest du einen Link zum Absagen.'],
      ] as const)
        await call('POST', '/api/kb/articles', { title, body, category_id: kb?.id, status: 'published', tags: ['Hilfe'] });
    }

    // --- contracts ------------------------------------------------------------------------------------
    await call('POST', '/api/contracts', { kind: 'template', title: 'Dienstleistungsvertrag', content: '# Dienstleistungsvertrag\n\nZwischen {{location.name}} und {{contact.first_name}} {{contact.last_name}}.\n\n## Leistung\nWie im Angebot beschrieben.\n\nOrt, Datum: ________________' });

    // --- per-business showcases -------------------------------------------------------------------------
    await seedCallScript(k);
    await seedProject(k);
    await seedOffice(k);
    await seedWebinar(k);
    await seedCourses(k);
    await seedKnowledge(k);
    await seedCommunity(k);
    await seedStore(k, products);
    if (plan.key === 'coach') await seedCreator(k);
    if (plan.key === 'agency') await seedAgencyObjects(k);
    for (const key of plan.reports) await call('POST', `/api/reports/templates/${key}`, {});

    // --- spread the history over the last twelve months -------------------------------------------
    await step('backdate', () => backdate(app, L, base, rand, dated));
  }

  await app.events.flush();
  return result;
}

/**
 * Moves created_at (and related timestamps) of the seeded rows into the past, so charts and lists look lived-in: contacts and
 * companies over the last year (more of them recently – the business grows), the rest over weeks or months. Rows whose dates
 * the history set explicitly (`dated`: deals, tickets, reviews …) and the messages of sent campaigns keep them.
 */
function backdate(app: App, locationId: string, base: Date, rand: () => number, dated: Set<string>) {
  const db = app.db;
  const iso = (daysBack: number) => new Date(base.getTime() - daysBack * 864e5 - Math.floor(rand() * 8 * 3600e3)).toISOString();
  const hasColumn = (table: string, column: string) => db.all(`PRAGMA table_info(${table})`).some((c: any) => c.name === column);
  /**
   * The rows in the order they were made, the first the oldest: evenly spread over `maxDays` (stratified, so the last 30 days
   * always hold their fair share). bias > 1 puts more rows into the recent past (the business grows, charts look busier).
   */
  const spread = (table: string, maxDays: number, extra: string[] = [], bias = 1) => {
    if (!hasColumn(table, 'created_at') || !hasColumn(table, 'location_id')) return;
    const rows = db.all(`SELECT id FROM ${table} WHERE location_id = ? ORDER BY rowid`, locationId).filter((r: any) => !dated.has(r.id));
    for (const [i, row] of rows.entries()) {
      const t = iso(Math.floor(Math.pow(1 - (i + rand()) / rows.length, bias) * maxDays));
      const cols = ['created_at', ...extra.filter((c) => hasColumn(table, c))];
      db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map(() => t), row.id);
    }
  };
  db.tx(() => {
    spread('contacts', 365, ['updated_at'], 1.7);
    spread('companies', 365, ['updated_at'], 1.4);
    spread('notes', 60, ['updated_at'], 1.3);
    spread('form_submissions', 60, [], 1.4);
    spread('tickets', 20, ['updated_at']);
    spread('review_requests', 330, [], 1.3);
    // Open deals were created over the last two months, closed ones within the last weeks (the history's deals are dated already).
    for (const o of db.all('SELECT id, status FROM opportunities WHERE location_id = ?', locationId)) {
      if (dated.has(o.id)) continue;
      const created = iso(10 + Math.floor(rand() * 75));
      const updated = o.status === 'open' ? created : iso(Math.floor(rand() * 40));
      db.run('UPDATE opportunities SET created_at = ?, updated_at = ? WHERE id = ?', created, updated, o.id);
    }
    for (const inv of db.all('SELECT id, status, issued_at, finalised_at FROM invoices WHERE location_id = ?', locationId)) {
      // finalised invoices keep the date they were created with (the database refuses to move it)
      const frozen = !!inv.finalised_at;
      const issued = frozen ? inv.issued_at : iso(5 + Math.floor(rand() * 55));
      db.run(`UPDATE invoices SET created_at = ?${hasColumn('invoices', 'issued_at') && !frozen ? ', issued_at = ?' : ''} WHERE id = ?`, ...(hasColumn('invoices', 'issued_at') && !frozen ? [issued, issued] : [issued]), inv.id);
      if (inv.status === 'paid') db.run('UPDATE invoices SET paid_at = ? WHERE id = ?', new Date(Math.min(Date.parse(issued) + (2 + Math.floor(rand() * 10)) * 864e5, base.getTime())).toISOString(), inv.id);
    }
    // Appointments were booked a few days before they take place (the dashboard counts what was booked recently).
    for (const a of db.all('SELECT id, start_at FROM appointments WHERE location_id = ?', locationId)) {
      const booked = Math.min(Date.parse(a.start_at) - (1 + Math.floor(rand() * 12)) * 864e5, base.getTime() - Math.floor(rand() * 5 * 3600e3));
      db.run('UPDATE appointments SET created_at = ? WHERE id = ?', new Date(booked).toISOString(), a.id);
    }
    // Inbox: every conversation happened on one day (most of them recently), its messages a little apart; campaign mails keep their send date.
    const sentMails = new Set(db.all('SELECT r.message_id AS m FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE c.location_id = ? AND r.message_id IS NOT NULL', locationId).map((r: any) => r.m));
    for (const c of db.all('SELECT id FROM conversations WHERE location_id = ?', locationId)) {
      const day = Math.floor(Math.pow(rand(), 2.4) * 75);
      let at = base.getTime() - day * 864e5 - Math.floor(rand() * 10 * 3600e3);
      for (const m of db.all('SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid', c.id)) {
        if (sentMails.has(m.id)) continue;
        db.run('UPDATE messages SET created_at = ? WHERE id = ?', new Date(Math.min(at, base.getTime())).toISOString(), m.id);
        at += (20 + Math.floor(rand() * 160)) * 60e3;
      }
      const last = db.get('SELECT MAX(created_at) t FROM messages WHERE conversation_id = ?', c.id)?.t;
      if (last) db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', last, c.id);
    }
  });
}
