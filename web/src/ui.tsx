import { Children, Fragment, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { serverText, useT } from './i18n';
import { LearnLink } from './tour/learn';

// --- router --------------------------------------------------------------------
export const BASE = '/app';

// Arbeitsfläche (web/src/xr/Workspace.tsx, docs/xr.md): pages shown side by side. While one is open, a link or navigate() made
// from inside a panel opens in a panel (the hook returns true) and `RouteScope` hands each panel its own route to useRoute().
let navHook: ((to: string) => boolean) | null = null;
export const setNavHook = (fn: ((to: string) => boolean) | null) => void (navHook = fn);
export const RouteScope = createContext<string[] | null>(null);

export function navigate(to: string) {
  if (navHook?.(to)) return;
  history.pushState(null, '', to.startsWith('/') ? to : `${BASE}/${to}`);
  window.dispatchEvent(new Event('pghl:nav'));
}

export function useRoute(): string[] {
  const scoped = useContext(RouteScope);
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    window.addEventListener('pghl:nav', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('pghl:nav', on);
    };
  }, []);
  if (scoped) return scoped;
  return path.replace(new RegExp(`^${BASE}/?`), '').split('/').filter(Boolean);
}

export function Link({ to, children, className, tour, label }: { to: string; children: ReactNode; className?: string; tour?: string; label?: string }) {
  const href = to.startsWith('/') ? to : `${BASE}/${to}`;
  return (
    <a
      href={href}
      className={className}
      data-tour={tour}
      aria-label={label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

// --- data loading ---------------------------------------------------------------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fnRef.current());
      setError('');
    } catch (e) {
      setError(serverText((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

// --- toasts ---------------------------------------------------------------------
type Toast = { id: number; text: string; kind: 'ok' | 'err' };
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};
export const toast = (text: string) => pushToast({ text, kind: 'ok' });
export const toastError = (e: unknown) => pushToast({ text: serverText(e instanceof Error ? e.message : String(e)), kind: 'err' });

export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setList((l) => [...l, { ...t, id }]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.kind === 'err' ? 6000 : 3000);
    };
  }, []);
  // A live region: screen readers announce "Gespeichert" and errors without moving the focus (errors right away).
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : undefined}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Runs an async action with error toast and optional success message. */
export async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r;
  } catch (e) {
    toastError(e);
    return undefined;
  }
}

// --- building blocks --------------------------------------------------------------
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

// The elements that had the focus last. A dialog whose code is still loading hides the page for a moment (Suspense), which
// drops the focus to <body>, and a field with autoFocus takes it before the dialog looks – the dialog still finds the
// button that opened it and gives the focus back on close.
const focusTrail: HTMLElement[] = [];
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function')
  document.addEventListener('focusin', (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    focusTrail.push(e.target);
    if (focusTrail.length > 6) focusTrail.shift();
  }, true);
const openerOf = (box: HTMLElement | null) => {
  const active = document.activeElement as HTMLElement | null;
  for (const el of [active, ...[...focusTrail].reverse()]) if (el && el !== document.body && document.contains(el) && !box?.contains(el)) return el;
  return null;
};

/** The topmost layer that holds the keyboard (dialogs with aria-modal, the phone menu while it is open). */
const isTopLayer = (box: HTMLElement) => {
  const all = document.querySelectorAll('[aria-modal="true"]');
  return all[all.length - 1] === box;
};

/** Tab and Shift+Tab stay inside the topmost dialog (aria-modal): without this the focus walked on into the page behind the overlay. */
export function trapTab(e: KeyboardEvent, box: HTMLElement) {
  if (!isTopLayer(box)) return; // another dialog (or the palette) is on top of this one
  const a = document.activeElement as HTMLElement | null;
  const inside = !!a && box.contains(a);
  // A layer of its own with the focus (tour card, a popup in the body): leave it alone.
  if (!inside && a && a !== document.body) return;
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0);
  if (!items.length) return void (e.preventDefault(), box.focus());
  const [first, last] = [items[0], items[items.length - 1]];
  if (!inside || a === box) return void (e.preventDefault(), (e.shiftKey ? last : first).focus());
  if (e.shiftKey && a === first) return void (e.preventDefault(), last.focus());
  if (!e.shiftKey && a === last) return void (e.preventDefault(), first.focus());
}

/**
 * A layer that takes the keyboard while it is open (dialogs, the command palette, the phone menu): the focus moves in
 * (`first`: onto its first control – or the first match of a selector such as 'input, select, textarea' – else onto the
 * box itself), Tab stays inside, Esc closes only the topmost layer (unless a control inside used it, e.g. to close its
 * own list), and on close the focus goes back to what opened it.
 */
export function useFocusLayer(box: React.RefObject<HTMLElement | null>, onClose: () => void, { active = true, first = false }: { active?: boolean; first?: boolean | string } = {}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const el = box.current;
    const opener = openerOf(el);
    if (el && !el.contains(document.activeElement)) {
      const shown = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)].find((x) => x.getClientRects().length > 0);
      const target = first ? shown(typeof first === 'string' ? first : FOCUSABLE) : undefined;
      // a box without tabindex can't take the focus itself: then its first control does
      (target ?? (el.hasAttribute('tabindex') ? el : (shown(FOCUSABLE) ?? el))).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (!box.current) return;
      if (e.key === 'Escape') !e.defaultPrevented && isTopLayer(box.current) && close.current();
      else if (e.key === 'Tab') trapTab(e, box.current);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Makes a clickable row or card (a <tr>, a kanban card) reachable with Tab and opens it with Enter or Space, like a link.
 * Keys pressed in a control inside it (a checkbox, a menu) stay with that control.
 */
export function pressable(onPress: (e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => void) {
  return {
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      onPress(e);
    },
  };
}

export function Modal({ title, onClose, children, wide, footer, className }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; className?: string }) {
  const t = useT('core');
  const box = useRef<HTMLDivElement>(null);
  // Focus moves into the dialog and – after ✕, Esc or a click outside – back to what opened it; Esc in a dialog on top of
  // another one closes only the top one.
  useFocusLayer(box, onClose);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} data-tour="modal">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('Schließen')}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot" data-tour="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint, tour }: { label: string; children: ReactNode; hint?: ReactNode; tour?: string }) {
  return (
    <label className="field" data-tour={tour}>
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Input({ value, onChange, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & { value: string | number | undefined | null; onChange: (v: string) => void }) {
  return <input {...rest} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export function Textarea({ value, onChange, ...rest }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { value: string | undefined | null; onChange: (v: string) => void }) {
  return <textarea {...rest} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * `aria` names a select that has no visible label (a filter in a toolbar). Without `aria` and outside a <label> (Field), the
 * select is named after its placeholder ("Alle Tags", "Vorlage einfügen…") so screen readers never announce a bare "combo box".
 */
export function Select({ value, onChange, options, placeholder, aria }: { value: string | undefined | null; onChange: (v: string) => void; options: (string | [string, string])[]; placeholder?: string; aria?: string }) {
  const ref = useRef<HTMLSelectElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || aria) return;
    if (placeholder && !el.labels?.length && !el.hasAttribute('aria-labelledby')) el.setAttribute('aria-label', placeholder);
    else el.removeAttribute('aria-label');
  }, [aria, placeholder]);
  return (
    <select ref={ref} value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

/** `aria` names the box when `label` is empty (a checkbox in a table cell). */
export function Check({ checked, onChange, label, tour, aria }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; tour?: string; aria?: string }) {
  return (
    <label className="check" data-tour={tour}>
      <input type="checkbox" checked={!!checked} aria-label={aria} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map(([k, l]) => (
        <button key={k} className={k === value ? 'on' : ''} aria-pressed={k === value} onClick={() => onChange(k)} data-tour={`tab-${k}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** `learn`: a „Tour starten“ link next to the action (the tour of the open page, or the given tour id) – for the main areas. */
export function Empty({ children, action, tour, learn }: { children: ReactNode; action?: ReactNode; tour?: string; learn?: boolean | string }) {
  return (
    <div className="empty" data-tour={tour}>
      <p>{children}</p>
      {action}
      {learn && (
        <>
          {action ? ' ' : null}
          <LearnLink tour={typeof learn === 'string' ? learn : undefined} />
        </>
      )}
    </div>
  );
}

// --- page heads: one primary action, the rest in "⋯" -------------------------------------------------------------------
const PHONE = '(max-width: 599.98px)';
function usePhone() {
  const [phone, setPhone] = useState(() => (typeof matchMedia === 'function' ? matchMedia(PHONE).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/** Children without fragments and empty slots (`{cond && <>…</>}` in a page head). */
function flatChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((c) => (isValidElement(c) && c.type === Fragment ? flatChildren((c as ReactElement<{ children?: ReactNode }>).props.children) : [c]));
}
const classOf = (c: ReactNode) => (isValidElement(c) ? String((c.props as { className?: unknown }).className ?? '') : '');
const isDanger = (c: ReactNode) => /\bdanger\b/.test(classOf(c));
/** A primary button: `btn` without secondary / ghost / danger (what the design system draws filled). */
const isPrimary = (c: ReactNode) => /\bbtn\b/.test(classOf(c)) && !/\b(secondary|ghost|danger|link|icon-btn)\b/.test(classOf(c));

/**
 * "⋯" with a menu of actions. The items stay mounted while the menu is closed, so a dialog one of them opened lives on;
 * a click on an item closes the menu, Esc and a click outside too.
 */
export function ActionMenu({ children, label, tour }: { children: ReactNode; label?: string; tour?: string }) {
  const t = useT('core');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[aria-modal="true"]') && setOpen(false);
    document.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', off), window.removeEventListener('keydown', esc));
  }, [open]);
  return (
    <span className="act-more" ref={ref} data-tour={tour ?? 'page-more'}>
      <button type="button" className="btn secondary" aria-haspopup="menu" aria-expanded={open} aria-label={label ?? t('Weitere Aktionen')} title={label ?? t('Weitere Aktionen')} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      <span className={`act-pop${open ? '' : ' closed'}`} role="menu" aria-hidden={!open || undefined} onClickCapture={(e) => (e.target as HTMLElement).closest('button, a') && setTimeout(() => setOpen(false), 0)}>
        {children}
      </span>
    </span>
  );
}

// `?new=1` in the address (quick actions of the palette and the Start page): the page's primary action starts once.
let wantNew = typeof location !== 'undefined' && new URLSearchParams(location.search).get('new') === '1';
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
  window.addEventListener('pghl:nav', () => {
    if (new URLSearchParams(location.search).get('new') === '1') wantNew = true;
  });
const dropNewParam = () => {
  wantNew = false;
  const u = new URL(location.href);
  if (!u.searchParams.has('new')) return;
  u.searchParams.delete('new');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
};

/**
 * The head of a page: title, a line below it and the actions. One primary action stays in view; on a phone everything
 * else goes into "⋯", on wider screens what does not fit into three buttons – destructive actions (`.danger`) always
 * do, they never sit in a header (docs/ui-patterns.md).
 */
export function PageHead({ title, children, sub }: { title: string; children?: ReactNode; sub?: ReactNode }) {
  const phone = usePhone();
  const ref = useRef<HTMLDivElement>(null);
  const items = flatChildren(children);
  let shown: ReactNode[];
  let more: ReactNode[];
  if (phone) {
    const first = items.find(isPrimary) ?? (items.length === 1 ? items[0] : undefined);
    shown = first !== undefined ? [first] : [];
    more = items.filter((c) => c !== first);
  } else {
    const calm = items.filter((c) => !isDanger(c));
    const primaries = calm.filter(isPrimary).slice(0, 1);
    const room = Math.max(0, 3 - primaries.length);
    const others = calm.filter((c) => !primaries.includes(c)).slice(0, room);
    shown = calm.filter((c) => primaries.includes(c) || others.includes(c));
    more = items.filter((c) => !shown.includes(c));
  }
  useEffect(() => {
    if (!wantNew) return;
    const btn = ref.current?.querySelector<HTMLElement>('.actions .btn:not(.secondary):not(.ghost):not(.danger)');
    if (btn) {
      dropNewParam();
      btn.click();
    }
  });
  useEffect(() => {
    // a page without a primary action: forget the wish after a moment instead of clicking something later
    const timer = setTimeout(() => wantNew && dropNewParam(), 6000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="page-head" data-tour="page-head" ref={ref}>
      <div data-tour="page-title">
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      <div className="actions" data-tour="page-actions">
        {shown}
        {more.length > 0 && <ActionMenu>{more}</ActionMenu>}
      </div>
    </div>
  );
}

/** `chip`: class and style of one chip (coloured contact tags – web/src/tag-chip.tsx); default the plain `tag` chip. */
export function TagInput({ value, onChange, suggestions = [], placeholder, chip }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; placeholder?: string; chip?: (tag: string) => { className: string; style?: React.CSSProperties } | undefined }) {
  const t = useT('core');
  const [text, setText] = useState('');
  const listId = useRef(`tags-${Math.random().toString(36).slice(2)}`).current;
  const add = (t: string) => {
    const s = t.trim();
    if (s && !value.includes(s)) onChange([...value, s]);
    setText('');
  };
  return (
    <div className="tag-input">
      {value.map((tag) => (
        <span key={tag} className="tag" {...chip?.(tag)}>
          {tag}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== tag))} aria-label={t('{tag} entfernen', { tag })}>
            ×
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={text}
        placeholder={placeholder ?? t('Tag + Enter')}
        onChange={(e) => {
          const v = e.target.value;
          if (suggestions.includes(v)) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id={listId}>
        {suggestions.filter((s) => !value.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const t = useT('core');
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small secondary"
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? t('Kopiert ✓') : (label ?? t('Kopieren'))}
    </button>
  );
}

export function CodeBox({ text }: { text: string }) {
  return (
    <div className="codebox">
      {/* scrolls sideways when the text is long: reachable with Tab so the arrow keys can scroll it */}
      <code tabIndex={0}>{text}</code>
      <Copy text={text} />
    </div>
  );
}

/** A key figure tile. Extra attributes (data-sort-key from a SortableGrid, aria-*) go onto the tile. */
export function Stat({ label, value, sub, tour, ...rest }: { label: string; value: ReactNode; sub?: ReactNode; tour?: string } & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  return (
    <div className="stat card" data-tour={tour} {...rest}>
      <div className="muted">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

export function Spinner() {
  const t = useT('core');
  return <div className="spinner" role="status" aria-label={t('Lädt')} />;
}

// --- confirm dialog -------------------------------------------------------------------------------------------------
export interface ConfirmOptions {
  /** The button that confirms (default "OK"; "Löschen" etc. for destructive questions). */
  confirm?: string;
  /** Red confirm button – destructive and not undoable. Guessed from the text ("löschen", "entfernen" …) when not given. */
  danger?: boolean;
  /** The person has to type this word first (irreversible actions such as erasing personal data). */
  typed?: string;
  title?: string;
}
type Ask = { text: string; opts: ConfirmOptions; done: (ok: boolean) => void };
let pushAsk: ((a: Ask) => void) | null = null;
const DANGER_WORDS = /(lösch|entfern|verwerf|widerruf|trenn|storn|beend|sperr|leeren|endgültig|zurücksetz|überschreib|ersetz|delete|remove)/i;

/** The native question (synchronous) – the call sites move to confirmDialog() step by step. */
export function confirmAsk(text: string) {
  return window.confirm(text);
}

/**
 * Asks a yes/no question in an in-app dialog (✕ and Esc = no). Resolves to true on yes. Styled, in the UI language, and
 * destructive questions get a red button. Without the dialog host mounted (tests) it falls back to window.confirm.
 */
export function confirmDialog(text: string, opts: ConfirmOptions = {}): Promise<boolean> {
  if (!pushAsk) return Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(text) : false);
  return new Promise((done) => pushAsk!({ text, opts, done }));
}

/** Mounted once in the app root (main.tsx): shows the questions of confirmDialog one after another. */
export function ConfirmHost() {
  const [queue, setQueue] = useState<Ask[]>([]);
  useEffect(() => {
    pushAsk = (a) => setQueue((q) => [...q, a]);
    return () => void (pushAsk = null);
  }, []);
  const cur = queue[0];
  if (!cur) return null;
  const finish = (ok: boolean) => {
    cur.done(ok);
    setQueue((q) => q.slice(1));
  };
  return <ConfirmDialog key={queue.length + cur.text} text={cur.text} opts={cur.opts} onDone={finish} />;
}

function ConfirmDialog({ text, opts, onDone }: { text: string; opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const t = useT('core');
  const [typed, setTyped] = useState('');
  const danger = opts.danger ?? DANGER_WORDS.test(text);
  const blocked = !!opts.typed && typed.trim().toLowerCase() !== opts.typed.toLowerCase();
  const yes = useRef<HTMLButtonElement>(null);
  // the confirm button takes the focus (Enter = yes), unless a word has to be typed first
  useEffect(() => void (!opts.typed && yes.current?.focus()), [opts.typed]);
  return (
    <Modal
      title={opts.title ?? (danger ? t('Bist du sicher?') : t('Bitte bestätigen'))}
      onClose={() => onDone(false)}
      className="confirm-dlg"
      footer={
        <>
          <button type="button" className="btn secondary" onClick={() => onDone(false)}>
            {t('Abbrechen')}
          </button>
          <button type="button" ref={yes} className={`btn${danger ? ' danger' : ''}`} disabled={blocked} onClick={() => onDone(true)} data-tour="confirm-yes">
            {opts.confirm ?? (danger ? t('Ja, fortfahren') : t('OK'))}
          </button>
        </>
      }
    >
      <p>{text}</p>
      {opts.typed && (
        <Field label={t('Zur Bestätigung „{word}“ eingeben', { word: opts.typed })}>
          <input className="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      )}
    </Modal>
  );
}

/** Merge-field help shown under message editors. */
export function MergeHint() {
  const t = useT('core');
  return (
    <small className="muted">
      {t('Platzhalter:')} {'{{contact.first_name}}'}, {'{{contact.last_name}}'}, {'{{contact.email}}'}, {'{{contact.phone}}'}, {`{{contact.custom.<${t('feld')}>}}`}, {'{{location.name}}'} – {t('Fallback mit')}{' '}
      {`{{contact.first_name|${t('du')}}}`}
    </small>
  );
}
