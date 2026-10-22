import { createHash } from 'node:crypto';

/**
 * Feature flags with staged rollout: Aus → Privat (chosen users) → Sub-Accounts (chosen ones) → Prozent
 * (a stable share of sub-accounts) → Alle. Each stage includes the ones before it: a flag at "percent" is
 * also on for the listed users and sub-accounts. Pure decision logic; the module keeps the table.
 */

export type FlagStage = 'off' | 'private' | 'location' | 'percent' | 'all';
export const FLAG_STAGES: [FlagStage, string][] = [
  ['off', 'Aus'],
  ['private', 'Privat (ausgewählte Nutzer)'],
  ['location', 'Sub-Accounts (ausgewählte)'],
  ['percent', 'Prozent der Sub-Accounts'],
  ['all', 'Alle'],
];

export interface FlagRow {
  name: string;
  description: string;
  stage: FlagStage;
  percent: number;
  users: string[];
  locations: string[];
  created_at: string;
  updated_at: string;
}

/** Stages that count as the advanced rollout (Pro, see services/werkstatt/license.ts). */
export const PRO_STAGES: FlagStage[] = ['percent'];

export const FLAG_NAME_RE = /^[a-z][a-z0-9._-]{1,59}$/;

/** A stable number 0–99 for a flag and a subject: the same sub-account stays in or out as the percentage grows. */
export function bucket(name: string, subject: string): number {
  return createHash('sha256').update(`${name}\n${subject}`).digest().readUInt32BE(0) % 100;
}

export interface FlagContext {
  locationId?: string | null;
  userId?: string | null;
}

export function decide(flag: Pick<FlagRow, 'name' | 'stage' | 'percent' | 'users' | 'locations'>, ctx: FlagContext): boolean {
  if (flag.stage === 'off') return false;
  if (flag.stage === 'all') return true;
  if (ctx.userId && flag.users.includes(ctx.userId)) return true;
  if (flag.stage === 'private') return false;
  if (ctx.locationId && flag.locations.includes(ctx.locationId)) return true;
  if (flag.stage === 'location') return false;
  const subject = ctx.locationId || ctx.userId;
  return !!subject && bucket(flag.name, subject) < Math.max(0, Math.min(100, flag.percent));
}
