import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { blockedConnections, installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { newApp, runWorkflow, type T } from './wfx-helpers.js';

/**
 * Second bug sweep, workflows: wfx-sweep.test.ts runs every action with its sample settings; this file runs each one with the settings
 * an editor leaves behind when nothing was filled in (no settings, every field null). Each step must end in a result or a clear German
 * step error – no JavaScript error text, no empty quotes, nothing sent to the customer, no connection out. And a static check over the
 * server code: every trigger in the catalogue has a source that fires it, every event name the code emits is a trigger or a known
 * internal event (a typo would be a trigger that never starts).
 */

let t: T;
const logged: string[] = [];
beforeAll(async () => {
  installOutboundGuard();
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ').slice(0, 300)));
  t = await newApp();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  uninstallOutboundGuard();
});

const UNCLEAR = /TypeError|ReferenceError|SyntaxError|RangeError|undefined|\bnull\b|NaN|\[object |\bat \S+ \(|is not a function|Cannot read|is not iterable|„“|\s$|SQLITE/;
/** Steps that steer the run rather than act (a wait without a duration is no wait), so they may leave no entry of their own. */
const CONTROL = ['goto', 'goal_jump', 'goal', 'end', 'if', 'split_test', 'loop', 'wait'];

describe('every action with empty settings', () => {
  it('ends in a result or a clear step error, sends nothing and calls nobody', async () => {
    const actions = (await t.api.get('/api/workflow-catalog')).data.actions as { type: string; fields?: { key: string }[] }[];
    expect(actions.length).toBeGreaterThanOrEqual(130);
    const found: string[] = [];
    for (const variant of ['leer', 'null'] as const) {
      for (const a of actions) {
        const step: Record<string, unknown> = { id: 'x', type: a.type };
        if (variant === 'null') for (const f of a.fields ?? []) step[f.key] = null;
        const e0 = logged.length;
        let res;
        try {
          res = await runWorkflow(t, [step, { id: 'after', type: 'set_variable', rows: [{ name: 'after', value: 'ja' }] }]);
        } catch (e) {
          found.push(`${variant} ${a.type}: Workflow abgelehnt – ${(e as Error).message.slice(0, 120)}`);
          continue;
        }
        if (!['completed', 'waiting', 'failed', 'stopped'].includes(res.run.status)) found.push(`${variant} ${a.type}: Status ${res.run.status}`);
        if (!res.log.some((l: any) => l.type === a.type) && res.run.status !== 'waiting' && !CONTROL.includes(a.type)) found.push(`${variant} ${a.type}: kein Protokolleintrag`);
        for (const l of res.log) {
          const text = String(l.error ?? '');
          if (text && UNCLEAR.test(text)) found.push(`${variant} ${a.type}: unklare Meldung „${text}“`);
        }
        if (logged.length > e0) found.push(`${variant} ${a.type}: Serverfehler ${logged.slice(e0).join(' | ')}`);
      }
    }
    expect(found).toEqual([]);
    expect(blockedConnections()).toEqual([]);
  }, 300_000);

  it('a mail or SMS step without content fails instead of sending a blank message', async () => {
    for (const [type, contact, error] of [
      ['send_email', {}, 'E-Mail ohne Betreff und Text – nichts gesendet'],
      ['send_sms', { phone: '+4915112345678' }, 'SMS ohne Text – nichts gesendet'],
    ] as const) {
      const r = await runWorkflow(t, [{ id: 's', type, subject: '{{contact.custom.leer}}', body: '{{contact.custom.leer}}' }], { contact });
      expect(r.log.find((l: any) => l.type === type)?.error, type).toBe(error);
      expect(Number(t.app.db.get(`SELECT COUNT(*) n FROM messages WHERE contact_id = ? AND direction = 'out'`, r.contact.id)!.n), type).toBe(0);
    }
  });
});

// --- static check: triggers ⇄ emitted events ------------------------------------------------------------

function sources(dir: string, out: Record<string, string> = {}) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (f.endsWith('.ts')) out[p] = readFileSync(p, 'utf8');
  }
  return out;
}

/** Events for other listeners (REST hooks, notifications, health score, call intelligence …) that are on purpose not workflow triggers. */
const INTERNAL_EVENTS = new Set([
  'social.approval', 'testimonial.received', 'opportunity.updated', 'portal.file_uploaded',
  'ads.approval_requested', 'ads.rule_triggered', 'agent.approval_needed', 'agent.replied', 'agent.run_finished', 'association.created', 'association.removed',
  'billing.cancel_requested', 'billing.plan_switched', 'blog.post_published', 'call.recorded', 'call.scored', 'call.transferred', 'company.deleted', 'contact.deleted',
  'contact.merged', 'dialer.voicemail_drop', 'feedback.replied', 'genmedia.failed', 'invoice.cancelled', 'invoice.finalised', 'invoice.partially_paid',
  'phone_number.bought', 'phone_number.released', 'pm.project.deleted', 'record.deleted', 'retainer.closed', 'sequence.enrolled', 'site.item_published',
  'task.commented', 'task.deleted', 'task.updated', 'time.logged', 'timer.started', 'timer.stopped', 'timesheet.decided', 'timesheet.submitted',
]);
/** Started by hand or by their own URL, not by an event. */
const NOT_EVENT_DRIVEN = new Set(['manual', 'webhook', 'webhook.received']);

describe('trigger catalogue and emitted events', () => {
  it('every trigger has a source and every emitted event name is known', async () => {
    const triggers: string[] = (await t.api.get('/api/workflow-catalog')).data.triggers.map((x: { type: string }) => x.type);
    expect(triggers.length).toBeGreaterThanOrEqual(140);
    const src = sources(join(__dirname, '..', 'server'));
    const emitted = new Set<string>();
    const prefixes: string[] = [];
    const indirect: string[] = []; // files that emit an event name held in a variable or constant
    for (const [file, s] of Object.entries(src)) {
      for (const m of s.matchAll(/\.emit\(/g)) {
        const seg = s.slice(m.index! + 6, m.index! + 306);
        const lit = seg.match(/^\s*[^,()]+(?:\([^()]*\))?\s*,\s*(['"])([a-z_]+\.[a-z_.]+)\1/);
        if (lit) emitted.add(lit[2]);
        else if (/^\s*[^,()]+(?:\([^()]*\))?\s*,\s*`([a-z_.]+)\$\{/.test(seg)) prefixes.push(seg.match(/`([a-z_.]+)\$\{/)![1]);
        else indirect.push(file);
      }
    }
    const fires = (type: string) =>
      NOT_EVENT_DRIVEN.has(type) ||
      emitted.has(type) ||
      prefixes.some((p) => type.startsWith(p)) ||
      Object.values(src).some((s) => s.includes(`flowsOf(app, '${type}')`) || s.includes(`dateScan('${type}'`) || s.includes(`'$.type') = '${type}'`)) ||
      indirect.some((f) => src[f].includes(`'${type}'`));
    const dead = triggers.filter((type) => !fires(type));
    expect(dead, `Auslöser ohne Quelle: ${dead.join(', ')}`).toEqual([]);
    const unknown = [...emitted].filter((e) => !triggers.includes(e) && !INTERNAL_EVENTS.has(e));
    expect(unknown, `Ereignisse, die kein Auslöser sind (Tippfehler? sonst in INTERNAL_EVENTS aufnehmen): ${unknown.join(', ')}`).toEqual([]);
    // the allow-list stays honest: every entry is still emitted somewhere
    expect([...INTERNAL_EVENTS].filter((e) => !emitted.has(e))).toEqual([]);
  });
});
