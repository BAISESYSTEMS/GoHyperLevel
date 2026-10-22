import { useEffect } from 'react';
import { api, dt } from '../api';
import { Badge, Empty, Spinner, useLoad } from '../ui';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Agentur → System: how the server is doing (event-loop lag, slow requests and queries, background jobs,
 * SQLite settings, data volume). GET /api/admin/metrics; refreshes every 15 s. Sizing tips: docs/performance.md.
 */

interface Metrics {
  uptime_s: number;
  node: string;
  memory_mb: { rss: number; heap_used: number; heap_total: number; external: number };
  event_loop: { current: Loop; last_minute: Loop | null; monitoring: boolean };
  requests: { total: number; slow_ms: number; top_routes: { route: string; count: number; avg_ms: number; max_ms: number; slow: number }[]; slow: { at: string; method: string; route: string; status: number; ms: number }[] };
  jobs: { name: string; runs: number; avg_ms: number; max_ms: number; last_ms: number }[];
  queries: { slow_ms: number; enabled: boolean; top: { sql: string; count: number; avg_ms: number; max_ms: number }[]; slow: { at: string; sql: string; ms: number }[] };
  database: { file_mb: number; wal_mb: number; pragmas: Record<string, unknown>; rows: Record<string, number> };
}
interface Loop {
  p50_ms: number;
  p99_ms: number;
  max_ms: number;
  mean_ms: number;
  utilization: number;
}

const LABELS: Record<string, string> = {
  locations: 'Sub-Accounts',
  contacts: 'Kontakte',
  opportunities: 'Deals',
  messages: 'Nachrichten',
  tasks: 'Aufgaben',
  invoices: 'Rechnungen',
  workflow_runs: 'Automations-Läufe',
};

const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} T ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.max(1, Math.floor(s / 60))} min`);
const n = (v: number) => v.toLocaleString('de-DE');
const tone = (ms: number, warn: number, bad: number) => (ms >= bad ? 'red' : ms >= warn ? 'yellow' : 'green');

function Stat({ label, value, sub, badge }: { label: string; value: string; sub?: string; badge?: 'green' | 'yellow' | 'red' }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>
        {value} {badge && <Badge tone={badge}>{badge === 'green' ? 'gut' : badge === 'yellow' ? 'hoch' : 'kritisch'}</Badge>}
      </div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

export function SystemHealth() {
  const m = useLoad(() => api.get<Metrics>('/api/admin/metrics'));
  useEffect(() => {
    const t = setInterval(() => void m.reload(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (m.error && !m.data) return <Empty>{m.error}</Empty>;
  if (!m.data) return <Spinner />;
  const d = m.data;
  const loop = d.event_loop.last_minute ?? d.event_loop.current;
  const p = d.database.pragmas;
  return (
    <div data-tour="system-health">
      <p className="muted" style={{ marginTop: 0 }}>
        Wie gut der Server gerade läuft. Langsame Anfragen (über {d.requests.slow_ms} ms) werden gezählt – nur mit der Route, nie mit Inhalten.
      </p>
      <SortableGrid id="system-stats" className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginBottom: 18 }} data-tour="system-stats">
        <Stat label="Event-Loop-Verzögerung p99" value={`${loop.p99_ms} ms`} sub={`Maximal ${loop.max_ms} ms · Auslastung ${Math.round(loop.utilization * 100)} %`} badge={tone(loop.p99_ms, 50, 200)} />
        <Stat label="Speicher (RSS)" value={`${d.memory_mb.rss} MB`} sub={`Heap ${d.memory_mb.heap_used} / ${d.memory_mb.heap_total} MB`} />
        <Stat label="Datenbank" value={`${d.database.file_mb} MB`} sub={`WAL ${d.database.wal_mb} MB`} />
        <Stat label="Anfragen seit Start" value={n(d.requests.total)} sub={`Laufzeit ${uptime(d.uptime_s)} · Node ${d.node}`} />
      </SortableGrid>

      <h3>Datenmenge</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 18 }} data-tour="system-rows">
        {Object.entries(d.database.rows).map(([k, v]) => (
          <Badge key={k}>
            {LABELS[k] ?? k}: {n(v)}
          </Badge>
        ))}
      </div>

      <h3>Langsamste Routen</h3>
      {!d.requests.top_routes.length ? (
        <Empty>Noch keine Anfragen.</Empty>
      ) : (
        <div className="table-wrap" data-tour="system-routes">
          <table className="t">
            <thead>
              <tr>
                <th>Route</th>
                <th>Anfragen</th>
                <th>Ø ms</th>
                <th>Max ms</th>
                <th>Langsam</th>
              </tr>
            </thead>
            <tbody>
              {d.requests.top_routes.map((r) => (
                <tr key={r.route}>
                  <td>
                    <code>{r.route}</code>
                  </td>
                  <td>{n(r.count)}</td>
                  <td>
                    <Badge tone={tone(r.avg_ms, 100, 300)}>{r.avg_ms}</Badge>
                  </td>
                  <td>{r.max_ms}</td>
                  <td>{r.slow || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!!d.requests.slow.length && (
        <>
          <h3>Letzte langsame Anfragen</h3>
          <div className="table-wrap">
            <table className="t">
              <tbody>
                {d.requests.slow.slice(0, 15).map((r, i) => (
                  <tr key={i}>
                    <td className="muted">{dt(r.at)}</td>
                    <td>
                      <code>
                        {r.method} {r.route}
                      </code>
                    </td>
                    <td>{r.status}</td>
                    <td>
                      <Badge tone="red">{r.ms} ms</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Hintergrund-Jobs</h3>
      {!d.jobs.length ? (
        <Empty>Der Scheduler hat noch nicht gelaufen.</Empty>
      ) : (
        <div className="table-wrap" data-tour="system-jobs">
          <table className="t">
            <thead>
              <tr>
                <th>Modul</th>
                <th>Läufe</th>
                <th>Ø ms</th>
                <th>Max ms</th>
                <th>Zuletzt ms</th>
              </tr>
            </thead>
            <tbody>
              {d.jobs.map((j) => (
                <tr key={j.name}>
                  <td>
                    <code>{j.name}</code>
                  </td>
                  <td>{n(j.runs)}</td>
                  <td>{j.avg_ms}</td>
                  <td>
                    <Badge tone={tone(j.max_ms, 500, 2000)}>{j.max_ms}</Badge>
                  </td>
                  <td>{j.last_ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Datenbank-Abfragen</h3>
      {!d.queries.enabled ? (
        <p className="muted small">
          Die Abfrage-Messung ist aus. Mit <code>PGHL_SLOW_QUERY_MS=50</code> in der Umgebung werden Abfragen über 50 ms protokolliert (als Muster, ohne Werte).
        </p>
      ) : !d.queries.top.length ? (
        <Empty>Keine langsamen Abfragen (über {d.queries.slow_ms} ms).</Empty>
      ) : (
        <div className="table-wrap" data-tour="system-queries">
          <table className="t">
            <thead>
              <tr>
                <th>Abfrage</th>
                <th>Anzahl</th>
                <th>Ø ms</th>
                <th>Max ms</th>
              </tr>
            </thead>
            <tbody>
              {d.queries.top.map((q) => (
                <tr key={q.sql}>
                  <td className="small">
                    <code>{q.sql}</code>
                  </td>
                  <td>{n(q.count)}</td>
                  <td>{q.avg_ms}</td>
                  <td>{q.max_ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>SQLite</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {Object.entries(p)
          .filter(([k]) => ['journal_mode', 'synchronous', 'cache_size', 'temp_store', 'mmap_size'].includes(k))
          .map(([k, v]) => `${k} = ${String(v)}`)
          .join(' · ')}
      </p>
    </div>
  );
}
