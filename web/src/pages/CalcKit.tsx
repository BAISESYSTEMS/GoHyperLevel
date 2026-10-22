import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { SPEC } from '../../../server/services/calc-spec';
import type { CalcInput } from '../../../server/services/calc-engine';
import { Modal } from '../ui';

/**
 * Shared pieces of the Gewinnrechner page: the editable input (path-based setters, so one tiny component edits any
 * field of the engine's JSON input), number fields that take German decimal commas and are clamped to the limits the
 * engine's spec documents, and a modal that gives focus back.
 */

// --- path helpers ------------------------------------------------------------------------------------------------------

export const getAt = (root: unknown, path: string): any => path.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), root);

export function setAt<T>(root: T, path: string, value: unknown): T {
  const copy: any = JSON.parse(JSON.stringify(root));
  const parts = path.split('.');
  let cur = copy;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
  return copy;
}

/** The spec node (limits, unit, description) of an input path like `pricing.plans.0.cap` or `matrix.customers.2`. */
export function leafOf(path: string): { kind: string; desc: string; unit?: string; min?: number; max?: number; values?: string[]; maxLen?: number } | undefined {
  let n: any = SPEC;
  for (const part of path.split('.')) {
    if (n.kind === 'array') {
      n = n.item;
      if (/^\d+$/.test(part)) continue;
    }
    if (n?.kind !== 'object') return undefined;
    n = n.props[part];
    if (!n) return undefined;
  }
  return n.kind === 'array' ? undefined : n;
}

// --- numbers (German decimal comma) ------------------------------------------------------------------------------------

export const fmtNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6).replace('.', ',') : '');

/** "1.234,5" · "12,5" · "12.5" · "-3" → number; anything else → null. */
export function parseNum(s: string): number | null {
  let t = s.replace(/\s|€|%/g, '');
  if (t === '' || t === '-' || t === ',' || t === '.') return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) ?? []).length > 1) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// --- the input as context ----------------------------------------------------------------------------------------------

export interface CalcCtx {
  input: CalcInput;
  set: (path: string, value: unknown) => void;
  update: (fn: (draft: CalcInput) => void) => void;
}
export const CalcContext = createContext<CalcCtx | null>(null);
export const useCalc = () => {
  const c = useContext(CalcContext);
  if (!c) throw new Error('CalcContext fehlt');
  return c;
};

// --- fields ---------------------------------------------------------------------------------------------------------------

/** A number field bound to an input path. Typing keeps your text; valid numbers apply at once, clamped to the spec's limits. */
export function N({ p, label, unit, hint, compact }: { p: string; label: string; unit?: string; hint?: string; compact?: boolean }) {
  const { input, set } = useCalc();
  const leaf = leafOf(p);
  const value = getAt(input, p) as number;
  const [text, setText] = useState(fmtNum(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmtNum(value));
  }, [value]);
  const clamp = (v: number) => {
    let x = v;
    if (leaf?.max !== undefined) x = Math.min(leaf.max, x);
    if (leaf?.min !== undefined) x = Math.max(leaf.min, x);
    return leaf?.kind === 'integer' ? Math.round(x) : x;
  };
  return (
    <label className={`calc-f${compact ? ' compact' : ''}`} title={hint ?? leaf?.desc}>
      <span>{label}</span>
      <span className="calc-in">
        <input
          inputMode="decimal"
          value={text}
          aria-label={label}
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseNum(e.target.value);
            if (v !== null) set(p, clamp(v));
          }}
          onBlur={() => {
            focused.current = false;
            setText(fmtNum(getAt(input, p)));
          }}
        />
        {(unit ?? leaf?.unit) && <i>{unit ?? leaf?.unit}</i>}
      </span>
    </label>
  );
}

export function T({ p, label, hint, wide }: { p: string; label: string; hint?: string; wide?: boolean }) {
  const { input, set } = useCalc();
  const leaf = leafOf(p);
  return (
    <label className={`calc-f${wide ? ' wide' : ''}`} title={hint ?? leaf?.desc}>
      <span>{label}</span>
      <span className="calc-in">
        <input value={getAt(input, p) ?? ''} maxLength={leaf?.maxLen ?? 80} aria-label={label} onChange={(e) => set(p, e.target.value)} />
      </span>
    </label>
  );
}

export function Sel({ p, label, options, hint }: { p: string; label: string; options: [string, string][]; hint?: string }) {
  const { input, set } = useCalc();
  return (
    <label className="calc-f" title={hint ?? leafOf(p)?.desc}>
      <span>{label}</span>
      <span className="calc-in">
        <select value={String(getAt(input, p))} aria-label={label} onChange={(e) => set(p, typeof getAt(input, p) === 'number' ? Number(e.target.value) : e.target.value)}>
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function Chk({ p, label, hint }: { p: string; label: string; hint?: string }) {
  const { input, set } = useCalc();
  return (
    <label className="check calc-check" title={hint ?? leafOf(p)?.desc}>
      <input type="checkbox" checked={!!getAt(input, p)} onChange={(e) => set(p, e.target.checked)} /> {label}
    </label>
  );
}

/** A list of numbers in one text field ("10, 25, 50"); applies when it parses, sorted, within the spec's list limits. */
export function NumList({ p, label, hint, max = 16 }: { p: string; label: string; hint?: string; max?: number }) {
  const { input, set } = useCalc();
  const value = (getAt(input, p) as number[]) ?? [];
  const show = (v: number[]) => v.map(fmtNum).join('; ');
  const [text, setText] = useState(show(value));
  const focused = useRef(false);
  const key = JSON.stringify(value);
  useEffect(() => {
    if (!focused.current) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const item = leafOf(`${p}.0`);
  const parse = (s: string) => {
    const parts = s.split(/[;\s]+/).filter(Boolean);
    const nums = parts.map(parseNum);
    if (!nums.length || nums.some((n) => n === null) || nums.length > max) return null;
    return (nums as number[]).map((n) => Math.min(item?.max ?? n, Math.max(item?.min ?? n, n)));
  };
  return (
    <label className="calc-f wide" title={hint ?? leafOf(p)?.desc}>
      <span>{label}</span>
      <span className="calc-in">
        <input
          value={text}
          aria-label={label}
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            setText(e.target.value);
            const v = parse(e.target.value);
            if (v) set(p, [...v].sort((a, b) => a - b));
          }}
          onBlur={() => {
            focused.current = false;
            setText(show(getAt(input, p)));
          }}
        />
      </span>
    </label>
  );
}

/** A collapsible group of fields. */
export function Sec({ title, tour, children, open = false, hint }: { title: string; tour?: string; children: ReactNode; open?: boolean; hint?: string }) {
  return (
    <details className="calc-sec" open={open} data-tour={tour}>
      <summary>
        <span>{title}</span>
        {hint && <small className="muted">{hint}</small>}
      </summary>
      <div className="calc-sec-body">{children}</div>
    </details>
  );
}

// --- modal ------------------------------------------------------------------------------------------------------------------

/**
 * A modal that gives focus back to what opened it when it closes (✕, Esc or after the action). The ✕ in the top right
 * corner and Esc come from the shared Modal.
 */
export function CalcModal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    const el = opener.current;
    return () => {
      setTimeout(() => (el && document.contains(el) ? el.focus?.() : undefined), 0);
    };
  }, []);
  return (
    <Modal title={title} onClose={onClose} wide={wide} footer={footer}>
      {children}
    </Modal>
  );
}
