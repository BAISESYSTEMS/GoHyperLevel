import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';
import type { AcademyState, TourProgress } from './types';

/**
 * The signed-in user's academy state (progress per tour, the tour that is running, the practice
 * sub-account), shared by the tour layer, the „?“ button and the academy page. Writes are optimistic
 * and sent to the server shortly after, so clicking through steps stays instant.
 */

let state: AcademyState | null = null;
let loading: Promise<AcademyState | null> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export function loadAcademy(force = false): Promise<AcademyState | null> {
  if (loading && !force) return loading;
  loading = api
    .get<AcademyState>('/api/academy')
    .then((s) => ((state = s), emit(), s))
    .catch(() => null)
    .finally(() => (loading = null));
  return loading;
}

export function academyState() {
  return state;
}

export function useAcademy(): AcademyState | null {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!state && !loading) void loadAcademy();
  }, []);
  return s;
}

const pending = new Map<string, { body: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }>();

function send(tourId: string, body: Record<string, unknown>) {
  return api.put(`/api/academy/tours/${tourId}`, body).catch(() => undefined);
}

/** Remember where the user is; `active` = this tour is running (resumed after a reload). */
export function saveProgress(tourId: string, step: number, total: number, opts: { active?: boolean; done?: boolean } = {}) {
  if (state) {
    const cur = state.tours[tourId];
    const t = new Date().toISOString();
    const next: TourProgress = {
      step,
      total,
      max_step: Math.max(cur?.max_step ?? 0, step),
      done: !!cur?.done || !!opts.done,
      started_at: cur?.started_at ?? t,
      updated_at: t,
      completed_at: cur?.completed_at ?? (opts.done ? t : null),
    };
    state = {
      ...state,
      tours: { ...state.tours, [tourId]: next },
      active: opts.done || opts.active === false ? (state.active?.tour === tourId ? null : state.active) : opts.active ? { tour: tourId, step } : state.active,
    };
    emit();
  }
  const body = { step, total, ...opts };
  const p = pending.get(tourId);
  if (p) clearTimeout(p.timer);
  // Finishing or closing goes out right away; plain step changes are batched.
  if (opts.done || opts.active === false) {
    pending.delete(tourId);
    void send(tourId, body);
    return;
  }
  pending.set(tourId, { body, timer: setTimeout(() => (pending.delete(tourId), void send(tourId, body)), 350) });
}

/** The running tour was closed (✕, Esc, „Später“). */
export function clearActive() {
  if (state?.active) {
    state = { ...state, active: null };
    emit();
  }
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    void send(id, { ...p.body, active: false });
  }
  pending.clear();
  return api.del('/api/academy/active').catch(() => undefined);
}

export async function resetTour(tourId: string) {
  await api.del(`/api/academy/tours/${tourId}`);
  if (state) {
    const { [tourId]: _gone, ...rest } = state.tours;
    state = { ...state, tours: rest, active: state.active?.tour === tourId ? null : state.active };
    emit();
  }
}

export async function createSandbox(): Promise<{ id: string; name: string }> {
  const r = await api.post<{ id: string; name: string }>('/api/academy/sandbox', {});
  if (state) state = { ...state, sandbox: { id: r.id, name: r.name } };
  emit();
  return r;
}

export async function deleteSandbox() {
  await api.del('/api/academy/sandbox');
  if (state) state = { ...state, sandbox: null };
  emit();
}
