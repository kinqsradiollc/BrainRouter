import { describe, expect, it } from "vitest";
import { renderShareMarkdown } from "./publicShare.js";

describe("public share markdown — safe rendering", () => {
  it("escapes HTML so user content can never inject markup (XSS)", () => {
    const html = renderShareMarkdown("<script>alert(1)</script>\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders headings, bold, code, and lists from escaped text", () => {
    const html = renderShareMarkdown("## Summary\n\nWe shipped **Track** and `api`.\n\n- one\n- two");
    expect(html).toContain("<h3>Summary</h3>"); // ## → h3 (level+1)
    expect(html).toContain("<strong>Track</strong>");
    expect(html).toContain("<code>api</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
  });

  it("does not turn a markdown link into a live anchor (escaped)", () => {
    const html = renderShareMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:alert(1)\"");
  });
});
