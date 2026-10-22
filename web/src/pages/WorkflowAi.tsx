import { useState } from 'react';
import { Icon } from '../icons';
import { api } from '../api';
import { Badge, Link, Modal, Spinner, Textarea, act, toast, useLoad } from '../ui';
import { Callout, Item } from './CreatorKit';
import './creator.css';
import { tr, useT } from '../i18n';

/**
 * KI-Workflow-Builder: "Mit KI erstellen" (Workflow-Liste) and "Mit KI ändern" (Editor). The person describes what should happen,
 * the AI proposes a workflow checked against the catalogue, the dialog shows it with what is new or changed – and saves it as a
 * DRAFT. Nothing here publishes or activates a workflow. Docs: docs/workflow-ai.md.
 */

/** Badge per change (German labels = message ids of the workflows catalog). */
const TAG: Record<string, [string, 'green' | 'yellow' | 'red' | 'blue' | 'gray']> = {
  added: ['neu', 'green'],
  changed: ['geändert', 'yellow'],
  removed: ['entfernt', 'red'],
  moved: ['verschoben', 'blue'],
  same: ['', 'gray'],
};
const SKIP = new Set(['id', 'type', 'name', 'then', 'else', 'each']);
const short = (v: unknown, max = 70): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const OPS: Record<string, string> = { has: 'hat', not_has: 'hat nicht', equals: '=', not_equals: '≠', contains: 'enthält', empty: 'ist leer', not_empty: 'ist nicht leer', gt: '>', lt: '<', gte: '≥', lte: '≤', starts_with: 'beginnt mit', ends_with: 'endet mit', in: 'in', not_in: 'nicht in', between: 'zwischen', regex: 'passt auf', date_before: 'vor', date_after: 'nach' };
/** One value as people read it: ids become names, conditions become sentences. */
function show(v: unknown, names: Map<string, string>, max = 60): string {
  const t = tr('workflows');
  if (typeof v === 'string') return short(names.get(v) ?? v, max);
  if (Array.isArray(v) && v.length && v.every((c) => c && typeof c === 'object' && 'op' in c && 'field' in c)) return short(v.map((c: any) => `${c.field === 'tag' ? 'Tag' : c.field} ${OPS[c.op] ? t(OPS[c.op]) : c.op}${c.value !== undefined ? ` ${t('„{value}“', { value: c.value })}` : ''}`).join(` ${t('und')} `), max + 20);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return short(v.map((x) => names.get(x) ?? x).join(', '), max);
  return short(v, max);
}
/** The first settings of a step as one line: "subject: Danke · body: Hallo …". */
function detail(step: any, names: Map<string, string>): string {
  return Object.entries(step ?? {})
    .filter(([k, v]) => !SKIP.has(k) && !/^b\d+$/.test(k) && v !== '' && v !== null && !(Array.isArray(v) && !v.length))
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${show(v, names)}`)
    .join(' · ');
}

/** Names of the things a step points at (pipelines, stages, forms …), so the preview shows "Verkauf" instead of an id. */
function useNames() {
  const lists = useLoad(async () => {
    const get = (p: string) => api.get<any[]>(p).catch(() => [] as any[]);
    const [pipes, forms, calendars, workflows, products, courses] = await Promise.all([get('/api/pipelines'), get('/api/forms'), get('/api/calendars'), get('/api/workflows'), get('/api/products'), get('/api/courses')]);
    const m = new Map<string, string>();
    for (const p of pipes) {
      m.set(p.id, p.name);
      for (const st of p.stages ?? []) m.set(st.id, `${p.name} › ${st.name}`);
    }
    for (const x of [...forms, ...calendars, ...workflows, ...products, ...courses]) m.set(x.id, x.name ?? x.title);
    return m;
  }, []);
  return lists.data ?? new Map<string, string>();
}

/** Names of steps and triggers from the catalogue, in the UI language. */
function useLabels() {
  const t = useT('workflows');
  const cat = useLoad(() => api.get('/api/workflow-catalog?compact=1'), []);
  const steps = new Map<string, string>((cat.data?.actions ?? []).map((a: any) => [a.type, a.label]));
  const triggers = new Map<string, string>((cat.data?.triggers ?? []).map((m: any) => [m.type, m.label]));
  return { step: (type: string) => t(steps.get(type) ?? type), trigger: (type: string) => t(triggers.get(type) ?? type) };
}

function Diff({ diff, workflow, label }: { diff: any; workflow: any; label: ReturnType<typeof useLabels> }) {
  const t = useT('workflows');
  const names = useNames();
  const live = diff.steps.filter((s: any) => s.status !== 'removed');
  const removed = diff.steps.filter((s: any) => s.status === 'removed');
  const trig = workflow.trigger;
  return (
    <div data-tour="wfai-diff">
      <div className="cr-list">
        <Item tone={diff.trigger.changed ? 'warn' : undefined} side={diff.trigger.changed ? <Badge tone="yellow">{t('geändert')}</Badge> : undefined}>
          <strong>{t('Auslöser:')} {label.trigger(trig.type)}</strong>
          {Object.keys(trig.config ?? {}).length > 0 && <div className="cr-sub">{detail(trig.config, names)}</div>}
          {diff.trigger.changed && diff.trigger.before && <div className="cr-sub">{t('vorher: {name}', { name: label.trigger(diff.trigger.before.type) })}</div>}
        </Item>
        {live.map((s: any) => {
          const depth = Math.floor(s.path.split('/').length / 2);
          const [tag, tone] = TAG[s.status];
          return (
            <div key={s.id} style={{ marginLeft: depth * 22 }}>
              <Item tone={s.status === 'added' ? 'ok' : s.status === 'changed' ? 'warn' : undefined} side={tag ? <Badge tone={tone}>{t(tag)}</Badge> : undefined}>
                <strong>{t(s.label)}</strong>
                {detail(s.after, names) && <div className="cr-sub">{detail(s.after, names)}</div>}
                {s.status === 'changed' &&
                  s.changes?.map((c: any) => (
                    <div key={c.key} className="cr-sub">
                      {c.key}: <s>{c.before === undefined ? '–' : show(c.before, names, 50)}</s> → {c.after === undefined ? '–' : show(c.after, names, 50)}
                    </div>
                  ))}
              </Item>
            </div>
          );
        })}
        {removed.map((s: any) => (
          <Item key={s.id} tone="bad" side={<Badge tone="red">{t('entfernt')}</Badge>}>
            <strong style={{ textDecoration: 'line-through' }}>{t(s.label)}</strong>
            {detail(s.before, names) && <div className="cr-sub">{detail(s.before, names)}</div>}
          </Item>
        ))}
      </div>
    </div>
  );
}

function Dialog({ mode, workflowId, dirty, onClose, onApplied }: { mode: 'create' | 'edit'; workflowId?: string; dirty?: boolean; onClose: () => void; onApplied: (r: { workflow_id: string; mode: string }) => void }) {
  const t = useT('workflows');
  const status = useLoad(() => api.get('/api/workflow-ai/status'), []);
  const label = useLabels();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<'' | 'generate' | 'apply'>('');
  const [error, setError] = useState('');
  const [res, setRes] = useState<any>(null);
  const st = status.data;
  const edit = mode === 'edit';

  const generate = async () => {
    setBusy('generate');
    setError('');
    try {
      setRes(await api.post('/api/workflow-ai/generate', { prompt, ...(edit ? { workflow_id: workflowId } : {}) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const apply = async () => {
    setBusy('apply');
    const r = await act(() => api.post(`/api/workflow-ai/runs/${res.run_id}/apply`));
    setBusy('');
    if (r) {
      toast(r.message);
      onClose();
      onApplied(r);
    }
  };

  if (res)
    return (
      <Modal
        title={edit ? t('Änderungsvorschlag für „{name}“', { name: res.base?.name ?? '' }) : t('Vorschlag: {name}', { name: res.workflow.name })}
        wide
        className="cr"
        onClose={onClose}
        footer={
          <>
            <button className="btn secondary" onClick={() => setRes(null)} disabled={busy === 'apply'}>
              {t('Anders formulieren')}
            </button>
            <button className="btn" onClick={apply} disabled={busy === 'apply'} data-tour="wfai-apply">
              {busy === 'apply' ? t('Speichert …') : edit ? t('Als Entwurf speichern') : t('Als Entwurf anlegen')}
            </button>
          </>
        }
      >
        <div data-tour="wfai-preview">
          <Callout tone="info">
            <p>
              <strong>{t('Das hat die KI gebaut')}</strong>
            </p>
            <p>{res.summary || t('Keine Zusammenfassung.')}</p>
            {res.attempts > 1 && <p className="small muted">{t.plural(res.attempts - 1, { other: 'Die KI hat sich {n}× selbst korrigiert, bis der Entwurf zum Katalog passte.' })}</p>}
          </Callout>
          {res.notes.length > 0 && (
            <Callout tone="warn">
              <strong>{t('Vorher einrichten oder prüfen')}</strong>
              <ul>
                {res.notes.map((n: string) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Callout>
          )}
          {res.warnings.length > 0 && (
            <Callout tone="warn">
              <strong>{t('Hinweise')}</strong>
              <ul>
                {res.warnings.slice(0, 8).map((n: string) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Callout>
          )}
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            {[t('{n} neu', { n: res.diff.counts.added }), t('{n} geändert', { n: res.diff.counts.changed }), t('{n} entfernt', { n: res.diff.counts.removed }), ...(res.diff.counts.moved ? [t('{n} verschoben', { n: res.diff.counts.moved })] : [])].join(' · ')}
          </p>
          <Diff diff={res.diff} workflow={res.workflow} label={label} />
          {edit && res.base?.has_draft && <Callout tone="warn">{t('Der Workflow hat schon einen Entwurf. Er wird durch diesen Vorschlag ersetzt – der Vorschlag baut auf dem bisherigen Entwurf auf.')}</Callout>}
          <Callout tone="info">
            <strong>{t('Nichts geht live.')}</strong> {edit ? t('Die Änderung wird als Entwurf des Workflows gespeichert. Du prüfst sie im Editor und veröffentlichst selbst.') : t('Der Workflow wird als Entwurf angelegt – inaktiv. Prüfe ihn, probiere den Testlauf und aktiviere ihn selbst.')}
          </Callout>
        </div>
      </Modal>
    );

  return (
    <Modal
      title={edit ? t('Workflow mit KI ändern') : t('Workflow mit KI erstellen')}
      wide
      className="cr"
      onClose={onClose}
      footer={
        <button className="btn" onClick={generate} disabled={busy === 'generate' || prompt.trim().length < 8 || (st && !st.ready)} data-tour="wfai-generate">
          {busy === 'generate' ? t('Die KI baut …') : <><Icon name="ai" /> {edit ? t('Änderung vorschlagen') : t('Entwurf erstellen')}</>}
        </button>
      }
    >
      {st && !st.ready && (
        <Callout tone="warn" tour="wfai-setup">
          <strong>{t('Die KI ist noch nicht eingerichtet.')}</strong> {st.reason} {t('Hinterlege einen Schlüssel unter')} <Link to="settings/ai">{t('Einstellungen → KI-Assistent')}</Link> {t('oder verbinde unter')} <Link to="settings/ai-providers">{t('KI-Anbieter (BYOK)')}</Link>{' '}
          {/* the English catalog moves "a provider of your choice" into the fragment before the link */}
          {t('einen Anbieter deiner Wahl – dort kannst du die Verwendung „Workflows“ einem Modell zuweisen.')}
        </Callout>
      )}
      {edit && dirty && <Callout tone="warn">{t('Du hast ungespeicherte Änderungen im Editor. Die KI baut auf dem gespeicherten Stand auf – speichere zuerst, wenn sie einfließen sollen.')}</Callout>}
      <p className="cr-hint" style={{ marginTop: 0 }}>
        {edit ? t('Beschreibe, was sich ändern soll – zum Beispiel „Warte drei statt zwei Tage und schicke vorher eine SMS“.') : t('Beschreibe in ein bis zwei Sätzen, was passieren soll – wann es startet und was dann geschieht.')}
      </p>
      <Textarea value={prompt} onChange={setPrompt} rows={5} maxLength={4000} autoFocus data-tour="wfai-prompt" placeholder={edit ? t('Was soll sich ändern?') : t('Wenn jemand das Kontaktformular ausfüllt, …')} aria-label={t('Auftrag an die KI')} />
      {!edit && st?.examples?.length > 0 && (
        <>
          <p className="muted small" style={{ margin: '12px 0 6px' }}>
            {t('Beispiele zum Anklicken:')}
          </p>
          <div className="cr-chips" data-tour="wfai-examples">
            {st.examples.map((x: string) => (
              <button key={x} type="button" className="cr-chip" onClick={() => setPrompt(x)}>
                {x}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <p className="cr-err" role="alert">{error}</p>}
      {busy === 'generate' && (
        <div className="cr-line" style={{ marginTop: 12 }} role="status">
          <Spinner /> <span className="muted">{t('Das dauert bis zu einer Minute. Passt der Entwurf nicht zum Katalog, korrigiert sich die KI bis zu zweimal selbst.')}</span>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 14 }}>
        {st ? `${t(st.provider.byok ? 'Läuft über {provider} – dein eigener Schlüssel.' : 'Läuft über {provider}.', { provider: `${st.provider.label}${st.provider.model ? ` (${st.provider.model})` : ''}` })} ` : ''}
        {edit ? t('Gesendet werden nur dein Auftrag, der Workflow-Katalog, die Namen von Pipelines, Formularen, Kursen und Ähnlichem und der bisherige Workflow – keine Kontaktdaten.') : t('Gesendet werden nur dein Auftrag, der Workflow-Katalog, die Namen von Pipelines, Formularen, Kursen und Ähnlichem – keine Kontaktdaten.')}
      </p>
    </Modal>
  );
}

/** The button and its dialog. `onApplied` gets the workflow to open (new) or reload (changed). */
export function WorkflowAiButton({ mode, workflowId, dirty, onApplied }: { mode: 'create' | 'edit'; workflowId?: string; dirty?: boolean; onApplied: (r: { workflow_id: string; mode: string }) => void }) {
  const t = useT('workflows');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn secondary wfai-btn" style={{ minHeight: 44 }} data-tour={mode === 'create' ? 'wfai-open' : 'wfai-open-edit'} onClick={() => setOpen(true)}>
        <Icon name="ai" /> {mode === 'create' ? t('Mit KI erstellen') : t('Mit KI ändern')}
      </button>
      {open && <Dialog mode={mode} workflowId={workflowId} dirty={dirty} onClose={() => setOpen(false)} onApplied={onApplied} />}
    </>
  );
}
