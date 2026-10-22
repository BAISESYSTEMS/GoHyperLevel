import { useMemo, useRef, useState } from 'react';
import { Icon } from '../icons';
import { MoveMenu } from '../xr/MoveMenu';
import { AvatarStack, DueChip, PriorityFlag, QuickAdd, applyFilters, fmtMinutes, isFiltered, neighbours, taskApi, todayIn, type Filters, type Meta, type ProjectDetail, type Task } from './PmKit';
import { useT } from '../i18n';

/** Board (Kanban): one column per status; drag a card to another column or to another place in its column. */

export function PmBoard({ project, tasks, filters, meta, reload, openTask }: { project: ProjectDetail; tasks: Task[]; filters: Filters; meta: Meta; reload: () => Promise<unknown>; openTask: (id: string) => void }) {
  const t = useT('pm');
  const tz = meta.timezone;
  const today = todayIn(tz);
  const [withSubs, setWithSubs] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: string; index: number } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const cols = useRef(new Map<string, HTMLDivElement>());

  const model = useMemo(() => {
    const rows = applyFilters(tasks, filters, tz, meta.me.id).filter((tk) => withSubs || !tk.parent_id);
    const first = project.statuses[0]?.id;
    const by = new Map<string, Task[]>(project.statuses.map((s) => [s.id, []]));
    for (const tk of rows) (by.get(tk.status_id ?? first ?? '') ?? by.get(first ?? '') ?? []).push(tk);
    for (const list of by.values()) list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    return by;
  }, [tasks, filters, tz, meta.me.id, withSubs, project.statuses]);

  const indexAt = (col: string, y: number, skip: string | null) => {
    const el = cols.current.get(col);
    if (!el) return 0;
    const cards = [...el.querySelectorAll<HTMLElement>('.pm-card')].filter((c) => c.dataset.id !== skip);
    let i = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y > r.top + r.height / 2) i++;
      else break;
    }
    return i;
  };

  const drop = async (col: string, index: number) => {
    const id = drag;
    setDrag(null);
    setOver(null);
    if (!id) return;
    const list = (model.get(col) ?? []).filter((tk) => tk.id !== id);
    if (!tasks.some((tk) => tk.id === id)) return;
    if (await taskApi.move(id, { status_id: col, ...neighbours(list, index) })) await reload();
  };

  const move = async (tk: Task, dir: -1 | 1) => {
    const i = project.statuses.findIndex((s) => s.id === tk.status_id);
    const next = project.statuses[i + dir];
    if (next && (await taskApi.move(tk.id, { status_id: next.id }))) await reload();
  };

  return (
    <div className="pm-boardview" data-tour="pm-board">
      <div className="pm-board-opts">
        <label className="check">
          <input type="checkbox" checked={withSubs} onChange={(e) => setWithSubs(e.target.checked)} /> {t('Unteraufgaben als Karten zeigen')}
        </label>
        {isFiltered(filters) && <span className="muted small">{t('Filter aktiv')}</span>}
        <span className="muted small pm-hint">{t('Karten ziehen zum Verschieben · Alt + ← / → verschiebt eine fokussierte Karte')}</span>
      </div>
      <div className="pm-board">
        {project.statuses.map((s) => {
          const list = model.get(s.id) ?? [];
          const minutes = list.reduce((n, tk) => n + (tk.estimate_minutes ?? 0), 0);
          const here = over?.col === s.id ? over.index : -1;
          const others = list.filter((tk) => tk.id !== drag);
          let seen = 0;
          return (
            <section
              key={s.id}
              className={`pm-col${here >= 0 ? ' over' : ''}`}
              aria-label={t.plural(list.length, { other: '{name}, {n} Aufgaben' }, { name: s.name })}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const index = indexAt(s.id, e.clientY, drag);
                if (over?.col !== s.id || over.index !== index) setOver({ col: s.id, index });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.col === s.id ? null : o));
              }}
              onDrop={(e) => {
                e.preventDefault();
                void drop(s.id, indexAt(s.id, e.clientY, drag));
              }}
            >
              <header className="pm-col-head" style={{ '--c': s.color } as React.CSSProperties} data-tour="pm-col-head">
                <i aria-hidden="true" />
                <strong>{s.name}</strong>
                <span className="muted small">{list.length}</span>
                {minutes > 0 && <span className="muted small">· {fmtMinutes(minutes)}</span>}
                <span className="grow" />
                <button type="button" className="icon-btn" aria-label={t('Aufgabe in „{name}“ hinzufügen', { name: s.name })} onClick={() => setAdding(adding === s.id ? null : s.id)}>
                  +
                </button>
              </header>
              <div className="pm-col-body" ref={(el) => void (el ? cols.current.set(s.id, el) : cols.current.delete(s.id))}>
                {adding === s.id && (
                  <QuickAdd
                    small
                    placeholder={t('Titel der Aufgabe')}
                    onAdd={async (title) => {
                      if (await taskApi.create({ title, project_id: project.id, status_id: s.id })) await reload();
                    }}
                  />
                )}
                {list.map((tk) => {
                  const showDrop = drag !== tk.id && here === seen;
                  if (drag !== tk.id) seen++;
                  return (
                  <div key={tk.id}>
                    {showDrop && <div className="pm-drop" aria-hidden="true" />}
                    <article
                      className={`pm-card${tk.done ? ' done' : ''}${drag === tk.id ? ' drag' : ''}`}
                      data-id={tk.id}
                      draggable
                      style={{ '--p': tk.priority >= 3 ? (tk.priority === 4 ? '#dc2626' : '#ea580c') : 'transparent' } as React.CSSProperties}
                      onDragStart={(e) => {
                        setDrag(tk.id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', tk.id);
                      }}
                      onDragEnd={() => (setDrag(null), setOver(null))}
                      onClick={(e) => !(e.target as HTMLElement).closest('input,select') && openTask(tk.id)}
                    >
                      {tk.parent_id && <div className="pm-card-parent muted small">↳ {tasks.find((x) => x.id === tk.parent_id)?.title}</div>}
                      <button
                        type="button"
                        className="pm-card-title"
                        onClick={(e) => (e.stopPropagation(), openTask(tk.id))}
                        onKeyDown={(e) => {
                          if (e.altKey && e.key === 'ArrowRight') (e.preventDefault(), void move(tk, 1));
                          if (e.altKey && e.key === 'ArrowLeft') (e.preventDefault(), void move(tk, -1));
                        }}
                      >
                        {tk.milestone && <Icon name="flag" size={12} />} {tk.title}
                      </button>
                      <MoveMenu what={t('Aufgabe „{title}“', { title: tk.title })} current={tk.status_id ?? project.statuses[0]?.id} targets={project.statuses.map((st) => ({ id: st.id, label: st.name }))} onMove={async (status) => ((await taskApi.move(tk.id, { status_id: status })) ? reload() : undefined)} />
                      {tk.tags.length > 0 && (
                        <div className="pm-chips">
                          {tk.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="pm-tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="pm-card-meta">
                        <DueChip task={tk} tz={tz} today={today} />
                        <PriorityFlag value={tk.priority} />
                        {tk.subtasks.total > 0 && (
                          <span className="pm-mini" title={t('Unteraufgaben')}>
                            <Icon name="layers" size={11} /> {tk.subtasks.done}/{tk.subtasks.total}
                          </span>
                        )}
                        {tk.checklists.length > 0 && (
                          <span className="pm-mini" title={t('Checkliste')}>
                            <Icon name="features" size={11} /> {tk.checklists.reduce((n, c) => n + c.items.filter((x) => x.done).length, 0)}/{tk.checklists.reduce((n, c) => n + c.items.length, 0)}
                          </span>
                        )}
                        {tk.blocked && (
                          <span className="pm-mini warn" title={t('Wartet auf eine andere Aufgabe')}>
                            <Icon name="lock" size={11} />
                          </span>
                        )}
                        <span className="grow" />
                        <AvatarStack people={tk.assignees} max={3} size={20} />
                      </div>
                    </article>
                  </div>
                  );
                })}
                {here >= 0 && here === others.length && <div className="pm-drop" aria-hidden="true" />}
                {!list.length && here < 0 && adding !== s.id && <div className="pm-col-empty muted small">{t('Keine Aufgaben')}</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
