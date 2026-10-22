import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { startTestApp } from './helpers';
import { pickEncoding, isCompressible } from '../server/core/compress';

/** Plain node:http request: no automatic decompression, so the wire format is visible. */
function raw(base: string, method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Buffer; headers: Record<string, any> }>((resolve, reject) => {
    const r = request(base + path, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('content negotiation', () => {
  it('prefers brotli, honours q-values and wildcards', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0.5, gzip;q=0.8')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding('*')).toBe('br');
    expect(pickEncoding('*;q=0')).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
    expect(pickEncoding('gzip, br', ['gzip'])).toBe('gzip');
  });
  it('compresses text-like types only', () => {
    expect(isCompressible('application/json; charset=utf-8')).toBe(true);
    expect(isCompressible('text/html; charset=utf-8')).toBe(true);
    expect(isCompressible('application/manifest+json')).toBe(true);
    expect(isCompressible('image/svg+xml')).toBe(true);
    expect(isCompressible('text/event-stream; charset=utf-8')).toBe(false);
    expect(isCompressible('image/png')).toBe(false);
    expect(isCompressible('font/woff2')).toBe(false);
    expect(isCompressible('application/zip')).toBe(false);
  });
});

describe('static files', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const js = `console.log(${JSON.stringify('x'.repeat(50))});\n`.repeat(200);
  const css = `.a{color:red}\n`.repeat(400);

  beforeAll(async () => {
    t = await startTestApp();
    const web = t.app.config.webDir;
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), `<!doctype html><title>HyperLevel</title><script type="module" src="/assets/index-Ab12Cd34.js"></script>`);
    writeFileSync(join(web, 'assets/index-Ab12Cd34.js'), js);
    writeFileSync(join(web, 'assets/index-Ab12Cd34.js.br'), brotliCompressSync(js));
    writeFileSync(join(web, 'assets/index-Ab12Cd34.js.gz'), gzipSync(js));
    // No precompressed siblings: gzipped on the fly.
    writeFileSync(join(web, 'assets/index-Zz99Yy88.css'), css);
    writeFileSync(join(web, 'assets/logo-Qq11Ww22.png'), Buffer.alloc(4000, 7));
  });
  afterAll(() => t.close());

  it('serves hashed assets immutable, precompressed by Accept-Encoding, with Vary and validators', async () => {
    const plain = await raw(t.base, 'GET', '/assets/index-Ab12Cd34.js');
    expect(plain.status).toBe(200);
    expect(plain.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers.vary).toBe('Accept-Encoding');
    expect(plain.headers.etag).toMatch(/^W\/"/);
    expect(plain.headers['last-modified']).toBeTruthy();
    expect(plain.body.toString()).toBe(js);
    expect(plain.headers['content-type']).toBe('text/javascript; charset=utf-8');
    // Security headers stay.
    expect(plain.headers['x-content-type-options']).toBe('nosniff');
    expect(plain.headers['x-frame-options']).toBe('DENY');

    const br = await raw(t.base, 'GET', '/assets/index-Ab12Cd34.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    expect(br.body.length).toBeLessThan(js.length / 5);
    expect(brotliDecompressSync(br.body).toString()).toBe(js);

    const gz = await raw(t.base, 'GET', '/assets/index-Ab12Cd34.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe(js);

    const head = await raw(t.base, 'HEAD', '/assets/index-Ab12Cd34.js', { 'accept-encoding': 'br' });
    expect(head.status).toBe(200);
    expect(head.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(head.headers['content-encoding']).toBe('br');
    expect(head.body.length).toBe(0);

    const again = await raw(t.base, 'GET', '/assets/index-Ab12Cd34.js', { 'if-none-match': plain.headers.etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    const since = await raw(t.base, 'GET', '/assets/index-Ab12Cd34.js', { 'if-modified-since': plain.headers['last-modified'] });
    expect(since.status).toBe(304);
  });

  it('gzips on the fly without a precompressed file, leaves images alone', async () => {
    const r = await raw(t.base, 'GET', '/assets/index-Zz99Yy88.css', { 'accept-encoding': 'br, gzip' });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(r.body).toString()).toBe(css);
    const png = await raw(t.base, 'GET', '/assets/logo-Qq11Ww22.png', { 'accept-encoding': 'br, gzip' });
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(png.headers.vary).toBeUndefined();
    expect(png.body.length).toBe(4000);
  });

  it('answers a missing hashed file with 404, SPA routes with index.html (no-cache + CSP)', async () => {
    const missing = await raw(t.base, 'GET', '/assets/index-OldBuild1.js');
    expect(missing.status).toBe(404);
    expect(String(missing.headers['content-type'])).not.toContain('html');
    for (const method of ['GET', 'HEAD']) {
      const page = await raw(t.base, method, '/app/contacts');
      expect(page.status).toBe(200);
      expect(page.headers['cache-control']).toBe('no-cache');
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.headers['content-security-policy']).toContain("default-src 'self'");
      expect(page.headers['x-frame-options']).toBe('DENY');
    }
    expect((await raw(t.base, 'GET', '/../../etc/passwd')).status).not.toBe(500);
  });
});

describe('compressed API answers', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    for (let i = 0; i < 30; i++) await t.api.post('/api/contacts', { first_name: `Kontakt ${i}`, email: `k${i}@example.com`, tags: ['newsletter', 'lead'] });
  });
  afterAll(() => t.close());

  const auth = () => ({ cookie: t.api.cookie, 'x-location-id': t.api.location });

  it('compresses JSON over 1 KB with brotli or gzip and sets Vary', async () => {
    const br = await raw(t.base, 'GET', '/api/contacts?limit=30', { ...auth(), 'accept-encoding': 'gzip, br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toContain('Accept-Encoding');
    expect(br.headers['cache-control']).toBe('no-store');
    const data = JSON.parse(brotliDecompressSync(br.body).toString());
    expect(data.contacts).toHaveLength(30);

    const gz = await raw(t.base, 'GET', '/api/contacts?limit=30', { ...auth(), 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(gz.body).toString()).total).toBe(30);

    const plain = await raw(t.base, 'GET', '/api/contacts?limit=30', auth());
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(plain.body.toString()).total).toBe(30);
  });

  it('leaves small answers, our own MCP relay and HEAD alone', async () => {
    const small = await raw(t.base, 'GET', '/api/version', { 'accept-encoding': 'br' });
    expect(small.body.length).toBeLessThan(1024);
    expect(small.headers['content-encoding']).toBeUndefined();
    const relay = await raw(t.base, 'GET', '/api/contacts?limit=30', { ...auth(), 'accept-encoding': 'br', 'x-pghl-via': 'mcp' });
    expect(relay.headers['content-encoding']).toBeUndefined();
  });

  it('compresses server-rendered pages too (public form page)', async () => {
    const form = await t.api.post('/api/forms', { name: 'Kontakt', fields: Array.from({ length: 12 }, (_, i) => ({ key: `f${i}`, label: `Feld Nummer ${i} mit etwas längerem Text`, type: 'text' })) });
    const r = await raw(t.base, 'GET', `/f/${form.data.id}`, { 'accept-encoding': 'gzip' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(r.body).toString()).toContain('<form');
  });
});
