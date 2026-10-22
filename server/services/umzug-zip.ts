import { inflateRawSync } from 'node:zlib';

/**
 * A small ZIP reader for export files (Mailchimp hands out its audience export as a ZIP of CSV files).
 * Reads only – nothing is ever written to disk from the archive – and refuses anything unusual: encrypted
 * or ZIP64 archives, too many entries, entries that inflate beyond the limits (zip bombs).
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}
const DEFAULT_LIMITS: ZipLimits = { maxEntries: 300, maxEntryBytes: 120 * 1024 * 1024, maxTotalBytes: 300 * 1024 * 1024 };

export const looksLikeZip = (buf: Buffer) => buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50;

export function readZip(buf: Buffer, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  // End of central directory: the last 22+ bytes (a comment may follow).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Das ist keine gültige ZIP-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('ZIP64-Archive werden nicht unterstützt – bitte die Dateien einzeln hochladen');
  if (count > lim.maxEntries) throw new Error(`Das Archiv enthält mehr als ${lim.maxEntries} Dateien`);
  const out: ZipEntry[] = [];
  let total = 0;
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (rawName.endsWith('/')) continue;
    // Only the file's own name counts: no paths, no resource forks, no hidden files.
    const name = rawName.split(/[\\/]/).pop() ?? '';
    if (!name || name.startsWith('.') || rawName.startsWith('__MACOSX/')) continue;
    if (flags & 1) throw new Error('Das Archiv ist mit einem Passwort geschützt');
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error('ZIP64-Archive werden nicht unterstützt – bitte die Dateien einzeln hochladen');
    if (usize > lim.maxEntryBytes) throw new Error(`„${name}“ ist größer als ${Math.round(lim.maxEntryBytes / 1048576)} MB`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP-Eintrag beschädigt');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error('ZIP-Datei abgeschnitten');
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: lim.maxEntryBytes });
      } catch {
        throw new Error(`„${name}“ lässt sich nicht entpacken (beschädigt oder zu groß)`);
      }
    } else throw new Error(`„${name}“ nutzt ein nicht unterstütztes Packverfahren`);
    total += data.length;
    if (total > lim.maxTotalBytes) throw new Error('Das Archiv ist entpackt zu groß');
    out.push({ name, data });
  }
  return out;
}
