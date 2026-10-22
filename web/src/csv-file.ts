/** Windows-1252 differs from Latin-1 only in 0x80–0x9F (€, „, “, –, Š …); 0x81, 0x8D, 0x8F, 0x90 and 0x9D are unassigned. */
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

/** Windows-1252 bytes as text (done by hand: some runtimes decode the label "windows-1252" as plain Latin-1). */
export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const part = bytes.subarray(i, i + 8192);
    out += String.fromCharCode(...Array.from(part, (b) => (b >= 0x80 && b <= 0x9f ? CP1252.charCodeAt(b - 0x80) : b)));
  }
  return out;
}

/**
 * Reads a CSV file the way spreadsheets write it. `File.text()` always decodes UTF-8, but German Excel saves
 * "CSV (Trennzeichen-getrennt)" in Windows-1252: every ä, ö, ü and ß arrived as "�" and was imported like that
 * ("M�ller"). UTF-8 is tried strictly first; a file that is no valid UTF-8 is read as Windows-1252.
 */
export async function readCsvFile(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}
