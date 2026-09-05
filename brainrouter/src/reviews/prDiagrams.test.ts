import { describe, expect, it } from "vitest";
import { listPrDiagrams, extractDiagramSvg, diagramShareCard } from "./prDiagrams.js";

const HTML = '<!doctype html>\n<html lang="en" data-theme="auto" data-diagram-kind="architecture" data-renderer="brainrouter-diagram/1.0.0">\n<head><title>Checkout &amp; billing</title></head><body><svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500"><rect x="10" y="10" width="200" height="80"/></svg></body></html>';
const RECEIPT = JSON.stringify({ receiptVersion: 1, kind: 'architecture', title: 'Checkout & billing', ok: true, artifact: { sha256: 'abcdef0123456789deadbeef' }, specification: { sha256: 'feedface' }, renderer: { name: 'brainrouter-diagram', version: '1.0.0' } });

function fakeFetch(files: Record<string, string>, dir: string[]): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = new URL(url); const rel = decodeURIComponent(u.pathname.split('/contents/')[1] ?? '');
    if (rel === '.brainrouter/diagrams' && !init?.headers?.Accept?.includes('raw')) return { ok: true, status: 200, json: async () => dir.map((name) => ({ name, path: `.brainrouter/diagrams/${name}`, type: 'file', size: 10 })), text: async () => '' };
    const body = files[rel];
    return body === undefined ? { ok: false, status: 404, json: async () => ({}), text: async () => '' } : { ok: true, status: 200, json: async () => ({}), text: async () => body };
  }) as unknown as typeof fetch;
}

describe("ADR-056 A7 — PR diagrams at head + share card", () => {
  const input = { apiBase: 'https://api.github.com', repo: 'o/r', ref: 'abc123', headers: { Authorization: 'Bearer t' } };

  it("lists the diagrams the head carries, with receipt facts, and skips non-slugs and missing html", async () => {
    const fetchImpl = fakeFetch({ '.brainrouter/diagrams/checkout.html': HTML, '.brainrouter/diagrams/checkout.receipt.json': RECEIPT, '.brainrouter/diagrams/orphan.receipt.json': RECEIPT }, ['checkout.html', 'checkout.json', 'checkout.receipt.json', 'Not A Slug.html', 'orphan.html', 'orphan.receipt.json']);
    const diagrams = await listPrDiagrams({ ...input, fetchImpl });
    expect(diagrams.map((d) => d.slug)).toEqual(['checkout']);
    expect(diagrams[0]).toMatchObject({ title: 'Checkout & billing', kind: 'architecture', receipt: { ok: true, artifactSha256: 'abcdef0123456789deadbeef', rendererVersion: '1.0.0' } });
    expect(diagrams[0].html).toContain('<svg');
  });

  it("returns nothing when the head has no diagrams directory", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })) as unknown as typeof fetch;
    expect(await listPrDiagrams({ ...input, fetchImpl })).toEqual([]);
  });

  it("extracts the inline svg and builds a 1200×630 card that nests it scaled, with title, kind, repo and receipt", () => {
    const svg = extractDiagramSvg(HTML)!;
    expect(svg.startsWith('<svg')).toBe(true); expect(svg.endsWith('</svg>')).toBe(true);
    const card = diagramShareCard({ title: 'Checkout & billing', kind: 'architecture', repo: 'o/r', number: 7, svg, receiptSha256: 'abcdef0123456789deadbeef' });
    expect(card).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
    expect(card).toContain('Checkout &amp; billing');
    expect(card).toContain('architecture · o/r#7 · receipt abcdef012345');
    expect(card).toMatch(/<svg x="\d+" y="\d+" width="\d+" height="\d+" viewBox="0 0 900 500" preserveAspectRatio="xMidYMid meet"/);
    expect((card.match(/<svg/g) ?? []).length).toBe(2);
    expect(extractDiagramSvg('<html><body>no drawing</body></html>')).toBeNull();
  });
});
