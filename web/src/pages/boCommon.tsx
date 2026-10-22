import { useEffect, useState, type ReactNode } from 'react';
import { api, currentLocation, money, name as contactName } from '../api';
import { Icon } from '../icons';
import { Input, toastError } from '../ui';

/** Small pieces shared by the Back-Office pages (Buchhaltung, Lager, Personal). */

export const DISCLAIMER =
  'Buchhaltung light zur Vorbereitung für den Steuerberater – keine zertifizierte Buchhaltungssoftware, keine GoBD-Zertifizierung, keine Steuerberatung und keine Übermittlung an das Finanzamt (ELSTER). Bitte alle Auswertungen und Exporte mit dem Steuerberater abstimmen.';

export function Disclaimer({ text, compact }: { text?: string; compact?: boolean }) {
  return (
    <div className={`bo-note${compact ? ' compact' : ''}`} role="note" data-tour="acc-disclaimer">
      <Icon name="shield" size={16} />
      <span>{compact ? 'Buchhaltung light – Vorbereitung für den Steuerberater. Keine zertifizierte Software, keine GoBD-Zertifizierung, kein ELSTER.' : text || DISCLAIMER}</span>
    </div>
  );
}

/** "1.234,56" / "1234.56" / "12,5" → cents (null when empty or not a number). */
export function parseEuro(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/[\s€]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Cents → "12,50" for an input field. */
export const euroText = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ','));

/** A money field: the user types euros, the form holds text. */
export function EuroInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <Input {...rest} inputMode="decimal" placeholder={rest.placeholder ?? '0,00'} value={value} onChange={onChange} />;
}

export const signedMoney = (cents: number) => <span className={cents < 0 ? 'bo-neg' : undefined}>{money(cents)}</span>;

/** A link to a file download of a location route (the session cookie authenticates, the sub-account goes in the query). */
export const dlHref = (path: string, params: Record<string, string | number | undefined> = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  q.set('locationId', currentLocation());
  return `${path}?${q.toString()}`;
};

export const readDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    r.readAsDataURL(file);
  });

/** A file chooser button: hands each chosen file (as a data URL) to `onFile`; errors become toasts. */
export function FileButton({ label, accept, multiple, onFile, tour, icon = 'upload', secondary = true }: { label: ReactNode; accept: string; multiple?: boolean; onFile: (f: { name: string; type: string; data: string }) => Promise<unknown>; tour?: string; icon?: 'upload' | 'camera'; secondary?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={`btn${secondary ? ' secondary' : ''}${busy ? ' disabled' : ''}`} data-tour={tour} style={{ cursor: 'pointer' }}>
      <Icon name={icon} /> {busy ? 'Lädt …' : label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        disabled={busy}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!files.length) return;
          setBusy(true);
          try {
            for (const f of files) await onFile({ name: f.name, type: f.type, data: await readDataUrl(f) });
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}

export const ymdLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const germanDate = (ymd?: string | null) => (ymd ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : '–');

/** Cents of a stock quantity with up to three decimals ("1,5"). */
export const qty = (n: number | null | undefined) => (n === null || n === undefined ? '–' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 }).format(n));

/** Picks a CRM contact (supplier, linked person): type two letters, choose from the hits. */
export function ContactPick({ value, onChange, placeholder }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setRes([]);
    const t = setTimeout(() => api.get(`/api/search?q=${encodeURIComponent(q.trim())}`).then((r) => setRes(r.contacts ?? [])).catch(() => setRes([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (value)
    return (
      <div className="bo-pick">
        <span>{value.name}</span>
        <button type="button" className="icon-btn" aria-label="Kontakt entfernen" onClick={() => onChange(null)}>
          ✕
        </button>
      </div>
    );
  return (
    <div className="bo-pick-wrap">
      <Input value={q} onChange={setQ} placeholder={placeholder ?? 'Kontakt suchen …'} />
      {res.length > 0 && (
        <div className="bo-pick-results">
          {res.map((c) => (
            <button type="button" key={c.id} onClick={() => (onChange({ id: c.id, name: contactName(c) }), setQ(''), setRes([]))}>
              {contactName(c)} <span className="muted small">{c.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
