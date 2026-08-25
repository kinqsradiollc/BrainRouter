/**
 * ADR-049 S1 / D5 — deck import/export codecs. Portable in both directions
 * (including from the incumbent flashcard apps), and pure so they are trivially
 * tested and safe for the renderer to call.
 *
 *  - Import: tab- or comma-delimited `front<sep>back<sep>tags` rows (Quizlet's
 *    export shape), tolerant of quoted CSV fields and blank/`#` lines.
 *  - Export: a readable Markdown table, or RFC-4180 CSV.
 */
import type { StudyCard, StudyCardProposal, StudyDeck } from "@kinqs/brainrouter-types";

/** One row parsed from delimited text — a proposal (no id yet). */
export function parseDelimitedCards(
  text: string,
  opts: { delimiter?: "\t" | "," | "auto" } = {},
): StudyCardProposal[] {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const delimiter = opts.delimiter && opts.delimiter !== "auto"
    ? opts.delimiter
    : raw.includes("\t") ? "\t" : ",";
  const rows: StudyCardProposal[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const fields = delimiter === "," ? splitCsvLine(line) : line.split("\t");
    const front = (fields[0] ?? "").trim();
    const back = (fields[1] ?? "").trim();
    if (!front || !back) continue;
    const tags = (fields[2] ?? "")
      .split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    rows.push({ front, back, format: "basic", tags });
  }
  return rows;
}

/** Split one CSV line honoring double-quoted fields with `""` escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Render a deck as RFC-4180 CSV (`front,back,tags`), tags `;`-joined. */
export function deckToCsv(deck: StudyDeck): string {
  const lines = ["front,back,tags"];
  for (const card of deck.cards) {
    lines.push([card.front, card.back, card.tags.join(";")].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function mdCell(value: string): string {
  return value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

/** Render a deck as a readable Markdown table (front · back · tags). */
export function deckToMarkdown(deck: StudyDeck): string {
  const head = `# ${deck.name}\n\n${deck.description ? deck.description + "\n\n" : ""}`;
  const rows = deck.cards.map(
    (c) => `| ${mdCell(c.front)} | ${mdCell(c.back)} | ${c.tags.map(mdCell).join(", ")} |`,
  );
  return `${head}| Front | Back | Tags |\n|---|---|---|\n${rows.join("\n")}\n`;
}

/** Materialize import proposals into cards with the given id factory + clock. */
export function proposalsToCards(
  proposals: readonly StudyCardProposal[],
  makeId: (index: number) => string,
  createdAt: string,
): StudyCard[] {
  return proposals.map((p, i) => ({
    id: makeId(i),
    front: p.front,
    back: p.back,
    format: p.format,
    tags: [...p.tags],
    ...(p.provenance ? { provenance: p.provenance } : {}),
    createdAt,
  }));
}
