/**
 * When a draft (agent, MCP) may go into the composer (MsgDrafts.tsx): never over text someone is typing.
 *  - `none`: no draft, or this draft is already in the composer / was already offered.
 *  - `fill`: the composer is empty, or still holds the previous draft's untouched text – put the new draft in.
 *  - `offer`: the person has typed something of their own – only show "Neuer Entwurf verfügbar – übernehmen".
 */
export type DraftAction = 'none' | 'fill' | 'offer';

export function draftAction(o: { draftId?: string | null; seenId?: string | null; appliedBody?: string | null; current: string }): DraftAction {
  if (!o.draftId || o.draftId === o.seenId) return 'none';
  if (!o.current.trim()) return 'fill';
  if (o.appliedBody != null && o.current === o.appliedBody) return 'fill';
  return 'offer';
}
