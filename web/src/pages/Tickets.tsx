import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, channelIcon, type IconName } from '../icons';
import { api, dt, name } from '../api';
import { CanvasPin } from '../canvas/pin';
import { act, Badge, Check, confirmAsk, Empty, Field, Input, Link, Modal, navigate, PageHead, pressable, Select, Spinner, Stat, Tabs, TagInput, Textarea, toast, useLoad } from '../ui';
import { HealthBadge } from './HealthScore';
import { BugTriagePanel } from './FeedbackAdmin';
import { MoveMenu } from '../xr/MoveMenu';
import { getLocale, intlLocale, useT, tr } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';
import { SortableGrid } from '../sortable/Sortable';

// --- shared bits --------------------------------------------------------------------------------

type Tone = 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple';
// German labels (message ids of the helpdesk catalog), shown through t()
export const PRIORITY: Record<string, [string, Tone]> = { niedrig: ['Niedrig', 'gray'], normal: ['Normal', 'blue'], hoch: ['Hoch', 'yellow'], dringend: ['Dringend', 'red'] };
const KIND_TONE: Record<string, Tone> = { new: 'blue', open: 'purple', waiting: 'yellow', resolved: 'green', closed: 'gray' };
// German labels (message ids of the helpdesk catalog), shown through t()
const CHANNELS: [string, string][] = [['email', 'E-Mail'], ['sms', 'SMS'], ['chat', 'Live-Chat'], ['whatsapp', 'WhatsApp']];

export function PriorityBadge({ p }: { p: string }) {
  const t = useT('helpdesk');
  const [l, tone] = PRIORITY[p] ?? [p, 'gray'];
  return <Badge tone={tone}>{PRIORITY[p] ? t(l) : l}</Badge>;
}
export function StatusBadge({ t }: { t: { status: string; status_kind: string } }) {
  return <Badge tone={KIND_TONE[t.status_kind] ?? 'gray'}>{t.status}</Badge>;
}

/** Re-renders every 30 s so SLA timers count down. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return now;
}

const dur = (ms: number) => {
  const t = tr('helpdesk');
  const m = Math.max(1, Math.round(Math.abs(ms) / 60000));
  if (m < 60) return t('{n} Min.', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('{n} Std.', { n: h });
  return t('{n} Tg.', { n: Math.round(h / 24) });
};

/** The timer that matters now: first answer (until answered), then resolution. */
export function slaInfo(tk: any, now: number): { label: string; tone: Tone; icon: IconName } | null {
  const t = tr('helpdesk');
  const done = tk.status_kind === 'resolved' || tk.status_kind === 'closed';
  if (done) {
    if (tk.sla?.resolution === 'met') return { label: t('SLA eingehalten'), tone: 'green', icon: 'ok' };
    if (tk.sla?.resolution === 'missed') return { label: t('SLA verfehlt'), tone: 'red', icon: 'fail' };
    return null;
  }
  let kind = '';
  let due = '';
  let warn = '';
  if (!tk.first_response_at && tk.first_response_due_at) [kind, due, warn] = [t('Antwort'), tk.first_response_due_at, tk.first_response_warn_at];
  else if (tk.sla_paused_at && tk.resolution_due_at && tk.resolution_due_at > tk.sla_paused_at) return { label: t('SLA pausiert'), tone: 'gray', icon: 'pause' };
  else if (tk.resolution_due_at) [kind, due, warn] = [t('Lösung'), tk.resolution_due_at, tk.resolution_warn_at];
  if (!due) return null;
  const left = Date.parse(due) - now;
  if (left <= 0) return { label: t('{kind} überfällig · {time}', { kind, time: dur(left) }), tone: 'red', icon: 'fail' };
  if (warn && now >= Date.parse(warn)) return { label: t('{kind} läuft bald ab · {time}', { kind, time: dur(left) }), tone: 'yellow', icon: 'wait' };
  return { label: t('{kind} in {time}', { kind, time: dur(left) }), tone: 'gray', icon: 'pending' };
}
export function SlaChip({ t: tk }: { t: any }) {
  const t = useT('helpdesk');
  const now = useNow();
  const s = slaInfo(tk, now);
  if (!s) return null;
  return (
    <span className={`sla-chip ${s.tone}`} title={t('Erste Antwort fällig: {first} · Lösung fällig: {resolution}', { first: dt(tk.first_response_due_at), resolution: dt(tk.resolution_due_at) })}>
      <Icon name={s.icon} size={12} /> {s.label}
    </span>
  );
}

export function useTicketMeta() {
  return useLoad(() => api.get('/api/tickets/meta'), []);
}

function ContactPicker({ value, label, onChange }: { value: string; label?: string; onChange: (id: string, label: string) => void }) {
  const t = useT('helpdesk');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  useEffect(() => {
    if (q.length < 2) return setFound([]);
    const tk = setTimeout(() => api.get(`/api/contacts?q=${encodeURIComponent(q)}&limit=6`).then((r) => setFound(r.contacts)).catch(() => {}), 200);
    return () => clearTimeout(tk);
  }, [q]);
  if (value)
    return (
      <div className="row" style={{ alignItems: 'center' }}>
        <strong className="grow">{label || t('Kontakt gewählt')}</strong>
        <button type="button" className="btn small ghost" onClick={() => onChange('', '')}>
          {t('ändern')}
        </button>
      </div>
    );
  return (
    <div className="picker">
      <Input value={q} onChange={setQ} placeholder={t('Name, E-Mail oder Telefon…')} />
      {found.map((c) => (
        <button type="button" key={c.id} className="picker-row" onClick={() => (onChange(c.id, name(c)), setQ(''))}>
          {name(c)} <span className="muted small">{c.email || c.phone}</span>
        </button>
      ))}
    </div>
  );
}

export function NewTicket({ onClose, onSaved, initial = {} }: { onClose: () => void; onSaved: (tk: any) => void; initial?: Record<string, any> }) {
  const t = useT('helpdesk');
  const meta = useTicketMeta();
  const [f, setF] = useState<any>({ priority: 'normal', source: 'manuell', ...initial });
  const m = meta.data;
  const pipe = m?.pipelines.find((p: any) => p.id === f.pipeline_id) ?? m?.pipelines[0];
  const save = async () => {
    const path = f.conversation_id ? '/api/tickets/from-conversation' : f.call_id ? '/api/tickets/from-call' : '/api/tickets';
    const r = await act(() => api.post(path, { ...f, contact_label: undefined }), t('Ticket angelegt'));
    if (r) onSaved(r);
  };
  return (
    <Modal title={t('Neues Ticket')} onClose={onClose} wide footer={<button className="btn" onClick={save}>{t('Ticket anlegen')}</button>}>
      {!m ? (
        <Spinner />
      ) : (
        <>
          <Field label={t('Betreff')} tour="ticket-subject">
            <Input value={f.subject} onChange={(v) => setF({ ...f, subject: v })} placeholder={f.conversation_id ? t('leer = Betreff der letzten Nachricht') : t('Worum geht es?')} autoFocus />
          </Field>
          <Field label={t('Beschreibung')}>
            <Textarea value={f.description} onChange={(v) => setF({ ...f, description: v })} rows={4} placeholder={f.conversation_id ? t('leer = letzte Nachricht des Kontakts') : ''} />
          </Field>
          {!f.conversation_id && !f.call_id && (
            <Field label={t('Kontakt')} tour="ticket-contact">
              <ContactPicker value={f.contact_id} label={f.contact_label} onChange={(id, l) => setF({ ...f, contact_id: id, contact_label: l })} />
            </Field>
          )}
          <div className="grid2">
            <Field label={t('Priorität')} tour="ticket-priority">
              <Select value={f.priority} onChange={(v) => setF({ ...f, priority: v })} options={m.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])} />
            </Field>
            <Field label={t('Kategorie')}>
              <Select value={f.category} onChange={(v) => setF({ ...f, category: v })} placeholder="–" options={m.categories} />
            </Field>
            <Field label="Team" tour="ticket-team">
              <Select value={f.team_id} onChange={(v) => setF({ ...f, team_id: v })} placeholder={t('– automatisch –')} options={m.teams.map((tk: any) => [tk.id, tk.name])} />
            </Field>
            <Field label={t('Zuständig')}>
              <Select value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} placeholder={t('– nach Regeln –')} options={m.agents.map((a: any) => [a.id, a.name])} />
            </Field>
            {!f.conversation_id && !f.call_id && (
              <Field label={t('Quelle')}>
                <Select value={f.source} onChange={(v) => setF({ ...f, source: v })} options={m.sources} />
              </Field>
            )}
            <Field label={t('Fällig am (optional)')}>
              <Input type="date" value={f.due_at?.slice(0, 10)} onChange={(v) => setF({ ...f, due_at: v })} />
            </Field>
            {m.pipelines.length > 1 && (
              <Field label="Pipeline">
                <Select value={pipe?.id} onChange={(v) => setF({ ...f, pipeline_id: v })} options={m.pipelines.map((p: any) => [p.id, p.name])} />
              </Field>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

// --- list & kanban --------------------------------------------------------------------------------

const FILTER_KEYS = ['state', 'pipeline_id', 'priority', 'owner', 'team_id', 'category', 'tag', 'source', 'sla', 'q', 'sort'] as const;
type Filters = Partial<Record<(typeof FILTER_KEYS)[number] | 'layout', string>>;
const loadLayout = () => {
  try {
    return localStorage.getItem('pghl.tickets.layout') || 'list';
  } catch {
    return 'list';
  }
};

function BulkBar({ ids, meta, onDone }: { ids: string[]; meta: any; onDone: () => void }) {
  const t = useT('helpdesk');
  const [tag, setTag] = useState('');
  const run = async (action: string, value?: string) => {
    if (action === 'delete' && !confirmAsk(t.plural(ids.length, { other: '{n} Tickets löschen?' }))) return;
    if (action === 'merge' && !confirmAsk(t.plural(ids.length, { other: '{n} Tickets zu einem zusammenführen? Das erste gewählte bleibt.' }))) return;
    const r = await act(() => api.post('/api/tickets/bulk', { ids, action, value }));
    if (r) {
      toast(action === 'merge' ? t('Zusammengeführt') : t.plural(r.count, { other: '{n} Tickets geändert' }));
      onDone();
    }
  };
  const stages = meta.pipelines.flatMap((p: any) => p.stages.map((s: any) => [s.id, meta.pipelines.length > 1 ? `${p.name}: ${s.name}` : s.name]));
  return (
    <div className="card bulk-bar">
      <strong>{ids.length} {t('ausgewählt')}</strong>
      <div style={{ width: 170 }}>
        <Select value="" onChange={(v) => v && run('status', v)} placeholder={t('Status setzen…')} options={stages} />
      </div>
      <div style={{ width: 150 }}>
        <Select value="" onChange={(v) => v && run('priority', v)} placeholder={t('Priorität…')} options={meta.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])} />
      </div>
      <div style={{ width: 170 }}>
        <Select value="" onChange={(v) => v && run('owner', v === '__none' ? '' : v)} placeholder={t('Zuweisen…')} options={[['__none', t('– niemand –')], ...meta.agents.map((a: any) => [a.id, a.name])]} />
      </div>
      {meta.teams.length > 0 && (
        <div style={{ width: 150 }}>
          <Select value="" onChange={(v) => v && run('team', v === '__none' ? '' : v)} placeholder={t('Team…')} options={[['__none', t('– kein Team –')], ...meta.teams.map((tk: any) => [tk.id, tk.name])]} />
        </div>
      )}
      <div style={{ width: 120 }}>
        <Input value={tag} onChange={setTag} placeholder="Tag" />
      </div>
      <button className="btn small secondary" disabled={!tag} onClick={() => run('add_tag', tag)}>
        {t('+ Tag')}
      </button>
      {ids.length > 1 && (
        <button className="btn small secondary" onClick={() => run('merge', ids[0])}>
          <Icon name="merge" size={14} /> {t('Zusammenführen')}
        </button>
      )}
      <button className="btn small danger" onClick={() => run('delete')}>
        {t('Löschen')}
      </button>
    </div>
  );
}

function TicketKanban({ tickets, pipeline, onMoved }: { tickets: any[]; pipeline: any; onMoved: () => void }) {
  const t = useT('helpdesk');
  const [over, setOver] = useState('');
  const drop = async (stageId: string, ticketId: string) => {
    setOver('');
    const tk = tickets.find((x) => x.id === ticketId);
    if (!tk || tk.stage_id === stageId) return;
    if (await act(() => api.patch(`/api/tickets/${ticketId}`, { status: stageId }))) onMoved();
  };
  return (
    <div className="kanban ticket-kanban">
      {pipeline.stages.map((s: any) => {
        const items = tickets.filter((tk) => tk.pipeline_id === pipeline.id && tk.stage_id === s.id);
        return (
          <div key={s.id} className={`kcol${over === s.id ? ' over' : ''}`} onDragOver={(e) => (e.preventDefault(), setOver(s.id))} onDragLeave={() => setOver('')} onDrop={(e) => drop(s.id, e.dataTransfer.getData('text/plain'))}>
            <div className="kcol-head">
              <strong>{s.name}</strong>
              <div className="muted">
                {items.length} {items.length === 1 ? t('Ticket') : 'Tickets'}
                {s.pause_sla ? t(' · SLA pausiert') : ''}
              </div>
            </div>
            <div className="kcol-body">
              {items.map((tk) => (
                <div key={tk.id} className="kcard tcard" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', tk.id)} {...pressable(() => navigate(`tickets/${tk.id}`))}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 6, flexWrap: 'nowrap' }}>
                    <span className="muted small">#{tk.number}</span>
                    <PriorityBadge p={tk.priority} />
                  </div>
                  <div className="tcard-subject">{tk.subject}</div>
                  <div className="muted small">{tk.contact_name || t('ohne Kontakt')}</div>
                  <MoveMenu what={t('Ticket #{number} „{subject}“', { number: tk.number, subject: tk.subject })} current={tk.stage_id} targets={pipeline.stages.map((st: any) => ({ id: st.id, label: st.name }))} onMove={(stage) => drop(stage, tk.id)} />
                  <div className="row" style={{ justifyContent: 'space-between', marginTop: 6, gap: 6, alignItems: 'center' }}>
                    <SlaChip t={tk} />
                    {tk.owner_name && (
                      <span className="avatar" title={tk.owner_name}>
                        {tk.owner_name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {!items.length && <div className="muted small kempty">{t('Hierher ziehen')}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TicketList() {
  const t = useT('helpdesk');
  const meta = useTicketMeta();
  const views = useLoad(() => api.get<any[]>('/api/helpdesk/views'), []);
  // Links like /app/tickets?owner=<id> or ?sla=breached (workload, dashboard) preset the filters.
  const [f, setF] = useState<Filters>(() => ({ state: 'open', layout: loadLayout(), ...Object.fromEntries([...new URLSearchParams(location.search)].filter(([k]) => (FILTER_KEYS as readonly string[]).includes(k))) }));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const tk = setTimeout(() => setF((x) => ({ ...x, q })), 250);
    return () => clearTimeout(tk);
  }, [q]);
  const layout = f.layout === 'kanban' ? 'kanban' : 'list';
  const pipeline = meta.data?.pipelines.find((p: any) => p.id === f.pipeline_id) ?? meta.data?.pipelines[0];
  const qs = new URLSearchParams(Object.entries({ ...f, layout: undefined, state: layout === 'kanban' ? 'all' : f.state, pipeline_id: layout === 'kanban' ? pipeline?.id : f.pipeline_id }).filter(([, v]) => v) as [string, string][]).toString();
  const list = useLoad(() => (meta.data ? api.get(`/api/tickets?${qs}&limit=${layout === 'kanban' ? 500 : 200}`) : Promise.resolve(null)), [qs, !!meta.data]);
  const set = (patch: Filters) => {
    setSel([]);
    setF((x) => ({ ...x, ...patch }));
  };
  const setLayout = (l: string) => {
    try {
      localStorage.setItem('pghl.tickets.layout', l);
    } catch {
      /* private mode */
    }
    set({ layout: l });
  };
  const m = meta.data;
  if (!m) return <Spinner />;
  const tickets: any[] = list.data?.tickets ?? [];
  const active = FILTER_KEYS.some((k) => k !== 'state' && k !== 'sort' && f[k]);
  return (
    <>
      <div className="row ticket-filters" data-tour="tickets-filters">
        <div className="grow">
          <Input value={q} onChange={setQ} placeholder={t('Suchen: Betreff, Kontakt, #Nummer…')} />
        </div>
        {layout === 'list' && (
          <div style={{ width: 150 }}>
            <Select value={f.state} onChange={(v) => set({ state: v })} aria="Status" options={[['open', t('Offen')], ['resolved', t('Gelöst')], ['closed', t('Geschlossen')], ['all', t('Alle')]]} />
          </div>
        )}
        <div style={{ width: 150 }}>
          <Select value={f.priority} onChange={(v) => set({ priority: v })} placeholder={t('Jede Priorität')} options={m.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])} />
        </div>
        <div style={{ width: 170 }}>
          <Select value={f.owner} onChange={(v) => set({ owner: v })} placeholder={t('Alle Zuständigen')} options={[['me', t('Mir zugewiesen')], ['none', t('Nicht zugewiesen')], ...m.agents.map((a: any) => [a.id, a.name])]} />
        </div>
        {m.teams.length > 0 && (
          <div style={{ width: 150 }}>
            <Select value={f.team_id} onChange={(v) => set({ team_id: v })} placeholder={t('Alle Teams')} options={[['none', t('Ohne Team')], ...m.teams.map((tk: any) => [tk.id, tk.name])]} />
          </div>
        )}
        <div style={{ width: 150 }}>
          <Select value={f.category} onChange={(v) => set({ category: v })} placeholder={t('Alle Kategorien')} options={m.categories} />
        </div>
        <div style={{ width: 160 }}>
          <Select value={f.sla} onChange={(v) => set({ sla: v })} placeholder={t('SLA: alle')} options={[['at_risk', t('Gefährdet')], ['warning', t('Läuft bald ab')], ['breached', t('Überschritten')]]} />
        </div>
        <div style={{ width: 140 }}>
          <Select value={f.source} onChange={(v) => set({ source: v })} placeholder={t('Jede Quelle')} options={m.sources} />
        </div>
        {(layout === 'kanban' || m.pipelines.length > 1) && m.pipelines.length > 1 && (
          <div style={{ width: 150 }}>
            <Select value={pipeline?.id} onChange={(v) => set({ pipeline_id: v })} aria="Pipeline" options={m.pipelines.map((p: any) => [p.id, p.name])} />
          </div>
        )}
        <div style={{ width: 175 }}>
          <Select value={f.sort} onChange={(v) => set({ sort: v })} placeholder={t('Zuletzt geändert')} aria={t('Sortierung')} options={[['due', t('SLA zuerst')], ['priority', t('Priorität')], ['created', t('Neueste')], ['number', t('Nummer')]]} />
        </div>
      </div>
      <div className="row view-row" data-tour="tickets-views">
        <div className="seg" role="group" aria-label={t('Ansicht')}>
          <button className={layout === 'list' ? 'on' : ''} onClick={() => setLayout('list')}>
            <Icon name="list" size={14} /> {t('Liste')}
          </button>
          <button className={layout === 'kanban' ? 'on' : ''} onClick={() => setLayout('kanban')}>
            <Icon name="kanban" size={14} /> {t('Kanban')}
          </button>
        </div>
        {(views.data ?? []).map((v) => (
          <span key={v.id} className="view-chip">
            <button className="btn small secondary" onClick={() => (setQ(v.filters.q ?? ''), setF({ state: 'open', layout, ...v.filters }))}>
              <Icon name="bookmark" size={13} /> {v.name}
              {!v.user_id && <span className="muted small"> {t('· geteilt')}</span>}
            </button>
            <button className="icon-btn" aria-label={t('Ansicht {name} löschen', { name: v.name })} onClick={async () => confirmAsk(t('Ansicht „{name}“ löschen?', { name: v.name })) && (await act(() => api.del(`/api/helpdesk/views/${v.id}`))) && views.reload()}>
              ×
            </button>
          </span>
        ))}
        {active && (
          <>
            <button
              className="btn small ghost"
              onClick={async () => {
                const n = prompt(t('Name der Ansicht'));
                if (!n) return;
                const shared = confirmAsk(t('Für das ganze Team sichtbar machen? (Abbrechen = nur für mich)'));
                if (await act(() => api.post('/api/helpdesk/views', { name: n, shared, filters: { ...f, q } }), t('Ansicht gespeichert'))) views.reload();
              }}
            >
              {t('☆ Ansicht speichern')}
            </button>
            <button className="btn small ghost" onClick={() => (setQ(''), setF({ state: 'open', layout }))}>
              {t('Filter zurücksetzen')}
            </button>
          </>
        )}
        <span className="grow" />
        <span className="muted small">{list.data ? t.plural(list.data.total, { other: '{n} Tickets' }) : ''}</span>
      </div>
      {sel.length > 0 && <BulkBar ids={sel} meta={m} onDone={() => (setSel([]), list.reload())} />}
      {list.loading && !list.data ? (
        <Spinner />
      ) : layout === 'kanban' && pipeline ? (
        <TicketKanban tickets={tickets} pipeline={pipeline} onMoved={list.reload} />
      ) : tickets.length ? (
        <div className="table-wrap" data-tour="tickets-table">
          <table className="t tickets-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input type="checkbox" aria-label={t('Alle wählen')} checked={sel.length === tickets.length} onChange={(e) => setSel(e.target.checked ? tickets.map((tk) => tk.id) : [])} />
                </th>
                <th>{t('Ticket')}</th>
                <th>Status</th>
                <th>{t('Priorität')}</th>
                <th>{t('Zuständig')}</th>
                <th>{t('SLA')}</th>
                <th>{t('Geändert')}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((tk) => (
                <tr key={tk.id} className="click" {...pressable(() => navigate(`tickets/${tk.id}`))}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={t('Ticket {number} wählen', { number: tk.number })} checked={sel.includes(tk.id)} onChange={(e) => setSel(e.target.checked ? [...sel, tk.id] : sel.filter((x) => x !== tk.id))} />
                  </td>
                  <td className="tcell">
                    <strong>
                      <span className="muted">#{tk.number}</span> {tk.subject}
                    </strong>
                    <div className="muted small">
                      {tk.contact_name || t('ohne Kontakt')}
                      {tk.category ? ` · ${tk.category}` : ''}
                      {tk.source ? ` · ${tk.source}` : ''}
                      {tk.tags.slice(0, 3).map((x: string) => (
                        <span key={x} className="tag" style={{ marginLeft: 6 }}>
                          {x}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <StatusBadge t={tk} />
                  </td>
                  <td>
                    <PriorityBadge p={tk.priority} />
                  </td>
                  <td className="muted">{tk.owner_name || '–'}{tk.team_name ? <div className="small">{tk.team_name}</div> : null}</td>
                  <td>
                    <SlaChip t={tk} />
                  </td>
                  <td className="muted small">{dt(tk.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty action={<button className="btn" onClick={() => setModal(true)}>{t('Erstes Ticket anlegen')}</button>}>{active ? t('Keine Tickets für diese Filter.') : t('Keine offenen Tickets – alles erledigt.')}</Empty>
      )}
      {modal && <NewTicket onClose={() => setModal(false)} onSaved={(tk) => navigate(`tickets/${tk.id}`)} />}
    </>
  );
}

// --- dashboard & workload ---------------------------------------------------------------------------

/** "12 %" / "1,5 Std." in German (as before), "12%" / "1.5 h" in English. */
const percent = (n: number | string) => (getLocale() === SOURCE_LOCALE ? `${n} %` : `${n}%`);
const dec = (n: number | string) => (getLocale() === SOURCE_LOCALE ? String(n).replace('.', ',') : String(n));
const fmtMin = (m: number | null) => {
  const t = tr('helpdesk');
  return m === null || m === undefined ? '–' : m < 60 ? t('{n} Min.', { n: m }) : m < 48 * 60 ? t('{n} Std.', { n: dec((m / 60).toFixed(1)) }) : t('{n} Tg.', { n: dec((m / 1440).toFixed(1)) });
};

/** Backlog (line) and new vs. solved per day (bars) – one axis, counts only. */
function TrendChart({ trend }: { trend: { day: string; created: number; resolved: number; backlog: number }[] }) {
  const t = useT('helpdesk');
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the real pixel width so text and marks keep their size.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 200;
  const pad = { l: 30, r: 8, t: 10, b: 22 };
  const max = Math.max(1, ...trend.map((d) => Math.max(d.backlog, d.created, d.resolved)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const step = iw / Math.max(1, trend.length);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const bw = Math.max(2, Math.min(14, step / 2 - 2));
  const line = trend.map((d, i) => `${i ? 'L' : 'M'}${(pad.l + step * i + step / 2).toFixed(1)},${y(d.backlog).toFixed(1)}`).join(' ');
  const ticks = [0, Math.round(max / 2), max];
  const h = hover !== null ? trend[hover] : null;
  return (
    <div className="hd-viz">
      <div className="hd-viz-legend">
        <span><i className="sw line" /> {t('Offen (Backlog)')}</span>
        <span><i className="sw s1" /> {t('Neu')}</span>
        <span><i className="sw s2" /> {t('Gelöst')}</span>
      </div>
      <div style={{ position: 'relative' }} ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ maxWidth: '100%' }} role="img" aria-label={t('Ticket-Verlauf: offen, neu und gelöst pro Tag')} onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="hd-viz-grid" />
              <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="hd-viz-axis">
                {v}
              </text>
            </g>
          ))}
          {trend.map((d, i) => {
            const x = pad.l + step * i + step / 2;
            return (
              <g key={d.day}>
                {d.created > 0 && <rect x={x - bw - 1} width={bw} y={y(d.created)} height={Math.max(0, pad.t + ih - y(d.created))} rx={Math.min(3, bw / 2)} className="hd-viz-s1" />}
                {d.resolved > 0 && <rect x={x + 1} width={bw} y={y(d.resolved)} height={Math.max(0, pad.t + ih - y(d.resolved))} rx={Math.min(3, bw / 2)} className="hd-viz-s2" />}
                <rect x={x - step / 2} width={step} y={pad.t} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          <path d={line} className="hd-viz-line" />
          {hover !== null && <line x1={pad.l + step * hover + step / 2} x2={pad.l + step * hover + step / 2} y1={pad.t} y2={pad.t + ih} className="hd-viz-cross" />}
          {[0, Math.floor((trend.length - 1) / 2), trend.length - 1].filter((v, i, a) => a.indexOf(v) === i && trend[v]).map((i) => (
            <text key={i} x={pad.l + step * i + step / 2} y={H - 6} textAnchor="middle" className="hd-viz-axis">
              {new Date(trend[i].day).toLocaleDateString(intlLocale(), { day: '2-digit', month: '2-digit' })}
            </text>
          ))}
        </svg>
        {h && hover !== null && (
          <div className="hd-viz-tip" style={{ left: `${((pad.l + step * hover + step / 2) / W) * 100}%` }}>
            <strong>{new Date(h.day).toLocaleDateString(intlLocale(), { weekday: 'short', day: '2-digit', month: '2-digit' })}</strong>
            <div>{t('Offen:')} {h.backlog}</div>
            <div>{t('Neu:')} {h.created}</div>
            <div>{t('Gelöst:')} {h.resolved}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; n: number; extra?: ReactNode }[] }) {
  const t = useT('helpdesk');
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <p className="muted">{t('Keine offenen Tickets.')}</p>;
  return (
    <>
      {rows.map((r) => (
        <div key={r.label} style={{ marginBottom: 8 }} title={`${r.label}: ${r.n}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              {r.label} {r.extra}
            </span>
            <span className="muted">{r.n}</span>
          </div>
          <div className="bar">
            <div style={{ width: `${(r.n / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

function HelpdeskDashboard() {
  const t = useT('helpdesk');
  const [days, setDays] = useState('30');
  const { data } = useLoad(() => api.get(`/api/helpdesk/dashboard?days=${days}`), [days]);
  if (!data) return <Spinner />;
  const pct = (x: { pct: number | null; met: number; missed: number }) => (x.pct === null ? '–' : percent(x.pct));
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
        <div style={{ width: 180 }}>
          <Select value={days} onChange={setDays} options={[['7', t('Letzte 7 Tage')], ['30', t('Letzte 30 Tage')], ['90', t('Letzte 90 Tage')]]} />
        </div>
      </div>
      <SortableGrid id="tickets-stats" className="stats" data-tour="tickets-stats">
        <Stat label={t('Offene Tickets')} value={data.open_total} sub={t('{n} nicht zugewiesen', { n: data.unassigned })} />
        <Stat label={t('SLA überschritten')} value={<span style={{ color: data.breached_open ? 'var(--red)' : undefined }}>{data.breached_open}</span>} sub={t.plural(data.warning_open, { other: '{n} laufen bald ab' })} />
        <Stat label={t('SLA-Quote erste Antwort')} value={pct(data.sla.first_response)} sub={t('{met} eingehalten · {missed} verfehlt', { met: data.sla.first_response.met, missed: data.sla.first_response.missed })} />
        <Stat label={t('SLA-Quote Lösung')} value={pct(data.sla.resolution)} sub={t('{met} eingehalten · {missed} verfehlt', { met: data.sla.resolution.met, missed: data.sla.resolution.missed })} />
        <Stat label={t('Ø erste Antwort')} value={fmtMin(data.avg_first_response_min)} sub={t.plural(data.created, { other: '{n} neue Tickets' })} />
        <Stat label={t('Ø Lösungszeit')} value={fmtMin(data.avg_resolution_min)} sub={t('{n} gelöst', { n: data.resolved })} />
        <Stat label={t('Zufriedenheit (CSAT)')} value={data.csat.avg !== null ? `${dec(data.csat.avg)} / 5` : '–'} sub={data.csat.count ? t.plural(data.csat.count, { other: '{pct} zufrieden · {n} Bewertungen' }, { pct: percent(data.csat.satisfied_pct) }) : t('noch keine Bewertungen')} />
        <Stat label={t('NPS')} value={data.nps?.score ?? '–'} sub={data.nps?.count ? t('{promoters} Promotoren · {detractors} Kritiker', { promoters: data.nps.promoters, detractors: data.nps.detractors }) : t('noch keine Antworten')} />
      </SortableGrid>
      <div className="card" data-tour="tickets-trend">
        <h2>{t('Verlauf')}</h2>
        <TrendChart trend={data.trend} />
      </div>
      <SortableGrid id="tickets.charts" className="grid3 dash-grid">
        <div className="card">
          <h2>{t('Offen nach Status')}</h2>
          <Bars rows={data.by_status.map((s: any) => ({ label: s.name, n: s.n }))} />
        </div>
        <div className="card">
          <h2>{t('Offen nach Priorität')}</h2>
          <Bars rows={Object.entries(data.by_priority).map(([p, n]) => ({ label: PRIORITY[p] ? t(PRIORITY[p][0]) : p, n: n as number }))} />
        </div>
        <div className="card">
          <h2>{t('Offen nach Zuständigen')}</h2>
          <Bars rows={data.by_owner.map((o: any) => ({ label: o.owner_id ? o.name : t(o.name), n: o.n }))} />
        </div>
      </SortableGrid>
    </>
  );
}

function Workload() {
  const t = useT('helpdesk');
  const { data } = useLoad(() => api.get('/api/helpdesk/workload'), []);
  if (!data) return <Spinner />;
  const max = Math.max(1, ...data.people.map((p: any) => p.open));
  return (
    <>
      <SortableGrid id="tickets-workload" className="stats" data-tour="tickets-workload">
        <Stat label={t('Nicht zugewiesen')} value={data.unassigned.open} sub={t('{urgent} hoch/dringend · {overdue} überfällig', { urgent: data.unassigned.urgent, overdue: data.unassigned.overdue })} />
      </SortableGrid>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>{t('Mitarbeiter')}</th>
              <th>Teams</th>
              <th style={{ width: '30%' }}>{t('Offen')}</th>
              <th>{t('Wartet')}</th>
              <th>{t('Hoch/dringend')}</th>
              <th>{t('Überfällig')}</th>
              <th>{t('Gelöst (7 Tage)')}</th>
            </tr>
          </thead>
          <tbody>
            {data.people.map((p: any) => (
              <tr key={p.owner_id} className="click" {...pressable(() => navigate(`tickets?owner=${p.owner_id}`))}>
                <td>
                  <strong>{p.name}</strong>
                  <div className="muted small">{p.email}</div>
                </td>
                <td className="muted small">{p.teams.join(', ') || '–'}</td>
                <td>
                  <div className="row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                    <span style={{ minWidth: 22 }}>{p.open}</span>
                    <div className="bar grow">
                      <div style={{ width: `${(p.open / max) * 100}%` }} />
                    </div>
                  </div>
                </td>
                <td>{p.waiting}</td>
                <td>{p.urgent ? <Badge tone="yellow">{p.urgent}</Badge> : 0}</td>
                <td>{p.overdue ? <Badge tone="red">{p.overdue}</Badge> : 0}</td>
                <td>{p.resolved_week}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Tickets({ tab }: { tab?: string }) {
  const t = useT('helpdesk');
  const [modal, setModal] = useState(false);
  const cur = tab === 'uebersicht' ? 'uebersicht' : tab === 'auslastung' ? 'auslastung' : 'liste';
  return (
    <>
      <PageHead title="Tickets" sub={t('Kundenanfragen aus E-Mail, Chat, WhatsApp, Formularen, Telefon und dem Kundenportal')}>
        <Link to="help-center" className="btn secondary">
          <Icon name="kb" size={15} /> {t('Wissensdatenbank')}
        </Link>
        <button className="btn" data-tour="tickets-new" onClick={() => setModal(true)}>
          {t('+ Ticket')}
        </button>
      </PageHead>
      <Tabs tabs={[['liste', 'Tickets'], ['uebersicht', t('Übersicht')], ['auslastung', t('Auslastung')]]} value={cur} onChange={(v) => navigate(v === 'liste' ? 'tickets' : `tickets/${v}`)} />
      <div style={{ marginTop: 14 }}>
        {cur === 'liste' && <TicketList />}
        {cur === 'uebersicht' && <HelpdeskDashboard />}
        {cur === 'auslastung' && <Workload />}
      </div>
      {modal && <NewTicket onClose={() => setModal(false)} onSaved={(tk) => navigate(`tickets/${tk.id}`)} />}
    </>
  );
}

// --- detail -----------------------------------------------------------------------------------------

const EVENT_ICON: Record<string, IconName> = { status: 'move', priority: 'flag', assigned: 'contact', field: 'edit', merged: 'merge', sla_warning: 'wait', sla_breached: 'fail', csat: 'heart', csat_sent: 'send', auto_reply: 'send' };
const FACES = ['😞', '🙁', '😐', '🙂', '😄'];

function eventLine(e: any, meta: any): string {
  const t = tr('helpdesk');
  const d = e.data ?? {};
  const who = e.user_name ? ` · ${e.user_name}` : d.via === 'workflow' ? ' · Workflow' : d.via === 'sla' ? ' · SLA' : '';
  switch (e.type) {
    case 'status':
      return t('Status: {status}', { status: e.body }) + who;
    case 'priority':
      return `${e.body}${who}`;
    case 'assigned': {
      const owner = meta?.agents.find((a: any) => a.id === d.owner_id)?.name;
      const team = meta?.teams.find((x: any) => x.id === d.team_id)?.name;
      return `${d.owner_id ? t('Zugewiesen an {name}', { name: owner ?? t('Mitarbeiter') }) : t('Zuweisung entfernt')}${team ? t(' (Team {team})', { team }) : ''}${d.auto ? t(' · automatisch') : who}`;
    }
    case 'csat':
      return t('Bewertung: {face} {score}/5 – {label}', { face: FACES[d.score - 1] ?? '', score: d.score, label: d.label ? t(d.label) : d.label }) + (e.body ? t(': „{comment}“', { comment: e.body }) : '');
    case 'csat_sent':
      return t('Zufriedenheits-Umfrage gesendet');
    default:
      return `${e.body}${who}`;
  }
}

function Timeline({ data, meta }: { data: any; meta: any }) {
  const t = useT('helpdesk');
  const tk = data.ticket;
  return (
    <div className="ticket-thread">
      {data.timeline.map((e: any) => {
        const d = e.data ?? {};
        if (e.type === 'created')
          return (
            <div key={e.id}>
              <div className="tl-sys">
                <Icon name="ticket" size={13} /> {t('Ticket angelegt ·')} {tk.source}
                {d.via && d.via !== 'user' ? ` (${d.via === 'email' ? t('E-Mail') : d.via === 'portal' ? t('Kundenportal') : d.via === 'form' ? t('Formular') : d.via === 'workflow' ? t('Workflow') : d.via.toUpperCase()})` : ''}
                {e.user_name ? ` · ${e.user_name}` : ''} · {dt(e.created_at)}
              </div>
              {e.body && !data.timeline.some((x: any) => x.type === 'customer_reply' && x.data?.origin) && <div className="bubble in">{e.body}</div>}
            </div>
          );
        if (e.type === 'customer_reply')
          return (
            <div key={e.id} className="bubble in">
              {d.subject && !d.origin && (
                <>
                  <strong>{d.subject}</strong>
                  <br />
                </>
              )}
              {e.body}
              <div className="meta">
                <Icon name={d.channel === 'portal' ? 'inbox' : channelIcon(e.channel ?? d.channel ?? 'email')} size={12} /> {d.user_name ?? name(data.contact)} · {d.channel === 'portal' || d.via === 'portal' ? t('Kundenportal · ') : ''}
                {dt(e.created_at)}
              </div>
            </div>
          );
        if (e.type === 'reply' || e.type === 'auto_reply')
          return (
            <div key={e.id} className={`bubble out${d.status === 'failed' ? ' failed' : ''}`}>
              {e.body.replace(/<[^>]+>/g, '')}
              <div className="meta">
                <Icon name={channelIcon(d.channel ?? 'email')} size={12} /> {e.type === 'auto_reply' ? t('Automatische Antwort') : e.user_name ?? 'Team'} · {dt(e.created_at)} · {d.status === 'failed' ? `${t('fehlgeschlagen')}${d.error ? `: ${d.error}` : ''}` : d.status === 'logged' ? t('gespeichert (kein Versand-Anbieter)') : t('gesendet')}
              </div>
            </div>
          );
        if (e.type === 'note')
          return (
            <div key={e.id} className="tl-note">
              <div className="muted small">
                <Icon name="note" size={12} /> {t('Interne Notiz ·')} {e.user_name ?? t('Automation')} · {dt(e.created_at)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>
            </div>
          );
        if (e.type === 'merged' && d.from)
          return (
            <div key={e.id} className="tl-note merged">
              <div className="muted small">
                <Icon name="merge" size={12} /> {dt(e.created_at)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{e.body}</div>
            </div>
          );
        return (
          <div key={e.id} className={`tl-sys${e.type === 'sla_breached' ? ' bad' : e.type === 'sla_warning' ? ' warn' : ''}`}>
            <Icon name={EVENT_ICON[e.type] ?? 'pending'} size={13} /> {eventLine(e, meta)} · {dt(e.created_at)}
          </div>
        );
      })}
    </div>
  );
}

function ReplyBox({ data, meta, onDone }: { data: any; meta: any; onDone: () => void }) {
  const t = useT('helpdesk');
  const tk = data.ticket;
  const [mode, setMode] = useState<'reply' | 'note'>(tk.contact_id ? 'reply' : 'note');
  const [channel, setChannel] = useState(tk.channel || (data.contact?.email ? 'email' : 'sms'));
  const [body, setBody] = useState('');
  const [after, setAfter] = useState('');
  const [busy, setBusy] = useState(false);
  const canned = useLoad(() => api.get<any[]>('/api/helpdesk/canned'), []);
  const [kbQ, setKbQ] = useState('');
  useEffect(() => {
    const tm = setTimeout(() => setKbQ(`${tk.subject} ${body.slice(-300)}`), 500);
    return () => clearTimeout(tm);
  }, [body, tk.subject]);
  const kb = useLoad(() => (kbQ.trim() ? api.get<any[]>(`/api/kb/search?q=${encodeURIComponent(kbQ)}&limit=3`) : Promise.resolve([])), [kbQ]);
  const pipe = meta?.pipelines.find((p: any) => p.id === tk.pipeline_id);
  const send = async () => {
    setBusy(true);
    const r = await act(() => (mode === 'note' ? api.post(`/api/tickets/${tk.id}/notes`, { body }) : api.post(`/api/tickets/${tk.id}/reply`, { body, channel, status: after || undefined })));
    setBusy(false);
    if (!r) return;
    if (mode === 'reply' && r.message?.status === 'failed') toast(t('Nicht gesendet: {error}', { error: r.message.error }));
    else toast(mode === 'note' ? t('Notiz gespeichert') : r.message?.status === 'logged' ? t('Gespeichert (kein Versand-Anbieter eingerichtet)') : t('Gesendet'));
    setBody('');
    onDone();
  };
  return (
    <div className={`card reply-box ${mode}`} data-tour="ticket-reply">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Tabs tabs={[...(tk.contact_id ? ([['reply', t('Antworten')]] as [string, string][]) : []), ['note', t('Interne Notiz')]]} value={mode} onChange={(v) => setMode(v as any)} />
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {mode === 'reply' && (
            <div style={{ width: 130 }}>
              <Select value={channel} onChange={setChannel} options={CHANNELS.map(([k, l]) => [k, t(l)] as [string, string])} />
            </div>
          )}
          {(canned.data ?? []).length > 0 && (
            <div style={{ width: 170 }}>
              <Select
                value=""
                placeholder={t('Textbaustein…')}
                onChange={async (v) => {
                  if (!v) return;
                  const r = await act(() => api.post(`/api/helpdesk/canned/${v}/render`, { ticket_id: tk.id }));
                  if (r) setBody((b) => (b ? `${b}\n\n${r.body}` : r.body));
                }}
                options={(canned.data ?? []).map((c) => [c.id, c.shortcut ? `${c.name} (/${c.shortcut})` : c.name])}
              />
            </div>
          )}
        </div>
      </div>
      <Textarea value={body} onChange={setBody} rows={5} placeholder={mode === 'note' ? t('Nur für das Team sichtbar…') : t('Antwort an {name}…', { name: name(data.contact) })} />
      {mode === 'reply' && (kb.data ?? []).length > 0 && (
        <div className="kb-suggest">
          <span className="muted small">
            <Icon name="kb" size={12} /> {t('Passende Artikel:')}
          </span>
          {(kb.data ?? []).map((a) => (
            <button key={a.id} type="button" className="kb-chip" title={a.excerpt} onClick={() => setBody((b) => `${b}${b && !b.endsWith('\n') ? '\n\n' : ''}${a.title}: ${a.url}`)}>
              {a.title} {a.status !== 'published' && <span className="muted">{t('(Entwurf)')}</span>} +
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', marginTop: 8 }}>
        {mode === 'reply' && pipe && (
          <div style={{ width: 230 }}>
            <Select value={after} onChange={setAfter} placeholder={t('Status danach: wie bisher')} options={pipe.stages.filter((s: any) => s.id !== tk.stage_id).map((s: any) => [s.id, t('danach: {name}', { name: s.name })])} />
          </div>
        )}
        <button className="btn" disabled={!body.trim() || busy} onClick={send}>
          <Icon name={mode === 'note' ? 'note' : 'send'} size={14} /> {mode === 'note' ? t('Notiz speichern') : t('Senden')}
        </button>
      </div>
    </div>
  );
}

function MergeModal({ ticket, onClose, onDone }: { ticket: any; onClose: () => void; onDone: () => void }) {
  const t = useT('helpdesk');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const list = useLoad(() => api.get(`/api/tickets?state=all&limit=20${q ? `&q=${encodeURIComponent(q)}` : ticket.contact_id ? `&contact_id=${ticket.contact_id}` : ''}`), [q]);
  const others = (list.data?.tickets ?? []).filter((x: any) => x.id !== ticket.id && !x.merged_into);
  return (
    <Modal
      title={t('In #{number} zusammenführen', { number: ticket.number })}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!sel.length} onClick={async () => (await act(() => api.post(`/api/tickets/${ticket.id}/merge`, { ids: sel }), t('Zusammengeführt'))) && onDone()}>
          {sel.length} {t('zusammenführen')}
        </button>
      }
    >
      <p className="muted">{t('Verlauf, Tags und Kontakt der gewählten Tickets wandern in dieses Ticket; die anderen werden geschlossen.')}</p>
      <Input value={q} onChange={setQ} placeholder={t('Suchen (Betreff, Kontakt, #Nummer)…')} />
      <div style={{ marginTop: 10 }}>
        {others.map((x: any) => (
          <Check
            key={x.id}
            checked={sel.includes(x.id)}
            onChange={(v) => setSel(v ? [...sel, x.id] : sel.filter((s) => s !== x.id))}
            label={
              <span>
                #{x.number} {x.subject} <span className="muted small">· {x.contact_name || t('ohne Kontakt')} · {x.status}</span>
              </span>
            }
          />
        ))}
        {!others.length && <p className="muted">{t('Keine passenden Tickets.')}</p>}
      </div>
    </Modal>
  );
}

export function TicketDetail({ id }: { id: string }) {
  const t = useT('helpdesk');
  const meta = useTicketMeta();
  const { data, reload, error } = useLoad(() => api.get(`/api/tickets/${id}`), [id]);
  const [edit, setEdit] = useState<{ subject: string; description: string } | null>(null);
  const [merge, setMerge] = useState(false);
  const health = useLoad(() => (data?.ticket.contact_id ? api.get(`/api/health/scores?ids=${data.ticket.contact_id}`) : Promise.resolve({})), [data?.ticket.contact_id]);
  const m = meta.data;
  const patch = async (p: any) => (await act(() => api.patch(`/api/tickets/${id}`, p))) && reload();
  const stages = useMemo(() => m?.pipelines.find((p: any) => p.id === data?.ticket.pipeline_id)?.stages ?? [], [m, data?.ticket.pipeline_id]);
  if (error) return <Empty action={<Link to="tickets">{t('Zur Ticketliste')}</Link>}>{error}</Empty>;
  if (!data || !m) return <Spinner />;
  const tk = data.ticket;
  const done = tk.status_kind === 'resolved' || tk.status_kind === 'closed';
  return (
    <>
      <div className="crumb-line">
        <Link to="tickets">{t('← Tickets')}</Link>
      </div>
      <PageHead
        title={`#${tk.number} ${tk.subject}`}
        sub={
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <StatusBadge t={tk} /> <PriorityBadge p={tk.priority} /> <SlaChip t={tk} /> <span className="muted small">{t('angelegt')} {dt(tk.created_at)} · {tk.source}</span>
          </span>
        }
      >
        <CanvasPin kind="ticket" id={tk.id} name={`#${tk.number} ${tk.subject}`} />
        <button className="btn secondary" onClick={() => setEdit({ subject: tk.subject, description: tk.description })}>
          <Icon name="edit" size={14} /> {t('Bearbeiten')}
        </button>
        <button className="btn secondary" data-tour="ticket-merge" onClick={() => setMerge(true)}>
          <Icon name="merge" size={14} /> {t('Zusammenführen')}
        </button>
        {!done && (
          <button className="btn" data-tour="ticket-resolve" onClick={() => patch({ status: 'resolved' })}>
            <Icon name="ok" size={14} /> {t('Als gelöst markieren')}
          </button>
        )}
      </PageHead>
      {data.merged_into && (
        <div className="card notice-card">
          {t('Zusammengeführt in')} <Link to={`tickets/${data.merged_into.id}`}>#{data.merged_into.number} {data.merged_into.subject}</Link>
        </div>
      )}
      <div className="ticket-layout">
        <div className="ticket-main">
          <BugTriagePanel ticketId={tk.id} onChanged={reload} />
          <div className="card" data-tour="ticket-timeline">
            <Timeline data={data} meta={m} />
          </div>
          {!data.merged_into && <ReplyBox data={data} meta={m} onDone={reload} />}
        </div>
        <aside className="ticket-side">
          <div className="card" data-tour="ticket-props">
            <h2>{t('Eigenschaften')}</h2>
            <Field label="Status">
              <Select value={tk.stage_id} onChange={(v) => patch({ status: v })} options={stages.map((s: any) => [s.id, s.name])} />
            </Field>
            <div className="grid2">
              <Field label={t('Priorität')}>
                <Select value={tk.priority} onChange={(v) => patch({ priority: v })} options={m.priorities.map(([k, l]: [string, string]) => [k, t(l)] as [string, string])} />
              </Field>
              <Field label={t('Kategorie')}>
                <Select value={tk.category} onChange={(v) => patch({ category: v })} placeholder="–" options={[...new Set([...m.categories, ...(tk.category ? [tk.category] : [])])]} />
              </Field>
            </div>
            <Field label={t('Zuständig')}>
              <Select value={tk.owner_id} onChange={(v) => patch({ owner_id: v })} placeholder={t('– niemand –')} options={[...m.agents.map((a: any) => [a.id, a.name]), ...(tk.team_id ? [['round_robin', t('↻ Nächste/r im Team')]] : [])] as [string, string][]} />
            </Field>
            {m.teams.length > 0 && (
              <Field label={t('Team / Queue')}>
                <Select value={tk.team_id} onChange={(v) => patch({ team_id: v })} placeholder={t('– kein Team –')} options={m.teams.map((x: any) => [x.id, x.name])} />
              </Field>
            )}
            <Field label="Tags">
              <TagInput value={tk.tags} onChange={(v) => patch({ tags: v })} />
            </Field>
            <Field label={t('Fällig am')}>
              <Input type="date" value={tk.due_at?.slice(0, 10)} onChange={(v) => patch({ due_at: v || null })} />
            </Field>
            {m.pipelines.length > 1 && (
              <Field label="Pipeline">
                <Select value={tk.pipeline_id} onChange={(v) => patch({ pipeline_id: v })} options={m.pipelines.map((p: any) => [p.id, p.name])} />
              </Field>
            )}
          </div>
          <div className="card">
            <h2>{t('Kontakt')}</h2>
            {data.contact ? (
              <>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Link to={`contacts/${data.contact.id}`}>
                    <strong>{name(data.contact)}</strong>
                  </Link>
                  {(health.data as any)?.[data.contact.id] && <HealthBadge {...(health.data as any)[data.contact.id]} />}
                </div>
                <div className="muted small">{[data.contact.email, data.contact.phone, data.contact.company].filter(Boolean).join(' · ')}</div>
                {tk.conversation_id && (
                  <p style={{ margin: '8px 0 0' }}>
                    <Link to={`conversations/${tk.conversation_id}`}>
                      <Icon name="conversations" size={13} /> {t('Konversation öffnen')}
                    </Link>
                  </p>
                )}
              </>
            ) : (
              <ContactPicker value="" onChange={(cid) => cid && patch({ contact_id: cid })} />
            )}
          </div>
          <div className="card" data-tour="ticket-sla">
            <h2>{t('SLA')}</h2>
            <div className="sla-rows">
              <div>
                <span className="muted small">{t('Erste Antwort')}</span>
                <div>{tk.first_response_at ? `${dt(tk.first_response_at)} ${tk.sla.first === 'met' ? '✓' : t('(verspätet)')}` : tk.first_response_due_at ? t('fällig {date}', { date: dt(tk.first_response_due_at) }) : '–'}</div>
              </div>
              <div>
                <span className="muted small">{t('Lösung')}</span>
                <div>{tk.resolved_at ? `${dt(tk.resolved_at)} ${tk.sla.resolution === 'met' ? '✓' : t('(verspätet)')}` : tk.sla.resolution === 'paused' ? t('pausiert (wartet auf Kunde)') : tk.resolution_due_at ? t('fällig {date}', { date: dt(tk.resolution_due_at) }) : '–'}</div>
              </div>
            </div>
          </div>
          <div className="card" data-tour="ticket-csat">
            <h2>{t('Zufriedenheit')}</h2>
            {tk.csat_score ? (
              <p style={{ margin: 0 }}>
                <span style={{ fontSize: 24 }}>{FACES[tk.csat_score - 1]}</span> <strong>{tk.csat_score}/5</strong>
                {tk.csat_comment && <span className="muted"> – „{tk.csat_comment}“</span>}
              </p>
            ) : tk.csat_sent_at ? (
              <p className="muted" style={{ margin: 0 }}>{t('Umfrage gesendet')} {dt(tk.csat_sent_at)} {t('– noch keine Antwort.')}</p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>{t('Wird nach dem Lösen automatisch gesendet.')}</p>
            )}
            {done && tk.contact_id && !tk.csat_score && (
              <button className="btn small secondary" style={{ marginTop: 8 }} onClick={() => act(() => api.post(`/api/surveys/csat/${tk.id}/send`), t('Umfrage gesendet')).then(reload)}>
                {tk.csat_sent_at ? t('Umfrage erneut senden') : t('Umfrage senden')}
              </button>
            )}
          </div>
          {data.others.length > 0 && (
            <div className="card">
              <h2>{t('Weitere Tickets des Kontakts')}</h2>
              {data.others.map((o: any) => (
                <div key={o.id} style={{ marginBottom: 6 }}>
                  <Link to={`tickets/${o.id}`}>
                    #{o.number} {o.subject}
                  </Link>{' '}
                  <span className="muted small">{['resolved', 'closed'].includes(o.status_kind) ? t('erledigt') : t('offen')}</span>
                </div>
              ))}
            </div>
          )}
          <button className="btn small danger" onClick={async () => confirmAsk(t('Ticket #{number} endgültig löschen?', { number: tk.number })) && (await act(() => api.del(`/api/tickets/${tk.id}`))) && navigate('tickets')}>
            {t('Ticket löschen')}
          </button>
        </aside>
      </div>
      {edit && (
        <Modal
          title={t('Ticket bearbeiten')}
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn"
              onClick={async () => {
                if (await act(() => api.patch(`/api/tickets/${id}`, edit), t('Gespeichert'))) (setEdit(null), reload());
              }}
            >
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Betreff')}>
            <Input value={edit.subject} onChange={(v) => setEdit({ ...edit, subject: v })} />
          </Field>
          <Field label={t('Beschreibung')}>
            <Textarea value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} rows={6} />
          </Field>
        </Modal>
      )}
      {merge && <MergeModal ticket={tk} onClose={() => setMerge(false)} onDone={() => (setMerge(false), reload())} />}
    </>
  );
}

// --- entry points for other pages -----------------------------------------------------------------

/** "Ticket erstellen" in Konversationen (links the thread). */
export function TicketFromConversation({ conversationId, contact }: { conversationId: string; contact: any }) {
  // The button in the inbox is translated with it (inbox catalog); the ticket dialog is German in phase 1.
  const t = useT('inbox');
  const [open, setOpen] = useState(false);
  const existing = useLoad(() => api.get(`/api/tickets?contact_id=${contact.id}&limit=3`).catch(() => null), [contact.id]);
  const first = existing.data?.tickets?.[0];
  return (
    <>
      {first ? (
        <Link to={`tickets/${first.id}`} className="btn small secondary">
          <Icon name="ticket" size={14} /> {t('Ticket #{n}', { n: first.number })}
        </Link>
      ) : (
        <button className="btn small secondary" onClick={() => setOpen(true)}>
          <Icon name="ticket" size={14} /> {t('Ticket erstellen')}
        </button>
      )}
      {open && <NewTicket initial={{ conversation_id: conversationId }} onClose={() => setOpen(false)} onSaved={(t) => navigate(`tickets/${t.id}`)} />}
    </>
  );
}

/** From a call in "Anrufe". */
export function TicketFromCall({ call }: { call: any }) {
  const t = useT('helpdesk');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn" title={t('Ticket aus diesem Anruf')} aria-label={t('Ticket aus diesem Anruf')} onClick={() => setOpen(true)}>
        <Icon name="ticket" size={14} />
      </button>
      {open && <NewTicket initial={{ call_id: call.id, priority: call.missed ? 'hoch' : 'normal' }} onClose={() => setOpen(false)} onSaved={(tk) => navigate(`tickets/${tk.id}`)} />}
    </>
  );
}
