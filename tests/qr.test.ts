import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { contrastOnWhite, qrColorOk, qrDownloadName, qrLinkOk, qrUrl } from '../web/src/qr.js';
import { qrFileName } from '../server/modules/qr.js';

/** QR codes for share links: the route (PNG/SVG, download, limits), the helpers and where the button sits. */

let t: Awaited<ReturnType<typeof startTestApp>>;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const png = async (qs: string) => {
  const r = await t.api.raw(`/api/qr?${qs}`, { headers: { cookie: t.api.cookie } });
  return { status: r.status, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) };
};
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe('GET /api/qr', () => {
  it('draws a PNG by default', async () => {
    const r = await png(q({ url: 'https://example.com/book/beratung' }));
    expect(r.status).toBe(200);
    expect(r.type).toBe('image/png');
    expect([...r.buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(r.disposition).toBeNull();
    // width in the IHDR chunk follows the requested size (to the next full pixel per module)
    const small = await png(q({ url: 'https://example.com/book/beratung', size: '200' }));
    const big = await png(q({ url: 'https://example.com/book/beratung', size: '1000' }));
    expect(big.buf.readUInt32BE(16)).toBeGreaterThan(small.buf.readUInt32BE(16));
    expect(big.buf.readUInt32BE(16)).toBeLessThanOrEqual(1000);
  });

  it('draws an SVG with the chosen colours, and the code differs per link', async () => {
    const a = await png(q({ url: 'https://example.com/a', format: 'svg', fg: '#1d4ed8', bg: '#fefefe' }));
    expect(a.type).toContain('image/svg+xml');
    const svg = a.buf.toString('utf8');
    expect(svg).toContain('<svg');
    expect(svg.toLowerCase()).toContain('#1d4ed8');
    expect(svg.toLowerCase()).toContain('#fefefe');
    const b = (await png(q({ url: 'https://example.com/b', format: 'svg', fg: '#1d4ed8', bg: '#fefefe' }))).buf.toString('utf8');
    expect(b).not.toBe(svg);
  });

  it('turns the answer into a download with a safe file name', async () => {
    const r = await png(q({ url: 'https://example.com/x', download: '1', name: 'Beratung Erstgespräch/../x' }));
    expect(r.disposition).toBe('attachment; filename="Beratung-Erstgespraech-x.png"');
    const s = await png(q({ url: 'https://example.com/x', format: 'svg', download: '1', name: '' }));
    expect(s.disposition).toBe('attachment; filename="qr-code.svg"');
  });

  it('completes a path with the base URL (the code of a relative link points at this server)', async () => {
    const rel = await png(q({ url: '/book/beratung', format: 'svg' }));
    const abs = await png(q({ url: `${t.app.baseUrl()}/book/beratung`, format: 'svg' }));
    expect(rel.status).toBe(200);
    expect(rel.buf.toString()).toBe(abs.buf.toString());
  });

  it('only encodes http(s) links and checks every option', async () => {
    const bad = async (o: Record<string, string>, msg: RegExp) => {
      const r = await t.api.get(`/api/qr?${q(o)}`);
      expect(r.status, JSON.stringify(o)).toBe(400);
      expect(r.data.error, JSON.stringify(o)).toMatch(msg);
    };
    await bad({}, /Link fehlt/);
    await bad({ url: 'javascript:alert(1)' }, /http/);
    await bad({ url: 'data:text/html,<script>' }, /http/);
    await bad({ url: 'WIFI:S:x;P:y;;' }, /http/);
    await bad({ url: '//evil.example/x' }, /http/);
    await bad({ url: 'https://exa mple.com' }, /http/);
    await bad({ url: `https://example.com/${'a'.repeat(2100)}` }, /zu lang/);
    await bad({ url: 'https://example.com', format: 'gif' }, /Format/);
    await bad({ url: 'https://example.com', size: '50' }, /Größe/);
    await bad({ url: 'https://example.com', size: '9999' }, /Größe/);
    await bad({ url: 'https://example.com', size: 'abc' }, /Größe/);
    await bad({ url: 'https://example.com', margin: '20' }, /Rand/);
    await bad({ url: 'https://example.com', ec: 'X' }, /Fehlerkorrektur/);
    await bad({ url: 'https://example.com', fg: 'red' }, /Farben/);
    await bad({ url: 'https://example.com', bg: '#12345' }, /Farben/);
  });

  it('is for signed-in users only', async () => {
    const r = await t.api.raw(`/api/qr?${q({ url: 'https://example.com' })}`);
    expect(r.status).toBe(401);
  });

  it('works for a member without any extra area, in any sub-account', async () => {
    await t.api.post('/api/users', { email: 'mitglied@example.com', password: 'passwort-m1', name: 'Mitglied', locations: [t.api.location], permissions: ['contacts'] });
    const login = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email: 'mitglied@example.com', password: 'passwort-m1' }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const r = await t.api.raw(`/api/qr?${q({ url: 'https://example.com/book/x' })}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
  });
});

describe('helpers of the button', () => {
  it('builds the address of the code', () => {
    expect(qrUrl('https://example.com/a?b=1&c=2')).toBe('/api/qr?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&format=png&size=512');
    expect(qrUrl('/book/x', { format: 'svg', size: 256, fg: '#000000', ec: 'H', download: 'qr-x' })).toBe('/api/qr?url=%2Fbook%2Fx&format=svg&size=256&fg=%23000000&ec=H&download=1&name=qr-x');
    expect(qrUrl('/x', { ec: 'M' })).not.toContain('ec=');
  });

  it('makes file names from titles (client and server agree on safe characters)', () => {
    expect(qrDownloadName('Buchungsseite Erstgespräch Süß')).toBe('qr-Buchungsseite-Erstgespraech-Suess');
    expect(qrDownloadName('???')).toBe('qr-code');
    expect(qrFileName('Kauf-Link: Online Kurs (neu)')).toBe('Kauf-Link-Online-Kurs-neu');
    expect(qrFileName('a'.repeat(100)).length).toBe(60);
    expect(qrFileName(undefined)).toBe('qr-code');
  });

  it('warns about colours that scan badly', () => {
    expect(contrastOnWhite('#000000')).toBeGreaterThan(20);
    expect(contrastOnWhite('#ffffff')).toBeCloseTo(1, 1);
    expect(qrColorOk('#111827')).toBe(true);
    expect(qrColorOk('#1d4ed8')).toBe(true);
    expect(qrColorOk('#facc15')).toBe(false);
    expect(qrColorOk('nonsense')).toBe(false);
  });

  it('accepts complete links and paths of this server only', () => {
    expect(qrLinkOk('https://example.com/x')).toBe(true);
    expect(qrLinkOk('/book/x')).toBe(true);
    expect(qrLinkOk('//evil.example')).toBe(false);
    expect(qrLinkOk('javascript:alert(1)')).toBe(false);
    expect(qrLinkOk('')).toBe(false);
  });
});

describe('where the button is', () => {
  it('sits next to the booking, review, buy, funnel, trigger and routing links', () => {
    const spots: [string, RegExp][] = [
      ['web/src/pages/Calendars.tsx', /<ShareLink url=\{c\.url\}/],
      ['web/src/pages/GoogleReviews.tsx', /<ShareLink url=\{s\.write_review_url\}/],
      ['web/src/pages/Settings.tsx', /<QrButton url=\{s\.public_url\}/],
      ['web/src/pages/Stripe.tsx', /<QrButton url=\{l\.url\}/],
      ['web/src/pages/Funnels.tsx', /<QrButton url=\{page\.url\}/],
      ['web/src/pages/Campaigns.tsx', /<ShareLink url=\{l\.short_url\}/],
      ['web/src/pages/TeamCalendarEditor.tsx', /<ShareLink url=\{r\.url\}/],
    ];
    for (const [file, re] of spots) expect(read(file), file).toMatch(re);
  });

  it('uses the shared dialog (top-right ✕, Esc) and a print sheet that only shows when printing', () => {
    const src = read('web/src/QrCode.tsx');
    expect(src).toContain('<Modal');
    expect(src).not.toContain('modal-bg');
    const css = read('web/src/pages/quickwins.css');
    expect(css).toMatch(/\.qr-sheet \{ display: none; \}/);
    expect(css).toMatch(/@media print[\s\S]*body\.qr-printing > \*:not\(\.qr-sheet\) \{ display: none !important; \}/);
    let depth = 0;
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
      depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
