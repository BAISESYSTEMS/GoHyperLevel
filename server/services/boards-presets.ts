/**
 * Living Boards: ready-made numbers and charts. A preset is a report query the report engine already understands
 * (services/report-sources.ts), with a name people (and the agent) can pick. The KPI and chart widgets also take a
 * saved report from the library or a free query – presets just make the common cases one click.
 */

export interface ReportQuery {
  source: string;
  measures: string[];
  group_by?: string[];
  filters?: { field: string; op: string; value?: unknown }[];
  date_field?: string;
  range?: string;
  compare?: boolean;
  sort?: { by: string; dir: 'asc' | 'desc' };
  limit?: number;
}

export interface KpiPreset {
  label: string;
  hint: string;
  query: ReportQuery;
  /** The range stays (e.g. "open pipeline value" is always over everything). */
  fixedRange?: boolean;
}
export interface ChartPreset {
  label: string;
  hint: string;
  viz: 'line' | 'area' | 'bar' | 'hbar' | 'pie' | 'donut' | 'funnel' | 'stacked';
  query: ReportQuery;
  fixedRange?: boolean;
}

const OPEN = { field: 'status', op: 'eq', value: 'open' };
const WON = { field: 'status', op: 'eq', value: 'won' };

export const KPI_PRESETS: Record<string, KpiPreset> = {
  open_pipeline_value: { label: 'Offener Pipeline-Wert', hint: 'Summe aller offenen Deals', fixedRange: true, query: { source: 'opportunities', measures: ['calc:open_value'], range: 'all' } },
  pipeline_forecast: { label: 'Umsatzprognose (gewichtet)', hint: 'Offene Deals × Wahrscheinlichkeit ihrer Phase', fixedRange: true, query: { source: 'opportunities', measures: ['calc:forecast'], range: 'all' } },
  open_deals: { label: 'Offene Deals', hint: 'Anzahl der offenen Opportunities', fixedRange: true, query: { source: 'opportunities', measures: ['count'], filters: [OPEN], range: 'all' } },
  win_rate: { label: 'Win-Rate', hint: 'Gewonnen ÷ (gewonnen + verloren)', query: { source: 'opportunities', measures: ['calc:win_rate'], date_field: 'closed_at', range: 'last_90_days', compare: true } },
  won_revenue: { label: 'Gewonnener Umsatz', hint: 'Summe der gewonnenen Deals', query: { source: 'opportunities', measures: ['calc:won_value'], date_field: 'won_at', range: 'this_month', compare: true } },
  new_contacts: { label: 'Neue Kontakte', hint: 'Neu angelegte Kontakte', query: { source: 'contacts', measures: ['count'], range: 'last_30_days', compare: true } },
  open_tasks: { label: 'Offene Aufgaben', hint: 'Alle Aufgaben, die noch nicht erledigt sind', fixedRange: true, query: { source: 'tasks', measures: ['calc:open_count'], range: 'all' } },
  overdue_tasks: { label: 'Überfällige Aufgaben', hint: 'Offene Aufgaben mit abgelaufenem Termin', fixedRange: true, query: { source: 'tasks', measures: ['count'], filters: [{ field: 'overdue', op: 'is_true' }], range: 'all' } },
  tasks_done: { label: 'Erledigte Aufgaben', hint: 'Aufgaben, die im Zeitraum erledigt wurden', query: { source: 'tasks', measures: ['count'], date_field: 'completed_at', filters: [{ field: 'done', op: 'is_true' }], range: 'last_7_days', compare: true } },
  unread_conversations: { label: 'Ungelesene Gespräche', hint: 'Konversationen mit ungelesenen Nachrichten', fixedRange: true, query: { source: 'conversations', measures: ['count'], filters: [{ field: 'unread', op: 'is_true' }], range: 'all' } },
  appointments: { label: 'Termine', hint: 'Gebuchte Termine im Zeitraum', query: { source: 'appointments', measures: ['count'], range: 'last_30_days', compare: true } },
  no_show_rate: { label: 'No-Show-Rate', hint: 'Nicht erschienen ÷ (erschienen + nicht erschienen)', query: { source: 'appointments', measures: ['calc:no_show_rate'], range: 'last_90_days', compare: true } },
  paid_revenue: { label: 'Bezahlter Umsatz', hint: 'Bezahlte Rechnungen im Zeitraum (brutto)', query: { source: 'invoices', measures: ['calc:paid_amount'], date_field: 'paid_at', range: 'this_month', compare: true } },
  open_invoices: { label: 'Offene Rechnungen', hint: 'Versendete, noch nicht bezahlte Rechnungen', fixedRange: true, query: { source: 'invoices', measures: ['calc:open_amount'], range: 'all' } },
  overdue_invoices: { label: 'Überfällige Rechnungen', hint: 'Offene Rechnungen nach Fälligkeit', fixedRange: true, query: { source: 'invoices', measures: ['calc:overdue_amount'], range: 'all' } },
  mrr: { label: 'MRR', hint: 'Monatlich wiederkehrender Umsatz aktiver Abos', fixedRange: true, query: { source: 'subscriptions', measures: ['calc:mrr'], range: 'all' } },
  form_submissions: { label: 'Formular-Einsendungen', hint: 'Eingegangene Formulare im Zeitraum', query: { source: 'form_submissions', measures: ['count'], range: 'last_30_days', compare: true } },
  calls: { label: 'Anrufe', hint: 'Telefonate im Zeitraum', query: { source: 'calls', measures: ['count'], range: 'last_30_days', compare: true } },
  messages_out: { label: 'Ausgehende Nachrichten', hint: 'Gesendete Nachrichten im Zeitraum', query: { source: 'messages', measures: ['calc:outbound'], range: 'last_30_days', compare: true } },
  tickets_open: { label: 'Offene Tickets', hint: 'Tickets, die noch bearbeitet werden', fixedRange: true, query: { source: 'tickets', measures: ['count'], filters: [{ field: 'open', op: 'is_true' }], range: 'all' } },
  ticket_sla: { label: 'SLA-Quote', hint: 'Tickets, bei denen die Fristen eingehalten wurden', query: { source: 'tickets', measures: ['calc:sla_rate'], range: 'last_90_days', compare: true } },
  csat: { label: 'Kundenzufriedenheit (CSAT)', hint: 'Durchschnittliche Bewertung 1–5 nach Tickets', query: { source: 'csat_responses', measures: ['avg:score'], range: 'last_90_days', compare: true } },
};

export const CHART_PRESETS: Record<string, ChartPreset> = {
  leads_by_week: { label: 'Neue Kontakte je Woche', hint: 'Verlauf der neuen Kontakte', viz: 'line', query: { source: 'contacts', measures: ['count'], group_by: ['created_at:week'], range: 'last_90_days', compare: true } },
  leads_by_source: { label: 'Kontakte je Quelle', hint: 'Woher die Kontakte kommen', viz: 'hbar', query: { source: 'contacts', measures: ['count'], group_by: ['source'], range: 'last_90_days', limit: 8 } },
  pipeline_by_stage: { label: 'Pipeline je Phase', hint: 'Wert der offenen Deals je Phase (Trichter)', viz: 'funnel', fixedRange: true, query: { source: 'opportunities', measures: ['sum:value'], group_by: ['stage'], filters: [OPEN], range: 'all' } },
  won_by_month: { label: 'Gewonnener Umsatz je Monat', hint: 'Gewonnene Deals der letzten 12 Monate', viz: 'bar', query: { source: 'opportunities', measures: ['sum:value'], group_by: ['won_at:month'], filters: [WON], date_field: 'won_at', range: 'last_12_months' } },
  forecast_by_close_month: { label: 'Prognose je Abschlussmonat', hint: 'Offene Deals nach erwartetem Abschluss: gewichtete Prognose und voller Wert', viz: 'bar', fixedRange: true, query: { source: 'opportunities', measures: ['calc:forecast', 'sum:value'], group_by: ['expected_close_date:month'], filters: [OPEN], date_field: 'expected_close_date', range: 'all' } },
  lost_reasons: { label: 'Verlustgründe', hint: 'Warum Deals verloren gehen (Anzahl und Wert)', viz: 'hbar', query: { source: 'opportunities', measures: ['count', 'calc:lost_value'], group_by: ['lost_reason'], filters: [{ field: 'status', op: 'eq', value: 'lost' }], date_field: 'lost_at', range: 'last_90_days', limit: 8 } },
  deals_by_owner: { label: 'Offene Deals je Zuständigem', hint: 'Wer wie viele offene Deals hat', viz: 'hbar', fixedRange: true, query: { source: 'opportunities', measures: ['count'], group_by: ['assigned_to'], filters: [OPEN], range: 'all' } },
  revenue_by_month: { label: 'Umsatz je Monat', hint: 'Bezahlte Rechnungen der letzten 12 Monate', viz: 'bar', query: { source: 'invoices', measures: ['calc:paid_amount'], group_by: ['paid_at:month'], date_field: 'paid_at', range: 'last_12_months' } },
  revenue_by_product: { label: 'Umsatz je Produkt', hint: 'Welche Produkte den Umsatz bringen', viz: 'hbar', query: { source: 'invoice_items', measures: ['calc:paid_revenue'], group_by: ['product'], date_field: 'paid_at', range: 'last_90_days', limit: 10 } },
  mrr_by_interval: { label: 'MRR je Intervall', hint: 'Abos nach Abrechnungsintervall', viz: 'donut', fixedRange: true, query: { source: 'subscriptions', measures: ['calc:mrr'], group_by: ['interval'], range: 'all' } },
  appointments_by_week: { label: 'Termine je Woche', hint: 'Gebuchte Termine im Verlauf', viz: 'line', query: { source: 'appointments', measures: ['count'], group_by: ['start_at:week'], range: 'last_90_days', compare: true } },
  messages_by_channel: { label: 'Nachrichten je Kanal', hint: 'E-Mail, SMS, Chat …', viz: 'donut', query: { source: 'messages', measures: ['count'], group_by: ['channel'], range: 'last_30_days' } },
  tasks_by_user: { label: 'Offene Aufgaben je Person', hint: 'Wer wie viele offene Aufgaben hat', viz: 'hbar', fixedRange: true, query: { source: 'tasks', measures: ['count'], group_by: ['assigned_to'], filters: [{ field: 'done', op: 'is_false' }], range: 'all' } },
  tickets_by_kind: { label: 'Tickets nach Status', hint: 'Neu, offen, gelöst …', viz: 'donut', query: { source: 'tickets', measures: ['count'], group_by: ['status_kind'], range: 'last_90_days' } },
  tickets_by_week: { label: 'Tickets je Woche', hint: 'Eingang neuer Tickets', viz: 'line', query: { source: 'tickets', measures: ['count'], group_by: ['created_at:week'], range: 'last_90_days', compare: true } },
  calls_by_user: { label: 'Anrufe je Person', hint: 'Telefonate je Mitarbeiter', viz: 'hbar', query: { source: 'calls', measures: ['count'], group_by: ['user'], range: 'last_30_days' } },
};

export const RANGES: [string, string][] = [
  ['', 'Wie vorgegeben'],
  ['today', 'Heute'],
  ['yesterday', 'Gestern'],
  ['this_week', 'Diese Woche'],
  ['last_7_days', 'Letzte 7 Tage'],
  ['last_30_days', 'Letzte 30 Tage'],
  ['last_90_days', 'Letzte 90 Tage'],
  ['this_month', 'Dieser Monat'],
  ['last_month', 'Letzter Monat'],
  ['this_quarter', 'Dieses Quartal'],
  ['last_12_months', 'Letzte 12 Monate'],
  ['this_year', 'Dieses Jahr'],
  ['all', 'Gesamter Zeitraum'],
];

/** The query a KPI or chart config stands for (before the range and comparison of the config are applied). */
export function presetQuery(kind: 'kpi' | 'chart', preset: string): { query: ReportQuery; viz?: string; label: string; fixedRange: boolean } | null {
  const p = kind === 'kpi' ? KPI_PRESETS[preset] : CHART_PRESETS[preset];
  if (!p) return null;
  return { query: JSON.parse(JSON.stringify(p.query)), viz: 'viz' in p ? (p as ChartPreset).viz : undefined, label: p.label, fixedRange: !!p.fixedRange };
}
