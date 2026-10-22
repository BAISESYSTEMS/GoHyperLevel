import { useEffect, useRef, useState } from 'react';
import { currentLocation } from '../api';
import { Icon } from '../icons';
import { Empty, Link, PageHead, Spinner, navigate, toast, toastError, useRoute } from '../ui';
import { PluginIcon, useActivePlugins, type ActivePlugin } from './shared';
import { SortableGrid } from '../sortable/lazy';

/**
 * Shows a plugin's interface: our trusted host page (/plugin-host/<id>) in an iframe, which in turn embeds the
 * plugin's own sandboxed frame (sandbox="allow-scripts", no allow-same-origin). This component only listens to the
 * host page's messages (same origin, from that very iframe): resize, toast, navigate. Nothing of the session
 * is ever handed to the plugin.
 */

const NAV = /^[a-z0-9-]+(?:\/[A-Za-z0-9._~%-]+){0,4}(?:\?[A-Za-z0-9=&_.%+-]*)?$/;

function currentTheme(): { theme: 'light' | 'dark'; brand: string } {
  const attr = document.documentElement.getAttribute('data-theme');
  const dark = attr ? attr === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  return { theme: dark ? 'dark' : 'light', brand: /^#[0-9a-f]{6}$/i.test(brand) ? brand : '#2563eb' };
}

export function PluginFrame({ pluginId, entry, entity, height, demo, title, fill }: { pluginId: string; entry: string; entity?: { type: 'contact' | 'deal'; id: string }; height?: number; demo?: boolean; title: string; fill?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(height ?? (fill ? 0 : 160));
  const [dead, setDead] = useState('');
  const { theme, brand } = currentTheme();
  const src = `/plugin-host/${encodeURIComponent(pluginId)}?${new URLSearchParams({ locationId: currentLocation(), entry, theme, brand, ...(entity ? { entity: `${entity.type}:${entity.id}` } : {}), ...(demo ? { demo: '1' } : {}) })}`;
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== ref.current?.contentWindow) return;
      const m = e.data;
      if (!m || m.pghl !== 'plugin' || m.plugin !== pluginId) return;
      if (m.type === 'resize' && !height && !fill) setH(Math.max(60, Math.min(1600, Number(m.height) || 0)));
      else if (m.type === 'toast') (m.kind === 'error' ? toastError(String(m.text ?? '')) : toast(String(m.text ?? '')));
      else if (m.type === 'navigate' && typeof m.path === 'string' && NAV.test(m.path)) navigate(m.path);
      else if (m.type === 'dead') setDead(String(m.message ?? 'Das Plugin wurde beendet.'));
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [pluginId, height, fill]);
  return (
    <div className={`plugin-frame${fill ? ' fill' : ''}`} data-tour="plugin-frame">
      <iframe ref={ref} src={src} title={title} style={fill ? undefined : { height: h }} loading="lazy" />
      {dead && <p className="muted small">{dead}</p>}
    </div>
  );
}

/** Route `plugin/<id>`: a plugin's page in the menu. */
export function PluginPage() {
  const route = useRoute();
  const id = route[1];
  const plugins = useActivePlugins();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 1200);
    return () => clearTimeout(t);
  }, []);
  const p = plugins.find((x) => x.id === id);
  if (!p) return waited ? <Empty action={<Link to="marktplatz">Zum Marktplatz</Link>}>Dieses Plugin ist hier nicht aktiv.</Empty> : <Spinner />;
  return (
    <>
      <PageHead title={p.page?.title ?? p.name} sub={<>Plugin „{p.name}“ · Version {p.version}</>}>
        <Link to={`werkstatt/plugins/${p.id}`} className="btn secondary small">
          <Icon name="settings" size={14} /> Verwalten
        </Link>
      </PageHead>
      <PluginFrame key={p.id} pluginId={p.id} entry="page" title={p.name} fill />
    </>
  );
}

/** Panels of plugins on a contact or deal page. */
export function PluginPanels({ on, entityId }: { on: 'contact' | 'deal'; entityId: string }) {
  const plugins = useActivePlugins();
  const panels = plugins.flatMap((p: ActivePlugin) => p.panels.filter((x) => x.on === on).map((x) => ({ p, x })));
  if (!panels.length) return null;
  return (
    <div className="plugin-panels" data-tour="plugin-panels">
      {panels.map(({ p, x }) => (
        <div className="card plugin-panel" key={`${p.id}:${x.id}`}>
          <h3>
            <PluginIcon name={p.icon} size={15} /> {x.title}
          </h3>
          <PluginFrame pluginId={p.id} entry={`panel:${x.id}`} entity={{ type: on, id: entityId }} height={x.height ?? 220} title={x.title} />
        </div>
      ))}
    </div>
  );
}

/** Dashboard widgets of plugins. */
export function PluginWidgets() {
  const plugins = useActivePlugins();
  const widgets = plugins.flatMap((p) => p.widgets.map((x) => ({ p, x })));
  if (!widgets.length) return null;
  // in the person's own order, like every grid of tiles (web/src/sortable) – keepDom: shown with CSS `order`, so moving a
  // widget never moves (and reloads) an iframe
  return (
    <SortableGrid id="dashboard.widgets" className="plugin-widgets" data-tour="plugin-widgets" keepDom>
      {widgets.map(({ p, x }) => (
        <div className={`card plugin-widget s-${x.size ?? 'm'}`} key={`${p.id}:${x.id}`}>
          <h2>
            <PluginIcon name={p.icon} size={16} /> {x.title}
          </h2>
          <PluginFrame pluginId={p.id} entry={`widget:${x.id}`} title={x.title} />
        </div>
      ))}
    </SortableGrid>
  );
}

/** Menu entries below „Marktplatz“: the pages of the plugins that are on here. */
export function PluginNav({ cur }: { cur: string[] }) {
  const plugins = useActivePlugins().filter((p) => p.page);
  if (!plugins.length) return null;
  return (
    <div className="nav-sub" data-tour="plugin-nav">
      {plugins.map((p) => (
        <Link key={p.id} to={`plugin/${p.id}`} className={cur[0] === 'plugin' && cur[1] === p.id ? 'on' : ''}>
          <PluginIcon name={p.page?.icon ?? p.icon} size={15} /> {p.page?.title ?? p.name}
        </Link>
      ))}
    </div>
  );
}
