/**
 * ADR-027 D4.1 — a declared capability outranks the id heuristic.
 *
 * The badge must not contradict what an operator explicitly recorded, in
 * EITHER direction: it must add vision the id failed to suggest, and remove
 * vision the id wrongly suggested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCapabilities, reconcileVision } from './modelCapabilities.js';

test("declared modality: removes vision the id wrongly suggested", () => {
    const guess = modelCapabilities("gpt-4o");
    assert.equal(guess.vision, true); // the heuristic's own verdict
    const reconciled = reconcileVision(guess, { status: "known", accepts: [] });
    assert.equal(reconciled.vision, false);
});

test("declared modality: adds vision the id failed to suggest", () => {
    const guess = modelCapabilities("internal-model-v3");
    assert.equal(guess.vision, false);
    const reconciled = reconcileVision(guess, { status: "known", accepts: ["image"] });
    assert.equal(reconciled.vision, true);
});

test("declared modality: keeps the heuristic when nothing was declared", () => {
    const guess = modelCapabilities("gpt-4o");
    assert.equal(reconcileVision(guess, { status: "unknown" }).vision, true);
    assert.equal(reconcileVision(guess, null).vision, true);
    assert.equal(reconcileVision(guess, undefined).vision, true);
});

test("declared modality: a pdf-only declaration does not imply image input", () => {
    const guess = modelCapabilities("gpt-4o");
    assert.equal(reconcileVision(guess, { status: "known", accepts: ["pdf"] }).vision, false);
});

test("declared modality: leaves every other flag untouched", () => {
    const guess = modelCapabilities("gpt-4o");
    const reconciled = reconcileVision(guess, { status: "known", accepts: ["image"] });
    assert.deepEqual({ ...reconciled, vision: null }, { ...guess, vision: null });
});
