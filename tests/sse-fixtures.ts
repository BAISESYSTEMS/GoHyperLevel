import { expect } from 'vitest';
import type { Db } from '../server/core/db.js';
import { sha256 } from '../server/core/util.js';
import { client } from './security-fixtures.js';

/**
 * Helpers for the live streams (Server-Sent Events) of Team-Chat, Team-Posteingang, Canvas and Living Boards: a tiny
 * reader, a second login of the same person and a session that runs out – for "the stream ends with its login".
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// some test files replace fetch with an offline stub after the imports
const realFetch = globalThis.fetch;

/** The last event of a stream whose login ended (services/stream-login.ts). */
export const BYE = /event: bye\ndata: \{"reason":"signed_out"\}/;

/** An open SSE stream with a tiny reader. */
export async function openSse(url: string, headers: Record<string, string>) {
  const ctrl = new AbortController();
  const res = await realFetch(url, { headers, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  let pending: Promise<void> | undefined;
  const pump = () => {
    pending ??= reader.read().then(
      (r) => {
        pending = undefined;
        if (r.done) done = true;
        else buf += dec.decode(r.value);
      },
      () => {
        pending = undefined;
        done = true;
      },
    );
    return pending;
  };
  return {
    text: () => buf,
    /** The server closed the stream. */
    ended: () => done,
    async until(re: RegExp, ms = 3000) {
      const end = Date.now() + ms;
      while (!re.test(buf) && !done && Date.now() < end) await Promise.race([pump(), sleep(50)]);
      return re.test(buf);
    },
    /** True when nothing matching `re` arrived within `ms`. */
    async quiet(re: RegExp, ms = 300) {
      const end = Date.now() + ms;
      while (!done && Date.now() < end) await Promise.race([pump(), sleep(30)]);
      return !re.test(buf);
    },
    /** True when the server closed the stream within `ms`. */
    async ends(ms = 2000) {
      const end = Date.now() + ms;
      while (!done && Date.now() < end) await Promise.race([pump(), sleep(30)]);
      return done;
    },
    async close() {
      ctrl.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

/** Another login of the same person (a second browser or device). */
export async function loginAgain(base: string, locationId: string, email: string, password: string) {
  const c = client(base, { 'x-pghl': '1', 'x-location-id': locationId });
  expect((await c('POST', '/api/auth/login', { email, password })).status).toBe(200);
  return c;
}

/** The stored hash of the session behind a cookie (`pghl_session=…`). */
export const sessionHash = (cookie: string) => sha256(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)));

/** Lets the session behind a cookie run out, as if its time was up. */
export function expireSession(db: Db, cookie: string) {
  expect(db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', new Date(Date.now() - 1000).toISOString(), sessionHash(cookie)).changes).toBe(1);
}
