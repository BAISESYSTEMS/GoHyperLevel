import { api } from '../api';
import { can, type Session } from '../session';
import { navigate } from '../ui';

/**
 * The start page: after signing in, somebody who made a board their start page lands on it instead of the default page.
 * A small note in the browser (refreshed daily, and whenever it is changed here) keeps this to a single request at most –
 * and nothing at all for people without a start board.
 */

const KEY = 'pghl.boards.home';
const TTL = 6 * 3600_000;
interface Home {
  board_id: string;
  location_id: string;
}

const read = (): { at: number; home: Home | null } | null => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
};
/** Remembers what the server said (called by the board page when the start page is set or cleared). */
export function rememberHome(home: Home | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), home }));
  } catch {
    /* storage blocked: the next start asks the server again */
  }
}

/** A board that is gone or no longer visible must not stay the start page in the note. */
export function forgetHome(boardId: string) {
  if (read()?.home?.board_id === boardId) rememberHome(null);
}

/** Only on the bare landing page; every other address is respected. */
export async function goHome(s: Pick<Session, 'user' | 'locationId' | 'switchLocation' | 'saas'>, route: string[]) {
  if (route.length || !can(s, 'dashboard') || !s.locationId) return;
  let note = read();
  if (!note || Date.now() - note.at > TTL) {
    try {
      const r = await api.get<{ home: Home | null }>('/api/boards/home');
      rememberHome(r.home);
      note = { at: Date.now(), home: r.home };
    } catch {
      return;
    }
  }
  const h = note.home;
  if (!h || location.pathname.replace(/\/+$/, '') !== '/app') return;
  if (h.location_id !== s.locationId) s.switchLocation(h.location_id, `boards/${h.board_id}`);
  else navigate(`boards/${h.board_id}`);
}
