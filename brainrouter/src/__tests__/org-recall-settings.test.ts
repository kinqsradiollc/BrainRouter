import { describe, expect, it } from "vitest";
import {
  normalizeRecallSettings,
  recallSettingsToOverrides,
  RECALL_SETTING_FIELDS,
} from "../memory/recall/orgRecallSettings.js";

describe("normalizeRecallSettings", () => {
  it("keeps only known fields, dropping junk keys", () => {
    const out = normalizeRecallSettings({ ftsLimit: 20, nope: 999, __proto__: {} });
    expect(out).toEqual({ ftsLimit: 20 });
  });

  it("clamps integers into [1,200] and floors floats-as-ints", () => {
    expect(normalizeRecallSettings({ ftsLimit: 0 }).ftsLimit).toBe(1);
    expect(normalizeRecallSettings({ vecLimit: 5000 }).vecLimit).toBe(200);
    expect(normalizeRecallSettings({ rerankPool: 33 }).rerankPool).toBe(33);
    expect(normalizeRecallSettings({ topResults: "7" }).topResults).toBe(7); // string coerced
  });

  it("clamps the [0,1] floats", () => {
    expect(normalizeRecallSettings({ diversityLambda: 1.9 }).diversityLambda).toBe(1);
    expect(normalizeRecallSettings({ rerankBlendAlpha: -0.5 }).rerankBlendAlpha).toBe(0);
    expect(normalizeRecallSettings({ diversityLambda: 0.42 }).diversityLambda).toBe(0.42);
  });

  it("coerces booleans (incl. string 'true'/'false') and omits others", () => {
    expect(normalizeRecallSettings({ diversity: false }).diversity).toBe(false);
    expect(normalizeRecallSettings({ queryRouting: "true" }).queryRouting).toBe(true);
    expect(normalizeRecallSettings({ diversity: "maybe" })).toEqual({}); // unparseable bool omitted
  });

  it("omits unset/empty/unparseable fields so they fall back to env/default", () => {
    expect(normalizeRecallSettings({ ftsLimit: undefined, vecLimit: "", rerankPool: "abc" })).toEqual({});
    expect(normalizeRecallSettings(null)).toEqual({});
    expect(normalizeRecallSettings("nope")).toEqual({});
  });

  it("every advertised field key round-trips through normalize", () => {
    const all: Record<string, unknown> = {};
    for (const f of RECALL_SETTING_FIELDS) all[f.key] = f.kind === "bool" ? true : (f.min ?? 1);
    const out = normalizeRecallSettings(all);
    for (const f of RECALL_SETTING_FIELDS) expect(out[f.key]).toBeDefined();
  });
});

describe("recallSettingsToOverrides", () => {
  it("maps limits + selection into partial override objects", () => {
    const o = recallSettingsToOverrides({ ftsLimit: 10, topResults: 8, diversity: false, diversityLambda: 0.3 });
    expect(o.limitsOverride).toEqual({ ftsLimit: 10, topResults: 8 });
    expect(o.selectionOverride).toEqual({ diversity: false, lambda: 0.3 });
    expect(o.rerankBlendAlphaOverride).toBeUndefined();
    expect(o.queryRoutingOverride).toBeUndefined();
  });

  it("maps the two standalone overrides", () => {
    const o = recallSettingsToOverrides({ rerankBlendAlpha: 0.5, queryRouting: false });
    expect(o.rerankBlendAlphaOverride).toBe(0.5);
    expect(o.queryRoutingOverride).toBe(false);
    expect(o.limitsOverride).toBeUndefined();
    expect(o.selectionOverride).toBeUndefined();
  });

  it("empty settings → empty overrides (a no-op for a default org)", () => {
    expect(recallSettingsToOverrides({})).toEqual({});
  });
});
