import { currentLocation } from '../api';

/**
 * Server-sent events over fetch (POST with JSON body, our CSRF and sub-account headers) – EventSource
 * can't POST. Works in browsers and the Android WebView; the reader stops when the run is done.
 */
export interface AgentEvent {
  type: string;
  [k: string]: any;
}

export async function streamPost(path: string, body: unknown, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const loc = currentLocation();
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pghl': '1', accept: 'text/event-stream', ...(loc ? { 'x-location-id': loc } : {}) },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  const type = r.headers.get('content-type') ?? '';
  if (!r.ok || !type.includes('event-stream') || !r.body) {
    const data = type.includes('json') ? await r.json().catch(() => null) : null;
    if (r.status === 401) window.dispatchEvent(new Event('pghl:logout'));
    throw new Error(data?.error || `Fehler ${r.status}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore broken lines */
      }
    }
  }
}

/** File → base64 (without the data: prefix) for /api/agent/files. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    r.readAsDataURL(file);
  });
}
