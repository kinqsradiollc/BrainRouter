import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { extractKnowledgeDocxText } from "../knowledge/services/docx-parser.js";

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
  <Relationship Id="external"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
    TargetMode="External" Target="https://internal.invalid/private"/>
</Relationships>`;

function wordDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;
}

function docx(parts: Record<string, string> = {}): Uint8Array {
  const entries: Zippable = {
    "[Content_Types].xml": strToU8(parts["[Content_Types].xml"] ?? contentTypes),
    "_rels/.rels": strToU8(parts["_rels/.rels"] ?? relationships),
    "word/document.xml": strToU8(parts["word/document.xml"] ?? wordDocument(
      "<w:p><w:r><w:t>Default document</w:t></w:r></w:p>",
    )),
  };
  for (const [name, value] of Object.entries(parts)) {
    if (name in entries) continue;
    entries[name] = strToU8(value);
  }
  return zipSync(entries, { level: 6 });
}

function forgeDeclaredDocumentSize(archive: Uint8Array, declaredSize: number): Uint8Array {
  const forged = archive.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  for (let cursor = 0; cursor + 46 <= forged.length; cursor += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(forged.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name !== "word/document.xml") continue;
    const localOffset = view.getUint32(cursor + 42, true);
    view.setUint32(cursor + 24, declaredSize, true);
    view.setUint32(localOffset + 22, declaredSize, true);
    return forged;
  }
  throw new Error("Expected the generated DOCX to contain word/document.xml");
}

function corruptStoredDocumentPayload(archive: Uint8Array): Uint8Array {
  const corrupted = archive.slice();
  const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
  for (let cursor = 0; cursor + 46 <= corrupted.length; cursor += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(corrupted.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name !== "word/document.xml") continue;
    const localOffset = view.getUint32(cursor + 42, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    corrupted[dataStart] ^= 0x01;
    return corrupted;
  }
  throw new Error("Expected the generated DOCX to contain word/document.xml");
}

describe("bounded DOCX text extraction", () => {
  it("extracts only main-document text and preserves paragraph controls", () => {
    const archive = docx({
      "word/document.xml": wordDocument(`
        <w:p><w:r><w:t>Deployment &amp; rollout</w:t><w:tab/><w:t>owner</w:t></w:r></w:p>
        <w:p><w:r><w:t>Line&#x20;two</w:t><w:br/><w:t>Line three</w:t></w:r></w:p>
      `),
      "word/media/private.txt": "SECRET_TOKEN=not-document-text",
    });

    expect(extractKnowledgeDocxText(archive)).toBe(
      "Deployment & rollout\towner\nLine two\nLine three",
    );
    expect(extractKnowledgeDocxText(archive)).not.toContain("internal.invalid");
    expect(extractKnowledgeDocxText(archive)).not.toContain("not-document-text");
  });

  it("rejects non-ZIP, incomplete, traversal, and case-colliding packages", () => {
    expect(extractKnowledgeDocxText(strToU8("not a ZIP"))).toBeNull();
    expect(extractKnowledgeDocxText(zipSync({
      "word/document.xml": strToU8(wordDocument("<w:p><w:t>Text</w:t></w:p>")),
    }))).toBeNull();
    expect(extractKnowledgeDocxText(docx({ "../escape.txt": "unsafe" }))).toBeNull();
    expect(extractKnowledgeDocxText(docx({ "WORD/DOCUMENT.XML": "collision" }))).toBeNull();
  });

  it("rejects excessive entry counts and high-ratio expansion before extraction", () => {
    const manyParts: Record<string, string> = {};
    for (let index = 0; index < 1_022; index += 1) {
      manyParts[`custom/item-${index}.xml`] = "";
    }
    expect(extractKnowledgeDocxText(docx(manyParts))).toBeNull();

    const repeated = "A".repeat(1_000_000);
    expect(extractKnowledgeDocxText(docx({
      "word/document.xml": wordDocument(`<w:p><w:t>${repeated}</w:t></w:p>`),
    }))).toBeNull();
  });

  it("caps actual inflation even when local and central size fields lie", () => {
    const archive = docx({
      "word/document.xml": wordDocument(`<w:p><w:t>${"B".repeat(100_000)}</w:t></w:p>`),
    });
    expect(extractKnowledgeDocxText(forgeDeclaredDocumentSize(archive, 128))).toBeNull();
  });

  it("rejects stored content that does not match its declared CRC", () => {
    const archive = zipSync({
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(relationships),
      "word/document.xml": strToU8(wordDocument("<w:p><w:t>Integrity</w:t></w:p>")),
    }, { level: 0 });

    expect(extractKnowledgeDocxText(corruptStoredDocumentPayload(archive))).toBeNull();
  });

  it("rejects entity declarations, unknown entities, malformed XML, and empty text", () => {
    const invalidBodies = [
      `<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///private/secret">]>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p><w:t>&xxe;</w:t></w:p></w:body>
        </w:document>`,
      wordDocument("<w:p><w:t>&unknown;</w:t></w:p>"),
      wordDocument("<w:p><w:t>Unclosed</w:p>"),
      wordDocument("<w:p><w:r/></w:p>"),
    ];

    for (const documentXml of invalidBodies) {
      expect(extractKnowledgeDocxText(docx({ "word/document.xml": documentXml }))).toBeNull();
    }
  });
});
