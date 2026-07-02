// Server-Sent Events relay: pipe the upstream SSE body to the client, rewriting
// reasoning frames on the fly and guarding against a hung upstream connection.

import { type Response } from "express";
import { StreamingReasoningRewriter } from "./reasoning.js";

function sseLine(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

// Idle watchdog: if the upstream stops sending bytes for this long and we
// haven't received [DONE], we treat the stream as dead and close the client.
// This prevents the "requests keep coming nonstop" symptom that happens when
// an upstream server holds a keep-alive connection open after the SSE body
// is logically complete.
const STREAM_IDLE_TIMEOUT_MS = 30_000;

async function streamUpstream(
  upstreamRes: globalThis.Response,
  clientRes: Response,
  onAssistantText: (chunk: string) => void,
): Promise<void> {
  clientRes.setHeader("Content-Type", "text/event-stream");
  clientRes.setHeader("Cache-Control", "no-cache");
  clientRes.setHeader("Connection", "keep-alive");
  clientRes.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if proxied
  clientRes.flushHeaders?.();

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    clientRes.end();
    return;
  }

  let clientClosed = false;
  let upstreamDone = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const rewriter = new StreamingReasoningRewriter();

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!upstreamDone) {
        // Abandon the upstream and tell the client we're closing.
        try { void reader.cancel("idle-timeout"); } catch { /* noop */ }
      }
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  // If the browser tab closes mid-stream, the client TCP socket emits 'close'.
  // Cancel the upstream reader so we don't keep pulling bytes from OpenAI.
  clientRes.on("close", () => {
    clientClosed = true;
    if (idleTimer) clearTimeout(idleTimer);
    try { void reader.cancel("client-closed"); } catch { /* noop */ }
  });

  const decoder = new TextDecoder();
  let buffer = "";
  armIdleTimer();
  try {
    for (;;) {
      if (clientClosed) break;
      const { value, done } = await reader.read();
      if (done) break;
      armIdleTimer();
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) {
          clientRes.write("\n");
          continue;
        }
        if (!t.startsWith("data:")) {
          clientRes.write(line + "\n");
          continue;
        }
        const payload = t.slice(5).trim();
        if (!payload) {
          clientRes.write("data:\n\n");
          continue;
        }
        if (payload === "[DONE]") {
          upstreamDone = true;
          const finalClose = rewriter.getFinalClose();
          if (finalClose) {
            const closeChunk = {
              choices: [{
                delta: { content: finalClose }
              }]
            };
            clientRes.write(`data: ${JSON.stringify(closeChunk)}\n\n`);
            onAssistantText(finalClose);
          }
          clientRes.write("data: [DONE]\n\n");
          try { void reader.cancel("done-sentinel"); } catch { /* noop */ }
          break;
        }
        try {
          let obj = JSON.parse(payload);
          obj = rewriter.processFrame(obj);

          const delta = obj?.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            onAssistantText(delta);
          }

          clientRes.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
          clientRes.write(line + "\n");
        }
      }
      if (upstreamDone) break;
    }

    // Process remaining buffer if it contains any last frame
    if (buffer.trim()) {
      const t = buffer.trim();
      if (t.startsWith("data:")) {
        const payload = t.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            let obj = JSON.parse(payload);
            obj = rewriter.processFrame(obj);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === "string") onAssistantText(delta);
            clientRes.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch {
            clientRes.write(buffer + "\n");
          }
        }
      }
    }
  } catch (err: any) {
    if (!clientClosed) clientRes.write(sseLine({ error: { message: err?.message || "stream error" } }));
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (!clientClosed) {
      // Always emit a final [DONE] so the client's SSE parser sees a clean end
      // even if the upstream didn't send one.
      if (!upstreamDone) clientRes.write("data: [DONE]\n\n");
      clientRes.end();
    }
  }
}

export { sseLine, STREAM_IDLE_TIMEOUT_MS, streamUpstream };
