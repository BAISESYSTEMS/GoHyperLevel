import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROUPS, MODULE_TOURS, tourById } from '../web/src/tour/catalog';
import { COMPANY_TOURS } from '../web/src/tour/content/company';
import { companyCourseMarkdown, lessonHeading } from '../web/src/tour/company-course';

/** The Academy course „Deine Firma mit … führen“ (web/src/tour/content/company.ts) – the generic tour checks live in academy.test.ts. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('course „Deine Firma führen“', () => {
  it('has 10 chained lessons in its own Academy group, each with a 10-minute task in the app', () => {
    expect(GROUPS.map((g) => g.id)).toContain('company');
    expect(COMPANY_TOURS).toHaveLength(10);
    expect(COMPANY_TOURS.map((t) => t.chapter)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    COMPANY_TOURS.forEach((t, i) => {
      expect(MODULE_TOURS).toContain(t);
      expect(t.group).toBe('company');
      expect(t.next).toBe(COMPANY_TOURS[i + 1]?.id);
      const last = t.steps.at(-1)!;
      expect(last.title, t.id).toBe('Deine 10-Minuten-Aufgabe');
      expect(last.do, t.id).toBeTruthy();
      expect(last.route, t.id).toBeTruthy();
      expect(t.docs?.file).toBe('company-playbook');
    });
    expect(COMPANY_TOURS.map((t) => t.title.split(':')[0])).toEqual(['Firmen-Setup', 'Vertrieb', 'Marketing', 'Kundenservice', 'Finanzen', 'Projekte & Zeit', 'KI-Mitarbeiter & Automatisierung', 'Kennzahlen & Wochen-Routine', 'Datenschutz & Compliance', 'Skalieren']);
    expect(tourById('firma-9-compliance')!.steps.some((s) => /Steuerberat/.test(s.text) && /Anwalt|Anwältin/.test(s.text))).toBe(true);
  });

  it('docs/kurs-firma-fuehren.md is the generated course (run the generator after changing a lesson)', () => {
    const md = readFileSync(join(ROOT, 'docs/kurs-firma-fuehren.md'), 'utf8');
    expect(md).toBe(companyCourseMarkdown('HyperLevel'));
    for (const t of COMPANY_TOURS) expect(md).toContain(`## ${lessonHeading(t.chapter!, t.title)}`);
  });
});
