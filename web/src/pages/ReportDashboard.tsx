import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Check, Field, Input, Modal, Select, Spinner, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { Icon } from '../icons';
import { ReportView } from '../charts/ReportView';
import { useHeight, useWidth, type ReportResult, type Viz } from '../charts/core';
import { RangePicker, VISIBILITY, localResult, nextSlot, widgetSize, type Meta, type Query } from './ReportKit';
import { intlLocale, useT } from '../i18n';

// --- grid -----------------------------------------------------------------------------------------

const COLS = 12;
const ROW = 76;
const GAP = 12;

export interface Cell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const hit = (a: Cell, b: Cell) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Places `fixed` where it is, then lets every other cell rise as far as it can without overlapping. */
export function settle<T extends Cell>(cells: T[], fixedId?: string): T[] {
  const fixed = cells.find((c) => c.id === fixedId);
  const placed: T[] = fixed ? [fixed] : [];
  for (const c of cells.filter((x) => x !== fixed).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const n = { ...c };
    while (n.y > 0 && !placed.some((p) => hit({ ...n, y: n.y - 1 }, p))) n.y--;
    while (placed.some((p) => hit(n, p))) n.y++;
    placed.push(n);
  }
  return cells.map((c) => placed.find((p) => p.id === c.id)!);
}

/**
 * Lightweight dashboard grid: 12 columns, drag a card by its handle, resize from the corner; cells
 * snap to the grid and the others make room. On phones the cards simply stack.
 */
function Grid<T extends Cell>({ cells, edit, onChange, render }: { cells: T[]; edit: boolean; onChange: (c: T[]) => void; render: (c: T, handle: ReactNode, height: number) => ReactNode }) {
  const t = useT('reports');
  const [ref, width] = useWidth<HTMLDivElement>();
  const [live, setLive] = useState<T[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const list = live ?? cells;
  const colW = (width - GAP * (COLS - 1)) / COLS;
  const narrow = width > 0 && width < 640;

  const start = (e: React.PointerEvent, cell: T, mode: 'move' | 'size') => {
    if (!edit || narrow) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    let cur = cells;
    setActive(cell.id);
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - sx) / (colW + GAP));
      const dy = Math.round((ev.clientY - sy) / (ROW + GAP));
      const next =
        mode === 'move'
          ? { ...cell, x: Math.max(0, Math.min(COLS - cell.w, cell.x + dx)), y: Math.max(0, cell.y + dy) }
          : { ...cell, w: Math.max(2, Math.min(COLS - cell.x, cell.w + dx)), h: Math.max(2, Math.min(12, cell.h + dy)) };
      cur = settle(cells.map((c) => (c.id === cell.id ? next : c)), cell.id);
      setLive(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setActive(null);
      setLive(null);
      const done = settle(cur);
      if (JSON.stringify(done) !== JSON.stringify(cells)) onChange(done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Arrow keys move (with Shift: resize) the focused card – the keyboard way to arrange. */
  const key = (e: React.KeyboardEvent, cell: T) => {
    if (!edit || narrow) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const next = e.shiftKey ? { ...cell, w: Math.max(2, Math.min(COLS - cell.x, cell.w + d[0])), h: Math.max(2, Math.min(12, cell.h + d[1])) } : { ...cell, x: Math.max(0, Math.min(COLS - cell.w, cell.x + d[0])), y: Math.max(0, cell.y + d[1]) };
    onChange(settle(settle(cells.map((c) => (c.id === cell.id ? next : c)), cell.id)));
  };

  if (narrow) {
    return (
      <div ref={ref} className="rpt-stack">
        {[...list].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => {
          const h = Math.max(c.h, 2) * ROW + (Math.max(c.h, 2) - 1) * GAP;
          const tall = c.h <= 2 ? 132 : Math.min(h, 360);
          return (
            <div key={c.id} style={{ height: tall }}>
              {render(c, null, tall)}
            </div>
          );
        })}
      </div>
    );
  }
  const height = Math.max(1, ...list.map((c) => c.y + c.h)) * (ROW + GAP);
  return (
    <div ref={ref} className={`rpt-grid${edit ? ' edit' : ''}`} style={{ height }}>
      {width > 0 &&
        list.map((c) => {
          const h = c.h * ROW + (c.h - 1) * GAP;
          const handle = edit ? (
            <button type="button" className="rpt-handle" aria-label={t('Verschieben (Pfeiltasten, mit Umschalt: Größe)')} onPointerDown={(e) => start(e, c, 'move')} onKeyDown={(e) => key(e, c)}>
              <Icon name="grip" />
            </button>
          ) : null;
          return (
            <div key={c.id} className={`rpt-cell${active === c.id ? ' active' : ''}`} style={{ left: c.x * (colW + GAP), top: c.y * (ROW + GAP), width: c.w * colW + (c.w - 1) * GAP, height: h }}>
              {render(c, handle, h)}
              {edit && <span className="rpt-resize" onPointerDown={(e) => start(e, c, 'size')} aria-hidden="true" />}
            </div>
          );
        })}
    </div>
  );
}

// --- dashboard ------------------------------------------------------------------------------------

interface Widget extends Cell {
  title: string;
  config?: { viz: Viz; query: Query; fixed_range?: boolean };
  report_id?: string;
}

function WidgetCard({ w, data, handle, height, edit, onRemove, onRename, dashId, loading }: { w: Widget; data?: { result?: ReportResult; error?: string; viz?: Viz }; handle: ReactNode; height: number; edit: boolean; onRemove: () => void; onRename: (title: string) => void; dashId: string; loading: boolean }) {
  const t = useT('reports');
  const [table, setTable] = useState(false);
  const viz = (data?.viz ?? w.config?.viz ?? 'table') as Viz;
  const result = useMemo(() => (data?.result ? localResult(data.result) : undefined), [data?.result, t]);
  const [bodyRef, measured] = useHeight<HTMLDivElement>();
  const bodyH = measured || Math.max(60, height - 70);
  return (
    <div className={`card rpt-widget${loading ? ' loading' : ''}${viz === 'kpi' ? ' kpi' : ''}`}>
      <div className="rpt-widget-head">
        {handle}
        {edit ? <input className="rpt-widget-title-input" value={w.title} onChange={(e) => onRename(e.target.value)} aria-label={t('Titel')} /> : <h3 title={t(w.title)}>{t(w.title)}</h3>}
        <div className="rpt-widget-tools">
          {!edit && viz !== 'kpi' && viz !== 'table' && data?.result && (
            <button className="icon-btn" onClick={() => setTable(!table)} title={table ? t('Diagramm') : t('Tabelle')} aria-label={table ? t('Diagramm zeigen') : t('Tabelle zeigen')}>
              <Icon name={table ? 'vizBar' : 'vizTable'} size={15} />
            </button>
          )}
          {w.config && (
            <button className="icon-btn" onClick={() => navigate(`reports/new?dashboard=${dashId}&widget=${w.id}`)} title={t('Im Builder bearbeiten')} aria-label={t('Im Builder bearbeiten')}>
              <Icon name="edit" size={15} />
            </button>
          )}
          {w.report_id && !w.config && (
            <button className="icon-btn" onClick={() => navigate(`reports/r/${w.report_id}`)} title={t('Gespeicherten Bericht öffnen')} aria-label={t('Bericht öffnen')}>
              <Icon name="external" size={15} />
            </button>
          )}
          {edit && (
            <button className="icon-btn" onClick={onRemove} aria-label={t('Widget entfernen')} title={t('Entfernen')}>
              ✕
            </button>
          )}
        </div>
      </div>
      <div className="rpt-widget-body" ref={bodyRef}>
        {!data ? <Spinner /> : data.error ? <p className="rpt-error">{data.error}</p> : result ? <ReportView r={result} viz={viz} height={bodyH} table={table} /> : null}
      </div>
      {result && viz !== 'kpi' && <div className="rpt-widget-foot muted">{result.range.label}</div>}
      {result && viz === 'kpi' && <div className="rpt-widget-foot muted">{result.range.dates}</div>}
    </div>
  );
}

function ShareModal({ dash, onClose, onSaved, isDefault }: { dash: any; onClose: () => void; onSaved: () => void; isDefault: boolean }) {
  const t = useT('reports');
  const [vis, setVis] = useState(dash.visibility);
  return (
    <Modal
      title={t('Teilen')}
      onClose={onClose}
      footer={
        <button className="btn" disabled={!dash.is_owner} onClick={async () => (await act(() => api.patch(`/api/reports/dashboards/${dash.id}`, { visibility: vis }), t('Freigabe gespeichert'))) && (onSaved(), onClose())}>
          {t('Speichern')}
        </button>
      }
    >
      <Field label={t('Wer darf dieses Dashboard sehen?')} hint={t('Alle sehen nur Zahlen aus den Sub-Accounts und Bereichen, auf die sie selbst Zugriff haben.')}>
        <Select value={vis} onChange={setVis} options={VISIBILITY.map(([k, l]) => [k, t(l)] as [string, string])} />
      </Field>
      {!dash.is_owner && <p className="muted small">{t('Nur die Person, die das Dashboard angelegt hat, ändert die Freigabe.')}</p>}
      <hr />
      <button className="btn secondary" onClick={async () => (await act(() => api.put('/api/reports/default', { dashboard_id: isDefault ? null : dash.id }), isDefault ? t('Kein Standard mehr') : t('Ist jetzt dein Standard-Dashboard'))) && onSaved()}>
        <Icon name="pin" /> {isDefault ? t('Nicht mehr mein Standard') : t('Als mein Standard-Dashboard')}
      </button>
    </Modal>
  );
}

function ScheduleModal({ dash, onClose }: { dash: any; onClose: () => void }) {
  const t = useT('reports');
  const [s, setS] = useState({ frequency: 'weekly', weekday: '1', monthday: '1', hour: '8', recipients: '', range: '' });
  const save = async () => {
    const r = await act(() => api.post('/api/reports/schedules', { dashboard_id: dash.id, ...s, weekday: Number(s.weekday), monthday: Number(s.monthday), hour: Number(s.hour) }), t('Zeitplan angelegt'));
    if (r) onClose();
  };
  return <ScheduleForm title={t('Per E-Mail senden: {name}', { name: dash.name })} s={s} setS={setS} onClose={onClose} onSave={save} />;
}

export function ScheduleForm({ title, s, setS, onClose, onSave }: { title: string; s: any; setS: (s: any) => void; onClose: () => void; onSave: () => void }) {
  const t = useT('reports');
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onSave}>
          {t('Speichern')}
        </button>
      }
    >
      <div className="grid2">
        <Field label={t('Wie oft')}>
          <Select value={s.frequency} onChange={(frequency) => setS({ ...s, frequency })} options={[['daily', t('Täglich')], ['weekly', t('Wöchentlich')], ['monthly', t('Monatlich')]]} />
        </Field>
        {s.frequency === 'weekly' && (
          <Field label={t('Wochentag')}>
            <Select value={String(s.weekday)} onChange={(weekday) => setS({ ...s, weekday })} options={[t('Montag'), t('Dienstag'), t('Mittwoch'), t('Donnerstag'), t('Freitag'), t('Samstag'), t('Sonntag')].map((d, i) => [String(i + 1), d])} />
          </Field>
        )}
        {s.frequency === 'monthly' && (
          <Field label={t('Am')}>
            <Select value={String(s.monthday)} onChange={(monthday) => setS({ ...s, monthday })} options={Array.from({ length: 28 }, (_, i) => [String(i + 1), `${i + 1}.`])} />
          </Field>
        )}
        <Field label={t('Uhrzeit')}>
          <Select value={String(s.hour)} onChange={(hour) => setS({ ...s, hour })} options={Array.from({ length: 24 }, (_, i) => [String(i), `${i}:00 Uhr`])} />
        </Field>
        <Field label={t('Zeitraum im Bericht')}>
          <Select value={s.range} onChange={(range) => setS({ ...s, range })} options={[['', t('Passend (gestern / letzte Woche / letzter Monat)')], ['last_7_days', t('Letzte 7 Tage')], ['last_30_days', t('Letzte 30 Tage')], ['this_month', t('Dieser Monat')], ['last_month', t('Letzter Monat')], ['this_quarter', t('Dieses Quartal')], ['this_year', t('Dieses Jahr')]]} />
        </Field>
      </div>
      <Field label={t('Empfänger')} hint={t('E-Mail-Adressen, mit Komma getrennt. Versand über den E-Mail-Versand des Sub-Accounts.')}>
        <Input value={Array.isArray(s.recipients) ? s.recipients.join(', ') : s.recipients} onChange={(recipients) => setS({ ...s, recipients })} placeholder={t('chef@firma.de, vertrieb@firma.de')} />
      </Field>
    </Modal>
  );
}

function AddWidgetModal({ dashId, onClose, onAdd }: { dashId: string; onClose: () => void; onAdd: (w: { title: string; report_id: string; viz: Viz }) => void }) {
  const t = useT('reports');
  const { data } = useLoad(() => api.get('/api/reports/library'));
  return (
    <Modal title={t('Widget hinzufügen')} onClose={onClose}>
      <button className="btn" onClick={() => navigate(`reports/new?dashboard=${dashId}`)}>
        <Icon name="vizBar" /> {t('Neuen Bericht bauen')}
      </button>
      <h3 style={{ margin: '18px 0 8px' }}>{t('Aus der Bibliothek')}</h3>
      {!data ? (
        <Spinner />
      ) : data.length ? (
        <div className="rpt-pick">
          {data.map((r: any) => (
            <button key={r.id} className="rpt-pick-item" onClick={() => onAdd({ title: r.name, report_id: r.id, viz: r.config.viz })}>
              <strong>{r.name}</strong>
              <span className="muted small">{r.description || r.config.query.source}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">{t('Noch keine gespeicherten Berichte.')}</p>
      )}
    </Modal>
  );
}

/** One dashboard: filter row (range, sub-accounts, compare, refresh), grid of widgets, edit mode, TV mode. */
export function DashboardView({ id, meta, defaultId, onListChange, switcher }: { id: string; meta: Meta; defaultId: string | null; onListChange: () => void; switcher: ReactNode }) {
  const t = useT('reports');
  const [dash, setDash] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);
  const [filters, setFilters] = useState<{ range: Query['range']; scope: string; compare: boolean }>({ range: 'last_30_days', scope: 'location', compare: false });
  const [data, setData] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState(false);
  const [tv, setTv] = useState(false);
  const [modal, setModal] = useState<'' | 'share' | 'schedule' | 'add'>('');
  const [updated, setUpdated] = useState<Date | null>(null);
  const tvRef = useRef<HTMLDivElement>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const d = await api.get(`/api/reports/dashboards/${id}`).catch(() => null);
    if (!d) return setNotFound(true);
    setDash(d);
    setFilters({ range: d.settings?.range ?? 'last_30_days', scope: d.settings?.scope ?? 'location', compare: !!d.settings?.compare });
  }, [id]);
  useEffect(() => {
    setDash(null);
    setData({});
    setEdit(false);
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    if (!dash) return;
    setLoading(true);
    const qs = new URLSearchParams({ range: typeof filters.range === 'object' ? JSON.stringify(filters.range) : filters.range, scope: filters.scope });
    if (filters.compare) qs.set('compare', '1');
    try {
      const r = await api.get(`/api/reports/dashboards/${id}/data?${qs}`);
      setData(Object.fromEntries(r.widgets.map((w: any) => [w.id, w])));
      setUpdated(new Date());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dash?.id, dash?.updated_at, JSON.stringify(filters)]);
  useEffect(() => void refresh(), [refresh]);

  // Auto refresh (TV mode at least every minute).
  const every = tv ? Math.min(dash?.settings?.refresh || 60, 60) : dash?.settings?.refresh || 0;
  useEffect(() => {
    if (!every) return;
    const timer = setInterval(() => void refresh(), every * 1000);
    return () => clearInterval(timer);
  }, [every, refresh]);

  // TV mode = full screen; leaving full screen (Esc) ends it.
  useEffect(() => {
    if (!tv) return;
    void tvRef.current?.requestFullscreen?.().catch(() => {});
    const onFs = () => !document.fullscreenElement && setTv(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setTv(false);
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [tv]);

  if (notFound) return <p className="muted">{t('Dieses Dashboard gibt es nicht (mehr) oder es ist nicht für dich freigegeben.')}</p>;
  if (!dash) return <Spinner />;

  const saveWidgets = async (widgets: Widget[]) => {
    setDash({ ...dash, widgets });
    const r = await act(() => api.patch(`/api/reports/dashboards/${dash.id}`, { widgets }));
    if (r) setDash(r);
  };
  const setFilter = (patch: Partial<typeof filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    if (dash.can_edit) void api.patch(`/api/reports/dashboards/${dash.id}`, { settings: next }).catch(() => {});
  };
  const rename = (wid: string, title: string) => {
    const widgets = dash.widgets.map((w: Widget) => (w.id === wid ? { ...w, title } : w));
    setDash({ ...dash, widgets });
    if (renameTimer.current) clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(() => void api.patch(`/api/reports/dashboards/${dash.id}`, { widgets }).catch(() => {}), 600);
  };

  const grid = (
    <Grid<Widget>
      cells={dash.widgets}
      edit={edit && !tv}
      onChange={(cells) => void saveWidgets(cells)}
      render={(w, handle, h) => (
        <WidgetCard w={w} data={data[w.id]} handle={handle} height={h} edit={edit && !tv} dashId={dash.id} loading={loading} onRename={(title) => rename(w.id, title)} onRemove={() => void saveWidgets(dash.widgets.filter((x: Widget) => x.id !== w.id))} />
      )}
    />
  );

  if (tv) {
    return (
      <div ref={tvRef} className="rpt-tv">
        <div className="rpt-tv-head">
          <h1>{dash.name}</h1>
          <span className="muted">
            {meta.ranges[typeof filters.range === 'string' ? filters.range : ''] ?? t('Benutzerdefiniert')} {t('· aktualisiert')} {updated?.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <button className="icon-btn" onClick={() => setTv(false)} aria-label={t('TV-Modus beenden')}>
            ✕
          </button>
        </div>
        {grid}
      </div>
    );
  }

  return (
    <>
      <div className="rpt-dash-head" data-tour="report-dash-head">
        <div className="rpt-dash-title">
          {switcher}
          {defaultId === dash.id && <span className="badge blue">{t('Standard')}</span>}
          {dash.visibility !== 'private' && <span className="badge gray">{dash.visibility === 'team' ? 'Team' : t('Admins')}</span>}
        </div>
        <div className="actions">
          {dash.can_edit && (
            <button className={`btn small ${edit ? '' : 'secondary'}`} onClick={() => setEdit(!edit)}>
              <Icon name={edit ? 'ok' : 'edit'} /> {edit ? t('Fertig') : t('Bearbeiten')}
            </button>
          )}
          {edit && (
            <button className="btn small secondary" onClick={() => setModal('add')}>
              {t('+ Widget')}
            </button>
          )}
          <button className="btn small secondary" data-tour="report-share" onClick={() => setModal('share')}>
            <Icon name="social" /> {t('Teilen')}
          </button>
          <button className="btn small secondary" data-tour="report-schedule" onClick={() => setModal('schedule')}>
            <Icon name="schedule" /> {t('Per E-Mail')}
          </button>
          <button className="btn small secondary" onClick={() => setTv(true)}>
            <Icon name="tv" /> {t('TV-Modus')}
          </button>
          {(dash.is_owner || dash.can_edit) && edit && (
            <button
              className="btn small danger"
              onClick={async () => {
                if (!confirmAsk(t('Dashboard „{name}“ löschen?', { name: dash.name }))) return;
                if (await act(() => api.del(`/api/reports/dashboards/${dash.id}`), t('Dashboard gelöscht'))) {
                  onListChange();
                  navigate('reports');
                }
              }}
            >
              {t('Löschen')}
            </button>
          )}
        </div>
      </div>
      <div className="rpt-filters" data-tour="report-filters">
        <RangePicker value={filters.range} onChange={(range) => setFilter({ range })} ranges={meta.ranges} />
        {meta.canAgency && <Select value={filters.scope} onChange={(scope) => setFilter({ scope })} aria={t('Sub-Accounts')} options={[['location', t('Dieser Sub-Account')], ['all', t('Alle Sub-Accounts')]]} />}
        {dash.can_edit && (
          <Select
            aria={t('Auto-Update')}
            value={String(dash.settings?.refresh ?? 0)}
            onChange={async (v) => {
              const r = await act(() => api.patch(`/api/reports/dashboards/${dash.id}`, { settings: { refresh: Number(v) } }));
              if (r) setDash(r);
            }}
            options={[['0', t('Auto-Update aus')], ['60', t('Auto-Update: 1 Min.')], ['300', t('Auto-Update: 5 Min.')], ['900', t('Auto-Update: 15 Min.')], ['3600', t('Auto-Update: stündlich')]]}
          />
        )}
        <Check checked={filters.compare} onChange={(compare) => setFilter({ compare })} label={t('Mit Vorperiode')} />
        <button className="icon-btn" onClick={() => void refresh()} aria-label={t('Neu laden')} title={updated ? t('Aktualisiert {time}', { time: updated.toLocaleTimeString(intlLocale()) }) : t('Neu laden')}>
          <Icon name="refresh" />
        </button>
        {edit && <span className="muted small">{t('Ziehen am Griff verschiebt, die Ecke unten rechts ändert die Größe.')}</span>}
      </div>
      {dash.widgets.length ? (
        grid
      ) : (
        <div className="card empty">
          <p>{t('Noch keine Widgets auf diesem Dashboard.')}</p>
          {dash.can_edit && (
            <button className="btn" onClick={() => setModal('add')}>
              {t('+ Widget hinzufügen')}
            </button>
          )}
        </div>
      )}
      {modal === 'share' && <ShareModal dash={dash} isDefault={defaultId === dash.id} onClose={() => setModal('')} onSaved={() => (void load(), onListChange())} />}
      {modal === 'schedule' && <ScheduleModal dash={dash} onClose={() => setModal('')} />}
      {modal === 'add' && (
        <AddWidgetModal
          dashId={dash.id}
          onClose={() => setModal('')}
          onAdd={(w) => {
            setModal('');
            void saveWidgets([...dash.widgets, { id: '', title: w.title, report_id: w.report_id, x: 0, y: nextSlot(dash.widgets), ...widgetSize(w.viz) }]);
          }}
        />
      )}
    </>
  );
}
