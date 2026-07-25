/**
 * Bounded, local DOCX text extraction.
 *
 * DOCX is an OPC ZIP package. This parser validates the complete central
 * directory before retaining only the three package parts needed to establish
 * the document type and read its main XML. It never writes files, follows
 * relationships, fetches resources, or expands XML entities.
 */

import { inflateRawSync } from "node:zlib";

const CONTENT_TYPES_PART = "[Content_Types].xml";
const ROOT_RELATIONSHIPS_PART = "_rels/.rels";
const DOCUMENT_PART = "word/document.xml";
const REQUIRED_PARTS = new Set([
  CONTENT_TYPES_PART,
  ROOT_RELATIONSHIPS_PART,
  DOCUMENT_PART,
]);

const MAX_ARCHIVE_ENTRIES = 1_024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_METADATA_BYTES = 1 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_ENTRY_NAME_CHARS = 512;
const MAX_XML_DEPTH = 256;
const MAX_EXTRACTED_CHARS = 1 * 1024 * 1024;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const ALLOWED_GENERAL_PURPOSE_FLAGS = 0x080e;
const CRC32_TABLE = buildCrc32Table();

type ZipEntry = {
  name: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  originalSize: number;
  localHeaderOffset: number;
};

export function extractKnowledgeDocxText(archive: Uint8Array): string | null {
  const inspected = inspectZipArchive(archive);
  if (!inspected) return null;
  const { entries, centralDirectoryOffset } = inspected;
  const parts: Record<string, Uint8Array> = {};
  const extractedRanges: Array<{ start: number; end: number }> = [];
  for (const part of REQUIRED_PARTS) {
    const entry = entries.get(part);
    if (!entry) return null;
    const extracted = extractZipEntry(archive, entry, centralDirectoryOffset);
    if (!extracted) return null;
    if (extractedRanges.some((range) =>
      extracted.start < range.end && extracted.end > range.start)) {
      return null;
    }
    extractedRanges.push({ start: extracted.start, end: extracted.end });
    parts[part] = extracted.content;
  }

  const contentTypes = decodeXmlPart(parts[CONTENT_TYPES_PART], MAX_PACKAGE_METADATA_BYTES);
  const relationships = decodeXmlPart(parts[ROOT_RELATIONSHIPS_PART], MAX_PACKAGE_METADATA_BYTES);
  const documentXml = decodeXmlPart(parts[DOCUMENT_PART], MAX_DOCUMENT_XML_BYTES);
  if (!contentTypes || !relationships || !documentXml) return null;
  if (!isWordDocumentPackage(contentTypes, relationships)) return null;
  return extractWordDocumentText(documentXml);
}

function inspectZipArchive(archive: Uint8Array): {
  entries: Map<string, ZipEntry>;
  centralDirectoryOffset: number;
} | null {
  if (!hasZipSignature(archive)
    || archive.length > MAX_ARCHIVE_BYTES
    || archive.length < 22) {
    return null;
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset === -1) return null;
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntryCount = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const commentLength = view.getUint16(eocdOffset + 20, true);
  if (diskNumber !== 0
    || centralDirectoryDisk !== 0
    || diskEntryCount !== entryCount
    || entryCount < REQUIRED_PARTS.size
    || entryCount > MAX_ARCHIVE_ENTRIES
    || diskEntryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
    || eocdOffset + 22 + commentLength !== archive.length
    || centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
    return null;
  }

  const entries = new Map<string, ZipEntry>();
  const foldedNames = new Set<string>();
  let expandedBytes = 0;
  let cursor = centralDirectoryOffset;
  try {
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > eocdOffset
        || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_HEADER) {
        return null;
      }
      const flags = view.getUint16(cursor + 8, true);
      const compression = view.getUint16(cursor + 10, true);
      const crc32 = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const originalSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const entryCommentLength = view.getUint16(cursor + 32, true);
      const diskStart = view.getUint16(cursor + 34, true);
      const externalAttributes = view.getUint32(cursor + 38, true);
      const localHeaderOffset = view.getUint32(cursor + 42, true);
      const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
      if (next > eocdOffset
        || diskStart !== 0
        || compressedSize === 0xffffffff
        || originalSize === 0xffffffff
        || localHeaderOffset === 0xffffffff
        || (flags & ~ALLOWED_GENERAL_PURPOSE_FLAGS) !== 0
        || (compression !== 0 && compression !== 8)
        || hasZip64Extra(archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
        || isUnixSymlink(view.getUint16(cursor + 4, true), externalAttributes)) {
        return null;
      }
      const name = decodeZipName(archive.subarray(cursor + 46, cursor + 46 + nameLength), flags);
      if (!name
        || !isSafeArchiveName(name)
        || foldedNames.has(name.toLowerCase())
        || originalSize > MAX_SINGLE_ENTRY_BYTES
        || originalSize > Math.max(compressedSize, 1) * MAX_COMPRESSION_RATIO) {
        return null;
      }
      const requiredLimit = name === DOCUMENT_PART
        ? MAX_DOCUMENT_XML_BYTES
        : REQUIRED_PARTS.has(name)
          ? MAX_PACKAGE_METADATA_BYTES
          : MAX_SINGLE_ENTRY_BYTES;
      if (originalSize > requiredLimit) return null;
      expandedBytes += originalSize;
      if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) return null;

      foldedNames.add(name.toLowerCase());
      entries.set(name, {
        name,
        flags,
        compression,
        crc32,
        compressedSize,
        originalSize,
        localHeaderOffset,
      });
      cursor = next;
    }
  } catch {
    return null;
  }
  return cursor === eocdOffset ? { entries, centralDirectoryOffset } : null;
}

function extractZipEntry(
  archive: Uint8Array,
  entry: ZipEntry,
  centralDirectoryOffset: number,
): { content: Uint8Array; start: number; end: number } | null {
  const offset = entry.localHeaderOffset;
  if (offset < 0 || offset + 30 > centralDirectoryOffset) return null;
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER) return null;
  const flags = view.getUint16(offset + 6, true);
  const compression = view.getUint16(offset + 8, true);
  const localCrc32 = view.getUint32(offset + 14, true);
  const localCompressedSize = view.getUint32(offset + 18, true);
  const localOriginalSize = view.getUint32(offset + 22, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralDirectoryOffset
    || flags !== entry.flags
    || compression !== entry.compression
    || hasZip64Extra(archive.subarray(offset + 30 + nameLength, dataStart))) {
    return null;
  }
  const localName = decodeZipName(archive.subarray(offset + 30, offset + 30 + nameLength), flags);
  if (localName !== entry.name) return null;
  const usesDataDescriptor = (flags & 0x0008) !== 0;
  if (!usesDataDescriptor
    && (localCrc32 !== entry.crc32
      || localCompressedSize !== entry.compressedSize
      || localOriginalSize !== entry.originalSize)) {
    return null;
  }
  if (usesDataDescriptor
    && ((localCrc32 !== 0 && localCrc32 !== entry.crc32)
      || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
      || (localOriginalSize !== 0 && localOriginalSize !== entry.originalSize))) {
    return null;
  }

  const compressed = archive.subarray(dataStart, dataEnd);
  let content: Uint8Array;
  try {
    content = entry.compression === 0
      ? compressed.slice()
      : inflateRawSync(compressed, { maxOutputLength: entry.originalSize });
  } catch {
    return null;
  }
  if (content.length !== entry.originalSize
    || (entry.compression === 0 && entry.compressedSize !== entry.originalSize)
    || crc32(content) !== entry.crc32) {
    return null;
  }
  return { content, start: offset, end: dataEnd };
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

function decodeZipName(value: Uint8Array, flags: number): string | null {
  if (value.length < 1 || value.length > MAX_ENTRY_NAME_CHARS * 4) return null;
  try {
    if ((flags & 0x0800) === 0 && value.some((byte) => byte > 0x7f)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

function hasZip64Extra(value: Uint8Array): boolean {
  let cursor = 0;
  while (cursor < value.length) {
    if (cursor + 4 > value.length) return true;
    const id = value[cursor] | (value[cursor + 1] << 8);
    const size = value[cursor + 2] | (value[cursor + 3] << 8);
    cursor += 4;
    if (cursor + size > value.length || id === 0x0001) return true;
    cursor += size;
  }
  return false;
}

function isUnixSymlink(versionMadeBy: number, externalAttributes: number): boolean {
  const hostSystem = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  return hostSystem === 3 && (unixMode & 0xf000) === 0xa000;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function isSafeArchiveName(value: string): boolean {
  if (!value
    || value.length > MAX_ENTRY_NAME_CHARS
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001F\u007F]/.test(value)
    || /^[A-Za-z]:/.test(value)
    || value.includes("//")) {
    return false;
  }
  const segments = value.endsWith("/") ? value.slice(0, -1).split("/") : value.split("/");
  return segments.length > 0 && segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function hasZipSignature(value: Uint8Array): boolean {
  return value.length >= 4
    && value[0] === 0x50
    && value[1] === 0x4b
    && value[2] === 0x03
    && value[3] === 0x04;
}

function decodeXmlPart(value: Uint8Array | undefined, maxBytes: number): string | null {
  if (!value || value.length < 1 || value.length > maxBytes) return null;
  try {
    if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) {
      return new TextDecoder("utf-16le", { fatal: true }).decode(value.subarray(2));
    }
    if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) {
      return new TextDecoder("utf-16be", { fatal: true }).decode(value.subarray(2));
    }
    const offset = value.length >= 3
      && value[0] === 0xef
      && value[1] === 0xbb
      && value[2] === 0xbf
      ? 3
      : 0;
    return new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(offset));
  } catch {
    return null;
  }
}

function isWordDocumentPackage(contentTypes: string, relationships: string): boolean {
  if (!hasSafeXmlEnvelope(contentTypes) || !hasSafeXmlEnvelope(relationships)) return false;
  return contentTypes.includes("/word/document.xml")
    && contentTypes.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")
    && relationships.includes("officeDocument")
    && relationships.includes("word/document.xml");
}

function extractWordDocumentText(xml: string): string | null {
  if (!hasSafeXmlEnvelope(xml)
    || !/<w:document(?:\s|>)/.test(xml)
    || !/<w:body(?:\s|>)/.test(xml)) {
    return null;
  }

  const stack: string[] = [];
  const output: string[] = [];
  let outputLength = 0;
  let textDepth = 0;
  let cursor = 0;
  let sawDocument = false;
  let sawBody = false;
  let sawText = false;

  const append = (value: string) => {
    if (!value || outputLength >= MAX_EXTRACTED_CHARS) return;
    const remaining = MAX_EXTRACTED_CHARS - outputLength;
    const bounded = value.length > remaining ? value.slice(0, remaining) : value;
    output.push(bounded);
    outputLength += bounded.length;
  };

  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart === -1) {
      if (textDepth > 0) {
        const text = decodeXmlText(xml.slice(cursor));
        if (text === null) return null;
        append(text);
        sawText ||= text.length > 0;
      }
      cursor = xml.length;
      break;
    }

    if (textDepth > 0 && tagStart > cursor) {
      const text = decodeXmlText(xml.slice(cursor, tagStart));
      if (text === null) return null;
      append(text);
      sawText ||= text.length > 0;
    }

    if (xml.startsWith("<!--", tagStart)) {
      const commentEnd = xml.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) return null;
      cursor = commentEnd + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const instructionEnd = xml.indexOf("?>", tagStart + 2);
      if (instructionEnd === -1) return null;
      cursor = instructionEnd + 2;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) return null;

    const tagEnd = findTagEnd(xml, tagStart + 1);
    if (tagEnd === -1) return null;
    const rawTag = xml.slice(tagStart + 1, tagEnd).trim();
    const closing = rawTag.startsWith("/");
    const selfClosing = rawTag.endsWith("/");
    const tagBody = rawTag.slice(closing ? 1 : 0, selfClosing ? -1 : undefined).trim();
    const name = tagBody.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1];
    if (!name) return null;

    if (closing) {
      if (selfClosing || stack.pop() !== name) return null;
      if (name === "w:t") textDepth -= 1;
      if (textDepth < 0) return null;
      if (name === "w:p" || name === "w:tr") append("\n");
      else if (name === "w:tc") append("\t");
    } else {
      if (name === "w:document") sawDocument = true;
      if (name === "w:body") sawBody = true;
      if (name === "w:t") textDepth += 1;
      if (name === "w:tab") append("\t");
      else if (name === "w:br" || name === "w:cr") append("\n");
      if (!selfClosing) {
        stack.push(name);
        if (stack.length > MAX_XML_DEPTH) return null;
      } else if (name === "w:t") {
        textDepth -= 1;
      }
    }
    cursor = tagEnd + 1;
  }

  if (stack.length !== 0 || textDepth !== 0 || !sawDocument || !sawBody || !sawText) return null;
  const normalized = output.join("")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n\t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\t{2,}/g, "\t")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized || null;
}

function hasSafeXmlEnvelope(value: string): boolean {
  return value.length > 0
    && !/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value)
    && !value.includes("\u0000");
}

function findTagEnd(xml: string, start: number): number {
  let quote = "";
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

function decodeXmlText(value: string): string | null {
  if (!value.includes("&")) return value;
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const entityStart = value.indexOf("&", cursor);
    if (entityStart === -1) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, entityStart);
    const entityEnd = value.indexOf(";", entityStart + 1);
    if (entityEnd === -1 || entityEnd - entityStart > 16) return null;
    const decoded = decodeXmlEntity(value.slice(entityStart + 1, entityEnd));
    if (decoded === null) return null;
    output += decoded;
    cursor = entityEnd + 1;
  }
  return output;
}

function decodeXmlEntity(value: string): string | null {
  switch (value) {
    case "amp": return "&";
    case "lt": return "<";
    case "gt": return ">";
    case "quot": return "\"";
    case "apos": return "'";
    default: {
      const numeric = /^#x[0-9A-Fa-f]+$/.test(value)
        ? Number.parseInt(value.slice(2), 16)
        : /^#[0-9]+$/.test(value)
          ? Number.parseInt(value.slice(1), 10)
          : Number.NaN;
      if (!Number.isInteger(numeric)
        || numeric < 0x09
        || numeric > 0x10ffff
        || (numeric >= 0xd800 && numeric <= 0xdfff)
        || (numeric >= 0x0e && numeric <= 0x1f)
        || numeric === 0x7f) {
        return null;
      }
      return String.fromCodePoint(numeric);
    }
  }
}
