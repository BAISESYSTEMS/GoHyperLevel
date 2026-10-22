import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { startTestApp } from './helpers.js';

/** Shared bits of the creator-depth tests (course video, discussion, paths, cohorts, analytics, forms). */

type T = Awaited<ReturnType<typeof startTestApp>>;

/** The first bytes of an MP4 container (`ftyp` at offset 4), padded to `n` bytes. */
export const fakeMp4 = (n = 200, fill = 7) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(Math.max(0, n - 12), fill)]);

export const BANNER = 'Input #0, mov,mp4, from \'x.mp4\':\n  Duration: 00:12:34.56, start: 0.000000, bitrate: 1200 kb/s\n  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 25 fps\n  Stream #0:1: Audio: aac, 44100 Hz\n';

export interface FakeFfmpeg {
  run: (tool: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  calls: string[][];
  /** Simulates a server without ffmpeg. */
  offline: boolean;
  /** Banner `ffmpeg -i` prints. */
  banner: string;
}

/** An ffmpeg stand-in: answers -version and the banner, and writes the files the real one would (poster, HLS, audio pieces). */
export function fakeFfmpeg(): FakeFfmpeg {
  const f: FakeFfmpeg = {
    calls: [],
    offline: false,
    banner: BANNER,
    async run(_tool, args) {
      f.calls.push(args);
      if (f.offline) return { code: 127, stdout: '', stderr: 'spawn ffmpeg ENOENT' };
      if (args[0] === '-version') return { code: 0, stdout: 'ffmpeg version fake', stderr: '' };
      const out = args.at(-1) ?? '';
      const put = (path: string, data: string | Buffer) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
      };
      if (args.includes('-hide_banner')) return { code: 1, stdout: '', stderr: f.banner };
      if (args.includes('-frames:v')) put(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
      else if (args.includes('-var_stream_map')) {
        const dir = dirname(out);
        put(`${dir}/master.m3u8`, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nv0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2900000\nv1.m3u8\n');
        for (const v of [0, 1]) {
          put(`${dir}/v${v}.m3u8`, `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nv${v}_000.ts\n#EXT-X-ENDLIST\n`);
          put(`${dir}/v${v}_000.ts`, Buffer.alloc(188, 0x47));
        }
      } else if (args.includes('-f') && args[args.indexOf('-f') + 1] === 'segment') {
        for (let i = 0; i < 2; i++) put(out.replace('%04d', String(i).padStart(4, '0')), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(120, i + 1)]));
      } else if (args.includes('+faststart')) {
        /* the remux produces nothing in the fake: the original stays */
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return f;
}

/** Logs a contact into the member portal of the test sub-account and returns its cookie (`pm_<location>=…`). */
export async function memberLogin(t: T, contactId: string): Promise<string> {
  const mails: { text: string }[] = [];
  const prev = t.app.services.memberMailer;
  t.app.services.memberMailer = async (_loc: unknown, mail: { text: string }) => {
    mails.push(mail);
    return { status: 'sent' };
  };
  try {
    await t.app.services.sendMemberLoginLink(t.api.location, contactId);
  } finally {
    t.app.services.memberMailer = prev;
  }
  const link = new URL(mails.at(-1)!.text.match(/https?:\/\/\S+\/auth\?token=\S+/)![0]);
  const r = await t.api.raw(`/portal/${t.api.location}/auth`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: link.searchParams.get('token')! }).toString() });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie.startsWith('pm_')) throw new Error(`member login failed: ${r.status}`);
  return cookie;
}

/** GET with the member's cookie (and any extra headers). */
export const memberGet = (t: T, path: string, cookie: string, headers: Record<string, string> = {}) => t.api.raw(path, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });

/** A form POST (the member portal's pages) with the member's cookie. */
export const memberPost = (t: T, path: string, data: Record<string, string>, cookie: string, headers: Record<string, string> = {}) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers }, body: new URLSearchParams(data).toString() });

export const memberJson = (t: T, path: string, body: unknown, cookie: string, headers: Record<string, string> = {}) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });

/** `src="…"` / `href="…"` values of a page with HTML entities undone. */
export const urlsIn = (html: string, re: RegExp): string[] => [...html.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].map((m) => m[1].replace(/&amp;/g, '&'));
