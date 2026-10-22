import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Field, Modal, Textarea, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { useSession, can } from '../session';
import { LinkPicker, prioLabel, centsToEuros, dayOf, eurosToCents, usePmMeta, type FieldDef, type Meta, type Person, type ProjectDetail, type Section, type Status } from './PmKit';
import { useT } from '../i18n';

/** Project settings: master data, statuses, sections, custom fields, automations, templates, rates, portal sharing. */

const COLORS = ['#94a3b8', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#059669', '#0891b2', '#dc2626', '#475569'];
// German labels (message ids of the pm catalog), shown through t()
const CATEGORY: Record<string, string> = { todo: 'Zu erledigen', active: 'In Arbeit', done: 'Erledigt' };

export function PmSettings({ project, reload }: { project: ProjectDetail; reload: () => Promise<unknown> }) {
  const t = useT('pm');
  const meta = usePmMeta();
  const session = useSession();
  if (!meta) return <div className="pm-loading">{t('Lädt…')}</div>;
  return (
    <div className="pm-settings" data-tour="pm-settings">
      <General project={project} meta={meta} reload={reload} />
      <Statuses project={project} reload={reload} />
      <Sections project={project} reload={reload} />
      <Fields project={project} reload={reload} />
      <Automations project={project} meta={meta} />
      <Templates project={project} />
      {can(session, 'payments') && <Rates project={project} meta={meta} />}
      <Danger project={project} />
    </div>
  );
}

function Card({ title, hint, children, tour }: { title: string; hint?: string; children: React.ReactNode; tour?: string }) {
  return (
    <section className="card pm-card-sec" data-tour={tour}>
      <h2>{title}</h2>
      {hint && <p className="muted small">{hint}</p>}
      {children}
    </section>
  );
}

// --- general --------------------------------------------------------------------------------------------------

function General({ project, meta, reload }: { project: ProjectDetail; meta: Meta; reload: () => Promise<unknown> }) {
  const t = useT('pm');
  const tz = meta.timezone;
  const init = () => ({
    name: project.name,
    description: project.description,
    color: project.color,
    status: project.status,
    owner_id: project.owner_id ?? '',
    start: dayOf(project.start_at, tz) ?? '',
    due: dayOf(project.due_at, tz) ?? '',
    skip_weekends: project.skip_weekends,
    billable: project.billable,
    rate: centsToEuros(project.hourly_rate_cents),
    portal: project.portal_visible,
    contact: project.contact_id ? { id: project.contact_id, name: project.contact_name } : null,
    company: project.company_id ? { id: project.company_id, name: project.company_name } : null,
    deal: project.opportunity_id ? { id: project.opportunity_id, name: project.opportunity_name } : null,
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [project.id, project.name, project.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<ReturnType<typeof init>>) => setF({ ...f, ...patch });
  const linked = !!(f.contact || f.company || f.deal);
  return (
    <Card title={t('Allgemein')} tour="pm-set-general">
      <div className="grid2">
        <Field label="Name">
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('Verantwortlich')}>
          <select value={f.owner_id} onChange={(e) => set({ owner_id: e.target.value })}>
            <option value="">{t('Niemand')}</option>
            {meta.team.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t('Beschreibung')}>
        <Textarea value={f.description} onChange={(v) => set({ description: v })} />
      </Field>
      <div className="grid3">
        <Field label={t('Farbe')}>
          <div className="pm-colors" role="radiogroup" aria-label={t('Projektfarbe')}>
            {COLORS.map((c) => (
              <button type="button" key={c} role="radio" aria-checked={f.color === c} aria-label={c} className={f.color === c ? 'on' : ''} style={{ background: c }} onClick={() => set({ color: c })} />
            ))}
          </div>
        </Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => set({ status: e.target.value as ProjectDetail['status'] })}>
            <option value="active">{t('Aktiv')}</option>
            <option value="paused">{t('Pausiert')}</option>
            <option value="done">{t('Abgeschlossen')}</option>
            {!project.is_default && <option value="archived">{t('Archiviert')}</option>}
          </select>
        </Field>
        <Field label={t('Stundensatz (€)')} hint={t('Gilt für Zeiten dieses Projekts, wenn keine Person einen eigenen Satz hat')}>
          <input value={f.rate} inputMode="decimal" placeholder={t('z. B. 95')} onChange={(e) => set({ rate: e.target.value })} />
        </Field>
      </div>
      <div className="grid2">
        <Field label={t('Start')}>
          <input type="date" value={f.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label={t('Ziel-Termin')}>
          <input type="date" value={f.due} min={f.start || undefined} onChange={(e) => set({ due: e.target.value })} />
        </Field>
      </div>
      <h3 className="pm-h3">{t('Kunde')}</h3>
      <p className="muted small">{t('Das Projekt gehört zu einem Kontakt, einer Firma oder einem Deal – so erscheint es bei ihnen und im Kundenportal.')}</p>
      <div className="grid3">
        <Field label={t('Kontakt')}>
          <LinkPicker type="contact" label={t('Kontakt')} value={f.contact} onChange={(v) => set({ contact: v })} />
        </Field>
        <Field label={t('Firma')}>
          <LinkPicker type="company" label={t('Firma')} value={f.company} onChange={(v) => set({ company: v })} />
        </Field>
        <Field label={t('Deal')}>
          <LinkPicker type="opportunity" label={t('Deal')} value={f.deal} onChange={(v) => set({ deal: v })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.skip_weekends} onChange={(e) => set({ skip_weekends: e.target.checked })} /> {t('Nur Werktage planen (Wochenenden zählen nicht beim Verschieben und im Gantt)')}
      </label>
      <label className="check">
        <input type="checkbox" checked={f.billable} onChange={(e) => set({ billable: e.target.checked })} /> {t('Zeiten dieses Projekts sind standardmäßig abrechenbar')}
      </label>
      <label className="check" data-tour="pm-portal-toggle">
        <input type="checkbox" checked={f.portal} onChange={(e) => set({ portal: e.target.checked })} /> {t('Im Kundenportal freigeben (nur lesen: Board, Fortschritt, Meilensteine)')}
      </label>
      {f.portal && (
        <p className={`pm-note${linked ? '' : ' warn'}`} role="status">
          {linked ? t('Der verknüpfte Kunde sieht dieses Projekt im Mitgliederbereich unter „Meine Projekte“. Interne Aufgaben (in der Aufgabe als „Nur intern“ markiert), Kommentare, Zeiten und Stundensätze bleiben verborgen.') : t('Niemand sieht das Projekt, solange kein Kontakt, keine Firma und kein Deal verknüpft ist.')}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!f.name.trim()}
          onClick={async () => {
            const cents = f.rate.trim() ? eurosToCents(f.rate) : null;
            if (f.rate.trim() && cents === null) return toast(t('Stundensatz bitte als Zahl angeben'));
            const r = await act(
              () =>
                api.patch(`/api/pm/projects/${project.id}`, {
                  name: f.name.trim(),
                  description: f.description,
                  color: f.color,
                  status: f.status,
                  owner_id: f.owner_id || null,
                  start_at: f.start || null,
                  due_at: f.due || null,
                  skip_weekends: f.skip_weekends,
                  billable: f.billable,
                  hourly_rate_cents: cents,
                  portal_visible: f.portal,
                  contact_id: f.contact?.id ?? null,
                  company_id: f.company?.id ?? null,
                  opportunity_id: f.deal?.id ?? null,
                }),
              t('Gespeichert'),
            );
            if (r) await reload();
          }}
        >
          {t('Speichern')}
        </button>
      </div>
    </Card>
  );
}

// --- statuses -------------------------------------------------------------------------------------------------

function Statuses({ project, reload }: { project: ProjectDetail; reload: () => Promise<unknown> }) {
  const t = useT('pm');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('active');
  const [color, setColor] = useState('#2563eb');
  const [del, setDel] = useState<{ s: Status; to: string } | null>(null);
  const list = project.statuses;
  const done = async (r: unknown) => r && (await reload());
  const swap = async (i: number, d: number) => {
    const ids = list.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await done(await act(() => api.put(`/api/pm/projects/${project.id}/statuses/order`, { ids })));
  };
  return (
    <Card title="Status" hint={t('Jedes Projekt hat eigene Status – die Spalten im Board. Die Kategorie sagt, ob eine Aufgabe als offen, in Arbeit oder erledigt zählt.')} tour="pm-set-statuses">
      {list.map((s, i) => (
        <div key={s.id} className="pm-set-row">
          <input type="color" value={s.color} aria-label={t('Farbe von {name}', { name: s.name })} onChange={async (e) => done(await act(() => api.patch(`/api/pm/statuses/${s.id}`, { color: e.target.value })))} />
          <NameInput value={s.name} label={t('Name des Status')} onSave={async (v) => done(await act(() => api.patch(`/api/pm/statuses/${s.id}`, { name: v })))} />
          <select value={s.category} aria-label={t('Kategorie von {name}', { name: s.name })} onChange={async (e) => done(await act(() => api.patch(`/api/pm/statuses/${s.id}`, { category: e.target.value })))}>
            {Object.entries(CATEGORY).map(([k, l]) => (
              <option key={k} value={k}>
                {t(l)}
              </option>
            ))}
          </select>
          <button type="button" className="icon-btn" disabled={i === 0} aria-label={t('Nach oben')} onClick={() => swap(i, -1)}>
            ↑
          </button>
          <button type="button" className="icon-btn" disabled={i === list.length - 1} aria-label={t('Nach unten')} onClick={() => swap(i, 1)}>
            ↓
          </button>
          <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: s.name })} onClick={() => setDel({ s, to: list.find((x) => x.id !== s.id)?.id ?? '' })}>
            ✕
          </button>
        </div>
      ))}
      <div className="pm-set-row add">
        <input type="color" value={color} aria-label={t('Farbe')} onChange={(e) => setColor(e.target.value)} />
        <input value={name} placeholder={t('Neuer Status, z. B. „Wartet auf Kunde“')} aria-label={t('Name des neuen Status')} onChange={(e) => setName(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('Kategorie')}>
          {Object.entries(CATEGORY).map(([k, l]) => (
            <option key={k} value={k}>
              {t(l)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn small"
          disabled={!name.trim()}
          onClick={async () => {
            const r = await act(() => api.post(`/api/pm/projects/${project.id}/statuses`, { name: name.trim(), category, color }));
            if (r) (setName(''), await reload());
          }}
        >
          {t('Hinzufügen')}
        </button>
      </div>
      {del && (
        <Modal title={t('Status „{name}“ löschen', { name: del.s.name })} onClose={() => setDel(null)}>
          <p>{t('Aufgaben in diesem Status wandern in den Status:')}</p>
          <select value={del.to} onChange={(e) => setDel({ ...del, to: e.target.value })} aria-label={t('Zielstatus')}>
            {list
              .filter((x) => x.id !== del.s.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
          <div className="actions" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                const r = await act(() => api.del(`/api/pm/statuses/${del.s.id}?move_to=${del.to}`), t('Status gelöscht'));
                if (r) (setDel(null), await reload());
              }}
            >
              {t('Löschen')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setDel(null)}>
              {t('Abbrechen')}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function NameInput({ value, onSave, label }: { value: string; onSave: (v: string) => void; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== value && onSave(v.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />;
}

// --- sections -------------------------------------------------------------------------------------------------

function Sections({ project, reload }: { project: ProjectDetail; reload: () => Promise<unknown> }) {
  const t = useT('pm');
  const [name, setName] = useState('');
  const list: Section[] = project.sections;
  const done = async (r: unknown) => r && (await reload());
  const swap = async (i: number, d: number) => {
    const ids = list.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await done(await act(() => api.put(`/api/pm/projects/${project.id}/sections/order`, { ids })));
  };
  return (
    <Card title={t('Abschnitte')} hint={t('Abschnitte gliedern die Liste und das Gantt-Diagramm, z. B. nach Phasen: Konzept, Umsetzung, Abnahme.')} tour="pm-set-sections">
      {list.map((s, i) => (
        <div key={s.id} className="pm-set-row">
          <NameInput value={s.name} label={t('Name des Abschnitts')} onSave={async (v) => done(await act(() => api.patch(`/api/pm/sections/${s.id}`, { name: v })))} />
          <button type="button" className="icon-btn" disabled={i === 0} aria-label={t('Nach oben')} onClick={() => swap(i, -1)}>
            ↑
          </button>
          <button type="button" className="icon-btn" disabled={i === list.length - 1} aria-label={t('Nach unten')} onClick={() => swap(i, 1)}>
            ↓
          </button>
          <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: s.name })} onClick={async () => confirmAsk(t('Abschnitt „{name}“ löschen? Die Aufgaben bleiben erhalten.', { name: s.name })) && done(await act(() => api.del(`/api/pm/sections/${s.id}`), t('Abschnitt gelöscht')))}>
            ✕
          </button>
        </div>
      ))}
      <div className="pm-set-row add">
        <input value={name} placeholder={t('Neuer Abschnitt')} aria-label={t('Name des neuen Abschnitts')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && (document.getElementById('pm-add-section') as HTMLButtonElement | null)?.click()} />
        <button
          id="pm-add-section"
          type="button"
          className="btn small"
          disabled={!name.trim()}
          onClick={async () => {
            const r = await act(() => api.post(`/api/pm/projects/${project.id}/sections`, { name: name.trim() }));
            if (r) (setName(''), await reload());
          }}
        >
          {t('Hinzufügen')}
        </button>
      </div>
    </Card>
  );
}

// --- custom fields --------------------------------------------------------------------------------------------

function Fields({ project, reload }: { project: ProjectDetail; reload: () => Promise<unknown> }) {
  const t = useT('pm');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldDef['type']>('text');
  const [options, setOptions] = useState('');
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const done = async (r: unknown) => r && (await reload());
  return (
    <Card title={t('Eigene Felder')} hint={t('Zusätzliche Angaben an jeder Aufgabe, z. B. „Kundenfreigabe“ (Häkchen) oder „Budget“ (Zahl).')} tour="pm-set-fields">
      {project.fields.map((f) => (
        <div key={f.id} className="pm-set-row">
          <strong className="grow">{f.label}</strong>
          <span className="muted small">
            {{ text: t('Text'), number: t('Zahl'), date: t('Datum'), select: t('Auswahl: {options}', { options: f.options.join(', ') }), checkbox: t('Häkchen'), url: t('Link') }[f.type]} · {f.project_id ? t('nur dieses Projekt') : t('alle Projekte')}
          </span>
          <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: f.label })} onClick={async () => confirmAsk(t('Feld „{name}“ samt Werten löschen?', { name: f.label })) && done(await act(() => api.del(`/api/pm/custom-fields/${f.id}`), t('Feld gelöscht')))}>
            ✕
          </button>
        </div>
      ))}
      <div className="pm-set-row add wrap">
        <input value={label} placeholder={t('Name des Felds')} aria-label={t('Name des Felds')} onChange={(e) => setLabel(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value as FieldDef['type'])} aria-label={t('Art des Felds')}>
          <option value="text">{t('Text')}</option>
          <option value="number">{t('Zahl')}</option>
          <option value="date">{t('Datum')}</option>
          <option value="select">{t('Auswahl')}</option>
          <option value="checkbox">{t('Häkchen')}</option>
          <option value="url">{t('Link')}</option>
        </select>
        {type === 'select' && <input value={options} placeholder={t('Optionen, mit Komma getrennt')} aria-label={t('Optionen')} onChange={(e) => setOptions(e.target.value)} />}
        <select value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'all')} aria-label={t('Gilt für')}>
          <option value="project">{t('Nur dieses Projekt')}</option>
          <option value="all">{t('Alle Projekte')}</option>
        </select>
        <button
          type="button"
          className="btn small"
          disabled={!label.trim()}
          onClick={async () => {
            const r = await act(() => api.post('/api/pm/custom-fields', { label: label.trim(), type, options: options.split(',').map((x) => x.trim()).filter(Boolean), project_id: scope === 'project' ? project.id : undefined }));
            if (r) (setLabel(''), setOptions(''), await reload());
          }}
        >
          {t('Hinzufügen')}
        </button>
      </div>
    </Card>
  );
}

// --- automations ----------------------------------------------------------------------------------------------

interface Rule {
  id: string;
  project_id: string | null;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: Record<string, any>;
  actions: Record<string, any>[];
  runs: number;
  last_run_at: string | null;
  last_error: string | null;
}
interface TaskTemplate {
  id: string;
  name: string;
  data: { title: string; due_in_days?: number; subtasks?: unknown[] };
}

function Automations({ project, meta }: { project: ProjectDetail; meta: Meta }) {
  const t = useT('pm');
  const rules = useLoad(() => api.get<Rule[]>(`/api/pm/automations?project_id=${project.id}`), [project.id]);
  const templates = useLoad(() => api.get<{ tasks: TaskTemplate[] }>('/api/pm/templates'), []);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const status = (id?: string) => project.statuses.find((s) => s.id === id)?.name ?? '?';
  const person = (id: string) => (id === 'creator' ? t('den Ersteller') : meta.team.find((p) => p.id === id)?.name ?? '?');
  const sentence = (r: Rule) => {
    const c = r.conditions;
    const cond = [
      c.to_category && t('neuer Status ist „{status}“', { status: t(CATEGORY[c.to_category] ?? '') }),
      c.status_id && t('Status „{status}“', { status: status(c.status_id) }),
      c.tag && t('Tag „{tag}“', { tag: c.tag }),
      c.priority_min !== undefined && t('Priorität ab „{priority}“', { priority: prioLabel(c.priority_min) }),
      c.assignee && t('zugewiesen an {person}', { person: person(c.assignee) }),
      c.title_contains && t('Titel enthält „{text}“', { text: c.title_contains }),
    ].filter(Boolean);
    const acts = r.actions.map((a) => {
      switch (a.type) {
        case 'create_task':
          return t('Aufgabe „{name}“ anlegen', { name: a.template_id ? (templates.data?.tasks.find((tpl) => tpl.id === a.template_id)?.name ?? t('Vorlage')) : a.title });
        case 'move_status':
          return t('Status auf „{status}“ setzen', { status: a.status_id ? status(a.status_id) : (a.status ?? t(CATEGORY[a.category] ?? '')) });
        case 'assign':
          return a.mode === 'set' ? t('{person} zuweisen', { person: person(a.user_id) }) : t('{person} hinzufügen', { person: person(a.user_id) });
        case 'set_priority':
          return t('Priorität „{priority}“', { priority: prioLabel(a.priority) });
        case 'add_tag':
          return t('Tag „{tag}“ hinzufügen', { tag: a.tag });
        default:
          return t('benachrichtigen');
      }
    });
    const trigger = meta.automation.triggers[r.trigger];
    return t('Wenn {trigger}{conditions}: {actions}', { trigger: trigger ? t(trigger).toLowerCase() : r.trigger, conditions: cond.length ? ` (${cond.join(', ')})` : '', actions: acts.join(' → ') });
  };
  return (
    <Card title={t('Automationen')} hint={t('Wenn etwas an einer Aufgabe passiert, erledigt die Planung den nächsten Schritt von selbst.')} tour="pm-set-automations">
      {(rules.data ?? []).map((r) => (
        <div key={r.id} className="pm-rule">
          <label className="check">
            <input
              type="checkbox"
              checked={r.enabled}
              aria-label={t('{name} aktiv', { name: r.name })}
              onChange={async (e) => {
                if (await act(() => api.patch(`/api/pm/automations/${r.id}`, { enabled: e.target.checked }))) await rules.reload();
              }}
            />
          </label>
          <div className="grow">
            <strong>{r.name}</strong> {!r.project_id && <span className="badge gray">{t('alle Projekte')}</span>}
            <div className="muted small">{sentence(r)}</div>
            <div className="muted small">
              {r.runs}{t('× ausgeführt')}{r.last_error ? '' : ''}
              {r.last_error && <span className="pm-bad"> {t('· letzter Fehler:')} {r.last_error}</span>}
            </div>
          </div>
          <button type="button" className="btn small secondary" onClick={() => setEditing(r)}>
            {t('Bearbeiten')}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('{name} löschen', { name: r.name })}
            onClick={async () => {
              if (confirmAsk(t('Automation „{name}“ löschen?', { name: r.name })) && (await act(() => api.del(`/api/pm/automations/${r.id}`), t('Gelöscht')))) await rules.reload();
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {!rules.data?.length && <p className="muted small">{t('Noch keine Automationen. Beispiel: „Wenn eine Aufgabe erledigt ist → Folgeaufgabe ‚Rechnung schreiben‘ anlegen“.')}</p>}
      <div className="actions">
        <button type="button" className="btn small" onClick={() => setEditing({ name: '', trigger: 'task.completed', conditions: {}, actions: [{ type: 'move_status', category: 'done' }], project_id: project.id })}>
          {t('+ Neue Automation')}
        </button>
      </div>
      {editing && (
        <RuleEditor
          rule={editing}
          project={project}
          meta={meta}
          templates={templates.data?.tasks ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), void rules.reload())}
        />
      )}
    </Card>
  );
}

function RuleEditor({ rule, project, meta, templates, onClose, onSaved }: { rule: Partial<Rule>; project: ProjectDetail; meta: Meta; templates: TaskTemplate[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('pm');
  const [r, setR] = useState<Partial<Rule>>(rule);
  const cond = r.conditions ?? {};
  const actions = r.actions ?? [];
  const setCond = (patch: Record<string, unknown>) => {
    const next: Record<string, any> = { ...cond, ...patch };
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined) delete next[k];
    setR({ ...r, conditions: next });
  };
  const setAction = (i: number, patch: Record<string, unknown>) => setR({ ...r, actions: actions.map((a, k) => (k === i ? { ...a, ...patch } : a)) });
  const newAction = (type: string): Record<string, any> => ({ create_task: { type, title: '' }, move_status: { type, category: 'done' }, assign: { type, mode: 'add', user_id: meta.team[0]?.id ?? '' }, set_priority: { type, priority: 3 }, add_tag: { type, tag: '' }, notify: { type, who: 'assignees', message: '' } })[type] ?? { type };
  const team: Person[] = meta.team;
  return (
    <Modal title={r.id ? t('Automation bearbeiten') : t('Neue Automation')} onClose={onClose} wide>
      <Field label="Name">
        <input value={r.name ?? ''} placeholder={t('z. B. Nach Erledigung abrechnen')} onChange={(e) => setR({ ...r, name: e.target.value })} />
      </Field>
      <div className="grid2">
        <Field label={t('Wenn …')}>
          <select value={r.trigger} onChange={(e) => setR({ ...r, trigger: e.target.value })}>
            {Object.entries(meta.automation.triggers).map(([k, l]) => (
              <option key={k} value={k}>
                {t(l)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Gilt für')}>
          <select value={r.project_id ?? ''} onChange={(e) => setR({ ...r, project_id: e.target.value || null })}>
            <option value={project.id}>{t('Dieses Projekt')}</option>
            <option value="">{t('Alle Projekte')}</option>
          </select>
        </Field>
      </div>
      <h3 className="pm-h3">{t('Nur wenn (optional)')}</h3>
      <div className="grid3">
        <Field label={t('Neuer Status')}>
          <select value={cond.status_id ?? ''} onChange={(e) => setCond({ status_id: e.target.value })}>
            <option value="">{t('egal')}</option>
            {project.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Kategorie')}>
          <select value={cond.to_category ?? ''} onChange={(e) => setCond({ to_category: e.target.value })}>
            <option value="">{t('egal')}</option>
            {Object.entries(CATEGORY).map(([k, l]) => (
              <option key={k} value={k}>
                {t(l)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tag">
          <input value={cond.tag ?? ''} onChange={(e) => setCond({ tag: e.target.value })} />
        </Field>
        <Field label={t('Priorität mindestens')}>
          <select value={cond.priority_min ?? ''} onChange={(e) => setCond({ priority_min: e.target.value === '' ? '' : Number(e.target.value) })}>
            <option value="">{t('egal')}</option>
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                {prioLabel(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Zugewiesen an')}>
          <select value={cond.assignee ?? ''} onChange={(e) => setCond({ assignee: e.target.value })}>
            <option value="">{t('egal')}</option>
            {team.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Titel enthält')}>
          <input value={cond.title_contains ?? ''} onChange={(e) => setCond({ title_contains: e.target.value })} />
        </Field>
      </div>
      <h3 className="pm-h3">{t('Dann …')}</h3>
      {actions.map((a, i) => (
        <div key={i} className="pm-action">
          <div className="pm-action-head">
            <select value={a.type} aria-label={t('Aktion {n}', { n: i + 1 })} onChange={(e) => setR({ ...r, actions: actions.map((x, k) => (k === i ? newAction(e.target.value) : x)) })}>
              {Object.entries(meta.automation.actions).map(([k, l]) => (
                <option key={k} value={k}>
                  {t(l)}
                </option>
              ))}
            </select>
            <button type="button" className="icon-btn" aria-label={t('Aktion entfernen')} disabled={actions.length < 2} onClick={() => setR({ ...r, actions: actions.filter((_, k) => k !== i) })}>
              ✕
            </button>
          </div>
          {a.type === 'create_task' && (
            <div className="grid2">
              <Field label={t('Vorlage')}>
                <select value={a.template_id ?? ''} onChange={(e) => setAction(i, { template_id: e.target.value || undefined })}>
                  <option value="">{t('Eigene Aufgabe …')}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
              </Field>
              {!a.template_id && (
                <Field label={t('Titel')} hint={t('{{title}} = Titel der auslösenden Aufgabe')}>
                  <input value={a.title ?? ''} onChange={(e) => setAction(i, { title: e.target.value })} />
                </Field>
              )}
              <Field label={t('Fällig in (Tagen)')}>
                <input type="number" min={0} value={a.due_in_days ?? ''} onChange={(e) => setAction(i, { due_in_days: e.target.value === '' ? undefined : Number(e.target.value) })} />
              </Field>
              <Field label={t('Zuweisen an')}>
                <select value={a.assignee ?? ''} onChange={(e) => setAction(i, { assignee: e.target.value || undefined })}>
                  <option value="">{t('Niemand')}</option>
                  <option value="same">{t('Dieselben wie die auslösende Aufgabe')}</option>
                  <option value="creator">{t('Ersteller der Aufgabe')}</option>
                  {team.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {a.type === 'move_status' && (
            <Field label="Status">
              <select
                value={a.status_id ?? (a.category ? `cat:${a.category}` : '')}
                onChange={(e) => setAction(i, e.target.value.startsWith('cat:') ? { status_id: undefined, category: e.target.value.slice(4) } : { category: undefined, status_id: e.target.value })}
              >
                {Object.entries(CATEGORY).map(([k, l]) => (
                  <option key={k} value={`cat:${k}`}>
                    {t('Irgendein Status „{status}“', { status: t(l) })}
                  </option>
                ))}
                {project.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {a.type === 'assign' && (
            <div className="grid2">
              <Field label={t('Person')}>
                <select value={a.user_id} onChange={(e) => setAction(i, { user_id: e.target.value })}>
                  <option value="creator">{t('Ersteller der Aufgabe')}</option>
                  {team.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Wie')}>
                <select value={a.mode} onChange={(e) => setAction(i, { mode: e.target.value })}>
                  <option value="add">{t('Zusätzlich zuweisen')}</option>
                  <option value="set">{t('Als einzige Person zuweisen')}</option>
                </select>
              </Field>
            </div>
          )}
          {a.type === 'set_priority' && (
            <Field label={t('Priorität')}>
              <select value={a.priority} onChange={(e) => setAction(i, { priority: Number(e.target.value) })}>
                {[4, 3, 2, 1, 0].map((p) => (
                  <option key={p} value={p}>
                    {prioLabel(p)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {a.type === 'add_tag' && (
            <Field label="Tag">
              <input value={a.tag ?? ''} onChange={(e) => setAction(i, { tag: e.target.value })} />
            </Field>
          )}
          {a.type === 'notify' && (
            <div className="grid2">
              <Field label={t('Wer')}>
                <select value={a.who} onChange={(e) => setAction(i, { who: e.target.value })}>
                  <option value="assignees">{t('Zuständige')}</option>
                  <option value="watchers">{t('Beobachter')}</option>
                  {team.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Text (optional)')}>
                <input value={a.message ?? ''} onChange={(e) => setAction(i, { message: e.target.value })} />
              </Field>
            </div>
          )}
        </div>
      ))}
      <div className="actions">
        <button type="button" className="btn small secondary" disabled={actions.length >= 10} onClick={() => setR({ ...r, actions: [...actions, newAction('add_tag')] })}>
          {t('+ Weitere Aktion')}
        </button>
        <span className="grow" />
        <button type="button" className="btn secondary" onClick={onClose}>
          {t('Abbrechen')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!r.name?.trim()}
          onClick={async () => {
            const body = { name: r.name, trigger: r.trigger, project_id: r.project_id ?? null, conditions: r.conditions ?? {}, actions: r.actions };
            const out = await act(() => (r.id ? api.patch(`/api/pm/automations/${r.id}`, body) : api.post('/api/pm/automations', body)), t('Gespeichert'));
            if (out) onSaved();
          }}
        >
          {t('Speichern')}
        </button>
      </div>
    </Modal>
  );
}

// --- templates -------------------------------------------------------------------------------------------------

function Templates({ project }: { project: ProjectDetail }) {
  const t = useT('pm');
  const tpls = useLoad(() => api.get<{ projects: { id: string; name: string; description: string; builtin: boolean; tasks: number }[]; tasks: TaskTemplate[] }>('/api/pm/templates'), []);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  return (
    <Card title={t('Vorlagen')} hint={t('Projekte und Aufgaben, die du immer wieder brauchst – mit Struktur, Terminen relativ zum Start und Abhängigkeiten.')} tour="pm-set-templates">
      <h3 className="pm-h3">{t('Dieses Projekt als Vorlage speichern')}</h3>
      <div className="pm-set-row add">
        <input value={name} placeholder={project.name} aria-label={t('Name der Vorlage')} onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          className="btn small"
          onClick={async () => {
            const r = await act(() => api.post(`/api/pm/projects/${project.id}/save-template`, { name: name.trim() || project.name }), t('Vorlage gespeichert'));
            if (r) (setName(''), await tpls.reload());
          }}
        >
          {t('Als Vorlage speichern')}
        </button>
      </div>
      <h3 className="pm-h3">{t('Projektvorlagen')}</h3>
      {(tpls.data?.projects ?? []).map((p) => (
        <div key={p.id} className="pm-set-row">
          <div className="grow">
            <strong>{p.name}</strong> {p.builtin && <span className="badge blue">{t('mitgeliefert')}</span>}
            <div className="muted small">{p.description || t.plural(p.tasks, { other: '{n} Aufgaben' })}</div>
          </div>
          <span className="muted small">{p.tasks} {t('Aufgaben')}</span>
          {!p.builtin && (
            <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: p.name })} onClick={async () => confirmAsk(t('Vorlage „{name}“ löschen?', { name: p.name })) && (await act(() => api.del(`/api/pm/templates/${p.id}`), t('Gelöscht'))) && (await tpls.reload())}>
              ✕
            </button>
          )}
        </div>
      ))}
      <h3 className="pm-h3">{t('Aufgabenvorlagen')}</h3>
      {(tpls.data?.tasks ?? []).map((x) => (
        <div key={x.id} className="pm-set-row">
          <div className="grow">
            <strong>{x.name}</strong>
            <div className="muted small">
              {x.data.title}
              {x.data.due_in_days !== undefined ? t.plural(x.data.due_in_days, { other: ' · fällig in {n} Tagen' }) : ''}
              {x.data.subtasks?.length ? t.plural(x.data.subtasks.length, { other: ' · {n} Unteraufgaben' }) : ''}
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label={t('{name} löschen', { name: x.name })} onClick={async () => confirmAsk(t('Vorlage „{name}“ löschen?', { name: x.name })) && (await act(() => api.del(`/api/pm/templates/${x.id}`), t('Gelöscht'))) && (await tpls.reload())}>
            ✕
          </button>
        </div>
      ))}
      {!tpls.data?.tasks.length && <p className="muted small">{t('Noch keine Aufgabenvorlagen – in einer Aufgabe auf „Als Vorlage“ klicken oder hier eine anlegen.')}</p>}
      <div className="actions">
        <button type="button" className="btn small secondary" onClick={() => setAdding(true)}>
          {t('+ Aufgabenvorlage')}
        </button>
      </div>
      {adding && <TaskTemplateModal onClose={() => setAdding(false)} onSaved={() => (setAdding(false), void tpls.reload())} />}
    </Card>
  );
}

function TaskTemplateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT('pm');
  const [f, setF] = useState({ name: '', title: '', description: '', due: '', subtasks: '', checklist: '' });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <Modal title={t('Neue Aufgabenvorlage')} onClose={onClose}>
      <Field label={t('Name der Vorlage')}>
        <input value={f.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label={t('Titel der Aufgabe')} hint={t('{{title}} = Titel der auslösenden Aufgabe (in Automationen)')}>
        <input value={f.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label={t('Beschreibung')}>
        <Textarea value={f.description} onChange={(v) => set({ description: v })} />
      </Field>
      <Field label={t('Fällig in (Tagen)')}>
        <input type="number" min={0} value={f.due} onChange={(e) => set({ due: e.target.value })} />
      </Field>
      <Field label={t('Unteraufgaben (eine pro Zeile)')}>
        <Textarea value={f.subtasks} onChange={(v) => set({ subtasks: v })} />
      </Field>
      <Field label={t('Checkliste (eine Zeile pro Punkt)')}>
        <Textarea value={f.checklist} onChange={(v) => set({ checklist: v })} />
      </Field>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!f.title.trim()}
          onClick={async () => {
            const data = { title: f.title.trim(), description: f.description, due_in_days: f.due === '' ? undefined : Number(f.due), subtasks: lines(f.subtasks), checklist: lines(f.checklist).length ? [{ title: t('Checkliste'), items: lines(f.checklist) }] : [] };
            const r = await act(() => api.post('/api/pm/templates', { name: f.name.trim() || f.title.trim(), data }), t('Vorlage gespeichert'));
            if (r) onSaved();
          }}
        >
          {t('Speichern')}
        </button>
        <button type="button" className="btn secondary" onClick={onClose}>
          {t('Abbrechen')}
        </button>
      </div>
    </Modal>
  );
}

// --- rates ----------------------------------------------------------------------------------------------------

function Rates({ project, meta }: { project: ProjectDetail; meta: Meta }) {
  const t = useT('pm');
  const rates = useLoad(() => api.get<{ rates: { id: string; user_id: string | null; project_id: string | null; rate_cents: number }[]; default_rate_cents: number }>('/api/pm/billing/rates'), []);
  const mine = (uid: string) => rates.data?.rates.find((r) => r.project_id === project.id && r.user_id === uid);
  const global = (uid: string) => rates.data?.rates.find((r) => !r.project_id && r.user_id === uid);
  return (
    <Card title={t('Stundensätze in diesem Projekt')} hint={t('Reihenfolge: Satz der Person im Projekt → Satz des Projekts → Satz der Person → Standardsatz unter Zeiterfassung.')} tour="pm-set-rates">
      {rates.error ? (
        <p className="muted small">{rates.error}</p>
      ) : (
        meta.team.map((p) => (
          <div key={p.id} className="pm-set-row">
            <span className="grow">{p.name}</span>
            <RateInput
              value={mine(p.id)?.rate_cents}
              placeholder={centsToEuros(project.hourly_rate_cents ?? global(p.id)?.rate_cents ?? rates.data?.default_rate_cents) || t('kein Satz')}
              disabled={!meta.me.manager}
              onSave={async (cents) => {
                if (await act(() => api.put('/api/pm/billing/rates', { user_id: p.id, project_id: project.id, rate_cents: cents }), t('Gespeichert'))) await rates.reload();
              }}
            />
            <span className="muted small">{t('€ / Std.')}</span>
          </div>
        ))
      )}
      {!meta.me.manager && <p className="muted small">{t('Sätze ändert die Leitung.')}</p>}
    </Card>
  );
}

function RateInput({ value, placeholder, onSave, disabled }: { value: number | undefined; placeholder: string; onSave: (cents: number | null) => void; disabled?: boolean }) {
  const t = useT('pm');
  const [v, setV] = useState(centsToEuros(value));
  useEffect(() => setV(centsToEuros(value)), [value]);
  return (
    <input
      className="pm-rate"
      value={v}
      disabled={disabled}
      placeholder={placeholder}
      inputMode="decimal"
      aria-label={t('Stundensatz in Euro')}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v === centsToEuros(value)) return;
        const cents = v.trim() ? eurosToCents(v) : null;
        if (v.trim() && cents === null) return toast(t('Stundensatz bitte als Zahl angeben'));
        onSave(cents);
      }}
    />
  );
}

// --- danger zone ----------------------------------------------------------------------------------------------

function Danger({ project }: { project: ProjectDetail }) {
  const t = useT('pm');
  const [copy, setCopy] = useState<{ name: string; tasks: boolean } | null>(null);
  return (
    <Card title={t('Projekt verwalten')}>
      <div className="actions">
        <button type="button" className="btn secondary" onClick={() => setCopy({ name: t('{name} (Kopie)', { name: project.name }), tasks: true })}>
          <Icon name="copy" size={14} /> {t('Duplizieren')}
        </button>
        {!project.is_default && project.status !== 'archived' && (
          <button
            type="button"
            className="btn secondary"
            onClick={async () => {
              if (await act(() => api.patch(`/api/pm/projects/${project.id}`, { status: 'archived' }), t('Archiviert'))) navigate('pm');
            }}
          >
            {t('Archivieren')}
          </button>
        )}
        {!project.is_default && (
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (!confirmAsk(t('Projekt „{name}“ löschen?\n\nOK = Aufgaben nach „Allgemein“ verschieben.\nAbbrechen = nichts tun.', { name: project.name }))) return;
              const withTasks = confirmAsk(t('Aufgaben ebenfalls löschen?\n\nOK = Projekt UND alle Aufgaben löschen.\nAbbrechen = Aufgaben nach „Allgemein“ verschieben.'));
              if (await act(() => api.del(`/api/pm/projects/${project.id}${withTasks ? '?tasks=delete' : ''}`), t('Projekt gelöscht'))) navigate('pm');
            }}
          >
            <Icon name="trash" size={14} /> {t('Löschen')}
          </button>
        )}
      </div>
      {project.is_default && <p className="muted small">{t('„Allgemein“ nimmt alle Aufgaben ohne Projekt auf und lässt sich weder löschen noch archivieren.')}</p>}
      {copy && (
        <Modal title={t('Projekt duplizieren')} onClose={() => setCopy(null)}>
          <Field label={t('Name der Kopie')}>
            <input value={copy.name} onChange={(e) => setCopy({ ...copy, name: e.target.value })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={copy.tasks} onChange={(e) => setCopy({ ...copy, tasks: e.target.checked })} /> {t('Aufgaben mit Unteraufgaben, Abhängigkeiten und Abschnitten kopieren')}
          </label>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              disabled={!copy.name.trim()}
              onClick={async () => {
                const r = await act(() => api.post<{ id: string }>(`/api/pm/projects/${project.id}/duplicate`, { name: copy.name.trim(), with_tasks: copy.tasks }), t('Projekt dupliziert'));
                if (r) (setCopy(null), navigate(`pm/${r.id}`));
              }}
            >
              {t('Duplizieren')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setCopy(null)}>
              {t('Abbrechen')}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
