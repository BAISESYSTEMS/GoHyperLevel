/**
 * Gewinnrechner: starting points (presets). Each is a partial input over the documented defaults (calc-spec.ts);
 * all numbers are example values to be replaced with your own. Pure data, usable in the browser and on the server.
 */
import { resolveInput, type CalcInput } from './calc-engine.js';

export interface CalcPreset {
  key: string;
  name: string;
  description: string;
  input: Record<string, any>;
}

/** Costs and payment settings both HyperLevel presets share (example values, hosted cloud on a small server). */
const GOHIGH_BASE = {
  customers: { churn: 2.5, b2b_share: 80, eu_share: 5, growth: { start: 0, monthly_new: 25, monthly_new_growth: 2, months: 36 } },
  pricing: { annual: { share: 30, discount: 16.7 } },
  costs: {
    variable: {
      hosting: { per_customer: 1.5, per_user: 0, per_unit: 0.4 },
      ai: { per_customer: 0, per_user: 0.6, per_unit: 0 },
      messaging: { per_customer: 1, per_user: 0, per_unit: 0 },
      support: { minutes_per_customer: 6, hourly_rate: 45 },
      referral: { commission_pct: 20, share: 10 },
    },
    fixed: { servers_tools: 400, salaries: 0, insurance: 60, marketing: 1500, other: 150 },
    cac: 120,
  },
  tax: { vorsorge_monat: 650 },
};

const merge = (a: Record<string, any>, b: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
};

export const PRESETS: CalcPreset[] = [
  {
    key: 'gohigh-staffel',
    name: 'HyperLevel Staffel (Vorschlag)',
    description: 'Preisstaffeln nach Teamgröße (Solo 49 €, Team 99 €, Firma 199 €) und Agentur-Stufen (Start 99 €, Pro 249 €, SaaS 449 €), je mit enthaltenen Standorten, Stufenpreis und Deckel. Der Kunden-Mix verteilt auf die Tarife; alle Preise sind frei änderbar.',
    input: merge(GOHIGH_BASE, {
      pricing: {
        plans: [
          { name: 'Solo', mix: 50, base_price: 49, included_units: 1, unit_price: 10, cap: 99, users: 1, avg_units: 1.4, note: '1 Nutzer, 1 Standort inklusive' },
          { name: 'Team', mix: 35, base_price: 99, included_units: 3, unit_price: 10, cap: 299, users: 6, avg_units: 4, note: '2–99 Nutzer, 3 Standorte inklusive' },
          { name: 'Firma', mix: 10, base_price: 199, included_units: 10, unit_price: 8, cap: 599, users: 150, avg_units: 14, note: 'ab 100 Nutzer, 10 Standorte inklusive' },
          { name: 'Agentur Start', mix: 3, base_price: 99, included_units: 5, unit_price: 0, cap: 0, users: 3, avg_units: 3, note: 'bis 5 Kunden-Accounts' },
          { name: 'Agentur Pro', mix: 1.5, base_price: 249, included_units: 0, unit_price: 0, cap: 0, users: 6, avg_units: 15, note: 'unbegrenzt Kunden-Accounts + White-Label' },
          { name: 'Agentur SaaS', mix: 0.5, base_price: 449, included_units: 0, unit_price: 0, cap: 0, users: 10, avg_units: 40, extra_cost: 25, note: 'Weiterverkauf (Rebilling) + eigene White-Label-App' },
        ],
      },
      customers: { count: 300 },
      matrix: { columns: 'factor', factors: [0.6, 0.8, 1, 1.25, 1.5], customers: [10, 25, 50, 100, 250, 500, 1000, 5000] },
    }),
  },
  {
    key: 'gohigh-standort',
    name: 'HyperLevel Standort-Modell (49 € inkl. 3 Standorte, +10 €, Deckel 499 €)',
    description: '49 € pro Firma und Monat mit 3 Standorten inklusive, jeder weitere Standort 10 €, höchstens 499 €. Die Verteilung der Standorte pro Kunde zeigt, wie der Deckel wirkt.',
    input: merge(GOHIGH_BASE, {
      pricing: { plans: [{ name: 'HyperLevel Cloud', mix: 100, base_price: 49, included_units: 3, unit_price: 10, cap: 499, users: 4, note: 'pro Firma, unbegrenzt Nutzer' }] },
      customers: {
        count: 300,
        unit_mix: [
          { units: 1, share: 35 },
          { units: 2, share: 20 },
          { units: 3, share: 15 },
          { units: 5, share: 12 },
          { units: 8, share: 8 },
          { units: 15, share: 6 },
          { units: 30, share: 3 },
          { units: 60, share: 1 },
        ],
      },
      matrix: { columns: 'price', prices: [29, 39, 49, 69, 99], customers: [10, 25, 50, 100, 250, 500, 1000, 5000] },
    }),
  },
  {
    key: 'saas-pro-nutzer',
    name: 'SaaS pro Nutzer',
    description: 'Klassisches Abo pro Platz: 12 € pro Nutzer und Monat, im Schnitt 8 Nutzer pro Kunde, Kosten steigen mit der Nutzerzahl (KI, Hosting). Die Spalten verändern den Preis pro Nutzer.',
    input: {
      pricing: { plans: [{ name: 'Pro Nutzer', mix: 100, base_price: 0, included_units: 0, unit_price: 12, avg_units: 8, users: 8, note: 'Preis pro Nutzer und Monat' }], annual: { share: 40, discount: 16.7 } },
      customers: { count: 200, churn: 2, b2b_share: 90, eu_share: 20, growth: { start: 0, monthly_new: 12, monthly_new_growth: 1, months: 36 } },
      costs: {
        variable: { hosting: { per_customer: 2, per_user: 0.5, per_unit: 0 }, ai: { per_customer: 0, per_user: 1.2, per_unit: 0 }, messaging: { per_customer: 0.5, per_user: 0.1, per_unit: 0 }, support: { minutes_per_customer: 8, hourly_rate: 45 } },
        fixed: { servers_tools: 600, salaries: 4500, insurance: 80, marketing: 2000, other: 250 },
        cac: 450,
      },
      tax: { legal_form: 'kapitalgesellschaft' },
      matrix: { columns: 'factor', factors: [0.5, 0.75, 1, 1.25, 1.5, 2], customers: [10, 25, 50, 100, 250, 500, 1000, 2500] },
    },
  },
  {
    key: 'agentur-retainer',
    name: 'Agentur-Retainer',
    description: 'Monatliche Betreuung für Kunden: Basis 1.500 €, Standard 2.500 €, Premium 4.500 € plus Einrichtungsgebühr. Der Betreuungsaufwand läuft als Stunden pro Kunde in den Kosten (Support-Minuten × Stundensatz). Spalten sind die Pakete.',
    input: {
      pricing: {
        price_basis: 'net',
        plans: [
          { name: 'Basis', mix: 40, base_price: 1500, setup_fee: 500, users: 1, note: 'Social Media + Anzeigen, ca. 12 Std./Monat' },
          { name: 'Standard', mix: 45, base_price: 2500, setup_fee: 500, users: 1, note: '+ E-Mail-Marketing + Funnel, ca. 20 Std./Monat' },
          { name: 'Premium', mix: 15, base_price: 4500, setup_fee: 1000, users: 1, note: '+ Strategie-Calls, ca. 32 Std./Monat' },
        ],
      },
      customers: { count: 10, churn: 3, b2b_share: 100, eu_share: 0, growth: { start: 3, monthly_new: 1, monthly_new_growth: 0, months: 36 } },
      costs: {
        variable: {
          payment: { methods: [{ label: 'SEPA-Lastschrift', share: 70, pct: 0.8, fixed: 0, cap: 5 }, { label: 'Karte (EU)', share: 30, pct: 1.5, fixed: 0.25, cap: 0 }] },
          hosting: { per_customer: 3, per_user: 0, per_unit: 0 },
          ai: { per_customer: 8, per_user: 0, per_unit: 0 },
          messaging: { per_customer: 5, per_user: 0, per_unit: 0 },
          support: { minutes_per_customer: 1100, hourly_rate: 40 },
          referral: { commission_pct: 10, share: 20 },
        },
        fixed: { servers_tools: 350, salaries: 0, insurance: 120, marketing: 600, other: 250 },
        cac: 500,
      },
      tax: { vorsorge_monat: 800 },
      matrix: { columns: 'plan', customers: [3, 5, 8, 10, 15, 20, 30] },
    },
  },
  {
    key: 'kurs-community',
    name: 'Kurs/Community',
    description: 'Mitgliedschaft für Privatkunden zu 29 € (Endpreis inkl. USt), 40 % zahlen jährlich mit Rabatt, etwas Kunden aus der EU, Zahlung per Karte, PayPal und Lastschrift, Coaching-Call als Add-on. Höhere Kündigungsquote als bei Firmenkunden.',
    input: {
      pricing: { price_basis: 'gross', plans: [{ name: 'Mitgliedschaft', mix: 100, base_price: 29, users: 1, note: 'Community + Kursarchiv' }], annual: { share: 40, discount: 16.7 }, addons: [{ name: '1:1-Coaching-Call', price: 60, take_rate: 5, per_unit: false }] },
      customers: { count: 250, avg_units: 1, churn: 6, b2b_share: 10, eu_share: 10, growth: { start: 0, monthly_new: 40, monthly_new_growth: 0, months: 36 } },
      costs: {
        variable: {
          payment: { methods: [{ label: 'Karte (EU)', share: 60, pct: 1.5, fixed: 0.25, cap: 0 }, { label: 'PayPal', share: 20, pct: 2.99, fixed: 0.39, cap: 0 }, { label: 'SEPA-Lastschrift', share: 20, pct: 0.8, fixed: 0, cap: 5 }] },
          hosting: { per_customer: 0.6, per_user: 0, per_unit: 0 },
          ai: { per_customer: 0.4, per_user: 0, per_unit: 0 },
          messaging: { per_customer: 0.3, per_user: 0, per_unit: 0 },
          support: { minutes_per_customer: 3, hourly_rate: 40 },
          referral: { commission_pct: 30, share: 15 },
        },
        fixed: { servers_tools: 250, salaries: 0, insurance: 30, marketing: 1200, other: 80 },
        cac: 35,
      },
      tax: { vorsorge_monat: 500 },
      matrix: { columns: 'price', prices: [15, 19, 29, 39, 49], customers: [50, 100, 250, 500, 1000, 2500] },
    },
  },
  {
    key: 'handwerk',
    name: 'Handwerk',
    description: 'Aufträge pro Monat als „Kunden“: Kündigungsquote 100 % heißt, jeder Auftrag ist neu; der Auftragswert (Endpreis inkl. USt) steht als Einrichtungsgebühr. Kosten pro Auftrag: Arbeitszeit (Support-Minuten × Stundensatz) und Material. Die Spalten verändern den Auftragswert.',
    input: {
      pricing: { price_basis: 'gross', plans: [{ name: 'Auftrag', mix: 100, base_price: 0, setup_fee: 780, users: 1, note: 'durchschnittlicher Auftragswert (brutto)' }], annual: { share: 0, discount: 0 } },
      customers: { count: 25, avg_units: 1, churn: 100, b2b_share: 40, eu_share: 0, max_lifetime_months: 1, growth: { start: 0, monthly_new: 20, monthly_new_growth: 0, months: 36 } },
      costs: {
        variable: {
          payment: { methods: [{ label: 'Überweisung', share: 70, pct: 0, fixed: 0, cap: 0 }, { label: 'Kartenzahlung', share: 30, pct: 1.39, fixed: 0, cap: 0 }] },
          hosting: { per_customer: 0, per_user: 0, per_unit: 0 },
          ai: { per_customer: 0, per_user: 0, per_unit: 0 },
          messaging: { per_customer: 1, per_user: 0, per_unit: 0 },
          support: { minutes_per_customer: 300, hourly_rate: 42 },
          other: { per_customer: 150, pct_of_revenue: 0 },
          referral: { commission_pct: 0, share: 0 },
        },
        fixed: { servers_tools: 120, salaries: 0, insurance: 250, marketing: 300, other: 1400 },
        cac: 40,
      },
      tax: { vorsorge_monat: 750 },
      matrix: { columns: 'factor', factors: [0.7, 0.85, 1, 1.15, 1.3, 1.5], customers: [5, 10, 15, 25, 35, 50, 70] },
    },
  },
];

export const presetByKey = (key: string) => PRESETS.find((p) => p.key === key);

/** The complete, validated input of a preset. */
export function presetInput(key: string): CalcInput | null {
  const p = presetByKey(key);
  return p ? resolveInput(p.input) : null;
}
