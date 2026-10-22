import { ApiError, currentLocation } from '../api';

/**
 * Shared pieces of the Office area (pages/Office.tsx, OfficeFile.tsx, OfficeEditor.tsx): types of the server's answers and the raw
 * upload of file bytes (the JSON helper in api.ts cannot send binary). Server contract: docs/office.md.
 */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'pdf';
export const OFFICE_KINDS: OfficeKind[] = ['docx', 'xlsx', 'pptx', 'pdf'];
export const ACCEPT = '.docx,.xlsx,.pptx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf';
export const MIME: Record<OfficeKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

export interface OfficeLock {
  user_id: string | null;
  user_name: string;
  expires_at: string;
  mine?: boolean;
}

export interface OfficeFileRow {
  id: string;
  kind: OfficeKind;
  name: string;
  size: number;
  version: number;
  contact_id: string | null;
  deal_id: string | null;
  project_id: string | null;
  contact_name?: string | null;
  deal_name?: string | null;
  project_name?: string | null;
  created_by_name: string;
  updated_by_name: string;
  created_at: string;
  updated_at: string;
  open_comments?: number;
  lock: OfficeLock | null;
}

export interface OfficeVersion {
  id: string;
  version: number;
  size: number;
  author_name: string;
  author_kind: 'user' | 'agent' | 'bot';
  message: string;
  restored_from: number | null;
  created_at: string;
}

export interface OfficeDetail extends OfficeFileRow {
  versions: OfficeVersion[];
  editor_file_url: string | null;
}

export interface OfficeStatus {
  editors: Record<OfficeKind, boolean>;
  engines: Record<OfficeKind, boolean>;
  sandbox: 'strict' | 'same-origin';
  lock_ttl_ms: number;
  lock_renew_ms: number;
  limits: { max_bytes: number; quota_bytes: number | null; used_bytes: number };
}

export interface OfficeComment {
  id: string;
  version: number | null;
  parent_id: string | null;
  body: string;
  author_id: string | null;
  author_name: string;
  resolved_at: string | null;
  created_at: string;
}

/** Sends file bytes as the raw body (the editor's save, the upload button). Throws ApiError with the server's answer. */
export async function postBytes<T = any>(path: string, bytes: ArrayBuffer | Blob, query: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(`${path}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'x-pghl': '1', 'content-type': 'application/octet-stream', ...(currentLocation() ? { 'x-location-id': currentLocation() } : {}) },
    body: bytes,
    credentials: 'same-origin',
  });
  const data = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, data?.error || `Fehler ${r.status}`, data); // i18n-ignore (server text)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pghl:saved', { detail: { method: 'POST', path } }));
  return data as T;
}

/** The bytes of a file version (for the editor bridge). */
export async function fetchBytes(fileId: string, version?: number): Promise<ArrayBuffer> {
  const r = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/raw${version ? `?version=${version}` : ''}`, { headers: { 'x-location-id': currentLocation() }, credentials: 'same-origin' });
  if (!r.ok) throw new ApiError(r.status, `Fehler ${r.status}`); // i18n-ignore (server text)
  return r.arrayBuffer();
}

export const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const randomChannel = () => {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
};
