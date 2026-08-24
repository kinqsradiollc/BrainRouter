/**
 * ADR-045 M3 — the per-org context-window cap is validated, clamped, and only
 * ever tightens. These assertions guard the property the gateway relies on: a
 * cap never raises a window above a model's real maximum, and an unset cap is
 * byte-neutral (the model's own window flows through untouched).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeContextSettings,
  resolveContextCapTokens,
  advertisedContextWindow,
  CONTEXT_SETTING_FIELDS,
} from './orgContextSettings.js';

describe('normalizeContextSettings', () => {
  it('keeps a valid integer cap', () => {
    expect(normalizeContextSettings({ maxContextTokens: 32000 })).toEqual({ maxContextTokens: 32000 });
  });

  it('clamps to the field bounds', () => {
    expect(normalizeContextSettings({ maxContextTokens: 50 }).maxContextTokens).toBe(1_000);
    expect(normalizeContextSettings({ maxContextTokens: 99_000_000 }).maxContextTokens).toBe(10_000_000);
  });

  it('drops unparseable / empty values (reads as no cap)', () => {
    expect(normalizeContextSettings({ maxContextTokens: 'nope' })).toEqual({});
    expect(normalizeContextSettings({ maxContextTokens: '' })).toEqual({});
    expect(normalizeContextSettings({})).toEqual({});
    expect(normalizeContextSettings(null)).toEqual({});
    expect(normalizeContextSettings('garbage')).toEqual({});
  });

  it('floors a fractional value', () => {
    expect(normalizeContextSettings({ maxContextTokens: 128000.9 }).maxContextTokens).toBe(128000);
  });

  it('exposes tunable field metadata for the dashboard form', () => {
    expect(CONTEXT_SETTING_FIELDS.map((f) => f.key)).toContain('maxContextTokens');
  });
});

describe('resolveContextCapTokens', () => {
  it('returns the cap when set, undefined otherwise', () => {
    expect(resolveContextCapTokens({ maxContextTokens: 64000 })).toBe(64000);
    expect(resolveContextCapTokens({})).toBeUndefined();
    expect(resolveContextCapTokens(null)).toBeUndefined();
    expect(resolveContextCapTokens({ maxContextTokens: 0 })).toBeUndefined();
  });
});

describe('advertisedContextWindow — the cap only tightens', () => {
  it('advertises the cap when no per-model window is known (managed models)', () => {
    expect(advertisedContextWindow(undefined, 32000)).toBe(32000);
  });

  it('advertises min(window, cap) when both are known', () => {
    expect(advertisedContextWindow(200000, 32000)).toBe(32000);
    expect(advertisedContextWindow(16000, 32000)).toBe(16000); // cap never RAISES a smaller window
  });

  it('is byte-neutral with no cap — the model window (or undefined) passes through', () => {
    expect(advertisedContextWindow(200000, undefined)).toBe(200000);
    expect(advertisedContextWindow(undefined, undefined)).toBeUndefined();
  });
});
