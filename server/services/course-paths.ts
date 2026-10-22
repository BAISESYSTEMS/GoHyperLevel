/**
 * Learning paths (a sequence of courses with unlock rules) and cohorts (a start date everybody's drip counts from) – the pure rules.
 */

export interface PathItem {
  course_id: string;
  title: string;
  /** The member's progress in this course, 0–100 (undefined: not enrolled). */
  percent?: number;
}

export interface PathStep extends PathItem {
  state: 'done' | 'open' | 'locked';
  /** Why a locked step is locked (names the course that has to be finished first). */
  reason: string;
}

/**
 * Where a member stands on a path. Without a sequence every course is open. In a sequence, a course opens once the one before it is at
 * least `unlockPercent` % done (100 = finished); a member who is not enrolled in a course counts as through it (nobody is locked
 * out forever by a course that was taken out of their access).
 */
export function pathSteps(items: PathItem[], opts: { sequential: boolean; unlockPercent: number }): PathStep[] {
  const need = Math.min(Math.max(Math.round(opts.unlockPercent) || 100, 1), 100);
  let blocker: PathItem | undefined;
  return items.map((it) => {
    const pct = it.percent ?? 100;
    const locked = opts.sequential && !!blocker;
    const step: PathStep = {
      ...it,
      state: pct >= 100 ? 'done' : locked ? 'locked' : 'open',
      reason: locked ? `Schließe zuerst den Kurs „${blocker!.title}“ ab (${blocker!.percent ?? 0} % von ${need} %).` : '',
    };
    if (!blocker && pct < need) blocker = it;
    return step;
  });
}

/** Share of the path's courses that are finished, 0–100. */
export const pathPercent = (steps: PathStep[]) => (steps.length ? Math.round((steps.filter((s) => s.state === 'done').length / steps.length) * 100) : 0);

// --- cohorts ------------------------------------------------------------------------------------------------------------------------

export type CohortState = 'upcoming' | 'running' | 'ended';

export const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function cleanYmd(v: unknown, what: string, required = true): string {
  const s = String(v ?? '').trim();
  if (!s) {
    if (required) throw new Error(`${what} fehlt`);
    return '';
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (!YMD.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`${what}: bitte als JJJJ-MM-TT angeben`);
  return s;
}

export function cohortState(c: { starts_at: string; ends_at?: string | null }, today: string): CohortState {
  if (c.starts_at > today) return 'upcoming';
  if (c.ends_at && c.ends_at < today) return 'ended';
  return 'running';
}

/**
 * The cohort a new member is put into (course setting "automatisch zuweisen"): the next one that has not started yet and has room;
 * if there is none, one that is running and has room (the member catches up); otherwise none.
 */
export function pickCohort(cohorts: { id: string; starts_at: string; ends_at?: string | null; capacity: number; members: number }[], today: string): string | undefined {
  const room = cohorts.filter((c) => !c.capacity || c.members < c.capacity);
  const upcoming = room.filter((c) => cohortState(c, today) === 'upcoming').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  if (upcoming[0]) return upcoming[0].id;
  const running = room.filter((c) => cohortState(c, today) === 'running').sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  return running[0]?.id;
}
