import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { Modal, useFocusLayer } from '../ui';
import { useT } from '../i18n';
import type { Catalog } from '../pages/WorkflowTools';
import { validateSteps } from '../../../server/services/workflow-validate';
import { NOTE_COLORS, type CanvasNote, type NoteColor } from '../../../server/services/workflow-layout';
import { IssueNote, PauseSwitch, isMac } from './tools';
import type { LNode } from './layout';
import { allIds, type Step } from './model';

/**
 * Parts of the workflow canvas (WorkflowCanvas.tsx, same lazy chunk): the drawer with the step's or the trigger's form, sticky
 * notes, the minimap and the keyboard help.
 */

export type View = { x: number; y: number; z: number };
type RenderStep = (step: Step, set: (patch: any) => void) => ReactNode;
type RenderTrigger = (trigger: any, set: (trigger: any) => void) => ReactNode;

// --- drawer -----------------------------------------------------------------------------------------------

function Drawer({ title, icon, onCancel, onSave, dirty, children, extra }: { title: string; icon: IconName; onCancel: () => void; onSave: () => void; dirty: boolean; children: ReactNode; extra?: ReactNode }) {
  const t = useT('wfcanvas');
  const box = useRef<HTMLElement>(null);
  const close = () => (!dirty || window.confirm(t('Änderungen an diesem Schritt verwerfen?'))) && onCancel();
  useFocusLayer(box, close);
  return (
    <aside ref={box} className="wfc-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <header className="wfc-drawer-head">
        <Icon name={icon} size={18} />
        <h3>{title}</h3>
        {extra}
        <button type="button" className="icon-btn" onClick={close} aria-label={t('Schließen')}>
          ✕
        </button>
      </header>
      <div className="wfc-drawer-body">{children}</div>
      <footer className="wfc-drawer-foot">
        <button type="button" className="btn secondary" onClick={onCancel}>
          {t('Abbrechen')}
        </button>
        <button type="button" className="btn" onClick={onSave}>
          {t('Speichern')}
        </button>
      </footer>
    </aside>
  );
}

export function StepDrawer({ step, steps, cat, info, renderStep, onClose, onSave }: { step: Step; steps: Step[]; cat?: Catalog; info: (type: string) => [IconName, string]; renderStep: RenderStep; onClose: () => void; onSave: (s: Step) => void }) {
  const t = useT('wfcanvas');
  const [draft, setDraft] = useState<Step>(step);
  const [icon, label] = info(step.type);
  const issues = useMemo(() => {
    const metas = new Map((cat?.actions ?? []).map((a) => [a.type, a]));
    return validateSteps([draft], (type) => metas.get(type), new Set(allIds(steps))).filter((i) => i.step === draft.id);
  }, [draft, cat, steps]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(step);
  return (
    <Drawer
      title={label}
      icon={icon}
      dirty={dirty}
      onCancel={onClose}
      onSave={() => onSave(draft)}
      extra={<PauseSwitch paused={!!draft.disabled} onToggle={() => setDraft(({ disabled, ...rest }) => (disabled ? rest : { ...rest, disabled: true }))} />}
    >
      {draft.disabled && <p className="wfc-drawer-note">{t('Dieser Schritt ist pausiert: Der Ablauf überspringt ihn und schreibt das ins Protokoll.')}</p>}
      <IssueNote issues={issues} />
      {renderStep(draft, (patch) => setDraft((d) => ({ ...d, ...patch })))}
    </Drawer>
  );
}

export function TriggerDrawer({ trigger, renderTrigger, onClose, onSave }: { trigger: any; renderTrigger: RenderTrigger; onClose: () => void; onSave: (t: any) => void }) {
  const t = useT('wfcanvas');
  const [draft, setDraft] = useState(trigger);
  return (
    <Drawer title={t('Auslöser')} icon="trigger" dirty={JSON.stringify(draft) !== JSON.stringify(trigger)} onCancel={onClose} onSave={() => onSave(draft)}>
      {renderTrigger(draft, setDraft)}
    </Drawer>
  );
}

// --- sticky notes ------------------------------------------------------------------------------------------

const NOTE_LABEL: Record<NoteColor, string> = { yellow: 'Gelb', blue: 'Blau', green: 'Grün', pink: 'Rosa', purple: 'Lila' };

export function Note({ note, onChange, onRemove }: { note: CanvasNote; onChange: (p: Partial<CanvasNote>) => void; onRemove: () => void }) {
  const t = useT('wfcanvas');
  const next = NOTE_COLORS[(NOTE_COLORS.indexOf(note.color) + 1) % NOTE_COLORS.length];
  return (
    <div className={`wfc-note c-${note.color}`} data-note={note.id} style={{ left: note.x, top: note.y, width: note.w, height: note.h }}>
      <div className="wfc-note-bar" title={t('Ziehen zum Verschieben')}>
        <button type="button" className="wfc-nodrag wfc-note-color" onClick={() => onChange({ color: next })} aria-label={t('Farbe: {color} – wechseln zu {next}', { color: t(NOTE_LABEL[note.color]), next: t(NOTE_LABEL[next]) })} />
        <button type="button" className="wfc-nodrag icon-btn" onClick={onRemove} aria-label={t('Notiz löschen')}>
          ✕
        </button>
      </div>
      <textarea className="wfc-nodrag" value={note.text} onChange={(e) => onChange({ text: e.target.value.slice(0, 2000) })} placeholder={t('Notiz …')} aria-label={t('Notiz')} />
      <span className="wfc-note-resize" aria-hidden="true" />
    </div>
  );
}

// --- minimap --------------------------------------------------------------------------------------------------

export function Minimap({ nodes, notes, bounds, view, size, onCenter }: { nodes: LNode[]; notes: CanvasNote[]; bounds: { x: number; y: number; w: number; h: number }; view: View; size: { w: number; h: number }; onCenter: (x: number, y: number) => void }) {
  const W = 176;
  const H = 116;
  const pad = 60;
  const bx = bounds.x - pad;
  const by = bounds.y - pad;
  const s = Math.min(W / (bounds.w + pad * 2), H / (bounds.h + pad * 2));
  const ox = (W - (bounds.w + pad * 2) * s) / 2;
  const oy = (H - (bounds.h + pad * 2) * s) / 2;
  const mx = (x: number) => ox + (x - bx) * s;
  const my = (y: number) => oy + (y - by) * s;
  const ref = useRef<SVGSVGElement>(null);
  const toWorld = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onCenter((e.clientX - r.left - ox) / s + bx, (e.clientY - r.top - oy) / s + by);
  };
  return (
    <svg
      ref={ref}
      className="wfc-minimap"
      width={W}
      height={H}
      aria-hidden="true"
      onPointerDown={(e) => {
        (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        toWorld(e);
      }}
      onPointerMove={(e) => e.buttons && toWorld(e)}
    >
      {notes.map((n) => (
        <rect key={n.id} className="note" x={mx(n.x)} y={my(n.y)} width={n.w * s} height={n.h * s} rx={1} />
      ))}
      {nodes.map((n) => (
        <rect key={n.key} className={`k-${n.kind}${n.step?.disabled ? ' paused' : ''}`} x={mx(n.x)} y={my(n.y)} width={Math.max(2, n.w * s)} height={Math.max(2, n.h * s)} rx={1.5} />
      ))}
      <rect className="view" x={mx(-view.x / view.z)} y={my(-view.y / view.z)} width={(size.w / view.z) * s} height={(size.h / view.z) * s} />
    </svg>
  );
}

// --- keys --------------------------------------------------------------------------------------------------------

export function KeysHelp({ onClose }: { onClose: () => void }) {
  const t = useT('wfcanvas');
  const mod = isMac ? '⌘' : t('Strg');
  const rows: [string, string][] = [
    ['↑ ↓', t('Zum nächsten / vorigen Schritt im Ablauf')],
    ['← →', t('Zum nächsten Schritt daneben (andere Spur)')],
    [t('Umschalt + Pfeile'), t('Ansicht verschieben')],
    ['Enter', t('Schritt öffnen (Einstellungen rechts)')], // i18n-ignore – a key name
    ['+ / −', t('Zoomen')],
    ['0', t('Auf 100 %')],
    ['F', t('Alles einpassen')],
    ['P', t('Schritt pausieren / fortsetzen')],
    [`${mod}+C · ${mod}+V`, t('Schritt kopieren · nach dem gewählten Schritt einfügen')],
    [`${mod}+D`, t('Schritt duplizieren')],
    [t('Entf'), t('Schritt löschen')],
    ['N', t('Notiz anlegen')],
    [t('Umschalt + F10'), t('Menü des Schritts')],
    ['Esc', t('Verschieben abbrechen, Menü oder Seitenleiste schließen')], // i18n-ignore – a key name
  ];
  return (
    <Modal title={t('Tastenkürzel im Canvas')} onClose={onClose}>
      <p className="muted small">{t('Maus: Hintergrund ziehen verschiebt die Ansicht, Mausrad oder zwei Finger zoomen, Schritte und Notizen lassen sich ziehen. Rechtsklick öffnet das Menü.')}</p>
      <table className="t wfc-keys">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
