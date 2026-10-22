import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Badge, Spinner, Textarea, act, confirmAsk, toast, useLoad } from '../ui';
import { AiLine, DiffList, VersionBadges, type DiffData, type VersionBadgesData } from './badges';
import { PlanView, Progress, StatusBadge, useBuild, useWerkstattMe, type Build, type WerkstattMe } from './Build';
import { PluginFrame } from './PluginFrame';
import { CARD_TOOLS, NAMES, refreshPlugins, usd } from './shared';
import './safety.css';

/**
 * Cards of the Werkstatt in the HyperLevel Agent chat (the "Realtime Feature Lifecycle"): the plan with the person's own
 * confirm button, live progress with step names, an inline sandboxed preview with Öffnen / Ändern lassen / Verwerfen,
 * and the diff of a new version. The agent only starts things; the card reads the order itself (by the `build_id` in the
 * tool result) and every click is a normal request the signed-in person makes – the agent never confirms for them.
 */

interface CardTool {
  id: string;
  name: string;
  status: string;
  args?: Record<string, unknown>;
  preview?: string;
}

/** The ids a card needs, from the tool's result (or, when the preview was cut off, from its first keys) and arguments. */
export function idsOf(t: Pick<CardTool, 'args' | 'preview'>): { buildId?: string; pluginId?: string } {
  const raw = t.preview ?? '';
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(raw);
  } catch {
    const grab = (k: string) => new RegExp(`"${k}":"([^"]+)"`).exec(raw)?.[1];
    data = { build_id: grab('build_id'), plugin_id: grab('plugin_id') };
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return { buildId: str(data.build_id) ?? str(t.args?.build_id), pluginId: str(data.plugin_id) ?? str(t.args?.plugin_id) };
}

// --- only the newest card of an order is interactive (older ones become one line) --------------------------------

const claims = new Map<string, string[]>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
function useClaim(key: string, cardId: string): boolean {
  useEffect(() => {
    claims.set(key, [...(claims.get(key) ?? []).filter((x) => x !== cardId), cardId]);
    notify();
    return () => {
      claims.set(key, (claims.get(key) ?? []).filter((x) => x !== cardId));
      notify();
    };
  }, [key, cardId]);
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => claims.get(key)?.at(-1) === cardId,
  );
}

export function WerkstattToolCard({ t, onNavigate }: { t: CardTool; onNavigate: (to: string) => void }) {
  if (t.status !== 'ok' || !(CARD_TOOLS as readonly string[]).includes(t.name)) return null;
  const { buildId, pluginId } = idsOf(t);
  if (buildId) return <BuildCard buildId={buildId} cardId={t.id} onNavigate={onNavigate} />;
  if (pluginId) return <PluginCard pluginId={pluginId} cardId={t.id} onNavigate={onNavigate} />;
  return null;
}

// --- an order ------------------------------------------------------------------------------------------------------

function BuildCard({ buildId, cardId, onNavigate }: { buildId: string; cardId: string; onNavigate: (to: string) => void }) {
  const me = useWerkstattMe();
  const build = useBuild(buildId);
  const mine = useClaim(`build:${buildId}`, cardId);
  const b = build.data;
  const reload = useRef(build.reload);
  reload.current = build.reload;
  // an order waiting for an admin changes by itself: look again now and then
  useEffect(() => {
    if (b?.status !== 'awaiting_approval') return;
    const i = setInterval(() => void reload.current(), 6000);
    return () => clearInterval(i);
  }, [b?.status]);
  // the plugin shows up in the menu as soon as it is built
  const done = b?.status === 'done';
  useEffect(() => {
    if (done) void refreshPlugins();
  }, [done]);
  // tell the chat panel when the card grew (a plan arrived, a step was added) so it can keep the newest part in view
  useEffect(() => {
    window.dispatchEvent(new Event('pghl:agent-grew'));
  }, [b?.status, b?.progress?.label, b?.log?.length, b?.plugin_id]);
  const [nested, setNested] = useState<string>();
  if (!b) return <div className="wk-chat">{build.error ? <span className="muted small">{build.error}</span> : <Spinner />}</div>;
  if (!mine)
    return (
      <div className="wk-chat compact" data-tour="agent-wk-card">
        <div className="head">
          <strong>{b.plan?.title ?? b.title}</strong> <StatusBadge b={b} />
          <button className="btn ghost small" onClick={() => onNavigate(`werkstatt/${b.id}`)}>
            Öffnen
          </button>
        </div>
      </div>
    );
  return (
    <div className="wk-chat" data-tour="agent-wk-card" aria-label={`${NAMES.werkstatt}: ${b.title}`}>
      <CardBody b={b} me={me.data} reload={() => void build.reload()} onNavigate={onNavigate} onNested={setNested} />
      {nested && <BuildCard buildId={nested} cardId={`${cardId}:nested`} onNavigate={onNavigate} />}
    </div>
  );
}

function CardBody({ b, me, reload, onNavigate, onNested }: { b: Build; me?: WerkstattMe; reload: () => void; onNavigate: (to: string) => void; onNested: (id: string) => void }) {
  if (b.status === 'planning')
    return (
      <>
        <div className="head">
          <Icon name="hammer" size={15} /> <strong>{NAMES.werkstatt}: Plan wird erstellt</strong>
        </div>
        {b.progress?.label ? <Progress b={b} /> : <Progress b={{ ...b, progress: { label: 'Die KI analysiert den Wunsch …' } }} />}
        <Steps b={b} />
      </>
    );
  if (b.status === 'planned') return <PlanView b={b} me={me} onChange={reload} />;
  if (b.status === 'awaiting_approval')
    return (
      <>
        <div className="head">
          <strong>{b.plan?.title ?? b.title}</strong> <StatusBadge b={b} />
        </div>
        <p className="small">Ein Admin muss den Bau noch freigeben. Du bekommst Bescheid – diese Karte aktualisiert sich von selbst.</p>
        <AiLine ai={b.ai} />
      </>
    );
  if (b.status === 'building')
    return (
      <>
        <div className="head">
          <strong>{b.plan?.title ?? b.title}</strong> <StatusBadge b={b} />
          <span className="muted small">KI-Kosten bisher {usd(b.cost_usd)}</span>
        </div>
        <Progress b={b} />
        <Steps b={b} />
        <AiLine ai={b.ai} />
      </>
    );
  if (b.status === 'done') return <Done b={b} reload={reload} onNavigate={onNavigate} onNested={onNested} />;
  return (
    <>
      <div className="head">
        <strong>{b.plan?.title ?? b.title}</strong> <StatusBadge b={b} />
      </div>
      {b.error && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{b.error}</p>}
      {b.status === 'failed' && (
        <div className="actions">
          <button className="btn secondary small" onClick={() => onNavigate(`werkstatt/${b.id}`)}>
            Protokoll ansehen
          </button>
        </div>
      )}
    </>
  );
}

/** The live steps: what the build did and is doing (the log of the order, newest at the bottom). */
function Steps({ b }: { b: Build }) {
  const log = (b.log ?? []).slice(-6);
  if (!log.length) return null;
  return (
    <ol className="wk-chat-steps" aria-label="Schritte">
      {log.map((l, i) => (
        <li key={`${l.at}-${i}`} className={l.level === 'error' ? 'err' : i === log.length - 1 && b.status === 'building' ? 'now' : ''}>
          <span aria-hidden>{l.level === 'error' ? '✗' : i === log.length - 1 && b.status === 'building' ? '›' : '✓'}</span> {l.text}
        </li>
      ))}
    </ol>
  );
}

function Done({ b, reload, onNavigate, onNested }: { b: Build; reload: () => void; onNavigate: (to: string) => void; onNested: (id: string) => void }) {
  const diff = b.plan?.diff as DiffData | null | undefined;
  const added: string[] = b.plan?.new_scopes ?? [];
  return (
    <>
      <div className="head">
        <Icon name="shieldOk" size={15} /> <strong>{b.plan?.title ?? b.title}</strong> <StatusBadge b={b} />
        {diff && (
          <Badge tone="blue">
            Version {diff.to}
          </Badge>
        )}
      </div>
      <AiLine ai={b.ai} />
      {diff && (
        <>
          <h4>Das hat sich geändert (Version {diff.from} → {diff.to})</h4>
          <DiffList d={diff} />
          {added.length > 0 && <p className="small">Die neue Version fragt zusätzliche Berechtigungen an – bitte beim Plugin bestätigen und aktivieren.</p>}
        </>
      )}
      {b.plugin_id ? (
        <PluginPreview pluginId={b.plugin_id} onNavigate={onNavigate} onNested={onNested} onChanged={reload} showBadges />
      ) : (
        <>
          {(b.created ?? []).length > 0 && (
            <>
              <h4>Angelegt</h4>
              <ul>
                {b.created!.map((c, i) => (
                  <li key={i} style={c.undone ? { textDecoration: 'line-through' } : undefined}>
                    {c.name} <span className="muted small">· {c.block}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="actions">
            <button className="btn secondary small" onClick={() => onNavigate(`werkstatt/${b.id}`)}>
              Öffnen
            </button>
            {b.undoable && (
              <button className="btn ghost small" onClick={async () => (await act(() => api.post(`/api/werkstatt/builds/${b.id}/undo`), 'Rückgängig gemacht')) && reload()}>
                <Icon name="undo" size={14} /> Alles rückgängig machen
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

// --- a plugin: preview and the three buttons ---------------------------------------------------------------------

interface PluginData {
  id: string;
  name: string;
  version: string;
  status: string;
  active_here: boolean;
  can_manage: boolean;
  entries: { page: { title: string } | null; panels: { id: string; title: string }[]; widgets: { id: string; title: string }[]; actions: { id: string; label: string }[]; jobs: { id: string; label: string }[] } | null;
  versions: { id: string; version: string; status: string; active: boolean; badges?: VersionBadgesData; diff?: DiffData | null }[];
}

function PluginPreview({ pluginId, onNavigate, onNested, onChanged, showBadges }: { pluginId: string; onNavigate: (to: string) => void; onNested: (id: string) => void; onChanged: () => void; showBadges: boolean }) {
  const r = useLoad(() => api.get<PluginData>(`/api/plugins/${pluginId}`), [pluginId]);
  const [gone, setGone] = useState(false);
  const [change, setChange] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const est = useLoad(() => (change ? api.get<{ typical_usd: number; max_usd: number }>('/api/werkstatt/estimate?kind=change') : Promise.resolve(undefined)), [change]);
  const p = r.data;
  useEffect(() => {
    window.dispatchEvent(new Event('pghl:agent-grew'));
  }, [p?.version, change, gone]);
  if (gone) return <p className="muted small">Verworfen – das Plugin ist gelöscht.</p>;
  if (r.loading && !p) return <Spinner />;
  if (!p) return <p className="muted small">{r.error || 'Das Plugin gibt es nicht mehr.'}</p>;
  const e = p.entries;
  const entry = e?.page ? { entry: 'page', title: e.page.title } : e?.widgets[0] ? { entry: `widget:${e.widgets[0].id}`, title: e.widgets[0].title } : e?.panels[0] ? { entry: `panel:${e.panels[0].id}`, title: e.panels[0].title, demo: true } : null;
  const active = p.versions.find((v) => v.active);
  const open = () => onNavigate(e?.page ? `plugin/${p.id}` : `werkstatt/plugins/${p.id}`);
  const send = async () => {
    setBusy(true);
    const x = await act(() => api.post<{ id: string }>(`/api/werkstatt/plugins/${p.id}/change`, { feedback: text.trim() }));
    setBusy(false);
    if (x) {
      setChange(false);
      setText('');
      onNested(x.id);
    }
  };
  const discard = async () => {
    if (!confirmAsk(`„${p.name}“ mit allen Versionen endgültig löschen?`)) return;
    if (await act(() => api.del(`/api/plugins/${p.id}`), 'Verworfen')) {
      void refreshPlugins();
      setGone(true);
      onChanged();
    }
  };
  const rollback = async () => {
    const x = await act(() => api.post<{ to: string }>(`/api/plugins/${p.id}/rollback`, {}));
    if (x) {
      toast(`Zurückgerollt auf Version ${x.to}`);
      void refreshPlugins();
      void r.reload();
    }
  };
  return (
    <>
      <p className="small" style={{ margin: '6px 0 0' }}>
        {p.name} · Version {p.version}
        {p.status !== 'active' && <> · <Badge tone="red">{p.status === 'killed' ? 'abgeschaltet' : p.status}</Badge></>}
      </p>
      {showBadges && <VersionBadges b={active?.badges} />}
      {entry && p.active_here && p.status === 'active' ? (
        <div className="wk-chat-preview" data-tour="agent-wk-preview">
          <PluginFrame key={`${p.id}:${p.version}`} pluginId={p.id} entry={entry.entry} demo={'demo' in entry ? entry.demo : undefined} height={240} title={entry.title} />
        </div>
      ) : (
        <p className="muted small">
          {entry ? 'Das Plugin ist gerade nicht aktiv.' : `Dieses Plugin hat keine Oberfläche – es läuft als ${[...(e?.actions ?? []).map((a) => `Automations-Schritt „${a.label}“`), ...(e?.jobs ?? []).map((j) => `Job „${j.label}“`)].join(', ') || 'Hintergrund-Logik'}.`}
        </p>
      )}
      <div className="actions" data-tour="agent-wk-actions">
        <button className="btn small" onClick={open}>
          <Icon name="play" size={14} /> Öffnen
        </button>
        {p.can_manage && p.status === 'active' && (
          <button className="btn secondary small" aria-expanded={change} onClick={() => setChange(!change)}>
            <Icon name="hammer" size={14} /> {NAMES.change}
          </button>
        )}
        {p.can_manage && p.versions.filter((v) => v.status === 'checked').length > 1 && (
          <button className="btn ghost small" onClick={rollback}>
            <Icon name="undo" size={14} /> Version zurück
          </button>
        )}
        {p.can_manage && (
          <button className="btn ghost small" onClick={discard}>
            Verwerfen
          </button>
        )}
      </div>
      {change && (
        <div style={{ marginTop: 8 }}>
          <Textarea value={text} onChange={setText} rows={3} placeholder="Was soll anders sein? z. B. Zeige die Karten dunkler und füge die Firma hinzu." />
          {est.data && <p className="muted small">Geschätzte KI-Kosten: etwa {usd(est.data.typical_usd)}, höchstens {usd(est.data.max_usd)}. Die bisherige Version bleibt erhalten.</p>}
          <div className="actions">
            <button className="btn small" disabled={busy || text.trim().length < 5} onClick={send}>
              <Icon name="hammer" size={14} /> Neue Version bauen
            </button>
            <button className="btn ghost small" onClick={() => setChange(false)}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** A tool result about a plugin only (status): the same preview and buttons, without an order. */
function PluginCard({ pluginId, cardId, onNavigate }: { pluginId: string; cardId: string; onNavigate: (to: string) => void }) {
  const mine = useClaim(`plugin:${pluginId}`, cardId);
  const [nested, setNested] = useState<string>();
  if (!mine) return null;
  return (
    <div className="wk-chat" data-tour="agent-wk-card">
      <PluginPreview pluginId={pluginId} onNavigate={onNavigate} onNested={setNested} onChanged={() => undefined} showBadges />
      {nested && <BuildCard buildId={nested} cardId={`${cardId}:nested`} onNavigate={onNavigate} />}
    </div>
  );
}
