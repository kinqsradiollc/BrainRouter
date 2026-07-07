import { describe, expect, it } from "vitest";
import { resolveRequestUrl, buildRequestBody, extractResponsesText, isResponsesWire } from "../providers/wireFormat.js";

const OAI = "https://api.openai.com/v1";

describe("WIRE-FORMAT — base URL resolution (both responses + completions)", () => {
  it("bare base → appends the wire path", () => {
    expect(resolveRequestUrl(OAI, "chat-completions")).toBe(`${OAI}/chat/completions`);
    expect(resolveRequestUrl(OAI, "responses")).toBe(`${OAI}/responses`);
    expect(resolveRequestUrl(OAI, undefined)).toBe(`${OAI}/chat/completions`); // default
    expect(resolveRequestUrl(`${OAI}/`, "responses")).toBe(`${OAI}/responses`); // trailing slash
  });

  it("a saved /chat/completions URL still works for BOTH wires (the 'base URL cause')", () => {
    const full = `${OAI}/chat/completions`;
    expect(resolveRequestUrl(full, "chat-completions")).toBe(full); // as-is
    expect(resolveRequestUrl(full, "responses")).toBe(`${OAI}/responses`); // swapped
  });

  it("a saved /responses URL swaps back to completions when asked", () => {
    expect(resolveRequestUrl(`${OAI}/responses`, "chat-completions")).toBe(`${OAI}/chat/completions`);
    expect(resolveRequestUrl(`${OAI}/responses`, "responses")).toBe(`${OAI}/responses`);
  });

  it("preserves a query string (e.g. Azure api-version)", () => {
    const az = "https://x.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-02-01";
    expect(resolveRequestUrl(az, "chat-completions")).toBe(az);
    expect(resolveRequestUrl(az, "responses")).toBe("https://x.openai.azure.com/openai/deployments/gpt/responses?api-version=2024-02-01");
  });

  it("isResponsesWire is case-insensitive + defaults false", () => {
    expect(isResponsesWire("responses")).toBe(true);
    expect(isResponsesWire("Responses")).toBe(true);
    expect(isResponsesWire("chat-completions")).toBe(false);
    expect(isResponsesWire(undefined)).toBe(false);
  });
});

describe("WIRE-FORMAT — request body shaping", () => {
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];

  it("chat-completions → messages (+ tool when given)", () => {
    const b = buildRequestBody("chat-completions", { model: "m", messages, tool: { name: "t", parameters: {} } });
    expect(b.messages).toEqual(messages);
    expect(Array.isArray(b.tools)).toBe(true);
    expect(b.input).toBeUndefined();
  });

  it("responses → instructions (system) + input (rest), no tools", () => {
    const b = buildRequestBody("responses", { model: "m", messages, tool: { name: "t", parameters: {} } });
    expect(b.instructions).toBe("sys");
    expect(b.input).toEqual([{ role: "user", content: "hi" }]);
    expect(b.messages).toBeUndefined();
    expect(b.tools).toBeUndefined(); // responses relies on the prompt's JSON fallback
  });
});

describe("WIRE-FORMAT — responses text extraction", () => {
  it("reads output_text", () => {
    expect(extractResponsesText({ output_text: "hello" })).toBe("hello");
  });
  it("walks output[].content[].text", () => {
    expect(extractResponsesText({ output: [{ content: [{ text: "a" }, { text: "b" }] }] })).toBe("ab");
  });
  it("returns undefined for an empty payload", () => {
    expect(extractResponsesText({})).toBeUndefined();
    expect(extractResponsesText(null)).toBeUndefined();
  });
});
