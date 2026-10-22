/**
 * Upload checks shared by every module: the bytes must match the type the client claims (no HTML or
 * scripts disguised as images/PDFs), and stored files get an extension from the checked type, never
 * from the name the client sent.
 */

const ZIP = (b: Buffer) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;
const OLE = (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

const CHECKS: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'application/zip': ZIP,
  'application/msword': OLE,
  'application/vnd.ms-excel': OLE,
  'application/vnd.ms-powerpoint': OLE,
};

/** Does the content fit the claimed type? Office Open XML / OpenDocument are ZIP containers; text must not be binary or HTML. */
export function contentMatches(mime: string, buf: Buffer): boolean {
  const check = CHECKS[mime];
  if (check) return check(buf);
  if (/^application\/vnd\.(openxmlformats-officedocument|oasis\.opendocument)\./.test(mime)) return ZIP(buf);
  if (mime === 'text/plain' || mime === 'text/csv') {
    const head = buf.subarray(0, 1024).toString('utf8');
    return !buf.subarray(0, 1024).includes(0) && !/<\s*(script|html|svg|iframe|body)\b/i.test(head);
  }
  return false;
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

/** File extension for a checked type (Office/OpenDocument keep their usual one from the type name). */
export function extFor(mime: string): string {
  if (EXT[mime]) return EXT[mime];
  const m = mime.match(/(wordprocessingml|spreadsheetml|presentationml)/);
  if (m) return { wordprocessingml: '.docx', spreadsheetml: '.xlsx', presentationml: '.pptx' }[m[1]]!;
  const od = mime.match(/opendocument\.(text|spreadsheet|presentation)/);
  if (od) return { text: '.odt', spreadsheet: '.ods', presentation: '.odp' }[od[1]]!;
  return '.bin';
}
