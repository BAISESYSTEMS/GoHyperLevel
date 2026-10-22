import { useEffect, useState, type ReactNode } from 'react';
import { currentLocation } from '../api';
import { api } from '../api';
import { Badge, Field, Input, act, useLoad } from '../ui';
import './community-admin.css';

/** Small pieces the lazy community tabs share (cards, key figures, copy field, sub-tabs). */

export const fileHref = (path: string) => `${path}${path.includes('?') ? '&' : '?'}locationId=${encodeURIComponent(currentLocation())}`;

export function Sec({ title, lead, children, tour, right }: { title: string; lead?: ReactNode; children: ReactNode; tour?: string; right?: ReactNode }) {
  return (
    <section className="cma-sec" data-tour={tour}>
      {right ? (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {right}
        </div>
      ) : (
        <h3>{title}</h3>
      )}
      {lead && <p className="lead">{lead}</p>}
      {children}
    </section>
  );
}

export function Kpi({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'red' | 'green' }) {
  return (
    <div className="cma-kpi">
      <small>{label}</small>
      <b style={tone ? { color: `var(--${tone})` } : undefined}>{value}</b>
      {note && <i>{note}</i>}
    </div>
  );
}

export function Sub({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="cma-sub" role="tablist">
      {tabs.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={k === value} className={k === value ? 'on' : ''} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1800);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Field label={label ?? 'Link'}>
      <div className="cma-copy">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label={label ?? 'Link'} />
        <button
          type="button"
          className="btn secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setDone(true);
            } catch {
              /* selecting the text is enough */
            }
          }}
        >
          {done ? 'Kopiert ✓' : 'Kopieren'}
        </button>
      </div>
    </Field>
  );
}

/** Number input that keeps an empty field empty (null) instead of 0. */
export function NumberField({ label, value, onChange, hint, min, max, placeholder }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void; hint?: ReactNode; min?: number; max?: number; placeholder?: string }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" min={min} max={max} placeholder={placeholder} value={value ?? ''} onChange={(v) => onChange(v === '' ? null : Number(v))} />
    </Field>
  );
}

export const toneOf = (status: string): 'green' | 'yellow' | 'red' | 'gray' | 'blue' =>
  ({ active: 'green', trialing: 'blue', pending: 'yellow', awaiting_payment: 'yellow', past_due: 'red', canceled: 'gray', rejected: 'gray' } as const)[status as 'active'] ?? 'gray';
export const statusText: Record<string, string> = { active: 'Aktiv', trialing: 'Testphase', pending: 'Wartet auf Freigabe', awaiting_payment: 'Wartet auf Zahlung', past_due: 'Zahlung offen', canceled: 'Beendet', rejected: 'Abgelehnt' };

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={toneOf(status)}>{statusText[status] ?? status}</Badge>;
}

/** Search a member of the group and pick one. */
export function MemberPick({ group, onPick }: { group: any; onPick: (m: any) => void }) {
  const [q, setQ] = useState('');
  const list = useLoad(() => (q.trim().length >= 2 ? api.get<any[]>(`/api/community/groups/${group.id}/members?q=${encodeURIComponent(q.trim())}`) : Promise.resolve([] as any[])), [group.id, q]);
  return (
    <>
      <Field label="Mitglied suchen">
        <Input value={q} onChange={setQ} placeholder="Name oder E-Mail (mindestens 2 Zeichen)" autoFocus />
      </Field>
      <ul className="cma-list">
        {(list.data ?? []).slice(0, 8).map((m) => (
          <li key={m.contact_id}>
            <div className="grow">
              <strong>{m.display_name || m.email}</strong>
              <div className="muted small">{m.email}</div>
            </div>
            <button className="btn small" onClick={() => onPick(m)}>
              Auswählen
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
/** Runs a request, shows the toast and reloads on success. */
export const run = async (fn: () => Promise<unknown>, ok: string, then?: () => void) => {
  const r = await act(fn, ok);
  if (r !== undefined) then?.();
  return r;
};

/** Local date-time input value ⇄ ISO. */
export const toLocalInput = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : '');
export const euro = (cents: number, cur = 'EUR') => new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur }).format((cents || 0) / 100);
