/**
 * Gewinnrechner: German taxes on business profit – pure functions, no imports (see calc-engine.ts).
 *
 * An estimate, not tax advice ("Schätzung, keine Steuerberatung"). Parameters are plain data so the user can
 * edit them: the income tax tariff of § 32a EStG for 2024–2026, Solidaritätszuschlag, Kirchensteuer,
 * Gewerbesteuer incl. § 35 EStG credit, Körperschaftsteuer. Sources: docs/gewinnrechner.md.
 *
 * Simplifications (all listed in the docs): no Verlustvortrag, no Hinzurechnungen/Kürzungen beyond a flat
 * amount, health/pension contributions are a flat yearly deduction, Kinderfreibeträge and other allowances
 * are not modelled, no Lohnsteuer of a managing shareholder's salary.
 */

/** Parameters of the tariff of § 32a Abs. 1 EStG (Grundtarif). All editable. */
export interface EstParams {
  /** Label only: the Veranlagungszeitraum these values belong to. */
  year: number;
  /** Zone 1 ends here: no tax up to and including this zvE (Grundfreibetrag). */
  grundfreibetrag: number;
  /** Zone 2 ends here (the "z" of zone 3 counts from this value). */
  zone2_end: number;
  /** Zone 3 ends here; above it the marginal rate is `rate4`. */
  zone3_end: number;
  /** Zone 4 ends here; above it the marginal rate is `rate5` (Reichensteuer). */
  zone4_end: number;
  /** Zone 2: (y_a · y + y_b) · y with y = (zvE − Grundfreibetrag) / 10 000. */
  y_a: number;
  y_b: number;
  /** Zone 3: (z_a · z + z_b) · z + z_c with z = (zvE − zone2_end) / 10 000. */
  z_a: number;
  z_b: number;
  z_c: number;
  /** Zone 4: rate4 · zvE − sub4. */
  rate4: number;
  sub4: number;
  /** Zone 5: rate5 · zvE − sub5. */
  rate5: number;
  sub5: number;
}

/** Built-in parameter sets. 2026 is the newest enacted tariff (Steuerfortentwicklungsgesetz). */
export const EST_YEARS: Record<number, EstParams> = {
  2024: { year: 2024, grundfreibetrag: 11604, zone2_end: 17005, zone3_end: 66760, zone4_end: 277825, y_a: 922.98, y_b: 1400, z_a: 181.19, z_b: 2397, z_c: 1025.38, rate4: 0.42, sub4: 10602.13, rate5: 0.45, sub5: 18936.88 },
  2025: { year: 2025, grundfreibetrag: 12096, zone2_end: 17443, zone3_end: 68480, zone4_end: 277825, y_a: 932.3, y_b: 1400, z_a: 176.64, z_b: 2397, z_c: 1015.13, rate4: 0.42, sub4: 10911.92, rate5: 0.45, sub5: 19246.67 },
  2026: { year: 2026, grundfreibetrag: 12348, zone2_end: 17799, zone3_end: 69878, zone4_end: 277825, y_a: 914.51, y_b: 1400, z_a: 173.1, z_b: 2397, z_c: 1034.87, rate4: 0.42, sub4: 11135.63, rate5: 0.45, sub5: 19470.38 },
};
export const LATEST_EST_YEAR = 2026;

/** Soli Freigrenze (single assessment) per year – the surcharge only starts above it. */
export const SOLI_FREIGRENZE: Record<number, number> = { 2024: 18130, 2025: 19950, 2026: 20350 };

const floorEuro = (v: number) => Math.floor(v + 1e-9);
const pos = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/** Einkommensteuer (Grundtarif, § 32a Abs. 1 EStG) for a zu versteuerndes Einkommen. Both are rounded down to full euros. */
export function estGrundtarif(zve: number, p: EstParams): number {
  const x = floorEuro(pos(zve));
  if (x <= p.grundfreibetrag) return 0;
  let t: number;
  if (x <= p.zone2_end) {
    const y = (x - p.grundfreibetrag) / 10000;
    t = (p.y_a * y + p.y_b) * y;
  } else if (x <= p.zone3_end) {
    const z = (x - p.zone2_end) / 10000;
    t = (p.z_a * z + p.z_b) * z + p.z_c;
  } else if (x <= p.zone4_end) {
    t = p.rate4 * x - p.sub4;
  } else {
    t = p.rate5 * x - p.sub5;
  }
  return floorEuro(t);
}

/** Splittingtarif (Zusammenveranlagung, § 32a Abs. 5): twice the tax on half the income. */
export function estSplitting(zve: number, p: EstParams): number {
  return 2 * estGrundtarif(floorEuro(pos(zve)) / 2, p);
}

export interface SoliParams {
  /** Percent of the income tax (5.5). */
  rate: number;
  /** Single assessment: no surcharge while the income tax stays below this (doubled for joint assessment). */
  freigrenze: number;
  /** Milderungszone: the surcharge is at most this percent of the amount above the Freigrenze (11.9). */
  milderung: number;
}

/** Solidaritätszuschlag on income tax: 0 below the Freigrenze, then min(5.5 % · ESt, 11.9 % · (ESt − Freigrenze)). */
export function soliOnEst(est: number, p: SoliParams, joint: boolean): number {
  const fg = p.freigrenze * (joint ? 2 : 1);
  if (est <= fg) return 0;
  return Math.min((p.rate / 100) * est, (p.milderung / 100) * (est - fg));
}

export interface GewstParams {
  enabled: boolean;
  /** Municipal multiplier in percent (default 400). */
  hebesatz: number;
  /** Steuermesszahl in percent (3.5). */
  messzahl: number;
  /** Freibetrag of natural persons (24 500 €); corporations get none. */
  freibetrag: number;
  /** Yearly amount added to the profit (Hinzurechnungen, e.g. a quarter of interest and rent shares). */
  hinzurechnung: number;
  /** § 35 EStG: factor of the Messbetrag credited against the income tax (4.0). */
  s35_factor: number;
}

export interface GewstResult {
  /** Gewerbeertrag rounded down to full 100 €, before the Freibetrag. */
  ertrag: number;
  messbetrag: number;
  gewst: number;
}

/** Gewerbesteuer on a yearly profit. `freibetrag` only applies to Einzelunternehmen (pass 0 for corporations). */
export function gewerbesteuer(profit: number, p: GewstParams, freibetrag: number): GewstResult {
  if (!p.enabled || profit <= 0) return { ertrag: 0, messbetrag: 0, gewst: 0 };
  const ertrag = Math.floor(pos(profit + p.hinzurechnung) / 100) * 100;
  const base = pos(ertrag - freibetrag);
  const messbetrag = (base * p.messzahl) / 100;
  return { ertrag, messbetrag, gewst: (messbetrag * p.hebesatz) / 100 };
}

export interface PersonalTaxParams {
  est: EstParams;
  soli: SoliParams;
  church_enabled: boolean;
  /** Percent of the income tax (8 in Bayern/Baden-Württemberg, otherwise 9). */
  church_rate: number;
  joint: boolean;
  /** Other taxable income per year the profit is added to (employment, partner …). */
  other_income: number;
  /** Other deductions per year (Sonderausgaben etc.) besides `vorsorge`. */
  deductions: number;
  gewst: GewstParams;
  /** Yearly health/pension contributions, deducted from the taxable income. */
  vorsorge: number;
}

export interface TaxBreakdown {
  /** zu versteuerndes Einkommen incl. other income. */
  zve: number;
  est: number;
  soli: number;
  church: number;
  gewst: number;
  /** Credit of Gewerbesteuer against the income tax (§ 35 EStG), a positive number that was subtracted from `est`. */
  s35: number;
  /** Körperschaftsteuer (corporations only). */
  kst: number;
  /** Tax on distributed profit (Abgeltungsteuer + Soli, corporations only). */
  dividend_tax: number;
  total: number;
  /** total / profit in percent. */
  rate_pct: number;
}

const ZERO: TaxBreakdown = { zve: 0, est: 0, soli: 0, church: 0, gewst: 0, s35: 0, kst: 0, dividend_tax: 0, total: 0, rate_pct: 0 };

/**
 * Taxes of an Einzelunternehmen on a yearly profit: ESt (Grund- or Splittingtarif) on profit + other income − Vorsorge − deductions,
 * minus the § 35 credit (min(factor · Messbetrag, Gewerbesteuer, the ESt share of the business income)), plus Soli and Kirchensteuer
 * on the remaining ESt, plus Gewerbesteuer. With other income only the extra tax caused by the profit is returned.
 */
export function taxEinzel(profit: number, p: PersonalTaxParams): TaxBreakdown {
  if (!(profit > 0)) return { ...ZERO };
  const tariff = (x: number) => (p.joint ? estSplitting(x, p.est) : estGrundtarif(x, p.est));
  const other = pos(p.other_income);
  const cut = pos(p.vorsorge) + pos(p.deductions);
  const zveTotal = floorEuro(pos(profit + other - cut));
  const zveBase = floorEuro(pos(other - pos(p.deductions)));
  const estTotal = tariff(zveTotal);
  const estBase = tariff(zveBase);
  const g = gewerbesteuer(profit, p.gewst, p.gewst.freibetrag);
  const share = profit / (profit + other);
  const s35 = Math.max(0, Math.min(p.gewst.s35_factor * g.messbetrag, g.gewst, estTotal * share));
  const estAfter = estTotal - s35;
  const soliTotal = soliOnEst(estAfter, p.soli, p.joint);
  const soliBase = soliOnEst(estBase, p.soli, p.joint);
  const church = p.church_enabled ? (p.church_rate / 100) * Math.max(0, estAfter - estBase) : 0;
  const est = Math.max(0, estAfter - estBase);
  const soli = Math.max(0, soliTotal - soliBase);
  const total = est + soli + church + g.gewst;
  return { zve: zveTotal, est, soli, church, gewst: g.gewst, s35, kst: 0, dividend_tax: 0, total, rate_pct: (total / profit) * 100 };
}

export interface CorpTaxParams {
  /** Percent (15). */
  kst_rate: number;
  /** Soli on the Körperschaftsteuer, percent (5.5). */
  soli_rate: number;
  gewst: GewstParams;
  /** Share of the after-tax profit that is paid out to the owner, percent. */
  distribution_pct: number;
  /** Abgeltungsteuer on dividends, percent (25). */
  dividend_rate: number;
}

/** Taxes of a GmbH/UG on a yearly profit: KSt + Soli on KSt + Gewerbesteuer (no Freibetrag, no § 35), optionally Abgeltungsteuer on a payout. */
export function taxCorp(profit: number, p: CorpTaxParams): TaxBreakdown {
  if (!(profit > 0)) return { ...ZERO };
  const kst = (profit * p.kst_rate) / 100;
  const soli = (kst * p.soli_rate) / 100;
  const g = gewerbesteuer(profit, p.gewst, 0);
  const afterCompany = profit - kst - soli - g.gewst;
  const dist = Math.max(0, afterCompany) * (Math.min(Math.max(p.distribution_pct, 0), 100) / 100);
  // Abgeltungsteuer 25 % plus 5.5 % Soli on it (Kirchensteuer on dividends is not modelled).
  const dividend_tax = (dist * p.dividend_rate * (1 + p.soli_rate / 100)) / 100;
  const total = kst + soli + g.gewst + dividend_tax;
  return { zve: profit, est: 0, soli, church: 0, gewst: g.gewst, s35: 0, kst, dividend_tax, total, rate_pct: (total / profit) * 100 };
}
