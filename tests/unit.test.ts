import { describe, expect, it } from 'vitest';
import { render } from '../server/core/template.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc } from '../server/core/time.js';
import { parseCsv, toCsv } from '../server/core/csv.js';
import { normalizePhone, slugify } from '../server/core/util.js';
import { computeSlots } from '../server/modules/calendars.js';
import { totals } from '../server/modules/payments.js';
import { miniMarkdown } from '../server/modules/funnels.js';
import { advance, evalCondition, stepAt, triggerMatches, walk, type Step } from '../server/services/workflow-engine.js';

describe('templates', () => {
  it('fills merge fields with fallbacks and escaping', () => {
    const data = { contact: { first_name: 'Anna', custom: { budget: '5000' } }, location: { name: 'ACME' } };
    expect(render('Hallo {{contact.first_name}} von {{ location.name }}', data)).toBe('Hallo Anna von ACME');
    expect(render('Hi {{contact.last_name|du}}', data)).toBe('Hi du');
    expect(render('{{contact.custom.budget}} €', data)).toBe('5000 €');
    expect(render('{{x}}', { x: '<b>' }, { escape: true })).toBe('&lt;b&gt;');
  });
});

describe('time zones', () => {
  it('converts Berlin wall time to UTC across DST', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(zonedToUtc('2026-01-15', '09:00', 'Europe/Berlin').toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(zonedToUtc('2026-03-29', '12:00', 'Europe/Berlin').toISOString()).toBe('2026-03-29T10:00:00.000Z');
    expect(ymdInTz(new Date('2026-07-01T23:30:00Z'), 'Europe/Berlin')).toBe('2026-07-02');
    expect(weekdayKey('2026-10-05')).toBe('mon');
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('booking slots', () => {
  const cal = { duration: 30, interval: 30, buffer: 0, min_notice: 0, max_days: 30, availability: { mon: [['09:00', '11:00']] as [string, string][] }, timezone: 'Europe/Berlin' };
  const at = new Date('2026-10-04T12:00:00Z'); // a Sunday

  it('lists free starts inside the window', () => {
    const slots = computeSlots(cal, '2026-10-05', [], at);
    expect(slots).toEqual(['2026-10-05T07:00:00.000Z', '2026-10-05T07:30:00.000Z', '2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z']);
  });
  it('skips booked times plus buffer, days without hours, and the past', () => {
    const busy = [{ start_at: '2026-10-05T07:30:00.000Z', end_at: '2026-10-05T08:00:00.000Z' }];
    expect(computeSlots({ ...cal, buffer: 15 }, '2026-10-05', busy, at)).toEqual(['2026-10-05T08:30:00.000Z']);
    expect(computeSlots(cal, '2026-10-06', [], at)).toEqual([]);
    expect(computeSlots(cal, '2026-09-28', [], at)).toEqual([]);
    expect(computeSlots({ ...cal, min_notice: 20 }, '2026-10-05', [], at)).toEqual(['2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z']);
  });
});

describe('workflow cursor', () => {
  const steps: Step[] = [
    { id: 'a', type: 'add_tag' },
    { id: 'b', type: 'if', then: [{ id: 'c', type: 'send_email' }, { id: 'd', type: 'wait' }], else: [] },
    { id: 'e', type: 'end' },
  ];
  it('walks into and out of branches', () => {
    expect(stepAt(steps, [1, 'then', 1])?.id).toBe('d');
    expect(advance(steps, [0])).toEqual([1]);
    expect(advance(steps, [1, 'then', 0])).toEqual([1, 'then', 1]);
    expect(advance(steps, [1, 'then', 1])).toEqual([2]);
    expect(advance(steps, [2])).toBeNull();
    expect(walk(steps).map((w) => w.step.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('evaluates conditions', () => {
    const vars = { contact: { tags: ['vip'], email: 'A@B.de', custom: { score: '42' } } };
    expect(evalCondition({ field: 'tag', op: 'has', value: 'vip' }, vars)).toBe(true);
    expect(evalCondition({ field: 'tag', op: 'not_has', value: 'vip' }, vars)).toBe(false);
    expect(evalCondition({ field: 'email', op: 'contains', value: 'b.de' }, vars)).toBe(true);
    expect(evalCondition({ field: 'contact.custom.score', op: 'gt', value: '40' }, vars)).toBe(true);
    expect(evalCondition({ field: 'phone', op: 'empty' }, vars)).toBe(true);
  });
  it('matches trigger filters', () => {
    const e = { locationId: 'l', type: 'contact.tag_added', data: { tag: 'lead' }, at: '' };
    expect(triggerMatches({ type: 'contact.tag_added', config: { tag: 'lead' } }, e)).toBe(true);
    expect(triggerMatches({ type: 'contact.tag_added', config: { tag: 'kunde' } }, e)).toBe(false);
    expect(triggerMatches({ type: 'form.submitted' }, e)).toBe(false);
  });
});

describe('helpers', () => {
  it('parses CSV with quotes and semicolons', () => {
    expect(parseCsv('Vorname;E-Mail\n"Müller; Hans";h@x.de\n')).toEqual([['Vorname', 'E-Mail'], ['Müller; Hans', 'h@x.de']]);
    expect(parseCsv(toCsv([['a', 'b,c'], ['"q"', '']]))).toEqual([['a', 'b,c'], ['"q"', '']]);
  });
  it('normalizes phones and slugs', () => {
    expect(normalizePhone('0176 123 456')).toBe('+49176123456');
    expect(normalizePhone('0049 176 1')).toBe('+491761');
    expect(slugify('Größe & Maß!')).toBe('grosse-mass');
  });
  it('sums invoice lines with tax', () => {
    expect(totals([{ name: 'a', qty: 2, price_cents: 1000, tax_rate: 19 }, { name: 'b', qty: 1, price_cents: 500, tax_rate: 7 }])).toEqual({ subtotal_cents: 2500, tax_cents: 415, total_cents: 2915 });
  });
  it('renders mini markdown safely', () => {
    expect(miniMarkdown('**fett** <script>')).toBe('<p><strong>fett</strong> &lt;script&gt;</p>');
    expect(miniMarkdown('[x](javascript:alert(1))')).toContain('href="#"');
  });
});

describe('contract text', async () => {
  const { contractHtml } = await import('../server/modules/contracts.js');
  it('renders headings, lists and bold without blank lines and escapes HTML', () => {
    const h = contractHtml('# Vertrag\nZwischen **A** und B.\n## 1. Leistungen\n- Website\n- Hosting\nDanach <script>x</script>');
    expect(h).toBe('<h2>Vertrag</h2>\n<p>Zwischen <strong>A</strong> und B.</p>\n<h3>1. Leistungen</h3>\n<ul><li>Website</li><li>Hosting</li></ul>\n<p>Danach &lt;script&gt;x&lt;/script&gt;</p>');
  });
});
