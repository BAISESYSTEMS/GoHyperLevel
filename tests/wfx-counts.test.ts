import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApp, type T } from './wfx-helpers.js';

/**
 * The depth of the native workflow library, counted from the registries (never typed by hand): at least 100 actions and 75
 * triggers, every one described for the picker, and the numbers the READMEs promise do not exceed what exists.
 */

let t: T;
beforeAll(async () => {
  t = await newApp();
});
afterAll(() => t.close());

const ROOT = join(__dirname, '..');

describe('workflow library depth', () => {
  it('has at least 100 actions and 75 triggers, all described', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    const actions = cat.actions as any[];
    const triggers = cat.triggers as any[];
    expect(cat.counts).toMatchObject({ actions: actions.length, triggers: triggers.length });
    expect(actions.length).toBeGreaterThanOrEqual(100);
    expect(triggers.length).toBeGreaterThanOrEqual(75);
    // no duplicates, and every registered handler / trigger shows up in the catalogue
    expect(new Set(actions.map((a) => a.type)).size).toBe(actions.length);
    expect(new Set(triggers.map((x) => x.type)).size).toBe(triggers.length);
    const registeredActions = Object.keys(t.app.services.workflowActions ?? {});
    for (const type of registeredActions) expect(actions.some((a) => a.type === type), `Aktion ${type} fehlt im Katalog`).toBe(true);
    for (const type of t.app.services.workflowTriggers as string[]) expect(triggers.some((x) => x.type === type), `Auslöser ${type} fehlt im Katalog`).toBe(true);
    const categories = new Set((cat.categories as any[]).map((c) => c.key));
    const triggerCategories = new Set((cat.trigger_categories as any[]).map((c) => c.key));
    for (const a of actions) {
      expect(a.label, a.type).toBeTruthy();
      expect(a.summary, `${a.type}: Aktion ohne Beschreibung – workflowActionMeta[type] ergänzen (docs/workflow-actions.md#adding-your-own-step)`).toBeTruthy();
      expect(categories.has(a.category), `${a.type}: Kategorie ${a.category}`).toBe(true);
    }
    for (const x of triggers) {
      expect(x.label, x.type).toBeTruthy();
      expect(x.summary, `${x.type}: Auslöser ohne Beschreibung – workflowTriggerMeta[type] bzw. registerTriggers() ergänzen (docs/workflow-actions.md#adding-your-own-step)`).toBeTruthy();
      expect(triggerCategories.has(x.category), `${x.type}: Kategorie ${x.category}`).toBe(true);
    }
  });

  it('the README numbers are real: claimed counts never exceed the registries', async () => {
    const { counts } = (await t.api.get('/api/workflow-catalog?compact=1')).data;
    const claims = (file: string, re: RegExp) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(re)].map((m) => Number(m[1]));
    const enTriggers = claims('README.md', /(\d+)\+? triggers/gi);
    const enActions = claims('README.md', /(\d+)\+? (?:built-in )?actions/gi);
    const deTriggers = claims('README.de.md', /(\d+)\+? Auslöser/g);
    const deActions = claims('README.de.md', /(\d+)\+? (?:eingebaute |integrierte )?Aktionen/g);
    expect(enTriggers.length, 'README.md nennt die Zahl der Trigger').toBeGreaterThan(0);
    expect(enActions.length, 'README.md nennt die Zahl der Aktionen').toBeGreaterThan(0);
    expect(deTriggers.length, 'README.de.md nennt die Zahl der Auslöser').toBeGreaterThan(0);
    expect(deActions.length, 'README.de.md nennt die Zahl der Aktionen').toBeGreaterThan(0);
    for (const n of [...enTriggers, ...deTriggers]) expect(n).toBeLessThanOrEqual(counts.triggers);
    for (const n of [...enActions, ...deActions]) expect(n).toBeLessThanOrEqual(counts.actions);
  });
});
