import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, LATE_ANYTIME, ScheduleError, cleanSchedule, isBlackout, offersSession, percentOf, roomClock, upcomingSessions, type Schedule } from '../server/services/webinar-schedule';
import { LIVE_CLAIM, cleanWebinar, honestText, joinToken, previewToken, publishProblems, readJoinToken, readPreviewToken, uniqueSlug } from '../server/services/webinar-model';
import { cleanVideo, embedOf, looksLikeVideo, parseRange, playbackOf } from '../server/services/webinar-video';
import { icsOf } from '../server/services/webinar-register';

/**
 * Pure parts of the webinar feature: when sessions start (zones, daylight saving, blackout days, "just in time"), what the room does at a
 * given second, the honest wording rules, the video sources and the signed links. No server, no database.
 */

const at = (iso: string) => new Date(iso);
const sched = (patch: Record<string, unknown>): Schedule => cleanSchedule(patch, DEFAULT_SCHEDULE);
const starts = (s: Schedule, now: string, tz = 'Europe/Berlin') => upcomingSessions(s, tz, at(now)).map((x) => `${x.kind}:${x.start}`);

describe('cleaning a schedule', () => {
  it('keeps what is valid, sorts times and removes doubles', () => {
    const s = sched({ fixed: { enabled: true, weekdays: ['fri', 'mon', 'mon'], times: ['19:00', '9:30', '19:00'] }, dates: ['2026-11-05 18:00', '2026-11-01T09:00'], blackout: ['2026-12-24', '2026-12-27..2027-01-02'], max_per_session: 50, late_join_min: 15 });
    expect(s.fixed.weekdays).toEqual(['mon', 'fri']);
    expect(s.fixed.times).toEqual(['09:30', '19:00']);
    expect(s.dates).toEqual(['2026-11-01T09:00', '2026-11-05T18:00']);
    expect(s.blackout).toEqual(['2026-12-24', '2026-12-27..2027-01-02']);
    expect(s.max_per_session).toBe(50);
    expect(s.late_join_min).toBe(15);
  });

  it('refuses nonsense with a German message', () => {
    expect(() => sched({ fixed: { enabled: true, times: ['25:00'] } })).toThrow(/HH:MM/);
    expect(() => sched({ fixed: { enabled: true, weekdays: [], times: ['10:00'] } })).toThrow(/Wochentag/);
    expect(() => sched({ fixed: { weekdays: ['montag'] } })).toThrow(/Wochentage/);
    expect(() => sched({ dates: ['morgen'] })).toThrow(/Einzeltermin/);
    expect(() => sched({ dates: ['2026-02-30T10:00'] })).toThrow(/Einzeltermin/);
    expect(() => sched({ blackout: ['2026-12-31..2026-12-01'] })).toThrow(/Sperrtag/);
    expect(() => sched({ tz: 'Mars/Olympus' })).toThrow(/Zeitzone/);
    expect(() => sched({ jit: { enabled: true, every_min: 2 } })).toThrow(/Abstand/);
    expect(() => sched({ jit: { enabled: true, from: '21:00', to: '09:00' } })).toThrow(/Zeitfenster/);
    expect(() => sched({ horizon_days: 400 })).toThrow(/Vorschau/);
    expect(() => sched({ late_join_min: -1 })).toThrow(ScheduleError);
  });

  it('finds blackout days and ranges', () => {
    const s = sched({ blackout: ['2026-12-24', '2026-12-27..2027-01-02'] });
    expect(isBlackout(s, '2026-12-24')).toBe(true);
    expect(isBlackout(s, '2026-12-25')).toBe(false);
    expect(isBlackout(s, '2026-12-31')).toBe(true);
    expect(isBlackout(s, '2027-01-03')).toBe(false);
  });
});

describe('fixed times and dates', () => {
  it('offers chosen weekdays at the given times in the webinar zone, soonest first', () => {
    const s = sched({ fixed: { enabled: true, weekdays: ['mon', 'wed'], times: ['10:00', '19:00'] }, horizon_days: 7 });
    // Friday 6 Nov 2026 12:00 UTC → Monday 9 Nov, Wednesday 11 Nov (CET = UTC+1)
    expect(starts(s, '2026-11-06T12:00:00Z')).toEqual(['fixed:2026-11-09T09:00:00.000Z', 'fixed:2026-11-09T18:00:00.000Z', 'fixed:2026-11-11T09:00:00.000Z', 'fixed:2026-11-11T18:00:00.000Z']);
  });

  it('keeps the wall clock across daylight saving (Berlin switches on 29 March 2026)', () => {
    const s = sched({ fixed: { enabled: true, weekdays: ['sat', 'mon'], times: ['19:00'] }, horizon_days: 4 });
    expect(starts(s, '2026-03-27T12:00:00Z')).toEqual(['fixed:2026-03-28T18:00:00.000Z', 'fixed:2026-03-30T17:00:00.000Z']);
  });

  it('uses the zone of the schedule, not the sub-account', () => {
    const s = sched({ tz: 'America/New_York', fixed: { enabled: true, weekdays: ['mon'], times: ['09:00'] }, horizon_days: 7 });
    expect(starts(s, '2026-11-06T12:00:00Z', 'Europe/Berlin')).toEqual(['fixed:2026-11-09T14:00:00.000Z']);
  });

  it('skips blackout days and past starts, and offers a date once even when it is also a fixed time', () => {
    const s = sched({ fixed: { enabled: true, weekdays: ['mon'], times: ['19:00'] }, dates: ['2026-11-09T19:00', '2026-11-02T10:00', '2026-11-10T08:00'], blackout: ['2026-11-16'], horizon_days: 21 });
    // 9 Nov is both a fixed and a date session (one entry), 16 Nov is blocked, 2 Nov is in the past
    expect(starts(s, '2026-11-06T12:00:00Z')).toEqual(['fixed:2026-11-09T18:00:00.000Z', 'date:2026-11-10T07:00:00.000Z', 'fixed:2026-11-23T18:00:00.000Z']);
  });

  it('a blackout day also removes single dates', () => {
    const s = sched({ dates: ['2026-12-24T10:00', '2026-12-28T10:00'], blackout: ['2026-12-24'] });
    expect(starts(s, '2026-12-01T00:00:00Z')).toEqual(['date:2026-12-28T09:00:00.000Z']);
  });
});

describe('"just in time" and on demand', () => {
  const jit = sched({ jit: { enabled: true, every_min: 15, from: '09:00', to: '21:00' } });

  it('offers the next three starts on the quarter-hour grid of the local clock', () => {
    // 12:07 Berlin (11:07Z)
    expect(starts(jit, '2026-11-06T11:07:30Z')).toEqual(['jit:2026-11-06T11:15:00.000Z', 'jit:2026-11-06T11:30:00.000Z', 'jit:2026-11-06T11:45:00.000Z']);
  });

  it('stays inside the daily window and rolls over to the next day', () => {
    // 20:50 Berlin: 21:00 is outside ("to" is exclusive) → next day from 09:00
    expect(starts(jit, '2026-11-06T19:50:00Z')).toEqual(['jit:2026-11-07T08:00:00.000Z', 'jit:2026-11-07T08:15:00.000Z', 'jit:2026-11-07T08:30:00.000Z']);
  });

  it('respects weekdays and blackout days', () => {
    const weekdays = sched({ jit: { enabled: true, every_min: 30, from: '10:00', to: '12:00', weekdays: ['mon'] }, blackout: ['2026-11-09'] });
    // Friday evening → the next Monday is blocked → the Monday after
    expect(starts(weekdays, '2026-11-06T19:00:00Z')[0]).toBe('jit:2026-11-16T09:00:00.000Z');
  });

  it('grids by the local clock in zones with a half-hour offset', () => {
    const india = sched({ tz: 'Asia/Kolkata', jit: { enabled: true, every_min: 60, from: '00:00', to: '24:00' } });
    // 10:10 IST (04:40Z) → 11:00 IST = 05:30Z
    expect(starts(india, '2026-11-06T04:40:00Z')[0]).toBe('jit:2026-11-06T05:30:00.000Z');
  });

  it('lists "Sofort starten" first, with the start of now', () => {
    const s = sched({ ondemand: { enabled: true }, fixed: { enabled: true, weekdays: ['mon'], times: ['10:00'] }, horizon_days: 7 });
    const list = upcomingSessions(s, 'Europe/Berlin', at('2026-11-06T12:00:00Z'));
    expect(list[0]).toEqual({ start: '2026-11-06T12:00:00.000Z', kind: 'ondemand' });
    expect(list[1].kind).toBe('fixed');
  });
});

describe('is a session offered?', () => {
  const s = sched({ fixed: { enabled: true, weekdays: ['mon'], times: ['19:00'] }, late_join_min: 30, horizon_days: 14 });
  const monday = '2026-11-09T18:00:00.000Z';

  it('accepts offered starts and nothing else', () => {
    expect(offersSession(s, 'Europe/Berlin', monday, at('2026-11-06T12:00:00Z'))).toBe('fixed');
    expect(offersSession(s, 'Europe/Berlin', '2026-11-09T18:05:00.000Z', at('2026-11-06T12:00:00Z'))).toBeUndefined();
    expect(offersSession(s, 'Europe/Berlin', '2026-11-10T18:00:00.000Z', at('2026-11-06T12:00:00Z'))).toBeUndefined();
    expect(offersSession(s, 'Europe/Berlin', 'nonsense', at('2026-11-06T12:00:00Z'))).toBeUndefined();
    // not in normal form (another spelling of the same instant is not accepted as a key)
    expect(offersSession(s, 'Europe/Berlin', '2026-11-09T19:00:00+01:00', at('2026-11-06T12:00:00Z'))).toBeUndefined();
  });

  it('still takes a booking shortly after the start, but not after the late-join window', () => {
    expect(offersSession(s, 'Europe/Berlin', monday, at('2026-11-09T18:10:00Z'))).toBe('fixed');
    expect(offersSession(s, 'Europe/Berlin', monday, at('2026-11-09T18:31:00Z'))).toBeUndefined();
  });

  it('knows the "just in time" slots', () => {
    const j = sched({ jit: { enabled: true, every_min: 15, from: '09:00', to: '21:00' } });
    expect(offersSession(j, 'Europe/Berlin', '2026-11-06T11:15:00.000Z', at('2026-11-06T11:07:00Z'))).toBe('jit');
    expect(offersSession(j, 'Europe/Berlin', '2026-11-06T11:16:00.000Z', at('2026-11-06T11:07:00Z'))).toBeUndefined();
  });
});

describe('the room clock', () => {
  const start = Date.parse('2026-11-09T18:00:00Z');
  const dur = 3600;
  it('waits, runs, and ends', () => {
    expect(roomClock(start, dur, start - 90_000, 30)).toMatchObject({ state: 'waiting', starts_in_s: 90, offset_s: 0 });
    expect(roomClock(start, dur, start, 30)).toMatchObject({ state: 'running', offset_s: 0, ends_in_s: 3600 });
    expect(roomClock(start, dur, start + 600_000, 30)).toMatchObject({ state: 'running', offset_s: 600, ends_in_s: 3000 });
    expect(roomClock(start, dur, start + dur * 1000, 30).state).toBe('ended');
    expect(roomClock(start, dur, start + dur * 1000 + 1, 30).state).toBe('ended');
  });

  it('turns late arrivals away after the window (with a grace for those in the waiting room) unless entry is open until the end', () => {
    expect(roomClock(start, dur, start + 29 * 60_000, 30).state).toBe('running');
    expect(roomClock(start, dur, start + 30 * 60_000 + 20_000, 30).state).toBe('running');
    expect(roomClock(start, dur, start + 31 * 60_000, 30).state).toBe('late');
    expect(roomClock(start, dur, start + 5_000, 0).state).toBe('running');
    expect(roomClock(start, dur, start + 60_000, 0).state).toBe('late');
    expect(roomClock(start, dur, start + 59 * 60_000, LATE_ANYTIME).state).toBe('running');
  });

  it('turns watched seconds into a share of the video', () => {
    expect(percentOf(1800, 3600)).toBe(50);
    expect(percentOf(9999, 3600)).toBe(100);
    expect(percentOf(10, 0)).toBe(0);
    expect(percentOf(-5, 3600)).toBe(0);
  });
});

describe('honest wording', () => {
  it('never lets an automated webinar call itself live', () => {
    for (const bad of ['Live-Webinar', 'live', 'Jetzt LIVE dabei', 'Livestream', 'Live Q&A', 'in Echtzeit', 'Real-Time Training', 'Direktübertragung', 'Direktuebertragung', 'Life-Stream', 'Das Webinar live erleben']) {
      expect(LIVE_CLAIM.test(bad), bad).toBe(true);
      expect(() => honestText(bad, 'Bezeichnung', 60, 'Automatisiertes Webinar'), bad).toThrow(/nicht als „live“/);
    }
    for (const fine of ['Automatisiertes Webinar', 'Webinar-Aufzeichnung', 'Deliver value', 'Alive and well', 'Olive Oil Masterclass', 'Lives matter', 'Liverpool Strategie', 'Aufgezeichnetes Training']) {
      expect(LIVE_CLAIM.test(fine), fine).toBe(false);
    }
    expect(honestText('', 'Bezeichnung', 60, 'Automatisiertes Webinar')).toBe('Automatisiertes Webinar');
  });

  it('applies to the label, the replay label and the texts the room shows', () => {
    const w = cleanWebinar({ title: 'Test' });
    expect(w.settings.room.label).toBe('Automatisiertes Webinar');
    expect(w.settings.room.replay_label).toBe('Aufzeichnung');
    expect(w.settings.room.show_counter).toBe(false);
    expect(w.settings.room.scripted_enabled).toBe(false);
    for (const settings of [{ room: { label: 'Live-Webinar' } }, { room: { replay_label: 'Live-Mitschnitt' } }, { room: { waiting_text: 'Gleich live!' } }, { room: { ended_text: 'Das Live-Event ist vorbei' } }, { registration: { headline: 'Live dabei sein' } }]) {
      expect(() => cleanWebinar({ title: 'Test', settings }), JSON.stringify(settings)).toThrow(/„live“/);
    }
    expect(cleanWebinar({ title: 'Test', settings: { room: { label: 'Webinar-Training' } } }).settings.room.label).toBe('Webinar-Training');
  });
});

describe('cleaning a webinar', () => {
  it('needs a title and validates the parts', () => {
    expect(() => cleanWebinar({})).toThrow(/Titel/);
    expect(() => cleanWebinar({ title: '  ' })).toThrow(/Titel/);
    expect(() => cleanWebinar({ title: 'A', status: 'archived' })).toThrow(/Status/);
    expect(() => cleanWebinar({ title: 'A', presenter_photo: 'http://example.com/a.jpg' })).toThrow(/https/);
    expect(() => cleanWebinar({ title: 'A', video: { type: 'url', url: 'javascript:alert(1)' } })).toThrow(/https/);
    expect(() => cleanWebinar({ title: 'A', schedule: { fixed: { enabled: true, times: ['x'] } } })).toThrow(/HH:MM/);
    expect(() => cleanWebinar({ title: 'A', settings: { offer: { enabled: true } } })).toThrow(/Angebot/);
    expect(() => cleanWebinar({ title: 'A', settings: { room: { polls: [{ question: 'Frage?', options: ['nur eine'] }] } } })).toThrow(/zwei Antworten/);
    const w = cleanWebinar({ title: 'A', duration_min: 45 });
    expect(w.duration_s).toBe(2700);
  });

  it('keeps moments inside the video when the duration shrinks', () => {
    const w = cleanWebinar({ title: 'A', duration_s: 3600, settings: { offer: { enabled: true, at_s: 3000, title: 'Angebot', target: { type: 'url', url: 'https://example.com/x' } }, room: { polls: [{ at_s: 3500, question: 'Wie war es?', options: ['gut', 'schlecht'] }] } } });
    const shorter = cleanWebinar({ duration_s: 1800 }, w);
    expect(shorter.settings.offer.at_s).toBe(1800);
    expect(shorter.settings.room.polls[0].at_s).toBe(1800);
  });

  it('says what is missing before publishing', () => {
    const w = cleanWebinar({ title: 'A' });
    expect(publishProblems(w)).toHaveLength(3);
    const ok = cleanWebinar({ title: 'A', duration_s: 600, video: { type: 'youtube', id: 'dQw4w9WgXcQ' }, schedule: { ondemand: { enabled: true } } });
    expect(publishProblems(ok)).toEqual([]);
  });

  it('makes unique slugs and keeps reserved paths free', () => {
    const taken = new Set(['mein-webinar', 'mein-webinar-2']);
    expect(uniqueSlug('Mein Webinar', (s) => taken.has(s))).toBe('mein-webinar-3');
    expect(uniqueSlug('Ärger mit Übergröße', () => false)).toBe('arger-mit-ubergrosse');
    expect(uniqueSlug('Assets', () => false)).toBe('assets-2');
  });
});

describe('video sources', () => {
  it('reduces YouTube and Vimeo links of any form to their id', () => {
    for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=5', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'youtube-nocookie.com/embed/dQw4w9WgXcQ']) {
      expect(embedOf(url), url).toEqual({ type: 'youtube', id: 'dQw4w9WgXcQ' });
    }
    expect(embedOf('https://vimeo.com/123456789')).toEqual({ type: 'vimeo', id: '123456789' });
    expect(embedOf('https://player.vimeo.com/video/123456789?h=abc')).toEqual({ type: 'vimeo', id: '123456789' });
    expect(embedOf('https://vimeo.com/123456789/abcdef012345')).toEqual({ type: 'vimeo', id: '123456789', hash: 'abcdef012345' });
    expect(embedOf('https://example.com/video.mp4')).toBeUndefined();
    expect(cleanVideo({ type: 'youtube', id: 'dQw4w9WgXcQ' })).toEqual({ type: 'youtube', id: 'dQw4w9WgXcQ' });
    // a YouTube link pasted as "MP4 link" still ends up as an embed
    expect(cleanVideo({ type: 'url', url: 'https://youtu.be/dQw4w9WgXcQ' })).toEqual({ type: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(() => cleanVideo({ type: 'youtube', id: 'kein-link' })).toThrow(/YouTube/);
    expect(() => cleanVideo({ type: 'vimeo', id: 'abc' })).toThrow(/Vimeo/);
  });

  it('only takes https links without credentials, and known types', () => {
    expect(cleanVideo({ type: 'url', url: 'https://cdn.example.com/v/webinar.mp4' })).toEqual({ type: 'url', url: 'https://cdn.example.com/v/webinar.mp4' });
    expect(() => cleanVideo({ type: 'url', url: 'http://cdn.example.com/a.mp4' })).toThrow(/https/);
    expect(() => cleanVideo({ type: 'url', url: 'https://user:pw@cdn.example.com/a.mp4' })).toThrow(/Zugangsdaten/);
    expect(() => cleanVideo({ type: 'url', url: 'data:video/mp4;base64,AAAA' })).toThrow(/https/);
    expect(() => cleanVideo({ type: 'url', url: '' })).toThrow(/fehlt/);
    expect(() => cleanVideo({ type: 'ftp' })).toThrow(/gibt es nicht/);
    expect(() => cleanVideo({ type: 'upload', upload_id: '../x' })).toThrow(/Upload/);
    expect(cleanVideo(undefined)).toEqual({ type: 'none' });
  });

  it('tells the room how to play it', () => {
    const media = '/w/x/media?t=abc';
    expect(playbackOf({ type: 'upload', upload_id: 'abcdefgh12', name: 'a.mp4' }, { mediaUrl: media })).toEqual({ kind: 'file', src: media, mime: 'video/mp4' });
    expect(playbackOf({ type: 'url', url: 'https://cdn.example.com/a.webm' }, { mediaUrl: media })).toEqual({ kind: 'file', src: 'https://cdn.example.com/a.webm', mime: 'video/webm' });
    expect(playbackOf({ type: 'url', url: 'https://cdn.example.com/live/master.m3u8?sig=1' }, { mediaUrl: media })).toEqual({ kind: 'hls', src: 'https://cdn.example.com/live/master.m3u8?sig=1' });
    const yt = playbackOf({ type: 'youtube', id: 'dQw4w9WgXcQ' }, { mediaUrl: media });
    expect(yt).toMatchObject({ kind: 'embed', provider: 'youtube' });
    expect((yt as { src: string }).src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect((yt as { src: string }).src).toContain('controls=0');
    expect(playbackOf({ type: 'none' }, { mediaUrl: media })).toEqual({ kind: 'none' });
  });

  it('recognises video containers by their first bytes', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
    expect(looksLikeVideo(mp4)).toBe(true);
    expect(looksLikeVideo(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]))).toBe(true);
    expect(looksLikeVideo(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(12)]))).toBe(true);
    expect(looksLikeVideo(Buffer.from('<html><script>alert(1)</script></html>'))).toBe(false);
    expect(looksLikeVideo(Buffer.alloc(4))).toBe(false);
  });

  it('reads one byte range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=2000-3000', 1000)).toBeNull();
    expect(parseRange('bytes=5-1', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe('signed links', () => {
  const secret = 'test-secret';
  it('lead to one registration and nothing else', () => {
    const t = joinToken(secret, 'AbCdEfGh12345678');
    expect(readJoinToken(secret, t)).toBe('AbCdEfGh12345678');
    expect(readJoinToken('other-secret', t)).toBeUndefined();
    expect(readJoinToken(secret, t.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBeUndefined();
    expect(readJoinToken(secret, `AbCdEfGh12345679.${t.split('.')[1]}`)).toBeUndefined();
    expect(readJoinToken(secret, 'AbCdEfGh12345678')).toBeUndefined();
    expect(readJoinToken(secret, '')).toBeUndefined();
    expect(readJoinToken(secret, undefined)).toBeUndefined();
  });

  it('preview links are tied to the webinar, expire and carry the second', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const p = previewToken(secret, 'webinar1', exp, 120);
    expect(readPreviewToken(secret, 'webinar1', p, Date.now())).toEqual({ offset: 120 });
    expect(readPreviewToken(secret, 'webinar2', p, Date.now())).toBeUndefined();
    expect(readPreviewToken(secret, 'webinar1', p, (exp + 1) * 1000)).toBeUndefined();
    expect(readPreviewToken(secret, 'webinar1', p.replace('.120.', '.999.'), Date.now())).toBeUndefined();
    expect(readPreviewToken(secret, 'webinar1', 'x', Date.now())).toBeUndefined();
  });
});

describe('calendar file', () => {
  it('has the personal link, an alarm, folded lines and stays valid when the title has special characters', () => {
    const w: any = { id: 'w1', title: 'Mehr Kunden; mit, Webinaren – ein sehr langer Titel, der garantiert über die fünfundsiebzig Zeichen pro Zeile hinausgeht und umgebrochen werden muss', presenter_name: 'Erika Muster', duration_s: 3600, slug: 'mehr-kunden' };
    const reg: any = { id: 'AbCdEfGh12345678', session_start: '2026-11-09T18:00:00.000Z', status: 'registered' };
    const app: any = { baseUrl: () => 'https://gh.example.com', config: { secret: 'test-secret' } };
    const ics = icsOf(app, w, reg);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261109T180000Z');
    expect(ics).toContain('DTEND:20261109T190000Z');
    expect(ics).toContain('UID:AbCdEfGh12345678@gohigh-webinar');
    expect(ics).toContain('TRIGGER:-PT15M');
    expect(ics).toContain('Automatisiertes Webinar');
    expect(ics.replace(/\r\n /g, '')).toContain('https://gh.example.com/w/mehr-kunden/watch?t=AbCdEfGh12345678.');
    expect(ics).toContain('Kunden\\; mit\\, Webinaren');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line), line).toBeLessThanOrEqual(75);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
