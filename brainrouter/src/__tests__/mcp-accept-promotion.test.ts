import { describe, expect, it } from "vitest";
import { decideMcpAcceptPromotion } from "../api/mcpAcceptHeader.js";

/**
 * Regression coverage for the MCP Streamable HTTP `Accept` header
 * promotion. Production was logging `Not Acceptable: Client must
 * accept both application/json and text/event-stream` from clients
 * that sent only `application/json`; the brain transparently
 * promotes that header now so the SDK doesn't 406.
 *
 * The pure decision function is the smallest testable unit; the
 * full wiring (mutating req.headers + one-time UA warning) is
 * exercised through manual / integration testing against a live
 * brain.
 */

describe("decideMcpAcceptPromotion", () => {
  it("leaves headers alone when text/event-stream is already present", () => {
    expect(
      decideMcpAcceptPromotion("application/json, text/event-stream"),
    ).toEqual({ promote: false });
    expect(decideMcpAcceptPromotion("text/event-stream")).toEqual({ promote: false });
    expect(
      decideMcpAcceptPromotion("Application/JSON, Text/Event-Stream"),
    ).toEqual({ promote: false });
  });

  it("promotes when the header is missing entirely", () => {
    expect(decideMcpAcceptPromotion("")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
  });

  it("promotes the `*/*` catch-all (caller deferred to server)", () => {
    expect(decideMcpAcceptPromotion("*/*")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
    expect(decideMcpAcceptPromotion("  */*  ")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
  });

  it("promotes the common naive `application/json`-only case", () => {
    expect(decideMcpAcceptPromotion("application/json")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
    // With a charset parameter the canonical form still triggers
    // promotion — most clients add ;charset=utf-8 automatically.
    expect(decideMcpAcceptPromotion("application/json; charset=utf-8")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
  });

  it("promotes multi-value Accept that lists application/json without event-stream", () => {
    expect(decideMcpAcceptPromotion("application/json, text/plain")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
    expect(
      decideMcpAcceptPromotion("text/html, application/json;q=0.9"),
    ).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
  });

  it("leaves narrow non-JSON Accept headers alone — the SDK's 406 is the right answer there", () => {
    expect(decideMcpAcceptPromotion("text/plain")).toEqual({ promote: false });
    expect(decideMcpAcceptPromotion("text/html")).toEqual({ promote: false });
    expect(decideMcpAcceptPromotion("image/png, text/css")).toEqual({ promote: false });
  });

  it("is forgiving about whitespace + casing in the input", () => {
    expect(decideMcpAcceptPromotion("   application/json   ")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
    expect(decideMcpAcceptPromotion("APPLICATION/JSON")).toEqual({
      promote: true,
      value: "application/json, text/event-stream",
    });
  });
});
