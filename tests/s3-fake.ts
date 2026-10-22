import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signRequest } from '../server/services/s3-lite.js';

/**
 * A local S3-compatible server for the off-site backup tests: path-style buckets, PUT/GET/DELETE of objects, multipart uploads,
 * ListObjectsV2 with continuation (small pages on purpose) – and it checks every request's SigV4 signature and payload hash
 * the way S3 does (403 SignatureDoesNotMatch, 400 XAmzContentSHA256Mismatch). Nothing leaves the machine.
 */

export const S3_CREDS = { accessKey: 'test-access-key', secretKey: 'test-secret-key-for-the-fake-s3', region: 'eu-test-1', bucket: 'backups' };

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function startFakeS3(o: { pageSize?: number } = {}) {
  const objects = new Map<string, { body: Buffer; at: string }>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const log: { method: string; key: string; query: string; status: number }[] = [];
  let seq = 0;
  let refuse: ((method: string, key: string) => boolean) | undefined;
  const pageSize = o.pageSize ?? 3;

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').slice(1);
    const bucket = decodeURIComponent(parts[0] ?? '');
    const key = parts.slice(1).map(decodeURIComponent).join('/');
    const send = (status: number, text = '', headers: Record<string, string> = {}) => {
      log.push({ method, key, query: url.search, status });
      res.writeHead(status, { 'content-type': 'application/xml', ...headers });
      res.end(text);
    };
    const error = (status: number, code: string, msg: string) => send(status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${xml(msg)}</Message></Error>`);

    // --- authentication: recompute the signature over the signed headers ---
    const auth = String(req.headers.authorization ?? '');
    const signed = /SignedHeaders=([^,\s]+)/.exec(auth)?.[1].split(';') ?? [];
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
    const extra = Object.fromEntries(signed.filter((h) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(h)).map((h) => [h, String(req.headers[h] ?? '')]));
    if (!signed.includes('host') || Number.isNaN(date.getTime())) return error(403, 'AccessDenied', 'missing signature parts');
    const want = signRequest({ method, url, headers: extra, payloadHash, accessKey: S3_CREDS.accessKey, secretKey: S3_CREDS.secretKey, region: S3_CREDS.region, date }).authorization;
    if (want !== auth) return error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
    if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha(body)) return error(400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed.');
    if (bucket !== S3_CREDS.bucket) return error(404, 'NoSuchBucket', 'The specified bucket does not exist');
    if (refuse?.(method, key)) return error(500, 'InternalError', 'We encountered an internal error. Please try again.');

    const q = url.searchParams;
    if (method === 'GET' && !key) {
      const prefix = q.get('prefix') ?? '';
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(q.get('continuation-token') ?? 0);
      const page = all.slice(start, start + Math.min(pageSize, Number(q.get('max-keys') ?? 1000)));
      const more = start + page.length < all.length;
      return send(
        200,
        `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>` : ''}${page.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${objects.get(k)!.at}</LastModified><Size>${objects.get(k)!.body.length}</Size></Contents>`).join('')}</ListBucketResult>`,
      );
    }
    if (method === 'POST' && q.has('uploads')) {
      const id = `up${++seq}`;
      uploads.set(id, new Map());
      return send(200, `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === 'PUT' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId')!);
      if (!up) return error(404, 'NoSuchUpload', 'no such upload');
      up.set(Number(q.get('partNumber')), body);
      return send(200, '', { etag: `"${sha(body).slice(0, 32)}"` });
    }
    if (method === 'POST' && q.has('uploadId')) {
      const up = uploads.get(q.get('uploadId')!);
      if (!up) return error(404, 'NoSuchUpload', 'no such upload');
      const nums = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      objects.set(key, { body: Buffer.concat(nums.map((n) => up.get(n)!)), at: new Date().toISOString() });
      uploads.delete(q.get('uploadId')!);
      return send(200, `<?xml version="1.0"?><CompleteMultipartUploadResult><Key>${xml(key)}</Key></CompleteMultipartUploadResult>`);
    }
    if (method === 'DELETE' && q.has('uploadId')) {
      uploads.delete(q.get('uploadId')!);
      return send(204);
    }
    if (method === 'PUT') {
      if (req.headers['content-length'] === undefined) return error(411, 'MissingContentLength', 'You must provide the Content-Length HTTP header.');
      objects.set(key, { body, at: new Date().toISOString() });
      return send(200, '', { etag: `"${sha(body).slice(0, 32)}"` });
    }
    if (method === 'GET') {
      const obj = objects.get(key);
      if (!obj) return error(404, 'NoSuchKey', 'The specified key does not exist.');
      log.push({ method, key, query: url.search, status: 200 });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(obj.body.length) });
      return void res.end(obj.body);
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return send(204);
    }
    return error(405, 'MethodNotAllowed', 'method not allowed');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint,
    objects,
    log,
    refuse: (fn?: (method: string, key: string) => boolean) => void (refuse = fn),
    keys: (prefix = '') => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
