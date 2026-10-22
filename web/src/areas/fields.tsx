import { useState, type ReactNode } from 'react';
import { isSimple } from '../../../server/services/areas-model';
import { useT } from '../i18n';
import { useLook } from '../theme/store';
import { anyFilled, moreFieldsOpen, visibleColumns } from './fields-model';

/**
 * Einfach-Modus in forms and tables (rules: ./fields-model.ts, how to use: docs/theming.md#einfach-modus).
 *
 *   <Field label="Name">…</Field>                 ← what everybody needs stays visible
 *   <MoreFields id="contact-form" values={[c.company, c.source, c.dob]}>
 *     <Field label="Firma">…</Field> …          ← the rest: one toggle in Einfach-Modus, inline in Profi
 *   </MoreFields>
 *   <ProOnly>…</ProOnly>                          ← expert settings: only in Profi
 */

/** Is the Einfach-Modus on (goals chosen and "Alles" not among them)? */
export function useSimple(): boolean {
  return isSimple(useLook().prefs.goals);
}

const KEY = (id: string) => `hl.more.${id}`;
function readStored(id: string): boolean | null {
  try {
    const v = localStorage.getItem(KEY(id));
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

/**
 * Secondary fields of a form. Einfach-Modus: a collapsed "Weitere Felder (n)" toggle – open when one of `values` is filled
 * in or when the person opened it before (remembered per `id`). Profi: the fields show inline, no toggle.
 */
export function MoreFields({ id, children, values, label, count }: { id: string; children: ReactNode; values?: readonly unknown[]; label?: string; count?: number }) {
  const t = useT('simple');
  const simple = useSimple();
  const [open, setOpen] = useState(() => moreFieldsOpen({ simple, stored: readStored(id), hasValue: values ? anyFilled(values) : false }));
  if (!simple) return <>{children}</>;
  const text = label ?? t('Weitere Felder');
  return (
    <details
      className="more-fields"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        try {
          localStorage.setItem(KEY(id), now ? '1' : '0');
        } catch {
          /* private mode: forgotten next time */
        }
      }}
    >
      <summary>
        {text}
        {count ? <span className="muted"> ({count})</span> : null}
      </summary>
      <div className="more-fields-body">{children}</div>
    </details>
  );
}

/** Expert settings: rendered only in Profi (Einfach-Modus shows nothing – switch to Profi in the quick settings to see them). */
export function ProOnly({ children }: { children: ReactNode }) {
  return useSimple() ? null : <>{children}</>;
}

/** Renders only in Einfach-Modus (a short hint instead of an expert panel). */
export function SimpleOnly({ children }: { children: ReactNode }) {
  return useSimple() ? <>{children}</> : null;
}

/**
 * Table columns for the Einfach-Modus: `cols` are the column keys in display order, `essential` those a busy admin needs.
 * Returns the keys to render and a small "Spalten" picker to switch more on (remembered per `id`). In Profi all columns show
 * and `picker` is null.
 */
export function useSimpleColumns(id: string, cols: readonly string[], essential: readonly string[], labels?: Record<string, string>): { visible: string[]; picker: ReactNode; has: (key: string) => boolean } {
  const t = useT('simple');
  const simple = useSimple();
  const [extra, setExtra] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`hl.cols.${id}`) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const visible = visibleColumns(cols, { simple, essential, extra });
  const has = (key: string) => visible.includes(key);
  if (!simple) return { visible, picker: null, has };
  const optional = cols.filter((c) => !essential.includes(c));
  if (!optional.length) return { visible, picker: null, has };
  const toggle = (c: string) => {
    const next = extra.includes(c) ? extra.filter((x) => x !== c) : [...extra, c];
    setExtra(next);
    try {
      localStorage.setItem(`hl.cols.${id}`, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  const picker = (
    <details className="cols-picker">
      <summary>{t('Spalten')}</summary>
      <div className="cols-picker-menu">
        {optional.map((c) => (
          <label key={c} className="check">
            <input type="checkbox" checked={extra.includes(c)} onChange={() => toggle(c)} /> {labels?.[c] ?? c}
          </label>
        ))}
      </div>
    </details>
  );
  return { visible, picker, has };
}
