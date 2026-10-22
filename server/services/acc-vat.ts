/**
 * VAT (Umsatzsteuer) building blocks of the light accounting: tax codes, rounding, and the
 * mapping to the Kennzahlen of the Umsatzsteuer-Voranmeldung and to DATEV's BU-Schlüssel.
 *
 * Preparation for the tax advisor only – not certified accounting software, no ELSTER transmission.
 */

export type TaxCode = 'none' | 'ust19' | 'ust7' | 'ust0' | 'ust_ig' | 'ust_export' | 'ust_rc' | 'kl' | 'vst19' | 'vst7' | 'vst0' | 'rc19';

export type TaxKind = 'none' | 'output' | 'input' | 'rc_in';

export interface TaxDef {
  code: TaxCode;
  label: string;
  kind: TaxKind;
  /** VAT rate in percent (0 for codes without tax on the booking itself). */
  rate: number;
  /** DATEV BU-Schlüssel for accounts without an automatic function ('' = none). */
  datev: string;
  /** Kennzahl of the Bemessungsgrundlage (base) in the Voranmeldung. */
  kz_base?: string;
  /** Kennzahl of the tax itself, where the form asks for it. */
  kz_tax?: string;
}

/**
 * Tax codes. Input-tax codes (vst*) are for expenses, output codes (ust*) for revenue. `rc19` is the
 * reverse-charge marker for purchases under § 13b UStG (the recipient owes the tax; the invoice shows none),
 * `ust_rc` its counterpart on outgoing invoices (service to a business in another EU state, tax owed there).
 * BU-Schlüssel follow DATEV's published list (3/2 = USt 19/7 %, 9/8 = Vorsteuer 19/7 %, 94 = § 13b 19 %).
 */
export const TAX_CODES: Record<TaxCode, TaxDef> = {
  none: { code: 'none', label: 'ohne Steuer', kind: 'none', rate: 0, datev: '' },
  ust19: { code: 'ust19', label: 'Umsatzsteuer 19 %', kind: 'output', rate: 19, datev: '3', kz_base: '81' },
  ust7: { code: 'ust7', label: 'Umsatzsteuer 7 %', kind: 'output', rate: 7, datev: '2', kz_base: '86' },
  ust0: { code: 'ust0', label: 'Steuerfreier Umsatz (0 %)', kind: 'output', rate: 0, datev: '' },
  ust_ig: { code: 'ust_ig', label: 'Innergemeinschaftliche Lieferung (steuerfrei)', kind: 'output', rate: 0, datev: '', kz_base: '41' },
  ust_export: { code: 'ust_export', label: 'Ausfuhrlieferung (steuerfrei)', kind: 'output', rate: 0, datev: '', kz_base: '43' },
  ust_rc: { code: 'ust_rc', label: 'Reverse Charge, Leistungsempfänger schuldet die Steuer (nicht steuerbar im Inland)', kind: 'output', rate: 0, datev: '', kz_base: '21' },
  kl: { code: 'kl', label: 'Kleinunternehmer (§ 19 UStG, keine USt)', kind: 'output', rate: 0, datev: '' },
  vst19: { code: 'vst19', label: 'Vorsteuer 19 %', kind: 'input', rate: 19, datev: '9', kz_tax: '66' },
  vst7: { code: 'vst7', label: 'Vorsteuer 7 %', kind: 'input', rate: 7, datev: '8', kz_tax: '66' },
  vst0: { code: 'vst0', label: 'Ohne Vorsteuer (0 %)', kind: 'input', rate: 0, datev: '' },
  rc19: { code: 'rc19', label: 'Reverse Charge § 13b UStG 19 % (Steuerschuld beim Empfänger)', kind: 'rc_in', rate: 19, datev: '94', kz_base: '46', kz_tax: '47' },
};

export const TAX_CODE_LIST = Object.values(TAX_CODES);
export const isTaxCode = (v: unknown): v is TaxCode => typeof v === 'string' && v in TAX_CODES;
export const isOutput = (c: TaxCode) => TAX_CODES[c].kind === 'output';
export const isInput = (c: TaxCode) => TAX_CODES[c].kind === 'input';

/** Tax on a net amount, rounded to whole cents (half away from zero). */
export function vatFromNet(netCents: number, ratePercent: number): number {
  return Math.sign(netCents) * Math.round((Math.abs(netCents) * ratePercent) / 100);
}

/** Splits a gross amount into net and tax. */
export function splitGross(grossCents: number, ratePercent: number): { net: number; tax: number } {
  if (!ratePercent) return { net: grossCents, tax: 0 };
  const net = Math.sign(grossCents) * Math.round((Math.abs(grossCents) * 100) / (100 + ratePercent));
  return { net, tax: grossCents - net };
}

/** Net and tax of a booking amount. Reverse charge: the amount is the net, the tax is self-assessed and not part of the payment. */
export function splitAmount(code: TaxCode, amountCents: number, opts: { net?: number; tax?: number } = {}): { net: number; tax: number; gross: number } {
  const def = TAX_CODES[code];
  if (def.kind === 'rc_in') {
    const net = opts.net ?? amountCents;
    return { net, tax: vatFromNet(net, def.rate), gross: net };
  }
  if (opts.net !== undefined && opts.tax !== undefined) return { net: opts.net, tax: opts.tax, gross: opts.net + opts.tax };
  if (!def.rate) return { net: amountCents, tax: 0, gross: amountCents };
  const { net, tax } = splitGross(amountCents, def.rate);
  return { net, tax, gross: amountCents };
}

/** Tax code for a document line: the rate (19/7/0) on the revenue or expense side. */
export function codeForRate(rate: number, side: 'output' | 'input'): TaxCode {
  const r = Math.round(rate * 100) / 100;
  if (side === 'output') return r === 19 ? 'ust19' : r === 7 ? 'ust7' : 'ust0';
  return r === 19 ? 'vst19' : r === 7 ? 'vst7' : 'vst0';
}

export function cleanTaxCode(v: unknown, fallback: TaxCode = 'none'): TaxCode {
  if (v === undefined || v === null || v === '') return fallback;
  if (!isTaxCode(v)) throw new Error(`Unbekannter Steuerschlüssel „${String(v).slice(0, 20)}“`);
  return v;
}
