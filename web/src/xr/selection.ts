/**
 * "A click in the inbox updates the contact panel": pages tell what the person picked, the Arbeitsfläche (web/src/xr/Workspace.tsx)
 * listens. Outside the Arbeitsfläche nobody listens and publishing costs nothing, so a page may call this wherever a selection happens.
 */

export interface Selection {
  contactId?: string;
}

const listeners = new Set<(s: Selection) => void>();

export function publishSelection(s: Selection) {
  for (const f of listeners) f(s);
}

export function subscribeSelection(f: (s: Selection) => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}
