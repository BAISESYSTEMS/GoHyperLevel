/**
 * A small sRGB ICC profile (version 2.1, display class, matrix/TRC), written by code instead of shipping a binary file:
 * D50 primaries of IEC 61966-2.1 (Bradford-adapted, as in the ICC's own sRGB profiles) and the sRGB tone curve sampled at
 * 1024 points (the three TRC tags share one table). PDF/A needs such a profile as the destination of its OutputIntent so that
 * DeviceRGB colours have a defined meaning. Deterministic: the same bytes every time (fixed creation date, no profile ID).
 */

const s15 = (v: number) => Math.round(v * 65536);

function tag(sig: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(sig, 0, 'latin1');
  return Buffer.concat([head, body]);
}

const xyz = (x: number, y: number, z: number) => {
  const b = Buffer.alloc(12);
  b.writeInt32BE(s15(x), 0);
  b.writeInt32BE(s15(y), 4);
  b.writeInt32BE(s15(z), 8);
  return tag('XYZ ', b);
};

function desc(text: string): Buffer {
  const ascii = Buffer.from(`${text}\0`, 'latin1');
  const count = Buffer.alloc(4);
  count.writeUInt32BE(ascii.length, 0);
  // Unicode language + count (0), ScriptCode code + count (0), 67 bytes Macintosh description
  return tag('desc', Buffer.concat([count, ascii, Buffer.alloc(4 + 4 + 2 + 1 + 67)]));
}

const text = (s: string) => tag('text', Buffer.from(`${s}\0`, 'latin1'));

function curve(points: number): Buffer {
  const b = Buffer.alloc(4 + points * 2);
  b.writeUInt32BE(points, 0);
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1);
    const y = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    b.writeUInt16BE(Math.round(y * 65535), 4 + i * 2);
  }
  return tag('curv', b);
}

export const SRGB_NAME = 'sRGB IEC61966-2.1';

let cached: Buffer | null = null;

/** The profile bytes (cached; callers must not change them). */
export function srgbIcc(): Buffer {
  if (cached) return cached;
  const D50 = [0.9642, 1, 0.8249] as const;
  const trc = curve(1024);
  // tag data in order; the TRC tags point at one shared block
  const blocks: [string[], Buffer][] = [
    [['desc'], desc(SRGB_NAME)],
    [['cprt'], text('No copyright, use freely')],
    [['wtpt'], xyz(...D50)],
    [['rXYZ'], xyz(0.436066, 0.222488, 0.013916)],
    [['gXYZ'], xyz(0.385147, 0.716873, 0.097076)],
    [['bXYZ'], xyz(0.143066, 0.060608, 0.714096)],
    [['rTRC', 'gTRC', 'bTRC'], trc],
  ];
  const tagCount = blocks.reduce((n, [sigs]) => n + sigs.length, 0);
  const table = Buffer.alloc(4 + tagCount * 12);
  table.writeUInt32BE(tagCount, 0);
  const data: Buffer[] = [];
  let offset = 128 + table.length;
  let k = 0;
  for (const [sigs, body] of blocks) {
    const padded = body.length % 4 ? Buffer.concat([body, Buffer.alloc(4 - (body.length % 4))]) : body;
    for (const sig of sigs) {
      const p = 4 + k * 12;
      table.write(sig, p, 'latin1');
      table.writeUInt32BE(offset, p + 4);
      table.writeUInt32BE(body.length, p + 8);
      k++;
    }
    data.push(padded);
    offset += padded.length;
  }
  const head = Buffer.alloc(128);
  head.writeUInt32BE(offset, 0); // profile size
  head.writeUInt32BE(0x02100000, 8); // version 2.1
  head.write('mntr', 12, 'latin1');
  head.write('RGB ', 16, 'latin1');
  head.write('XYZ ', 20, 'latin1');
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => head.writeUInt16BE(v, 24 + i * 2));
  head.write('acsp', 36, 'latin1');
  head.writeInt32BE(s15(D50[0]), 68);
  head.writeInt32BE(s15(D50[1]), 72);
  head.writeInt32BE(s15(D50[2]), 76);
  cached = Buffer.concat([head, table, ...data]);
  return cached;
}
