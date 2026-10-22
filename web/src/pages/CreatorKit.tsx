import { useState, type ReactNode } from 'react';
import { currentLocation } from '../api';
import { Badge, toastError } from '../ui';
import './creator.css';

/**
 * Small shared parts of the Creator & Commerce pages (Ratenzahlung, Mahnwesen, Quiz & Zertifikate, Kommentar-zu-DM): euro input,
 * panels, list rows, a progress bar and status badges. Everything is sized for eye tracking plus pinch (hit targets of at least
 * 44 px, clear hover and focus states) and lays out as panels that spread over ultrawide screens (creator.css).
 */

/** "99", "99,50", "99.50", "1.234,56", "1 234,56 €" → cents, or null when it is no amount. */
export function parseEuro(input: string): number | null {
  let s = String(input ?? '').replace(/[€\s]/g, '');
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0) s = s.replace(/\./g, '').replace(',', '.');
  else if (dot >= 0 && s.length - dot - 1 === 3 && s.indexOf('.') === dot && !/^0\./.test(s)) s = s.replace('.', '');
  else if (dot >= 0 && s.indexOf('.') !== dot) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Cents as the text of an input ("99,50"). */
export const euroText = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ','));

export function Panel({ title, sub, actions, children, tour, wide }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode; tour?: string; wide?: boolean }) {
  return (
    <section className={`cr-panel${wide ? ' wide' : ''}`} data-tour={tour}>
      <header className="cr-panel-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="muted small">{sub}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      <div className="cr-panel-body">{children}</div>
    </section>
  );
}

/** A list row that can be opened: large, with hover and focus state. */
export function Item({ onClick, children, side, tour, tone }: { onClick?: () => void; children: ReactNode; side?: ReactNode; tour?: string; tone?: 'warn' | 'bad' | 'ok' }) {
  const props = onClick ? { role: 'button', tabIndex: 0, onClick, onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) } : {};
  return (
    <div className={`cr-item${onClick ? ' click' : ''}${tone ? ` ${tone}` : ''}`} data-tour={tour} {...props}>
      <div className="cr-item-main">{children}</div>
      {side && <div className="cr-item-side">{side}</div>}
    </div>
  );
}

export const Progress = ({ value, max, label }: { value: number; max: number; label?: string }) => (
  <div className="cr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
    <i style={{ width: `${max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0}%` }} />
  </div>
);

export function Callout({ tone = 'info', children, tour }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode; tour?: string }) {
  return (
    <div className={`cr-callout ${tone}`} role={tone === 'info' ? 'note' : 'alert'} data-tour={tour}>
      {children}
    </div>
  );
}

/** Key/value lines of a detail dialog. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="cr-facts">
      {rows
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Opens and closes a section without leaving the page (settings with many texts). */
export function Fold({ title, children, open: start = false, tour }: { title: ReactNode; children: ReactNode; open?: boolean; tour?: string }) {
  const [open, setOpen] = useState(start);
  return (
    <div className={`cr-fold${open ? ' open' : ''}`} data-tour={tour}>
      <button type="button" className="cr-fold-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
      </button>
      {open && <div className="cr-fold-body">{children}</div>}
    </div>
  );
}

export const STATUS: Record<string, [string, 'gray' | 'green' | 'red' | 'blue' | 'yellow' | 'purple']> = {
  active: ['läuft', 'blue'],
  completed: ['abgeschlossen', 'green'],
  defaulted: ['ausgefallen', 'red'],
  canceled: ['beendet', 'gray'],
  open: ['offen', 'yellow'],
  failed: ['gescheitert', 'red'],
  recovered: ['wieder bezahlt', 'green'],
  closed: ['geschlossen', 'gray'],
  pending: ['wartet auf Freigabe', 'yellow'],
  sent: ['gesendet', 'green'],
  dismissed: ['verworfen', 'gray'],
  queued: ['wartet', 'gray'],
  done: ['erledigt', 'green'],
  skipped: ['übersprungen', 'gray'],
  rate_limited: ['gebremst', 'yellow'],
  submitted: ['abgegeben', 'yellow'],
  approved: ['bestanden', 'green'],
  rejected: ['überarbeiten', 'red'],
  graded: ['ausgewertet', 'green'],
  revoked: ['widerrufen', 'red'],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, 'gray'];
  return <Badge tone={tone}>{label}</Badge>;
}

export const ACCESS_LABEL: Record<string, string> = { active: 'Zugang aktiv', paused: 'Zugang pausiert', revoked: 'Zugang entzogen' };

/** Opens a file from an admin route (PDF, hand-in) in a new tab – or saves it under `saveAs`: the request carries the session, a plain link would not. */
export async function openAuthed(path: string, saveAs?: string) {
  try {
    const r = await fetch(path, { headers: { 'x-pghl': '1', 'x-location-id': currentLocation() } });
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `Fehler ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    if (saveAs) {
      const a = document.createElement('a');
      a.href = url;
      a.download = saveAs;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (e) {
    toastError(e);
  }
}

/** A base64 PDF (the certificate preview) in a new tab. */
export function openPdfBase64(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** The lessons of a course in reading order, for a select: "Modul › Lektion". */
export const lessonOptions = (outline: { title: string; lessons: { id: string; title: string }[] }[] | undefined): [string, string][] => (outline ?? []).flatMap((m) => m.lessons.map((l) => [l.id, `${m.title} › ${l.title}`] as [string, string]));
