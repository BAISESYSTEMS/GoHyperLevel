import type { App } from '../core/app.js';
import { now } from '../core/util.js';

/**
 * Settings of the e-mail marketing extras of a sub-account (list hygiene, address checks, send-time default, abandoned checkout).
 * One JSON row per sub-account in `mk_settings` (created by the campaigns module). Nothing secret in here.
 */

export interface MkSettings {
  hygiene: {
    /** This many soft bounces in a row put the address on "Nicht stören". */
    soft_bounce_limit: number;
    /** Do it automatically (hourly) – off means the dashboard only lists them. */
    auto_suppress: boolean;
    /** Contacts that got mail for this many months without opening it form the sunset segment. */
    sunset_months: number;
  };
  validation: {
    /** Check new addresses in the background (and right after a form or import). */
    auto: boolean;
    /** Look the domain up in DNS (MX). Off = syntax, disposable and role checks only. */
    mx: boolean;
    /** Campaigns skip addresses that cannot receive mail. */
    exclude_invalid: boolean;
    exclude_disposable: boolean;
    exclude_role: boolean;
  };
  sto: { default_hour: number };
  abandoned: {
    /** An abandoned checkout of an unknown e-mail address creates a contact (otherwise only known contacts are reminded). */
    create_contacts: boolean;
  };
}

export const DEFAULTS: MkSettings = {
  hygiene: { soft_bounce_limit: 3, auto_suppress: true, sunset_months: 6 },
  validation: { auto: true, mx: true, exclude_invalid: true, exclude_disposable: false, exclude_role: false },
  sto: { default_hour: 10 },
  abandoned: { create_contacts: false },
};

const int = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);

/** Cleans stored or submitted settings: unknown keys dropped, numbers clamped, missing values from `base`. */
export function cleanSettings(input: unknown, base: MkSettings = DEFAULTS): MkSettings {
  const o: Record<string, any> = input && typeof input === 'object' ? (input as Record<string, any>) : {};
  const h = { ...base.hygiene, ...(o.hygiene ?? {}) };
  const v = { ...base.validation, ...(o.validation ?? {}) };
  return {
    hygiene: { soft_bounce_limit: int(h.soft_bounce_limit, 2, 10, base.hygiene.soft_bounce_limit), auto_suppress: bool(h.auto_suppress, base.hygiene.auto_suppress), sunset_months: int(h.sunset_months, 1, 36, base.hygiene.sunset_months) },
    validation: { auto: bool(v.auto, base.validation.auto), mx: bool(v.mx, base.validation.mx), exclude_invalid: bool(v.exclude_invalid, base.validation.exclude_invalid), exclude_disposable: bool(v.exclude_disposable, base.validation.exclude_disposable), exclude_role: bool(v.exclude_role, base.validation.exclude_role) },
    sto: { default_hour: int({ ...base.sto, ...(o.sto ?? {}) }.default_hour, 0, 23, base.sto.default_hour) },
    abandoned: { create_contacts: bool({ ...base.abandoned, ...(o.abandoned ?? {}) }.create_contacts, base.abandoned.create_contacts) },
  };
}

export function getSettings(app: App, locationId: string): MkSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM mk_settings WHERE location_id = ?', locationId);
  if (!row) return DEFAULTS;
  try {
    return cleanSettings(JSON.parse(row.data));
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(app: App, locationId: string, patch: unknown): MkSettings {
  const next = cleanSettings(patch, getSettings(app, locationId));
  app.db.run(
    `INSERT INTO mk_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    locationId,
    JSON.stringify(next),
    now(),
  );
  return next;
}
