/**
 * The Raum-Modus: its stylesheet (a chunk of its own, loaded only while `html[data-spatial="1"]` is on – the theme store imports
 * this module) and the one bit of behaviour that cannot be done in CSS: a checkbox or radio button is only a 34 px box, so in a
 * table cell, a list row or any wrapper where it is the only control, the whole empty area around it toggles it (60 px and more).
 */
import './spatial.css';
import { installTypeScale } from './type-scale';

export const SPATIAL_STYLES = true;

const CONTROLS = 'a, button, input, select, textarea, summary, label, [role="button"], [tabindex]';

/** The checkbox/radio a click on `target` (an empty area) should toggle, or null. Pure enough to test with a fake element. */
export function toggleTarget(target: Element | null): HTMLInputElement | null {
  const el = target as HTMLElement | null;
  if (!el || !el.children || el.matches?.(CONTROLS) || el.closest?.('label')) return null;
  const inputs = [...el.children].filter((c): c is HTMLInputElement => c.tagName === 'INPUT' && ['checkbox', 'radio'].includes((c as HTMLInputElement).type));
  if (inputs.length !== 1) return null;
  // only when the box is the cell's only control: anything else in it keeps its own click
  if ([...el.children].some((c) => c !== inputs[0] && c.matches(CONTROLS))) return null;
  return inputs[0].disabled ? null : inputs[0];
}

let installed = false;
export function installCellToggle(doc: Document = document) {
  if (installed) return;
  installed = true;
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || doc.documentElement.dataset.spatial !== '1') return;
    const input = toggleTarget(e.target as Element);
    if (input) input.click();
  });
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  try {
    installCellToggle();
    installTypeScale();
  } catch {
    /* a locked-down browser: the stylesheet alone is the Raum-Modus */
  }
}
