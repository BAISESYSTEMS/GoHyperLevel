import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeNode, ROOT, boot } from './boot-fakes.js';

/**
 * The Android app asks the page whether the web app started (PageHealth.PROBE_JS in
 * android/…/ui/main/WebHealth.kt) and clears service workers with OFFLINE_RESET_JS. Both are JavaScript inside a Kotlin
 * file: here they run against the real boot guard, so the two sides cannot drift apart unnoticed (names of the flags,
 * the id of the fallback page, the fields of PageProbe).
 */

const KOTLIN = readFileSync(join(ROOT, 'android/app/src/main/java/org/gohigh/android/ui/main/WebHealth.kt'), 'utf8');

/** `const val NAME = "…" + "…"` → the string (the literals up to the next blank line). */
function kotlinConst(name: string): string {
  const from = KOTLIN.indexOf(`const val ${name} =`);
  expect(from, `${name} not found`).toBeGreaterThan(-1);
  const rest = KOTLIN.slice(from + `const val ${name} =`.length);
  const end = rest.search(/\n\s*\n/);
  const block = end < 0 ? rest : rest.slice(0, end);
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(["\\$])/g, '$1')).join('');
}

const PROBE = kotlinConst('PROBE_JS');
const RESET = kotlinConst('OFFLINE_RESET_JS');
/** The fields of `data class PageProbe` the Kotlin side reads. */
const FIELDS = ['root', 'children', 'text', 'mounted', 'guard', 'fallback', 'errors', 'ready', 'url'];

const probe = (t: { win: any }) => JSON.parse(JSON.stringify(vm.runInNewContext(PROBE, t.win)));

describe('Android probe – the script', () => {
  it('both scripts are valid JavaScript and are expressions (evaluateJavascript returns their value)', () => {
    expect(() => new vm.Script(PROBE)).not.toThrow();
    expect(() => new vm.Script(RESET)).not.toThrow();
    expect(PROBE.startsWith('(function(){')).toBe(true);
    expect(PROBE.endsWith('})()')).toBe(true);
  });

  it('every field of the Kotlin PageProbe is in the answer (and nothing else)', () => {
    const t = boot();
    expect(Object.keys(probe(t)).sort()).toEqual([...FIELDS].sort());
    // the data class declares exactly these
    const block = KOTLIN.slice(KOTLIN.indexOf('data class PageProbe('), KOTLIN.indexOf('enum class PageVerdict'));
    const declared = [...block.matchAll(/^\s+val (\w+):/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...FIELDS].sort());
  });
});

describe('Android probe – against the boot guard', () => {
  it('a page that did not start: empty root, guard there, errors listed', () => {
    const t = boot();
    t.emit('error', { message: 'Uncaught SyntaxError: Unexpected token', filename: 'https://crm.example.test/assets/index-1.js', lineno: 1, colno: 2, target: t.win });
    const p = probe(t);
    expect(p).toMatchObject({ root: true, children: 0, mounted: false, guard: true, fallback: false, ready: 'complete', url: '/app/contacts' });
    expect(p.errors).toEqual(['Uncaught SyntaxError: Unexpected token']);
  });

  it('the web fallback page is recognised as such (it has content, but it is the failure page)', () => {
    const t = boot();
    t.guard.check();
    const p = probe(t);
    expect(p.fallback).toBe(true);
    expect(p.children).toBeGreaterThan(0);
    expect(p.text).toBeGreaterThan(10);
  });

  it('a mounted app: content and the flag', () => {
    const t = boot();
    t.mountApp();
    expect(probe(t)).toMatchObject({ root: true, children: 1, mounted: true, guard: true, fallback: false });
  });

  it('after a late mount the fallback is gone again', () => {
    const t = boot();
    t.guard.check();
    t.root.childNodes = [];
    t.mountApp();
    expect(probe(t)).toMatchObject({ fallback: false, mounted: true });
  });

  it('an older web build without the guard: only the root counts (guard false, no errors)', () => {
    const t = boot({}, false);
    t.root.appendChild(new FakeNode('DIV'));
    expect(probe(t)).toMatchObject({ root: true, children: 1, guard: false, mounted: false, fallback: false, errors: [] });
  });

  it('a page that is not the web app (no #root)', () => {
    const t = boot({ withRoot: false });
    expect(probe(t)).toMatchObject({ root: false, children: 0 });
  });

  it('keeps only the last five error messages, short ones', () => {
    const t = boot();
    for (let i = 0; i < 12; i++) t.emit('error', { message: `fehler ${i} ${'x'.repeat(400)}`, target: t.win });
    const { errors } = probe(t);
    expect(errors).toHaveLength(5);
    expect(errors[4].startsWith('fehler 11')).toBe(true);
    expect(errors[4].length).toBeLessThanOrEqual(200);
  });
});

describe('Android probe – clearing offline data', () => {
  it('unregisters every service worker and deletes every cache of the page', async () => {
    const t = boot();
    const result = vm.runInNewContext(RESET, t.win);
    expect(typeof result.then).toBe('function');
    expect(await result).toBe('ok');
    expect(t.unregistered).toEqual(['reg', 'reg2']);
    expect(t.deletedCaches).toEqual(['pghl-shell-v1', 'pghl-api-v1']);
  });

  it('never throws on a page without service workers or caches', async () => {
    const t = boot();
    delete t.win.navigator.serviceWorker;
    delete t.win.caches;
    expect(await vm.runInNewContext(RESET, t.win)).toBe('ok');
  });
});
