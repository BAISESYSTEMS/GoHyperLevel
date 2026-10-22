import type { App } from '../core/app.js';
import { csvSafe } from '../core/csv.js';
import { hiddenUser } from '../core/permissions.js';
import { todayYmd } from './acc-ledger.js';

/** Small helpers shared by the Back-Office modules (accounting, inventory, HR). */

/** Quantities and days with at most three decimals, without floating-point noise. */
export const q3 = (n: number) => Math.round(n * 1000) / 1000;

/** YYYY-MM-DD of today in the sub-account's time zone (the UTC date is still yesterday between 00:00 and 02:00 in Berlin). */
export const today = (app: App, locationId: string) => todayYmd(app, locationId);

/** Whether `v` is a real calendar date YYYY-MM-DD. */
export const isYmd = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Users who may use `area` in this sub-account (for notifications): agency admins, and members of the sub-account whose
 * permissions include it (null = all areas, unless `explicit` – then the area has to be listed).
 */
export function usersWithArea(app: App, locationId: string, area: string, opts: { explicit?: boolean } = {}): string[] {
  return app.db
    .all<{ id: string; role: string; locations: string; permissions: string | null }>('SELECT id, role, locations, permissions FROM users')
    .filter((u) => u.role === 'admin' || (JSON.parse(u.locations || '[]') as string[]).includes(locationId))
    .filter((u) => !hiddenUser(app, u, locationId))
    .filter((u) => {
      if (u.role === 'admin') return true;
      if (!u.permissions) return !opts.explicit;
      return (JSON.parse(u.permissions) as string[]).includes(area);
    })
    .map((u) => u.id);
}

/** Cents as German decimal text (1234,50). */
export const moneyDe = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, '0')}`;

/** Spreadsheet-friendly CSV: UTF-8 with BOM, semicolons, every field quoted, formulas neutralised (csvSafe). */
export const semicolonCsv = (rows: (string | number)[][]): string => '﻿' + rows.map((r) => r.map((v) => `"${csvSafe(v).replace(/"/g, '""')}"`).join(';')).join('\r\n') + '\r\n';
