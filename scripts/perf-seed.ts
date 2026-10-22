/**
 * Fills an empty data folder with a large, fictional data set for load tests (docs/performance.md):
 * 50 sub-accounts, 100k contacts, 20k deals, 200k messages, 50k tasks, 5k invoices, 100k activities.
 * Names, e-mail addresses (example.test) and phone numbers are made up; nothing is sent anywhere.
 *
 *   npm run perf:seed -- --data-dir ./perf-data            # full size (about 15 s, 220 MB)
 *   npm run perf:seed -- --data-dir ./perf-data --scale 0.1 # a tenth of everything
 *   PGHL_DATA_DIR=./perf-data npm start                     # then start the server on it
 *   npm run perf:bench -- --url http://127.0.0.1:4700
 *
 * The same data every time (fixed random seed). Login: perf@example.test / perf-pass-123.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../server/core/app.js';
import { loadConfig } from '../server/config.js';
import { MODULES } from '../server/modules/index.js';
import { createLocation } from '../server/modules/core.js';
import { hashPassword, id } from '../server/core/util.js';
import type { App } from '../server/core/app.js';

export const PERF_EMAIL = 'perf@example.test';
export const PERF_PASSWORD = 'perf-pass-123';

export interface PerfCounts {
  locations: number;
  contacts: number;
  deals: number;
  messages: number;
  tasks: number;
  invoices: number;
  activities: number;
}
export const FULL: PerfCounts = { locations: 50, contacts: 100_000, deals: 20_000, messages: 200_000, tasks: 50_000, invoices: 5_000, activities: 100_000 };

/** mulberry32: a small seeded generator, so every run builds the same data. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Anna', 'Ben', 'Clara', 'David', 'Emma', 'Felix', 'Greta', 'Hannes', 'Ida', 'Jonas', 'Klara', 'Leon', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rosa', 'Samuel', 'Tilda', 'Uwe', 'Vera', 'Willi', 'Xenia', 'Yusuf', 'Zoe'];
const LAST = ['Adler', 'Berg', 'Conrad', 'Dietz', 'Engel', 'Fuchs', 'Graf', 'Haas', 'Imhof', 'Jung', 'Kraus', 'Lenz', 'Moser', 'Nagel', 'Ott', 'Pohl', 'Quast', 'Rieger', 'Sommer', 'Thiel', 'Ulrich', 'Voss', 'Wagner', 'Xander', 'Yilmaz', 'Zeller'];
const COMPANIES = ['Beispiel GmbH', 'Muster AG', 'Testhaus', 'Demo & Söhne', 'Fiktiv Consulting', 'Platzhalter UG', 'Sample Studio', 'Nordlicht Medien', 'Alpenblick Treuhand', 'Kieselstein Handwerk'];
const CITIES = ['Berlin', 'Hamburg', 'München', 'Köln', 'Frankfurt', 'Stuttgart', 'Leipzig', 'Dresden', 'Wien', 'Zürich'];
const SOURCES = ['Website', 'Formular', 'Empfehlung', 'Messe', 'Anzeige', 'Import'];
const TAGS = ['lead', 'kunde', 'newsletter', 'vip', 'messe-2026', 'webinar', 'partner'];
const WORDS = 'Hallo danke für Ihre Anfrage wir melden uns Termin Angebot Rechnung Rückfrage Lieferung morgen heute gerne bitte Unterlagen Projekt Preis Start Woche Besprechung'.split(' ');

const iso = (ms: number) => new Date(ms).toISOString();

export interface SeedResult {
  email: string;
  password: string;
  counts: PerfCounts;
  seconds: number;
  /** The biggest sub-account, to benchmark against. */
  bigLocation: string;
}

/** Seeds an app whose database is empty. */
export async function seedPerfData(app: App, scale = 1, log: (m: string) => void = () => undefined): Promise<SeedResult> {
  const t0 = Date.now();
  const want: PerfCounts = {
    locations: Math.max(2, Math.round(FULL.locations * Math.min(1, Math.max(scale, 0.04)))),
    contacts: Math.round(FULL.contacts * scale),
    deals: Math.round(FULL.deals * scale),
    messages: Math.round(FULL.messages * scale),
    tasks: Math.round(FULL.tasks * scale),
    invoices: Math.round(FULL.invoices * scale),
    activities: Math.round(FULL.activities * scale),
  };
  const rnd = rng(20261004);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const raw = app.db.raw;
  const nowMs = Date.now();
  const YEAR = 365 * 864e5;

  // The admin and the sub-accounts (each with its default pipeline).
  const passwordHash = hashPassword(PERF_PASSWORD);
  app.db.insert('users', { id: id(), email: PERF_EMAIL, name: 'Perf Admin', password_hash: passwordHash, role: 'admin', locations: [], created_at: iso(nowMs) });
  const locs = Array.from({ length: want.locations }, (_, i) => {
    const l = createLocation(app.db, `Beispiel ${String(i + 1).padStart(2, '0')} ${pick(COMPANIES)}`, 'Europe/Berlin');
    const pipeline = app.db.get('SELECT id, stages FROM pipelines WHERE location_id = ?', l.id)!;
    return { id: l.id as string, pipeline: pipeline.id as string, stages: (JSON.parse(pipeline.stages) as { id: string }[]).map((s) => s.id), contacts: [] as string[], invoiceNo: 0 };
  });
  // A few client logins (members), one per ten sub-accounts.
  for (let i = 0; i < locs.length; i += 10) {
    app.db.insert('users', { id: id(), email: `kunde${i / 10 + 1}@example.test`, name: `Kunde ${i / 10 + 1}`, password_hash: passwordHash, role: 'member', locations: locs.slice(i, i + 10).map((l) => l.id), created_at: iso(nowMs) });
  }
  // Skewed sizes: the first sub-accounts are much bigger than the last (weight 1/sqrt(rank)).
  const weights = locs.map((_, i) => 1 / Math.sqrt(i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const cum = weights.map((_, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / total);
  const pickLoc = () => {
    const r = rnd();
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return locs[lo];
  };

  const batch = (table: string, cols: string[], rows: number, row: (i: number) => unknown[]) => {
    const st = raw.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    raw.exec('BEGIN');
    try {
      for (let i = 0; i < rows; i++) st.run(...(row(i) as any[]));
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
    log(`  ${rows.toLocaleString('en-US')} ${table}`);
  };

  // Contacts
  const allContacts: { loc: string; id: string }[] = [];
  batch(
    'contacts',
    ['id', 'location_id', 'first_name', 'last_name', 'email', 'phone', 'company', 'city', 'country', 'source', 'tags', 'last_activity_at', 'created_at', 'updated_at'],
    want.contacts,
    (i) => {
      const l = pickLoc();
      const cid = id();
      l.contacts.push(cid);
      allContacts.push({ loc: l.id, id: cid });
      const first = pick(FIRST);
      const last = pick(LAST);
      const created = nowMs - rnd() * 2 * YEAR;
      const tags = rnd() < 0.6 ? [pick(TAGS), ...(rnd() < 0.3 ? [pick(TAGS)] : [])] : [];
      return [cid, l.id, first, last, `${first}.${last}.${i}@example.test`.toLowerCase(), `+4915${String(10_000_000 + Math.floor(rnd() * 89_999_999))}`, rnd() < 0.5 ? pick(COMPANIES) : '', pick(CITIES), 'DE', pick(SOURCES), JSON.stringify([...new Set(tags)]), iso(created + rnd() * (nowMs - created)), iso(created), iso(created)];
    },
  );

  // Deals (status: 70 % open, 20 % won, 10 % lost)
  batch(
    'opportunities',
    ['id', 'location_id', 'pipeline_id', 'stage_id', 'contact_id', 'name', 'value', 'status', 'source', 'created_at', 'updated_at', 'stage_changed_at', 'closed_at'],
    want.deals,
    (i) => {
      let l = pickLoc();
      while (!l.contacts.length) l = pickLoc();
      const r = rnd();
      const status = r < 0.7 ? 'open' : r < 0.9 ? 'won' : 'lost';
      const created = nowMs - rnd() * YEAR;
      const upd = iso(created + rnd() * (nowMs - created));
      return [id(), l.id, l.pipeline, status === 'won' ? l.stages[l.stages.length - 1] : pick(l.stages), pick(l.contacts), `Projekt ${i + 1} ${pick(COMPANIES)}`, Math.round(rnd() * 20_000) * 100, status, pick(SOURCES), iso(created), upd, upd, status === 'open' ? null : upd];
    },
  );

  // Conversations: about 40 % of the contacts have one (UNIQUE per contact); the messages are spread over them.
  const withConv = allContacts.filter(() => rnd() < 0.4);
  const convRows = withConv.map((c) => ({ id: id(), loc: c.loc, contact: c.id, at: nowMs - rnd() * 90 * 864e5 }));
  batch('conversations', ['id', 'location_id', 'contact_id', 'unread', 'starred', 'last_message', 'last_message_at', 'created_at'], convRows.length, (i) => {
    const c = convRows[i];
    return [c.id, c.loc, c.contact, rnd() < 0.15 ? 1 + Math.floor(rnd() * 3) : 0, rnd() < 0.03 ? 1 : 0, `${pick(WORDS)} ${pick(WORDS)}`, iso(c.at), iso(c.at - 864e5)];
  });

  // Messages
  batch('messages', ['id', 'location_id', 'conversation_id', 'contact_id', 'channel', 'direction', 'subject', 'body', 'status', 'created_at'], want.messages, (i) => {
    const c = convRows[i % convRows.length];
    const out = rnd() < 0.5;
    const channel = rnd() < 0.7 ? 'email' : 'sms';
    const body = Array.from({ length: 6 + Math.floor(rnd() * 20) }, () => pick(WORDS)).join(' ');
    return [id(), c.loc, c.id, c.contact, channel, out ? 'out' : 'in', channel === 'email' ? `${pick(WORDS)} ${pick(WORDS)}` : '', body, out ? 'sent' : 'received', iso(c.at - rnd() * 30 * 864e5)];
  });

  // Tasks (40 % done)
  batch('tasks', ['id', 'location_id', 'contact_id', 'title', 'description', 'due_at', 'done', 'created_at', 'completed_at'], want.tasks, () => {
    let l = pickLoc();
    while (!l.contacts.length) l = pickLoc();
    const created = nowMs - rnd() * YEAR;
    const done = rnd() < 0.4;
    return [id(), l.id, rnd() < 0.8 ? pick(l.contacts) : null, `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`, '', iso(created + (rnd() - 0.3) * 60 * 864e5), done ? 1 : 0, iso(created), done ? iso(created + rnd() * 20 * 864e5) : null];
  });

  // Invoices
  batch(
    'invoices',
    ['id', 'location_id', 'kind', 'number', 'contact_id', 'title', 'items', 'subtotal_cents', 'tax_cents', 'total_cents', 'status', 'public_token', 'issued_at', 'due_at', 'paid_at', 'created_at', 'updated_at'],
    want.invoices,
    () => {
      let l = pickLoc();
      while (!l.contacts.length) l = pickLoc();
      const issued = nowMs - rnd() * YEAR;
      const net = Math.round(rnd() * 5000) * 100 + 5000;
      const tax = Math.round(net * 0.19);
      const status = pick(['draft', 'sent', 'sent', 'paid', 'paid', 'paid', 'overdue']);
      l.invoiceNo++;
      return [id(), l.id, 'invoice', `RE-${String(l.invoiceNo).padStart(5, '0')}`, pick(l.contacts), `Leistung ${pick(WORDS)}`, JSON.stringify([{ name: `Leistung ${pick(WORDS)}`, qty: 1, price_cents: net, tax_rate: 19 }]), net, tax, net + tax, status, id(24), iso(issued), iso(issued + 14 * 864e5), status === 'paid' ? iso(issued + 9 * 864e5) : null, iso(issued), iso(issued)];
    },
  );

  // Activities (the contact timeline)
  batch('activities', ['id', 'location_id', 'contact_id', 'type', 'summary', 'created_at'], want.activities, () => {
    let l = pickLoc();
    while (!l.contacts.length) l = pickLoc();
    return [id(), l.id, pick(l.contacts), pick(['note', 'email', 'sms', 'call', 'stage']), `${pick(WORDS)} ${pick(WORDS)}`, iso(nowMs - rnd() * YEAR)];
  });

  raw.exec('ANALYZE');
  const big = locs.reduce((a, b) => (b.contacts.length > a.contacts.length ? b : a));
  return { email: PERF_EMAIL, password: PERF_PASSWORD, counts: want, seconds: Math.round((Date.now() - t0) / 100) / 10, bigLocation: big.id };
}

// ---- CLI -------------------------------------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\.ts$/, '') === resolve(new URL(import.meta.url).pathname).replace(/\.ts$/, '');
if (isMain) {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes('--help')) {
    console.log('Usage: npm run perf:seed -- [--data-dir <folder>] [--scale <0.01-1>]');
    process.exit(0);
  }
  const dir = resolve(value('data-dir') ?? './perf-data');
  if (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith('pghl.db'))) {
    console.error(`${dir} already holds a database – use an empty folder (or delete it).`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const scale = Math.min(1, Math.max(0.001, Number(value('scale') ?? 1) || 1));
  const instance = createApp({ ...loadConfig({ ...process.env, PGHL_DATA_DIR: dir, PGHL_DEMO_MODE: '0' }), tickMs: 0, demoMode: false }, MODULES);
  try {
    console.log(`Seeding ${dir} (scale ${scale}) …`);
    const r = await seedPerfData(instance.app, scale, console.log);
    console.log(`Done in ${r.seconds} s. Login: ${r.email} / ${r.password}`);
    console.log(`Start:  PGHL_DATA_DIR=${dir} npm start      then: npm run perf:bench -- --url http://127.0.0.1:4700`);
  } finally {
    await instance.close();
  }
}
