import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * A small S3 client for the off-site backups – just what they need (put, get, list, delete, multipart for big files), signed
 * with AWS Signature V4 by hand, over node:http(s) so the upload streams from disk with an exact Content-Length. Works with any
 * S3-compatible storage: Hetzner Object Storage, Backblaze B2, Hostinger, Cloudflare R2, Wasabi, MinIO, AWS.
 */

export interface S3Config {
  /** https://fsn1.your-objectstorage.com, https://s3.eu-central-003.backblazeb2.com, http://127.0.0.1:9000 (MinIO) … */
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** true: https://endpoint/bucket/key (default, works everywhere); false: https://bucket.endpoint/key. */
  pathStyle: boolean;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

const EMPTY_SHA = createHash('sha256').update('').digest('hex');
/** Files above this go up in parts (single PUTs are limited to 5 GB, and a failed part is cheaper to repeat). */
export const MULTIPART_THRESHOLD = 512 * 1024 * 1024;
const PART_SIZE = 64 * 1024 * 1024;

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
/** RFC 3986 encoding as SigV4 wants it (everything but unreserved characters). */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a request (SigV4, service s3). All given headers are signed; `host`, `x-amz-date` and `x-amz-content-sha256` are added.
 * Pure – exported for the test against AWS's published example.
 */
export function signRequest(o: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; accessKey: string; secretKey: string; region: string; date: Date }): Record<string, string> {
  const amzDate = o.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = o.url.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = o.payloadHash;
  const names = Object.keys(headers).sort();
  const path = o.url.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/') || '/';
  const query = [...o.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [o.method, path, query, names.map((n) => `${n}:${headers[n]}`).join('\n') + '\n', names.join(';'), o.payloadHash].join('\n');
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretKey}`, day), o.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return headers;
}

const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlText(m[1]) : '';
};

export class S3Client {
  constructor(readonly cfg: S3Config) {}

  url(key: string, query: Record<string, string> = {}): URL {
    const base = new URL(this.cfg.endpoint.replace(/\/$/, ''));
    const path = key.split('/').map(uriEncode).join('/');
    const u = this.cfg.pathStyle ? new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/${this.cfg.bucket}${key ? `/${path}` : ''}`) : new URL(`${base.protocol}//${this.cfg.bucket}.${base.host}/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private send(method: string, url: URL, o: { headers?: Record<string, string>; body?: Buffer | (() => Readable); length?: number; payloadHash?: string } = {}): Promise<IncomingMessage> {
    const payloadHash = o.payloadHash ?? (Buffer.isBuffer(o.body) ? sha(o.body) : EMPTY_SHA);
    const extra: Record<string, string> = { ...(o.headers ?? {}) };
    const length = Buffer.isBuffer(o.body) ? o.body.length : o.length;
    if (length !== undefined) extra['content-length'] = String(length);
    const headers = signRequest({ method, url, headers: extra, payloadHash, accessKey: this.cfg.accessKey, secretKey: this.cfg.secretKey, region: this.cfg.region, date: new Date() });
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, timeout: 300_000 });
    return new Promise<IncomingMessage>((resolve, reject) => {
      req.once('response', resolve);
      req.once('error', reject);
      req.once('timeout', () => req.destroy(new Error(`S3: keine Antwort von ${url.host}`)));
      if (typeof o.body === 'function') {
        const src = o.body();
        src.once('error', (e) => req.destroy(e));
        src.pipe(req);
      } else req.end(o.body);
    });
  }

  private async ok(res: IncomingMessage, what: string): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if ((res.statusCode ?? 0) >= 300) {
      const code = tag(body, 'Code');
      const msg = tag(body, 'Message');
      throw new Error(`S3 ${what}: HTTP ${res.statusCode}${code ? ` ${code}` : ''}${msg ? ` – ${msg}` : ''}`);
    }
    return body;
  }

  async putBuffer(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await this.ok(await this.send('PUT', this.url(key), { body, headers: { 'content-type': contentType } }), `PUT ${key}`);
  }

  /** Uploads a file whose SHA-256 is known (the encryption computed it while writing); big files go up in parts. */
  async putFile(key: string, file: string, size: number, sha256: string): Promise<void> {
    if (size > MULTIPART_THRESHOLD) return this.putMultipart(key, file, size);
    const res = await this.send('PUT', this.url(key), { body: () => createReadStream(file), length: size, payloadHash: sha256, headers: { 'content-type': 'application/octet-stream' } });
    await this.ok(res, `PUT ${key}`);
  }

  private async putMultipart(key: string, file: string, size: number): Promise<void> {
    const init = await this.ok(await this.send('POST', this.url(key, { uploads: '' })), `Upload starten ${key}`);
    const uploadId = tag(init, 'UploadId');
    if (!uploadId) throw new Error('S3: keine UploadId erhalten');
    const parts: { n: number; etag: string }[] = [];
    const fh = await open(file, 'r');
    try {
      for (let n = 1, pos = 0; pos < size; n++, pos += PART_SIZE) {
        const buf = Buffer.alloc(Math.min(PART_SIZE, size - pos));
        await fh.read(buf, 0, buf.length, pos);
        const res = await this.send('PUT', this.url(key, { partNumber: String(n), uploadId }), { body: buf });
        await this.ok(res, `Teil ${n} von ${key}`);
        parts.push({ n, etag: String(res.headers.etag ?? '') });
      }
      const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const done = await this.ok(await this.send('POST', this.url(key, { uploadId }), { body: Buffer.from(xml), headers: { 'content-type': 'application/xml' } }), `Upload abschließen ${key}`);
      if (/<Error>/.test(done)) throw new Error(`S3 Upload abschließen ${key}: ${tag(done, 'Message') || tag(done, 'Code')}`);
    } catch (e) {
      await this.send('DELETE', this.url(key, { uploadId })).then((r) => r.resume()).catch(() => undefined);
      throw e;
    } finally {
      await fh.close();
    }
  }

  async getToFile(key: string, file: string): Promise<void> {
    const res = await this.send('GET', this.url(key));
    if ((res.statusCode ?? 0) >= 300) {
      await this.ok(res, `GET ${key}`);
      return;
    }
    try {
      await pipeline(res, createWriteStream(file, { mode: 0o600 }));
    } catch (e) {
      rmSync(file, { force: true });
      throw e;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.send('GET', this.url(key));
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    if ((res.statusCode ?? 0) >= 300) throw new Error(`S3 GET ${key}: HTTP ${res.statusCode} ${tag(Buffer.concat(chunks).toString('utf8'), 'Code')}`.trim());
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', this.url(key));
    // 404 on delete: already gone, which is what we wanted.
    if (res.statusCode === 404) return void res.resume();
    await this.ok(res, `DELETE ${key}`);
  }

  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token = '';
    for (let page = 0; page < 1000; page++) {
      const q: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) q['continuation-token'] = token;
      const xml = await this.ok(await this.send('GET', this.url('', q)), `Liste ${prefix}`);
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) out.push({ key: tag(m[1], 'Key'), size: Number(tag(m[1], 'Size')) || 0, lastModified: tag(m[1], 'LastModified') });
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : '';
      if (!token) break;
    }
    return out;
  }
}
