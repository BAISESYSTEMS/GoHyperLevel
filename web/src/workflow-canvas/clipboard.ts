import { useSyncExternalStore } from 'react';
import { api } from '../api';
import { tr } from '../i18n';
import type { Step } from './model';

/**
 * The step clipboard of the workflow editors: localStorage of this browser, format `gohigh-steps`, so steps copied in one
 * workflow (or sub-account, or tab) can be pasted in another. Copying asks the server for the clean copy (secrets of HTTP steps
 * blanked, like an export); pasting asks it for new ids and the reference check of the import (modules/workflow-clipboard.ts).
 */

export const CLIP_KEY = 'pghl.wf-clipboard';
export const CLIP_FORMAT = 'gohigh-steps';
const EVENT = 'pghl:wf-clipboard';

export interface ClipData {
  format: typeof CLIP_FORMAT;
  version: number;
  steps: Step[];
  copied_at?: string;
  source?: { workflow_id?: string; workflow?: string; location_id?: string };
  references?: string[];
}

let cached: { raw: string | null; data: ClipData | null } = { raw: null, data: null };

export function readClip(): ClipData | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CLIP_KEY);
  } catch {
    return null;
  }
  if (raw === cached.raw) return cached.data;
  let data: ClipData | null = null;
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && v.format === CLIP_FORMAT && Array.isArray(v.steps) && v.steps.length) data = v;
  } catch {
    /* not ours */
  }
  cached = { raw, data };
  return data;
}

function writeClip(data: ClipData) {
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(data));
  } catch {
    const t = tr('wfcanvas');
    throw new Error(t('Die Zwischenablage ist voll oder gesperrt (Browser-Speicher).'));
  }
  window.dispatchEvent(new Event(EVENT));
}

const subscribe = (fn: () => void) => {
  const onStorage = (e: StorageEvent) => (e.key === null || e.key === CLIP_KEY) && fn();
  window.addEventListener('storage', onStorage);
  window.addEventListener(EVENT, fn);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(EVENT, fn);
  };
};

/** What is on the clipboard right now – updates when another tab copies, too. */
export const useClip = () => useSyncExternalStore(subscribe, readClip, () => null);

/** Copies steps of a workflow; returns how many steps (with their lanes) are on the clipboard. */
export async function copySteps(workflowId: string, steps: Step[]): Promise<number> {
  const data = await api.post<ClipData>(`/api/workflows/${workflowId}/copy`, { steps });
  writeClip(data);
  return countSteps(data.steps);
}

/** The clipboard's steps ready to insert into a workflow: new ids, plus warnings about references to check. */
export async function pasteSteps(workflowId: string, existingIds: string[]): Promise<{ steps: Step[]; warnings: string[] }> {
  const data = readClip();
  const t = tr('wfcanvas');
  if (!data) throw new Error(t('Die Zwischenablage ist leer.'));
  return api.post(`/api/workflows/${workflowId}/paste`, { data, existing_ids: existingIds });
}

export function countSteps(steps: Step[]): number {
  return (steps ?? []).reduce((n, s) => n + 1 + Object.keys(s).filter((k) => /^(then|else|each|b\d)$/.test(k) && Array.isArray(s[k])).reduce((m, k) => m + countSteps(s[k]), 0), 0);
}
