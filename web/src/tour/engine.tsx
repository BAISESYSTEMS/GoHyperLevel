import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';
import { can, useSession, type Session } from '../session';
import { act, navigate } from '../ui';
import { JOURNEY, TOURS, composeSteps, resumeIndex, tourById, toursForPath, type Access, type RunStep } from './catalog';
import { academyState, clearActive, createSandbox, loadAcademy, saveProgress, useAcademy } from './progress';
import type { Tour } from './types';

/**
 * The tour layer: a dimmed backdrop with a cut-out around the highlighted element, a card with
 * the explanation and „Zurück / Weiter / Überspringen“, and the logic that waits for the person to
 * click, type, navigate or save. Mounted once in the app shell, so it survives page changes and
 * switching the sub-account.
 */


// --- the running tour (module store) ------------------------------------------------------------
let run: { id: string; index: number; nonce: number; resume?: boolean } | null = null;
const subs = new Set<() => void>();
const emitRun = () => subs.forEach((f) => f());
const useRunState = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => run);

/**
 * Start a tour; `step` is the index in the composed step list. Resuming goes back to the last step
 * that opens its own page, so the highlighted element is really there (a modal from an earlier
 * click is gone after a reload).
 */
export function startTour(id: string, step = 0, resume = step > 0) {
  if (!tourById(id)) return;
  run = { id, index: Math.max(0, step), nonce: Date.now(), resume };
  emitRun();
}
export const tourRunning = () => run?.id ?? null;

/** The „Lernen“ links (tour/learn.tsx): a tour id, or the first tour of a page that needs no admin rights – else the academy. */
export function learnHere(tourOrPath: string) {
  const t = tourById(tourOrPath) ?? toursForPath(tourOrPath, { admin: false, can: () => true })[0];
  if (t) startTour(t.id);
  else navigate('academy');
}

function stopTour() {
  run = null;
  emitRun();
}

export function accessOf(session: Pick<Session, 'user' | 'saas'>): Access {
  return { admin: session.user.role === 'admin', can: (p: string) => can(session, p) };
}

const sel = (key: string) => `[data-tour="${CSS.escape(key)}"]`;
const curPath = () => location.pathname.replace(/^\/app\/?/, '').replace(/\/+$/, '');
const onRoute = (route: string) => curPath() === route.replace(/^\/+|\/+$/g, '');
/** `contacts` = that page or below; `forms/` = any page below (e.g. the editor that opens after „Anlegen“). */
const startsRoute = (route: string) => {
  const p = curPath();
  const r = route.replace(/^\/+|\/+$/g, '');
  if (route.endsWith('/')) return p.startsWith(r + '/') && p.length > r.length + 1;
  return p === r || p.startsWith(r + '/');
};

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}

function findTarget(key: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(sel(key)));
  const hit = all.find(visible);
  if (hit) return hit;
  // Einfach-Modus folds secondary fields into <details class="more-fields"> (web/src/areas/fields.tsx): a step whose target
  // sits in a closed fold opens it instead of waiting for something nobody can see.
  const el = all.find((x) => x.closest('details.more-fields:not([open])'));
  if (!el) {
    // …and folded tabs ("+ 2 weitere Bereiche") unfold, so the next look finds the tab.
    const unfold = document.querySelector<HTMLElement>('[data-tour-unfold]');
    if (unfold && visible(unfold)) unfold.click();
    return null;
  }
  for (let d = el.closest<HTMLDetailsElement>('details.more-fields:not([open])'); d; d = d.parentElement?.closest<HTMLDetailsElement>('details.more-fields:not([open])') ?? null) d.open = true;
  return all.find(visible) ?? null;
}

function valueOf(el: Element | null): string {
  if (!el) return '';
  const input = el.matches('input, textarea, select') ? (el as HTMLInputElement) : el.querySelector<HTMLInputElement>('input:not([type=hidden]):not([type=checkbox]), textarea, select');
  if (!input) return (el as HTMLElement).isContentEditable ? (el.textContent ?? '').trim() : '';
  return String(input.value ?? '').trim();
}

/** Type into a React-controlled input (native setter + input event), for „Mach's für mich“. */
function typeInto(el: Element, value: string) {
  const input = el.matches('input, textarea') ? (el as HTMLInputElement) : el.querySelector<HTMLInputElement>('input:not([type=hidden]):not([type=checkbox]), textarea');
  const select = el.matches('select') ? (el as HTMLSelectElement) : el.querySelector('select');
  // A dropdown (e.g. the workflow trigger): pick the option by value, React listens to "change".
  if (select && (!input || el.matches('select'))) {
    if (![...select.options].some((o) => o.value === value)) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.focus();
    return;
  }
  if (!input) return;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.focus();
}

const isPhone = () => window.innerWidth < 640;

/** The element that scrolls around `el` (the page, a dialog body …), so the wheel still works over the dimmed area. */
function scrollParent(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const st = getComputedStyle(p);
    if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.querySelector<HTMLElement>('.main');
}

/** Opens the off-canvas menu on small screens when a step points into it (and closes it otherwise). */
function syncMenu(target: HTMLElement | null) {
  if (window.innerWidth > 860) return;
  const side = document.querySelector('.side');
  if (!side) return;
  const inside = !!target && side.contains(target);
  const open = side.classList.contains('open');
  if (inside !== open) document.querySelector<HTMLButtonElement>('.menu-btn')?.click();
}

/** `**fett**` and `{brand}` in tour texts. */
export function richText(text: string, brand: string): ReactNode[] {
  return text
    .replace(/\{brand\}/g, brand)
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>));
}

type Rect = { top: number; left: number; width: number; height: number };
const PAD = 6;

export function TourLayer() {
  const session = useSession();
  const r = useRunState();
  const academy = useAcademy();
  const access = useMemo(() => accessOf(session), [session.user, session.saas]);
  const tour = r ? tourById(r.id) : undefined;
  const steps = useMemo(() => (tour ? composeSteps(tour, access) : []), [tour, access]);
  const index = r ? Math.min(r.index, Math.max(0, steps.length - 1)) : 0;
  const step = steps[index];

  // Resume the tour that was running when the page was left (reload, new tab).
  useEffect(() => {
    void loadAcademy().then((s) => {
      if (s?.active && !run && tourById(s.active.tour)) startTour(s.active.tour, s.active.step, true);
    });
  }, []);
  useEffect(() => {
    if (!run?.resume || !steps.length) return;
    run = { ...run, index: resumeIndex(steps, run.index), resume: false };
    emitRun();
  }, [r?.nonce, steps.length]);

  const go = (to: number) => {
    if (!run || !tour) return;
    const i = Math.max(0, Math.min(to, steps.length - 1));
    run = { ...run, index: i };
    emitRun();
  };
  const next = () => go(index + 1);
  const close = () => {
    if (tour && index < steps.length - 1) void clearActive();
    stopTour();
  };

  // Save the position; the last card marks the tour as done.
  useEffect(() => {
    if (!tour || !step || r?.resume) return;
    if (step.special === 'outro') saveProgress(tour.id, index, steps.length, { done: true });
    else saveProgress(tour.id, index, steps.length, { active: true });
  }, [tour?.id, index, r?.resume]);

  useEffect(() => {
    if (!tour) return;
    document.body.classList.add('tour-on');
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog, popover or the e-mail designer is open: Esc closes that first, the tour stays.
      if (document.querySelector('.modal-bg, .help-pop, .switcher-pop, .menu-pop, .eb, .phone-panel')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.classList.remove('tour-on');
      window.removeEventListener('keydown', onKey, true);
    };
  }, [tour?.id, index, steps.length]);

  if (!tour || !step || r?.resume) return null;
  return createPortal(
    <StepView
      key={`${r!.nonce}-${index}`}
      tour={tour}
      steps={steps}
      index={index}
      step={step}
      session={session}
      sandbox={academy?.sandbox ?? null}
      onNext={next}
      onBack={() => go(index - 1)}
      onClose={close}
    />,
    document.body,
  );
}

function StepView({ tour, steps, index, step, session, sandbox, onNext, onBack, onClose }: { tour: Tour; steps: RunStep[]; index: number; step: RunStep; session: Session; sandbox: { id: string; name: string } | null; onNext: () => void; onBack: () => void; onClose: () => void }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; place: string } | null>(null);
  const kind = step.special ? 'info' : (step.kind ?? 'info');
  const advanced = useRef(false);
  const advance = () => {
    if (advanced.current) return;
    advanced.current = true;
    onNext();
  };

  // Open the step's page, then wait for its element.
  useEffect(() => {
    let alive = true;
    if (step.route && !onRoute(step.route)) navigate(step.route);
    if (!step.target) {
      syncMenu(null);
      return;
    }
    let startedAt = Date.now();
    let scrolled = false;
    const look = () => {
      if (!alive) return;
      // A page still loading its chunk (lazy route, skeleton on screen) does not count as missing.
      if (document.querySelector('[data-suspense]')) startedAt = Date.now();
      const found = findTarget(step.target!);
      if (found) {
        syncMenu(found);
        setMissing(false);
        setEl(found);
        if (!scrolled) {
          scrolled = true;
          const b = found.getBoundingClientRect();
          const bottomSpace = isPhone() ? window.innerHeight * 0.48 : 24;
          if (b.top < 70 || b.bottom > window.innerHeight - bottomSpace) found.scrollIntoView({ block: isPhone() ? 'start' : 'center', behavior: 'smooth' });
        }
        return;
      }
      setEl(null);
      if (Date.now() - startedAt > 6000) setMissing(true);
      timer = window.setTimeout(look, 150);
    };
    let timer = window.setTimeout(look, step.route ? 120 : 30);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // Follow the element while it moves (scrolling, layout changes, re-renders).
  useEffect(() => {
    if (!step.target) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      let cur = el;
      if (!cur || !cur.isConnected || !visible(cur)) cur = findTarget(step.target!);
      if (cur !== el && cur) setEl(cur);
      if (cur) {
        const b = cur.getBoundingClientRect();
        const key = `${Math.round(b.top)},${Math.round(b.left)},${Math.round(b.width)},${Math.round(b.height)}`;
        if (key !== last) {
          last = key;
          setRect({ top: b.top, left: b.left, width: b.width, height: b.height });
        }
      } else if (last) {
        last = '';
        setRect(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el]);

  // Wait for the person to act.
  useEffect(() => {
    const key = step.target;
    const within = (t: EventTarget | null) => !!key && t instanceof Element && !!t.closest(sel(key));
    const offs: (() => void)[] = [];
    if (kind === 'click' && key) {
      const h = (e: MouseEvent) => within(e.target) && window.setTimeout(advance, 80);
      document.addEventListener('click', h, true);
      offs.push(() => document.removeEventListener('click', h, true));
    }
    if (kind === 'fill' && key) {
      // A dropdown always has a value – there the step is done once the suggested option is picked.
      const filled = () => {
        const t = findTarget(key);
        const v = valueOf(t);
        const isSelect = !!t && (t.matches('select') || (!!t.querySelector('select') && !t.querySelector('input:not([type=hidden]):not([type=checkbox]), textarea')));
        return isSelect && step.demo?.fill !== undefined ? v === step.demo.fill : !!v;
      };
      const check = () => setDone(filled());
      check();
      const onInput = (e: Event) => within(e.target) && check();
      const onChange = (e: Event) => within(e.target) && filled() && window.setTimeout(advance, 150);
      document.addEventListener('input', onInput, true);
      document.addEventListener('change', onChange, true);
      offs.push(() => (document.removeEventListener('input', onInput, true), document.removeEventListener('change', onChange, true)));
    }
    if ((kind === 'navigate' && step.to) || (kind === 'wait' && step.wait?.route)) {
      const to = (step.to ?? step.wait!.route)!;
      const check = () => startsRoute(to) && window.setTimeout(advance, 250);
      const t = window.setInterval(check, 250);
      window.addEventListener('pghl:nav', check);
      offs.push(() => (clearInterval(t), window.removeEventListener('pghl:nav', check)));
    }
    if (kind === 'wait' && step.wait?.appear) {
      const appear = step.wait.appear;
      const t = window.setInterval(() => findTarget(appear) && advance(), 250);
      offs.push(() => clearInterval(t));
    }
    if (kind === 'wait' && step.wait?.toast) {
      const want = step.wait.toast;
      const seen = new Set(document.querySelectorAll('.toast'));
      const mo = new MutationObserver(() => {
        for (const t of Array.from(document.querySelectorAll('.toast.ok'))) {
          if (seen.has(t)) continue;
          seen.add(t);
          if (want === true || (t.textContent ?? '').toLowerCase().includes(want.toLowerCase())) {
            setDone(true);
            window.setTimeout(advance, 700);
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      offs.push(() => mo.disconnect());
    }
    return () => offs.forEach((f) => f());
  }, [kind]);

  // Place the card next to the element (or as a bottom sheet on phones).
  useLayoutEffect(() => {
    const c = card.current;
    if (!c) return;
    if (isPhone() || !rect) {
      setPos(null);
      return;
    }
    const w = c.offsetWidth;
    const h = c.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 14;
    const hole = { top: rect.top - PAD, left: rect.left - PAD, bottom: rect.top + rect.height + PAD, right: rect.left + rect.width + PAD };
    const fits = {
      bottom: vh - hole.bottom >= h + gap + 8,
      top: hole.top >= h + gap + 8,
      right: vw - hole.right >= w + gap + 8,
      left: hole.left >= w + gap + 8,
    };
    const order = step.placement && step.placement !== 'auto' ? [step.placement, 'bottom', 'top', 'right', 'left'] : ['bottom', 'top', 'right', 'left'];
    const place = order.find((p) => fits[p as keyof typeof fits]) ?? 'over';
    const clampX = (x: number) => Math.max(8, Math.min(x, vw - w - 8));
    const clampY = (y: number) => Math.max(8, Math.min(y, vh - h - 8));
    const cx = rect.left + rect.width / 2 - w / 2;
    const cy = rect.top + rect.height / 2 - h / 2;
    const p =
      place === 'bottom'
        ? { top: hole.bottom + gap, left: clampX(cx) }
        : place === 'top'
          ? { top: hole.top - gap - h, left: clampX(cx) }
          : place === 'right'
            ? { top: clampY(cy), left: hole.right + gap }
            : place === 'left'
              ? { top: clampY(cy), left: hole.left - gap - w }
              : { top: vh - h - 16, left: clampX(vw - w - 16) };
    setPos((old) => (old && Math.abs(old.top - p.top) < 1 && Math.abs(old.left - p.left) < 1 && old.place === place ? old : { ...p, place }));
  }, [rect, missing, done, busy]);

  const brand = session.branding.name || 'HyperLevel';
  const last = index === steps.length - 1;
  const inSandbox = !!sandbox && session.locationId === sandbox.id;
  const waiting = !done && (kind === 'click' || kind === 'navigate' || kind === 'fill' || kind === 'wait');
  const hole = rect ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } : null;
  const nextTour = tour.next ? tourById(tour.next) : undefined;

  const doIt = () => {
    const t = step.target ? findTarget(step.target) : null;
    if (!t || !step.demo) return;
    if (step.demo.fill !== undefined) typeInto(t, step.demo.fill);
    if (step.demo.click) t.click();
  };
  const weiter = () => {
    // „Weiter“ on a navigate step opens the page for you – unless it is „any sub-page“ (e.g. the editor after „Anlegen“).
    if (kind === 'navigate' && step.to && !step.to.endsWith('/') && !startsRoute(step.to)) navigate(step.to);
    advance();
  };
  const toSandbox = async () => {
    setBusy(true);
    try {
      const sb = sandbox ?? (await act(() => createSandbox()));
      if (!sb) return;
      // A new sub-account must be in the session's list before switching to it.
      if (!session.locations.some((l) => l.id === sb.id)) await session.reload();
      const first = steps.find((s) => s.route)?.route;
      session.switchLocation(sb.id, first);
      advance();
    } finally {
      setBusy(false);
    }
  };
  const skipChapter = () => {
    if (nextTour) {
      void clearActive();
      startTour(nextTour.id, 0);
    } else onClose();
  };

  const touchY = useRef(0);
  const scrollBy = (dx: number, dy: number) => scrollParent(el)?.scrollBy({ left: dx, top: dy });
  const pass = {
    onWheel: (e: React.WheelEvent) => scrollBy(e.deltaX, e.deltaY),
    onTouchStart: (e: React.TouchEvent) => void (touchY.current = e.touches[0]?.clientY ?? 0),
    onTouchMove: (e: React.TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      scrollBy(0, touchY.current - y);
      touchY.current = y;
    },
  };

  return (
    <div className="tour-layer" aria-live="polite">
      {hole ? (
        <>
          <div className="tour-block" {...pass} style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className="tour-block" {...pass} style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          <div className="tour-block" {...pass} style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div className="tour-block" {...pass} style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
          <div className={`tour-hole${kind !== 'info' ? ' act' : ''}`} style={hole} />
        </>
      ) : (
        <div className="tour-dim" {...pass} />
      )}
      <div
        ref={card}
        className={`tour-card${pos ? '' : rect && !isPhone() ? ' corner' : ' center'}${isPhone() ? ' sheet' : ''}`}
        style={pos && !isPhone() ? { top: pos.top, left: pos.left } : undefined}
        role="dialog"
        aria-label={step.title}
      >
        <div className="tour-head">
          <span className="tour-kicker">
            <Icon name={tour.icon} size={14} /> {tour.chapter ? `Kapitel ${tour.chapter} · ` : ''}
            {tour.title}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Tour schließen" title="Schließen (Esc)">
            ✕
          </button>
        </div>
        <h3>{step.title}</h3>
        <p className="tour-text">{richText(step.text, brand)}</p>

        {step.special === 'context' && (
          <div className="tour-context">
            {inSandbox ? (
              <p className="tour-ok">
                <Icon name="ok" size={15} /> Du bist schon in der Übungs-Firma – perfekt.
              </p>
            ) : (
              <>
                <button className="btn" disabled={busy} onClick={toSandbox}>
                  <Icon name="academy" size={15} /> {sandbox ? 'In die Übungs-Firma wechseln' : 'Übungs-Firma anlegen & wechseln'}
                </button>
                <button className="btn ghost small" onClick={advance}>
                  Hier im aktuellen Account weiter
                </button>
              </>
            )}
          </div>
        )}

        {step.special === 'outro' && (
          <div className="tour-outro">
            <ul>
              {tour.learned.map((l, i) => (
                <li key={i}>
                  <Icon name="ok" size={15} /> {richText(l, brand)}
                </li>
              ))}
            </ul>
            {tour.docs && (
              <a
                href={`/app/academy/docs/${tour.docs.file}${tour.docs.anchor ? `#${tour.docs.anchor}` : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  onClose();
                  navigate(`academy/docs/${tour.docs!.file}${tour.docs!.anchor ? `#${tour.docs!.anchor}` : ''}`);
                }}
              >
                <Icon name="doc" size={14} /> Mehr dazu: {tour.docs.label}
              </a>
            )}
          </div>
        )}

        {step.do && !step.special && (
          <div className={`tour-do${done ? ' done' : ''}`}>
            <span className="tour-do-icon">{done ? <Icon name="ok" size={16} /> : '👉'}</span>
            <span>{richText(step.do, brand)}</span>
          </div>
        )}
        {waiting && !missing && <div className="tour-wait">{kind === 'fill' ? 'Tippe einfach los – oder klick auf „Weiter“.' : kind === 'wait' ? 'Ich warte, bis es geklappt hat …' : 'Ich warte auf deinen Klick … oder „Weiter“.'}</div>}
        {missing && step.target && <div className="tour-missing">{step.missing ?? 'Das markierte Element ist hier gerade nicht zu sehen (vielleicht ist die Liste noch leer oder der Bereich nicht eingerichtet). Kein Problem – du kannst einfach weitermachen.'}</div>}
        {step.demo && el && !done && (
          <button className="btn small secondary tour-demo" onClick={doIt}>
            <Icon name="sparkles" size={14} /> {step.demo.label ?? 'Mach’s für mich'}
          </button>
        )}

        <div className="tour-foot">
          <div className="tour-prog">
            <div className="tour-bar">
              <div style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
            </div>
            <span className="muted small">
              {index + 1}/{steps.length}
            </span>
          </div>
          <div className="tour-btns">
            {!last && (
              <button className="btn ghost small" onClick={skipChapter} title={nextTour ? 'Zum nächsten Kapitel springen' : 'Tour beenden – Fortschritt bleibt gespeichert'}>
                Überspringen
              </button>
            )}
            {index > 0 && !last && (
              <button className="btn secondary small" onClick={onBack}>
                Zurück
              </button>
            )}
            {last ? (
              <>
                {nextTour && (
                  <button className="btn small" onClick={() => startTour(nextTour.id, 0)}>
                    Weiter: Kapitel {nextTour.chapter} →
                  </button>
                )}
                <button className={`btn small${nextTour ? ' secondary' : ''}`} onClick={onClose}>
                  Fertig
                </button>
              </>
            ) : step.special === 'context' && !inSandbox ? null : (
              <button className={`btn small${waiting ? ' secondary' : ''}`} onClick={weiter} autoFocus>
                Weiter →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Dev/test helper: the browser screenshot script checks every step's element against the real pages. */
declare global {
  interface Window {
    __pghlTours?: { tours: Tour[]; journey: Tour[]; start: typeof startTour; state: typeof academyState };
  }
}
if (typeof window !== 'undefined') window.__pghlTours = { tours: TOURS, journey: JOURNEY, start: startTour, state: academyState };
