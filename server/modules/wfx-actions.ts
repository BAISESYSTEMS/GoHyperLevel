import type { Module } from '../core/app.js';
import { bad } from '../core/http.js';
import { checkSyntax } from '../services/expr.js';
import { aiActions } from '../services/wfx-ai.js';
import { dataActions } from '../services/wfx-data.js';
import { flowActions, HARD_MAX_JUMPS, HARD_MAX_LOOP_ITEMS, MAX_VARIANTS } from '../services/wfx-flow.js';
import { httpActions } from '../services/wfx-http.js';
import { registerActions } from '../services/wfx-kit.js';
import { crmActions } from './wfx-crm.js';

/**
 * More workflow steps, each group in its own file: data and formatting (services/wfx-data.ts), flow – go-to, goal jump,
 * split test, loop, drip, waits (services/wfx-flow.ts), CRM and business steps (modules/wfx-crm.ts), AI steps with
 * structured output (services/wfx-ai.ts) and the HTTP request (services/wfx-http.ts). This module owns their tables
 * (split-test assignments, drip slots, round-robin state, do-not-disturb per channel), checks their settings when a workflow
 * is saved and registers them through app.services.workflowActions / workflowActionMeta. Docs: docs/workflow-actions.md.
 */

export const wfxActionsModule: Module = {
  name: 'wfx-actions',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE wfx_split (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, step_id TEXT NOT NULL,
        run_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        variant INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX wfx_split_run ON wfx_split(run_id, step_id);
      CREATE INDEX wfx_split_wf ON wfx_split(workflow_id, step_id, contact_id);
      CREATE TABLE wfx_drip (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, step_id TEXT NOT NULL,
        slot_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workflow_id, step_id, slot_at)
      );
      CREATE TABLE wfx_rr (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, key TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, current INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (location_id, key, user_id)
      );
      CREATE TABLE wfx_dnd (
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, channel TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (contact_id, channel)
      );
      CREATE INDEX IF NOT EXISTS messages_contact_dir ON messages(contact_id, direction, created_at);
      `,
    ],
  ],
  register(app) {
    registerActions(app, [...dataActions(app), ...flowActions(app), ...crmActions(app), ...aiActions(app), ...httpActions(app)]);

    // DND per channel: sendToContact (e-mail, SMS) and the Meta sender (WhatsApp, Messenger, Instagram) ask this before they send.
    const CHANNEL_LABEL: Record<string, string> = { email: 'E-Mail', sms: 'SMS', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' };
    app.services.channelDnd = (_loc: string, contactId: string, channel: string): string | undefined =>
      app.db.get('SELECT 1 FROM wfx_dnd WHERE contact_id = ? AND channel = ?', contactId, channel) ? `Kontakt hat „Nicht stören“ für ${CHANNEL_LABEL[channel] ?? channel} aktiv` : undefined;

    // Checked when a workflow is saved: broken expressions and out-of-range limits are refused early, with a clear message.
    const clamp = (v: unknown, lo: number, hi: number, d: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    app.services.workflowStepCleaners = {
      ...(app.services.workflowStepCleaners ?? {}),
      '*': (step: any) => {
        if (typeof step.expression === 'string' && step.expression.trim()) {
          const err = checkSyntax(step.expression);
          if (err) throw bad(`Ausdruck in „${step.name || step.type}“: ${err}`);
        }
      },
      code: (step: any) => {
        const err = checkSyntax(String(step.code ?? ''));
        if (err) throw bad(`Code-Schritt: ${err}`);
      },
      goto: (step: any) => void (step.max_jumps = clamp(step.max_jumps, 1, HARD_MAX_JUMPS, 10)),
      goal_jump: (step: any) => void (step.max_jumps = clamp(step.max_jumps, 1, HARD_MAX_JUMPS, 10)),
      loop: (step: any) => void (step.max_items = clamp(step.max_items, 1, HARD_MAX_LOOP_ITEMS, 100)),
      http_request: (step: any) => void (step.retries = clamp(step.retries, 0, 5, 2)),
      split_test: (step: any) => {
        const list = (Array.isArray(step.variants) ? step.variants : []).slice(0, MAX_VARIANTS);
        const variants = (list.length < 2 ? [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }] : list).map((v: any, i: number) => ({ name: String(v?.name || String.fromCharCode(65 + i)).trim().slice(0, 40), weight: clamp(v?.weight, 0, 100, 50) }));
        step.variants = variants;
      },
    };
  },
};
