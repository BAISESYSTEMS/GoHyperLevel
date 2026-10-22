import type { ReactNode } from 'react';
import { money } from '../api';
import { Badge, Check } from '../ui';
import './sales.css';

/** Shared parts of the sales pages: money input (euros on screen, cents on the wire), the positions editor and small status helpers. */

export const eur = (cents: number | null | undefined, currency = 'EUR') => money(cents ?? 0, currency);
/** "1.234,5" or "1234.5" → cents. */
export const toCents = (v: unknown): number => {
  const s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return 0;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
/** cents → "1234.50" for an input. */
export const fromCents = (c: number | null | undefined) => ((c ?? 0) / 100).toFixed(2);
const num = (v: unknown, fallback = 0) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
};

export interface LineDraft {
  id?: string;
  product_id?: string | null;
  name: string;
  description: string;
  qty: string;
  /** euros */
  price: string;
  discount_type: 'none' | 'percent' | 'amount';
  /** percent, or euros */
  discount_value: string;
  tax_rate: string;
  optional?: boolean;
  selected?: boolean;
}

export const emptyLine = (tax = 19): LineDraft => ({ name: '', description: '', qty: '1', price: '0.00', discount_type: 'none', discount_value: '0', tax_rate: String(tax) });

export const toDraft = (l: any): LineDraft => ({
  id: l.id,
  product_id: l.product_id ?? null,
  name: l.name ?? '',
  description: l.description ?? '',
  qty: String(l.qty ?? 1),
  price: fromCents(l.price_cents),
  discount_type: l.discount_type ?? 'none',
  discount_value: l.discount_type === 'amount' ? fromCents(l.discount_value) : String(l.discount_value ?? 0),
  tax_rate: String(l.tax_rate ?? 19),
  optional: !!l.optional,
  selected: l.selected !== false,
});

export const fromDraft = (l: LineDraft, withFlags = false) => ({
  ...(l.id ? { id: l.id } : {}),
  ...(l.product_id ? { product_id: l.product_id } : {}),
  name: l.name,
  description: l.description,
  qty: num(l.qty, 1),
  price_cents: toCents(l.price),
  discount_type: l.discount_type,
  discount_value: l.discount_type === 'amount' ? toCents(l.discount_value) : num(l.discount_value),
  tax_rate: num(l.tax_rate, 19),
  ...(withFlags ? { optional: !!l.optional, selected: l.selected !== false } : {}),
});

/** An approximate net for the row while typing (the server's numbers are the real ones). */
export function rowNet(l: LineDraft): number {
  const list = Math.round(num(l.qty, 1) * toCents(l.price));
  const off = l.discount_type === 'percent' ? Math.round((list * Math.min(100, Math.max(0, num(l.discount_value)))) / 100) : l.discount_type === 'amount' ? Math.min(list, toCents(l.discount_value)) : 0;
  return list - Math.max(0, off);
}

/** Positions with product picker, quantity, price, discount, tax and (for quotes) the "optional" tick. */
export function LinesEditor({ lines, onChange, products, currency = 'EUR', defaultTax = 19, optional = false, label = 'Position', tour }: { lines: LineDraft[]; onChange: (l: LineDraft[]) => void; products: any[]; currency?: string; defaultTax?: number; optional?: boolean; label?: string; tour?: string }) {
  const set = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (i: number, pid: string) => {
    const p = products.find((x) => x.id === pid);
    if (!p) return set(i, { product_id: null });
    set(i, { product_id: p.id, name: p.name, description: p.description ?? '', price: fromCents(p.price_cents), tax_rate: String(p.tax_rate ?? defaultTax) });
  };
  const move = (i: number, dir: number) => {
    const next = [...lines];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  };
  return (
    <div className="lines" data-tour={tour}>
      {lines.map((l, i) => (
        <div className={`line${l.optional ? ' opt' : ''}`} key={l.id ?? `n${i}`}>
          <div className="line-main">
            {products.length > 0 && (
              <select aria-label="Produkt aus dem Katalog" value={l.product_id ?? ''} onChange={(e) => pick(i, e.target.value)} className="line-product">
                <option value="">Freie {label}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {eur(p.price_cents, p.currency || currency)}
                  </option>
                ))}
              </select>
            )}
            <input className="line-name" aria-label={`${label}: Name`} placeholder="Name" value={l.name} onChange={(e) => set(i, { name: e.target.value })} />
          </div>
          <div className="line-nums">
            <label>
              <span>Menge</span>
              <input inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
            </label>
            <label>
              <span>Preis ({currency})</span>
              <input inputMode="decimal" value={l.price} onChange={(e) => set(i, { price: e.target.value })} />
            </label>
            <label>
              <span>Rabatt</span>
              <span className="line-disc">
                <select aria-label="Rabattart" value={l.discount_type} onChange={(e) => set(i, { discount_type: e.target.value as LineDraft['discount_type'], discount_value: '0' })}>
                  <option value="none">–</option>
                  <option value="percent">%</option>
                  <option value="amount">{currency}</option>
                </select>
                {l.discount_type !== 'none' && <input aria-label="Rabatt" inputMode="decimal" value={l.discount_value} onChange={(e) => set(i, { discount_value: e.target.value })} />}
              </span>
            </label>
            <label>
              <span>USt %</span>
              <input inputMode="decimal" value={l.tax_rate} onChange={(e) => set(i, { tax_rate: e.target.value })} />
            </label>
            <div className="line-net" title="Netto nach Rabatt">
              <span>Netto</span>
              <b>{eur(rowNet(l), currency)}</b>
            </div>
          </div>
          <div className="line-foot">
            {optional && (
              <>
                <Check checked={!!l.optional} onChange={(v) => set(i, { optional: v })} label="Optional (der Kunde wählt)" />
                {l.optional && <Check checked={l.selected !== false} onChange={(v) => set(i, { selected: v })} label="Vorangekreuzt" />}
              </>
            )}
            <input className="line-desc" aria-label="Beschreibung" placeholder="Beschreibung (optional)" value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
            <span className="line-tools">
              <button type="button" className="icon-btn" disabled={!i} onClick={() => move(i, -1)} aria-label="Nach oben">
                ↑
              </button>
              <button type="button" className="icon-btn" disabled={i === lines.length - 1} onClick={() => move(i, 1)} aria-label="Nach unten">
                ↓
              </button>
              <button type="button" className="icon-btn" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label={`${label} entfernen`}>
                ✕
              </button>
            </span>
          </div>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={() => onChange([...lines, emptyLine(defaultTax)])}>
        + {label}
      </button>
    </div>
  );
}

/** Sums of a list of draft rows (net only; tax and gross come from the server after saving). */
export const sumNet = (lines: LineDraft[]) => lines.filter((l) => !l.optional).reduce((n, l) => n + rowNet(l), 0);

export const QUOTE_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple'> = { draft: 'gray', sent: 'blue', viewed: 'purple', accepted: 'green', declined: 'red', expired: 'yellow', void: 'gray' };
export const StatusBadge = ({ status, label }: { status: string; label: string }) => <Badge tone={QUOTE_TONE[status] ?? 'gray'}>{label}</Badge>;

/** A share of a whole as a bar. */
export function Bar({ pct, tone }: { pct: number | null; tone?: string }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <span className={`bar ${tone ?? ''}`} role="img" aria-label={pct === null ? 'keine Quote' : `${pct} %`}>
      <i style={{ width: `${p}%` }} />
    </span>
  );
}

export function Section({ title, children, actions, tour }: { title: string; children: ReactNode; actions?: ReactNode; tour?: string }) {
  return (
    <section className="sales-sec" data-tour={tour}>
      <div className="sales-sec-head">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A choice of two or three with a short explanation under each (modes, levels). */
export function Choice<T extends string>({ value, onChange, options, name }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; text: string }[]; name: string }) {
  return (
    <div className="choice" role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className={value === o.value ? 'on' : ''}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          <b>{o.label}</b>
          <span className="muted small">{o.text}</span>
        </label>
      ))}
    </div>
  );
}
