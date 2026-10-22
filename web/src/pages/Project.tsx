import { useEffect, useState } from 'react';
import { ago, api, euro } from '../api';
import { can, useSession } from '../session';
import { displayHost } from '../format';
import { act, Badge, Empty, Field, Input, PageHead, pressable, Select, Spinner, Stat, Textarea, useLoad } from '../ui';
import { ClaudeButton, CodexButton, refreshProjects } from '../nav';
import { ProjectDocs } from './Docs';
import { Slot } from '../slots';
import { SortableGrid } from '../sortable/Sortable';

export const STATUS: Record<string, [string, any]> = {
  idee: ['Idee', 'gray'],
  entwicklung: ['In Entwicklung', 'yellow'],
  beta: ['Beta', 'purple'],
  live: ['Live', 'green'],
  pausiert: ['Pausiert', 'gray'],
  archiviert: ['Archiviert', 'gray'],
};

export function UptimeDot({ uptime }: { uptime: any }) {
  const last = uptime?.last;
  if (!last) return <span className="muted small">nicht geprüft</span>;
  return (
    <span className="small" title={`HTTP ${last.status || '–'} · ${last.ms} ms · ${ago(last.at)}`}>
      <span className={`dot ${last.ok ? 'up' : 'down'}`} />
      {last.ok ? 'online' : 'offline'}
      {uptime.week_pct !== null ? ` · ${String(uptime.week_pct).replace('.', ',')} % (7 T.)` : ''}
    </span>
  );
}

function ListEditor({ items, onChange, fields }: { items: any[]; onChange: (v: any[]) => void; fields: [string, string][] }) {
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} className="list-row" style={{ gridTemplateColumns: `${fields.map(() => 'minmax(0, 1fr)').join(' ')} auto` }}>
          {fields.map(([k, ph]) => (
            <Input key={k} value={typeof it === 'string' ? it : it[k]} onChange={(v) => onChange(items.map((x, j) => (j === i ? (fields.length === 1 && typeof x === 'string' ? v : { ...x, [k]: v }) : x)))} placeholder={ph} />
          ))}
          <button className="btn small ghost" aria-label="Entfernen" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn small secondary" onClick={() => onChange([...items, fields.length === 1 && fields[0][0] === '' ? '' : Object.fromEntries(fields.map(([k]) => [k, '']))])}>
        + Hinzufügen
      </button>
    </div>
  );
}

export function Project() {
  const session = useSession();
  const p = useLoad(() => api.get<any>('/api/project'), [session.locationId]);
  const [v, setV] = useState<any>(null);
  useEffect(() => setV(p.data ? { ...p.data } : null), [p.data]);
  if (!p.data || !v) return <Spinner />;
  const edit = can(session, 'settings');
  const set = (patch: any) => setV({ ...v, ...patch });
  const s = p.data.stats;
  const loc = session.locations.find((l) => l.id === session.locationId);
  return (
    <>
      <PageHead title={loc?.name ?? 'Projekt'} sub={v.tagline || 'Projekt-Steckbrief'}>
        <Badge tone={STATUS[v.status]?.[1]}>{STATUS[v.status]?.[0] ?? v.status}</Badge>
        <ClaudeButton sessions={p.data.claude_sessions} />
        <CodexButton sessions={p.data.codex_sessions} />
        {v.website && (
          <a className="btn secondary" href={v.website} target="_blank" rel="noreferrer">
            Website öffnen
          </a>
        )}
        {edit && (
          <button className="btn" data-tour="project-save" onClick={async () => (await act(() => api.put('/api/project', v), 'Gespeichert')) && (p.reload(), void refreshProjects(session))}>
            Speichern
          </button>
        )}
      </PageHead>
      <SortableGrid id="project.stats" className="stats" data-tour="project-stats">
        <Stat key="contacts" label="Kontakte" value={s.contacts} />
        <Stat key="deals" label="Offene Deals" value={s.open_opportunities} sub={euro(s.open_value)} />
        <Stat key="tasks" label="Aufgaben offen" value={s.open_tasks} sub={s.overdue_tasks ? `${s.overdue_tasks} überfällig` : undefined} />
        <Stat key="inbox" label="Ungelesen / Entwürfe" value={`${s.unread} / ${s.drafts}`} />
        <Stat key="website" tour="project-uptime" label="Website" value={<UptimeDot uptime={p.data.uptime} />} sub={s.last_activity ? `Aktiv ${ago(s.last_activity)}` : undefined} />
      </SortableGrid>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '2 1 460px' }}>
          <div className="grid2">
            <Field label="Status" tour="project-status">
              <Select value={v.status} onChange={(x) => set({ status: x })} options={Object.entries(STATUS).map(([k, [l]]) => [k, l])} />
            </Field>
            <Field label="Kategorie">
              <Input value={v.category} onChange={(x) => set({ category: x })} placeholder="z. B. App, Spiel, Marktplatz" />
            </Field>
          </div>
          <Field label="Kurzbeschreibung">
            <Input value={v.tagline} onChange={(x) => set({ tagline: x })} />
          </Field>
          <Field label="Website" hint="Wird alle 10 Minuten auf Erreichbarkeit geprüft." tour="project-website">
            <Input value={v.website} onChange={(x) => set({ website: x })} placeholder="https://…" />
          </Field>
          <Field label="Beschreibung">
            <Textarea value={v.description} onChange={(x) => set({ description: x })} rows={5} />
          </Field>
          <Field label="Ziele" tour="project-goals">
            <Textarea value={v.goals} onChange={(x) => set({ goals: x })} rows={4} placeholder="Was soll bis wann erreicht sein?" />
          </Field>
          <Field label="Notizen">
            <Textarea value={v.notes} onChange={(x) => set({ notes: x })} rows={6} />
          </Field>
        </div>
        <div style={{ flex: '1 1 320px' }}>
          <ProjectDocs />
          <Slot name="project.files" />
          <div className="card" data-tour="project-kpis">
            <h2>Kennzahlen</h2>
            <ListEditor items={v.kpis} onChange={(kpis) => set({ kpis })} fields={[['label', 'Kennzahl'], ['value', 'Ist'], ['target', 'Ziel']]} />
          </div>
          <div className="card">
            <h2>Links</h2>
            <ListEditor items={v.links} onChange={(links) => set({ links })} fields={[['label', 'Name'], ['url', 'https://…']]} />
            {v.links.length > 0 && (
              <p className="small">
                {v.links.filter((l: any) => l.url).map((l: any, i: number) => (
                  <a key={i} href={l.url} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                    {l.label} ↗
                  </a>
                ))}
              </p>
            )}
          </div>
          <div className="card" data-tour="project-claude">
            <h2>Claude-Sitzungen</h2>
            <p className="muted small" style={{ marginTop: -4 }}>Link aus claude.ai/code einfügen – dann springst du von überall mit einem Klick in die Sitzung zum Projekt.</p>
            <ListEditor items={v.claude_sessions ?? []} onChange={(claude_sessions) => set({ claude_sessions })} fields={[['label', 'z. B. Go-to-Market'], ['url', 'https://claude.ai/code/session_…']]} />
          </div>
          <div className="card" data-tour="project-codex">
            <h2>Codex-Aufgaben</h2>
            <p className="muted small" style={{ marginTop: -4 }}>Link aus chatgpt.com/codex einfügen (Aufgabe oder Umgebung) – der Codex-Knopf öffnet sie von überall, auch über Strg+K.</p>
            <ListEditor items={v.codex_sessions ?? []} onChange={(codex_sessions) => set({ codex_sessions })} fields={[['label', 'z. B. Checkout-Bug'], ['url', 'https://chatgpt.com/codex/tasks/task_e_…']]} />
          </div>
          <div className="card" data-tour="project-servers">
            <h2>Code & Server</h2>
            <Field label="Repositories">
              <ListEditor items={v.repos} onChange={(repos) => set({ repos })} fields={[['', 'owner/repo']]} />
            </Field>
            <Field label="Server / Deployments">
              <ListEditor items={v.servers} onChange={(servers) => set({ servers })} fields={[['name', 'z. B. KVM 8'], ['detail', 'Docker-Projekt, Port …']]} />
            </Field>
          </div>
        </div>
      </div>
    </>
  );
}

export function ProjectsOverview() {
  const session = useSession();
  const list = useLoad(() => api.get<any[]>('/api/agency/projects'), []);
  const [filter, setFilter] = useState('');
  if (!list.data) return <Spinner />;
  // Archived projects only show up when asked for.
  const shown = list.data.filter((l) => (filter ? l.profile.status === filter : l.profile.status !== 'archiviert')).sort((a, b) => (b.profile.priority ?? 0) - (a.profile.priority ?? 0) || a.name.localeCompare(b.name));
  if (!list.data.length) return <Empty>Noch keine Projekte.</Empty>;
  return (
    <>
      <div className="row" style={{ marginBottom: 12, maxWidth: 360 }}>
        <Select value={filter} onChange={setFilter} placeholder="Alle Status" options={Object.entries(STATUS).map(([k, [l]]) => [k, l])} />
      </div>
      {/* in the order the person dragged them into (web/src/sortable); new projects join at the end, a status filter keeps the rest's order */}
      <SortableGrid id="agency.projects" className="proj-grid" data-tour="agency-projects">
        {shown.map((l) => (
          <div
            key={l.id}
            className="card proj-card"
            {...pressable(() => session.switchLocation(l.id, 'project'))}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>{l.name}</h3>
              <span className="actions">
                <ClaudeButton sessions={l.profile.claude_sessions} compact />
                <CodexButton sessions={l.profile.codex_sessions} compact />
                <Badge tone={STATUS[l.profile.status]?.[1]}>{STATUS[l.profile.status]?.[0]}</Badge>
              </span>
            </div>
            {l.profile.tagline && <div className="muted small">{l.profile.tagline}</div>}
            <div className="row small" style={{ justifyContent: 'space-between' }}>
              {l.profile.website ? (
                <a href={l.profile.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  {displayHost(l.profile.website)}
                </a>
              ) : (
                <span className="muted">keine Website</span>
              )}
              <UptimeDot uptime={l.profile.uptime} />
            </div>
            <div className="proj-kpis">
              <div>
                <b>{l.stats.open_opportunities}</b>
                <span>offene Deals</span>
              </div>
              <div>
                <b>{l.stats.open_tasks}</b>
                <span>Aufgaben{l.stats.overdue_tasks ? ` (${l.stats.overdue_tasks} überf.)` : ''}</span>
              </div>
              <div>
                <b>{l.stats.unread + l.stats.drafts}</b>
                <span>Post & Entwürfe</span>
              </div>
            </div>
            <div className="muted small">{l.stats.contacts} Kontakte · {l.stats.last_activity ? `aktiv ${ago(l.stats.last_activity)}` : 'noch keine Aktivität'}</div>
          </div>
        ))}
      </SortableGrid>
    </>
  );
}
