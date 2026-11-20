import { describe, expect, it } from 'vitest';
import { normText, scoreMatch } from '../web/src/nav-match.js';
import { promotedFrom, splitNav } from '../server/services/areas-model.js';

/**
 * Getting around (1.0.73): Ctrl/⌘+K ranks its commands by how well they match (web/src/nav-match.ts), and the Einfach-Modus menu
 * stays put – areas used often are only suggested under "Mehr", never added to the menu by themselves (web/src/areas/adaptive.ts).
 */

describe('Ctrl+K matching', () => {
  it('ranks the whole label, its start, a word start, the middle and keywords in that order', () => {
    expect(scoreMatch('kontakte', 'Kontakte')).toBe(100);
    expect(scoreMatch('kon', 'Kontakte')).toBe(80);
    expect(scoreMatch('anbieter', 'Einstellungen › KI-Anbieter (BYOK)')).toBe(60);
    expect(scoreMatch('takt', 'Kontakte')).toBe(40);
    expect(scoreMatch('smtp', 'Einstellungen › E-Mail & SMS', 'SMTP Absender Postfach')).toBe(20);
    expect(scoreMatch('xyz', 'Kontakte', 'contacts')).toBe(0);
    expect(scoreMatch('', 'Kontakte')).toBe(1);
  });

  it('ignores case and accents, and needs every typed word', () => {
    expect(normText('Kanäle')).toBe('kanale');
    expect(scoreMatch('kanale', 'Kanäle')).toBe(100);
    expect(scoreMatch('KANÄLE', 'Kanäle')).toBe(100);
    expect(scoreMatch('mail zustellung', 'Einstellungen › E-Mail-Zustellung')).toBe(20);
    expect(scoreMatch('mail rechnung', 'Einstellungen › E-Mail-Zustellung')).toBe(0);
  });

  it('puts a page above a project whose name only contains the word', () => {
    const page = scoreMatch('rech', 'Rechnungen');
    const project = scoreMatch('rech', 'Kunde Brechmann');
    expect(page).toBeGreaterThan(project);
  });
});

describe('Einfach-Modus menu stays put', () => {
  const base = { order: ['dashboard', 'conversations', 'contacts', 'calendars', 'tasks', 'academy', 'opportunities', 'funnels', 'reports', 'invoices'], goals: ['leads'], pinned: [] as string[], unpinned: [] as string[] };

  it('lists often used areas as suggestions – the split without promotion keeps them under "Mehr"', () => {
    const usage = { reports: 5, invoices: 1 };
    expect(promotedFrom(usage, base)).toEqual(['reports']);
    // what the sidebar uses since 1.0.73: no promotion into the menu
    expect(splitNav({ ...base, promoted: [] }).more).toContain('reports');
    // pinning is the only way in
    expect(splitNav({ ...base, pinned: ['reports'], promoted: [] }).core).toContain('reports');
  });
});
