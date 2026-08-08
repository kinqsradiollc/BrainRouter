/**
 * Test fixtures — a tiny PDF writer, so the parser is exercised against real
 * files rather than against strings that happen to look like one.
 *
 * It writes compressed streams with `node:zlib`, which is the point: a test
 * that only ever feeds uncompressed content cannot tell whether FlateDecode
 * works, and that gap is exactly how the module shipped believing it could not
 * inflate anything.
 */
import zlib from 'node:zlib';

export interface ObjectSpec {
  /** The object body — a dictionary, array, number, whatever. */
  body: string;
  /** Stream payload; written verbatim after the dictionary. */
  stream?: Buffer;
}

/** Assemble numbered objects (1-based) plus a trailer into a PDF buffer. */
export function buildPdf(objects: ObjectSpec[], trailer = '<</Root 1 0 R>>'): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  objects.forEach((object, index) => {
    parts.push(Buffer.from(`${index + 1} 0 obj\n${object.body}\n`, 'latin1'));
    if (object.stream) {
      parts.push(Buffer.from('stream\n', 'latin1'));
      parts.push(object.stream);
      parts.push(Buffer.from('\nendstream\n', 'latin1'));
    }
    parts.push(Buffer.from('endobj\n', 'latin1'));
  });
  parts.push(Buffer.from(`trailer ${trailer}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** A `/Length … /Filter /FlateDecode` stream object for the given content. */
export function flateStream(content: string, extra = ''): ObjectSpec {
  const deflated = zlib.deflateSync(Buffer.from(content, 'latin1'));
  return { body: `<</Length ${deflated.length}/Filter/FlateDecode${extra}>>`, stream: deflated };
}

/** An uncompressed stream object. */
export function rawStream(content: string, extra = ''): ObjectSpec {
  const bytes = Buffer.from(content, 'latin1');
  return { body: `<</Length ${bytes.length}${extra}>>`, stream: bytes };
}

/**
 * A one-page document whose content stream is Flate-compressed — the shape the
 * old extractor could not read at all.
 *
 * Object layout: 1 catalog, 2 page tree, 3 page, 4 contents, 5 font.
 */
export function onePageFlatePdf(content: string, fontBody?: string): Buffer {
  return buildPdf([
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    {
      body:
        '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R' +
        '/Resources<</Font<</F1 5 0 R>>>>>>',
    },
    flateStream(content),
    { body: fontBody ?? '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>' },
  ]);
}

/**
 * The same writer, but with a real cross-reference table.
 *
 * `buildPdf` deliberately omits one — a file the baseline reconstructs by
 * scanning for `N 0 obj` is a useful test of the baseline. A conforming parser
 * refuses it, so ADR-030's structured engine cannot be exercised by those
 * fixtures at all; anything asserting on classification needs this instead.
 */
export function buildPdfWithXref(objects: ObjectSpec[], rootIndex = 1): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk: Buffer[] = [Buffer.from(`${index + 1} 0 obj\n${object.body}\n`, 'latin1')];
    if (object.stream) {
      chunk.push(Buffer.from('stream\n', 'latin1'), object.stream, Buffer.from('\nendstream\n', 'latin1'));
    }
    chunk.push(Buffer.from('endobj\n', 'latin1'));
    for (const buf of chunk) {
      parts.push(buf);
      length += buf.length;
    }
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<</Size ${objects.length + 1}/Root ${rootIndex} 0 R>>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** One page of a multi-page fixture: written text, a drawn image, or both. */
export interface XrefPageSpec {
  /** Shown with `/F1 12 Tf` at 72,700. Keep it free of `(`, `)` and `\`. */
  text?: string;
  /**
   * A full page of text, one line per entry.
   *
   * Needed because the structured engine judges a page by how much of it is
   * covered: a single sentence on a letter-size page reads as sparse and gets
   * flagged for OCR, so a fixture asserting on the structured path has to fill
   * the page the way a real document does.
   */
  lines?: readonly string[];
  /** Draw a page-sized image — what a scanned page looks like to a parser. */
  image?: boolean;
  /**
   * Draw a one-inch mark in the top margin — what a LETTERHEAD looks like.
   *
   * The counterpart to `image`, and the pair is the point: both pages drew
   * exactly one image, so anything deciding "is this a scan?" from the count
   * alone cannot tell them apart. Only the area can.
   */
  logo?: boolean;
}

/** ~45 lines of plausible prose — enough to fill a page. */
export function pageOfProse(prefix: string, count = 45): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`${prefix} line ${i}: the method section explains the sampling frame and the instrument.`);
  }
  return lines;
}

/**
 * A conforming multi-page document, for the classification tests: page 1 of
 * `[{ text }, { image }]` is a text page and page 2 is a scan.
 *
 * Object layout: 1 catalog, 2 page tree, 3 font, 4 image, then page/contents
 * pairs from 5.
 */
export function xrefPagesPdf(pages: readonly XrefPageSpec[]): Buffer {
  const raster = zlib.deflateSync(Buffer.alloc(64 * 64, 0x80));
  const objects: ObjectSpec[] = [
    { body: '<</Type/Catalog/Pages 2 0 R>>' },
    { body: '' }, // page tree, filled in once the kid numbers are known
    { body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>' },
    {
      body: '<</Type/XObject/Subtype/Image/Width 64/Height 64/ColorSpace/DeviceGray'
        + `/BitsPerComponent 8/Filter/FlateDecode/Length ${raster.length}>>`,
      stream: raster,
    },
  ];
  const kids: string[] = [];
  pages.forEach((page, index) => {
    const pageNum = 5 + index * 2;
    const contentNum = pageNum + 1;
    kids.push(`${pageNum} 0 R`);
    let content = '';
    if (page.image) content += 'q 612 0 0 792 0 0 cm /Im1 Do Q\n';
    if (page.logo) content += 'q 72 0 0 72 72 700 cm /Im1 Do Q\n';
    if (page.text) content += `BT /F1 12 Tf 72 700 Td (${page.text}) Tj ET\n`;
    if (page.lines) {
      content += 'BT /F1 11 Tf 14 TL 72 740 Td\n';
      for (const line of page.lines) content += `(${line}) Tj T*\n`;
      content += 'ET\n';
    }
    objects.push({
      body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentNum} 0 R`
        + '/Resources<</Font<</F1 3 0 R>>/XObject<</Im1 4 0 R>>>>>>',
    });
    objects.push(flateStream(content));
  });
  objects[1] = { body: `<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pages.length}>>` };
  return buildPdfWithXref(objects);
}

/**
 * A `/ToUnicode` CMap that spells "Hello" from codes 1–4 through `bfchar`, and
 * maps codes 0x10–0x12 to A–C through `bfrange` so both constructs are covered.
 */
export const HELLO_CMAP =
  '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
  '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n' +
  '4 beginbfchar\n<01> <0048>\n<02> <0065>\n<03> <006C>\n<04> <006F>\nendbfchar\n' +
  '1 beginbfrange\n<10> <12> <0041>\nendbfrange\n' +
  'endcmap\nend\nend\n';
