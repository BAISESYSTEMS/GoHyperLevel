import type { ReactNode } from 'react';
import { currentLocation } from '../api';
import { useSession } from '../session';
import './creator.css';
import './calls.css';

/**
 * Shared parts of the pages behind "Anrufe": the wrapper that gives every control a 44 px hit target (creator.css), a raw upload
 * (recordings and audio files go up as the plain bytes) and a few formats. Docs: docs/telephony.md.
 */

/** Wrapper of a Calls sub-page. */
export const Tl = ({ children, name }: { children: ReactNode; name: string }) => <div className={`cr tl tl-${name}`}>{children}</div>;

/** Whether the signed-in person may change settings (menus, numbers, queues): the telephony settings need the "settings" area. */
export function useCanSettings(): boolean {
  const s = useSession();
  return s.user.role === 'admin' || !s.user.permissions || s.user.permissions.includes('settings');
}

/** mm:ss, or h:mm:ss from an hour on. */
export function dur(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}

/** The bytes of a file as the request body (`POST path?query`): audio files and meeting recordings. Throws the server's message. */
export async function uploadRaw<T = any>(path: string, file: File): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'x-pghl': '1', 'x-location-id': currentLocation(), 'content-type': file.type || 'application/octet-stream' }, body: file, credentials: 'same-origin' });
  const data = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && (data as any).error) || `Fehler ${r.status}`);
  return data as T;
}

/** A stored number for reading: a space after the country code of Germany, Austria and Switzerland (area codes vary in length, so nothing more is guessed). */
export const phoneText = (n: string | null | undefined) => (n ?? '').replace(/^(\+(?:49|43|41))(\d+)$/, '$1 $2');

export const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${Math.round(v)} %`);

/** Splits a free text of numbers ("+4930…, +49151…") into a list. */
export const splitList = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
