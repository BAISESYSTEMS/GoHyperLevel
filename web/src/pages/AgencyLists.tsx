import { useEffect, useState } from 'react';
import { ago, api, euro, name } from '../api';
import { StatusDot, useOpenProject, useProjects } from '../nav';
import { useSession } from '../session';
import { Empty, Input, navigate, pressable, Select, Spinner, Tabs, useLoad } from '../ui';

/** Agency-wide views: every contact and every deal of every project, one click into the project. */

function useDebounced(v: string, ms = 250) {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v]);
  return x;
}

export function AllContacts() {
  const projects = useProjects();
  const open = useOpenProject();
  const [q, setQ] = useState('');
  const [loc, setLoc] = useState('');
  const dq = useDebounced(q);
  const data = useLoad(() => api.get<any>(`/api/agency/contacts?q=${encodeURIComponent(dq)}&location_id=${loc}`), [dq, loc]);
  const status = Object.fromEntries(projects.map((p) => [p.id, p.status]));
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow" style={{ maxWidth: 420 }}>
          <Input value={q} onChange={setQ} placeholder="Name, E-Mail, Firma, Telefon…" />
        </div>
        <div style={{ width: 260 }}>
          <Select value={loc} onChange={setLoc} placeholder="Alle Projekte" options={projects.filter((p) => p.stats?.contacts).map((p) => [p.id, `${p.name} (${p.stats!.contacts})`])} />
        </div>
      </div>
      {!data.data ? (
        <Spinner />
      ) : data.data.contacts.length ? (
        <>
          <p className="muted small">{data.data.total} Kontakte{data.data.total > data.data.contacts.length ? `, die ${data.data.contacts.length} zuletzt aktiven` : ''}</p>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>E-Mail / Telefon</th>
                  <th>Projekt</th>
                  <th>Deals</th>
                  <th>Aktiv</th>
                </tr>
              </thead>
              <tbody>
                {data.data.contacts.map((c: any) => (
                  <tr key={c.id} className="click" {...pressable(() => open(c.location_id, `contacts/${c.id}`))}>
                    <td>
                      <strong>{name(c)}</strong>
                      {c.company && <div className="muted small">{c.company}</div>}
                    </td>
                    <td className="small">
                      {c.email}
                      {c.phone && <div className="muted">{c.phone}</div>}
                    </td>
                    <td className="small">
                      <StatusDot status={status[c.location_id] ?? ''} />
                      {c.project}
                    </td>
                    <td>{c.open_deals || <span className="muted">–</span>}</td>
                    <td className="muted small">{ago(c.last_activity_at ?? c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <Empty>Keine Kontakte gefunden.</Empty>
      )}
    </>
  );
}

export function AllDeals() {
  const projects = useProjects();
  const open = useOpenProject();
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const data = useLoad(() => api.get<any[]>(`/api/agency/opportunities?status=${status}&q=${encodeURIComponent(dq)}`), [status, dq]);
  const pStatus = Object.fromEntries(projects.map((p) => [p.id, p.status]));
  const groups = new Map<string, any[]>();
  for (const o of data.data ?? []) groups.set(o.location_id, [...(groups.get(o.location_id) ?? []), o]);
  return (
    <>
      <div className="row" style={{ marginBottom: 4, alignItems: 'center' }}>
        <Tabs
          tabs={[
            ['open', 'Offen'],
            ['won', 'Gewonnen'],
            ['lost', 'Verloren'],
            ['all', 'Alle'],
          ]}
          value={status}
          onChange={setStatus}
        />
        <div className="grow" style={{ maxWidth: 360 }}>
          <Input value={q} onChange={setQ} placeholder="Deal, E-Mail, Firma…" />
        </div>
      </div>
      {!data.data ? (
        <Spinner />
      ) : !data.data.length ? (
        <Empty>Keine Deals.</Empty>
      ) : (
        [...groups.entries()].map(([locId, list]) => {
          const stages = new Map<string, number>();
          for (const o of list) stages.set(`${o.pipeline} · ${o.stage}`, (stages.get(`${o.pipeline} · ${o.stage}`) ?? 0) + 1);
          return (
            <div key={locId} className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h3 className="linkish" onClick={() => open(locId, 'opportunities')}>
                  <StatusDot status={pStatus[locId] ?? ''} />
                  {list[0].project} <span className="muted small">· {list.length} Deals · {euro(list.reduce((s, o) => s + o.value, 0))}</span>
                </h3>
                <span className="muted small">{[...stages.entries()].map(([k, n]) => `${k}: ${n}`).join(' · ')}</span>
              </div>
              <div className="deal-list">
                {list.slice(0, 12).map((o) => (
                  <div key={o.id} className="deal-row" {...pressable(() => open(locId, `opportunities?pipeline=${o.pipeline_id}`))}>
                    <span className="grow">
                      {o.name}
                      <small className="muted"> {o.email || name(o)}</small>
                    </span>
                    <span className="badge">{o.stage}</span>
                    <span className="muted small">{ago(o.updated_at)}</span>
                  </div>
                ))}
                {list.length > 12 && (
                  <a href="#" className="small" onClick={(e) => (e.preventDefault(), open(locId, 'opportunities'))}>
                    + {list.length - 12} weitere in der Pipeline
                  </a>
                )}
              </div>
            </div>
          );
        })
      )}
    </>
  );
}

/** Shown in an empty project: where the data actually is, one click away. */
export function ElsewhereHint({ kind }: { kind: 'contacts' | 'opportunities' }) {
  const session = useSession();
  const projects = useProjects();
  const open = useOpenProject();
  if (session.user.role !== 'admin') return null;
  const key = kind === 'contacts' ? 'contacts' : 'open_opportunities';
  const others = projects.filter((p) => p.id !== session.locationId && (p.stats?.[key] ?? 0) > 0).sort((a, b) => b.stats![key] - a.stats![key]);
  if (!others.length) return null;
  const total = others.reduce((s, p) => s + p.stats![key], 0);
  return (
    <div className="card elsewhere">
      <strong>
        {kind === 'contacts' ? `${total} Kontakte` : `${total} offene Deals`} liegen in deinen anderen Projekten:
      </strong>
      <div className="chips">
        {others.map((p) => (
          <button key={p.id} className="chip" onClick={() => open(p.id, kind)}>
            <StatusDot status={p.status} />
            {p.name} <b>{p.stats![key]}</b>
          </button>
        ))}
      </div>
      <a href="#" className="small" onClick={(e) => (e.preventDefault(), navigate(kind === 'contacts' ? 'agency/contacts' : 'agency/deals'))}>
        {kind === 'contacts' ? 'Alle Kontakte' : 'Alle Deals'} auf einen Blick →
      </a>
    </div>
  );
}
