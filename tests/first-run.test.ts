import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_CHOICES, SUCCESS_CHOICES, dataChoices, firstSteps, progressOf, skipGoals, successChoices, suggestedSuccess, type FirstRunPlan } from '../web/src/onboarding/first-run-model';
import catalog from '../web/src/i18n/en/onboarding';
import { adminHome } from '../web/src/onboarding/home';

const plan = (p: Partial<FirstRunPlan>): FirstRunPlan => ({ data: 'import', success: 'form', at: '2026-11-12T10:00:00Z', ...p });

describe('Willkommens-Assistent: choices', () => {
  it('suggests the first success that fits the goals', () => {
    expect(suggestedSuccess(['leads'])).toBe('form');
    expect(suggestedSuccess(['courses', 'leads'])).toBe('course');
    expect(suggestedSuccess(['agency'])).toBe('site');
    expect(suggestedSuccess(['office'])).toBe('booking');
    expect(suggestedSuccess([])).toBe('form');
  });

  it('offers a course only when courses are a goal (or everything is in the menu)', () => {
    expect(successChoices(['leads']).map((c) => c.id)).toEqual(['booking', 'form', 'site']);
    expect(successChoices(['courses']).map((c) => c.id)).toContain('course');
    expect(successChoices(['all']).map((c) => c.id)).toContain('course');
  });

  it('shows the practice company to admins and the move to people with the settings area only', () => {
    expect(dataChoices({ admin: true, settings: true }).map((c) => c.id)).toEqual(['import', 'umzug', 'practice', 'empty']);
    expect(dataChoices({ admin: false, settings: true }).map((c) => c.id)).toEqual(['import', 'umzug', 'empty']);
    expect(dataChoices({ admin: false, settings: false }).map((c) => c.id)).toEqual(['import', 'empty']);
  });

  it('skipping step 1 keeps the whole menu, later the goals picked so far', () => {
    expect(skipGoals(1, ['leads'])).toEqual(['all']);
    expect(skipGoals(2, ['courses', 'office'])).toEqual(['courses', 'office']);
    expect(skipGoals(3, [])).toEqual(['all']);
  });

  it('opens the page with its dialog right away', () => {
    expect(DATA_CHOICES.find((c) => c.id === 'import')!.to).toBe('contacts?import=1');
    expect(SUCCESS_CHOICES.find((c) => c.id === 'form')!.to).toBe('forms?gallery=1');
    expect(SUCCESS_CHOICES.find((c) => c.id === 'booking')!.to).toBe('calendars?new=1');
  });
});

describe('"Erste Schritte" card', () => {
  it('ticks steps off from real data only – unknown facts never count', () => {
    const steps = firstSteps(plan({}), {});
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ['data', false],
      ['success', false],
      ['tour', false],
    ]);
    const later = firstSteps(plan({}), { contacts: 12, forms: 1, tour: true });
    expect(later.every((s) => s.done)).toBe(true);
    expect(progressOf(later)).toEqual({ done: 3, total: 3, next: undefined });
  });

  it('counts the chosen success: a calendar for the booking page, a form for the form', () => {
    expect(firstSteps(plan({ success: 'booking' }), { calendars: 1, forms: 0 })[1].done).toBe(true);
    expect(firstSteps(plan({ success: 'form' }), { calendars: 1, forms: 0 })[1].done).toBe(false);
  });

  it('"Leer starten" puts the first success first and keeps the import as the last step', () => {
    const steps = firstSteps(plan({ data: 'empty' }), { contacts: 0 });
    expect(steps.map((s) => s.key)).toEqual(['success', 'tour', 'data']);
    expect(steps[2]).toMatchObject({ to: 'contacts?import=1', done: false });
    expect(progressOf(steps).next?.key).toBe('success');
  });

  it('practising is done once the practice company exists', () => {
    expect(firstSteps(plan({ data: 'practice' }), { practice: true })[0]).toMatchObject({ key: 'data', to: 'academy', done: true });
    expect(firstSteps(plan({ data: 'practice' }), { practice: false, contacts: 5 })[0].done).toBe(false);
  });

  it('the next open step is the one primary action', () => {
    const steps = firstSteps(plan({}), { contacts: 3 });
    expect(progressOf(steps)).toMatchObject({ done: 1, total: 3, next: { key: 'success' } });
  });
});

describe('Ersteinstieg texts', () => {
  it('every label and text of the choices has an English translation', () => {
    const en = catalog as Record<string, string>;
    for (const c of [...DATA_CHOICES, ...SUCCESS_CHOICES]) {
      expect(en[c.label], c.label).toBeTruthy();
      expect(en[c.text], c.text).toBeTruthy();
    }
    for (const s of firstSteps(plan({}), {})) expect(en[s.label], s.label).toBeTruthy();
  });

  it('the old goal dialog is gone: new logins get the wizard', () => {
    const main = readFileSync(join(__dirname, '../web/src/main.tsx'), 'utf8');
    expect(main).toContain("import('./onboarding/FirstRun')");
    expect(main).toContain('<FirstRun />');
    expect(readFileSync(join(__dirname, '../web/src/areas/GoalSetup.tsx'), 'utf8')).not.toContain('export function GoalSetup(');
  });
});

describe('Startseite eines Admins', () => {
  it('opens the dashboard while there is one company of their own, the agency once there are more', () => {
    expect(adminHome([{ name: 'Meine Firma' }])).toBe('dashboard');
    // the academy's practice company does not count
    expect(adminHome([{ name: 'Meine Firma' }, { name: 'Übungs-Firma (Akademie)' }])).toBe('dashboard');
    expect(adminHome([{ name: 'Meine Firma' }, { name: 'Kunde A' }])).toBe('agency');
    // no company yet: the agency overview is where one is created
    expect(adminHome([])).toBe('agency');
    expect(adminHome([{ name: 'Übungs-Firma (Akademie)' }])).toBe('agency');
  });

  it('keeps the practice company name in step with the server', () => {
    const server = readFileSync(join(__dirname, '../server/modules/academy.ts'), 'utf8');
    expect(server).toContain("SANDBOX_NAME = 'Übungs-Firma (Akademie)'");
  });
});
