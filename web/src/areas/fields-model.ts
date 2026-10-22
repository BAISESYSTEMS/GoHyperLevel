/**
 * Rules of the Einfach-Modus for forms and tables (pure – shared by web/src/areas/fields.tsx and the tests).
 *
 * In Einfach-Modus a form shows only what most people fill in; the rest sits behind one "Weitere Felder" toggle
 * (MoreFields), a table only its essential columns (useSimpleColumns). Nothing is ever lost: a section that already holds
 * a value opens by itself, a toggle someone opened stays open (per form, in this browser), and Profi shows everything.
 */

/** Should a "Weitere Felder" section start open? */
export function moreFieldsOpen(opts: { simple: boolean; stored?: boolean | null; hasValue?: boolean }): boolean {
  if (!opts.simple) return true;
  if (opts.hasValue) return true;
  return opts.stored === true;
}

/** Is any of these form values filled in (so its section must not hide it)? Empty strings, null, [], {} and false are empty. */
export function anyFilled(values: readonly unknown[]): boolean {
  return values.some((v) => {
    if (v === null || v === undefined || v === false || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v as object).length > 0;
    return true;
  });
}

/**
 * The columns a table shows: in Profi all of them; in Einfach-Modus the essential ones plus those the person switched on
 * (`extra`), in their original order. Unknown keys in `essential`/`extra` are ignored; with no essential column at all
 * the first two columns show (a table never ends up empty).
 */
export function visibleColumns(all: readonly string[], opts: { simple: boolean; essential: readonly string[]; extra?: readonly string[] }): string[] {
  if (!opts.simple) return [...all];
  const keep = new Set([...opts.essential, ...(opts.extra ?? [])]);
  const out = all.filter((k) => keep.has(k));
  return out.length ? out : all.slice(0, 2);
}
