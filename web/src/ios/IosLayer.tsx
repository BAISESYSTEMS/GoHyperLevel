import { RefreshCw } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Modal } from '../ui';
import { InstallSheet } from './InstallSheet';
import { HOLD_HINT_MS, matchShortcut, modKey, primaryAction, shortcutRows } from './shortcuts';
import { keepStorage } from './viewport';
import './ios-sheet.css';

/**
 * The parts of the iPhone/iPad/foldable experience that can wait for the first screen (a chunk of their own): the install sheet,
 * the hardware-keyboard shortcuts with their overview (⌘/ , or hold ⌘ for a second), and pull-to-refresh in the installed app.
 */

const mod = () => modKey(navigator.platform ?? '', navigator.userAgent);

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const m = mod();
  return (
    <Modal title="Tastaturkürzel" onClose={onClose} className="kb-sheet">
      <table className="kb-table" data-tour="shortcuts-sheet">
        <tbody>
          {shortcutRows(m).map((g) => (
            <Fragment key={g.group}>
              <tr>
                <th colSpan={2}>{g.group}</th>
              </tr>
              {g.rows.map((r) => (
                <tr key={g.group + r.keys}>
                  <td>
                    <kbd>{r.keys}</kbd>
                  </td>
                  <td>{r.text}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/** ⌘N → the page's main action, ⌘/ → the overview; holding ⌘ (or Strg) for about a second shows the short list. */
function Shortcuts() {
  const [help, setHelp] = useState(false);
  const [hint, setHint] = useState(false);
  useEffect(() => {
    let hold = 0;
    const stop = () => {
      clearTimeout(hold);
      setHint(false);
    };
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'Meta' || e.key === 'Control') && !e.repeat) {
        clearTimeout(hold);
        hold = window.setTimeout(() => setHint(true), HOLD_HINT_MS);
        return;
      }
      stop();
      const s = matchShortcut(e);
      if (s === 'help') {
        e.preventDefault();
        setHelp((v) => !v);
      } else if (s === 'new') {
        const el = primaryAction(document);
        if (el) {
          e.preventDefault();
          el.click();
        }
      }
    };
    const up = (e: KeyboardEvent) => (e.key === 'Meta' || e.key === 'Control') && stop();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    return () => {
      clearTimeout(hold);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
    };
  }, []);
  const m = mod();
  return (
    <>
      {hint && !help && (
        <div className="kb-hint" role="status">
          {shortcutRows(m)[0].rows.slice(0, 5).map((r) => (
            <div key={r.keys}>
              <kbd>{r.keys}</kbd>
              <span>{r.text}</span>
            </div>
          ))}
        </div>
      )}
      {help && <ShortcutSheet onClose={() => setHelp(false)} />}
    </>
  );
}

/** Pages with their own gestures or scroll areas: no pull-to-refresh there. */
const PTR_OFF = /^\/app\/(canvas|workspace|boards|wiki|team-chat|werkstatt|video-studio|ki-studio|funnels\/|forms\/|workflows\/|campaigns\/.|courses\/.)/;
const PTR_SKIP = '.modal-bg, textarea, input, select, canvas, iframe, [contenteditable="true"], [data-no-ptr], .kanban, .agent-panel, .tour-layer';
const TRIGGER = 64;

/** True when nothing between the touched element and the page scrolls (or is scrolled down): the pull is meant for the page. */
function atTop(target: Element | null, main: Element): boolean {
  for (let el: Element | null = target; el && el !== main.parentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (scrolls && el.scrollTop > 0) return false;
  }
  return true;
}

/** The installed app on iOS has no pull-to-refresh of its own: pull the page down and it loads again (the same as after an undo). */
function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const state = useRef({ y: 0, on: false, dy: 0 });
  useEffect(() => {
    if (document.documentElement.dataset.standalone !== '1') return;
    const s = state.current;
    const start = (e: TouchEvent) => {
      const main = document.querySelector('.main');
      const t = e.target as Element | null;
      s.on = false;
      if (!main || e.touches.length !== 1 || PTR_OFF.test(location.pathname) || t?.closest(PTR_SKIP) || document.documentElement.dataset.keyboard === 'open') return;
      if (main.scrollTop > 0 || !atTop(t, main)) return;
      s.y = e.touches[0].clientY;
      s.dy = 0;
      s.on = true;
    };
    const move = (e: TouchEvent) => {
      if (!s.on) return;
      s.dy = e.touches[0].clientY - s.y;
      if (s.dy <= 0) return void setPull(0);
      setPull(Math.min(s.dy * 0.5, 84));
    };
    const end = () => {
      if (!s.on) return;
      s.on = false;
      const fire = s.dy * 0.5 >= TRIGGER;
      setPull(0);
      if (fire) {
        setBusy(true);
        window.dispatchEvent(new Event('pghl:refresh'));
        window.setTimeout(() => setBusy(false), 900);
      }
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
  }, []);
  if (!pull && !busy) return null;
  return (
    <div className={`ptr${busy ? ' spin' : ''}`} style={{ opacity: busy ? 1 : Math.min(1, pull / 40), transform: busy ? undefined : `translateY(${pull - 40}px) rotate(${pull * 4}deg)` }} role="status" aria-label="Aktualisieren">
      <RefreshCw size={18} />
    </div>
  );
}

/**
 * A file dropped anywhere but on an upload area would make the browser open it and replace the app (an iPad lets you drag files out
 * of Files into the window). Upload areas handle their own drop (and mark it handled); everything else is told "not here".
 */
function useFileDropGuard() {
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);
}

export function IosLayer({ userId }: { userId: string }) {
  useEffect(() => keepStorage(), []);
  useFileDropGuard();
  return (
    <>
      <InstallSheet userId={userId} />
      <Shortcuts />
      <PullToRefresh />
    </>
  );
}
