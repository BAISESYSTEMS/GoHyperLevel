import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, SOURCE, boot } from './boot-fakes.js';
import { startTestApp } from './helpers.js';

/**
 * web/public/boot-guard.js – the page that must never stay blank without a word. The shipped file runs here
 * against a small fake DOM (no jsdom in this project): error buffering, the 10 s check, the plain fallback page
 * with its buttons, the automatic report and the one-time self-repair when a service worker controls a blank page.
 */

const bodyOf = (call: { init: any }) => JSON.parse(call.init.body);

describe('boot guard – the file', () => {
  it('is plain ES5: it must run on a WebView too old for the app bundle', () => {
    expect(() => transformSync(SOURCE, { target: 'es5', logLevel: 'silent' })).not.toThrow();
  });

  it('is the first script of index.html (before the theme script) and is not a module', () => {
    const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts[0]).toBe('<script src="/boot-guard.js">');
    expect(scripts[1]).toBe('<script src="/theme-boot.js">');
  });

  it('is cached by the service worker only as a network-first file, never as a hashed asset', () => {
    const sw = readFileSync(join(ROOT, 'web/public/sw.js'), 'utf8');
    expect(sw).toMatch(/BOOT = \[[^\]]*'\/boot-guard\.js'/);
  });
});

describe('boot guard – buffering', () => {
  it('buffers errors, rejections, failed scripts and CSP violations (newest last, at most 20)', () => {
    const t = boot();
    t.emit('error', { message: 'Uncaught SyntaxError: Unexpected token', filename: 'https://crm.example.test/assets/index-1.js', lineno: 3, colno: 9, error: undefined, target: t.win });
    t.emit('error', { target: { tagName: 'SCRIPT', src: 'https://crm.example.test/assets/app-2.js' } });
    t.emit('error', { target: { tagName: 'IMG', src: 'https://crm.example.test/logo.png' } }); // images are noise
    t.emit('unhandledrejection', { reason: new Error('boom') });
    t.emitDoc('securitypolicyviolation', { violatedDirective: 'script-src', blockedURI: 'inline' });
    const e = t.guard.errors;
    expect(e.map((x: any) => x.kind)).toEqual(['error', 'resource', 'rejection', 'csp']);
    expect(e[0]).toMatchObject({ message: 'Uncaught SyntaxError: Unexpected token', line: 3, col: 9 });
    expect(e[1].message).toBe('Datei nicht geladen: /assets/app-2.js');
    expect(e[1].source).toBe('https://crm.example.test/assets/app-2.js');
    expect(e[2].message).toBe('Error: boom');
    for (let i = 0; i < 40; i++) t.emit('error', { message: `fehler ${i}`, target: t.win });
    expect(t.guard.errors).toHaveLength(20);
    expect(t.guard.errors.at(-1).message).toBe('fehler 39');
  });

  it('keeps error messages short', () => {
    const t = boot();
    t.emit('error', { message: 'x'.repeat(5000), target: t.win });
    expect(t.guard.errors[0].message.length).toBe(300);
  });
});

describe('boot guard – the 10 s check', () => {
  it('schedules itself for 10 seconds', () => {
    const t = boot();
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0].ms).toBe(10_000);
  });

  it('does nothing when the app mounted: no fallback, no report', () => {
    const t = boot();
    t.mountApp();
    expect(t.guard.check()).toBe(false);
    expect(t.fallback()).toBeNull();
    expect(t.fetchCalls).toHaveLength(0);
  });

  it('shows the fallback page when the app did not start, with the error text and both buttons', () => {
    const t = boot();
    t.emit('error', { message: 'Uncaught SyntaxError: Unexpected token', filename: 'https://crm.example.test/assets/index-1.js', lineno: 3, colno: 9, target: t.win });
    expect(t.guard.check()).toBe(true);
    const page = t.fallback()!;
    expect(page).not.toBeNull();
    const text = page.textContent;
    expect(text).toContain('Die App konnte nicht starten');
    expect(text).toContain('Uncaught SyntaxError: Unexpected token (/assets/index-1.js:3)');
    t.guard.errors.length = 0;
    t.emit('error', { target: { tagName: 'SCRIPT', src: 'https://crm.example.test/assets/index-9.js' } });
    expect(t.guard.text(3)).toBe('Datei nicht geladen: /assets/index-9.js');
    expect(text).toContain('Neu laden');
    expect(text).toContain('Offline-Daten löschen');
    expect(page.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Neu laden')).not.toBeNull();
    expect(t.guard.isShown()).toBe(true);
    expect(t.guard.mounted()).toBe(false);
  });

  it('keeps the fallback page inside the safe areas of an iPhone/iPad (notch, home indicator) and above the minimum 44 px target', () => {
    const t = boot();
    t.emit('error', { message: 'x', target: t.win });
    t.guard.check();
    const page = t.fallback()!;
    const style = String(page.getAttribute('style'));
    expect(style).toContain('env(safe-area-inset-top)');
    expect(style).toContain('env(safe-area-inset-bottom)');
    // the older padding stays in front for engines that do not know max()/env()
    expect(style.indexOf('padding:32px 20px')).toBeLessThan(style.indexOf('padding:max('));
    expect(readFileSync(join(ROOT, 'web/public/boot-guard.js'), 'utf8')).toContain('min-height:44px');
  });

  it('says so when there is no error message at all', () => {
    const t = boot();
    t.guard.check();
    expect(t.fallback()!.textContent).toContain('Keine Fehlermeldung');
  });

  it('Neu laden reloads the page', () => {
    const t = boot();
    t.guard.check();
    t.fallback()!.find((n) => n.textContent === 'Neu laden')!.click();
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('Offline-Daten löschen unregisters service workers, deletes all caches, then reloads', async () => {
    const t = boot();
    t.guard.check();
    t.fallback()!.find((n) => n.textContent === 'Offline-Daten löschen')!.click();
    await t.flush();
    expect(t.unregistered).toEqual(['reg', 'reg2']);
    expect(t.deletedCaches).toEqual(['pghl-shell-v1', 'pghl-api-v1']);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('does not touch a page without #root (not the app shell)', () => {
    const t = boot({ withRoot: false });
    expect(t.guard.check()).toBe(false);
    expect(t.fetchCalls).toHaveLength(0);
  });

  it('waits up to 30 s for a slow download without errors, but not when something already failed', () => {
    const slow = boot({ readyState: 'interactive' });
    expect(slow.guard.check()).toBe(false);
    expect(slow.fallback()).toBeNull();
    expect(slow.timers.at(-1)!.ms).toBe(5000);
    slow.guard.started -= 31_000;
    expect(slow.guard.check()).toBe(true);
    expect(slow.fallback()).not.toBeNull();

    const failed = boot({ readyState: 'interactive' });
    failed.emit('error', { target: { tagName: 'SCRIPT', src: '/assets/index-1.js' } });
    expect(failed.guard.check()).toBe(true);
  });

  it('a late mount replaces the fallback and counts as started', () => {
    const t = boot();
    t.guard.check();
    expect(t.guard.mounted()).toBe(false);
    // React's first render clears the container, then the flag is set.
    t.root.childNodes = [];
    t.mountApp();
    expect(t.guard.isShown()).toBe(false);
    expect(t.guard.mounted()).toBe(true);
  });

  it('a mounted flag with an empty #root (the tree was unmounted) is not "started"', () => {
    const t = boot();
    t.win.__pghlMounted = true;
    expect(t.guard.mounted()).toBe(false);
    expect(t.guard.check()).toBe(true);
  });
});

describe('boot guard – report', () => {
  it('posts the buffered errors once to the automatic error capture, same origin, with the CSRF header', () => {
    const t = boot();
    t.emit('error', { message: 'Uncaught SyntaxError: Unexpected token', filename: 'https://crm.example.test/assets/index-1.js', lineno: 3, colno: 9, target: t.win });
    t.emit('unhandledrejection', { reason: new TypeError('x is not a function') });
    t.guard.check();
    t.guard.check(); // a second look does not send a second report
    expect(t.fetchCalls).toHaveLength(1);
    const call = t.fetchCalls[0];
    expect(call.url).toBe('/api/feedback/client-errors');
    expect(call.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'x-pghl': '1', 'content-type': 'application/json' } });
    const body = bodyOf(call);
    expect(body.errors).toHaveLength(3);
    expect(body.errors[0].message).toBe('App-Start fehlgeschlagen (nicht gestartet nach 10 s): Uncaught SyntaxError: Unexpected token');
    expect(body.errors[0].stack).toContain('Geladene /assets/-Dateien: 1');
    expect(body.errors[1]).toMatchObject({ message: 'Uncaught SyntaxError: Unexpected token', line: 3, col: 9 });
    expect(body.diagnostics).toMatchObject({ route: '/app/contacts', build: 'Ab12Cd34', online: true });
    expect(body.diagnostics.user_agent).toContain('Chrome/74');
  });

  it('sends at most five errors (the server takes five)', () => {
    const t = boot();
    for (let i = 0; i < 12; i++) t.emit('error', { message: `fehler ${i}`, target: t.win });
    t.guard.check();
    expect(bodyOf(t.fetchCalls[0]).errors).toHaveLength(5);
  });

  it('does not report again within ten minutes on the same device', () => {
    const t = boot({ storage: { 'pghl.bootreport': String(Date.now() - 60_000) } });
    t.guard.check();
    expect(t.fallback()).not.toBeNull();
    expect(t.fetchCalls).toHaveLength(0);
    const later = boot({ storage: { 'pghl.bootreport': String(Date.now() - 11 * 60_000) } });
    later.guard.check();
    expect(later.fetchCalls).toHaveLength(1);
  });

  it('a failing report never breaks the fallback page', () => {
    const t = boot();
    t.win.fetch = () => {
      throw new Error('offline');
    };
    expect(() => t.guard.check()).not.toThrow();
    expect(t.fallback()).not.toBeNull();
  });

  it('the app can add its own error (render error) and report with it as the headline', () => {
    const t = boot();
    t.guard.add('render', 'TypeError: Cannot read properties of undefined', '', 0, 0, 'at Sidebar');
    t.guard.report('Darstellungsfehler', 'TypeError: Cannot read properties of undefined');
    expect(bodyOf(t.fetchCalls[0]).errors[0].message).toBe('App-Start fehlgeschlagen (Darstellungsfehler): TypeError: Cannot read properties of undefined');
  });
});

describe('boot guard – one-time self-repair', () => {
  it('clears a controlling service worker and its caches and reloads, before showing anything', async () => {
    const t = boot({ controller: true });
    expect(t.guard.check()).toBe(true);
    await t.flush();
    expect(t.unregistered).toEqual(['reg', 'reg2']);
    expect(t.deletedCaches).toEqual(['pghl-shell-v1', 'pghl-api-v1']);
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.fallback()).toBeNull();
    expect(t.store['pghl.bootheal']).toBeTruthy();
  });

  it('only once per ten minutes: the next failure shows the fallback instead of looping', async () => {
    const t = boot({ controller: true, storage: { 'pghl.bootheal': String(Date.now() - 2 * 60_000) } });
    expect(t.guard.check()).toBe(true);
    await t.flush();
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.fallback()).not.toBeNull();
  });

  it('is not tried without a service worker (reloading would change nothing)', () => {
    const t = boot({ controller: false });
    t.guard.check();
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.fallback()).not.toBeNull();
  });
});

describe('boot guard – with the real server', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    const web = t.app.config.webDir;
    mkdirSync(web, { recursive: true });
    copyFileSync(join(ROOT, 'web/public/boot-guard.js'), join(web, 'boot-guard.js'));
  });
  afterAll(() => t.close());

  it('is served as a script that revalidates every time (a fixed guard reaches the app on the next start)', async () => {
    const r = await t.api.raw('/boot-guard.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(await r.text()).toBe(SOURCE);
  });

  it('the page it builds is accepted by the automatic error capture: one grouped [Browser] ticket, a second start joins it', async () => {
    t.app.services.feedbackCaptureReset();
    const send = async () => {
      const g = boot();
      g.emit('error', { message: 'Uncaught SyntaxError: Unexpected token', filename: 'https://crm.example.test/assets/index-1.js', lineno: 3, colno: 9, target: g.win });
      g.guard.check();
      return t.api.post(g.fetchCalls[0].url, bodyOf(g.fetchCalls[0]));
    };
    const first = await send();
    expect(first.status).toBe(200);
    expect(first.data.results.map((r: any) => r.created ?? r.skipped)).toEqual([true, true]);
    const again = await send();
    expect(again.data.results.map((r: any) => r.created)).toEqual([false, false]);
    const items = (await t.api.get('/api/feedback/admin/items?kind=auto')).data;
    const ticket = items.find((i: any) => /App-Start fehlgeschlagen/.test(i.title));
    expect(ticket).toMatchObject({ platform: 'web', occurrences: 2 });
    expect(ticket.title).toMatch(/^\[Browser\] App-Start fehlgeschlagen/);
  });

  it('needs a login: a signed-out device sends nothing the server would keep (no anonymous reports)', async () => {
    const g = boot();
    g.guard.check();
    t.api.clearCookie();
    const r = await t.api.post(g.fetchCalls[0].url, bodyOf(g.fetchCalls[0]));
    expect(r.status).toBe(401);
  });
});
