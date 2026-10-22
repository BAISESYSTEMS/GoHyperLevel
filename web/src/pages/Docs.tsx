import { useState } from 'react';
import { ago, api } from '../api';
import { Icon, type IconName } from '../icons';
import { StatusDot, useOpenProject, useProjects } from '../nav';
import { can, useSession } from '../session';
import { Empty, Input, Select, Spinner, act, confirmAsk, useLoad } from '../ui';

/** Reports, Claude artifacts and documents: per project and agency-wide with an inbox. */

const KIND: Record<string, [IconName, string]> = {
  artifact: ['artifact', 'Artefakt'],
  report: ['doc', 'Bericht'],
  doc: ['doc', 'Dokument'],
  session: ['claude', 'Claude-Sitzung'],
  link: ['link', 'Link'],
};

/** Kind of a link pasted by hand: Claude artifacts, ChatGPT canvases and Codex tasks are recognised. */
export function kindOfUrl(url: string): string {
  if (/claude\.ai\/artifact/.test(url) || /chatgpt\.com\/canvas/.test(url)) return 'artifact';
  if (/chatgpt\.com\/codex/.test(url)) return 'session';
  return 'link';
}

function DocRow({ d, actions }: { d: any; actions?: React.ReactNode }) {
  const [kindIcon, kindLabel] = KIND[d.kind] ?? KIND.link;
  // Codex tasks are sessions too, with their own icon.
  const codex = d.source === 'Codex' || /chatgpt\.com\/codex/.test(d.url);
  const icon: IconName = codex ? 'codex' : kindIcon;
  const label = codex && d.kind === 'session' ? 'Codex-Aufgabe' : kindLabel;
  return (
    <div className="doc-row">
      <Icon name={icon} size={17} />
      <div className="grow">
        <a href={d.url} target="_blank" rel="noreferrer">
          {d.pinned ? <Icon name="pin" size={12} /> : null} {d.title}
        </a>
        <div className="muted small">
          {label}
          {d.source ? ` · ${d.source}` : ''} · {ago(d.updated_at)}
          {d.session_url && (
            <>
              {' · '}
              <a href={d.session_url} target="_blank" rel="noreferrer">
                Sitzung öffnen
              </a>
            </>
          )}
        </div>
      </div>
      {actions}
    </div>
  );
}

/** Card on the project page. */
export function ProjectDocs() {
  const session = useSession();
  const docs = useLoad(() => api.get<any[]>('/api/docs'), [session.locationId]);
  const [add, setAdd] = useState({ title: '', url: '' });
  const edit = can(session, 'settings');
  return (
    <div className="card" data-tour="project-docs">
      <h2>Berichte & Artefakte</h2>
      {!docs.data ? (
        <Spinner />
      ) : docs.data.length ? (
        <div className="doc-list">
          {docs.data.map((d) => (
            <DocRow
              key={d.id}
              d={d}
              actions={
                edit && (
                  <span className="doc-actions">
                    <button className="icon-btn" title={d.pinned ? 'Nicht mehr anheften' : 'Anheften'} onClick={async () => (await act(() => api.patch(`/api/docs/${d.id}`, { pinned: !d.pinned }))) && docs.reload()}>
                      <Icon name="pin" size={14} />
                    </button>
                    <button className="icon-btn" title="Entfernen" onClick={async () => confirmAsk(`„${d.title}“ aus dem Projekt entfernen?`) && (await act(() => api.del(`/api/docs/${d.id}`))) && docs.reload()}>
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                )
              }
            />
          ))}
        </div>
      ) : (
        <p className="muted small">Noch nichts abgelegt. Claude-Artefakte, ChatGPT-Canvas und Codex-Aufgaben zu diesem Projekt erscheinen hier automatisch.</p>
      )}
      {edit && (
        <div className="list-row" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.3fr) auto', marginTop: 10 }}>
          <Input value={add.title} onChange={(title) => setAdd({ ...add, title })} placeholder="Titel" />
          <Input value={add.url} onChange={(url) => setAdd({ ...add, url })} placeholder="Link (claude.ai, chatgpt.com …)" />
          <button className="btn small secondary" disabled={!add.url} onClick={async () => (await act(() => api.post('/api/docs', { ...add, kind: kindOfUrl(add.url) }), 'Abgelegt')) && (setAdd({ title: '', url: '' }), docs.reload())}>
            + Ablegen
          </button>
        </div>
      )}
    </div>
  );
}

/** Agency tab: all documents, the inbox first. */
export function AgencyDocs() {
  const projects = useProjects();
  const open = useOpenProject();
  const [q, setQ] = useState('');
  const [loc, setLoc] = useState('');
  const docs = useLoad(() => api.get<any[]>('/api/agency/docs'), []);
  if (!docs.data) return <Spinner />;
  const options = projects.filter((p) => p.status !== 'archiviert').map((p) => [p.id, p.name] as [string, string]);
  const match = (d: any) => (!q || `${d.title} ${d.summary} ${d.project ?? ''}`.toLowerCase().includes(q.toLowerCase())) && (!loc || d.location_id === loc);
  const inbox = docs.data.filter((d) => !d.location_id && match(d));
  const filed = docs.data.filter((d) => d.location_id && match(d));
  const groups = new Map<string, any[]>();
  for (const d of filed) groups.set(d.location_id, [...(groups.get(d.location_id) ?? []), d]);
  const status = Object.fromEntries(projects.map((p) => [p.id, p.status]));
  const assign = async (d: any, location_id: string) => (await act(() => api.patch(`/api/agency/docs/${d.id}`, { location_id }), location_id ? 'Zugeordnet' : 'In den Eingang gelegt')) && docs.reload();
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow" style={{ maxWidth: 420 }}>
          <Input value={q} onChange={setQ} placeholder="Titel, Projekt…" />
        </div>
        <div style={{ width: 260 }}>
          <Select value={loc} onChange={setLoc} placeholder="Alle Projekte" options={options} />
        </div>
      </div>
      {inbox.length > 0 && !loc && (
        <div className="card">
          <h2>
            <Icon name="inbox" size={18} /> Eingang <span className="muted small">· {inbox.length} ohne Projekt</span>
          </h2>
          <div className="doc-list">
            {inbox.map((d) => (
              <DocRow
                key={d.id}
                d={d}
                actions={
                  <div style={{ width: 220 }}>
                    <Select value="" onChange={(v) => v && assign(d, v)} placeholder="Projekt zuordnen…" options={options} />
                  </div>
                }
              />
            ))}
          </div>
        </div>
      )}
      {[...groups.entries()].map(([locId, list]) => (
        <div key={locId} className="card">
          <h3 className="linkish" style={{ marginBottom: 8 }} onClick={() => open(locId, 'project')}>
            <StatusDot status={status[locId] ?? ''} />
            {list[0].project} <span className="muted small">· {list.length}</span>
          </h3>
          <div className="doc-list">
            {list.map((d) => (
              <DocRow
                key={d.id}
                d={d}
                actions={
                  <button className="icon-btn" title="Zurück in den Eingang" onClick={() => assign(d, '')}>
                    <Icon name="inbox" size={14} />
                  </button>
                }
              />
            ))}
          </div>
        </div>
      ))}
      {!inbox.length && !groups.size && <Empty>Keine Dokumente gefunden.</Empty>}
    </>
  );
}
