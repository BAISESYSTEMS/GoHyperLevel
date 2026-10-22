#!/usr/bin/env node
/**
 * HTTP load test for a running HyperLevel server (docs/performance.md). Plain node:http with keep-alive,
 * no dependencies. Logs in as the perf admin (see scripts/perf-seed.ts), picks the biggest sub-account
 * and hammers about 20 key endpoints at concurrency 1 / 10 / 50, reporting req/s and p50 / p95 / p99.
 *
 *   npm run perf:seed -- --data-dir ./perf-data
 *   PGHL_DATA_DIR=./perf-data npm start            # in another terminal
 *   npm run perf:bench -- --url http://127.0.0.1:4700
 *
 * Options:
 *   --url <base>            server address (default http://127.0.0.1:4700)
 *   --email, --password     login (default perf@example.test / perf-pass-123)
 *   --concurrency 1,10,50   levels to run
 *   --seconds 4             measuring time per endpoint and level (after a short warm-up)
 *   --only a,b              only endpoints whose name contains one of these words
 *   --json <file>           also write the results as JSON
 *   --no-compress           send no Accept-Encoding (default: br, gzip like a browser; bodies are not decoded)
 *   --budget-ms 200         exit code 1 when a p95 at concurrency 10 is above this (default: report only)
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (flag('help')) {
  console.log(readUsage());
  process.exit(0);
}
function readUsage() {
  return 'Usage: npm run perf:bench -- [--url http://127.0.0.1:4700] [--concurrency 1,10,50] [--seconds 4] [--only word,word] [--json out.json] [--budget-ms 200] [--no-compress]';
}

const BASE = new URL(opt('url', 'http://127.0.0.1:4700'));
const LEVELS = String(opt('concurrency', '1,10,50')).split(',').map(Number).filter((n) => n > 0);
const SECONDS = Number(opt('seconds', 4));
const ONLY = String(opt('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const BUDGET = opt('budget-ms') ? Number(opt('budget-ms')) : 0;
const ENCODING = flag('no-compress') ? undefined : 'br, gzip';

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

/** One request; resolves with status, bytes and elapsed ms. The body is read and dropped (not decoded). */
function hit(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const req = http.request(
      { agent, host: BASE.hostname, port: BASE.port, path, method, headers: { ...(ENCODING ? { 'accept-encoding': ENCODING } : {}), ...headers } },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (chunks.length < 64) chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes, ms: performance.now() - t, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function json(method, path, headers = {}, payload) {
  const r = await hit(method, path, { 'accept-encoding': 'identity', ...(payload ? { 'content-type': 'application/json', 'x-pghl': '1' } : {}), ...headers }, payload ? JSON.stringify(payload) : undefined);
  return { ...r, data: r.body.length ? JSON.parse(r.body.toString('utf8') || 'null') : null, text: r.body.toString('utf8') };
}

async function fetchJson(path, headers) {
  const res = await new Promise((resolve, reject) => {
    http
      .get({ agent, host: BASE.hostname, port: BASE.port, path, headers: { 'accept-encoding': 'identity', ...headers } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      })
      .on('error', reject);
  });
  if (res.status !== 200) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

/** `workers` loops hammer one endpoint for `seconds`; the first 15 % of requests are warm-up (not counted). */
async function run(ep, workers, seconds) {
  const lat = [];
  let errors = 0;
  let bytes = 0;
  const end = performance.now() + seconds * 1000;
  const warmUntil = performance.now() + seconds * 150;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (performance.now() < end) {
        try {
          const r = await hit('GET', ep.path, ep.headers);
          if (performance.now() < warmUntil) continue;
          if (r.status >= 400) errors++;
          else {
            lat.push(r.ms);
            bytes += r.bytes;
          }
        } catch {
          errors++;
        }
      }
    }),
  );
  const secs = (performance.now() - t0 - seconds * 150) / 1000;
  lat.sort((a, b) => a - b);
  return { endpoint: ep.name, concurrency: workers, requests: lat.length, errors, rps: Math.round(lat.length / Math.max(secs, 0.001)), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1] ?? 0, kb: lat.length ? Math.round(bytes / lat.length / 102.4) / 10 : 0 };
}

async function main() {
  // Login
  const login = await json('POST', '/api/auth/login', {}, { email: opt('email', 'perf@example.test'), password: opt('password', 'perf-pass-123') });
  if (login.status !== 200) throw new Error(`login failed (${login.status}): ${login.text.slice(0, 200)}`);
  const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
  if (!cookie) throw new Error('login gave no session cookie');
  const auth = { cookie, 'x-pghl': '1' };

  // The biggest sub-account, and ids to read in detail.
  const overview = await fetchJson('/api/agency/overview', auth);
  const big = [...overview].sort((a, b) => b.contacts - a.contacts)[0];
  const loc = { ...auth, 'x-location-id': big.id };
  const [conversations, pipelines] = await Promise.all([fetchJson('/api/conversations?limit=5', loc), fetchJson('/api/pipelines', loc)]);
  const conv = conversations[0]?.id;
  const pipe = pipelines[0]?.id;
  // A report dashboard to read (the sales template is created once, when the sub-account has none).
  let dash = (await fetchJson('/api/reports/dashboards', loc)).dashboards?.[0];
  if (!dash) dash = (await json('POST', '/api/reports/templates/sales', loc, {})).data;
  console.log(`Server ${BASE.origin} – ${overview.length} sub-accounts, biggest: ${big.name} (${big.contacts} contacts)`);

  const endpoints = [
    { name: 'me', path: '/api/me', headers: auth },
    { name: 'dashboard', path: '/api/dashboard', headers: loc },
    { name: 'contacts list', path: '/api/contacts?limit=50', headers: loc },
    { name: 'contacts search', path: '/api/contacts?q=anna&limit=50', headers: loc },
    { name: 'contacts by tag', path: '/api/contacts?tag=kunde&limit=50', headers: loc },
    { name: 'conversations', path: '/api/conversations', headers: loc },
    { name: 'conversation messages', path: `/api/conversations/${conv}/messages`, headers: loc },
    { name: 'pipelines', path: '/api/pipelines', headers: loc },
    { name: 'opportunities (board)', path: `/api/opportunities?pipeline_id=${pipe}`, headers: loc },
    { name: 'tasks', path: '/api/tasks', headers: loc },
    { name: 'invoices', path: '/api/invoices', headers: loc },
    { name: 'global search', path: '/api/search?q=anna', headers: loc },
    { name: 'project', path: '/api/project', headers: loc },
    { name: 'agency projects', path: '/api/agency/projects', headers: auth },
    { name: 'agency overview', path: '/api/agency/overview', headers: auth },
    { name: 'agency contacts', path: '/api/agency/contacts', headers: auth },
    { name: 'agency deals', path: '/api/agency/opportunities', headers: auth },
    { name: 'agency tasks', path: '/api/agency/tasks', headers: auth },
    { name: 'mobile summary', path: '/api/mobile/summary', headers: auth },
    { name: 'mobile inbox', path: '/api/mobile/inbox', headers: auth },
    { name: 'mobile tasks', path: '/api/mobile/tasks', headers: auth },
    { name: 'mobile deals', path: '/api/mobile/deals', headers: auth },
    { name: 'mobile contacts', path: '/api/mobile/contacts', headers: auth },
    { name: 'mobile payments', path: '/api/mobile/payments', headers: auth },
    { name: 'mobile projects', path: '/api/mobile/projects', headers: auth },
    { name: 'report dashboards', path: '/api/reports/dashboards', headers: loc },
    { name: 'report dashboard data', path: `/api/reports/dashboards/${dash?.id}/data`, headers: loc },
    { name: 'contacts export.csv (async ok)', path: '/api/contacts/export.csv', headers: loc, export: true },
  ].filter((e) => !ONLY.length || ONLY.some((w) => e.name.includes(w)));

  // Every endpoint must answer before the clock starts.
  for (const ep of endpoints) {
    const r = await hit('GET', ep.path, ep.headers);
    if (r.status >= 400) console.warn(`  ! ${ep.name}: HTTP ${r.status} – ${r.body.toString('utf8').slice(0, 100)}`);
  }

  const results = [];
  console.log(`\n${'endpoint'.padEnd(32)} ${'c'.padStart(3)} ${'req/s'.padStart(7)} ${'p50 ms'.padStart(8)} ${'p95 ms'.padStart(8)} ${'p99 ms'.padStart(8)} ${'KB'.padStart(7)} ${'err'.padStart(4)}`);
  for (const ep of endpoints) {
    for (const c of LEVELS) {
      // Exports are heavy by nature: one level, a shorter run.
      if (ep.export && c > 10) continue;
      const r = await run(ep, c, ep.export ? Math.min(SECONDS, 3) : SECONDS);
      results.push(r);
      console.log(`${r.endpoint.padEnd(32)} ${String(c).padStart(3)} ${String(r.rps).padStart(7)} ${fmt(r.p50).padStart(8)} ${fmt(r.p95).padStart(8)} ${fmt(r.p99).padStart(8)} ${String(r.kb).padStart(7)} ${String(r.errors).padStart(4)}`);
    }
  }

  const metrics = await fetchJson('/api/admin/metrics', auth).catch(() => null);
  if (metrics) console.log(`\nEvent loop (last window): p99 ${metrics.event_loop.current.p99_ms} ms, max ${metrics.event_loop.current.max_ms} ms; RSS ${metrics.memory_mb.rss} MB; DB ${metrics.database.file_mb} MB`);

  const out = opt('json');
  if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), url: BASE.origin, location: { id: big.id, contacts: big.contacts }, results, metrics }, null, 2));

  if (BUDGET) {
    const over = results.filter((r) => r.concurrency === 10 && !endpoints.find((e) => e.name === r.endpoint)?.export && r.p95 > BUDGET);
    if (over.length) {
      console.error(`\nOver the ${BUDGET} ms p95 budget at c=10: ${over.map((r) => `${r.endpoint} (${fmt(r.p95)} ms)`).join(', ')}`);
      process.exitCode = 1;
    }
  }
  agent.destroy();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
