import { useState, type CSSProperties } from 'react';
import { useT } from './i18n';
import './tag-chip.css';

/**
 * A small colour picker: a swatch that opens twelve preset colours, "no colour" and the browser's own picker. Used for tag
 * colours and categories (pages/TagMeta.tsx) and pipeline stages (pages/Opportunities.tsx).
 */

/** Twelve colours that stay readable as chips and stage markers in light and dark themes. */
export const PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'];

export function ColorPick({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  const t = useT('tags');
  const [open, setOpen] = useState(false);
  return (
    <span className="tag-palette">
      <button type="button" className={`tag-swatch${value ? '' : ' none'}`} style={value ? ({ '--sw': value } as CSSProperties) : undefined} aria-expanded={open} aria-label={t('Farbe von {name} wählen', { name: label })} onClick={() => setOpen(!open)} />
      {open && (
        <span className="tag-palette" role="group" aria-label={t('Farben')}>
          <button type="button" className="tag-swatch none" aria-pressed={!value} aria-label={t('Keine Farbe')} onClick={() => (onChange(''), setOpen(false))} />
          {PALETTE.map((c) => (
            <button key={c} type="button" className="tag-swatch" style={{ '--sw': c } as CSSProperties} aria-pressed={value === c} aria-label={c} onClick={() => (onChange(c), setOpen(false))} />
          ))}
          <input type="color" value={value || '#3b82f6'} onChange={(e) => onChange(e.target.value)} aria-label={t('Eigene Farbe')} />
        </span>
      )}
    </span>
  );
}
