import { addDaysYmd, ymdInTz } from '../core/time.js';
import { centsToMoney } from '../core/util.js';
import { deYmd, type LineItem, type TaxMode } from './invoice-model.js';
import { LineError, cleanLines, docItems, lineAmounts, salesTotals, type SalesLine, type SalesTotals } from './sales-lines.js';

/**
 * What a quote is (no database, no HTTP): common positions, alternative options ("Basis / Plus / Premium"), optional positions the
 * customer ticks, what the customer chose, and the money that follows from it. The engine (quote-engine.ts) stores and sends it, the
 * public page (quote-page.ts) shows it; tests/quotes-model.test.ts covers these rules without an app.
 */

export interface QuoteItem extends SalesLine {
  /** The customer decides whether it is part of the offer. */
  optional: boolean;
  /** Optional positions: ticked when the page opens. */
  selected: boolean;
}
export interface QuoteOption {
  id: string;
  name: string;
  description: string;
  recommended: boolean;
  items: QuoteItem[];
}
export interface QuoteDoc {
  /** Positions of every variant of the offer. */
  items: QuoteItem[];
  /** Alternatives: the customer takes exactly one (with a single one it is simply part of the offer). */
  options: QuoteOption[];
}
export interface Selection {
  option_id: string | null;
  optional_ids: string[];
}

export const QUOTE_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'void'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = { draft: 'Entwurf', sent: 'Gesendet', viewed: 'Angesehen', accepted: 'Angenommen', declined: 'Abgelehnt', expired: 'Abgelaufen', void: 'Zurückgezogen' };
/** Quotes the customer can still answer. */
export const OPEN_STATUSES: QuoteStatus[] = ['sent', 'viewed'];

export const MAX_OPTIONS = 6;

type Mint = () => string;
const ID = /^[A-Za-z0-9_-]{4,24}$/;
const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n/g, '\n').slice(0, max);

function flagged(raw: unknown, lines: SalesLine[]): QuoteItem[] {
  const list = Array.isArray(raw) ? raw : [];
  return lines.map((l, i) => {
    const optional = !!list[i]?.optional;
    return { ...l, optional, selected: optional ? list[i]?.selected !== false : true };
  });
}

/** The positions and options of a quote from user input. */
export function cleanQuoteDoc(input: { items?: unknown; options?: unknown }, o: { defaultTax: number; mint: Mint; product?: Parameters<typeof cleanLines>[1]['product'] }): QuoteDoc {
  const lineOpts = { defaultTax: o.defaultTax, mint: o.mint, product: o.product };
  const ids = new Set<string>();
  const uniq = (v: unknown) => {
    let id = typeof v === 'string' && ID.test(v) && !ids.has(v) ? v : o.mint();
    while (ids.has(id)) id = o.mint();
    ids.add(id);
    return id;
  };
  const rawItems = input.items === undefined ? [] : input.items;
  if (!Array.isArray(rawItems)) throw new LineError('Positionen: Liste erwartet');
  const items = flagged(rawItems, cleanLines(rawItems, lineOpts));
  const rawOptions = input.options === undefined ? [] : input.options;
  if (!Array.isArray(rawOptions)) throw new LineError('Varianten: Liste erwartet');
  if (rawOptions.length > MAX_OPTIONS) throw new LineError(`Höchstens ${MAX_OPTIONS} Varianten`);
  const options = rawOptions.map((r: any, i): QuoteOption => {
    const list = Array.isArray(r?.items) ? r.items : [];
    if (!list.length) throw new LineError(`Variante ${i + 1}: mindestens eine Position`);
    const name = text(r?.name, 120).replace(/\n/g, ' ').trim();
    if (!name) throw new LineError(`Variante ${i + 1}: Name fehlt`);
    return { id: uniq(r?.id), name, description: text(r?.description, 1000).trim(), recommended: !!r?.recommended, items: flagged(list, cleanLines(list, lineOpts)) };
  });
  // The ids of positions must be unique across the whole quote: the customer's choice names them.
  for (const it of [...items, ...options.flatMap((x) => x.items)]) {
    while (ids.has(it.id)) it.id = o.mint();
    ids.add(it.id);
  }
  if (options.filter((x) => x.recommended).length > 1) {
    let seen = false;
    for (const x of options) if (x.recommended) (x.recommended = !seen), (seen = true);
  }
  if (!items.length && !options.length) throw new LineError('Das Angebot braucht mindestens eine Position');
  if (!items.some((x) => !x.optional) && !options.length) throw new LineError('Mindestens eine Position darf nicht optional sein');
  return { items, options };
}

/** The option a customer who picked nothing gets: the recommended one, else the first. */
export const defaultOption = (doc: QuoteDoc): QuoteOption | undefined => doc.options.find((o) => o.recommended) ?? doc.options[0];

/**
 * The choice of a customer, checked: the option must exist (needed when there are several; with one it is taken), only optional
 * positions of the offer can be ticked. Without a choice the defaults apply – the recommended option and the pre-ticked positions.
 * `strict` (the customer accepts): a missing option out of several is an error instead of a default.
 */
export function resolveSelection(doc: QuoteDoc, sel?: { option_id?: unknown; optional_ids?: unknown } | null, strict = false): Selection {
  let option: QuoteOption | undefined;
  if (doc.options.length === 1) option = doc.options[0];
  else if (doc.options.length > 1) {
    const wanted = typeof sel?.option_id === 'string' ? doc.options.find((o) => o.id === sel.option_id) : undefined;
    if (!wanted && (strict || (sel?.option_id !== undefined && sel?.option_id !== null && sel?.option_id !== ''))) throw new LineError('Bitte eine Variante wählen');
    option = wanted ?? defaultOption(doc);
  }
  const pool = [...doc.items, ...(option?.items ?? [])].filter((x) => x.optional);
  let optional_ids: string[];
  if (sel && Array.isArray(sel.optional_ids)) {
    const asked = new Set(sel.optional_ids.map(String));
    for (const a of asked) if (!pool.some((x) => x.id === a)) throw new LineError('Eine gewählte optionale Position gibt es nicht');
    optional_ids = pool.filter((x) => asked.has(x.id)).map((x) => x.id);
  } else optional_ids = pool.filter((x) => x.selected).map((x) => x.id);
  return { option_id: option?.id ?? null, optional_ids };
}

/** The positions that make up the offer for a choice, in the order the customer sees them. */
export function selectedItems(doc: QuoteDoc, sel: Selection): QuoteItem[] {
  const option = doc.options.find((o) => o.id === sel.option_id);
  const ticked = new Set(sel.optional_ids);
  return [...doc.items, ...(option?.items ?? [])].filter((x) => !x.optional || ticked.has(x.id));
}

export function quoteTotals(doc: QuoteDoc, sel: Selection, mode: TaxMode = 'standard'): SalesTotals {
  return salesTotals(selectedItems(doc, sel), mode);
}

/** The totals of every option with the default choice – the price tags of the option cards. */
export function optionTotals(doc: QuoteDoc, mode: TaxMode = 'standard'): { option_id: string; totals: SalesTotals }[] {
  return doc.options.map((o) => {
    const sel = resolveSelection(doc, { option_id: o.id });
    return { option_id: o.id, totals: quoteTotals(doc, sel, mode) };
  });
}

/** The lines of the estimate and the invoices made from a choice. */
export const quoteDocItems = (doc: QuoteDoc, sel: Selection): LineItem[] => docItems(selectedItems(doc, sel));

// --- validity ----------------------------------------------------------------------------------------------------------------------------

export const DEFAULT_VALID_DAYS = 30;

/** The last day (YYYY-MM-DD) the quote can be accepted, `days` after `from`, in the sub-account's calendar. */
export const validUntilFrom = (from: Date, days: number, tz: string): string => addDaysYmd(ymdInTz(from, tz), Math.max(0, Math.round(days)));

/** A quote is open through the whole day of its last day. */
export const isExpired = (validUntil: string | null | undefined, today: string): boolean => !!validUntil && validUntil < today;

// --- the signed text ----------------------------------------------------------------------------------------------------------------------

/**
 * The text that is frozen with the signature (a contract record, see contracts.ts): what was offered, what the customer chose and what
 * it costs. Plain text with the contract page's light markup (# heading, - list, **bold**).
 */
export function quoteContractText(q: {
  number: string;
  title: string;
  currency: string;
  valid_until: string | null;
  intro: string;
  terms: string;
  customer: string;
  seller: string;
  doc: QuoteDoc;
  selection: Selection;
  totals: SalesTotals;
  deposit?: { label: string; total_cents: number } | null;
}): string {
  const money = (c: number) => centsToMoney(c, q.currency);
  const option = q.doc.options.find((o) => o.id === q.selection.option_id);
  const lines = selectedItems(q.doc, q.selection).map((l) => {
    const a = lineAmounts(l);
    const qty = String(l.qty).replace('.', ',');
    const off = a.discount_cents ? `, Rabatt ${money(a.discount_cents)}` : '';
    return `- ${l.name}: ${qty} × ${money(l.price_cents)}${off} = ${money(a.net_cents)}`;
  });
  const out = [`# Angebot ${q.number}`, '', `**${q.title || 'Angebot'}**`, `Für: ${q.customer}`, `Von: ${q.seller}`];
  if (q.valid_until) out.push(`Gültig bis: ${deYmd(q.valid_until)}`);
  if (q.intro.trim()) out.push('', q.intro.trim());
  if (option) out.push('', `## Gewählte Variante: ${option.name}`, ...(option.description ? [option.description] : []));
  out.push('', '## Positionen', ...lines, '', `Summe netto: ${money(q.totals.subtotal_cents)}`);
  for (const g of q.totals.groups) if (g.rate > 0) out.push(`Umsatzsteuer ${String(g.rate).replace('.', ',')} %: ${money(g.tax_cents)}`);
  out.push(`**Gesamtbetrag: ${money(q.totals.total_cents)}**`);
  if (q.deposit) out.push('', `Bei Annahme fällig: ${q.deposit.label} – ${money(q.deposit.total_cents)}`);
  if (q.terms.trim()) out.push('', '## Bedingungen', q.terms.trim());
  out.push('', 'Mit meiner elektronischen Unterschrift nehme ich dieses Angebot verbindlich an.');
  return out.join('\n');
}
