import { useState, type ReactNode } from 'react';
import { AgentMarkdown } from '../agent/markdown';
import { fmt, type Format, type ReportResult, type Viz } from '../charts/core';
import { ReportView } from '../charts/ReportView';
import { ago, api } from '../api';
import { Icon } from '../icons';
import { Link, toastError } from '../ui';
import { PluginFrame } from '../werkstatt/PluginFrame';
import { ActionButtons } from './Actions';
import type { ListRow, NumberFormat, Tone, View } from './types';

/**
 * Draws the standard views a widget returns (server/services/boards-widgets.ts). A widget written by a module author
 * needs no browser code: it returns one of these and gets the same look, sizing and states as the built-in ones.
 */

const external = (url: string) => /^https:\/\//i.test(url);

/** An internal page ("contacts/<id>") or an https address. */
export function Go({ url, className, children, label }: { url?: string; className?: string; children: ReactNode; label?: string }) {
  if (!url) return <span className={className}>{children}</span>;
  if (external(url))
    return (
      <a href={url} className={className} target="_blank" rel="noopener noreferrer" aria-label={label}>
        {children}
      </a>
    );
  if (/^\/app(?:\/[A-Za-z0-9._~%-]+){0,5}(?:\?[A-Za-z0-9=&_.%+-]*)?$/.test(url) || /^[a-z0-9-]+(?:\/[A-Za-z0-9._~%-]+){0,4}(?:\?[A-Za-z0-9=&_.%+-]*)?$/.test(url))
    return (
      <Link to={url} className={className}>
        {children}
      </Link>
    );
  return <span className={className}>{children}</span>;
}

const show = (v: string | number | null | undefined, format?: NumberFormat) => (v === null || v === undefined ? '–' : typeof v === 'string' ? v : fmt(v, (format ?? 'number') as Format));
const tone = (t?: Tone) => (t ? ` tone-${t}` : '');

function NumberView({ v }: { v: Extract<View, { kind: 'number' }> }) {
  const d = v.delta;
  return (
    <Go url={v.url} className="bd-num-wrap">
      <div className={`bd-num${tone(v.tone)}`}>
        <b>{show(v.value, v.format)}</b>
        {v.label && <span className="bd-num-label">{v.label}</span>}
        {d !== null && d !== undefined && (
          <span className={`bd-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`} title="Veränderung zur Vorperiode">
            {d > 0 ? '▲' : d < 0 ? '▼' : '='} {Math.abs(d).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %
          </span>
        )}
        {v.hint && <span className="bd-hint">{v.hint}</span>}
      </div>
    </Go>
  );
}

function NumbersView({ v }: { v: Extract<View, { kind: 'numbers' }> }) {
  return (
    <Go url={v.url} className="bd-nums-wrap">
      <div className="bd-nums">
        {v.items.map((i, n) => (
          <div key={n} className={`bd-nums-item${tone(i.tone)}`}>
            <b>{show(i.value, i.format)}</b>
            <span>{i.label}</span>
          </div>
        ))}
      </div>
      {v.hint && <p className="bd-hint">{v.hint}</p>}
    </Go>
  );
}

function Check({ row }: { row: ListRow }) {
  const [done, setDone] = useState(!!row.check?.done);
  const [busy, setBusy] = useState(false);
  return (
    <input
      type="checkbox"
      className="bd-check"
      checked={done}
      disabled={busy}
      aria-label={`„${row.title}“ erledigt`}
      onChange={async (e) => {
        const next = e.target.checked;
        setDone(next);
        setBusy(true);
        try {
          await api.patch(`/api/tasks/${row.check!.task_id}`, { done: next });
        } catch (err) {
          setDone(!next);
          toastError(err);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function ListView({ v }: { v: Extract<View, { kind: 'list' }> }) {
  if (!v.rows.length) return <Quiet text={v.empty ?? 'Nichts zu zeigen.'} />;
  return (
    <div className="bd-list">
      <ul>
        {v.rows.map((r) => (
          <li key={r.id} className={r.check?.done ? 'done' : ''}>
            {r.check && <Check row={r} />}
            <Go url={r.url} className="bd-row">
              <span className="bd-row-main">
                <span className="bd-row-title">{r.title}</span>
                {r.subtitle && <span className="bd-row-sub">{r.subtitle}</span>}
              </span>
              <span className="bd-row-side">
                {r.badge && <span className={`bd-badge${tone(r.badge.tone)}`}>{r.badge.text}</span>}
                {(r.meta || r.at) && <span className="bd-row-meta">{r.meta ?? ago(r.at)}</span>}
              </span>
            </Go>
          </li>
        ))}
      </ul>
      {v.total !== undefined && v.total > v.rows.length && (
        <Go url={v.url} className="bd-more">
          Alle {v.total.toLocaleString('de-DE')} ansehen
        </Go>
      )}
    </div>
  );
}

function TableView({ v }: { v: Extract<View, { kind: 'table' }> }) {
  if (!v.rows.length) return <Quiet text={v.empty ?? 'Nichts zu zeigen.'} />;
  return (
    <div className="bd-table-wrap">
      <table className="bd-table">
        <thead>
          <tr>
            {v.columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.rows.map((r, i) => (
            <tr key={i}>
              {v.columns.map((c) => (
                <td key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                  {r[c.key] ?? '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {v.total !== undefined && v.total > v.rows.length && (
        <Go url={v.url} className="bd-more">
          Alle {v.total.toLocaleString('de-DE')} ansehen
        </Go>
      )}
    </div>
  );
}

function KanbanView({ v }: { v: Extract<View, { kind: 'kanban' }> }) {
  if (!v.columns.length) return <Quiet text={v.empty ?? 'Keine Phasen.'} />;
  return (
    <div className="bd-kanban">
      {v.columns.map((c) => (
        <section key={c.id} className="bd-kcol" aria-label={c.title}>
          <header>
            <b>{c.title}</b>
            <span className="bd-kcount">{c.count}</span>
            {c.sum !== undefined && c.sum > 0 && <span className="bd-ksum">{fmt(c.sum, 'money')}</span>}
          </header>
          <div className="bd-kcards">
            {c.cards.map((k) => (
              <Go key={k.id} url={k.url} className="bd-kcard">
                <span className="bd-row-title">{k.title}</span>
                {k.subtitle && <span className="bd-row-sub">{k.subtitle}</span>}
                {k.meta && <span className="bd-row-meta">{k.meta}</span>}
              </Go>
            ))}
            {c.count > c.cards.length && <span className="bd-hint">+ {c.count - c.cards.length} weitere</span>}
          </div>
        </section>
      ))}
    </div>
  );
}

function AgendaView({ v }: { v: Extract<View, { kind: 'agenda' }> }) {
  if (!v.days.length) return <Quiet text={v.empty ?? 'Keine Termine.'} />;
  return (
    <div className="bd-agenda">
      {v.days.map((d) => (
        <section key={d.date}>
          <h5>{d.label}</h5>
          <ul>
            {d.items.map((i) => (
              <li key={i.id}>
                <Go url={i.url} className="bd-row">
                  <span className={`bd-time${tone(i.tone)}`}>{i.time}</span>
                  <span className="bd-row-main">
                    <span className="bd-row-title">{i.title}</span>
                    {i.subtitle && <span className="bd-row-sub">{i.subtitle}</span>}
                  </span>
                </Go>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Embed({ url, title }: { url: string; title: string }) {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === location.origin;
  } catch {
    /* an invalid address is shown as locked by the server; nothing to do here */
  }
  // A frame of another origin keeps its own storage (players need it); our own origin never gets scripts + same-origin together.
  const sandbox = `allow-scripts allow-popups allow-forms allow-presentation${sameOrigin ? '' : ' allow-same-origin'}`;
  return <iframe className="bd-embed" src={url} title={title} sandbox={sandbox} referrerPolicy="no-referrer" loading="lazy" allow="fullscreen; picture-in-picture; clipboard-write" />;
}

export function Quiet({ text, icon = 'sparkles' }: { text: string; icon?: 'sparkles' | 'lock' }) {
  return (
    <div className="bd-quiet">
      <Icon name={icon} size={20} />
      <p>{text}</p>
    </div>
  );
}

/** One widget's content. `height` is the card's body height in pixels (charts need it). */
export function ViewBody({ view, title, height, onChanged }: { view: View; title: string; height: number; onChanged?: () => void }) {
  switch (view.kind) {
    case 'number':
      return <NumberView v={view} />;
    case 'numbers':
      return <NumbersView v={view} />;
    case 'report':
      return (
        <div className="bd-chart">
          <ReportView r={view.result as ReportResult} viz={view.viz as Viz} height={Math.max(90, height)} />
        </div>
      );
    case 'list':
      return <ListView v={view} />;
    case 'table':
      return <TableView v={view} />;
    case 'kanban':
      return <KanbanView v={view} />;
    case 'agenda':
      return <AgendaView v={view} />;
    case 'markdown':
      return view.text.trim() ? (
        <div className="bd-md">
          <AgentMarkdown text={view.text} />
        </div>
      ) : (
        <Quiet text="Die Notiz ist noch leer. Öffne die Einstellungen, um Text zu schreiben." />
      );
    case 'embed':
      return <Embed url={view.url} title={title} />;
    case 'actions':
      return <ActionButtons actions={view.actions} onDone={onChanged} />;
    case 'frame':
      return <PluginFrame pluginId={view.plugin_id} entry={view.entry} title={title} fill />;
    case 'message':
      return (
        <div className={`bd-message${tone(view.tone)}`}>
          <p>{view.text}</p>
          {view.action && (
            <Go url={view.action.url} className="btn secondary small">
              {view.action.label}
            </Go>
          )}
        </div>
      );
    case 'locked':
      return <Quiet text={view.reason} icon="lock" />;
    default:
      return <Quiet text="Dieses Widget lässt sich hier nicht darstellen." />;
  }
}

export function Skeleton() {
  return (
    <div className="bd-skel" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}
