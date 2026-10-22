import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { XRECHNUNG_CUSTOMIZATION } from './einvoice-model.js';
import { SRGB_NAME, srgbIcc } from './srgb-icc.js';

/**
 * ZUGFeRD 2.3 / Factur-X 1.07: the invoice PDF with its CII XML attached – a post-processing step on top of our own PDF writer
 * (no library). The PDF is read through its classic cross-reference table and written again as one revision (PDF 1.7) with:
 * - the XML as an embedded file stream (/Subtype text/xml, /Params with size, MD5 and date), a file specification with
 *   /AFRelationship, the EmbeddedFiles name tree and the /AF array on the catalog (PDF/A-3 "associated file");
 * - XMP metadata with pdfaid part 3 / conformance B, Dublin Core, the Factur-X extension schema and its fx: values
 *   (DocumentType INVOICE, DocumentFileName, Version 1.0, ConformanceLevel);
 * - an OutputIntent (GTS_PDFA1) with an sRGB ICC profile, a document ID and an Info dictionary that matches the XMP.
 * Limit (see docs/invoicing.md): the page content keeps the PDF base fonts, which PDF/A wants embedded – a strict PDF/A-3
 * validator reports that; the e-invoice part (XML, attachment, metadata) is complete.
 */

export type FxProfile = 'en16931' | 'xrechnung';

export const FX_PROFILES: Record<FxProfile, { label: string; conformance: string; filename: string; guideline: string }> = {
  en16931: { label: 'EN 16931 (Comfort)', conformance: 'EN 16931', filename: 'factur-x.xml', guideline: 'urn:cen.eu:en16931:2017' },
  // ZUGFeRD 2.3 profile XRECHNUNG: the XRechnung CIUS, attached under its own file name
  xrechnung: { label: 'XRECHNUNG', conformance: 'XRECHNUNG', filename: 'xrechnung.xml', guideline: XRECHNUNG_CUSTOMIZATION },
};

export const isFxProfile = (v: unknown): v is FxProfile => v === 'en16931' || v === 'xrechnung';

export const FX_NAMESPACE = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';

// --- reading our PDFs ------------------------------------------------------------------------------------------------------

export interface PdfIndex {
  /** object number → byte range of "n g obj … endobj" (and what follows up to the next object). */
  objects: Map<number, { start: number; end: number }>;
  root: number;
  info: number | null;
  size: number;
  xref: number;
}

/** Reads the cross-reference table and trailer of a PDF with one revision and a classic xref (what our writer makes). */
export function indexPdf(pdf: Buffer): PdfIndex {
  const s = pdf.toString('latin1');
  const sx = s.lastIndexOf('startxref');
  if (sx < 0) throw new Error('PDF ohne startxref');
  const xref = Number(/^startxref\s+(\d+)/.exec(s.slice(sx))?.[1]);
  if (!Number.isFinite(xref) || !s.startsWith('xref', xref)) throw new Error('PDF mit Querverweis-Stream wird nicht unterstützt');
  const tp = s.indexOf('trailer', xref);
  if (tp < 0) throw new Error('PDF ohne trailer');
  const trailer = s.slice(tp, sx);
  if (/\/(Prev|Encrypt)\b/.test(trailer)) throw new Error('PDF mit mehreren Revisionen oder Verschlüsselung wird nicht unterstützt');
  const root = Number(/\/Root\s+(\d+)\s+0\s+R/.exec(trailer)?.[1]);
  const infoM = /\/Info\s+(\d+)\s+0\s+R/.exec(trailer);
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)?.[1]);
  if (!root || !size) throw new Error('PDF-Trailer unvollständig');
  const offsets: [number, number][] = [];
  const table = s.slice(xref + 4, tp);
  const lines = table.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; ) {
    const head = /^(\d+)\s+(\d+)$/.exec(lines[i]);
    if (!head) throw new Error('PDF-Querverweistabelle unlesbar');
    const first = Number(head[1]);
    const n = Number(head[2]);
    for (let k = 0; k < n; k++) {
      const e = /^(\d{10})\s+(\d{5})\s+([nf])$/.exec(lines[i + 1 + k] ?? '');
      if (!e) throw new Error('PDF-Querverweistabelle unlesbar');
      if (e[3] === 'n') offsets.push([first + k, Number(e[1])]);
    }
    i += 1 + n;
  }
  const sorted = [...offsets].sort((a, b) => a[1] - b[1]);
  const objects = new Map<number, { start: number; end: number }>();
  sorted.forEach(([num, start], i) => {
    if (!new RegExp(`^${num}\\s+0\\s+obj\\b`).test(s.slice(start, start + 24))) throw new Error(`PDF-Objekt ${num} steht nicht an seiner Adresse`);
    objects.set(num, { start, end: i + 1 < sorted.length ? sorted[i + 1][1] : xref });
  });
  return { objects, root, info: infoM ? Number(infoM[1]) : null, size, xref };
}

/** The text of an object without its stream data ("<< … >>" or a plain value). */
export function objectText(pdf: Buffer, idx: PdfIndex, num: number): string {
  const r = idx.objects.get(num);
  if (!r) throw new Error(`PDF-Objekt ${num} fehlt`);
  const s = pdf.subarray(r.start, r.end).toString('latin1');
  const body = s.replace(/^\d+\s+0\s+obj\s*/, '');
  const st = body.search(/\bstream\r?\n/);
  return (st >= 0 ? body.slice(0, st) : body.replace(/\s*endobj[\s\S]*$/, '')).trim();
}

/** The decoded data of a stream object (FlateDecode or none). */
export function streamData(pdf: Buffer, idx: PdfIndex, num: number): Buffer {
  const r = idx.objects.get(num);
  if (!r) throw new Error(`PDF-Objekt ${num} fehlt`);
  const s = pdf.subarray(r.start, r.end).toString('latin1');
  const dict = objectText(pdf, idx, num);
  const len = Number(/\/Length\s+(\d+)/.exec(dict)?.[1]);
  const m = /\bstream(\r?\n)/.exec(s);
  if (!m || !Number.isFinite(len)) throw new Error(`PDF-Objekt ${num} ist kein Stream`);
  const raw = pdf.subarray(r.start + m.index + m[0].length, r.start + m.index + m[0].length + len);
  return /\/Filter\s*\/FlateDecode/.test(dict) ? inflateSync(raw) : Buffer.from(raw);
}

const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

/**
 * The files attached through the catalog's EmbeddedFiles name tree (flat /Names array, as written below): name → data and
 * the file specification's text. Used by the tests and for a sanity check of every hybrid PDF before it leaves.
 */
export function readEmbeddedFiles(pdf: Buffer): { name: string; data: Buffer; spec: string; af: boolean }[] {
  const idx = indexPdf(pdf);
  const cat = objectText(pdf, idx, idx.root);
  const afList = /\/AF\s*\[([^\]]*)\]/.exec(cat)?.[1] ?? '';
  const af = new Set([...afList.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1])));
  const names = /\/EmbeddedFiles\s*<<\s*\/Names\s*\[([\s\S]*?)\]\s*>>/.exec(cat)?.[1] ?? '';
  const out: { name: string; data: Buffer; spec: string; af: boolean }[] = [];
  for (const m of names.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(\d+)\s+0\s+R/g)) {
    const specNum = Number(m[2]);
    const spec = objectText(pdf, idx, specNum);
    const ef = /\/EF\s*<<([^>]*)>>/.exec(spec)?.[1] ?? '';
    const fileNum = ref(ef, 'F') ?? ref(ef, 'UF');
    if (fileNum === null) continue;
    out.push({ name: m[1].replace(/\\(.)/g, '$1'), data: streamData(pdf, idx, fileNum), spec, af: af.has(specNum) });
  }
  return out;
}

// --- writing ---------------------------------------------------------------------------------------------------------------

/** PDF text string: plain ASCII as a literal, anything else as UTF-16BE with byte-order mark. */
export function pdfText(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  return `<FEFF${Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "2026-10-05T10:00:00.000Z" → the PDF date and the XMP date of the same instant (UTC). */
function dates(iso: string): { pdf: string; xmp: string } {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date(0) : d;
  const p = (n: number) => String(n).padStart(2, '0');
  const [Y, M, D, h, m, s] = [t.getUTCFullYear(), p(t.getUTCMonth() + 1), p(t.getUTCDate()), p(t.getUTCHours()), p(t.getUTCMinutes()), p(t.getUTCSeconds())];
  return { pdf: `D:${Y}${M}${D}${h}${m}${s}+00'00'`, xmp: `${Y}-${M}-${D}T${h}:${m}:${s}+00:00` };
}

export interface HybridMeta {
  title: string;
  author: string;
  subject: string;
  creator: string;
  producer: string;
  date: string;
}

const FX_PROPS: [string, string][] = [
  ['DocumentFileName', 'The name of the embedded XML document'],
  ['DocumentType', 'The type of the hybrid document in capital letters, e.g. INVOICE or ORDER'],
  ['Version', 'The actual version of the standard applying to the embedded XML document'],
  ['ConformanceLevel', 'The conformance level of the embedded XML document'],
];

/** The XMP packet (UTF-8): PDF/A-3B identification, Dublin Core, PDF and XMP basics, the Factur-X extension schema and values. */
export function facturxXmp(meta: HybridMeta, profile: FxProfile): string {
  const fx = FX_PROFILES[profile];
  const d = dates(meta.date).xmp;
  const props = FX_PROPS.map(
    ([name, desc]) => `            <rdf:li rdf:parseType="Resource">
              <pdfaProperty:name>${name}</pdfaProperty:name>
              <pdfaProperty:valueType>Text</pdfaProperty:valueType>
              <pdfaProperty:category>external</pdfaProperty:category>
              <pdfaProperty:description>${desc}</pdfaProperty:description>
            </rdf:li>`,
  ).join('\n');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(meta.title)}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${xmlEsc(meta.author)}</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(meta.subject)}</rdf:li></rdf:Alt></dc:description>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>${xmlEsc(meta.producer)}</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>${xmlEsc(meta.creator)}</xmp:CreatorTool>
      <xmp:CreateDate>${d}</xmp:CreateDate>
      <xmp:ModifyDate>${d}</xmp:ModifyDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>${FX_NAMESPACE}</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
${props}
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="${FX_NAMESPACE}">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>${fx.filename}</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${fx.conformance}</fx:ConformanceLevel>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

const latin = (s: string) => Buffer.from(s, 'latin1');
const streamObj = (num: number, dict: string, data: Buffer) => Buffer.concat([latin(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin('\nendstream\nendobj\n')]);

/**
 * Attaches the XML to the PDF the ZUGFeRD / Factur-X way. `relationship`: /Alternative (the XML is an equivalent
 * representation of the invoice – the usual choice for EN 16931 / XRECHNUNG) or /Data. Deterministic for the same input.
 */
export function makeHybridPdf(pdf: Buffer, o: { xml: string; profile: FxProfile; meta: HybridMeta; relationship?: 'Alternative' | 'Data' }): Buffer {
  const idx = indexPdf(pdf);
  const fx = FX_PROFILES[o.profile];
  const catalog = objectText(pdf, idx, idx.root);
  const inner = /^<<([\s\S]*)>>$/.exec(catalog)?.[1];
  if (inner === undefined || !/\/Type\s*\/Catalog/.test(inner)) throw new Error('PDF-Katalog unlesbar');
  if (/\/(AF|Names|Metadata|OutputIntents)\b/.test(inner)) throw new Error('PDF hat schon Anhänge oder Metadaten');

  const xml = Buffer.from(o.xml, 'utf8');
  const when = dates(o.meta.date).pdf;
  let next = idx.size;
  const num = { file: next++, spec: next++, meta: next++, icc: next++, intent: next++, info: idx.info ?? next++ };
  const extra: Buffer[] = [];
  extra.push(
    streamObj(
      num.file,
      `/Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Params << /Size ${xml.length} /CheckSum <${createHash('md5').update(xml).digest('hex').toUpperCase()}> /CreationDate (${when}) /ModDate (${when}) >>`,
      deflateSync(xml),
    ),
  );
  extra.push(latin(`${num.spec} 0 obj\n<< /Type /Filespec /F (${fx.filename}) /UF (${fx.filename}) /Desc (Factur-X/ZUGFeRD ${fx.conformance}) /AFRelationship /${o.relationship ?? 'Alternative'} /EF << /F ${num.file} 0 R /UF ${num.file} 0 R >> >>\nendobj\n`));
  extra.push(streamObj(num.meta, '/Type /Metadata /Subtype /XML', Buffer.from(facturxXmp(o.meta, o.profile), 'utf8')));
  extra.push(streamObj(num.icc, '/N 3 /Filter /FlateDecode', deflateSync(srgbIcc())));
  extra.push(latin(`${num.intent} 0 obj\n<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (${SRGB_NAME}) /RegistryName (http://www.color.org) /Info (${SRGB_NAME}) /DestOutputProfile ${num.icc} 0 R >>\nendobj\n`));
  const info = `<< /Title ${pdfText(o.meta.title)} /Author ${pdfText(o.meta.author)} /Subject ${pdfText(o.meta.subject)} /Creator ${pdfText(o.meta.creator)} /Producer ${pdfText(o.meta.producer)} /CreationDate (${when}) /ModDate (${when}) >>`;
  const newCatalog = `<<${inner.trimEnd()} /Metadata ${num.meta} 0 R /OutputIntents [${num.intent} 0 R] /Names << /EmbeddedFiles << /Names [(${fx.filename}) ${num.spec} 0 R] >> >> /AF [${num.spec} 0 R] >>`;

  // one revision again: header, the objects in their order (catalog and info replaced), the new objects, one xref
  const parts: Buffer[] = [Buffer.from([...latin('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let pos = parts[0].length;
  const offsets = new Map<number, number>();
  const push = (n: number, b: Buffer) => {
    offsets.set(n, pos);
    parts.push(b);
    pos += b.length;
  };
  const ordered = [...idx.objects.entries()].sort((a, b) => a[1].start - b[1].start);
  for (const [n, r] of ordered) {
    if (n === idx.root) push(n, latin(`${n} 0 obj\n${newCatalog}\nendobj\n`));
    else if (n === idx.info) push(n, latin(`${n} 0 obj\n${info}\nendobj\n`));
    else push(n, pdf.subarray(r.start, r.end));
  }
  const added = [num.file, num.spec, num.meta, num.icc, num.intent];
  added.forEach((n, i) => push(n, extra[i]));
  if (idx.info === null) push(num.info, latin(`${num.info} 0 obj\n${info}\nendobj\n`));
  const size = Math.max(...offsets.keys()) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  const id = createHash('md5').update(pdf).update(xml).digest('hex').toUpperCase();
  xref += `trailer\n<< /Size ${size} /Root ${idx.root} 0 R /Info ${num.info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(latin(xref));
  return Buffer.concat(parts);
}
