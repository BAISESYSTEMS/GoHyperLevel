/**
 * Which off-site snapshots to keep (grandfather–father–son): the newest snapshot of each of the last `hourly` hours, of each of
 * the last `daily` days and of each of the last `monthly` months that have one (UTC). Everything else is pruned. Pure.
 */

export interface Retention {
  hourly: number;
  daily: number;
  monthly: number;
}

export const DEFAULT_RETENTION: Retention = { hourly: 48, daily: 14, monthly: 6 };

/** "48,14,6" → the retention; anything unreadable falls back to the default. */
export function parseRetention(v: string | undefined): Retention {
  const n = String(v ?? '').split(/[,/ ]+/).map((x) => Number(x));
  if (n.length !== 3 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 10_000) || n.every((x) => x === 0)) return { ...DEFAULT_RETENTION };
  return { hourly: n[0], daily: n[1], monthly: n[2] };
}

/** Stamp of a snapshot as it appears in object keys: 2026-10-10T14-05-00Z. */
export const stampOf = (at: Date) => at.toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
/** The time back from a stamp (undefined for anything else). */
export function timeOfStamp(stamp: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(stamp);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isFinite(t) ? t : undefined;
}

/** Splits the stamps into those to keep and those to delete. */
export function plan(stamps: string[], r: Retention): { keep: string[]; prune: string[] } {
  const sorted = [...new Set(stamps)].filter((s) => timeOfStamp(s) !== undefined).sort().reverse();
  const keep = new Set<string>();
  const pick = (n: number, bucket: (iso: string) => string) => {
    const seen = new Set<string>();
    for (const s of sorted) {
      if (seen.size >= n) break;
      const b = bucket(new Date(timeOfStamp(s)!).toISOString());
      if (seen.has(b)) continue;
      seen.add(b);
      keep.add(s);
    }
  };
  pick(r.hourly, (iso) => iso.slice(0, 13));
  pick(r.daily, (iso) => iso.slice(0, 10));
  pick(r.monthly, (iso) => iso.slice(0, 7));
  return { keep: sorted.filter((s) => keep.has(s)), prune: sorted.filter((s) => !keep.has(s)) };
}
