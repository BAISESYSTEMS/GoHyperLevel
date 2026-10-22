import { describe, expect, it } from 'vitest';
import {
  CALENDAR_TABS_ESSENTIAL,
  COMPANY_COLUMNS,
  CONTACT_COLUMNS,
  CONTACT_ESSENTIAL,
  CONTACT_MAIN_FIELDS,
  DEAL_COLUMNS,
  dashboardLayout,
  isAutoSlug,
  defaultColumns,
  recordColumns,
  simpleTabs,
  splitFields,
} from '../web/src/areas/easy-core';
import { visibleColumns } from '../web/src/areas/fields-model';

const all = () => true;

describe('Einfach-Modus: dashboard', () => {
  it('Profi keeps every tile and card of the visible areas, nothing folded', () => {
    const l = dashboardLayout(false, all);
    expect(l.stats).toEqual(['contacts', 'pipeline', 'won', 'booked', 'forms', 'messages', 'revenue', 'reviews']);
    expect(l.cards).toEqual(['leads', 'next', 'pipelines', 'sources']);
    expect(l.moreStats).toEqual([]);
    expect(l.moreCards).toEqual([]);
    expect(l.widgetsInMore).toBe(false);
  });

  it('Einfach-Modus shows only what calls for action today; the rest – without repeats – behind "Mehr anzeigen"', () => {
    const l = dashboardLayout(true, all);
    expect(l.stats).toEqual(['tasks', 'unread', 'upcoming', 'pipeline']);
    expect(l.cards).toEqual(['next']);
    expect(l.moreStats).toEqual(['contacts', 'won', 'booked', 'forms', 'messages', 'revenue', 'reviews']);
    expect(l.moreStats).not.toContain('pipeline');
    expect(l.moreCards).toEqual(['leads', 'pipelines', 'sources']);
    expect(l.widgetsInMore).toBe(true);
    expect(l.stats.length).toBeLessThanOrEqual(5);
  });

  it('a hidden area takes its tiles and cards with it in both modes', () => {
    const noDeals = (a: string) => a !== 'opportunities' && a !== 'tasks';
    const simple = dashboardLayout(true, noDeals);
    expect(simple.stats).toEqual(['unread', 'upcoming']);
    expect(simple.moreStats).not.toContain('won');
    expect(simple.moreCards).not.toContain('pipelines');
    expect(dashboardLayout(false, noDeals).stats).not.toContain('pipeline');
    // "next" (appointments + open tasks) stays in Profi while either is visible; in Einfach-Modus the tasks tile covers the tasks
    expect(dashboardLayout(false, (a) => a === 'tasks').cards).toEqual(['next']);
    expect(dashboardLayout(true, (a) => a === 'tasks')).toMatchObject({ stats: ['tasks'], cards: [], moreCards: [] });
    expect(dashboardLayout(true, (a) => a === 'calendars').cards).toEqual(['next']);
    expect(dashboardLayout(true, (a) => a === 'contacts').cards).toEqual([]);
  });
});

describe('Einfach-Modus: tables', () => {
  it('contacts show four essential columns, the rest is one click away', () => {
    expect(CONTACT_ESSENTIAL.every((k) => (CONTACT_COLUMNS as readonly string[]).includes(k))).toBe(true);
    expect(visibleColumns(CONTACT_COLUMNS, { simple: true, essential: CONTACT_ESSENTIAL })).toEqual(['name', 'email', 'phone', 'tags']);
    expect(visibleColumns(CONTACT_COLUMNS, { simple: true, essential: CONTACT_ESSENTIAL, extra: ['created'] })).toEqual(['name', 'email', 'phone', 'tags', 'created']);
    expect(visibleColumns(CONTACT_COLUMNS, { simple: false, essential: CONTACT_ESSENTIAL })).toHaveLength(CONTACT_COLUMNS.length);
  });

  it('lists with their own column chooser start leaner in Einfach-Modus, unchanged in Profi', () => {
    for (const set of [COMPANY_COLUMNS, DEAL_COLUMNS]) {
      expect(set.simple.every((k) => set.pro.includes(k))).toBe(true);
      expect(set.simple.length).toBeLessThanOrEqual(5);
      expect(defaultColumns(set, false)).toEqual(set.pro);
      expect(defaultColumns(set, true)).toEqual(set.simple);
      expect(defaultColumns(set, true)).not.toBe(set.simple); // a copy – the caller may change it
    }
    expect(COMPANY_COLUMNS.pro[0]).toBe('name');
  });

  it('custom object records: primary + 3 in Einfach-Modus, primary + 5 + "Geändert" in Profi', () => {
    const others = ['title', 'a', 'b', 'c', 'd', 'e', 'f'];
    expect(recordColumns('title', others, true)).toEqual(['title', 'a', 'b', 'c']);
    expect(recordColumns('title', others, false)).toEqual(['title', 'a', 'b', 'c', 'd', 'e', 'updated_at']);
    expect(recordColumns('title', [], true)).toEqual(['title']);
  });
});

describe('Einfach-Modus: forms', () => {
  const f = (key: string, required = false) => ({ key, required });

  it('keeps required and primary fields, then fills up to the first-glance limit in form order', () => {
    const fields = [f('a'), f('b'), f('c', true), f('d'), f('e'), f('primary'), f('g'), f('h')];
    const { main, more } = splitFields(fields, { primary: 'primary', max: 4 });
    expect(main.map((x) => x.key)).toEqual(['a', 'b', 'c', 'primary']);
    expect(more.map((x) => x.key)).toEqual(['d', 'e', 'g', 'h']);
  });

  it('never folds a required field, even beyond the limit', () => {
    const fields = [f('a', true), f('b', true), f('c', true), f('d')];
    const { main, more } = splitFields(fields, { max: 2 });
    expect(main.map((x) => x.key)).toEqual(['a', 'b', 'c']);
    expect(more.map((x) => x.key)).toEqual(['d']);
  });

  it('a short form stays whole', () => {
    const fields = [f('a'), f('b'), f('c')];
    expect(splitFields(fields).more).toEqual([]);
    expect(splitFields([]).main).toEqual([]);
  });

  it('the contact form keeps name, e-mail, phone and company at first glance', () => {
    expect(CONTACT_MAIN_FIELDS).toEqual(['first_name', 'last_name', 'email', 'phone', 'company']);
  });
});

describe('Einfach-Modus: calendar URL path', () => {
  it('a path made from the name (with umlauts, ß and a "-2" suffix) does not count as typed in', () => {
    expect(isAutoSlug('erstgesprach', 'Erstgespräch')).toBe(true);
    expect(isAutoSlug('strasse-30-min-2', 'Straße 30 Min.')).toBe(true);
    expect(isAutoSlug('', 'Egal')).toBe(true);
    expect(isAutoSlug(undefined, 'Egal')).toBe(true);
  });
  it('a path someone chose does', () => {
    expect(isAutoSlug('termin', 'Erstgespräch')).toBe(false);
    expect(isAutoSlug('erstgesprach-vip', 'Erstgespräch')).toBe(false);
  });
});

describe('Einfach-Modus: settings tabs', () => {
  const tabs: [string, string][] = [
    ['basic', 'Allgemein'],
    ['hours', 'Verfügbarkeit'],
    ['notify', 'Bestätigung'],
    ['after', 'Nachfassen'],
    ['crm', 'CRM'],
    ['team', 'Team'],
    ['payment', 'Zahlung'],
    ['sync', 'Sync'],
  ];

  it('Profi and an unfolded list show every tab', () => {
    expect(simpleTabs(tabs, { simple: false, essential: ['basic'] }).tabs).toEqual(tabs);
    expect(simpleTabs(tabs, { simple: true, essential: ['basic'], expanded: true })).toEqual({ tabs, hidden: 0 });
  });

  it('Einfach-Modus keeps the essential tabs, the open one and those holding settings – in their order', () => {
    const r = simpleTabs(tabs, { simple: true, essential: CALENDAR_TABS_ESSENTIAL, current: 'payment', filled: ['crm'] });
    expect(r.tabs.map(([k]) => k)).toEqual(['basic', 'hours', 'notify', 'crm', 'team', 'payment', 'sync']);
    expect(r.hidden).toBe(1);
    const plain = simpleTabs(tabs, { simple: true, essential: CALENDAR_TABS_ESSENTIAL });
    expect(plain.tabs.map(([k]) => k)).toEqual(['basic', 'hours', 'notify', 'team', 'sync']);
    expect(plain.hidden).toBe(3);
  });
});
