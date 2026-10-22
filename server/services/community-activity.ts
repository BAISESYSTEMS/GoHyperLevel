import type { App } from '../core/app.js';
import { addDaysYmd, weekdayKey, ymdInTz } from '../core/time.js';
import { escapeHtml } from '../core/template.js';

/**
 * A member's activity over the last year (posts, comments, likes given, challenge check-ins, answers in polls) as a calendar of
 * small squares – the heatmap on the profile – and the numbers next to it.
 */

const DAYS = 371; // 53 weeks

/** Contributions per local day (YYYY-MM-DD) in the last year. */
export function contributions(app: App, locationId: string, contactId: string, tz: string, at = new Date()): Map<string, number> {
  const since = new Date(at.getTime() - 366 * 864e5).toISOString();
  const rows = app.db.all<{ at: string }>(
    `SELECT created_at AS at FROM community_posts WHERE location_id = ? AND contact_id = ? AND created_at >= ? AND status = 'visible'
     UNION ALL SELECT created_at FROM community_comments WHERE location_id = ? AND contact_id = ? AND created_at >= ? AND status = 'visible'
     UNION ALL SELECT l.created_at FROM community_likes l JOIN community_groups g ON g.id = l.group_id WHERE g.location_id = ? AND l.contact_id = ? AND l.created_at >= ?
     UNION ALL SELECT created_at FROM community_poll_votes v WHERE v.contact_id = ? AND v.created_at >= ? AND EXISTS (SELECT 1 FROM community_polls p WHERE p.id = v.poll_id AND p.location_id = ?)
     UNION ALL SELECT checked_at FROM community_challenge_checkins WHERE location_id = ? AND contact_id = ? AND checked_at >= ?`,
    locationId, contactId, since, locationId, contactId, since, locationId, contactId, since, contactId, since, locationId, locationId, contactId, since,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const day = ymdInTz(new Date(r.at), tz);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

export const heatLevel = (n: number) => (n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4);

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Longest run of consecutive active days ending today or yesterday (current streak). */
export function currentStreak(map: Map<string, number>, today: string): number {
  let day = map.has(today) ? today : addDaysYmd(today, -1);
  let n = 0;
  while (map.has(day)) {
    n++;
    day = addDaysYmd(day, -1);
  }
  return n;
}

export function heatmapSvg(map: Map<string, number>, today: string): string {
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const dow = order.indexOf(weekdayKey(today));
  // The grid starts on a Monday, 52 weeks and the days of this week back.
  const first = addDaysYmd(today, -(DAYS - 1 - (6 - dow)));
  const cell = 11;
  const pitch = 14;
  const left = 0;
  const top = 16;
  const cols = Math.ceil((DAYS + 6 - dow) / 7);
  const cells: string[] = [];
  const labels: string[] = [];
  let lastMonth = -1;
  for (let i = 0; i < cols * 7; i++) {
    const day = addDaysYmd(first, i);
    if (day > today) break;
    const col = Math.floor(i / 7);
    const row = i % 7;
    const n = map.get(day) ?? 0;
    const month = Number(day.slice(5, 7)) - 1;
    if (row === 0 && month !== lastMonth && Number(day.slice(8, 10)) <= 7) {
      labels.push(`<text x="${left + col * pitch}" y="10" class="hml">${MONTHS[month]}</text>`);
      lastMonth = month;
    }
    cells.push(`<rect x="${left + col * pitch}" y="${top + row * pitch}" width="${cell}" height="${cell}" rx="2" class="hm${heatLevel(n)}"><title>${escapeHtml(`${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}: ${n} ${n === 1 ? 'Beitrag' : 'Beiträge'}`)}</title></rect>`);
  }
  const w = left + cols * pitch;
  return `<svg class="cm-heat" viewBox="0 0 ${w} ${top + 7 * pitch}" role="img" aria-label="Aktivität der letzten 12 Monate">${labels.join('')}${cells.join('')}</svg>`;
}
