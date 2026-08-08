/**
 * ADR-029 F1 — every block kind is drawn as that kind, on the dashboard too.
 *
 * The desktop has exactly this test (`partFRenderers.test.ts`) and it is why the
 * desktop's gap was caught. The dashboard had no such test, and that is why the
 * same gap survived Part F on this surface: `table`, `table-row`, `embed`,
 * `synced` and a nested `database` all fell through the renderer's `default:`
 * and drew as a plain line of text. A person opening a page that contained a
 * table saw a row of pipe-separated characters where their table was.
 *
 * **It lives in the backend workspace because that is where the repo can run
 * it.** `brainrouter-dashboard` has thirteen `node:test` files, no `test`
 * script, and CI says so out loud — "dashboard has no test script and is
 * skipped" (`.github/workflows/ci.yml`). Wiring a runner for that workspace is a
 * decision about thirteen files that have never run, not a thing to do inside a
 * renderer fix. This suite runs on every push, imports core directly (the
 * dashboard may not — `scripts/check-package-boundaries.mjs` allows it hooks,
 * sdk and types only), and reads the page as text, which is the shape
 * `notes-routes.test.ts` beside it already uses for the same file.
 *
 * The assertion is not "the component compiles". It is ADR-028 E1's rule applied
 * to what the surface draws: for every kind core defines, name the thing that
 * DRAWS it. A kind that reaches nothing but the shared prose line fails here —
 * which is exactly the state five of them shipped in.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_TABLE_COLUMNS, NOTE_BLOCK_KINDS, parseTableRow, tableCells, tableWidth,
} from "@kinqs/brainrouter-core/notes";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = (...segments: string[]): string =>
  fs.readFileSync(path.join(here, "..", "..", "..", "brainrouter-dashboard", "app", "notes", ...segments), "utf8");

const page = dashboard("page.tsx");
const cells = dashboard("tableCells.ts");
const stylesheet = dashboard("notes.module.css");

/**
 * The file with its prose removed.
 *
 * One assertion below is "this surface does not compose core's sentences", and
 * the comments explaining WHY quote those sentences — so a whole-file search
 * fails on the explanation rather than on the defect. The `//` rule spares
 * `brainrouter://`, which is a URI and not a comment.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const pageCode = withoutComments(page);

/**
 * The renderer, sliced out of the file.
 *
 * The claim is about the block renderer's switch specifically, not about the
 * word appearing anywhere in a 1,400-line page — a `case "table"` in some other
 * switch would satisfy a whole-file search while a table still drew as a line.
 */
const renderer = (() => {
  const start = page.indexOf("function BlockBody(");
  expect(start, "the block renderer has been renamed; this test can no longer find it").toBeGreaterThan(-1);
  const end = page.indexOf("\n}\n", start);
  return page.slice(start, end === -1 ? undefined : end);
})();

/**
 * The kinds that legitimately render as plain prose.
 *
 * One entry, and it has to stay one: a paragraph IS plain text, so framing it
 * would be inventing chrome over somebody's writing. Every other kind means
 * something the prose line cannot say — a checkbox, a grid, a live target — and
 * adding a kind here to make this test pass is the F1 defect being re-committed
 * with the alarm switched off.
 */
const PROSE_KINDS = new Set<string>(["paragraph"]);

/**
 * Where each kind is drawn, and what proves it.
 *
 * Every row names a real thing in a real file. "The model supports it" is not
 * built (§5), and neither is "there is a case for it" on its own — the evidence
 * has to be the route a reader's eye actually takes.
 */
const DRAWN_BY: Record<string, { by: string; evidence: RegExp }> = {
  heading: { by: "a size class by level", evidence: /styles\.h1 : level === 2/ },
  bullet: { by: "a gutter marker", evidence: /styles\.bullet}>•/ },
  numbered: { by: "a gutter marker", evidence: /styles\.bullet}>–/ },
  todo: { by: "a checkbox glyph and a struck-through body", evidence: /styles\.todoDone/ },
  toggle: { by: "a disclosure marker", evidence: /styles\.bullet}>▸/ },
  quote: { by: "a ruled indent", evidence: /styles\.quote/ },
  callout: { by: "an icon and a framed panel", evidence: /styles\.callout/ },
  code: { by: "a preformatted block", evidence: /<pre className=\{styles\.code}/ },
  divider: { by: "a rule", evidence: /<hr className=\{styles\.divider}/ },
  image: { by: "the image itself", evidence: /<img className=\{styles\.image}/ },
  bookmark: { by: "a link out", evidence: /rel="noreferrer noopener"/ },
  page: { by: "a sub-page row", evidence: /styles\.block} \$\{styles\.ref}/ },
  // The five Part F left inert on this surface. Each is a component, because a
  // class name on the prose line is what the first four of these had.
  table: { by: "the grid", evidence: /<TableBlock/ },
  "table-row": { by: "a one-row grid", evidence: /<TableGrid rows=\{\[block\]}/ },
  embed: { by: "the live resolved target", evidence: /<EmbedBlock/ },
  synced: { by: "the mirrored source's own rows", evidence: /<SyncedBlock/ },
  database: { by: "the shared database view", evidence: /<NestedDatabase/ },
};

describe("ADR-029 F1 — the dashboard draws every kind", () => {
  it("every kind core defines has a case in the renderer, and prose is the only exception", () => {
    for (const kind of NOTE_BLOCK_KINDS) {
      if (PROSE_KINDS.has(kind)) {
        // Asserted rather than skipped: if a paragraph ever grows a case, the
        // exemption above has stopped describing the code.
        expect(
          renderer.includes(`case "${kind}":`),
          `${kind} is exempt because it renders as prose, and it now has a case`,
        ).toBe(false);
        continue;
      }
      expect(
        renderer.includes(`case "${kind}":`),
        `a ${kind} block falls through to the prose line. That is ADR-029 F1's defect: `
        + "the kind is stored, the merge is correct, and a person sees a line of text where their "
        + `${kind} is. Give it a case in the dashboard's block renderer.`,
      ).toBe(true);
    }
  });

  it("each case reaches something that actually draws it", () => {
    for (const kind of NOTE_BLOCK_KINDS) {
      if (PROSE_KINDS.has(kind)) continue;
      const drawn = DRAWN_BY[kind];
      expect(
        drawn,
        `${kind} is in core's kinds and nothing in this test claims to draw one. `
        + "A kind with a case and no renderer is the same defect one layer in.",
      ).toBeDefined();
      expect(
        drawn!.evidence.test(renderer),
        `a ${kind} is drawn by ${drawn!.by}, and that is no longer there.`,
      ).toBe(true);
    }
  });

  it("prose still has somewhere to land", () => {
    // The counterpart to the exemption: a renderer with no `default:` would fail
    // every kind that is meant to be plain, which is not an improvement.
    expect(renderer).toContain("default:");
  });

  it("the five that were inert are components, not class names on the prose line", () => {
    // Named individually rather than left to the loop, because these are the
    // exact five that shipped offered-and-inert here. A future edit that deletes
    // one route would otherwise only fail a generic assertion.
    for (const component of ["TableBlock", "TableGrid", "EmbedBlock", "SyncedBlock", "NestedDatabase"]) {
      expect(page, `${component} lost its definition`).toContain(`function ${component}(`);
      expect(page, `${component} is defined but never rendered`).toContain(`<${component}`);
    }
  });
});

describe("ADR-029 A3/A4 — what a resolved reference is allowed to say", () => {
  it("the embed and the mirror resolve through the shared, permission-aware resolver", () => {
    // Q5's decision: resolution is a server capability because this surface has
    // no local store. Reaching for the block directly would be the widened read
    // A4 refuses, and it would answer for blocks the server would not hand over.
    expect(page).toContain("/api/workspace/resolve?uri=");
    expect(page).not.toContain("/api/notes/blocks?");
  });

  it("the refusal sentences are the server's, so this surface cannot write its own", () => {
    // A4's rule is a property of the product: six surfaces each composing their
    // own "you cannot see this" is six chances for one of them to write the
    // title instead. `renderWorkspaceResolution` writes them once, and the
    // dashboard renders `resolved.line`.
    expect(page).toContain("resolved.line");
    for (const wording of ["do not have access", "(deleted", "no longer exists"]) {
      expect(
        pageCode.includes(wording),
        `"${wording}" is core's wording for a resolution outcome and this file has composed its own`,
      ).toBe(false);
    }
  });

  it("a link a note carries cannot become a script", () => {
    // C4 reaching the DOM. A note's text arrives over sync and can be written by
    // anybody a page is shared with, and this surface is where it becomes an
    // `href` — both for an inline `[label](…)` and for a bookmark block.
    expect(page).toContain("function safeHref(");
    expect(pageCode).toMatch(/href = safeHref\(/);
    expect(pageCode).not.toMatch(/href=\{text}/);
  });

  it("a mirror's depth is bounded, so a mirror of an ancestor stops instead of hanging", () => {
    expect(page).toContain("MAX_SYNCED_DEPTH");
    expect(page).toMatch(/depth >= MAX_SYNCED_DEPTH/);
  });
});

describe("ADR-029 F3 — comments, and the file people leave with", () => {
  it("comments are drawn on the block that carries them", () => {
    expect(page).toContain("function BlockComments(");
    expect(page).toContain("<BlockComments");
    // Resolved and unresolved are distinguished, which is the whole of F3's row.
    expect(page).toMatch(/comment\.resolved\.value/);
  });

  it("comment text is rendered as text, because a comment is written by a person", () => {
    // The one field on a page a stranger can write. C4: content is data, never
    // instructions — and never markup either.
    expect(page).toContain("{comment.body.value}");
    expect(page).not.toContain("dangerouslySetInnerHTML");
  });

  it("the write goes through the one route, from both places that offer it", () => {
    expect(page).toContain("async function postComment(");
    expect(page).toContain("async function setCommentResolved(");
    expect(page).toContain('method: "POST", body: { body }');
    expect(page).toContain('method: "PATCH", body: { resolved }');
  });

  it("the export offers what the server says the block can be written as", () => {
    // F1 again: `exportFormatsFor` decides in core and travels on the read, so
    // the dashboard and the desktop cannot disagree about what is exportable —
    // and no menu here offers CSV for a page of paragraphs.
    expect(page).toContain("formats={view?.exportFormats ?? []}");
    expect(page).toContain("formats.map((format)");
    expect(page).not.toMatch(/const\s+\w*[Ff]ormats\s*(:\s*[^=]+)?=\s*\[\s*"markdown"/);
  });

  it("a database nested in a page reuses the one projection and the one view set", () => {
    // E3: a second projection would be a second view language, and the symptom
    // is one board showing different cards on two screens.
    expect(page).toContain("/api/notes/databases/");
    const nested = page.slice(page.indexOf("function NestedDatabase("));
    expect(nested).toContain("<DatabaseReader");
  });
});

describe("the table decoder the boundary forces this surface to keep", () => {
  /**
   * The dashboard may not import core (`check-package-boundaries.mjs` gives it
   * hooks, sdk and types), so `app/notes/tableCells.ts` re-implements the row
   * encoding core defines in `packages/core/src/notes/tableBlock.ts`. These pin
   * the CONTRACT that copy claims to implement: if core's encoding changes, this
   * fails here and names the file that has to change with it.
   */
  it("core's encoding is what the copy says it is", () => {
    expect(parseTableRow("a|b|c")).toEqual(["a", "b", "c"]);
    // The two escapes, and the order they have to be undone in.
    expect(parseTableRow("a\\|b|c")).toEqual(["a|b", "c"]);
    expect(parseTableRow("a\\\\|b")).toEqual(["a\\", "b"]);
    // A lone backslash is kept as itself rather than swallowing the next
    // character, which is the case a naive unescape gets wrong.
    expect(parseTableRow("a\\b")).toEqual(["a\\b"]);
    expect(parseTableRow("")).toEqual([""]);
    expect(tableWidth(["a|b", "c"])).toBe(2);
    expect(tableCells("c", 2)).toEqual(["c", ""]);
  });

  it("the dashboard's copy carries the same branches and the same bound", () => {
    expect(cells).toContain(`export const MAX_TABLE_COLUMNS = ${MAX_TABLE_COLUMNS};`);
    // Both escape branches, and the overflow that joins the tail into the last
    // cell rather than dropping it — content gone with no notice is the one
    // failure a reader cannot see.
    expect(cells).toContain('if (next === "\\\\" || next === "|")');
    expect(cells).toContain('text.slice(i + 1).replace(/\\\\([\\\\|])/g, "$1")');
    // It decodes and never encodes: an encoder here would be a second WRITER of
    // the format, which is the thing that could store a row the desktop reads
    // back differently.
    expect(cells).not.toContain("export function formatTableRow");
  });

  it("the grid is styled, so a table does not render as an unframed run of text", () => {
    for (const rule of [".table.grid th", ".embed", ".synced", ".nestedDatabase", ".blockThread"]) {
      expect(stylesheet.includes(rule), `${rule} has no styling, so its block renders unframed`).toBe(true);
    }
    // Part F introduces no colour of its own on this surface either: every value
    // it adds is one of the tokens already in the sheet.
    const added = stylesheet.slice(stylesheet.indexOf("F1 · the kinds that drew as plain lines"));
    expect(
      /#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/.test(added),
      "Part F must not add a colour — the design language is a border, a tint and a weight",
    ).toBe(false);
  });
});
