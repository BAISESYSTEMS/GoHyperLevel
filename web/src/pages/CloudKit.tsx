/** Shared by the customer's account area (Cloud*.tsx): the shapes the API returns and the fair-use meter. */

export interface Meter {
  used: number;
  limit: number | null;
  overage: string;
}
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  subdomain: string | null;
  location_id: string;
  plan: { key: 'solo' | 'team' | 'agency'; name: string; interval: 'month' | 'year'; price_cents: number; currency: string };
  phase: string;
  phase_label: string;
  status: string;
  billing: 'stripe' | 'manual';
  stripe: boolean;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  grace_until: string | null;
  read_only: boolean;
  comped: boolean;
  comp_until: string | null;
  deletion: { at: string; reason: string } | null;
  meters: Record<'emails' | 'sms' | 'ai' | 'storage_mb', Meter>;
  counts: { users: number; clients: number };
  entitlements: { users: number | null; white_label: boolean; client_accounts: boolean; custom_domain: boolean; max_clients: number | null };
  support: { until: string | null; active: boolean };
}
export interface CloudMe {
  customer: boolean;
  limited?: boolean;
  role?: 'owner' | 'member';
  read_only?: boolean;
  tenant: Tenant;
  support_email: string;
  legal: { pending: { doc: string; version: number }[] };
  status_url: string;
}

/** Why a customer cancels (keys as the server stores them). */
export const REASONS: [string, string][] = [
  ['price', 'Zu teuer'],
  ['features', 'Es fehlt eine Funktion'],
  ['switched', 'Zu einem anderen Anbieter gewechselt'],
  ['selfhost', 'Ich hoste selbst'],
  ['not_needed', 'Brauche ich nicht mehr'],
  ['other', 'Anderer Grund'],
];

export const PHASE_TONE: Record<string, 'green' | 'blue' | 'yellow' | 'red' | 'gray' | 'purple'> = { active: 'green', trial: 'blue', comped: 'purple', past_due: 'yellow', read_only: 'red', canceled: 'gray', deletion_scheduled: 'red' };

export function MeterBar({ label, m, unit = '' }: { label: string; m: Meter; unit?: string }) {
  const unlimited = m.limit === null;
  const pct = unlimited ? 0 : m.limit === 0 ? (m.used > 0 ? 100 : 0) : Math.min(100, Math.round((m.used / m.limit!) * 100));
  const passThrough = m.limit === 0 && m.overage === 'bill';
  return (
    <div className="saas-meter">
      <div className="saas-meter-head">
        <span>{label}</span>
        <strong>
          {m.used.toLocaleString('de-DE')}
          {unit}
          <span className="muted"> / {unlimited ? 'unbegrenzt' : passThrough ? 'zum Selbstkostenpreis' : `${m.limit!.toLocaleString('de-DE')}${unit}`}</span>
        </strong>
      </div>
      {!unlimited && !passThrough && (
        <div className={`bar${pct >= 100 ? ' full' : pct >= 80 ? ' high' : ''}`} title={`${pct} %`}>
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      {!unlimited && pct >= 100 && !passThrough && <small className="muted">Fair-Use-Grenze erreicht – {m.overage === 'bill' ? 'darüber hinaus wird zum Selbstkostenpreis berechnet.' : 'bitte melde dich, wenn du mehr brauchst.'}</small>}
    </div>
  );
}

