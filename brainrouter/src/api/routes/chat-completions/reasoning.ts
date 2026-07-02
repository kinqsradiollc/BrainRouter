// Reasoning-channel formatting: fold separate `reasoning_content` / inline
// <think> tags into a collapsible "Work Section" details block, for both the
// streaming path (StreamingReasoningRewriter) and the buffered path
// (parseAndFormatThink).

export class StreamingReasoningRewriter {
  private reasoningChannel: "separate" | "inline" | null = null;
  private inReasoningBlock = false;

  public processFrame(frameJson: any): any {
    if (!frameJson?.choices?.[0]) return frameJson;
    const choice = frameJson.choices[0];
    const delta = choice.delta;
    if (!delta) return frameJson;

    // 1. Separate reasoning_content / reasoning field
    const rawReasoning = (typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined)
      ?? (typeof delta.reasoning === "string" ? delta.reasoning : undefined);

    if (rawReasoning !== undefined && rawReasoning.length > 0) {
      let contentAddition = "";
      if (!this.reasoningChannel) {
        this.reasoningChannel = "separate";
        this.inReasoningBlock = true;
        contentAddition += "<details>\n<summary>Work Section (Reasoning)</summary>\n\n";
      }
      contentAddition += rawReasoning;

      delta.content = (delta.content ?? "") + contentAddition;
      delete delta.reasoning_content;
      delete delta.reasoning;
      return frameJson;
    }

    // 2. Transition from reasoning to content
    if (this.reasoningChannel === "separate" && this.inReasoningBlock && typeof delta.content === "string" && delta.content.length > 0) {
      this.inReasoningBlock = false;
      delta.content = "\n</details>\n\n" + delta.content;
      return frameJson;
    }

    // 3. Inline tags in content
    if (typeof delta.content === "string" && delta.content.length > 0) {
      let text = delta.content;
      const openTag = text.match(/<(think|thinking|thought|reasoning)>/i);
      if (openTag) {
        text = text.replace(openTag[0], "<details>\n<summary>Work Section (Reasoning)</summary>\n\n");
        this.inReasoningBlock = true;
        this.reasoningChannel = "inline";
      }
      const closeTag = text.match(/<\/(think|thinking|thought|reasoning)>/i);
      if (closeTag) {
        text = text.replace(closeTag[0], "\n</details>\n\n");
        this.inReasoningBlock = false;
      }
      delta.content = text;
    }

    return frameJson;
  }

  public getFinalClose(): string | null {
    if (this.inReasoningBlock) {
      this.inReasoningBlock = false;
      return "\n</details>\n\n";
    }
    return null;
  }
}

export function parseAndFormatThink(content: string): string {
  if (!content) return content;

  // Tag replacements: <think>, <thinking>, <thought>, <reasoning>
  const openTag = content.match(/<(think|thinking|thought|reasoning)>/i);
  const closeTag = content.match(/<\/(think|thinking|thought|reasoning)>/i);

  if (openTag && closeTag) {
    return content
      .replace(openTag[0], "<details>\n<summary>Work Section (Reasoning)</summary>\n\n")
      .replace(closeTag[0], "\n</details>\n\n");
  } else if (openTag) {
    return content.replace(openTag[0], "<details>\n<summary>Work Section (Reasoning)</summary>\n\n") + "\n</details>\n\n";
  }

  return content;
}
