/**
 * Gewinnrechner: the input of the calculation engine – one declarative spec that produces the defaults, the
 * JSON Schema, the validation (German messages) and the defaults table of docs/gewinnrechner.md. Pure, no imports
 * from the app (calc-tax.ts only), so the engine can be packaged as a plugin later.
 *
 * Every field has a documented default; nothing is hidden in code. Amounts are euros, "pro Monat" unless noted,
 * percentages are 0–100.
 */
import { EST_YEARS, LATEST_EST_YEAR, SOLI_FREIGRENZE, type EstParams } from './calc-tax.js';

// --- typed input ---------------------------------------------------------------------------------------------------

export interface CalcPlan {
  /** Plan or band name ("Solo", "Team", "Agentur Pro"). */
  name: string;
  /** Share of all customers on this plan in percent (the plans' shares are scaled to 100 %). */
  mix: number;
  /** Flat price per customer and month (the band price, not per seat). */
  base_price: number;
  /** Units (locations, seats, client accounts) included in the base price. */
  included_units: number;
  /** Price for each unit beyond the included ones ("Stufenpreis"). */
  unit_price: number;
  /** Upper limit of the monthly price (0 = no cap). */
  cap: number;
  /** One-time fee per new customer. */
  setup_fee: number;
  /** Average users per customer on this plan (drives the per-user costs). */
  users: number;
  /** Average units per customer on this plan; 0 = use the customer settings (unit mix or average). */
  avg_units: number;
  /** Extra variable cost per customer and month of this plan (e.g. white-label app). */
  extra_cost: number;
  /** Free text shown next to the plan ("2–99 Nutzer", "bis 5 Clients"). */
  note: string;
}
export interface CalcAddon {
  name: string;
  /** Price per month. */
  price: number;
  /** Share of the customers that book it in percent. */
  take_rate: number;
  /** true = the price is per unit (location/seat), false = per customer. */
  per_unit: boolean;
}
export interface CalcUnitShare {
  units: number;
  share: number;
}
export interface CalcPayMethod {
  label: string;
  /** Share of the payments in percent. */
  share: number;
  /** Percent of the charged (gross) amount. */
  pct: number;
  /** Fixed fee per charge. */
  fixed: number;
  /** Upper limit of the fee per charge (0 = none). */
  cap: number;
}
export interface CostLine {
  per_customer: number;
  per_user: number;
  per_unit: number;
}
export interface CalcInput {
  pricing: {
    price_basis: 'net' | 'gross';
    plans: CalcPlan[];
    annual: { share: number; discount: number };
    addons: CalcAddon[];
  };
  customers: {
    count: number;
    avg_units: number;
    unit_mix: CalcUnitShare[];
    b2b_share: number;
    eu_share: number;
    churn: number;
    max_lifetime_months: number;
    growth: { start: number; monthly_new: number; monthly_new_growth: number; months: number };
  };
  vat: { rate: number; kleinunternehmer: boolean; eu_b2c_rate: number; input_rate: number };
  costs: {
    variable: {
      payment: { methods: CalcPayMethod[] };
      hosting: CostLine;
      ai: CostLine;
      messaging: CostLine;
      support: { minutes_per_customer: number; hourly_rate: number };
      other: { per_customer: number; pct_of_revenue: number };
      referral: { commission_pct: number; share: number };
      app_store: { fee_pct: number; share: number };
    };
    fixed: { servers_tools: number; salaries: number; insurance: number; marketing: number; other: number; one_time: number };
    cac: number;
  };
  tax: {
    legal_form: 'einzelunternehmen' | 'kapitalgesellschaft' | 'keine';
    est: EstParams;
    soli: { rate: number; freigrenze: number; milderung: number };
    church: { enabled: boolean; rate: number };
    joint: boolean;
    other_income: number;
    deductions: number;
    vorsorge_monat: number;
    gewerbesteuer: { enabled: boolean; hebesatz: number; messzahl: number; freibetrag: number; hinzurechnung: number; s35_factor: number };
    kst: { rate: number; soli_rate: number; distribution_pct: number; dividend_rate: number };
  };
  matrix: {
    customers: number[];
    columns: 'price' | 'factor' | 'plan';
    prices: number[];
    factors: number[];
    plan_index: number;
    sensitivity_pct: number;
  };
}

// --- spec -----------------------------------------------------------------------------------------------------------

type Leaf = { kind: 'number' | 'integer' | 'boolean' | 'string' | 'enum'; def: unknown; desc: string; unit?: string; min?: number; max?: number; values?: string[]; maxLen?: number };
type ObjNode = { kind: 'object'; desc: string; props: Record<string, Node> };
type ArrNode = { kind: 'array'; desc: string; item: Node; def: unknown[]; max: number; min: number };
type Node = Leaf | ObjNode | ArrNode;

const num = (def: number, desc: string, o: { unit?: string; min?: number; max?: number } = {}): Leaf => ({ kind: 'number', def, desc, min: 0, ...o });
const int = (def: number, desc: string, o: { unit?: string; min?: number; max?: number } = {}): Leaf => ({ kind: 'integer', def, desc, min: 0, ...o });
const bool = (def: boolean, desc: string): Leaf => ({ kind: 'boolean', def, desc });
const text = (def: string, desc: string, maxLen = 80): Leaf => ({ kind: 'string', def, desc, maxLen });
const pick = (def: string, values: string[], desc: string): Leaf => ({ kind: 'enum', def, values, desc });
const obj = (desc: string, props: Record<string, Node>): ObjNode => ({ kind: 'object', desc, props });
const arr = (desc: string, item: Node, def: unknown[], max: number, min = 0): ArrNode => ({ kind: 'array', desc, item, def, max, min });

const EUR = '€';
const EURM = '€/Monat';
const PCT = '%';

const PLAN: ObjNode = obj('Tarif / Staffel', {
  name: text('Standard', 'Name des Tarifs (z. B. Solo, Team, Agentur Pro)', 60),
  mix: num(100, 'Anteil der Kunden in diesem Tarif; die Anteile aller Tarife werden auf 100 % hochgerechnet', { unit: PCT, max: 100 }),
  base_price: num(49, 'Pauschalpreis pro Kunde und Monat (Staffelpreis, nicht pro Nutzer)', { unit: EURM, max: 1_000_000 }),
  included_units: num(0, 'Im Grundpreis enthaltene Einheiten (Standorte, Nutzer oder Kunden-Accounts)', { max: 1_000_000 }),
  unit_price: num(0, 'Preis je weiterer Einheit über den enthaltenen hinaus (Stufenpreis)', { unit: EURM, max: 1_000_000 }),
  cap: num(0, 'Deckel: höchster Monatspreis (0 = kein Deckel)', { unit: EURM, max: 10_000_000 }),
  setup_fee: num(0, 'Einmalige Einrichtungsgebühr pro Neukunde', { unit: EUR, max: 1_000_000 }),
  users: num(1, 'Durchschnittliche Nutzer pro Kunde in diesem Tarif (für Kosten pro Nutzer)', { max: 1_000_000 }),
  avg_units: num(0, 'Durchschnittliche Einheiten pro Kunde in diesem Tarif; 0 = Kundeneinstellungen (Verteilung oder Durchschnitt) gelten', { max: 1_000_000 }),
  extra_cost: num(0, 'Zusätzliche variable Kosten pro Kunde dieses Tarifs (z. B. White-Label-App)', { unit: EURM, max: 1_000_000 }),
  note: text('', 'Hinweis zum Tarif (z. B. „2–99 Nutzer“, „bis 5 Clients“)', 120),
});
const DEFAULT_PLAN = { name: 'Standard', mix: 100, base_price: 49, included_units: 0, unit_price: 0, cap: 0, setup_fee: 0, users: 1, avg_units: 0, extra_cost: 0, note: '' };

const costLine = (what: string, c: number, u: number, n: number): ObjNode =>
  obj(what, {
    per_customer: num(c, `${what}: pro Kunde und Monat`, { unit: EURM, max: 1_000_000 }),
    per_user: num(u, `${what}: pro Nutzer und Monat`, { unit: EURM, max: 1_000_000 }),
    per_unit: num(n, `${what}: pro Einheit (Standort/Account) und Monat`, { unit: EURM, max: 1_000_000 }),
  });

export const SPEC: ObjNode = obj('Eingaben des Gewinnrechners', {
  pricing: obj('Preismodell', {
    price_basis: pick('net', ['net', 'gross'], 'Preise sind Netto (ohne USt) oder Brutto (inkl. deutscher USt, wie sie Endkunden sehen)'),
    plans: arr('Tarife mit Kunden-Mix (Staffeln nach Teamgröße, Agentur-Stufen, Standort-Modell …)', PLAN, [DEFAULT_PLAN], 12, 1),
    annual: obj('Jahreszahlung', {
      share: num(0, 'Anteil der Kunden, die jährlich im Voraus zahlen', { unit: PCT, max: 100 }),
      discount: num(16.7, 'Rabatt bei Jahreszahlung (16,7 % = zwei Monate gratis)', { unit: PCT, max: 100 }),
    }),
    addons: arr(
      'Add-ons (zubuchbar)',
      obj('Add-on', {
        name: text('Add-on', 'Name', 60),
        price: num(0, 'Preis pro Monat', { unit: EURM, max: 1_000_000 }),
        take_rate: num(0, 'Anteil der Kunden, die es buchen', { unit: PCT, max: 100 }),
        per_unit: bool(false, 'Preis gilt je Einheit (Standort/Nutzer) statt je Kunde'),
      }),
      [],
      12,
    ),
  }),
  customers: obj('Kunden', {
    count: int(100, 'Anzahl zahlender Kunden für die Einzelrechnung („Was verdiene ich bei … Kunden?“)', { max: 100_000_000 }),
    avg_units: num(1, 'Durchschnittliche Einheiten (Standorte/Nutzer/Accounts) je Kunde, wenn keine Verteilung angegeben ist', { max: 1_000_000 }),
    unit_mix: arr(
      'Verteilung der Einheiten je Kunde, z. B. 40 % mit 1 Standort, 10 % mit 30 (genauer als ein Durchschnitt, weil Deckel und Inklusiv-Einheiten nicht linear wirken)',
      obj('Einheiten-Anteil', { units: num(1, 'Einheiten', { max: 1_000_000 }), share: num(0, 'Anteil der Kunden', { unit: PCT, max: 100 }) }),
      [],
      12,
    ),
    b2b_share: num(80, 'Anteil Geschäftskunden (B2B); wichtig für die Umsatzsteuer bei Kunden im EU-Ausland', { unit: PCT, max: 100 }),
    eu_share: num(0, 'Anteil der Kunden in anderen EU-Ländern (B2B: Reverse Charge ohne USt, B2C: USt des Landes)', { unit: PCT, max: 100 }),
    churn: num(3, 'Kündigungsquote pro Monat', { unit: '% pro Monat', max: 100 }),
    max_lifetime_months: num(60, 'Obergrenze der Kundenlebensdauer für den Kundenwert (LTV), z. B. wenn die Kündigungsquote 0 ist', { unit: 'Monate', min: 1, max: 600 }),
    growth: obj('Wachstumskurve (für die 12/24/36-Monats-Prognose)', {
      start: int(0, 'Kunden zu Beginn', { max: 100_000_000 }),
      monthly_new: num(10, 'Neukunden pro Monat', { max: 100_000_000 }),
      monthly_new_growth: num(0, 'Wachstum der Neukunden pro Monat (z. B. 2 = jeden Monat 2 % mehr Neukunden)', { unit: '% pro Monat', min: -50, max: 100 }),
      months: int(36, 'Länge der Prognose', { unit: 'Monate', min: 1, max: 120 }),
    }),
  }),
  vat: obj('Umsatzsteuer', {
    rate: num(19, 'Umsatzsteuersatz im Inland (19, 7 oder 0)', { unit: PCT, max: 30 }),
    kleinunternehmer: bool(false, 'Kleinunternehmer (§ 19 UStG): keine USt auf Umsätze, aber auch keine Vorsteuer – Einkäufe kosten brutto'),
    eu_b2c_rate: num(21, 'USt-Satz für Privatkunden im EU-Ausland (One-Stop-Shop, Durchschnitt)', { unit: PCT, max: 30 }),
    input_rate: num(19, 'Vorsteuersatz der Einkäufe (nur für Kleinunternehmer relevant)', { unit: PCT, max: 30 }),
  }),
  costs: obj('Kosten', {
    variable: obj('Variable Kosten (steigen mit der Kundenzahl)', {
      payment: obj('Zahlungsanbieter', {
        methods: arr(
          'Zahlungsarten mit Anteil und Gebühr (Richtwerte, beim Anbieter prüfen); die Gebühr fällt auf den Bruttobetrag je Abbuchung an',
          obj('Zahlungsart', {
            label: text('Karte (EU)', 'Name', 60),
            share: num(100, 'Anteil der Zahlungen', { unit: PCT, max: 100 }),
            pct: num(1.5, 'Prozent vom Bruttobetrag (Stripe, EU-Karten: 1,5 %)', { unit: PCT, max: 100 }),
            fixed: num(0.25, 'Fester Betrag je Abbuchung (Stripe: 0,25 €)', { unit: EUR, max: 1000 }),
            cap: num(0, 'Höchstgebühr je Abbuchung (0 = keine)', { unit: EUR, max: 100_000 }),
          }),
          [{ label: 'Karte (EU)', share: 100, pct: 1.5, fixed: 0.25, cap: 0 }],
          8,
        ),
      }),
      hosting: costLine('Hosting', 1, 0, 0),
      ai: costLine('KI-Token', 1.5, 0, 0),
      messaging: costLine('E-Mail/SMS', 0.5, 0, 0),
      support: obj('Support', {
        minutes_per_customer: num(5, 'Support-Minuten pro Kunde und Monat', { unit: 'Min.', max: 100_000 }),
        hourly_rate: num(45, 'Stundensatz für Support (Vollkosten)', { unit: '€/Std.', max: 10_000 }),
      }),
      other: obj('Sonstiges', {
        per_customer: num(0, 'Sonstige variable Kosten pro Kunde und Monat', { unit: EURM, max: 1_000_000 }),
        pct_of_revenue: num(0, 'Sonstige variable Kosten in Prozent vom Netto-Umsatz', { unit: PCT, max: 100 }),
      }),
      referral: obj('Partner-/Empfehlungsprovision', {
        commission_pct: num(20, 'Provision in Prozent vom Netto-Umsatz der vermittelten Kunden (dauerhaft)', { unit: PCT, max: 100 }),
        share: num(0, 'Anteil der Kunden, die über Partner kommen', { unit: PCT, max: 100 }),
      }),
      app_store: obj('App-Store', {
        fee_pct: num(15, 'Store-Gebühr in Prozent vom Netto-Umsatz (Apple/Google: 15–30 %)', { unit: PCT, max: 100 }),
        share: num(0, 'Anteil der Kunden, die über einen App-Store zahlen (dann fallen keine Zahlungsgebühren an)', { unit: PCT, max: 100 }),
      }),
    }),
    fixed: obj('Fixkosten pro Monat (netto)', {
      servers_tools: num(150, 'Server und Software-Werkzeuge', { unit: EURM, max: 100_000_000 }),
      salaries: num(0, 'Gehälter inkl. Nebenkosten (ohne Unternehmerlohn)', { unit: EURM, max: 100_000_000 }),
      insurance: num(50, 'Versicherungen', { unit: EURM, max: 100_000_000 }),
      marketing: num(500, 'Marketing (laufend)', { unit: EURM, max: 100_000_000 }),
      other: num(100, 'Sonstige Fixkosten (Buchhaltung, Büro …)', { unit: EURM, max: 100_000_000 }),
      one_time: num(0, 'Einmalige Anfangsinvestition (nur Prognose; wird im ersten Monat abgezogen)', { unit: EUR, max: 1_000_000_000 }),
    }),
    cac: num(150, 'Kosten je Neukunde (CAC: Werbung, Vertrieb, Onboarding)', { unit: EUR, max: 10_000_000 }),
  }),
  tax: obj('Steuern (Schätzung, keine Steuerberatung)', {
    legal_form: pick('einzelunternehmen', ['einzelunternehmen', 'kapitalgesellschaft', 'keine'], 'Rechtsform: Einzelunternehmen (ESt), GmbH/UG (KSt) oder keine Steuern (Ergebnis vor Steuern)'),
    est: obj('Einkommensteuer-Tarif § 32a EStG (Grundtarif)', {
      year: int(LATEST_EST_YEAR, 'Veranlagungsjahr der Tarifwerte (nur Beschriftung; 2024–2026 sind eingebaut, „year“ allein lädt die Werte)', { min: 2000, max: 2100 }),
      grundfreibetrag: num(EST_YEARS[LATEST_EST_YEAR].grundfreibetrag, 'Grundfreibetrag: bis hierhin keine Steuer', { unit: EUR, max: 10_000_000 }),
      zone2_end: num(EST_YEARS[LATEST_EST_YEAR].zone2_end, 'Ende der ersten Progressionszone', { unit: EUR, max: 10_000_000 }),
      zone3_end: num(EST_YEARS[LATEST_EST_YEAR].zone3_end, 'Ende der zweiten Progressionszone (danach Spitzensteuersatz)', { unit: EUR, max: 10_000_000 }),
      zone4_end: num(EST_YEARS[LATEST_EST_YEAR].zone4_end, 'Ab hier gilt der Reichensteuersatz', { unit: EUR, max: 100_000_000 }),
      y_a: num(EST_YEARS[LATEST_EST_YEAR].y_a, 'Zone 2: Koeffizient von y² ((a·y + b)·y)', { max: 100_000 }),
      y_b: num(EST_YEARS[LATEST_EST_YEAR].y_b, 'Zone 2: Koeffizient von y', { max: 100_000 }),
      z_a: num(EST_YEARS[LATEST_EST_YEAR].z_a, 'Zone 3: Koeffizient von z² ((a·z + b)·z + c)', { max: 100_000 }),
      z_b: num(EST_YEARS[LATEST_EST_YEAR].z_b, 'Zone 3: Koeffizient von z', { max: 100_000 }),
      z_c: num(EST_YEARS[LATEST_EST_YEAR].z_c, 'Zone 3: konstanter Betrag', { max: 100_000 }),
      rate4: num(EST_YEARS[LATEST_EST_YEAR].rate4, 'Spitzensteuersatz als Faktor (0,42)', { max: 1 }),
      sub4: num(EST_YEARS[LATEST_EST_YEAR].sub4, 'Spitzensteuersatz: abzuziehender Betrag', { unit: EUR, max: 10_000_000 }),
      rate5: num(EST_YEARS[LATEST_EST_YEAR].rate5, 'Reichensteuersatz als Faktor (0,45)', { max: 1 }),
      sub5: num(EST_YEARS[LATEST_EST_YEAR].sub5, 'Reichensteuersatz: abzuziehender Betrag', { unit: EUR, max: 10_000_000 }),
    }),
    soli: obj('Solidaritätszuschlag', {
      rate: num(5.5, 'Prozent der Einkommensteuer', { unit: PCT, max: 100 }),
      freigrenze: num(SOLI_FREIGRENZE[LATEST_EST_YEAR], 'Freigrenze der Einkommensteuer (Einzelveranlagung; bei Zusammenveranlagung doppelt)', { unit: EUR, max: 10_000_000 }),
      milderung: num(11.9, 'Milderungszone: höchstens dieser Prozentsatz des Betrags über der Freigrenze', { unit: PCT, max: 100 }),
    }),
    church: obj('Kirchensteuer', {
      enabled: bool(false, 'Kirchensteuer berechnen'),
      rate: num(9, 'Prozent der Einkommensteuer (8 in Bayern und Baden-Württemberg, sonst 9)', { unit: PCT, max: 20 }),
    }),
    joint: bool(false, 'Zusammenveranlagung (Splittingtarif) statt Einzelveranlagung'),
    other_income: num(0, 'Weitere zu versteuernde Einkünfte pro Jahr (z. B. Gehalt, Partner); der Gewinn kommt obendrauf', { unit: '€/Jahr', max: 100_000_000 }),
    deductions: num(0, 'Weitere Abzüge pro Jahr (Sonderausgaben, Freibeträge) neben der Vorsorge', { unit: '€/Jahr', max: 100_000_000 }),
    vorsorge_monat: num(0, 'Kranken-, Pflege- und Rentenversicherung als fester Monatsbetrag (nur Einzelunternehmen; mindert Steuer und Gewinn)', { unit: EURM, max: 1_000_000 }),
    gewerbesteuer: obj('Gewerbesteuer', {
      enabled: bool(true, 'Gewerbesteuer berechnen (Freiberufler zahlen keine: ausschalten)'),
      hebesatz: num(400, 'Hebesatz der Gemeinde', { unit: PCT, max: 1000 }),
      messzahl: num(3.5, 'Steuermesszahl', { unit: PCT, max: 100 }),
      freibetrag: num(24500, 'Freibetrag bei Einzelunternehmen (Kapitalgesellschaften haben keinen)', { unit: '€/Jahr', max: 10_000_000 }),
      hinzurechnung: num(0, 'Hinzurechnungen zum Gewerbeertrag pro Jahr', { unit: '€/Jahr', max: 100_000_000 }),
      s35_factor: num(4, 'Anrechnung auf die Einkommensteuer nach § 35 EStG: Vielfaches des Messbetrags (Einzelunternehmen)', { max: 10 }),
    }),
    kst: obj('Kapitalgesellschaft (GmbH/UG)', {
      rate: num(15, 'Körperschaftsteuer', { unit: PCT, max: 100 }),
      soli_rate: num(5.5, 'Solidaritätszuschlag auf die Körperschaftsteuer', { unit: PCT, max: 100 }),
      distribution_pct: num(0, 'Anteil des Gewinns nach Steuern, der an den Inhaber ausgeschüttet wird', { unit: PCT, max: 100 }),
      dividend_rate: num(25, 'Abgeltungsteuer auf Ausschüttungen (zuzüglich Soli darauf)', { unit: PCT, max: 100 }),
    }),
  }),
  matrix: obj('Matrix', {
    customers: arr('Zeilen: Kundenzahlen', num(100, 'Kunden', { max: 100_000_000 }), [10, 25, 50, 100, 250, 500, 1000, 5000], 16, 1),
    columns: pick('price', ['price', 'factor', 'plan'], 'Spalten: price = Grundpreis des Tarifs „plan_index“, factor = alle Preise mit einem Faktor, plan = ein Tarif pro Spalte'),
    prices: arr('Spalten bei columns=price: Grundpreise pro Monat', num(49, 'Preis', { unit: EURM, max: 1_000_000 }), [29, 49, 79, 99, 149], 12, 1),
    factors: arr('Spalten bei columns=factor: Preisfaktoren (1 = aktuelle Preise)', num(1, 'Faktor', { max: 100 }), [0.6, 0.8, 1, 1.25, 1.5], 12, 1),
    plan_index: int(0, 'Tarif (0 = erster), dessen Grundpreis bei columns=price ersetzt wird', { max: 11 }),
    sensitivity_pct: num(20, 'Schwankung für die Sensitivitätsanalyse (Tornado)', { unit: PCT, min: 1, max: 90 }),
  }),
});

// --- defaults, schema -----------------------------------------------------------------------------------------------

function defaultsOf(n: Node): any {
  if (n.kind === 'object') return Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, defaultsOf(v)]));
  if (n.kind === 'array') return JSON.parse(JSON.stringify(n.def));
  return n.def;
}
/** The defaults of every field (a fresh copy per call). */
export const defaultInput = (): CalcInput => defaultsOf(SPEC) as CalcInput;

function schemaOf(n: Node): any {
  if (n.kind === 'object') return { type: 'object', description: n.desc, properties: Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, schemaOf(v)])), additionalProperties: false };
  if (n.kind === 'array') return { type: 'array', description: n.desc, items: schemaOf(n.item), minItems: n.min, maxItems: n.max, default: n.def };
  const s: any = { type: n.kind === 'enum' ? 'string' : n.kind, description: n.unit ? `${n.desc} [${n.unit}]` : n.desc, default: n.def };
  if (n.kind === 'enum') s.enum = n.values;
  if (n.min !== undefined) s.minimum = n.min;
  if (n.max !== undefined) s.maximum = n.max;
  if (n.maxLen) s.maxLength = n.maxLen;
  return s;
}
/** JSON Schema (draft 2020-12) of the input; every field carries `description` and `default`. All fields are optional. */
export const inputSchema = () => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'HyperLevel Gewinnrechner', ...schemaOf(SPEC) });

/** Leaf fields as `path` rows with default and description (the docs table is generated from this). */
export function specRows(): { path: string; type: string; unit: string; def: string; desc: string }[] {
  const rows: { path: string; type: string; unit: string; def: string; desc: string }[] = [];
  const show = (v: unknown) => (Array.isArray(v) ? (v.length ? JSON.stringify(v).replace(/"/g, '').slice(0, 90) : '[]') : String(v));
  const walk = (n: Node, path: string) => {
    if (n.kind === 'object') {
      for (const [k, v] of Object.entries(n.props)) walk(v, path ? `${path}.${k}` : k);
    } else if (n.kind === 'array') {
      if (n.item.kind === 'object') {
        rows.push({ path: `${path}[]`, type: 'Liste', unit: '', def: show(n.def.map((d: any) => d?.name ?? d?.label ?? d)), desc: n.desc });
        for (const [k, v] of Object.entries(n.item.props)) walk(v, `${path}[].${k}`);
      } else rows.push({ path, type: 'Liste', unit: n.item.kind === 'number' && (n.item as Leaf).unit ? String((n.item as Leaf).unit) : '', def: show(n.def), desc: n.desc });
    } else rows.push({ path, type: n.kind === 'enum' ? n.values!.join(' \\| ') : n.kind === 'integer' ? 'Zahl (ganz)' : n.kind === 'number' ? 'Zahl' : n.kind === 'boolean' ? 'ja/nein' : 'Text', unit: n.unit ?? '', def: show(n.def), desc: n.desc });
  };
  walk(SPEC, '');
  return rows;
}

/** The markdown table of all fields and defaults (docs/gewinnrechner.md contains exactly this between two markers). */
export function specMarkdown(): string {
  const lines = ['| Field | Type | Unit | Default | Meaning |', '| --- | --- | --- | --- | --- |'];
  for (const r of specRows()) lines.push(`| \`${r.path}\` | ${r.type} | ${r.unit} | ${r.def === '' ? '–' : `\`${r.def.replace(/\|/g, '\\|')}\``} | ${r.desc.replace(/\|/g, '\\|')} |`);
  return lines.join('\n');
}

// --- validation -----------------------------------------------------------------------------------------------------

export class CalcInputError extends Error {
  constructor(public problems: string[]) {
    super(problems.slice(0, 6).join('; ') + (problems.length > 6 ? ` (+${problems.length - 6} weitere)` : ''));
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function norm(n: Node, raw: unknown, base: unknown, path: string, problems: string[]): any {
  const given = raw !== undefined && raw !== null;
  if (n.kind === 'object') {
    if (given && !isObj(raw)) {
      problems.push(`${path || 'Eingabe'}: Objekt erwartet`);
      return defaultsOf(n);
    }
    const src = (given ? raw : {}) as Record<string, unknown>;
    const b = isObj(base) ? base : {};
    for (const k of Object.keys(src)) if (!(k in n.props)) problems.push(`${path ? `${path}.` : ''}${k}: unbekanntes Feld (gültig: ${Object.keys(n.props).join(', ')})`);
    return Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, norm(v, src[k], b[k], path ? `${path}.${k}` : k, problems)]));
  }
  if (n.kind === 'array') {
    if (!given) return Array.isArray(base) ? JSON.parse(JSON.stringify(base)) : JSON.parse(JSON.stringify(n.def));
    if (!Array.isArray(raw)) {
      problems.push(`${path}: Liste erwartet`);
      return JSON.parse(JSON.stringify(n.def));
    }
    if (raw.length > n.max) problems.push(`${path}: höchstens ${n.max} Einträge`);
    if (raw.length < n.min) problems.push(`${path}: mindestens ${n.min} Eintrag`);
    return raw.slice(0, n.max).map((x, i) => norm(n.item, x, undefined, `${path}[${i}]`, problems));
  }
  const fallback = base !== undefined && base !== null ? base : n.def;
  if (!given) return fallback;
  switch (n.kind) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1) return true;
      if (raw === 'false' || raw === 0) return false;
      problems.push(`${path}: ja/nein erwartet`);
      return fallback;
    case 'string': {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        problems.push(`${path}: Text erwartet`);
        return fallback;
      }
      const s = String(raw).trim();
      if (n.maxLen && s.length > n.maxLen) problems.push(`${path}: höchstens ${n.maxLen} Zeichen`);
      return s.slice(0, n.maxLen ?? 200);
    }
    case 'enum':
      if (typeof raw === 'string' && n.values!.includes(raw)) return raw;
      problems.push(`${path}: einer von ${n.values!.join(', ')} erwartet`);
      return fallback;
    default: {
      const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(',', '.')) : raw;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        problems.push(`${path}: Zahl erwartet`);
        return fallback;
      }
      if (n.kind === 'integer' && !Number.isInteger(v)) {
        problems.push(`${path}: ganze Zahl erwartet`);
        return Math.round(v);
      }
      if ((n.min !== undefined && v < n.min) || (n.max !== undefined && v > n.max)) {
        problems.push(`${path}: muss zwischen ${n.min ?? '−∞'} und ${n.max ?? '∞'} liegen`);
        return Math.min(n.max ?? v, Math.max(n.min ?? v, v));
      }
      return v;
    }
  }
}

/** Deep merge: objects key by key, everything else (numbers, lists …) replaced. */
export function mergeInput(base: unknown, patch: unknown): any {
  if (!isObj(patch)) return patch === undefined ? base : patch;
  if (!isObj(base)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? mergeInput(base[k], v) : v;
  return out;
}

/** `tax.est: { year: 2025 }` without coefficients means "the built-in tariff of that year" (with that year's Soli Freigrenze). */
export function expandTaxYear(patch: unknown): unknown {
  if (!isObj(patch) || !isObj(patch.tax)) return patch;
  const tax = patch.tax as Record<string, unknown>;
  const est = isObj(tax.est) ? (tax.est as Record<string, unknown>) : null;
  if (!est || Object.keys(est).length !== 1 || typeof est.year !== 'number' || !EST_YEARS[est.year]) return patch;
  const y = est.year;
  const soli = isObj(tax.soli) ? (tax.soli as Record<string, unknown>) : {};
  return { ...patch, tax: { ...tax, est: { ...EST_YEARS[y] }, soli: { freigrenze: SOLI_FREIGRENZE[y], ...soli } } };
}

/**
 * Validates and completes a (partial) input: missing fields take the defaults (or those of `base`, e.g. a preset),
 * unknown fields and wrong types are errors with a German message – an agent typing `custmers` must not get a
 * silently wrong answer. `tax.est.year` alone loads the built-in tariff of that year (2024–2026).
 */
export function normalizeInput(raw: unknown, base?: CalcInput): CalcInput {
  const problems: string[] = [];
  const patch: any = expandTaxYear(raw ?? {});
  if (!isObj(patch)) throw new CalcInputError(['Eingabe: Objekt erwartet']);
  const out = norm(SPEC, patch, base, '', problems) as CalcInput;
  const plans = out.pricing.plans;
  if (out.matrix.plan_index >= plans.length) problems.push(`matrix.plan_index: es gibt nur ${plans.length} Tarif(e)`);
  if (out.tax.est.zone2_end < out.tax.est.grundfreibetrag || out.tax.est.zone3_end < out.tax.est.zone2_end || out.tax.est.zone4_end < out.tax.est.zone3_end) problems.push('tax.est: die Zonen müssen aufsteigend sein');
  if (problems.length) throw new CalcInputError(problems);
  return out;
}

export const DISCLAIMER = 'Schätzung, keine Steuerberatung';
