import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BRIDGE_JS } from '../server/services/office-bridge-js.js';

/**
 * The load/save bridge of the Office editors (server/services/office-bridge-js.ts) in a minimal fake browser: it catches the
 * editor's save download (the file's own kind or the editor's native format – a long extension like ".deckcraft"), lets every
 * other download through and announces it, binds every message to the channel and to window.parent, and presses the right save
 * shortcut. The real editors were checked end to end in Chromium (docs/office.md#wie-die-editoren-laden-und-speichern).
 */

function fakeBrowser(attrs: Record<string, string>) {
  const posted: { msg: any; target: string }[] = [];
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const dispatched: any[] = [];
  let n = 0;
  class Blob {
    size: number;
    constructor(public parts: Uint8Array[]) {
      this.size = parts.reduce((s, p) => s + p.length, 0);
    }
    arrayBuffer() {
      return Promise.resolve(Uint8Array.from(this.parts.flatMap((p) => [...p])).buffer);
    }
  }
  class HTMLElement {
    nativeClicks = 0;
    click() {
      this.nativeClicks++;
    }
  }
  class HTMLAnchorElement extends HTMLElement {
    attrs: Record<string, string> = {};
    getAttribute(k: string) {
      return k in this.attrs ? this.attrs[k] : null;
    }
  }
  class KeyboardEvent {
    constructor(
      public type: string,
      public init: any,
    ) {}
  }
  const canvas = { width: 300, focus() {}, dispatchEvent: (e: any) => void dispatched.push(e) };
  const parent = { postMessage: (msg: any, target: string) => void posted.push({ msg, target }) };
  const ctx: any = {
    Blob,
    HTMLElement,
    HTMLAnchorElement,
    KeyboardEvent,
    URL: { createObjectURL: () => `blob:null/${++n}`, revokeObjectURL: () => undefined },
    location: { hash: '#c=chan0123456789ab' },
    navigator: { platform: 'Linux x86_64', userAgent: 'test' },
    document: {
      currentScript: { getAttribute: (k: string) => attrs[k] ?? null },
      addEventListener: () => undefined,
      querySelector: (sel: string) => (sel === 'canvas' ? canvas : null),
    },
    addEventListener: (type: string, fn: (e: any) => void) => void (listeners[type] ??= []).push(fn),
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: (fn: () => void) => (fn(), 1),
    requestAnimationFrame: (fn: () => void) => fn(),
  };
  ctx.window = ctx;
  ctx.parent = parent;
  runInNewContext(BRIDGE_JS, ctx);
  const send = (data: any, source: any = parent) => listeners.message?.forEach((fn) => fn({ source, data }));
  return { ctx, posted, dispatched, listeners, send, parent };
}

const attrsFor = (kind: string, exts: string, save = 'plain') => ({ 'data-kind': kind, 'data-exts': exts, 'data-target': 'https://crm.example.com', 'data-max': '1000', 'data-save': save });

describe('office editor bridge', () => {
  it('keeps the editor’s own save (also a long native extension) and announces other downloads', async () => {
    const b = fakeBrowser(attrsFor('pptx', 'pptx,deckcraft'));
    const { ctx } = b;
    const save = (name: string) => {
      const url = ctx.URL.createObjectURL(new ctx.Blob([new Uint8Array([80, 75, 3, 4])]));
      const a = new ctx.HTMLAnchorElement();
      a.attrs = { href: url, download: name };
      a.click();
      return a;
    };
    const own = save('Pitch.deckcraft');
    const pptx = save('Pitch.pptx');
    const pdf = save('Pitch.pdf');
    await new Promise((r) => setTimeout(r, 0));
    expect(own.nativeClicks).toBe(0);
    expect(pptx.nativeClicks).toBe(0);
    expect(pdf.nativeClicks).toBe(1);
    const msgs = b.posted.map((p) => p.msg).filter((m) => m.type !== 'starting');
    expect(msgs.map((m) => [m.type, m.name, m.ext, m.size])).toEqual([
      ['saved', 'Pitch.deckcraft', 'deckcraft', 4],
      ['saved', 'Pitch.pptx', 'pptx', 4],
      ['exported', 'Pitch.pdf', 'pdf', 4],
    ]);
    for (const p of b.posted) {
      expect(p.target).toBe('https://crm.example.com');
      expect(p.msg).toMatchObject({ channel: 'chan0123456789ab', source: 'pghl-office' });
    }
  });

  it('leaves links without a remembered blob and blobs over the size limit alone', () => {
    const { ctx, posted } = fakeBrowser(attrsFor('docx', 'docx'));
    const big = ctx.URL.createObjectURL(new ctx.Blob([new Uint8Array(2000)]));
    const a = new ctx.HTMLAnchorElement();
    a.attrs = { href: big, download: 'Gross.docx' };
    a.click();
    const plainLink = new ctx.HTMLAnchorElement();
    plainLink.attrs = { href: 'https://example.com/x.docx', download: 'x.docx' };
    plainLink.click();
    expect([a.nativeClicks, plainLink.nativeClicks]).toEqual([1, 1]);
    expect(posted.filter((p) => p.msg.type === 'saved')).toEqual([]);
  });

  it('takes messages only from the parent window on its channel, and presses the editor’s save shortcut', () => {
    const b = fakeBrowser(attrsFor('xlsx', 'xlsx', 'shift'));
    b.send({ type: 'save', channel: 'falsch', source: 'pghl-office-host' });
    b.send({ type: 'save', channel: 'chan0123456789ab', source: 'pghl-office-host' }, { postMessage() {} });
    expect(b.dispatched).toEqual([]);
    b.send({ type: 'save', channel: 'chan0123456789ab', source: 'pghl-office-host' });
    expect(b.dispatched.map((e) => [e.type, e.init.key, e.init.ctrlKey, e.init.shiftKey])).toEqual([
      ['keydown', 'S', true, true],
      ['keyup', 'S', true, true],
    ]);
    const docx = fakeBrowser(attrsFor('docx', 'docx'));
    docx.send({ type: 'save', channel: 'chan0123456789ab', source: 'pghl-office-host' });
    expect(docx.dispatched[0].init).toMatchObject({ key: 's', ctrlKey: true, shiftKey: false });
  });
});
