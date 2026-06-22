import { describe, expect, it, vi } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    capturePassiveL0: vi.fn(),
    capture: vi.fn(),
    getPersona: vi.fn(),
    getTopScenes: vi.fn(),
    recall: vi.fn(),
  },
}));

import { StreamingReasoningRewriter, parseAndFormatThink } from "../api/routes/chat-completions.js";

describe("chat completions formatting logic", () => {
  describe("parseAndFormatThink (non-streaming)", () => {
    it("leaves regular text unchanged", () => {
      expect(parseAndFormatThink("Hello world")).toBe("Hello world");
    });

    it("formats closed think block into details block", () => {
      const src = "<think>Analyzing directory\nFinding matches</think>\n\nHere is the answer.";
      const expected = "<details>\n<summary>Work Section (Reasoning)</summary>\n\nAnalyzing directory\nFinding matches\n</details>\n\n\n\nHere is the answer.";
      expect(parseAndFormatThink(src)).toBe(expected);
    });

    it("formats unclosed think block with details tags", () => {
      const src = "<think>Still working...";
      const expected = "<details>\n<summary>Work Section (Reasoning)</summary>\n\nStill working...\n</details>\n\n";
      expect(parseAndFormatThink(src)).toBe(expected);
    });

    it("formats case-insensitive variations like <Thinking> or <thought>", () => {
      const src = "<Thinking>thought process</Thinking>hello";
      const expected = "<details>\n<summary>Work Section (Reasoning)</summary>\n\nthought process\n</details>\n\nhello";
      expect(parseAndFormatThink(src)).toBe(expected);
    });
  });

  describe("StreamingReasoningRewriter (streaming)", () => {
    it("handles reasoning_content field and wraps it in details block", () => {
      const rewriter = new StreamingReasoningRewriter();
      
      // Frame 1: reasoning starts
      let f1: any = { choices: [{ delta: { reasoning_content: "thinking step 1" } }] };
      f1 = rewriter.processFrame(f1);
      expect(f1.choices[0].delta.content).toBe("<details>\n<summary>Work Section (Reasoning)</summary>\n\nthinking step 1");
      expect(f1.choices[0].delta.reasoning_content).toBeUndefined();

      // Frame 2: reasoning continues
      let f2: any = { choices: [{ delta: { reasoning_content: " step 2" } }] };
      f2 = rewriter.processFrame(f2);
      expect(f2.choices[0].delta.content).toBe(" step 2");

      // Frame 3: reasoning finishes and normal content starts
      let f3: any = { choices: [{ delta: { content: "The final answer is" } }] };
      f3 = rewriter.processFrame(f3);
      expect(f3.choices[0].delta.content).toBe("\n</details>\n\nThe final answer is");

      // Frame 4: normal content continues
      let f4: any = { choices: [{ delta: { content: " 42." } }] };
      f4 = rewriter.processFrame(f4);
      expect(f4.choices[0].delta.content).toBe(" 42.");

      expect(rewriter.getFinalClose()).toBeNull();
    });

    it("handles inline think tags in streaming content field", () => {
      const rewriter = new StreamingReasoningRewriter();

      // Frame 1: text before think tag
      let f1: any = { choices: [{ delta: { content: "Initial text. " } }] };
      f1 = rewriter.processFrame(f1);
      expect(f1.choices[0].delta.content).toBe("Initial text. ");

      // Frame 2: opening think tag
      let f2: any = { choices: [{ delta: { content: "<think>" } }] };
      f2 = rewriter.processFrame(f2);
      expect(f2.choices[0].delta.content).toBe("<details>\n<summary>Work Section (Reasoning)</summary>\n\n");

      // Frame 3: thinking content
      let f3: any = { choices: [{ delta: { content: "thought process" } }] };
      f3 = rewriter.processFrame(f3);
      expect(f3.choices[0].delta.content).toBe("thought process");

      // Frame 4: closing think tag
      let f4: any = { choices: [{ delta: { content: "</think>Final response" } }] };
      f4 = rewriter.processFrame(f4);
      expect(f4.choices[0].delta.content).toBe("\n</details>\n\nFinal response");
    });

    it("forces close if stream ends while in reasoning block", () => {
      const rewriter = new StreamingReasoningRewriter();
      
      let f1: any = { choices: [{ delta: { reasoning_content: "thinking" } }] };
      f1 = rewriter.processFrame(f1);
      expect(f1.choices[0].delta.content).toBe("<details>\n<summary>Work Section (Reasoning)</summary>\n\nthinking");

      expect(rewriter.getFinalClose()).toBe("\n</details>\n\n");
    });
  });
});
