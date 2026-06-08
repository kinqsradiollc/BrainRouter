import { describe, it, expect } from "vitest";
import { isClientDisconnectError } from "../transport-errors.js";

describe("isClientDisconnectError", () => {
  it("matches a response dropped because the client closed the stream", () => {
    for (const msg of [
      "Failed to send response: Error: No connection established for request ID: 75",
      "No connection established for request ID: 80",
      "Not connected",
      "Connection closed",
      "write EPIPE",
      "Cannot call write after a stream was destroyed [ERR_STREAM_DESTROYED]",
    ]) {
      expect(isClientDisconnectError(new Error(msg))).toBe(true);
      expect(isClientDisconnectError(msg)).toBe(true); // bare string too
    }
  });

  it("does NOT match genuine server/handler errors", () => {
    for (const msg of [
      "Invalid arguments: userId is required",
      "Embedding API failed: HTTP 400 Bad Request",
      "RerankerService is not ready (missing API key)",
      "Unexpected token in JSON",
      "",
    ]) {
      expect(isClientDisconnectError(new Error(msg))).toBe(false);
    }
  });

  it("is null/undefined/non-Error safe", () => {
    expect(isClientDisconnectError(undefined)).toBe(false);
    expect(isClientDisconnectError(null)).toBe(false);
    expect(isClientDisconnectError({ weird: true })).toBe(false);
  });
});
