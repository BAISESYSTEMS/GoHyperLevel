import { useEffect, useRef, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { Badge, Check, Field, Link, Modal, Spinner, Textarea, act, navigate, useLoad } from '../ui';
import { NAMES, STATUS_TONE, openBuild, pendingBuild, refreshPlugins, usd } from './shared';
import { ScopeList } from './scopes';
import { AiLine, DiffList, ModelGateNotice, type DiffData, type ModelGateData } from './badges';

/**
 * „Bauen lassen“: the order → the AI's plan (what gets created, which permissions, what it may cost) → confirm →
 * the build with its log. The same view serves the dialog opened from a wish and the order page in the Werkstatt.
 */

export interface Build {
  id: string;
  kind: string;
  status: string;
  status_label: string;
  stage: number;
  stage_label: string;
  title: string;
  text: string;
  wish_id: string | null;
  plugin_id: string | null;
  user: string;
  location: string;
  est_cost_usd: number;
  cost_usd: number;
  error: string;
  needs_approval: boolean;
  progress?: { label?: string; current?: number; total?: number };
  location_id?: string;
  created_at: string;
  finished_at: string | null;
  plan?: any;
  log?: { at: string; level: string; text: string }[];
  created?: { block: string; id: string; name: string; url?: string; undone?: boolean }[];
  approval?: { by: string; at: string; note: string } | null;
  budget?: { limit_usd: number; used_usd: number };
  undoable?: boolean;
  /** Model and Denkstufe of the calls of this build. */
  ai?: { model?: string; label?: string; note?: string };
}
export interface WerkstattMe {
  can_build: boolean;
  reason: string;
  ai_problem: string | null;
  ai_hint: string;
  ai: { provider: string; label: string; model: string; connection_id: string | null; key_source: string | null };
  budget_problem: string | null;
  who: string;
  approval: boolean;
  needs_approval: boolean;
  budget: { limit_usd: number; used_usd: number };
  server_logic: string;
  admin: boolean;
  pending_approvals: number;
  model_gate: ModelGateData;
  license: { pro: boolean; stub: boolean; features: { id: string; label: string }[] };
}

export const useWerkstattMe = () => useLoad(() => api.get<WerkstattMe>('/api/werkstatt/me'), []);

/** Loads one build and keeps polling while the AI or the build is working. */
export function useBuild(id: string | undefined) {
  const r = useLoad(() => (id ? api.get<Build>(`/api/werkstatt/builds/${id}`) : Promise.resolve(undefined)), [id]);
  const busy = r.data && ['planning', 'building'].includes(r.data.status);
  const reload = useRef(r.reload);
  reload.current = r.reload;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload.current(), 1500);
    return () => clearInterval(t);
  }, [busy]);
  return r;
}

/** What the build is doing right now – with step names, updated by polling. */
export function Progress({ b }: { b: Pick<Build, 'progress' | 'status'> }) {
  const p = b.progress;
  if (!p?.label || !['planning', 'building'].includes(b.status)) return null;
  const pct = p.total && p.total > 1 ? Math.round(((p.current ?? 0) / p.total) * 100) : 0;
  return (
    <div className="wk-progress" role="status" aria-live="polite" data-tour="wk-progress">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Spinner /> <strong>{p.label}</strong>
        {p.total && p.total > 1 ? <span className="muted small">{p.current} von {p.total}</span> : null}
      </div>
      {pct > 0 && (
        <div className="wk-meter" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

const BLOCK_LABEL: Record<string, string> = { object_type: 'Objekt', workflow: 'Automation', custom_field: 'Kontaktfeld', property: 'Feld', report: 'Bericht', dashboard: 'Dashboard', agent: 'KI-Agent', template: 'Vorlage', form: 'Formular', pipeline: 'Pipeline', tag: 'Tag' };

export function StatusBadge({ b }: { b: Pick<Build, 'status' | 'status_label'> }) {
  return <Badge tone={STATUS_TONE[b.status] ?? 'gray'}>{b.status_label}</Badge>;
}

export function LogView({ log }: { log: NonNullable<Build['log']> }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [log.length]);
  return (
    <div className="wk-log" data-tour="wk-log" role="log">
      {log.map((l, i) => (
        <div key={i} className={l.level === 'error' ? 'err' : ''}>
          <span className="muted small">{new Date(l.at).toLocaleTimeString('de-DE')}</span> {l.text}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function ManifestSummary({ m }: { m: any }) {
  const parts: string[] = [];
  if (m.entries?.page) parts.push(`Seite im Menü: „${m.entries.page.title}“`);
  for (const p of m.entries?.panels ?? []) parts.push(`Panel auf der ${p.on === 'contact' ? 'Kontakt' : 'Deal'}-Seite: „${p.title}“`);
  for (const w of m.entries?.widgets ?? []) parts.push(`Dashboard-Widget: „${w.title}“`);
  for (const a of m.entries?.actions ?? []) parts.push(`Automations-Schritt: „${a.label}“`);
  for (const j of m.entries?.jobs ?? []) parts.push(`Geplanter Job: „${j.label}“ (${{ hourly: 'stündlich', daily: 'täglich', weekly: 'wöchentlich' }[j.every as 'daily']}${j.at ? ` um ${j.at}` : ''})`);
  return (
    <div className="wk-manifest">
      <strong>{m.name}</strong>
      <ul>
        {parts.map((x) => (
          <li key={x}>{x}</li>
        ))}
        {m.server && <li>Server-Logik: {m.server.mode === 'script' ? 'Skript in der Sandbox' : 'deklarative Schritte (ohne Code)'}</li>}
      </ul>
    </div>
  );
}

/** The plan: what gets created, which permissions it needs, what it costs – with the confirmation. */
export function PlanView({ b, me, onChange }: { b: Build; me?: WerkstattMe; onChange: () => void }) {
  const plan = b.plan ?? {};
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const areas = useLoad(() => api.get<Record<string, string>>('/api/permissions').catch(() => ({}) as Record<string, string>), []);
  const label = (a: string) => areas.data?.[a] ?? a;
  const tooBig = me && plan.estimate && me.budget.used_usd + (plan.estimate.typical_usd ?? 0) > me.budget.limit_usd;
  const confirm = async () => {
    setBusy(true);
    const r = await act(() => api.post(`/api/werkstatt/builds/${b.id}/confirm`, { accept_scopes: (plan.scopes ?? []).map((s: any) => s.key), accept_areas: plan.areas ?? [] }));
    setBusy(false);
    if (r) onChange();
  };
  return (
    <div className="wk-plan" data-tour="wk-plan">
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <Badge tone={b.stage === 2 ? 'purple' : 'blue'}>{b.stage === 2 ? `Stufe 2 · ${NAMES.stage2}` : `Stufe 1 · ${NAMES.stage1}`}</Badge>
        <h3 style={{ margin: 0 }}>{plan.title ?? b.title}</h3>
      </div>
      <p>{plan.summary}</p>
      {plan.rationale && <p className="muted small">{plan.rationale}</p>}
      <h4>Was gebaut wird</h4>
      {b.stage === 2 && plan.manifest ? (
        <ManifestSummary m={plan.manifest} />
      ) : (
        <ol className="wk-steps">
          {(plan.steps ?? []).map((s: any, i: number) => (
            <li key={i}>
              {s.title}
              {s.area && <span className="muted small"> · Bereich {label(s.area)}</span>}
            </li>
          ))}
        </ol>
      )}
      {(plan.notes ?? []).length > 0 && (
        <ul className="wk-notes">
          {plan.notes.map((n: string) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <h4>Berechtigungen</h4>
      {b.stage === 2 ? (
        <ScopeList scopes={plan.scopes ?? []} />
      ) : (
        <p className="small">
          {(plan.areas ?? []).length ? <>Legt Dinge in diesen Bereichen deines Sub-Accounts an: {(plan.areas as string[]).map(label).join(', ')}.</> : 'Keine besonderen Bereiche.'} Es läuft mit deinen Rechten, nur in diesem Sub-Account.
        </p>
      )}
      {(plan.missing_areas ?? []).length > 0 && <div className="card notice-card">Dir fehlt das Recht für: {(plan.missing_areas as string[]).map(label).join(', ')}. Ein Admin kann den Plan bestätigen.</div>}
      {b.stage === 2 && plan.ai?.model && (
        <p className="wk-ai" data-tour="wk-plan-model">
          Gebaut wird mit {plan.ai.model} · Denkstufe {plan.ai.effort?.label || 'nicht gesendet'}
          {plan.ai.effort?.note ? ` (${plan.ai.effort.note})` : ''}
        </p>
      )}
      {plan.model_gate && plan.model_gate.ok === false && me && <ModelGateNotice gate={{ ...me.model_gate, ok: false, message: plan.model_gate.message }} />}
      <h4>Kosten</h4>
      {b.stage === 2 ? (
        <p className="small">
          Geschätzt etwa <strong>{usd(plan.estimate?.typical_usd ?? 0)}</strong> KI-Kosten (höchstens {usd(plan.estimate?.max_usd ?? 0)} mit Korrekturrunden)
          {me ? <> · Monatsbudget des Sub-Accounts: {usd(me.budget.used_usd)} von {usd(me.budget.limit_usd)} verbraucht</> : null}.
          {tooBig && <strong style={{ color: 'var(--red)' }}> Das Budget reicht dafür nicht.</strong>}
        </p>
      ) : (
        <p className="small">Der Bau selbst kostet keine KI – bisher {usd(b.cost_usd)} für die Analyse.</p>
      )}
      {b.status === 'planned' && (
        <div className="wk-confirm">
          <Check checked={ok} onChange={setOk} label="Ich habe gelesen, was gebaut wird und welche Berechtigungen es braucht." tour="wk-consent" />
          {me?.needs_approval && <p className="muted small">Ein Admin muss den Bau danach noch freigeben.</p>}
          <div className="actions">
            <button className="btn secondary" onClick={() => act(() => api.post(`/api/werkstatt/builds/${b.id}/cancel`)).then(onChange)}>
              Verwerfen
            </button>
            {plan.model_gate?.ok === false && (
              <button className="btn secondary" disabled={busy} title="Plant den Wunsch noch einmal, z. B. nachdem ein Spitzenmodell eingestellt wurde" onClick={() => act(() => api.post<{ id: string }>(`/api/werkstatt/builds/${b.id}/replan`)).then((r) => r && (navigate(`werkstatt/${r.id}`), onChange()))}>
                Plan neu erstellen
              </button>
            )}
            <button className="btn" data-tour="wk-confirm" disabled={!ok || busy || !!tooBig || plan.model_gate?.ok === false} onClick={confirm}>
              <Icon name="hammer" size={14} /> {me?.needs_approval ? 'Zur Freigabe senden' : 'Jetzt bauen'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Progress and result of a build (log, created items, links). */
export function ResultView({ b, onChange }: { b: Build; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <StatusBadge b={b} />
        <span className="muted small">KI-Kosten bisher {usd(b.cost_usd)}</span>
      </div>
      <Progress b={b} />
      <AiLine ai={b.ai} />
      <DiffList d={b.plan?.diff as DiffData | undefined} />
      {b.error && b.status !== 'planning' && <div className="card notice-card" style={{ whiteSpace: 'pre-wrap' }}>{b.error}</div>}
      {b.status === 'awaiting_approval' && <div className="card notice-card">Wartet auf die Freigabe eines Admins. Du bekommst Bescheid, sobald es losgeht.</div>}
      {(b.created ?? []).length > 0 && (
        <>
          <h4>Angelegt</h4>
          <ul className="wk-created">
            {b.created!.map((c, i) => (
              <li key={i} className={c.undone ? 'undone' : ''}>
                {c.url && !c.undone ? <Link to={c.url}>{c.name}</Link> : c.name} <span className="muted small">· {BLOCK_LABEL[c.block] ?? c.block}{c.undone ? ' · rückgängig gemacht' : ''}</span>
              </li>
            ))}
          </ul>
          {b.undoable && (
            <button className="btn secondary small" disabled={busy} onClick={async () => (setBusy(true), await act(() => api.post(`/api/werkstatt/builds/${b.id}/undo`), 'Rückgängig gemacht'), setBusy(false), onChange())}>
              <Icon name="undo" size={14} /> Alles rückgängig machen
            </button>
          )}
        </>
      )}
      {b.plugin_id && b.status === 'done' && (
        <p>
          <Link to={`werkstatt/plugins/${b.plugin_id}`} className="btn">
            <Icon name="puzzle" size={14} /> Plugin ansehen
          </Link>
        </p>
      )}
      <h4>Protokoll</h4>
      <LogView log={b.log ?? []} />
    </>
  );
}

/** One screen for a build, whatever state it is in. */
export function BuildView({ b, me, onChange }: { b: Build; me?: WerkstattMe; onChange: () => void }) {
  if (b.status === 'planning') {
    return (
      <>
        {b.progress?.label ? (
          <Progress b={b} />
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <Spinner /> <strong>Die KI analysiert deinen Wunsch …</strong>
          </div>
        )}
        <p className="muted small">Das dauert meist eine halbe Minute. Du kannst das Fenster schließen – der Auftrag steht danach in der {NAMES.werkstatt}.</p>
        <LogView log={b.log ?? []} />
      </>
    );
  }
  return (
    <>
      {b.status !== 'planned' && b.plan?.title && (
        <p>
          <strong>{b.plan.title}</strong> <span className="muted small">· {b.stage_label} · {dt(b.created_at)}</span>
        </p>
      )}
      {b.status === 'planned' ? <PlanView b={b} me={me} onChange={onChange} /> : <ResultView b={b} onChange={onChange} />}
    </>
  );
}

/** Mounted once in the app shell: opens on the event `pghl:build` (wish page, new wish, Werkstatt). */
export function BuildLayer() {
  const [open, setOpen] = useState<{ wishId?: string; title?: string; text?: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      pendingBuild.v = undefined;
      setOpen((e as CustomEvent).detail ?? {});
    };
    window.addEventListener('pghl:build', on);
    // asked for before this chunk was there
    if (pendingBuild.v) on(new CustomEvent('pghl:build', { detail: pendingBuild.v }));
    return () => window.removeEventListener('pghl:build', on);
  }, []);
  const close = () => {
    setOpen(null);
    void refreshPlugins();
    window.dispatchEvent(new Event('pghl:build-closed'));
  };
  return open ? <BuildModal init={open} onClose={close} /> : null;
}

function BuildModal({ init, onClose }: { init: { wishId?: string; title?: string; text?: string }; onClose: () => void }) {
  const me = useWerkstattMe();
  const [text, setText] = useState(init.text ?? [init.title].filter(Boolean).join('\n'));
  const [id, setId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const build = useBuild(id);
  const b = build.data;
  const start = async () => {
    setBusy(true);
    const r = await act(() => api.post<Build>('/api/werkstatt/builds', { text: text.trim() || undefined, wish_id: init.wishId }));
    setBusy(false);
    if (r) setId(r.id);
  };
  const m = me.data;
  return (
    <Modal
      title={`${NAMES.build} – ${NAMES.werkstatt}`}
      wide
      onClose={onClose}
      footer={
        b ? (
          <>
            <button className="btn secondary" onClick={() => (onClose(), navigate(`werkstatt/${b.id}`))}>
              In der {NAMES.werkstatt} öffnen
            </button>
            <button className="btn" onClick={onClose}>
              Schließen
            </button>
          </>
        ) : (
          <button className="btn" data-tour="wk-start" disabled={busy || !m?.can_build || !!m?.ai_problem || !!m?.budget_problem || (!init.wishId && text.trim().length < 8)} onClick={start}>
            <Icon name="hammer" size={14} /> Plan erstellen
          </button>
        )
      }
    >
      {!b ? (
        <>
          {init.wishId && <p className="muted small">Gebaut wird der Wunsch aus der Wunschliste – du kannst den Text unten ergänzen.</p>}
          <Field label="Was soll gebaut werden?" hint="Ein bis zwei Sätze reichen: „Ich möchte …“. Die KI schlägt zuerst einen Plan vor – gebaut wird erst nach deiner Bestätigung.">
            <Textarea value={text} onChange={setText} rows={5} placeholder="z. B. Ich möchte vor Geburtstagen meiner Kontakte erinnert werden." />
          </Field>
          {m && !m.can_build && <div className="card notice-card">{m.reason}</div>}
          {m?.can_build && m.ai_problem && (
            <div className="card notice-card" data-tour="wk-ai-problem">
              <strong>{m.ai_problem}</strong>
              <div className="small">{m.ai_hint}</div>
            </div>
          )}
          {m?.can_build && !m.ai_problem && m.budget_problem && <div className="card notice-card">{m.budget_problem}</div>}
          {m?.can_build && !m.ai_problem && !m.budget_problem && <p className="muted small">KI: {m.ai.label} · {m.ai.model}{m.needs_approval ? ' · Ein Admin gibt den Bau nach deiner Bestätigung frei.' : ''}</p>}
          <p className="muted small">
            Alles gilt nur für diesen Sub-Account. Ein Wunsch wird zuerst ein privates Plugin, das nur du siehst – später kann es für den Sub-Account, die ganze Agentur oder den {NAMES.marktplatz} freigegeben werden.
          </p>
        </>
      ) : (
        <BuildView b={b} me={m} onChange={() => void build.reload()} />
      )}
      {id && !b && <Spinner />}
    </Modal>
  );
}


/** On a wish: the „Bauen lassen“ button and the builds made for this wish. */
export function WishBuilds({ wishId }: { wishId: string }) {
  const me = useWerkstattMe();
  const l = useLoad(() => api.get<Build[]>(`/api/werkstatt/wishes/${wishId}`).catch(() => [] as Build[]), [wishId]);
  const reload = l.reload;
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener('pghl:build-closed', on);
    return () => window.removeEventListener('pghl:build-closed', on);
  }, [reload]);
  const builds = l.data ?? [];
  if (!me.data || (!me.data.can_build && !builds.length)) return null;
  return (
    <div className="card wk-wish" data-tour="wish-build">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="grow">
          <h2 style={{ margin: 0 }}>{NAMES.build}</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Die KI schlägt einen Plan vor und baut ihn nach deiner Bestätigung – zuerst nur für dich.
          </p>
        </div>
        {me.data.can_build && (
          <button className="btn" onClick={() => openBuild({ wishId })}>
            <Icon name="hammer" size={14} /> {NAMES.build}
          </button>
        )}
      </div>
      {builds.length > 0 && (
        <ul className="wk-entries">
          {builds.map((b) => (
            <li key={b.id}>
              <Link to={`werkstatt/${b.id}`}>{b.title}</Link> <StatusBadge b={b} /> <span className="muted small">{dt(b.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Done screen of a new wish: build it right away. */
export function BuildHint({ wishId, onBefore }: { wishId: string; onBefore: () => void }) {
  const me = useWerkstattMe();
  if (!me.data?.can_build) return null;
  return (
    <button
      className="btn secondary"
      data-tour="fb-build"
      onClick={() => {
        onBefore();
        openBuild({ wishId });
      }}
    >
      <Icon name="hammer" size={14} /> {NAMES.build}
    </button>
  );
}
