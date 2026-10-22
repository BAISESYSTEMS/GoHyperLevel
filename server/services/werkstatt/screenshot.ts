import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Automatic preview image of a plugin for the Marktplatz: a headless Chromium opens the plugin's signed demo
 * page (sample data only) and takes a screenshot. Off unless an admin turns it on with PGHL_PLUGIN_SCREENSHOTS=1
 * and PGHL_CHROMIUM=/path/to/chromium – the server then runs a browser on plugin code (inside the same sandbox
 * as for users, but a browser is a big program: on a server without a user namespace it needs
 * PGHL_CHROMIUM_NO_SANDBOX=1, which removes Chromium's own sandbox. Only enable that in a container you trust
 * to be disposable). Without it, authors upload screenshots by hand or use the live demo preview.
 */

export const screenshotsEnabled = () => process.env.PGHL_PLUGIN_SCREENSHOTS === '1' && !!chromiumPath();

export function chromiumPath(): string | null {
  const c = process.env.PGHL_CHROMIUM?.trim();
  return c && existsSync(c) ? c : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the signed preview page in a headless Chromium (driven through the DevTools protocol over Node's built-in
 * WebSocket – no new package), waits until the plugin has stopped changing its size (the host page stamps
 * `window.__ghSize` on every size message) and takes the picture. A plain `--screenshot` would be taken as soon as the
 * page has loaded, i.e. often while the plugin still says "Lade …".
 */
export async function captureScreenshot(url: string, o: { width?: number; height?: number } = {}): Promise<Buffer | null> {
  const bin = chromiumPath();
  const WS = (globalThis as { WebSocket?: new (url: string) => any }).WebSocket;
  if (!bin || !WS) return null;
  const w = o.width ?? 960;
  const h = o.height ?? 540;
  const dir = mkdtempSync(join(tmpdir(), 'gohigh-shot-'));
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, `--window-size=${w},${h}`, ...(process.env.PGHL_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank'];
  // Own process group: Chromium starts helper processes, all of them go when we are done.
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: dir }, detached: true });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  };
  const hard = setTimeout(kill, 60_000);
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let log = '';
      const t = setTimeout(() => reject(new Error('Chromium started no DevTools endpoint')), 15_000);
      child.stderr!.on('data', (d) => {
        log += String(d);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
        if (m) (clearTimeout(t), resolve(m[1]));
      });
      child.on('exit', () => reject(new Error('Chromium exited')));
      child.on('error', reject);
    });
    const ws = new WS(endpoint);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('DevTools connection failed'));
    });
    let seq = 0;
    const waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
    ws.onmessage = (e: { data: unknown }) => {
      const m = JSON.parse(String(e.data));
      if (m.id && waiting.has(m.id)) (waiting.get(m.id)!(m), waiting.delete(m.id));
    };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq;
        const t = setTimeout(() => (waiting.delete(id), reject(new Error(`${method}: timeout`))), 30_000);
        waiting.set(id, (m) => (clearTimeout(t), m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    // Ready = the plugin sent its first size and then stayed quiet for 800 ms (at most 20 s).
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      await sleep(250);
      const r = await send('Runtime.evaluate', { expression: 'window.__ghSize ? Date.now() - window.__ghSize.at : -1', returnByValue: true }, sessionId).catch(() => null);
      if (r && Number(r.result?.value) >= 800) break;
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    ws.close();
    return Buffer.from(String(shot.data), 'base64');
  } catch {
    return null;
  } finally {
    clearTimeout(hard);
    kill();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* the temp folder is cleaned up by the OS later */
    }
  }
}
