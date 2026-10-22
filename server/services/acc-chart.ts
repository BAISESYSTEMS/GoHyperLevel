import type { TaxCode } from './acc-vat.js';

/**
 * Chart of accounts of the light accounting: a selection of the main accounts of DATEV's standard charts
 * SKR03 and SKR04 (the ones a small business uses every month), seeded per sub-account. Numbers and names
 * follow the DATEV standard charts; every account can be renamed and own accounts can be added.
 * Always check the account assignment with the tax advisor before the first DATEV export.
 */

export type AccType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
/** Special role of an account for the postings and reports. */
export type AccKind = '' | 'bank' | 'cash' | 'transit' | 'receivable' | 'payable' | 'vat_in' | 'vat_out' | 'vat_pay' | 'private' | 'opening';
export type Standard = 'skr03' | 'skr04';

export interface SeedAccount {
  n: string;
  name: string;
  type: AccType;
  kind?: AccKind;
  /** DATEV "Automatikkonto": the tax code the account books by itself (no BU-Schlüssel in the export). */
  auto?: TaxCode;
  /** Group in the BWA and the EÜR. */
  grp?: string;
}

export const GROUP_LABELS: Record<string, string> = {
  revenue: 'Umsatzerlöse',
  other_income: 'Sonstige betriebliche Erträge',
  interest_income: 'Zinserträge',
  cogs: 'Wareneinsatz und bezogene Leistungen',
  personnel: 'Personalkosten',
  rooms: 'Raumkosten',
  insurance: 'Versicherungen und Beiträge',
  vehicle: 'Fahrzeugkosten',
  marketing: 'Werbe- und Reisekosten',
  repairs: 'Reparaturen und Instandhaltung',
  depreciation: 'Abschreibungen',
  admin: 'Verwaltung (Büro, Telefon, Software, Beratung, Gebühren)',
  other_costs: 'Sonstige Kosten',
  interest_costs: 'Zinsaufwand',
};
/** Order of the groups in the BWA and EÜR. */
export const GROUP_ORDER = Object.keys(GROUP_LABELS);

const A = (n: string, name: string, extra: Partial<SeedAccount> = {}): SeedAccount => ({ n, name, type: 'asset', ...extra });
const L = (n: string, name: string, extra: Partial<SeedAccount> = {}): SeedAccount => ({ n, name, type: 'liability', ...extra });
const Q = (n: string, name: string, extra: Partial<SeedAccount> = {}): SeedAccount => ({ n, name, type: 'equity', ...extra });
const I = (n: string, name: string, grp: string, extra: Partial<SeedAccount> = {}): SeedAccount => ({ n, name, type: 'income', grp, ...extra });
const E = (n: string, name: string, grp: string, extra: Partial<SeedAccount> = {}): SeedAccount => ({ n, name, type: 'expense', grp, ...extra });

export const SKR03: SeedAccount[] = [
  A('0200', 'Technische Anlagen und Maschinen'),
  A('0320', 'Pkw'),
  A('0420', 'Büroeinrichtung'),
  A('0480', 'Geringwertige Wirtschaftsgüter'),
  A('1000', 'Kasse', { kind: 'cash' }),
  A('1200', 'Bank', { kind: 'bank' }),
  A('1360', 'Geldtransit (Zahlungsdienstleister, z. B. Stripe)', { kind: 'transit' }),
  A('1400', 'Forderungen aus Lieferungen und Leistungen', { kind: 'receivable' }),
  A('1570', 'Abziehbare Vorsteuer', { kind: 'vat_in' }),
  A('1571', 'Abziehbare Vorsteuer 7 %', { kind: 'vat_in' }),
  A('1576', 'Abziehbare Vorsteuer 19 %', { kind: 'vat_in' }),
  A('1577', 'Abziehbare Vorsteuer nach § 13b UStG 19 %', { kind: 'vat_in' }),
  L('1600', 'Verbindlichkeiten aus Lieferungen und Leistungen', { kind: 'payable' }),
  L('1740', 'Verbindlichkeiten aus Lohn und Gehalt'),
  L('1771', 'Umsatzsteuer 7 %', { kind: 'vat_out' }),
  L('1776', 'Umsatzsteuer 19 %', { kind: 'vat_out' }),
  L('1780', 'Umsatzsteuer-Vorauszahlung', { kind: 'vat_pay' }),
  L('1787', 'Umsatzsteuer nach § 13b UStG 19 %', { kind: 'vat_out' }),
  Q('0800', 'Gezeichnetes Kapital'),
  Q('0860', 'Gewinnvortrag vor Verwendung'),
  Q('1800', 'Privatentnahmen allgemein', { kind: 'private' }),
  Q('1890', 'Privateinlagen', { kind: 'private' }),
  Q('9000', 'Saldenvorträge, Sachkonten', { kind: 'opening' }),
  I('8195', 'Erlöse als Kleinunternehmer nach § 19 Abs. 1 UStG', 'revenue'),
  I('8125', 'Steuerfreie innergemeinschaftliche Lieferungen (§ 4 Nr. 1b UStG)', 'revenue'),
  I('8200', 'Erlöse (ohne Umsatzsteuer)', 'revenue'),
  I('8300', 'Erlöse 7 % USt', 'revenue', { auto: 'ust7' }),
  I('8336', 'Erlöse sonstige Leistungen EU (Reverse Charge, nicht steuerbar)', 'revenue'),
  I('8400', 'Erlöse 19 % USt', 'revenue', { auto: 'ust19' }),
  I('8700', 'Erlösschmälerungen', 'revenue'),
  I('2700', 'Sonstige betriebliche Erträge', 'other_income'),
  I('2650', 'Sonstige Zinsen und ähnliche Erträge', 'interest_income'),
  E('3100', 'Fremdleistungen', 'cogs'),
  E('3200', 'Wareneingang', 'cogs'),
  E('3300', 'Wareneingang 7 % Vorsteuer', 'cogs', { auto: 'vst7' }),
  E('3400', 'Wareneingang 19 % Vorsteuer', 'cogs', { auto: 'vst19' }),
  E('4120', 'Gehälter', 'personnel'),
  E('4130', 'Gesetzliche soziale Aufwendungen', 'personnel'),
  E('4210', 'Miete', 'rooms'),
  E('4240', 'Gas, Strom, Wasser', 'rooms'),
  E('4260', 'Instandhaltung betrieblicher Räume', 'rooms'),
  E('4360', 'Versicherungen', 'insurance'),
  E('4380', 'Beiträge', 'insurance'),
  E('4510', 'Kfz-Steuer', 'vehicle'),
  E('4520', 'Kfz-Versicherungen', 'vehicle'),
  E('4530', 'Laufende Kfz-Betriebskosten', 'vehicle'),
  E('4610', 'Werbekosten', 'marketing'),
  E('4650', 'Bewirtungskosten', 'marketing'),
  E('4654', 'Nicht abzugsfähige Bewirtungskosten', 'marketing'),
  E('4660', 'Reisekosten Arbeitnehmer', 'marketing'),
  E('4670', 'Reisekosten Unternehmer', 'marketing'),
  E('4800', 'Reparaturen und Instandhaltung', 'repairs'),
  E('4806', 'Wartungskosten für Hard- und Software', 'admin'),
  E('4830', 'Abschreibungen auf Sachanlagen', 'depreciation'),
  E('4855', 'Sofortabschreibung geringwertiger Wirtschaftsgüter', 'depreciation'),
  E('4910', 'Porto', 'admin'),
  E('4920', 'Telefon', 'admin'),
  E('4930', 'Bürobedarf', 'admin'),
  E('4940', 'Zeitschriften, Bücher', 'admin'),
  E('4945', 'Fortbildungskosten', 'admin'),
  E('4950', 'Rechts- und Beratungskosten', 'admin'),
  E('4955', 'Buchführungskosten', 'admin'),
  E('4957', 'Abschluss- und Prüfungskosten', 'admin'),
  E('4960', 'Mieten für Einrichtungen', 'admin'),
  E('4964', 'Aufwendungen für Lizenzen und Software-Abos', 'admin'),
  E('4970', 'Nebenkosten des Geldverkehrs', 'admin'),
  E('4980', 'Betriebsbedarf', 'other_costs'),
  E('4985', 'Werkzeuge und Kleingeräte', 'other_costs'),
  E('2100', 'Zinsen und ähnliche Aufwendungen', 'interest_costs'),
];

export const SKR04: SeedAccount[] = [
  A('0320', 'Pkw'),
  A('0650', 'Büroeinrichtung'),
  A('0670', 'Geringwertige Wirtschaftsgüter'),
  A('1200', 'Forderungen aus Lieferungen und Leistungen', { kind: 'receivable' }),
  A('1400', 'Abziehbare Vorsteuer', { kind: 'vat_in' }),
  A('1401', 'Abziehbare Vorsteuer 7 %', { kind: 'vat_in' }),
  A('1406', 'Abziehbare Vorsteuer 19 %', { kind: 'vat_in' }),
  A('1407', 'Abziehbare Vorsteuer nach § 13b UStG 19 %', { kind: 'vat_in' }),
  A('1460', 'Geldtransit (Zahlungsdienstleister, z. B. Stripe)', { kind: 'transit' }),
  A('1600', 'Kasse', { kind: 'cash' }),
  A('1800', 'Bank', { kind: 'bank' }),
  L('3300', 'Verbindlichkeiten aus Lieferungen und Leistungen', { kind: 'payable' }),
  L('3720', 'Verbindlichkeiten aus Lohn und Gehalt'),
  L('3801', 'Umsatzsteuer 7 %', { kind: 'vat_out' }),
  L('3806', 'Umsatzsteuer 19 %', { kind: 'vat_out' }),
  L('3820', 'Umsatzsteuer-Vorauszahlung', { kind: 'vat_pay' }),
  L('3837', 'Umsatzsteuer nach § 13b UStG 19 %', { kind: 'vat_out' }),
  Q('2900', 'Gezeichnetes Kapital'),
  Q('2970', 'Gewinnvortrag vor Verwendung'),
  Q('2100', 'Privatentnahmen allgemein', { kind: 'private' }),
  Q('2180', 'Privateinlagen', { kind: 'private' }),
  Q('9000', 'Saldenvorträge, Sachkonten', { kind: 'opening' }),
  I('4180', 'Erlöse bei Anwendung der Kleinunternehmerregelung nach § 19 Abs. 1 UStG', 'revenue'),
  I('4125', 'Steuerfreie innergemeinschaftliche Lieferungen (§ 4 Nr. 1b UStG)', 'revenue'),
  I('4200', 'Erlöse (ohne Umsatzsteuer)', 'revenue'),
  I('4300', 'Erlöse 7 % USt', 'revenue', { auto: 'ust7' }),
  I('4336', 'Erlöse sonstige Leistungen EU (Reverse Charge, nicht steuerbar)', 'revenue'),
  I('4400', 'Erlöse 19 % USt', 'revenue', { auto: 'ust19' }),
  I('4700', 'Erlösschmälerungen', 'revenue'),
  I('4830', 'Sonstige betriebliche Erträge', 'other_income'),
  I('7100', 'Sonstige Zinsen und ähnliche Erträge', 'interest_income'),
  E('5200', 'Wareneingang', 'cogs'),
  E('5300', 'Wareneingang 7 % Vorsteuer', 'cogs', { auto: 'vst7' }),
  E('5400', 'Wareneingang 19 % Vorsteuer', 'cogs', { auto: 'vst19' }),
  E('5900', 'Fremdleistungen', 'cogs'),
  E('6020', 'Gehälter', 'personnel'),
  E('6110', 'Gesetzliche soziale Aufwendungen', 'personnel'),
  E('6310', 'Miete', 'rooms'),
  E('6325', 'Gas, Strom, Wasser', 'rooms'),
  E('6400', 'Versicherungen', 'insurance'),
  E('6420', 'Beiträge', 'insurance'),
  E('6520', 'Kfz-Versicherungen', 'vehicle'),
  E('6530', 'Laufende Kfz-Betriebskosten', 'vehicle'),
  E('6600', 'Werbekosten', 'marketing'),
  E('6640', 'Bewirtungskosten', 'marketing'),
  E('6644', 'Nicht abzugsfähige Bewirtungskosten', 'marketing'),
  E('6650', 'Reisekosten Arbeitnehmer', 'marketing'),
  E('6670', 'Reisekosten Unternehmer', 'marketing'),
  E('6490', 'Sonstige Reparaturen und Instandhaltungen', 'repairs'),
  E('6495', 'Wartungskosten für Hard- und Software', 'admin'),
  E('6220', 'Abschreibungen auf Sachanlagen', 'depreciation'),
  E('6260', 'Sofortabschreibung geringwertiger Wirtschaftsgüter', 'depreciation'),
  E('6800', 'Porto', 'admin'),
  E('6805', 'Telefon', 'admin'),
  E('6815', 'Bürobedarf', 'admin'),
  E('6820', 'Zeitschriften, Bücher', 'admin'),
  E('6821', 'Fortbildungskosten', 'admin'),
  E('6825', 'Rechts- und Beratungskosten', 'admin'),
  E('6830', 'Buchführungskosten', 'admin'),
  E('6835', 'Mieten für Einrichtungen', 'admin'),
  E('6855', 'Nebenkosten des Geldverkehrs', 'admin'),
  E('6850', 'Sonstiger Betriebsbedarf', 'other_costs'),
  E('6845', 'Werkzeuge und Kleingeräte', 'other_costs'),
  E('6300', 'Sonstige betriebliche Aufwendungen', 'other_costs'),
  E('7300', 'Zinsen und ähnliche Aufwendungen', 'interest_costs'),
];

export const CHARTS: Record<Standard, SeedAccount[]> = { skr03: SKR03, skr04: SKR04 };
export const isStandard = (v: unknown): v is Standard => v === 'skr03' || v === 'skr04';

/** Which account books what – the defaults per chart; the settings can override each of them. */
export const MAPPING_KEYS = [
  'bank',
  'cash',
  'transit',
  'receivable',
  'payable',
  'revenue19',
  'revenue7',
  'revenue0',
  'revenue_small',
  'revenue_ig',
  'revenue_rc',
  'vat_out19',
  'vat_out7',
  'vat_in19',
  'vat_in7',
  'vat_rc_in',
  'vat_rc_out',
  'vat_pay',
  'fees',
  'default_expense',
  'private_withdrawal',
  'private_deposit',
  'opening',
] as const;
export type MappingKey = (typeof MAPPING_KEYS)[number];
export type Mapping = Record<MappingKey, string>;

export const MAPPING_LABELS: Record<MappingKey, string> = {
  bank: 'Bank',
  cash: 'Kasse',
  transit: 'Geldtransit (Stripe & Co.)',
  receivable: 'Forderungen aus Lieferungen und Leistungen',
  payable: 'Verbindlichkeiten aus Lieferungen und Leistungen',
  revenue19: 'Erlöse 19 %',
  revenue7: 'Erlöse 7 %',
  revenue0: 'Erlöse steuerfrei (0 %)',
  revenue_small: 'Erlöse Kleinunternehmer',
  revenue_ig: 'Erlöse innergemeinschaftliche Lieferung',
  revenue_rc: 'Erlöse Reverse Charge (EU-Leistung)',
  vat_out19: 'Umsatzsteuer 19 %',
  vat_out7: 'Umsatzsteuer 7 %',
  vat_in19: 'Vorsteuer 19 %',
  vat_in7: 'Vorsteuer 7 %',
  vat_rc_in: 'Vorsteuer § 13b UStG',
  vat_rc_out: 'Umsatzsteuer § 13b UStG',
  vat_pay: 'Umsatzsteuer-Vorauszahlung',
  fees: 'Nebenkosten des Geldverkehrs (Zahlungsgebühren)',
  default_expense: 'Standard-Aufwandskonto',
  private_withdrawal: 'Privatentnahmen',
  private_deposit: 'Privateinlagen',
  opening: 'Saldenvorträge',
};

export const DEFAULT_MAPPING: Record<Standard, Mapping> = {
  skr03: {
    bank: '1200', cash: '1000', transit: '1360', receivable: '1400', payable: '1600',
    revenue19: '8400', revenue7: '8300', revenue0: '8200', revenue_small: '8195', revenue_ig: '8125', revenue_rc: '8336',
    vat_out19: '1776', vat_out7: '1771', vat_in19: '1576', vat_in7: '1571', vat_rc_in: '1577', vat_rc_out: '1787', vat_pay: '1780',
    fees: '4970', default_expense: '4980', private_withdrawal: '1800', private_deposit: '1890', opening: '9000',
  },
  skr04: {
    bank: '1800', cash: '1600', transit: '1460', receivable: '1200', payable: '3300',
    revenue19: '4400', revenue7: '4300', revenue0: '4200', revenue_small: '4180', revenue_ig: '4125', revenue_rc: '4336',
    vat_out19: '3806', vat_out7: '3801', vat_in19: '1406', vat_in7: '1401', vat_rc_in: '1407', vat_rc_out: '3837', vat_pay: '3820',
    fees: '6855', default_expense: '6850', private_withdrawal: '2100', private_deposit: '2180', opening: '9000',
  },
};

/** Keywords of the supplier or the text → expense account number per chart (first match wins). Used when no AI and no history helps. */
export const EXPENSE_HINTS: { re: RegExp; skr03: string; skr04: string }[] = [
  { re: /telekom|vodafone|o2\b|1&1|telefon|mobilfunk|congstar|sipgate/i, skr03: '4920', skr04: '6805' },
  { re: /miete|vermieter|hausverwaltung/i, skr03: '4210', skr04: '6310' },
  { re: /strom|gas\b|wasser|stadtwerke|eon|e\.on|vattenfall|enbw/i, skr03: '4240', skr04: '6325' },
  { re: /versicherung|allianz|axa|huk|ergo|signal iduna|haftpflicht/i, skr03: '4360', skr04: '6400' },
  { re: /tankstelle|shell|aral|esso|total|jet\b|kraftstoff|benzin|diesel|tanken/i, skr03: '4530', skr04: '6530' },
  { re: /bahn|lufthansa|flug|hotel|booking\.com|airbnb|taxi|uber|reise/i, skr03: '4670', skr04: '6670' },
  { re: /restaurant|café|cafe|bewirtung|gaststätte|lieferando/i, skr03: '4650', skr04: '6640' },
  { re: /google ads|facebook|meta platforms|werbung|anzeige|druckerei|flyer|vistaprint|canva/i, skr03: '4610', skr04: '6600' },
  { re: /steuerberat|datev|buchhaltung|lohnabrechnung/i, skr03: '4955', skr04: '6830' },
  { re: /rechtsanw|anwalt|notar|beratung|kanzlei/i, skr03: '4950', skr04: '6825' },
  { re: /porto|dhl|deutsche post|hermes|dpd|ups\b|fedex/i, skr03: '4910', skr04: '6800' },
  { re: /fortbildung|seminar|schulung|weiterbildung|udemy|coursera/i, skr03: '4945', skr04: '6821' },
  { re: /buch|zeitschrift|zeitung|abo\b|fachbuch/i, skr03: '4940', skr04: '6820' },
  { re: /software|saas|lizenz|cloud|hosting|server|domain|github|slack|zoom|notion|adobe|microsoft|google workspace|openai|anthropic|stripe|aws|amazon web/i, skr03: '4964', skr04: '6495' },
  { re: /büro|office|staples|papier|toner|druckerpatrone|schreibwaren|amazon|ikea|bürobedarf/i, skr03: '4930', skr04: '6815' },
  { re: /reparatur|werkstatt|instandhaltung|handwerk/i, skr03: '4800', skr04: '6490' },
  { re: /bank|gebühr|kontoführung|paypal|sumup|zettle|mollie/i, skr03: '4970', skr04: '6855' },
];

export function hintAccount(standard: Standard, text: string): string | undefined {
  const hit = EXPENSE_HINTS.find((h) => h.re.test(text));
  return hit ? hit[standard] : undefined;
}
