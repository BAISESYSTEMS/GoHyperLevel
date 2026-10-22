import './tools.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../icons';
import { Modal, act, confirmAsk, toast } from '../ui';
import { tr, useT } from '../i18n';
import { issuesByStep, validateSteps, type Issue, type RuleMeta } from '../../../server/services/workflow-validate';
import { ISSUE_TEXT } from './issues';
import { copySteps, countSteps, pasteSteps, useClip, type ClipData } from './clipboard';
import { allIds, duplicateStep, findStep, insertAt, isWithin, moveStep, removeStep, togglePaused, type Slot, type Step } from './model';

/**
 * Builder tools both workflow editors share (list and canvas): the editor switch, copy/paste/duplicate/move/delete through one
 * context menu, pausing a step, and the validation issues on the steps. The canvas itself is a lazy chunk (WorkflowCanvas.tsx);
 * this file is small and loads with the workflow page. Docs: docs/workflow-actions.md.
 */

// --- editor switch ----------------------------------------------------------------------------------

export type EditorMode = 'list' | 'canvas';
const MODE_KEY = 'pghl.wf-editor';

export function useEditorMode(): [EditorMode, (m: EditorMode) => void] {
  const [mode, setMode] = useState<EditorMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'canvas' ? 'canvas' : 'list';
    } catch {
      return 'list';
    }
  });
  const set = useCallback((m: EditorMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* remembered for this visit only */
    }
  }, []);
  return [mode, set];
}

export function EditorToggle({ mode, onChange }: { mode: EditorMode; onChange: (m: EditorMode) => void }) {
  const t = useT('wfcanvas');
  const opts: [EditorMode, IconName, string][] = [
    ['list', 'list', t('Liste')],
    ['canvas', 'canvas', 'Canvas'],
  ];
  return (
    <div className="wfc-toggle" role="group" aria-label={t('Ansicht des Editors')} data-tour="wf-editor-toggle">
      {opts.map(([m, icon, label]) => (
        <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => onChange(m)}>
          <Icon name={icon} size={14} /> {label}
        </button>
      ))}
    </div>
  );
}

// --- validation --------------------------------------------------------------------------------------

/** Issues of the steps by step id, with the catalogue's field rules – empty while `shown` is false (before the first save). */
export function useIssues(steps: Step[] | undefined, actions: RuleMeta[] | undefined, shown: boolean): Record<string, Issue[]> {
  return useMemo(() => {
    if (!shown || !steps) return {};
    const metas = new Map((actions ?? []).map((a) => [a.type, a]));
    return issuesByStep(validateSteps(steps, (type) => metas.get(type)));
  }, [steps, actions, shown]);
}

export function useIssueText() {
  const t = useT('wfcanvas');
  return (i: Issue) => t(ISSUE_TEXT[i.code] ?? i.code, i.params);
}

export function IssueNote({ issues }: { issues?: Issue[] }) {
  const text = useIssueText();
  if (!issues?.length) return null;
  return (
    <ul className="wfc-issues" role="list">
      {issues.map((i, n) => (
        <li key={n}>
          <Icon name="fail" size={13} /> {text(i)}
        </li>
      ))}
    </ul>
  );
}

/** After a save: how many settings are still missing (the steps show them in red). */
export function announceIssues(n: number) {
  const t = tr('wfcanvas');
  if (n) toast(t.plural(n, { one: 'Eine Angabe fehlt noch – rot markiert', other: '{n} Angaben fehlen noch – rot markiert' }));
}

/** Activating with incomplete steps asks first (saving a draft never does). */
export function confirmActivate(stepsWithIssues: number): boolean {
  if (!stepsWithIssues) return true;
  const t = tr('wfcanvas');
  return confirmAsk(t.plural(stepsWithIssues, { one: 'Ein Schritt ist unvollständig und würde beim Ausführen fehlschlagen. Trotzdem aktivieren?', other: '{n} Schritte sind unvollständig und würden beim Ausführen fehlschlagen. Trotzdem aktivieren?' }));
}

// --- operations ----------------------------------------------------------------------------------------

export interface StepOps {
  workflowId: string;
  clip: ClipData | null;
  /** The step being moved (choose a target slot), or null. */
  moving: string | null;
  canMoveTo: (slot: Slot) => boolean;
  copy: (id: string) => Promise<void>;
  duplicate: (id: string) => void;
  startMove: (id: string) => void;
  cancelMove: () => void;
  moveTo: (slot: Slot) => void;
  remove: (id: string, ask?: boolean) => void;
  toggle: (id: string) => void;
  paste: (slot: Slot) => Promise<void>;
  warnings: string[];
  clearWarnings: () => void;
}

export function useStepOps({ workflowId, steps, onSteps, onSelect }: { workflowId: string; steps: Step[]; onSteps: (next: Step[]) => void; onSelect?: (id: string) => void }): StepOps {
  const t = useT('wfcanvas');
  const clip = useClip();
  const [moving, setMoving] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    if (!moving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMoving(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [moving]);
  return {
    workflowId,
    clip,
    moving,
    canMoveTo: (slot) => !!moving && !(slot.parent && isWithin(steps, slot.parent, moving)),
    copy: async (id) => {
      const step = findStep(steps, id);
      if (!step) return;
      const n = await act(() => copySteps(workflowId, [step]));
      if (n) toast(t.plural(n, { one: 'Schritt kopiert – in diesem oder einem anderen Workflow einfügen', other: '{n} Schritte kopiert – in diesem oder einem anderen Workflow einfügen' }));
    },
    duplicate: (id) => {
      const r = duplicateStep(steps, id);
      if (!r.copy) return;
      onSteps(r.steps);
      onSelect?.(r.copy.id);
    },
    startMove: (id) => setMoving(id),
    cancelMove: () => setMoving(null),
    moveTo: (slot) => {
      if (!moving) return;
      const next = moveStep(steps, moving, slot);
      setMoving(null);
      if (!next) return void toast(t('Ein Schritt kann nicht in sich selbst verschoben werden.'));
      onSteps(next);
      onSelect?.(moving);
    },
    remove: (id, ask = true) => {
      if (ask && !confirmAsk(t('Schritt entfernen?'))) return;
      onSteps(removeStep(steps, id));
    },
    toggle: (id) => onSteps(togglePaused(steps, id)),
    paste: async (slot) => {
      const r = await act(() => pasteSteps(workflowId, allIds(steps)));
      if (!r) return;
      onSteps(insertAt(steps, slot, r.steps));
      if (r.steps[0]) onSelect?.(r.steps[0].id);
      if (r.warnings.length) setWarnings(r.warnings);
      else toast(t.plural(countSteps(r.steps), { one: 'Schritt eingefügt – Speichern nicht vergessen', other: '{n} Schritte eingefügt – Speichern nicht vergessen' }));
    },
    warnings,
    clearWarnings: () => setWarnings([]),
  };
}

/** Banner while a step is being moved, and the warnings after a paste (e.g. a pipeline of another sub-account). */
export function StepOpsLayer({ ops, banner = true }: { ops: StepOps; banner?: boolean }) {
  const t = useT('wfcanvas');
  return (
    <>
      {banner && ops.moving && (
        <div className="wfc-move-banner" role="status">
          <Icon name="move" size={15} /> {t('Verschieben: an der gewünschten Stelle „Hierher verschieben“ wählen – Esc bricht ab.')}
          <button type="button" className="btn small secondary" onClick={ops.cancelMove}>
            {t('Abbrechen')}
          </button>
        </div>
      )}
      {ops.warnings.length > 0 && (
        <Modal title={t('Eingefügt – bitte prüfen')} onClose={ops.clearWarnings} footer={<button className="btn" onClick={ops.clearWarnings}>{t('Verstanden')}</button>}>
          <p className="muted">{t('Die Schritte sind eingefügt (noch nicht gespeichert). Diese Verweise gibt es hier nicht – bitte in den Schritten neu wählen:')}</p>
          <ul className="wfc-warn-list">
            {ops.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}

// --- menu ------------------------------------------------------------------------------------------------

export interface MenuItem {
  key: string;
  label: string;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A small menu at a point (kebab button or right click): arrow keys, Enter, Esc, a click outside closes it. */
export function PopMenu({ items, at, onClose, label }: { items: MenuItem[]; at: { x: number; y: number }; onClose: () => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({ preventScroll: true });
  }, [at.x, at.y]);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close();
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  });
  const close = () => {
    onClose();
    const o = opener.current as HTMLElement | null;
    if (o && document.contains(o)) o.focus({ preventScroll: true });
  };
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(box.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return createPortal(
    <div ref={box} className="wfc-menu" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className={it.danger ? 'danger' : ''}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.icon && <Icon name={it.icon} size={15} />}
          <span>{it.label}</span>
          {it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The context menu of a step: copy, duplicate, move, pause/resume, delete (plus `extra` items such as "Bearbeiten"). */
export function useStepMenu() {
  const t = useT('wfcanvas');
  const mod = isMac ? '⌘' : `${t('Strg')}+`;
  return (ops: StepOps, step: Step, extra: MenuItem[] = []): MenuItem[] => [
    ...extra,
    { key: 'copy', label: t('Kopieren'), icon: 'copy', hint: `${mod}C`, onSelect: () => void ops.copy(step.id) },
    { key: 'duplicate', label: t('Duplizieren'), icon: 'layers', hint: `${mod}D`, onSelect: () => ops.duplicate(step.id) },
    { key: 'move', label: t('Verschieben …'), icon: 'move', onSelect: () => ops.startMove(step.id) },
    { key: 'pause', label: step.disabled ? t('Fortsetzen') : t('Pausieren'), icon: step.disabled ? 'play' : 'pause', hint: 'P', onSelect: () => ops.toggle(step.id) },
    { key: 'delete', label: t('Löschen'), icon: 'trash', hint: t('Entf'), danger: true, onSelect: () => ops.remove(step.id) },
  ];
}

/** On/off switch of a step: off = paused, the engine skips it. */
export function PauseSwitch({ paused, onToggle, label }: { paused: boolean; onToggle: () => void; label?: string }) {
  const t = useT('wfcanvas');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!paused}
      className={`wfc-switch${paused ? ' off' : ''}`}
      title={paused ? t('Pausiert – wird übersprungen. Klicken zum Fortsetzen.') : t('Aktiv – klicken zum Pausieren (der Schritt wird dann übersprungen).')}
      aria-label={label ?? t('Schritt aktiv')}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <span />
    </button>
  );
}

/** List editor: the switch and the ⋮ menu of a step card. */
export function StepActions({ ops, step }: { ops: StepOps; step: Step }) {
  const t = useT('wfcanvas');
  const menu = useStepMenu();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      {step.disabled && <span className="wfc-paused-badge">{t('pausiert')}</span>}
      <PauseSwitch paused={!!step.disabled} onToggle={() => ops.toggle(step.id)} />
      <button
        type="button"
        className="icon-btn wfc-kebab"
        aria-label={t('Weitere Aktionen')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAt({ x: r.right - 190, y: r.bottom + 4 });
        }}
      >
        ⋮
      </button>
      {at && <PopMenu items={menu(ops, step)} at={at} label={t('Aktionen des Schritts')} onClose={() => setAt(null)} />}
    </>
  );
}

/** List editor: at an insert position – paste the clipboard here, or drop the step being moved. */
export function SlotTools({ ops, slot, children }: { ops: StepOps; slot: Slot; children?: ReactNode }) {
  const t = useT('wfcanvas');
  if (ops.moving) {
    return ops.canMoveTo(slot) ? (
      <div className="wf-add">
        <button type="button" className="btn small wfc-drop" onClick={(e) => (e.stopPropagation(), ops.moveTo(slot))}>
          <Icon name="move" size={14} /> {t('Hierher verschieben')}
        </button>
      </div>
    ) : null;
  }
  return (
    <div className="wfc-slot">
      {children}
      {ops.clip && (
        <button type="button" className="btn small ghost" title={ops.clip.source?.workflow ? t('Aus „{name}“', { name: ops.clip.source.workflow }) : undefined} onClick={(e) => (e.stopPropagation(), void ops.paste(slot))}>
          <Icon name="copy" size={14} /> {t.plural(countSteps(ops.clip.steps), { one: 'Einfügen', other: '{n} Schritte einfügen' })}
        </button>
      )}
    </div>
  );
}
