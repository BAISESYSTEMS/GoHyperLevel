import { buildZip } from './acc-datev.js';
import { readZip } from './umzug-zip.js';
import type { OfficeKind } from './office-model.js';

/**
 * Office files HyperLevel makes and reads on its own, without the optional engines (docs/office.md): blank documents (optionally with
 * starting text or table rows, so the agent can create something useful on a server without engines) and a plain-text excerpt of
 * .docx/.xlsx/.pptx for reading. The files are minimal, valid Office Open XML / PDF; the engines and the editors open them.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// characters XML 1.0 does not allow
const xmlText = (s: unknown) => esc(String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ''));
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const f = (name: string, xml: string) => ({ name, data: Buffer.from(HEAD + xml, 'utf8'), date: new Date('2026-01-01T00:00:00Z') });

function types(overrides: [string, string][]): string {
  return `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`;
}
const rels = (list: [string, string, string][]) => `<Relationships xmlns="${PKG_REL}">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
const rootRels = (target: string) => rels([['rId1', `${REL}/officeDocument`, target]]);

export interface BlankInput {
  /** Starting text: one paragraph per line (documents, PDF) or the title of the first slide (presentations). */
  text?: string;
  /** Starting rows of a spreadsheet's first sheet. */
  rows?: (string | number | boolean | null)[][];
}

function docx(input: BlankInput): Buffer {
  const lines = String(input.text ?? '').split(/\r?\n/).slice(0, 5000);
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = lines.map((l) => (l ? `<w:p><w:r><w:t xml:space="preserve">${xmlText(l)}</w:t></w:r></w:p>` : '<w:p/>')).join('');
  return buildZip([
    f('[Content_Types].xml', types([['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']])),
    f('_rels/.rels', rootRels('word/document.xml')),
    f('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${paras}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  ]);
}

/** Column letters of a 0-based index (0 → A, 26 → AA). */
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function xlsx(input: BlankInput): Buffer {
  const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rows = (input.rows ?? []).slice(0, 10_000);
  const data = rows
    .map((row, r) => {
      const cells = (Array.isArray(row) ? row : []).slice(0, 500).map((v, c) => {
        const ref = `${colName(c)}${r + 1}`;
        if (v === null || v === undefined || v === '') return '';
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
      });
      return `<row r="${r + 1}">${cells.join('')}</row>`;
    })
    .join('');
  return buildZip([
    f(
      '[Content_Types].xml',
      types([
        ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
        ['/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
      ]),
    ),
    f('_rels/.rels', rootRels('xl/workbook.xml')),
    f('xl/workbook.xml', `<workbook xmlns="${S}" xmlns:r="${REL}"><sheets><sheet name="Tabelle1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    f('xl/_rels/workbook.xml.rels', rels([['rId1', `${REL}/worksheet`, 'worksheets/sheet1.xml']])),
    f('xl/worksheets/sheet1.xml', `<worksheet xmlns="${S}"><sheetData>${data}</sheetData></worksheet>`),
  ]);
}

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const emptyTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>`;

function theme(): string {
  const solid = (c: string) => `<a:solidFill><a:schemeClr val="${c}"/></a:solidFill>`;
  const ln = `<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  const colors = [
    ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
    ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ['dk2', '<a:srgbClr val="1F2937"/>'],
    ['lt2', '<a:srgbClr val="F3F4F6"/>'],
    ['accent1', '<a:srgbClr val="2563EB"/>'],
    ['accent2', '<a:srgbClr val="16A34A"/>'],
    ['accent3', '<a:srgbClr val="F59E0B"/>'],
    ['accent4', '<a:srgbClr val="DC2626"/>'],
    ['accent5', '<a:srgbClr val="7C3AED"/>'],
    ['accent6', '<a:srgbClr val="0891B2"/>'],
    ['hlink', '<a:srgbClr val="2563EB"/>'],
    ['folHlink', '<a:srgbClr val="7C3AED"/>'],
  ]
    .map(([n, v]) => `<a:${n}>${v}</a:${n}>`)
    .join('');
  const font = (face: string) => `<a:latin typeface="${face}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  return (
    `<a:theme xmlns:a="${A}" name="HyperLevel"><a:themeElements><a:clrScheme name="HyperLevel">${colors}</a:clrScheme>` +
    `<a:fontScheme name="HyperLevel"><a:majorFont>${font('Calibri Light')}</a:majorFont><a:minorFont>${font('Calibri')}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="HyperLevel"><a:fillStyleLst>${solid('phClr').repeat(3)}</a:fillStyleLst><a:lnStyleLst>${ln.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${solid('phClr').repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements></a:theme>`
  );
}

function pptx(input: BlankInput): Buffer {
  const title = String(input.text ?? '').split(/\r?\n/)[0]?.slice(0, 500) ?? '';
  const ns = `xmlns:a="${A}" xmlns:r="${REL}" xmlns:p="${P}"`;
  const titleShape = title
    ? `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titel"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="2286000"/><a:ext cx="10515600" cy="1325563"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="de-DE" sz="4400"/><a:t>${xmlText(title)}</a:t></a:r></a:p></p:txBody></p:sp>`
    : '';
  const slideTree = emptyTree.replace('<p:grpSpPr/>', `<p:grpSpPr/>${titleShape}`);
  const clrMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  return buildZip([
    f(
      '[Content_Types].xml',
      types([
        ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
        ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
        ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
        ['/ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
        ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
      ]),
    ),
    f('_rels/.rels', rootRels('ppt/presentation.xml')),
    f(
      'ppt/presentation.xml',
      `<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ),
    f(
      'ppt/_rels/presentation.xml.rels',
      rels([
        ['rId1', `${REL}/slideMaster`, 'slideMasters/slideMaster1.xml'],
        ['rId2', `${REL}/slide`, 'slides/slide1.xml'],
        ['rId3', `${REL}/theme`, 'theme/theme1.xml'],
      ]),
    ),
    f('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster ${ns}><p:cSld>${emptyTree}</p:cSld>${clrMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    f(
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      rels([
        ['rId1', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml'],
        ['rId2', `${REL}/theme`, '../theme/theme1.xml'],
      ]),
    ),
    f('ppt/slideLayouts/slideLayout1.xml', `<p:sldLayout ${ns} type="blank" preserve="1"><p:cSld name="Leer">${emptyTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    f('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', `${REL}/slideMaster`, '../slideMasters/slideMaster1.xml']])),
    f('ppt/slides/slide1.xml', `<p:sld ${ns}><p:cSld>${slideTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`),
    f('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml']])),
    f('ppt/theme/theme1.xml', theme()),
  ]);
}

/** A one-page A4 PDF, optionally with lines of text (Helvetica, Latin-1; other characters become "?"). */
function pdf(input: BlankInput): Buffer {
  const lines = String(input.text ?? '').split(/\r?\n/).slice(0, 60);
  const latin = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
  const content = lines.some((l) => l) ? `BT /F1 11 Tf 14 TL 56 786 Td ${lines.map((l) => `(${latin(l.slice(0, 110))}) '`).join(' ')} ET` : '';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function blankFile(kind: OfficeKind, input: BlankInput = {}): Buffer {
  return { docx, xlsx, pptx, pdf }[kind](input);
}

// --- reading without an engine -------------------------------------------------------------------------------------------

const unesc = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'amp') return '&';
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
const texts = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => unesc(m[1]));
const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

/**
 * Plain text of a .docx, .xlsx (tab-separated per sheet) or .pptx (per slide) – a fallback when no engine is installed. A PDF needs the
 * engine. Never throws on odd input: returns null when the file cannot be read.
 */
export function extractText(kind: OfficeKind, buf: Buffer): string | null {
  if (kind === 'pdf') return null;
  let entries: { name: string; data: Buffer }[];
  try {
    entries = readZip(buf, { maxEntries: 2000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
  const get = (name: string) => entries.find((e) => e.name === name)?.data.toString('utf8');
  if (kind === 'docx') {
    const xml = get('document.xml');
    if (!xml) return null;
    return xml
      .split(/<\/w:p>/)
      .map((p) => p.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>'))
      .map((p) => texts(p, 'w:t').join(''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (kind === 'pptx') {
    const slides = entries.filter((e) => /^slide\d+\.xml$/.test(e.name)).sort((a, b) => num(a.name) - num(b.name));
    return slides
      .map((s, i) => {
        const paras = s.data
          .toString('utf8')
          .split(/<\/a:p>/)
          .map((p) => texts(p, 'a:t').join(''))
          .filter(Boolean);
        return `--- Folie ${i + 1} ---\n${paras.join('\n')}`;
      })
      .join('\n\n')
      .trim();
  }
  // xlsx
  const shared = (() => {
    const xml = get('sharedStrings.xml');
    if (!xml) return [] as string[];
    return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1], 't').join(''));
  })();
  const names = [...(get('workbook.xml') ?? '').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unesc(m[1]));
  const sheets = entries.filter((e) => /^sheet\d+\.xml$/.test(e.name)).sort((a, b) => num(a.name) - num(b.name));
  return sheets
    .map((s, i) => {
      const rows = [...s.data.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        const cells: string[] = [];
        for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
          const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
          const t = attrs.match(/\bt="(\w+)"/)?.[1];
          const body = c[2] ?? '';
          const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
          let out = '';
          if (t === 's' && v !== undefined) out = shared[Number(v)] ?? '';
          else if (t === 'inlineStr') out = texts(body, 't').join('');
          else if (t === 'b') out = v === '1' ? 'WAHR' : 'FALSCH';
          else if (v !== undefined) out = unesc(v);
          while (cells.length < col) cells.push('');
          cells[col] = out;
        }
        return cells.join('\t');
      });
      return `--- Blatt ${names[i] ?? i + 1} ---\n${rows.join('\n')}`;
    })
    .join('\n\n')
    .trim();
}
