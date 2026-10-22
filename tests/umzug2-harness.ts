import { expect } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * Shared test plumbing of the "Umzug Welle 2" importers (systeme.io, Klaviyo, Brevo …): an app with the vendor HTTP stubbed
 * (app.services.umzugFetch = fake.fetch, no waiting), a fresh sub-account per describe block, and helpers to run an import
 * through the real routes and read the result back. The fakes live in umzug2-fakes.ts; nothing here touches the network.
 */
export type TestApp = Awaited<ReturnType<typeof startTestApp>>;

export async function umzugHarness() {
  const t = await startTestApp();
  await t.setup();
  t.app.services.umzugSleep = async () => undefined;
  t.app.services.umzugPauseMs = 0;
  const loc = () => t.api.location;
  const q = <T = any>(sql: string, ...p: any[]) => t.app.db.all<T>(sql, loc(), ...p);
  const one = <T = any>(sql: string, ...p: any[]) => t.app.db.get<T>(sql, loc(), ...p);
  /** One row by any SQL (no location parameter added). */
  const raw = <T = any>(sql: string, ...p: any[]) => t.app.db.get<T>(sql, ...p);
  const email = (e: string) => one('SELECT * FROM contacts WHERE location_id = ? AND email = ?', e);
  const tags = (e: string): string[] => JSON.parse(email(e)?.tags ?? '[]');
  const fresh = async (name: string) => {
    const r = await t.api.post('/api/locations', { name });
    expect(r.data.id, JSON.stringify(r.data)).toBeTruthy();
    t.api.setLocation(r.data.id);
    return r.data.id as string;
  };
  const wait = async (jobId: string) => {
    await t.app.services.umzug.idle();
    return (await t.api.get(`/api/umzug/jobs/${jobId}`)).data;
  };
  /** Starts an import (or a dry run) through the routes and waits for it. */
  const run = async (body: any, kind: 'jobs' | 'dry-run' = 'jobs') => {
    const r = await t.api.post(kind === 'jobs' ? '/api/umzug/jobs' : '/api/umzug/dry-run', body);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return wait(r.data.id);
  };
  const undo = async (jobId: string) => {
    const r = await t.api.post(`/api/umzug/jobs/${jobId}/undo`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return wait(jobId);
  };
  const lines = (job: any): Record<string, any> => Object.fromEntries((job.report ?? []).map((l: any) => [l.key, l]));
  /** Ledger events of a contact (consent_events), oldest first. */
  const ledger = (e: string): any[] => t.app.db.all('SELECT channel, purpose, action, source_kind, source_label, proof_url, note, created_at FROM consent_events WHERE contact_id = ? ORDER BY created_at, rowid', email(e)?.id ?? '');
  const count = (table: string) => Number(one(`SELECT COUNT(*) n FROM ${table} WHERE location_id = ?`)?.n ?? 0);
  return { t, loc, q, one, raw, email, tags, fresh, run, undo, wait, lines, ledger, count };
}
export type Harness = Awaited<ReturnType<typeof umzugHarness>>;
