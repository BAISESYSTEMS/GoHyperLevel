import { describe, expect, it } from 'vitest';
import { anyFilled, moreFieldsOpen, visibleColumns } from '../web/src/areas/fields-model';

describe('Einfach-Modus: forms', () => {
  it('opens secondary fields in Profi, when they hold a value, or when the person opened them before', () => {
    expect(moreFieldsOpen({ simple: false })).toBe(true);
    expect(moreFieldsOpen({ simple: true })).toBe(false);
    expect(moreFieldsOpen({ simple: true, stored: true })).toBe(true);
    expect(moreFieldsOpen({ simple: true, stored: false, hasValue: true })).toBe(true);
    expect(moreFieldsOpen({ simple: true, stored: false })).toBe(false);
  });

  it('treats empty strings, null, [], {} and false as empty – a filled field is never hidden', () => {
    expect(anyFilled(['', null, undefined, [], {}, false])).toBe(false);
    expect(anyFilled(['', 'Müller'])).toBe(true);
    expect(anyFilled([0])).toBe(true);
    expect(anyFilled([['vip']])).toBe(true);
    expect(anyFilled([{ a: 1 }])).toBe(true);
  });
});

describe('Einfach-Modus: table columns', () => {
  const all = ['name', 'email', 'phone', 'tags', 'source', 'created'];
  it('shows every column in Profi', () => {
    expect(visibleColumns(all, { simple: false, essential: ['name'] })).toEqual(all);
  });
  it('shows the essential columns plus the switched-on ones, in table order', () => {
    expect(visibleColumns(all, { simple: true, essential: ['email', 'name'], extra: ['created'] })).toEqual(['name', 'email', 'created']);
  });
  it('never ends up with an empty table', () => {
    expect(visibleColumns(all, { simple: true, essential: ['nope'] })).toEqual(['name', 'email']);
  });
});
