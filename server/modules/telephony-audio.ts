import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { AUDIO_KINDS, MAX_AUDIO_BYTES, PLAYABLE, audioSeconds, holdMelody, type AudioKind } from '../services/call-audio.js';
import { sniff } from '../services/genmedia/media.js';
import { asHttp, synthesize } from '../services/voice-engine.js';

/**
 * Audio files of the telephony: greetings of the telephone menu, hold music of queues and the pre-recorded messages the power
 * dialer leaves on a voicemail ("Voicemail-Drop"). Uploaded as MP3/WAV or spoken from a text with the sub-account's own voice
 * (KI-Anbieter → Sprachausgabe). Twilio fetches them from /hooks/twilio/audio/<file> – the file name is random and unguessable,
 * the files hold nothing but the message itself.
 */

export interface AudioRow {
  id: string;
  location_id: string;
  name: string;
  kind: AudioKind;
  mime: string;
  bytes: number;
  file: string;
  text: string;
  duration_s: number;
  created_at: string;
}

export const audioDir = (app: App) => join(app.config.dataDir, 'call-audio');
export const audioUrl = (app: App, row: Pick<AudioRow, 'file'>) => `${app.baseUrl()}/hooks/twilio/audio/${row.file}`;
export const defaultHoldUrl = (app: App) => `${app.baseUrl()}/hooks/twilio/audio/default-hold.wav`;

/** The audio file of a sub-account by id, or undefined (also for another sub-account's id). */
export const audioOf = (app: App, locationId: string, audioId: string | null | undefined) => (audioId ? app.db.get<AudioRow>('SELECT * FROM call_audio WHERE id = ? AND location_id = ?', audioId, locationId) : undefined);

const out = (app: App, r: AudioRow) => ({ id: r.id, name: r.name, kind: r.kind, mime: r.mime, bytes: r.bytes, duration_s: r.duration_s, text: r.text, created_at: r.created_at, url: audioUrl(app, r) });

export const telephonyAudioModule: Module = {
  name: 'telephony-audio',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE call_audio (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
        file TEXT NOT NULL UNIQUE, text TEXT NOT NULL DEFAULT '', duration_s INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX call_audio_loc ON call_audio(location_id, kind, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    // Modules that use a file say so, so it is not deleted from under them: (locationId, audioId) → what uses it.
    app.services.audioUsage ??= [];

    // Raw audio bodies for the upload (a JSON body – the text for a spoken message – needs no extra room).
    const prev = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'POST' && path === '/api/telephony/audio' && /^audio\/|application\/octet-stream/i.test(String(req.headers['content-type'] ?? '')) && (cookies.pghl_session || req.headers.authorization) ? MAX_AUDIO_BYTES + 1024 : prev?.(method, path, req, cookies);

    const store = (locationId: string, name: string, kind: AudioKind, data: Buffer, mime: string, text = ''): AudioRow => {
      mkdirSync(audioDir(app), { recursive: true });
      const file = `${id(24)}${PLAYABLE[mime]}`;
      writeFileSync(join(audioDir(app), file), data);
      const row: AudioRow = { id: id(), location_id: locationId, name, kind, mime, bytes: data.length, file, text, duration_s: audioSeconds(data, mime), created_at: now() };
      db.insert('call_audio', row);
      return row;
    };

    router.get('/api/telephony/audio', 'location', (ctx) => {
      const kind = ctx.query.get('kind');
      const rows = db.all<AudioRow>(`SELECT * FROM call_audio WHERE location_id = ? ${kind && (AUDIO_KINDS as readonly string[]).includes(kind) ? 'AND kind = ?' : ''} ORDER BY created_at DESC LIMIT 200`, ctx.locationId, ...(kind && (AUDIO_KINDS as readonly string[]).includes(kind) ? [kind] : []));
      return { audio: rows.map((r) => out(app, r)), default_hold: defaultHoldUrl(app) };
    });

    const kindOf = (v: unknown): AudioKind => {
      const k = String(v ?? 'greeting');
      if (!(AUDIO_KINDS as readonly string[]).includes(k)) throw bad('Art: Ansage, Wartemusik oder Voicemail-Drop');
      return k as AudioKind;
    };

    /** An MP3/WAV file as raw bytes (`?name=&kind=`), or a spoken message from a text ({ name, kind, text }). */
    router.post('/api/telephony/audio', 'location', async (ctx: Ctx) => {
      const raw = ctx.rawBuffer;
      if (raw?.length) {
        const name = str(ctx.query.get('name'), 'Name', { required: true, max: 80 });
        if (raw.length > MAX_AUDIO_BYTES) throw bad(`Datei ist zu groß (höchstens ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB)`);
        // The type comes from the bytes, never from the header.
        const mime = sniff(raw, 'audio/');
        if (!PLAYABLE[mime]) throw bad('Bitte eine MP3- oder WAV-Datei hochladen (andere Formate spielt Twilio nicht ab)');
        return out(app, store(ctx.locationId, name, kindOf(ctx.query.get('kind')), raw, mime));
      }
      const b = ctx.body ?? {};
      const text = str(b.text, 'Text', { required: true, max: 1500 });
      const name = str(b.name, 'Name', { required: true, max: 80 });
      try {
        const r = await synthesize(app, { locationId: ctx.locationId, text });
        if (!PLAYABLE[r.mime]) throw bad('Der Sprachanbieter liefert ein Format, das Twilio nicht abspielt – bitte MP3 oder WAV einstellen oder eine Datei hochladen');
        return out(app, store(ctx.locationId, name, kindOf(b.kind), r.data, r.mime, text));
      } catch (e) {
        throw asHttp(e);
      }
    });

    router.patch('/api/telephony/audio/:id', 'location', (ctx) => {
      const r = audioOf(app, ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Audiodatei nicht gefunden');
      if (ctx.body?.name !== undefined) db.run('UPDATE call_audio SET name = ? WHERE id = ?', str(ctx.body.name, 'Name', { required: true, max: 80 }), r.id);
      return out(app, audioOf(app, ctx.locationId, r.id)!);
    });

    router.delete('/api/telephony/audio/:id', 'location', (ctx) => {
      const r = audioOf(app, ctx.locationId, ctx.params.id);
      if (!r) throw notFound('Audiodatei nicht gefunden');
      for (const use of app.services.audioUsage as ((loc: string, audioId: string) => string | undefined)[]) {
        const where = use(ctx.locationId, r.id);
        if (where) throw bad(`Die Datei wird noch benutzt: ${where}`);
      }
      db.run('DELETE FROM call_audio WHERE id = ?', r.id);
      rmSync(join(audioDir(app), r.file), { force: true });
      return { ok: true };
    });

    /** What Twilio plays. The name of the file is the secret; nothing but the audio is served. */
    router.get('/hooks/twilio/audio/:file', 'public', (ctx) => {
      const file = ctx.params.file;
      if (file === 'default-hold.wav') return { __raw: true, status: 200, headers: { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=86400' }, body: holdMelody() };
      if (!/^[A-Za-z0-9]{24}\.(mp3|wav)$/.test(file)) throw notFound();
      const row = db.get<AudioRow>('SELECT * FROM call_audio WHERE file = ?', file);
      const path = row && join(audioDir(app), row.file);
      if (!row || !path || !existsSync(path)) throw notFound();
      return { __raw: true, status: 200, headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }, body: readFileSync(path) };
    });
  },
};
