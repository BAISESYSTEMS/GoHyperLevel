import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './collab.css';
import { api, currentLocation } from '../api';
import { Modal, navigate, Spinner } from '../ui';
import { useSession } from '../session';
import { intlLocale, tr, useT } from '../i18n';

/**
 * Pieces shared by the Wiki and the Team-Chat: dialogs that give the focus back, menus, avatars, the
 * renderer for the server's (already sanitised) HTML with live record cards, @mention / slash completion
 * for text areas and the record picker. Everything user-made reaches the page as the server's escaped HTML
 * or as React text – nothing is built from strings here.
 */

// --- small helpers ----------------------------------------------------------------------------------------------------

/** `?locationId=` for links the browser opens itself (downloads, images), which cannot send the sub-account header. */
export const withLocation = (url: string) => `${url}${url.includes('?') ? '&' : '?'}locationId=${encodeURIComponent(currentLocation())}`;

export const readAsDataUrl = (file: Blob) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => {
      const t = tr('collab');
      rej(fr.error ?? new Error(t('Datei konnte nicht gelesen werden')));
    };
    fr.readAsDataURL(file);
  });

export const readAsText = (file: Blob) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => {
      const t = tr('collab');
      rej(fr.error ?? new Error(t('Datei konnte nicht gelesen werden')));
    };
    fr.readAsText(file);
  });

export const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Changes the address without a history entry (a landing page that only picks the first item). */
export function replaceRoute(path: string) {
  history.replaceState(null, '', path);
  window.dispatchEvent(new Event('pghl:nav'));
}

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
export function dayLabel(iso: string) {
  const t = tr('collab');
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 864e5);
  if (diff === 0) return t('Heute');
  if (diff === 1) return t('Gestern');
  return d.toLocaleDateString(intlLocale(), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Search hits come with \u0001…\u0002 around the matching words. */
export function Snippet({ text }: { text: string }) {
  return (
    <>
      {String(text ?? '')
        .split(/(\u0001[\s\S]*?\u0002)/)
        .map((p, i) => (p.startsWith('\u0001') ? <mark key={i}>{p.replace(/[\u0001\u0002]/g, '')}</mark> : p.replace(/[\u0001\u0002]/g, '')))}
    </>
  );
}

const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0d9488', '#4f46e5', '#65a30d', '#0891b2', '#c026d3', '#b45309'];
export function Avatar({ name, size = 32, online, agent }: { name: string; size?: number; online?: boolean; agent?: boolean }) {
  let h = 0;
  for (const c of name || '?') h = (h * 31 + c.charCodeAt(0)) | 0;
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  return (
    <span className={`ck-avatar${agent ? ' agent' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: PALETTE[Math.abs(h) % PALETTE.length] }} aria-hidden="true">
      {agent ? '✨' : initials}
      {online && <span className="ck-dot" />}
    </span>
  );
}

// --- dialog that gives the focus back ---------------------------------------------------------------------------------------

/**
 * The app's Modal (top-right ✕, Esc, click outside) plus: the first field gets the focus, and closing it – by ✕,
 * Esc or after saving – puts the focus back on what opened it, so keyboard users do not lose their place.
 */
export function Dialog({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = body.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
    if (first && !body.current?.contains(document.activeElement)) first.focus({ preventScroll: true });
    return () => {
      if (opener && opener.isConnected) setTimeout(() => opener.focus({ preventScroll: true }), 0);
    };
  }, [opener]);
  return (
    <Modal title={title} onClose={onClose} wide={wide} footer={footer}>
      <div ref={body}>{children}</div>
    </Modal>
  );
}

// --- dropdown menu --------------------------------------------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
  hidden?: boolean;
  sep?: boolean;
}

export function Menu({ trigger, items, up, left, title, className = 'btn secondary small', tour }: { trigger: ReactNode; items: MenuItem[]; up?: boolean; left?: boolean; title: string; className?: string; tour?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // the menu closes first; a dialog underneath stays
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  return (
    <div className="ck-menu-wrap" ref={ref}>
      <button type="button" className={className} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-tour={tour}>
        {trigger}
      </button>
      {open && (
        <div className={`ck-menu${up ? ' up' : ''}${left ? ' left' : ''}`} role="menu">
          {shown.map((i, n) =>
            i.sep ? (
              <hr key={n} />
            ) : i.href ? (
              <a key={n} role="menuitem" href={i.href} download onClick={() => setOpen(false)}>
                {i.icon} {i.label}
              </a>
            ) : (
              <button
                key={n}
                type="button"
                role="menuitem"
                className={i.danger ? 'danger' : ''}
                onClick={() => {
                  setOpen(false);
                  i.onClick?.();
                }}
              >
                {i.icon} {i.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export const EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅', '🔥', '😮', '😢', '👏', '🚀', '💯', '🤔', '😊', '👌', '➕', '❌', '💡', '📌', '⭐', '🙌', '😅', '🤝', '☕', '🎯', '🧠', '⚡', '📎', '👋', '😎', '🤷'];

/** Emoji button with a small palette; `onPick` gets the emoji. */
export function EmojiMenu({ onPick, trigger, className = 'ic', up = true, left }: { onPick: (e: string) => void; trigger: ReactNode; className?: string; up?: boolean; left?: boolean }) {
  const t = useT('collab');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <span className="ck-menu-wrap" ref={ref}>
      <button type="button" className={className} title={t('Emoji')} aria-label={t('Emoji')} aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && (
        <div className={`ck-menu ck-emoji${up ? ' up' : ''}${left ? ' left' : ''}`} role="menu">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(e);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// --- live cards -------------------------------------------------------------------------------------------------------------------

export interface EmbedCard {
  ok: boolean;
  kind: string;
  title?: string;
  subtitle?: string;
  badge?: { text: string; tone?: string };
  fields?: [string, string][];
  url?: string;
  error?: string;
  thumb?: string;
  external?: boolean;
}

/** German labels (message ids of the collab catalog), shown through t(). */
export const KIND_LABEL: Record<string, string> = { contact: 'Kontakt', company: 'Firma', deal: 'Deal', pipeline: 'Pipeline', task: 'Aufgabe', ticket: 'Ticket', canvas: 'Canvas-Board', doc: 'Dokument', wiki: 'Wiki-Seite' };

/** Looks cards up in batches (one request for everything a page or a chat window asks for within a moment) and keeps them. */
export class CardStore {
  cards = new Map<string, EmbedCard>();
  private listeners = new Set<() => void>();
  private queue = new Set<string>();
  private inflight = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(public endpoint: string) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private notify() {
    for (const l of this.listeners) l();
  }
  want(refs: { kind: string; id: string }[]) {
    let any = false;
    for (const r of refs) {
      const key = `${r.kind}:${r.id}`;
      if (this.cards.has(key) || this.inflight.has(key) || this.queue.has(key)) continue;
      this.queue.add(key);
      any = true;
    }
    if (any && !this.timer) this.timer = setTimeout(() => void this.flush(), 30);
  }
  /** Forgets what was loaded: the next look fetches current data. */
  invalidate() {
    this.cards = new Map();
    this.notify();
  }
  private async flush() {
    const t = tr('collab');
    this.timer = undefined;
    const keys = [...this.queue].slice(0, 100);
    for (const k of keys) this.queue.delete(k);
    if (this.queue.size) this.timer = setTimeout(() => void this.flush(), 30);
    if (!keys.length) return;
    for (const k of keys) this.inflight.add(k);
    const next = new Map(this.cards);
    try {
      const r = await api.post(this.endpoint, { refs: keys.map((k) => ({ kind: k.slice(0, k.indexOf(':')), id: k.slice(k.indexOf(':') + 1) })) });
      for (const k of keys) next.set(k, (r.cards?.[k] as EmbedCard | undefined) ?? { ok: false, kind: k.split(':')[0], error: t('Nicht gefunden') });
    } catch {
      for (const k of keys) next.set(k, { ok: false, kind: k.split(':')[0], error: t('Konnte nicht geladen werden') });
    } finally {
      for (const k of keys) this.inflight.delete(k);
    }
    this.cards = next;
    this.notify();
  }
}

export function useCardStore(endpoint: string) {
  const loc = currentLocation();
  return useMemo(() => new CardStore(endpoint), [endpoint, loc]);
}

export function useCard(store: CardStore, kind: string, id: string): EmbedCard | undefined {
  const key = `${kind}:${id}`;
  useEffect(() => store.want([{ kind, id }]), [store, kind, id]);
  return useSyncExternalStore(store.subscribe, () => store.cards.get(key));
}

const safeCardHref = (c: EmbedCard) => (c.url && (/^\/app\//.test(c.url) || (c.external && /^https?:\/\//i.test(c.url))) ? c.url : undefined);

export function EmbedCardView({ store, kind, id }: { store: CardStore; kind: string; id: string }) {
  const t = useT('collab');
  const card = useCard(store, kind, id);
  const label = KIND_LABEL[kind] ? t(KIND_LABEL[kind]) : kind;
  if (!card) return <div className="ck-embed loading">{label} {t('wird geladen …')}</div>;
  if (!card.ok)
    return (
      <div className="ck-embed err">
        <div className="ck-embed-top">{label}</div>
        {(card.error && t(card.error)) || t('Nicht verfügbar')}
      </div>
    );
  const href = safeCardHref(card);
  const inner = (
    <>
      <div className="ck-embed-top">
        <span>{label}</span>
        {card.badge && <span className={`badge ${card.badge.tone ?? 'gray'}`}>{card.badge.text}</span>}
      </div>
      <div className="ck-embed-title">{card.title}</div>
      {card.subtitle && <div className="ck-embed-sub">{card.subtitle}</div>}
      {!!card.fields?.length && (
        <dl>
          {card.fields.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.thumb && /^\/api\//.test(card.thumb) && <img className="ck-thumb" src={withLocation(card.thumb)} alt="" loading="lazy" />}
    </>
  );
  if (!href) return <div className="ck-embed">{inner}</div>;
  if (card.external)
    return (
      <a className="ck-embed" href={href} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  return (
    <a
      className="ck-embed"
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {inner}
    </a>
  );
}

// --- rendered text --------------------------------------------------------------------------------------------------------------------

/**
 * The server's HTML (escaped and sanitised twice there). Adds what only the browser can: checklist boxes that save,
 * links into the app without a reload, "that's you" on your own @mentions, and live cards where a record was embedded.
 */
export function Prose({ html, store, onToggle, className = '', chat }: { html: string; store: CardStore; onToggle?: (line: number, checked: boolean) => Promise<unknown> | void; className?: string; chat?: boolean }) {
  const me = useSession().user.id;
  const ref = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<{ el: HTMLElement; kind: string; id: string }[]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const m of root.querySelectorAll<HTMLElement>('.wk-mention[data-user]')) if (m.dataset.user === me) m.classList.add('wk-mention-me');
    const found = [...root.querySelectorAll<HTMLElement>('.wk-card[data-card-kind][data-card-id]')].map((el) => ({ el, kind: el.dataset.cardKind!, id: el.dataset.cardId! }));
    // the plain link the server wrote makes room for the live card
    for (const f of found) f.el.textContent = '';
    setSlots(found);
  }, [html, me]);
  return (
    <>
      <div
        ref={ref}
        className={`wk-prose${chat ? ' wk-chat' : ''} ${className}`}
        // The HTML is the server's renderer output (escaping renderer + allow-list sanitiser), never raw user input.
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t instanceof HTMLInputElement && t.type === 'checkbox' && t.dataset.line) {
            if (!onToggle || t.disabled) {
              e.preventDefault();
              return;
            }
            const box = t;
            Promise.resolve(onToggle(Number(box.dataset.line), box.checked)).catch(() => {
              box.checked = !box.checked;
            });
            return;
          }
          const a = t.closest('a');
          if (!a || e.metaKey || e.ctrlKey || e.button !== 0) return;
          const href = a.getAttribute('href') ?? '';
          if (href.startsWith('/app/')) {
            e.preventDefault();
            navigate(href);
          }
        }}
      />
      {slots.map((s, i) => createPortal(<EmbedCardView store={store} kind={s.kind} id={s.id} />, s.el, `${s.kind}:${s.id}:${i}`))}
    </>
  );
}

// --- @mention and slash completion ---------------------------------------------------------------------------------------------------------

export interface Person {
  id: string;
  name: string;
}
/** Marks the cursor position inside the text of a slash item. */
export const CARET = '\u0007';
export interface SlashItem {
  key: string;
  label: string;
  sub?: string;
  /** Text that replaces "/query"; CARET marks where the cursor goes. */
  insert: string;
  /** Runs after the text was replaced (opens a picker). */
  run?: () => void;
}
interface PopItem {
  key: string;
  label: string;
  sub?: string;
  insert: string;
  run?: () => void;
}
interface Pop {
  kind: 'mention' | 'slash';
  from: number;
  to: number;
  items: PopItem[];
  idx: number;
  x: number;
  y: number;
}

/** Pixel position of the cursor in a textarea (a hidden copy of its text up to there). */
function caretXY(el: HTMLTextAreaElement, pos: number): { x: number; y: number; h: number } {
  const cs = getComputedStyle(el);
  const div = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'borderWidth', 'boxSizing', 'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize'] as const) (div.style as any)[p] = cs[p];
  div.style.cssText += ';position:absolute;visibility:hidden;top:0;left:-9999px;white-space:pre-wrap;overflow-wrap:break-word;';
  div.style.width = `${el.clientWidth + parseFloat(cs.borderLeftWidth) * 2}px`;
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '​';
  div.appendChild(mark);
  document.body.appendChild(div);
  const r = { x: mark.offsetLeft, y: mark.offsetTop - el.scrollTop, h: parseFloat(cs.lineHeight) || 20 };
  document.body.removeChild(div);
  return r;
}

const MENTION_RE = /(^|[\s(])@([\p{L}\p{N}_.-]{0,30}(?: [\p{L}\p{N}_.-]{0,30})?)$/u;
const cleanName = (n: string) => n.replace(/[[\]\n]/g, '').trim();

interface AutoProps {
  value: string;
  onChange: (v: string) => void;
  people?: Person[];
  /** Offer "@alle" (everybody in the channel). */
  groupMention?: boolean;
  slash?: SlashItem[];
  /** "line": a "/" at the start of any line; "start": only at the very start of the text (chat commands). */
  slashMode?: 'line' | 'start';
  /** Enter sends (Shift+Enter breaks the line). */
  onEnter?: () => void;
  /** Gets every key the suggestions did not take; return true when handled. */
  onKey?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean | void;
  onType?: () => void;
  onPasteFiles?: (files: File[]) => void;
  /** Open the suggestions above the text instead of below. */
  up?: boolean;
  className?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  autoGrow?: boolean;
  readOnly?: boolean;
  spellCheck?: boolean;
  ariaLabel?: string;
  onBlur?: () => void;
  tour?: string;
}

export const AutoTextarea = forwardRef<HTMLTextAreaElement, AutoProps>(function AutoTextarea({ value, onChange, people, groupMention, slash, slashMode = 'line', onEnter, onKey, onType, onPasteFiles, up, className, placeholder, rows, disabled, autoGrow, readOnly, spellCheck, ariaLabel, onBlur, tour }, fwd) {
  const t = useT('collab');
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof fwd === 'function') fwd(el);
      else if (fwd) fwd.current = el;
    },
    [fwd],
  );
  const [pop, setPop] = useState<Pop | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const detect = useCallback(() => {
    const el = inner.current;
    if (!el || disabled || readOnly) return setPop(null);
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return setPop(null);
    const before = el.value.slice(0, pos);
    const mm = people ? MENTION_RE.exec(before) : null;
    if (mm && people) {
      const q = mm[2].toLowerCase();
      const cands = people.filter((p) => p.name.toLowerCase().includes(q));
      cands.sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
      const items: PopItem[] = cands.slice(0, 8).map((p) => ({ key: p.id, label: p.name, insert: `[@${cleanName(p.name)}](user:${p.id}) ` }));
      if (groupMention && 'alle'.startsWith(q)) items.push({ key: '@alle', label: 'alle', insert: '@alle ', sub: t('ganzer Kanal') });
      if (items.length) {
        const from = pos - mm[2].length - 1;
        const c = caretXY(el, from);
        return setPop({ kind: 'mention', from, to: pos, items, idx: 0, x: c.x, y: c.y + c.h });
      }
    }
    if (slash?.length) {
      const ls = before.lastIndexOf('\n') + 1;
      const sm = /^\/([\p{L}-]{0,24})$/u.exec(before.slice(ls));
      if (sm && (slashMode === 'line' || ls === 0)) {
        const q = sm[1].toLowerCase();
        const items = slash.filter((s) => s.key.toLowerCase().startsWith(q) || s.label.toLowerCase().includes(q)).slice(0, 10);
        if (items.length) {
          const c = caretXY(el, ls);
          return setPop({ kind: 'slash', from: ls, to: pos, items, idx: 0, x: c.x, y: c.y + c.h });
        }
      }
    }
    setPop(null);
  }, [people, slash, slashMode, groupMention, disabled, readOnly]);

  const accept = (it: PopItem) => {
    const el = inner.current;
    if (!pop || !el) return;
    const caret = it.insert.indexOf(CARET);
    const text = caret >= 0 ? it.insert.replace(CARET, '') : it.insert;
    const next = el.value.slice(0, pop.from) + text + el.value.slice(pop.to);
    const at = pop.from + (caret >= 0 ? caret : text.length);
    // set text and cursor together, then tell React: it finds the value already there and leaves the cursor alone
    el.value = next;
    el.setSelectionRange(at, at);
    onChange(next);
    setPop(null);
    el.focus();
    if (it.run) setTimeout(it.run, 0);
  };

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !autoGrow) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`;
  }, [value, autoGrow]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (pop) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setPop({ ...pop, idx: (pop.idx + d + pop.items.length) % pop.items.length });
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        accept(pop.items[pop.idx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setPop(null);
        return;
      }
    }
    if (onKey?.(e)) return;
    if (onEnter && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onEnter();
    }
  };

  const pos = pop && wrap.current && inner.current ? { left: Math.max(4, Math.min(pop.x, inner.current.clientWidth - 230)), ...(up ? { bottom: wrap.current.clientHeight - (pop.y - 24) + 4 } : { top: pop.y + 4 }) } : undefined;

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <textarea
        ref={setRef}
        value={value}
        rows={rows}
        disabled={disabled}
        readOnly={readOnly}
        spellCheck={spellCheck}
        aria-label={ariaLabel}
        data-tour={tour}
        className={className}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          onType?.();
          // the cursor position is settled after the change
          requestAnimationFrame(detect);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          // i18n-ignore – key names
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) detect();
        }}
        onClick={detect}
        onBlur={() => {
          setTimeout(() => setPop(null), 120);
          onBlur?.();
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length && onPasteFiles) {
            e.preventDefault();
            onPasteFiles(files);
          }
        }}
      />
      {pop && pos && (
        <div className="ck-pop" style={pos} role="listbox">
          {pop.items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              role="option"
              aria-selected={i === pop.idx}
              className={i === pop.idx ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(it);
              }}
            >
              <span className="ck-lab">{pop.kind === 'mention' ? `@${it.label}` : it.label}</span>
              {it.sub && <span className="ck-sub">{it.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// --- record picker ----------------------------------------------------------------------------------------------------------------------------

export interface Picked {
  kind: string;
  id: string;
  label: string;
  sub?: string;
}
// German labels (message ids of the collab catalog), shown through t()
const PICK_KINDS: [string, string][] = [
  ['contact', 'Kontakte'],
  ['company', 'Firmen'],
  ['deal', 'Deals'],
  ['task', 'Aufgaben'],
  ['ticket', 'Tickets'],
  ['canvas', 'Canvas-Boards'],
  ['doc', 'Dokumente'],
  ['wiki', 'Wiki-Seiten'],
];

/** Choose a record, board, document or wiki page (read with the caller's own rights on the server). */
export function RecordPicker({ title: titleProp, kinds, onPick, onClose }: { title?: string; kinds?: string[]; onPick: (p: Picked) => void; onClose: () => void }) {
  const t = useT('collab');
  const title = titleProp ?? t('Datensatz einfügen');
  const list = PICK_KINDS.filter(([k]) => !kinds || kinds.includes(k));
  const [kind, setKind] = useState(list[0][0]);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [rows, setRows] = useState<{ id: string; label: string; sub?: string }[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setRows(null);
    setErr('');
    api
      .get(`/api/wiki/pick?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(dq)}`)
      .then((r) => live && setRows(r))
      .catch((e) => live && (setErr((e as Error).message), setRows([])));
    return () => {
      live = false;
    };
  }, [kind, dq]);
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="ck-pick-tabs" data-tour="pick-tabs">
        {list.map(([k, l]) => (
          <button key={k} type="button" className={k === kind ? 'on' : ''} onClick={() => setKind(k)}>
            {t(l)}
          </button>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Suchen …')} aria-label={t('Suchen')} />
      <div className="ck-pick-list">
        {rows === null && <Spinner />}
        {err && <p className="muted">{err}</p>}
        {rows?.length === 0 && !err && <p className="muted">{t('Nichts gefunden.')}</p>}
        {rows?.map((r) => (
          <button key={r.id} type="button" onClick={() => onPick({ kind, id: r.id, label: r.label, sub: r.sub })}>
            <b>{r.label}</b>
            {r.sub && <span className="muted small">{r.sub}</span>}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/** "[Label](card:kind:id)" for a picked record; wiki pages are "[Title](page:id)". */
export const refMarkdown = (p: Picked) => {
  const t = tr('collab');
  const label = p.label.replace(/[[\]\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || (KIND_LABEL[p.kind] ? t(KIND_LABEL[p.kind]) : p.kind);
  return p.kind === 'wiki' ? `[${label}](page:${p.id})` : `[${label}](card:${p.kind}:${p.id})`;
};

// --- panels (not modals): focus goes back, Esc closes ---------------------------------------------------------------------------------------

/** Puts the focus back on what was focused when the component appeared (the button that opened a panel). */
export function useFocusReturn() {
  useEffect(() => {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (el && el.isConnected) setTimeout(() => el.focus({ preventScroll: true }), 0);
    };
  }, []);
}

export function useEscape(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) ref.current();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
}
