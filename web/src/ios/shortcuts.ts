/**
 * Hardware keyboard on iPad (Magic Keyboard, Smart Keyboard) and on every other device with one: the shortcuts the whole app knows,
 * and the pure matching of the ones this module adds (Cmd/Ctrl+N "Neu", Cmd/Ctrl+/ "Kürzel"). Cmd/Ctrl+K, +B, +Z and +Enter live
 * with their features (nav.tsx, theme/Sidebar.tsx, undo/Undo.tsx, the composers). Tests: tests/ios-logic.test.ts.
 */

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

export type Shortcut = 'new' | 'help';

/** The shortcut this key press is, or null. Cmd on Apple devices, Ctrl elsewhere – both count. Never while a dead key / IME composes. */
export function matchShortcut(e: KeyLike): Shortcut | null {
  if (e.defaultPrevented || e.isComposing || e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  if (k === 'n' && !e.shiftKey) return 'new';
  // Cmd+/ and (on layouts where "/" needs Shift) Cmd+?
  if (k === '/' || k === '?') return 'help';
  return null;
}

/** Cmd (Mac, iPad) or Ctrl (Windows, Linux) – for the labels. */
export const modKey = (platform: string, ua: string) => (/Mac|iPhone|iPad|iPod/.test(platform) || /iPad|iPhone|Macintosh/.test(ua) ? '⌘' : 'Strg');

export interface ShortcutRow {
  keys: string;
  text: string;
}

/** What the sheet lists. `mod` = ⌘ or Strg. */
export const shortcutRows = (mod: string): { group: string; rows: ShortcutRow[] }[] => [
  {
    group: 'Überall',
    rows: [
      { keys: `${mod} K`, text: 'Springen: Projekt, Seite, Claude-Sitzung' },
      { keys: `${mod} N`, text: 'Neu anlegen (die Hauptaktion der Seite)' },
      { keys: `${mod} B`, text: 'Seitenleiste ein- oder ausklappen' },
      { keys: `${mod} Z`, text: 'Rückgängig' },
      { keys: `${mod} /`, text: 'Diese Übersicht' },
      { keys: 'Esc', text: 'Fenster, Menü oder Übersicht schließen' },
      { keys: 'Tab · ⇧ Tab', text: 'Zum nächsten · vorigen Element' },
    ],
  },
  {
    group: 'In Textfeldern',
    rows: [
      { keys: `${mod} ⏎`, text: 'Senden bzw. Speichern' },
      { keys: 'Apple Pencil', text: 'Mit dem Stift in ein Feld schreiben (Scribble) – er wird zu Text' },
    ],
  },
  { group: 'Im Posteingang', rows: [{ keys: '?', text: 'Zeigt die Kürzel des Posteingangs (J/K, E, …)' }] },
];

/** Time holding Cmd/Ctrl alone before the hint appears (ms). */
export const HOLD_HINT_MS = 900;

/** The main action of the page: the first enabled, visible primary button in the page header (or anything marked data-new). */
export function primaryAction(root: ParentNode): HTMLElement | null {
  const found = root.querySelectorAll<HTMLElement>('[data-new], .page-head .actions .btn:not(.secondary):not(.ghost):not(.danger)');
  for (const el of found) {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.getClientRects().length === 0) continue;
    return el;
  }
  return null;
}
