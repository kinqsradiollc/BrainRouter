/**
 * ADR-058 D12 — the gateway honours a provider definition's declared request
 * limits and effort support exactly as the desktop/CLI transport does. Before
 * this, `buildUpstreamChatPayload` forwarded the client's full agent turn
 * (~120 KB, ~104 tools) verbatim; a 64 KiB-limited endpoint (Matilda) answered
 * 403 and the upstream-error mapping reported it as a 502 "authentication"
 * failure — while the very same turn succeeded on the desktop's direct path.
 */
import { describe, expect, it } from 'vitest';
import { buildUpstreamChatPayload } from './chatProtocol.js';
import type { GatewayResolvedModel } from './modelPolicy.js';

const BODY_LIMIT = 65_536;
const MSG_LIMIT = 16_000;
const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

function resolvedFor(endpoint: string, upstreamModelId: string, selectedEffort: string | null): GatewayResolvedModel {
  return {
    provider: { endpoint, apiKey: 'k' },
    model: {
      upstreamModelId,
      capabilities: { streaming: true, tools: true },
      // A per-model wire map that WOULD emit the field — the provider def must win.
      effortWireMap: { high: { reasoning_effort: 'high' } },
    },
    selectedEffort,
  } as unknown as GatewayResolvedModel;
}

function spec(name: string, description: string) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
}
// ~200 × ~1 KB tool specs with multi-byte characters (JS length under-counts wire bytes).
const heavy = () => Array.from({ length: 200 }, (_, i) => spec(`tool_${i}`, `Tool ${i} — does a thing — ${'—'.repeat(300)}`));

function request(body: Record<string, unknown>) {
  return { body, stream: false, usesTools: Array.isArray(body.tools), model: String(body.model), effort: 'high' } as any;
}

describe('buildUpstreamChatPayload honours ProviderDefinition.limits + reasoningEffort (ADR-058 D12)', () => {
  it('shapes a full agent turn for Matilda: ≤ 64 KiB UTF-8, messages ≤ 16k chars, relevant tools kept, no effort field', () => {
    const body = {
      model: 'matilda',
      messages: [
        { role: 'system', content: 'INSTRUCTIONS-FIRST ' + 'x'.repeat(25_000) },
        { role: 'user', content: 'please read the file at src/index.ts' },
      ],
      tools: [...heavy(), spec('read_file', 'Read a file from the workspace')],
      tool_choice: 'auto',
    };
    const out = buildUpstreamChatPayload(request(body), resolvedFor('https://matilda.maincode.com/api/v1', 'matilda', 'high'));
    const json = JSON.stringify(out);
    expect(utf8(json)).toBeLessThanOrEqual(BODY_LIMIT);
    const messages = out.messages as Array<{ content: string }>;
    expect(messages[0].content.length).toBeLessThanOrEqual(MSG_LIMIT);
    expect(messages[0].content.startsWith('INSTRUCTIONS-FIRST')).toBe(true);
    const kept = (out.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(201);
    expect(kept).toContain('read_file');
    // The provider def says `reasoningEffort: 'unsupported'` — the per-model wire
    // map must not put the field back (Matilda 400s on it).
    expect('reasoning_effort' in out).toBe(false);
    expect('reasoning' in out).toBe(false);
    expect(out.model).toBe('matilda');
  });

  it('leaves a provider with no declared limits untouched and still applies its effort wire map', () => {
    const body = {
      model: 'gpt-5',
      messages: [{ role: 'system', content: 'x'.repeat(25_000) }, { role: 'user', content: 'hi' }],
      tools: heavy(),
      tool_choice: 'auto',
    };
    const out = buildUpstreamChatPayload(request(body), resolvedFor('https://api.openai.com/v1', 'gpt-5', 'high'));
    expect((out.messages as Array<{ content: string }>)[0].content.length).toBe(25_000);
    expect((out.tools as unknown[]).length).toBe(200);
    expect(out.reasoning_effort).toBe('high');
  });
});
