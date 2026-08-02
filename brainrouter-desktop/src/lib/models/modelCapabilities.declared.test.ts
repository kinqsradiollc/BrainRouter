/**
 * ADR-027 D4.1 — a declared capability outranks the id heuristic.
 *
 * The badge must not contradict what an operator explicitly recorded, in
 * EITHER direction: it must add vision the id failed to suggest, and remove
 * vision the id wrongly suggested.
 */
import { describe, expect, it } from "vitest";
import { modelCapabilities, reconcileVision } from "./modelCapabilities";

describe("declared input modality overrides the id heuristic", () => {
  it("removes vision the id wrongly suggested", () => {
    const guess = modelCapabilities("gpt-4o");
    expect(guess.vision).toBe(true); // the heuristic's own verdict
    const reconciled = reconcileVision(guess, { status: "known", accepts: [] });
    expect(reconciled.vision).toBe(false);
  });

  it("adds vision the id failed to suggest", () => {
    const guess = modelCapabilities("internal-model-v3");
    expect(guess.vision).toBe(false);
    const reconciled = reconcileVision(guess, { status: "known", accepts: ["image"] });
    expect(reconciled.vision).toBe(true);
  });

  it("keeps the heuristic when nothing was declared", () => {
    const guess = modelCapabilities("gpt-4o");
    expect(reconcileVision(guess, { status: "unknown" }).vision).toBe(true);
    expect(reconcileVision(guess, null).vision).toBe(true);
    expect(reconcileVision(guess, undefined).vision).toBe(true);
  });

  it("a pdf-only declaration does not imply image input", () => {
    const guess = modelCapabilities("gpt-4o");
    expect(reconcileVision(guess, { status: "known", accepts: ["pdf"] }).vision).toBe(false);
  });

  it("leaves every other flag untouched", () => {
    const guess = modelCapabilities("gpt-4o");
    const reconciled = reconcileVision(guess, { status: "known", accepts: ["image"] });
    expect({ ...reconciled, vision: null }).toEqual({ ...guess, vision: null });
  });
});
