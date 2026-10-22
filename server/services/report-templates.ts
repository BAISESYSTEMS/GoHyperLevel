/**
 * Prebuilt dashboards ("Dashboard aus Vorlage"). A widget is a report config plus its size in the
 * 12-column grid; positions are packed row by row when the dashboard is created.
 */

export type Viz = 'kpi' | 'line' | 'area' | 'bar' | 'hbar' | 'stacked' | 'pie' | 'donut' | 'table' | 'funnel' | 'heatmap';
export const VIZ: Viz[] = ['kpi', 'line', 'area', 'bar', 'hbar', 'stacked', 'pie', 'donut', 'table', 'funnel', 'heatmap'];

export interface ReportConfig {
  title?: string;
  viz: Viz;
  /** Report query as the API takes it (source, measures, group_by, filters, date_field, range, compare, sort, limit). */
  query: Record<string, any>;
  /** Keep the report's own range instead of the dashboard's (e.g. "open pipeline value" over all time). */
  fixed_range?: boolean;
}

export interface Widget {
  id: string;
  title: string;
  config?: ReportConfig;
  /** Saved report from the library (config is read from there). */
  report_id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TemplateWidget {
  title: string;
  w: number;
  h: number;
  config: ReportConfig;
}

export interface DashboardTemplate {
  key: string;
  name: string;
  description: string;
  range: string;
  widgets: TemplateWidget[];
}

const kpi = (title: string, query: Record<string, any>, fixed = false): TemplateWidget => ({ title, w: 3, h: 2, config: { viz: 'kpi', query: { compare: !fixed, ...query }, ...(fixed ? { fixed_range: true } : {}) } });
const chart = (title: string, viz: Viz, query: Record<string, any>, opts: { w?: number; h?: number; fixed?: boolean } = {}): TemplateWidget => ({ title, w: opts.w ?? 6, h: opts.h ?? 4, config: { viz, query, ...(opts.fixed ? { fixed_range: true } : {}) } });

const OPEN = { field: 'status', op: 'eq', value: 'open' };
const WON = { field: 'status', op: 'eq', value: 'won' };

export const TEMPLATES: DashboardTemplate[] = [
  {
    key: 'sales',
    name: 'Vertrieb',
    description: 'Pipeline-Wert je Phase, Win-Rate, gewichtete Umsatzprognose und Deal-Geschwindigkeit.',
    range: 'last_90_days',
    widgets: [
      kpi('Offener Pipeline-Wert', { source: 'opportunities', measures: ['calc:open_value'], range: 'all' }, true),
      kpi('Umsatzprognose (gewichtet)', { source: 'opportunities', measures: ['calc:forecast'], range: 'all' }, true),
      kpi('Win-Rate', { source: 'opportunities', measures: ['calc:win_rate'], date_field: 'closed_at' }),
      kpi('Deal-Geschwindigkeit', { source: 'opportunities', measures: ['calc:velocity'], date_field: 'won_at' }),
      chart('Pipeline-Wert je Phase', 'funnel', { source: 'opportunities', measures: ['sum:value'], group_by: ['stage'], filters: [OPEN], range: 'all' }, { fixed: true }),
      chart('Umsatzprognose je Phase', 'hbar', { source: 'opportunities', measures: ['calc:forecast'], group_by: ['stage'], filters: [OPEN], range: 'all' }, { fixed: true }),
      chart('Gewonnener Umsatz je Monat', 'bar', { source: 'opportunities', measures: ['sum:value'], group_by: ['won_at:month'], filters: [WON], date_field: 'won_at', range: 'last_12_months' }, { fixed: true }),
      chart('Prognose je erwartetem Abschlussmonat', 'bar', { source: 'opportunities', measures: ['calc:forecast', 'sum:value'], group_by: ['expected_close_date:month'], filters: [OPEN], date_field: 'expected_close_date', range: 'all' }, { fixed: true }),
      chart('Verlorene Deals nach Grund', 'hbar', { source: 'opportunities', measures: ['count', 'calc:lost_value'], group_by: ['lost_reason'], filters: [{ field: 'status', op: 'eq', value: 'lost' }], date_field: 'lost_at', limit: 10 }),
      chart('Deals je Zuständigem', 'table', { source: 'opportunities', measures: ['count', 'calc:won_value', 'calc:win_rate'], group_by: ['assigned_to'] }),
    ],
  },
  {
    key: 'marketing',
    name: 'Marketing',
    description: 'Leads je Quelle, Kampagnen-Performance und Formular-Conversion.',
    range: 'last_30_days',
    widgets: [
      kpi('Neue Leads', { source: 'contacts', measures: ['count'] }),
      kpi('Lead → Deal', { source: 'contacts', measures: ['calc:deal_rate'] }),
      kpi('Formular-Einsendungen', { source: 'form_submissions', measures: ['count'] }),
      kpi('Öffnungsrate Kampagnen', { source: 'campaigns', measures: ['calc:open_rate'] }),
      chart('Leads je Quelle', 'hbar', { source: 'contacts', measures: ['count'], group_by: ['source'], limit: 10 }),
      chart('Leads je Woche', 'line', { source: 'contacts', measures: ['count'], group_by: ['created_at:week'], compare: true }),
      chart('Kampagnen-Performance', 'table', { source: 'campaigns', measures: ['calc:sent', 'calc:open_rate', 'calc:click_rate'], group_by: ['campaign'] }),
      chart('Formular-Conversion', 'table', { source: 'form_submissions', measures: ['count', 'calc:deal_rate', 'calc:customer_rate'], group_by: ['form'] }),
    ],
  },
  {
    key: 'revenue',
    name: 'Umsatz',
    description: 'MRR, Umsatz je Monat und Produkt, offene und überfällige Rechnungen.',
    range: 'last_12_months',
    widgets: [
      kpi('MRR', { source: 'subscriptions', measures: ['calc:mrr'], range: 'all' }, true),
      kpi('Bezahlter Umsatz', { source: 'invoices', measures: ['calc:paid_amount'], date_field: 'paid_at' }),
      kpi('Offene Rechnungen', { source: 'invoices', measures: ['calc:open_amount'], range: 'all' }, true),
      kpi('Davon überfällig', { source: 'invoices', measures: ['calc:overdue_amount'], range: 'all' }, true),
      chart('Umsatz je Monat', 'bar', { source: 'invoices', measures: ['calc:paid_amount'], group_by: ['paid_at:month'], date_field: 'paid_at' }),
      chart('Umsatz je Produkt', 'hbar', { source: 'invoice_items', measures: ['calc:paid_revenue'], group_by: ['product'], date_field: 'paid_at', limit: 10 }),
      chart('Offene Rechnungen je Kunde', 'table', { source: 'invoices', measures: ['calc:open_amount', 'count'], group_by: ['contact'], filters: [{ field: 'kind', op: 'eq', value: 'invoice' }, { field: 'status', op: 'eq', value: 'sent' }], range: 'all', limit: 20 }, { fixed: true }),
      chart('MRR je Intervall', 'donut', { source: 'subscriptions', measures: ['calc:mrr'], group_by: ['interval'], range: 'all' }, { fixed: true }),
    ],
  },
  {
    key: 'activity',
    name: 'Aktivität',
    description: 'Anrufe, Nachrichten und Aufgaben je Nutzer, Spitzenzeiten.',
    range: 'last_30_days',
    widgets: [
      kpi('Anrufe', { source: 'calls', measures: ['count'] }),
      kpi('Ausgehende Nachrichten', { source: 'messages', measures: ['calc:outbound'] }),
      kpi('Erledigte Aufgaben', { source: 'tasks', measures: ['count'], date_field: 'completed_at', filters: [{ field: 'done', op: 'is_true' }] }),
      kpi('Annahmequote Anrufe', { source: 'calls', measures: ['calc:answer_rate'] }),
      chart('Anrufe je Nutzer', 'stacked', { source: 'calls', measures: ['count'], group_by: ['user', 'direction'] }),
      chart('Nachrichten je Kanal', 'stacked', { source: 'messages', measures: ['count'], group_by: ['channel', 'direction'] }),
      chart('Aufgaben je Nutzer', 'stacked', { source: 'tasks', measures: ['count'], group_by: ['assigned_to', 'done'] }),
      chart('Eingehende Nachrichten nach Wochentag und Uhrzeit', 'heatmap', { source: 'messages', measures: ['count'], group_by: ['created_at:weekday', 'created_at:hour'], filters: [{ field: 'direction', op: 'eq', value: 'in' }] }),
    ],
  },
  {
    key: 'appointments',
    name: 'Termine',
    description: 'Gebuchte Termine, No-Show-Rate und Auslastung je Kalender.',
    range: 'last_90_days',
    widgets: [
      kpi('Termine', { source: 'appointments', measures: ['count'] }),
      kpi('No-Show-Rate', { source: 'appointments', measures: ['calc:no_show_rate'] }),
      kpi('Show-Rate', { source: 'appointments', measures: ['calc:show_rate'] }),
      kpi('Absagequote', { source: 'appointments', measures: ['calc:cancel_rate'] }),
      chart('Termine je Kalender', 'stacked', { source: 'appointments', measures: ['count'], group_by: ['calendar', 'status'] }),
      chart('Termine je Woche', 'line', { source: 'appointments', measures: ['count'], group_by: ['start_at:week'], compare: true }),
      chart('No-Show-Rate je Kalender', 'hbar', { source: 'appointments', measures: ['calc:no_show_rate'], group_by: ['calendar'] }),
      chart('Termine nach Wochentag und Uhrzeit', 'heatmap', { source: 'appointments', measures: ['count'], group_by: ['start_at:weekday', 'start_at:hour'] }),
    ],
  },
];

/** Packs widgets left to right, top to bottom into 12 columns. */
export function packWidgets(list: { w: number; h: number }[]): { x: number; y: number }[] {
  const heights = new Array(12).fill(0);
  return list.map(({ w, h }) => {
    let best = { x: 0, y: Infinity };
    for (let x = 0; x + w <= 12; x++) {
      const y = Math.max(...heights.slice(x, x + w));
      if (y < best.y) best = { x, y };
    }
    for (let i = best.x; i < best.x + w; i++) heights[i] = best.y + h;
    return best;
  });
}
