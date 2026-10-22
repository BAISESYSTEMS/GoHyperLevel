import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtSession, getIn, parseDuration, parseMoment, percent, setIn, videoLabel, euros } from '../web/src/pages/webinar-format';
import { WEBINAR_TOURS } from '../web/src/tour/content/webinars';
import { MODULE_IDS } from '../server/services/appearance-model';
import { DEPT_OF_ROUTE } from '../web/src/theme/depts';
import { SOLID } from '../web/src/theme/packs/solid';

/** The pure helpers behind the Webinare pages (fields that take minutes or mm:ss, deep edits, labels) and that the page is wired into the registries. */

describe('durations in the editor', () => {
  it('reads minutes, mm:ss and h:mm:ss, and refuses the rest', () => {
    expect(parseDuration('45')).toBe(2700);
    expect(parseDuration('45 min')).toBe(2700);
    expect(parseDuration('45,5')).toBe(2730);
    expect(parseDuration('45:30')).toBe(2730);
    expect(parseDuration('1:05:00')).toBe(3900);
    expect(parseDuration('0:30')).toBe(30);
    for (const bad of ['', 'abc', '45:99', '1:2:3:4', '-5', '45 Stunden']) expect(parseDuration(bad), bad).toBeNull();
  });

  it('shows seconds as mm:ss or h:mm:ss', () => {
    expect(fmtDuration(2730)).toBe('45:30');
    expect(fmtDuration(30)).toBe('0:30');
    expect(fmtDuration(3905)).toBe('1:05:05');
    expect(fmtDuration(-4)).toBe('0:00');
    expect(fmtDuration(Number.NaN)).toBe('0:00');
  });

  it('a moment in the video: empty is the start, otherwise like a duration', () => {
    expect(parseMoment('')).toBe(0);
    expect(parseMoment('  ')).toBe(0);
    expect(parseMoment('30')).toBe(1800);
    expect(parseMoment('12:30')).toBe(750);
    expect(parseMoment('x')).toBeNull();
    // the round trip a field makes
    for (const s of [0, 59, 60, 750, 3599, 3600, 5405]) expect(parseMoment(fmtDuration(s))).toBe(s);
  });
});

describe('editing the form by path', () => {
  it('sets deep values without touching the original, creates missing levels and edits lists by index', () => {
    const a = { settings: { room: { label: 'A', polls: [{ q: 1 }, { q: 2 }] } } };
    const b = setIn(a, 'settings.room.label', 'B');
    expect(a.settings.room.label).toBe('A');
    expect(b.settings.room.label).toBe('B');
    expect(b.settings.room.polls).toBe(a.settings.room.polls);
    const c = setIn(a, 'settings.room.polls.1.q', 9) as typeof a;
    expect(c.settings.room.polls).toEqual([{ q: 1 }, { q: 9 }]);
    expect(Array.isArray(c.settings.room.polls)).toBe(true);
    expect(a.settings.room.polls[1].q).toBe(2);
    expect(setIn({}, 'x.y.z', 1)).toEqual({ x: { y: { z: 1 } } });
    expect(getIn(b, 'settings.room.polls.0.q')).toBe(1);
    expect(getIn(b, 'settings.nope.deeper')).toBeUndefined();
  });
});

describe('labels and numbers', () => {
  it('formats shares, money and sessions in German', () => {
    expect(percent(0.255)).toBe('25,5 %');
    expect(percent(null)).toBe('–');
    expect(percent(1)).toBe('100 %');
    expect(euros(49000).replace(/\s/g, ' ')).toBe('490,00 €');
    const s = fmtSession('2026-11-09T18:00:00.000Z', 'Europe/Berlin');
    expect(s).toContain('19:00');
    expect(s).toContain('9');
    expect(fmtSession('2026-11-09T18:00:00.000Z', 'America/New_York')).toContain('13:00');
    expect(fmtSession('kaputt', 'Europe/Berlin')).toBe('kaputt');
    expect(fmtSession('2026-11-09T18:00:00.000Z', 'Mars/Olympus')).toBeTruthy();
  });

  it('names each video source', () => {
    expect(videoLabel({ type: 'none' })).toBe('Noch kein Video');
    expect(videoLabel(undefined)).toBe('Noch kein Video');
    expect(videoLabel({ type: 'upload', name: 'a.mp4' })).toBe('Hochgeladene Datei: a.mp4');
    expect(videoLabel({ type: 'youtube', id: 'abc' })).toBe('YouTube: abc');
    expect(videoLabel({ type: 'studio_clip', title: 'Clip' })).toBe('Video-Studio-Clip: Clip');
  });
});

describe('the page is part of the app', () => {
  const main = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../web/src/pages/WebinarEditor.tsx', import.meta.url), 'utf8');

  it('has a lazy page, a menu entry under Marketing with the Funnels area, and every theme registry entry', () => {
    expect(main).toContain("lazyPages(() => import('./pages/Webinars'), 'Webinars')");
    expect(main).toMatch(/\['group', 'Marketing'\][\s\S]*\['webinars', 'webinar', 'Webinare', 'funnels'\][\s\S]*\['group', 'Seiten'\]/);
    expect(main).toContain("case 'webinars':");
    expect(MODULE_IDS).toContain('webinars');
    expect(DEPT_OF_ROUTE.webinars).toBe('marketing');
    expect(SOLID.webinar).toBeTruthy();
    expect(SOLID.webinar).toContain('fill-rule="evenodd"');
  });

  it('has the six tabs the brief asks for, in order, with German names', () => {
    const tabs = [...editor.matchAll(/\[\s*'(basics|schedule|registration|room|reminders|stats)',\s*'([^']+)'\s*\]/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(tabs).toEqual(['basics=Grunddaten', 'schedule=Termine', 'registration=Anmeldung', 'room=Raum & Angebot', 'reminders=Erinnerungen', 'stats=Auswertung']);
  });

  it('has an academy tour for the area with a docs page', () => {
    expect(WEBINAR_TOURS).toHaveLength(1);
    const t = WEBINAR_TOURS[0];
    expect(t).toMatchObject({ id: 'webinars', perm: 'funnels', group: 'marketing', docs: { file: 'webinars' } });
    expect(t.routes).toContain('webinars');
    expect(readFileSync(new URL('../docs/webinars.md', import.meta.url), 'utf8')).toContain('# Webinare');
  });

  it('every modal of the pages is the shared Modal (top-right ✕, Esc, focus back)', () => {
    for (const f of ['Webinars', 'WebinarEditor', 'WebinarTabs', 'WebinarRoomTab', 'WebinarStats']) {
      const src = readFileSync(new URL(`../web/src/pages/${f}.tsx`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/className=["']modal/);
      expect(src, f).not.toMatch(/role=["']dialog/);
    }
    expect(readFileSync(new URL('../web/src/pages/Webinars.tsx', import.meta.url), 'utf8')).toContain('<Modal');
  });
});
