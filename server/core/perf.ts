import { monitorEventLoopDelay, performance, type EventLoopUtilization, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Runtime health for self-hosters: event-loop lag (perf_hooks), slow requests and slow SQL queries.
 * Kept in memory (ring buffers, per-route counters), shown on Agentur → System and GET /api/admin/metrics.
 *
 * - PGHL_SLOW_REQUEST_MS (default 300): requests slower than this are logged with their route pattern.
 * - PGHL_SLOW_QUERY_MS (default off, e.g. 50): times every query (core/db.ts) and logs the slow ones as a
 *   fingerprint – literals and parameters are never logged.
 */

export interface SlowRequest {
  at: string;
  method: string;
  route: string;
  status: number;
  ms: number;
}
export interface SlowQuery {
  at: string;
  sql: string;
  ms: number;
}
interface RouteStat {
  count: number;
  totalMs: number;
  maxMs: number;
  slow: number;
}

const RING = 100;
const round = (n: number) => Math.round(n * 10) / 10;
const nsToMs = (n: number) => (Number.isFinite(n) ? round(n / 1e6) : 0);
/** The histogram samples a timer every RESOLUTION ms; what it reports is that interval – the lag is what exceeds it. */
const RESOLUTION_MS = 20;
const lagMs = (n: number) => Math.max(0, round(nsToMs(n) - RESOLUTION_MS));

/** Normalised SQL for logs: string/number literals → ?, whitespace collapsed, long IN-lists folded. */
export function sqlFingerprint(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?, …)')
    .trim()
    .slice(0, 400);
}

const envMs = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export class PerfMonitor {
  readonly startedAt = Date.now();
  slowRequestMs = envMs(process.env.PGHL_SLOW_REQUEST_MS, 300);
  slowQueryMs = envMs(process.env.PGHL_SLOW_QUERY_MS, 0);
  /** Silence the console lines (tests). */
  quiet = !!process.env.VITEST || process.env.NODE_ENV === 'test';
  requests = 0;
  slowRequests: SlowRequest[] = [];
  slowQueries: SlowQuery[] = [];
  private routes = new Map<string, RouteStat>();
  private queryStats = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  private jobs = new Map<string, { runs: number; totalMs: number; maxMs: number; lastMs: number }>();
  private histogram: IntervalHistogram | undefined;
  private elu: EventLoopUtilization | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastWindow: ReturnType<PerfMonitor['loopSnapshot']> | null = null;

  /** Starts the event-loop monitor (20 ms resolution) with one-minute windows. */
  start() {
    if (this.histogram) return;
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.histogram.enable();
    this.elu = performance.eventLoopUtilization();
    this.timer = setInterval(() => {
      const snap = this.loopSnapshot();
      this.lastWindow = snap;
      if (!this.quiet && snap.p99_ms > 200) console.warn(`[perf] event loop lag p99 ${snap.p99_ms} ms, max ${snap.max_ms} ms in the last minute`);
      this.histogram!.reset();
      this.elu = performance.eventLoopUtilization();
    }, 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.histogram?.disable();
    this.histogram = undefined;
  }

  private loopSnapshot() {
    const h = this.histogram;
    const elu = this.elu ? performance.eventLoopUtilization(this.elu) : undefined;
    return {
      p50_ms: h ? lagMs(h.percentile(50)) : 0,
      p99_ms: h ? lagMs(h.percentile(99)) : 0,
      max_ms: h ? lagMs(h.max) : 0,
      mean_ms: h ? lagMs(h.mean) : 0,
      utilization: elu ? round(elu.utilization * 100) / 100 : 0,
    };
  }

  /** One finished request (route pattern, never the raw path with ids or the query string). */
  request(method: string, route: string, status: number, ms: number) {
    this.requests++;
    const key = `${method} ${route}`;
    let s = this.routes.get(key);
    if (!s) {
      if (this.routes.size > 3000) this.routes.clear();
      this.routes.set(key, (s = { count: 0, totalMs: 0, maxMs: 0, slow: 0 }));
    }
    s.count++;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
    if (this.slowRequestMs > 0 && ms > this.slowRequestMs) {
      s.slow++;
      push(this.slowRequests, { at: new Date().toISOString(), method, route, status, ms: round(ms) });
      if (!this.quiet) console.warn(`[slow] ${Math.round(ms)} ms ${method} ${route} → ${status}`);
    }
  }

  /** One run of a background job (app.onTick): wall time including waits, per registering module. */
  job(name: string, ms: number) {
    let j = this.jobs.get(name);
    if (!j) this.jobs.set(name, (j = { runs: 0, totalMs: 0, maxMs: 0, lastMs: 0 }));
    j.runs++;
    j.totalMs += ms;
    j.lastMs = ms;
    if (ms > j.maxMs) j.maxMs = ms;
  }

  /** Called by core/db.ts for queries over slowQueryMs. */
  query(sql: string, ms: number) {
    const fp = sqlFingerprint(sql);
    push(this.slowQueries, { at: new Date().toISOString(), sql: fp, ms: round(ms) });
    let s = this.queryStats.get(fp);
    if (!s) {
      if (this.queryStats.size > 1000) this.queryStats.clear();
      this.queryStats.set(fp, (s = { count: 0, totalMs: 0, maxMs: 0 }));
    }
    s.count++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    if (!this.quiet) console.warn(`[slow-sql] ${Math.round(ms)} ms ${fp}`);
  }

  snapshot() {
    const top = [...this.routes.entries()]
      .map(([route, s]) => ({ route, count: s.count, avg_ms: round(s.totalMs / s.count), max_ms: round(s.maxMs), slow: s.slow }))
      .sort((a, b) => b.avg_ms * Math.log2(b.count + 1) - a.avg_ms * Math.log2(a.count + 1))
      .slice(0, 15);
    const queries = [...this.queryStats.entries()]
      .map(([sql, s]) => ({ sql, count: s.count, avg_ms: round(s.totalMs / s.count), max_ms: round(s.maxMs) }))
      .sort((a, b) => b.avg_ms * b.count - a.avg_ms * a.count)
      .slice(0, 15);
    const jobs = [...this.jobs.entries()]
      .map(([name, j]) => ({ name, runs: j.runs, avg_ms: round(j.totalMs / j.runs), max_ms: round(j.maxMs), last_ms: round(j.lastMs) }))
      .sort((a, b) => b.max_ms - a.max_ms)
      .slice(0, 15);
    const mem = process.memoryUsage();
    return {
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      node: process.version,
      memory_mb: { rss: mb(mem.rss), heap_used: mb(mem.heapUsed), heap_total: mb(mem.heapTotal), external: mb(mem.external) },
      event_loop: { current: this.loopSnapshot(), last_minute: this.lastWindow, monitoring: !!this.histogram },
      requests: { total: this.requests, slow_ms: this.slowRequestMs, top_routes: top, slow: [...this.slowRequests].reverse().slice(0, 50) },
      jobs,
      queries: { slow_ms: this.slowQueryMs, enabled: this.slowQueryMs > 0, top: queries, slow: [...this.slowQueries].reverse().slice(0, 50) },
    };
  }
}

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

function push<T>(ring: T[], item: T) {
  ring.push(item);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
}

/**
 * Runs `work(item)` over a list in slices of at most `budgetMs`, yielding to the event loop between
 * slices (setImmediate) – background jobs must never hold up requests for long.
 */
export async function inSlices<T>(items: Iterable<T>, work: (item: T) => void | Promise<void>, budgetMs = 25): Promise<void> {
  let sliceStart = performance.now();
  for (const item of items) {
    await work(item);
    if (performance.now() - sliceStart > budgetMs) {
      await new Promise<void>((r) => setImmediate(r));
      sliceStart = performance.now();
    }
  }
}

/** Yields to the event loop when the current slice has run longer than `budgetMs` (call inside loops). */
export function sliceTimer(budgetMs = 25) {
  let start = performance.now();
  return async () => {
    if (performance.now() - start < budgetMs) return;
    await new Promise<void>((r) => setImmediate(r));
    start = performance.now();
  };
}
