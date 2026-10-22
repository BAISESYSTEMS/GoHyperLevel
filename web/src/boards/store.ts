import { useCallback, useEffect, useRef, useState } from 'react';
import { api, currentLocation } from '../api';
import { toastError } from '../ui';
import type { BoardFull, BoardState, Catalogue, Spec, Viewer, WidgetData } from './types';

/**
 * The state of one open board: the board itself, kept current by the server's event stream (so changes by other people,
 * the agent or an undo appear at once), changes sent as patches with an optimistic local update, and the widgets' data.
 */

const clientId = () => `c${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export interface Live {
  summary: string;
  actor: string;
  via: string;
  at: number;
  mine: boolean;
}

export function useBoard(id: string) {
  const [board, setBoard] = useState<BoardFull | null>(null);
  const [error, setError] = useState('');
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [online, setOnline] = useState(true);
  const cid = useRef(clientId());
  const pending = useRef(0);
  const current = useRef<BoardFull | null>(null);
  current.current = board;

  const load = useCallback(async () => {
    try {
      const b = await api.get<BoardFull>(`/api/boards/${id}`);
      setBoard(b);
      setViewers(b.viewers ?? []);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setBoard(null);
    setError('');
    void load();
  }, [load]);

  // realtime: changes by other people, the agent, an undo
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let wasDown = false;
    let closed = false;
    /** The server said `bye` (signed out, session revoked or expired, no access any more): no reconnect until the tab is looked at again. */
    let parked = false;
    const open = () => {
      es = new EventSource(`/api/boards/${id}/stream?clientId=${cid.current}&locationId=${encodeURIComponent(currentLocation())}`);
      es.addEventListener('hello', (e) => {
        setViewers(JSON.parse((e as MessageEvent).data).viewers ?? []);
        setOnline(true);
        // after a dropped connection the board may have changed in between
        if (wasDown) void load();
        wasDown = false;
      });
      es.addEventListener('viewers', (e) => setViewers(JSON.parse((e as MessageEvent).data).viewers ?? []));
      es.addEventListener('board', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { client_id: string; state: BoardState; version: number; summary: string; actor: string; via: string; kind: string; can_undo: boolean; can_redo: boolean; updated_at: string };
        const mine = d.client_id === cid.current;
        // our own change is answered by the request itself; while one is on its way the stream must not undo our local picture
        if (mine && pending.current > 0) return;
        setBoard((b) => (b ? { ...b, ...d.state, version: d.version, can_undo: d.can_undo, can_redo: d.can_redo, updated_at: d.updated_at, updated_by: d.actor } : b));
        if (!mine) setLive({ summary: d.summary, actor: d.actor, via: d.via, at: Date.now(), mine: false });
      });
      es.addEventListener('deleted', () => {
        setError('Dieses Board wurde gelöscht.');
        es?.close();
      });
      es.addEventListener('access', () => void load());
      // the server ends the stream for good: no reconnect loop
      es.addEventListener('bye', () => {
        es?.close();
        parked = true;
        wasDown = true;
        setOnline(false);
      });
      es.addEventListener('error', () => {
        wasDown = true;
        setOnline(false);
        // An error answer (404/403, 503 when the server is full) closes the stream for good: show why when the board is gone for
        // us, and make one new try when the tab is looked at again (like after `bye`).
        if (es && es.readyState === EventSource.CLOSED && !closed) {
          parked = true;
          void api.get(`/api/boards/${id}`).catch((e) => setError((e as Error).message));
        }
      });
    };
    open();
    // looked at again after a `bye`: one new try (its hello reloads the board; without the login or access it fails once)
    const back = () => {
      if (!parked || closed || document.hidden) return;
      parked = false;
      open();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', back);
      es?.close();
    };
  }, [id, load]);

  /** Sends a patch; `optimistic` shows the result at once, the answer (the board as the server has it) replaces it. */
  const patch = useCallback(
    async (ops: Record<string, unknown>[], optimistic?: (b: BoardFull) => BoardFull, opts: { quiet?: boolean } = {}): Promise<BoardFull | null> => {
      const before = current.current;
      if (optimistic && before) setBoard(optimistic(before));
      pending.current++;
      try {
        const r = await api.post<{ board: BoardFull; unchanged?: boolean }>(`/api/boards/${id}/patch`, { ops, client_id: cid.current });
        setBoard(r.board);
        return r.board;
      } catch (e) {
        if (!opts.quiet) toastError(e);
        // back to what the server has
        await load();
        return null;
      } finally {
        pending.current--;
      }
    },
    [id, load],
  );

  const step = useCallback(
    async (path: string, body: Record<string, unknown> = {}): Promise<BoardFull | null> => {
      pending.current++;
      try {
        const b = await api.post<BoardFull>(`/api/boards/${id}/${path}`, { ...body, client_id: cid.current });
        setBoard(b);
        return b;
      } catch (e) {
        toastError(e);
        return null;
      } finally {
        pending.current--;
      }
    },
    [id],
  );

  /** Any other call on this board (compose, proposals): `board` in the answer replaces ours; errors go to the caller. */
  const call = useCallback(
    async <T extends { board?: BoardFull }>(path: string, body: Record<string, unknown> = {}): Promise<T> => {
      pending.current++;
      try {
        const r = await api.post<T>(`/api/boards/${id}/${path}`, { ...body, client_id: cid.current });
        if (r.board) setBoard(r.board);
        return r;
      } finally {
        pending.current--;
      }
    },
    [id],
  );

  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => setLive((l) => (l === live ? null : l)), 6000);
    return () => clearTimeout(t);
  }, [live]);

  return { board, setBoard, error, viewers, live, online, reload: load, patch, call, undo: () => step('undo'), redo: () => step('redo'), restore: (n: number) => step(`versions/${n}/restore`), clientId: cid.current };
}

/** The data of the widgets, refreshed every minute while the tab is open and whenever a widget's settings change. */
export function useWidgetData(boardId: string, spec: Spec | undefined) {
  const [data, setData] = useState<Record<string, WidgetData>>({});
  const [loading, setLoading] = useState(true);
  const sigs = useRef<Record<string, string>>({});
  const fetchedAt = useRef(0);

  const fetchIds = useCallback(
    async (ids?: string[]) => {
      try {
        const r = await api.get<{ data: Record<string, WidgetData> }>(`/api/boards/${boardId}/data${ids ? `?ids=${ids.join(',')}` : ''}`);
        setData((d) => ({ ...(ids ? d : {}), ...r.data }));
        if (!ids) fetchedAt.current = Date.now();
      } catch {
        /* the board itself shows the error; stale numbers stay */
      } finally {
        setLoading(false);
      }
    },
    [boardId],
  );

  useEffect(() => {
    setData({});
    setLoading(true);
    sigs.current = {};
  }, [boardId]);

  // new widgets and changed settings: just those
  useEffect(() => {
    if (!spec) return;
    const next: Record<string, string> = {};
    const changed: string[] = [];
    for (const w of spec.widgets) {
      next[w.id] = `${w.type}:${JSON.stringify(w.config)}`;
      if (sigs.current[w.id] !== next[w.id]) changed.push(w.id);
    }
    const first = Object.keys(sigs.current).length === 0;
    sigs.current = next;
    if (first) void fetchIds();
    else if (changed.length) void fetchIds(changed);
  }, [spec, fetchIds]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible' && Date.now() - fetchedAt.current > 55_000) void fetchIds();
    };
    const t = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [fetchIds]);

  return { data, loading, refresh: (ids?: string[]) => fetchIds(ids), refreshAll: () => fetchIds() };
}

let catalogue: Promise<Catalogue> | null = null;
let catalogueLoc = '';
/** The widget catalogue (types, fields) – loaded once per sub-account. */
export function loadCatalogue(): Promise<Catalogue> {
  const loc = currentLocation();
  if (!catalogue || catalogueLoc !== loc) {
    catalogueLoc = loc;
    catalogue = api.get<Catalogue>('/api/boards/widgets').catch((e) => {
      catalogue = null;
      throw e;
    });
  }
  return catalogue;
}

export function useCatalogue(): Catalogue | null {
  const [c, setC] = useState<Catalogue | null>(null);
  useEffect(() => {
    let live = true;
    loadCatalogue().then((x) => live && setC(x)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return c;
}
