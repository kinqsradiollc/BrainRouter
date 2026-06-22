/**
 * CLI-19 (0.4.4) — LSP base-protocol framing: `Content-Length: N\r\n\r\n<json>`.
 * Pure + streaming so it's testable without a real language server: the parser
 * buffers arbitrary chunk boundaries and yields complete JSON-RPC messages.
 */

/** Encode a JSON-RPC message as a single LSP frame. */
export function encodeFrame(message: unknown): string {
  const json = JSON.stringify(message);
  // Content-Length is the BYTE length of the JSON payload.
  const len = Buffer.byteLength(json, 'utf8');
  return `Content-Length: ${len}\r\n\r\n${json}`;
}

/**
 * Incremental parser: push raw stdout chunks, pull fully-received messages.
 * Tolerates split headers/bodies across chunks and extra header fields.
 */
export class LspFrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer | string): unknown[] {
    this.buf = Buffer.concat([this.buf, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Malformed header block — drop it and resync past the separator.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) break; // body not fully arrived yet
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      try {
        out.push(JSON.parse(body));
      } catch {
        // skip an unparseable body but keep draining the stream
      }
    }
    return out;
  }
}
