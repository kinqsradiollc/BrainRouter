import { describe, it, expect } from "vitest";
import {
  parseRequestTimeoutMs,
  normalizeRequestTimeoutMs,
  requestTimeoutSignal,
} from "../memory/util/request-timeout.js";

describe("parseRequestTimeoutMs", () => {
  it("treats unset / empty / zero / negative / junk as 0 (no timeout)", () => {
    expect(parseRequestTimeoutMs(undefined)).toBe(0);
    expect(parseRequestTimeoutMs("")).toBe(0);
    expect(parseRequestTimeoutMs("   ")).toBe(0);
    expect(parseRequestTimeoutMs("0")).toBe(0);
    expect(parseRequestTimeoutMs("-1000")).toBe(0);
    expect(parseRequestTimeoutMs("nope")).toBe(0);
  });
  it("returns a positive bound, floored to 1000ms, with no upper clamp", () => {
    expect(parseRequestTimeoutMs("1500")).toBe(1500);
    expect(parseRequestTimeoutMs("500")).toBe(1000); // floored
    expect(parseRequestTimeoutMs("3600000")).toBe(3_600_000); // 1h, no clamp
  });
});

describe("normalizeRequestTimeoutMs", () => {
  it("maps non-positive / non-finite to 0", () => {
    expect(normalizeRequestTimeoutMs(undefined)).toBe(0);
    expect(normalizeRequestTimeoutMs(0)).toBe(0);
    expect(normalizeRequestTimeoutMs(-5)).toBe(0);
    expect(normalizeRequestTimeoutMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeRequestTimeoutMs(Number.NaN)).toBe(0);
  });
  it("floors a positive value to 1000ms", () => {
    expect(normalizeRequestTimeoutMs(250)).toBe(1000);
    expect(normalizeRequestTimeoutMs(45_000)).toBe(45_000);
  });
});

describe("requestTimeoutSignal", () => {
  it("returns undefined (no client-side deadline) for 0 / negative / non-finite", () => {
    expect(requestTimeoutSignal(0)).toBeUndefined();
    expect(requestTimeoutSignal(-1)).toBeUndefined();
    expect(requestTimeoutSignal(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(requestTimeoutSignal(Number.NaN)).toBeUndefined();
  });
  it("returns an AbortSignal for a positive timeout", () => {
    const sig = requestTimeoutSignal(5000);
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig!.aborted).toBe(false);
  });
});
