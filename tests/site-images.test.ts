import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FF } from './site-fixtures.js';
import { imageSize, pickFormat, srcsetFor, uploadFileOf, widthsFor } from '../server/services/site-images.js';

/** Image optimisation: sizes from file headers, the srcset ladder, the scaled-copy route with a fake engine. */

// --- hand-made headers ---------------------------------------------------------------------------------------------------

const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n: number) => Buffer.from([(n >>> 8) & 255, n & 255]);
const le16 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);
const png = (w: number, h: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0]), Buffer.alloc(8)]);
const gif = (w: number, h: number) => Buffer.concat([Buffer.from('GIF89a'), le16(w), le16(h), Buffer.alloc(16)]);
const jpeg = (w: number, h: number, orientation?: number) => {
  const exif = orientation
    ? Buffer.concat([Buffer.from([0xff, 0xe1]), u16(2 + 6 + 8 + 2 + 12 + 4), Buffer.from('Exif\0\0'), Buffer.from('MM'), u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), u32(0)])
    : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0]), u16(16), Buffer.from('JFIF\0'), Buffer.alloc(9), exif, Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(h), u16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(8)]);
};
const webpX = (w: number, h: number) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8X'), Buffer.alloc(4), Buffer.alloc(4), Buffer.from([(w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]), Buffer.alloc(4)]);
const webpL = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8L'), Buffer.alloc(4), Buffer.from([0x2f]), Buffer.from([bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]), Buffer.alloc(8)]);
};
const webpLossy = (w: number, h: number) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8 '), Buffer.alloc(4), Buffer.alloc(3), Buffer.from([0x9d, 0x01, 0x2a]), le16(w), le16(h), Buffer.alloc(4)]);

describe('image size from the header', () => {
  it('reads PNG, GIF, JPEG and the three WebP flavours', () => {
    expect(imageSize(png(1600, 900))).toEqual({ w: 1600, h: 900 });
    expect(imageSize(gif(320, 200))).toEqual({ w: 320, h: 200 });
    expect(imageSize(jpeg(4000, 3000))).toEqual({ w: 4000, h: 3000 });
    expect(imageSize(webpX(1200, 630))).toEqual({ w: 1200, h: 630 });
    expect(imageSize(webpL(800, 600))).toEqual({ w: 800, h: 600 });
    expect(imageSize(webpLossy(640, 480))).toEqual({ w: 640, h: 480 });
  });

  it('swaps width and height for a JPEG the camera held upright (EXIF 5–8)', () => {
    expect(imageSize(jpeg(4000, 3000, 1))).toEqual({ w: 4000, h: 3000 });
    expect(imageSize(jpeg(4000, 3000, 6))).toEqual({ w: 3000, h: 4000 });
    expect(imageSize(jpeg(4000, 3000, 8))).toEqual({ w: 3000, h: 4000 });
  });

  it('does not guess at damaged or foreign files', () => {
    expect(imageSize(Buffer.from('<html><body>hello world, not a picture</body></html>'))).toBeUndefined();
    expect(imageSize(png(0, 10))).toBeUndefined();
    expect(imageSize(png(70000, 10))).toBeUndefined();
    expect(imageSize(Buffer.alloc(10))).toBeUndefined();
    expect(imageSize(jpeg(10, 10).subarray(0, 20))).toBeUndefined();
  });
});

describe('srcset ladder', () => {
  it('lists the smaller copies and the original at its own width', () => {
    const s = srcsetFor('http://x.test/uploads/abcdefgh12345.jpg', { w: 1600, h: 900 })!;
    expect(s.split(', ')).toEqual([
      'http://x.test/uploads-opt/320/abcdefgh12345.jpg 320w',
      'http://x.test/uploads-opt/640/abcdefgh12345.jpg 640w',
      'http://x.test/uploads-opt/960/abcdefgh12345.jpg 960w',
      'http://x.test/uploads-opt/1280/abcdefgh12345.jpg 1280w',
      'http://x.test/uploads/abcdefgh12345.jpg 1600w',
    ]);
    expect(srcsetFor('/uploads/abcdefgh12345.png', { w: 700, h: 700 })).toBe('/uploads-opt/320/abcdefgh12345.png 320w, /uploads-opt/640/abcdefgh12345.png 640w, /uploads/abcdefgh12345.png 700w');
  });

  it('skips small pictures, animated GIFs and links that are no upload', () => {
    expect(widthsFor(300)).toEqual([]);
    expect(widthsFor(340)).toEqual([]);
    expect(widthsFor(361)).toEqual([320]);
    expect(srcsetFor('/uploads/abcdefgh12345.jpg', { w: 300, h: 300 })).toBeUndefined();
    expect(srcsetFor('/uploads/abcdefgh12345.gif', { w: 2000, h: 300 })).toBeUndefined();
    expect(srcsetFor('https://cdn.example.com/a.jpg', { w: 2000, h: 300 })).toBeUndefined();
    expect(srcsetFor('/uploads/abcdefgh12345.jpg', undefined)).toBeUndefined();
    expect(uploadFileOf('/uploads/../etc/passwd.png')).toBeUndefined();
    expect(uploadFileOf('/uploads/abcdefgh12345.jpg?x=1')).toBe('abcdefgh12345.jpg');
  });

  it('picks the newest format the browser accepts and the engine writes', () => {
    const both = { formats: ['webp', 'avif'] as ('webp' | 'avif')[] };
    expect(pickFormat('image/avif,image/webp,*/*', both, 'image/jpeg')).toBe('avif');
    expect(pickFormat('image/webp,*/*', both, 'image/jpeg')).toBe('webp');
    expect(pickFormat('image/avif,*/*', { formats: ['webp'] }, 'image/jpeg')).toBe('jpeg');
    expect(pickFormat('*/*', both, 'image/png')).toBe('png');
    expect(pickFormat('', both, 'image/webp')).toBe('webp');
  });
});

// --- through the app ---------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

const upload = async (buf: Buffer, mime: string, name = 'bild') => {
  const r = await t.api.post('/api/uploads', { name, data: `data:${mime};base64,${buf.toString('base64')}` });
  expect(r.status).toBe(200);
  return r.data as { file: string; url: string };
};
async function pageWith(blocks: any[]) {
  const f = (await t.api.post('/api/funnels', { name: 'Bild-Test', kind: 'website', template: 'blank' })).data;
  expect((await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks })).status).toBe(200);
  const r = await t.api.raw(`/p/${f.slug}`, { headers: FF });
  return r.text();
}
const imgs = (html: string) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

describe('images on pages', () => {
  it('gives every upload width and height, whatever the block says', async () => {
    const up = await upload(png(1600, 900), 'image/png');
    const html = await pageWith([{ type: 'image', src: up.url, alt: 'Team' }]);
    const tag = imgs(html).find((x) => x.includes(up.file))!;
    expect(tag).toContain('width="1600" height="900"');
    expect(tag).toContain('alt="Team"');
    expect(tag).not.toContain('srcset');
  });

  it('keeps sizes and srcset the editor stored, and lazy-loads below the first picture', async () => {
    const up = await upload(jpeg(1200, 800), 'image/jpeg');
    const set = `${up.url} 1200w, ${up.url} 600w`;
    const html = await pageWith([
      { type: 'hero', heading: 'Hallo', image: up.url, image_alt: 'Titel', image_w: 640, image_h: 360, image_srcset: set },
      { type: 'image', src: up.url, alt: 'Zwei' },
    ]);
    const tags = imgs(html).filter((x) => x.includes(up.file));
    expect(tags[0]).toContain('width="640" height="360"');
    expect(tags[0]).toContain('srcset=');
    expect(tags[0]).toContain('fetchpriority="high"');
    expect(tags[1]).toContain('loading="lazy"');
    expect(tags[1]).toContain('width="1200" height="800"');
  });

  it('serves the original when there is no engine', async () => {
    const up = await upload(png(1600, 900), 'image/png');
    const r = await t.api.raw(`/uploads-opt/640/${up.file}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`http://localhost/uploads/${up.file}`);
  });
});

describe('scaled copies with an engine', () => {
  const calls: { width: number; format: string }[] = [];
  beforeAll(() => {
    (t.app.services as any).imageEngine = {
      name: 'fake',
      formats: ['webp', 'avif'],
      async resize(_input: Buffer, o: { width: number; format: string }) {
        calls.push(o);
        return Buffer.from(`copy-${o.width}-${o.format}`);
      },
    };
  });
  afterAll(() => {
    delete (t.app.services as any).imageEngine;
  });

  it('writes a srcset into pages and serves the copies as WebP or AVIF, made once', async () => {
    const up = await upload(jpeg(1600, 900), 'image/jpeg');
    const html = await pageWith([{ type: 'image', src: up.url, alt: 'Groß' }]);
    const tag = imgs(html).find((x) => x.includes(up.file))!;
    expect(tag).toContain(`/uploads-opt/320/${up.file} 320w`);
    expect(tag).toContain(`/uploads-opt/1280/${up.file} 1280w`);
    expect(tag).toContain(`/uploads/${up.file} 1600w`);
    expect(tag).toMatch(/sizes="[^"]+"/);

    calls.length = 0;
    const a = await t.api.raw(`/uploads-opt/640/${up.file}`, { headers: { accept: 'image/webp,*/*' } });
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('image/webp');
    expect(a.headers.get('vary')).toBe('Accept');
    expect(a.headers.get('cache-control')).toContain('immutable');
    expect(await a.text()).toBe('copy-640-webp');
    const b = await t.api.raw(`/uploads-opt/640/${up.file}`, { headers: { accept: 'image/webp,*/*' } });
    expect(await b.text()).toBe('copy-640-webp');
    expect(calls).toHaveLength(1);

    const c = await t.api.raw(`/uploads-opt/640/${up.file}`, { headers: { accept: 'image/avif,image/webp,*/*' } });
    expect(c.headers.get('content-type')).toBe('image/avif');
    expect(await c.text()).toBe('copy-640-avif');
    const d = await t.api.raw(`/uploads-opt/640/${up.file}`, { headers: { accept: '*/*' } });
    expect(d.headers.get('content-type')).toBe('image/jpeg');
  });

  it('turns away widths off the ladder, unknown files and foreign types', async () => {
    const up = await upload(jpeg(1600, 900), 'image/jpeg');
    expect((await t.api.raw(`/uploads-opt/777/${up.file}`)).status).toBe(404);
    expect((await t.api.raw(`/uploads-opt/99999/${up.file}`)).status).toBe(404);
    expect((await t.api.raw(`/uploads-opt/640/doesnotexist1234.jpg`)).status).toBe(404);
    expect((await t.api.raw(`/uploads-opt/640/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    const doc = await upload(Buffer.from('%PDF-1.4\n%fake pdf body for the test\n'), 'application/pdf');
    expect((await t.api.raw(`/uploads-opt/640/${doc.file}`)).status).toBe(404);
  });

  it('sends the original for a picture no larger than the copy, and when the engine fails', async () => {
    const small = await upload(png(500, 300), 'image/png');
    const r = await t.api.raw(`/uploads-opt/640/${small.file}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(await pageWith([{ type: 'image', src: small.url, alt: 'Klein' }])).not.toContain('uploads-opt/640');

    const big = await upload(png(2000, 1000), 'image/png');
    const eng = (t.app.services as any).imageEngine;
    const ok = eng.resize;
    eng.resize = async () => {
      throw new Error('kaputt');
    };
    try {
      const bad = await t.api.raw(`/uploads-opt/320/${big.file}`, { redirect: 'manual' });
      expect(bad.status).toBe(302);
      expect(bad.headers.get('location')).toBe(`http://localhost/uploads/${big.file}`);
    } finally {
      eng.resize = ok;
    }
  });

  it('works on a custom domain too (the path is not rewritten into the site)', async () => {
    const up = await upload(png(1600, 900), 'image/png');
    const f = (await t.api.post('/api/funnels', { name: 'Domain-Bild', kind: 'website', template: 'blank' })).data;
    expect((await t.api.patch(`/api/funnels/${f.id}`, { domain: 'bilder.example.com' })).status).toBe(200);
    // the Host header takes effect: the site answers at the domain's root
    expect((await t.api.raw('/', { headers: { host: 'bilder.example.com', ...FF } })).status).toBe(200);
    const r = await t.api.raw(`/uploads-opt/320/${up.file}`, { headers: { host: 'bilder.example.com', accept: 'image/webp' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/webp');
  });
});
