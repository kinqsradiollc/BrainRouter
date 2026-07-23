import { describe, expect, it } from "vitest";
import { extractKnowledgeHtmlText } from "../knowledge/services/html-parser.js";

describe("extractKnowledgeHtmlText", () => {
  it("preserves readable structure and decodes bounded text entities", () => {
    expect(extractKnowledgeHtmlText(`
      <!doctype html>
      <article>
        <h1>Setup &amp; deployment</h1>
        <p>Run&nbsp;<strong>verify</strong> before release.</p>
        <ul><li>Build</li><li>Test &#x1F680;</li></ul>
      </article>
    `)).toBe("Setup & deployment\nRun verify before release.\nBuild\nTest 🚀");
  });

  it("drops executable, metadata, template, comment, and attribute content", () => {
    const text = extractKnowledgeHtmlText(`
      <head><title>Private metadata</title></head>
      <main data-secret="attribute-secret">
        <a href="https://credential.example/token">Visible label</a>
        <!-- comment-secret -->
        <script>fetch("https://script.example/secret")</script>
        <style>.secret { background: url(https://style.example/secret) }</style>
        <template>template-secret</template>
        <noscript>noscript-secret</noscript>
      </main>
    `);

    expect(text).toBe("Visible label");
    expect(text).not.toMatch(/attribute-secret|credential\.example|script\.example|style\.example|secret/i);
  });

  it("fails closed on unterminated comments, tags, and omitted elements", () => {
    expect(extractKnowledgeHtmlText("Visible<!-- hidden forever")).toBe("Visible");
    expect(extractKnowledgeHtmlText("Visible<div title='unterminated>hidden")).toBe("Visible");
    expect(extractKnowledgeHtmlText("Visible<script>hidden<div>also hidden")).toBe("Visible");
  });

  it("removes control entities and normalizes excessive whitespace", () => {
    expect(extractKnowledgeHtmlText("<p>A&#0;   B</p>\r\n\r\n\r\n<p>C</p>"))
      .toBe("A B\nC");
  });
});
