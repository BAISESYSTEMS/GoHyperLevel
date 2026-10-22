import { describe, expect, it } from 'vitest';
import {
  EMPTY_PLAYBACK,
  applyPlayback,
  chaptersText,
  cleanChapters,
  cleanCompletePercent,
  cleanLang,
  cuesFromChunks,
  durationFromBanner,
  formatTimestamp,
  formatVtt,
  heightFromBanner,
  hlsArgs,
  hlsLadder,
  isWatchedEnough,
  parseCaptions,
  parseTimestamp,
  resumeAt,
  signPlaylist,
  watchedPercent,
} from '../server/services/course-media.js';
import { playerHtml } from '../server/services/course-player.js';

describe('chapters', () => {
  it('reads times in the usual forms', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp('12:30')).toBe(750);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('45')).toBe(45);
    expect(parseTimestamp('1:75')).toBeUndefined();
    expect(parseTimestamp('abc')).toBeUndefined();
    expect(formatTimestamp(3723)).toBe('1:02:03');
    expect(formatTimestamp(75)).toBe('1:15');
  });

  it('accepts YouTube-style text and lists, sorts and drops duplicates', () => {
    const list = cleanChapters('2:15 Thema A\n0:00 Einleitung\n- 10:00 – Abschluss\n2:15 doppelt');
    expect(list).toEqual([
      { t: 0, title: 'Einleitung' },
      { t: 135, title: 'Thema A' },
      { t: 600, title: 'Abschluss' },
    ]);
    expect(chaptersText(list)).toBe('0:00 Einleitung\n2:15 Thema A\n10:00 Abschluss');
    expect(cleanChapters([{ t: 30, title: ' Kurz ' }])).toEqual([{ t: 30, title: 'Kurz' }]);
    expect(cleanChapters('')).toEqual([]);
    expect(() => cleanChapters('irgendein Text ohne Zeit')).toThrow(/0:00 Titel/);
    expect(() => cleanChapters([{ t: 5, title: '' }])).toThrow(/Titel/);
    expect(() => cleanChapters([{ t: 'x', title: 'a' }])).toThrow(/Zeit/);
    expect(cleanChapters(Array.from({ length: 80 }, (_v, i) => ({ t: i, title: `K${i}` })))).toHaveLength(60);
  });
});

describe('captions', () => {
  const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHallo <b>Welt</b>\n\n2\n00:00:04.000 --> 00:00:06.000 align:start\n<script>x()</script>Zweite Zeile\n';
  it('reads WebVTT, keeps basic emphasis and drops other markup', () => {
    const cues = parseCaptions(VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 3.5, text: 'Hallo <b>Welt</b>' });
    expect(cues[1].text).toBe('x()Zweite Zeile');
    expect(formatVtt(cues)).toContain('00:00:01.000 --> 00:00:03.500');
    expect(formatVtt(cues).startsWith('WEBVTT\n')).toBe(true);
  });

  it('converts SRT (comma times) and refuses garbage', () => {
    const srt = '1\n00:00:00,500 --> 00:00:02,000\nEins\n\n2\n00:01:00,000 --> 00:01:02,250\nZwei\nzeilig\n';
    const cues = parseCaptions(srt);
    expect(cues.map((c) => [c.start, c.end])).toEqual([[0.5, 2], [60, 62.25]]);
    expect(cues[1].text).toBe('Zwei\nzeilig');
    expect(() => parseCaptions('')).toThrow(/leer/);
    expect(() => parseCaptions('Das ist kein Untertitel')).toThrow(/weder WebVTT noch SRT/);
    expect(() => parseCaptions('WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nrückwärts')).toThrow(/Zeitangabe/);
    expect(() => parseCaptions('WEBVTT\n\nnur Kopf')).toThrow(/keine Untertitel/);
  });

  it('checks the language code', () => {
    expect(cleanLang('DE')).toBe('de');
    expect(cleanLang('pt-br')).toBe('pt-BR');
    expect(() => cleanLang('deutsch')).toThrow();
    expect(() => cleanLang('')).toThrow();
  });

  it('spreads the text of an audio piece over its time by sentence', () => {
    const cues = cuesFromChunks([
      { start: 0, end: 60, text: 'Erster Satz hier. Zweiter Satz ist etwas länger als der erste.' },
      { start: 60, end: 90, text: '' },
      { start: 90, end: 120, text: 'Noch ein Stück.' },
    ]);
    expect(cues).toHaveLength(3);
    expect(cues[0].start).toBe(0);
    expect(cues[1].end).toBeCloseTo(60, 5);
    expect(cues[0].end).toBeCloseTo(cues[1].start, 5);
    expect(cues[0].end - cues[0].start).toBeLessThan(cues[1].end - cues[1].start);
    expect(cues[2]).toMatchObject({ start: 90, end: 120 });
    // A very long sentence is cut at spaces
    const long = cuesFromChunks([{ start: 0, end: 30, text: 'wort '.repeat(60) }]);
    expect(long.length).toBeGreaterThan(2);
    expect(long.every((c) => c.text.length <= 84)).toBe(true);
  });
});

describe('resume and watched time', () => {
  const t0 = Date.parse('2026-10-05T10:00:00Z');
  it('keeps position and furthest point inside the video and takes the file duration over the player', () => {
    const pb = applyPlayback(undefined, { position: 500, duration: 99999, furthest: 700, watched: 3, speed: 1.5 }, { duration: 300, now: t0 });
    expect(pb.duration_sec).toBe(300);
    expect(pb.position_sec).toBe(300);
    expect(pb.furthest_sec).toBe(300);
    expect(pb.speed).toBe(1.5);
    expect(applyPlayback(undefined, { position: -5, duration: 100, speed: 9 }, { now: t0 })).toMatchObject({ position_sec: 0, speed: 1, duration_sec: 100 });
  });

  it('lets watched time grow no faster than 3x the clock, and never shrink', () => {
    const first = applyPlayback(undefined, { position: 100, duration: 600, watched: 590 }, { now: t0 });
    // first report: only the allowance (6 s) – "I watched everything" does not finish a lesson
    expect(first.watched_sec).toBe(6);
    const second = applyPlayback(first, { position: 110, duration: 600, watched: 590 }, { now: t0 + 10_000 });
    expect(second.watched_sec).toBe(42); // 6 + 10 s * 3 + 6
    const honest = applyPlayback(second, { position: 140, duration: 600, watched: 60 }, { now: t0 + 20_000 });
    expect(honest.watched_sec).toBe(60);
    const back = applyPlayback(honest, { position: 10, duration: 600, watched: 5 }, { now: t0 + 30_000 });
    expect(back.watched_sec).toBe(60);
    expect(back.furthest_sec).toBe(140);
    expect(back.position_sec).toBe(10);
  });

  it('decides where to resume and when a lesson counts as watched', () => {
    expect(resumeAt(undefined)).toBe(0);
    expect(resumeAt({ position_sec: 3, duration_sec: 600 })).toBe(0);
    expect(resumeAt({ position_sec: 123.7, duration_sec: 600 })).toBe(123);
    expect(resumeAt({ position_sec: 595, duration_sec: 600 })).toBe(0);
    expect(watchedPercent({ watched_sec: 150, duration_sec: 600 })).toBe(25);
    expect(watchedPercent({ watched_sec: 150, duration_sec: 0 })).toBe(0);
    expect(isWatchedEnough({ watched_sec: 540, duration_sec: 600 }, 90)).toBe(true);
    expect(isWatchedEnough({ watched_sec: 500, duration_sec: 600 }, 90)).toBe(false);
    expect(isWatchedEnough({ watched_sec: 600, duration_sec: 600 }, 0)).toBe(false);
    expect(isWatchedEnough({ watched_sec: 600, duration_sec: 0 }, 90)).toBe(false);
    expect(cleanCompletePercent('90')).toBe(90);
    expect(cleanCompletePercent(3)).toBe(10);
    expect(cleanCompletePercent(500)).toBe(100);
    expect(cleanCompletePercent('')).toBe(0);
    expect(EMPTY_PLAYBACK.speed).toBe(1);
  });
});

describe('ffmpeg helpers', () => {
  it('reads duration, height and builds an HLS ladder no bigger than the source', () => {
    const banner = '  Duration: 00:12:34.56, start: 0.000000, bitrate: 1200 kb/s\n  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 25 fps\n  Stream #0:1: Audio: aac, 44100 Hz';
    expect(durationFromBanner(banner)).toBeCloseTo(754.56, 2);
    expect(heightFromBanner(banner)).toBe(1080);
    expect(durationFromBanner('nothing')).toBe(0);
    expect(hlsLadder(480).map((r) => r.height)).toEqual([360]);
    expect(hlsLadder(720).map((r) => r.height)).toEqual([360, 720]);
    expect(hlsLadder(2160).map((r) => r.height)).toEqual([360, 720, 1080]);
    expect(hlsLadder(0).length).toBe(3);
    expect(hlsLadder(100).map((r) => r.height)).toEqual([360]);
    const args = hlsArgs('/in.mp4', '/out', 720, true);
    expect(args).toContain('-var_stream_map');
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0 v:1,a:1');
    expect(args).toContain('master.m3u8');
    expect(args.at(-1)).toBe('/out/v%v.m3u8');
    expect(hlsArgs('/in.mp4', '/out', 360, false)[hlsArgs('/in.mp4', '/out', 360, false).indexOf('-var_stream_map') + 1]).toBe('v:0');
  });

  it('puts the viewer token on every file a playlist names', () => {
    const pl = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nv0.m3u8\n#EXT-X-KEY:METHOD=AES-128,URI="key.ts"\n#EXTINF:6.0,\nv0_000.ts\nhttps://evil.example/x.ts\n';
    const out = signPlaylist(pl, 'a b');
    expect(out).toContain('v0.m3u8?t=a%20b');
    expect(out).toContain('v0_000.ts?t=a%20b');
    expect(out).toContain('URI="key.ts?t=a%20b"');
    expect(out).toContain('\nhttps://evil.example/x.ts\n');
  });
});

describe('player markup', () => {
  it('escapes everything it prints and lists chapters, captions and the HLS source', () => {
    const html = playerHtml({
      title: 'Lektion "A" <b>',
      video: '/v.mp4?t=a&b',
      hls: '/h.m3u8?t=x',
      poster: '/p.jpg',
      captions: [{ lang: 'de', label: 'Deutsch<script>', src: '/c.vtt' }],
      chapters: [{ t: 90, title: '<img onerror=x>' }],
      resume: 42,
      speed: 1.25,
      post: '/portal/x/c/y/z/playback',
      completePercent: 90,
      duration: 600,
      watched: 12,
      furthest: 50,
      done: false,
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('application/vnd.apple.mpegurl');
    expect(html).toContain('data-t="90"');
    expect(html).toContain('1:30');
    expect(html).toContain('<option value="1.25" selected>1,25×</option>');
    expect(html).toContain('controlslist="nodownload"');
    expect(html).toContain('90 % gesehen');
    expect(html).toContain('&quot;resume&quot;:42');
  });
});
