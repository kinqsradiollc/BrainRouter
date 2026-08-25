/**
 * ADR-049 S1 — the study core: deterministic SM-2 scheduler, MC distractors,
 * import/export codecs, and the commit-clean workspace-root store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { StudyCard, StudyDeck, StudyGrade } from "@kinqs/brainrouter-types";
import {
  applyGrade, newSchedule, previewIntervalDays, dueCardIds, isoDay, MIN_EASE, DEFAULT_EASE,
} from "../study/srs.js";
import { pickDistractors, multipleChoiceOptions } from "../study/distractors.js";
import { parseDelimitedCards, deckToCsv, deckToMarkdown, proposalsToCards } from "../study/codecs.js";
import { deckStats, reviewStreak } from "../study/stats.js";
import { buildGenerationPrompt, parseCardProposals, profileGenerationSources } from "../study/generate.js";
import {
  listStudyDecks, readStudyDeck, saveStudyDeck, deleteStudyDeck,
  readStudyProgress, saveStudyProgress, decksDir,
} from "../study/store.js";
import { withTempWorkspaceAsync } from "./_helpers.js";

const AUG25 = new Date(2026, 7, 25, 9, 0, 0); // local; day = 2026-08-25

const card = (id: string, front: string, back: string): StudyCard =>
  ({ id, front, back, format: "basic", tags: [], createdAt: "2026-08-25T00:00:00.000Z" });

// --- scheduler -------------------------------------------------------------

test("SRS — a new card graduates, and identical grades give identical schedules", () => {
  const s0 = newSchedule("c1", AUG25);
  assert.equal(s0.state, "new");
  assert.equal(s0.ease, DEFAULT_EASE);
  assert.equal(s0.dueOn, "2026-08-25");

  const good1 = applyGrade(s0, "good", AUG25);
  assert.equal(good1.state, "review");
  assert.equal(good1.intervalDays, 1);
  assert.equal(good1.dueOn, "2026-08-26");
  assert.equal(good1.repetitions, 1);

  const good2 = applyGrade(good1, "good", new Date(2026, 7, 26, 9));
  assert.equal(good2.intervalDays, 6); // second good → 6d
  // Determinism: same input, same output.
  assert.deepEqual(applyGrade(good1, "good", new Date(2026, 7, 26, 9)), good2);

  const good3 = applyGrade(good2, "good", new Date(2026, 8, 1, 9));
  assert.equal(good3.intervalDays, Math.round(6 * DEFAULT_EASE)); // interval*ease
});

test("SRS — again is a lapse (ease down, reps reset, due tomorrow); ease floored", () => {
  let s = newSchedule("c", AUG25);
  s = applyGrade(s, "good", AUG25);
  s = applyGrade(s, "good", AUG25);
  const before = s.ease;
  const lapsed = applyGrade(s, "again", AUG25);
  assert.equal(lapsed.state, "learning");
  assert.equal(lapsed.repetitions, 0);
  assert.equal(lapsed.lapses, 1);
  assert.equal(lapsed.intervalDays, 1);
  assert.equal(lapsed.dueOn, "2026-08-26");
  assert.ok(lapsed.ease < before);

  // Repeated `again` never drops ease below the floor.
  let floor = newSchedule("f", AUG25);
  for (let i = 0; i < 20; i++) floor = applyGrade(floor, "again", AUG25);
  assert.equal(floor.ease, MIN_EASE);
});

test("SRS — hard < good < easy intervals, and preview matches applyGrade", () => {
  let s = newSchedule("c", AUG25);
  s = applyGrade(s, "good", AUG25);
  s = applyGrade(s, "good", new Date(2026, 7, 26)); // reps=2, interval=6
  const hard = applyGrade(s, "hard", new Date(2026, 8, 1));
  const good = applyGrade(s, "good", new Date(2026, 8, 1));
  const easy = applyGrade(s, "easy", new Date(2026, 8, 1));
  assert.ok(hard.intervalDays < good.intervalDays, "hard < good");
  assert.ok(good.intervalDays < easy.intervalDays, "good < easy");
  for (const g of ["again", "hard", "good", "easy"] as StudyGrade[]) {
    assert.equal(previewIntervalDays(s, g), applyGrade(s, g, new Date(2026, 8, 1)).intervalDays);
  }
});

test("SRS — dueCardIds returns only due cards, most-overdue first", () => {
  const now = AUG25;
  const schedules = {
    a: { ...newSchedule("a", now), dueOn: "2026-08-20" }, // overdue
    b: { ...newSchedule("b", now), dueOn: "2026-08-25" }, // due today
    c: { ...newSchedule("c", now), dueOn: "2026-08-30" }, // future
  };
  assert.deepEqual(dueCardIds(schedules, now), ["a", "b"]);
});

test("SRS — property: identical grade sequences from identical state converge", () => {
  const seq: StudyGrade[] = ["good", "hard", "good", "again", "good", "easy", "good"];
  const run = () => {
    let s = newSchedule("p", AUG25);
    let day = new Date(AUG25);
    for (const g of seq) { s = applyGrade(s, g, day); day = new Date(day.getTime() + 86400000); }
    return s;
  };
  assert.deepEqual(run(), run());
});

// --- distractors -----------------------------------------------------------

test("distractors — deterministic, distinct from the answer, capped by supply", () => {
  const correct = card("c1", "2+2", "4");
  const siblings = [card("c2", "x", "5"), card("c3", "y", "6"), card("c4", "z", "4"), card("c5", "w", "5")];
  const d1 = pickDistractors(correct, siblings, 3);
  assert.deepEqual(d1, pickDistractors(correct, siblings, 3)); // deterministic
  assert.ok(!d1.includes("4"), "never the correct answer");
  assert.equal(new Set(d1).size, d1.length, "distinct");
  assert.deepEqual([...d1].sort(), ["5", "6"]); // only two distinct wrong answers exist

  const { options, correctIndex } = multipleChoiceOptions(correct, siblings, 4);
  assert.equal(options[correctIndex], "4");
  assert.equal(new Set(options).size, options.length);
});

// --- codecs ----------------------------------------------------------------

test("codecs — import TSV/CSV (Quizlet shape), export MD + CSV round-trip", () => {
  const tsv = "front\tback\ttag1;tag2\n# comment\nq2\ta2\n\n";
  const rows = parseDelimitedCards(tsv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { front: "front", back: "back", format: "basic", tags: ["tag1", "tag2"] });

  const quoted = `"a, b","c ""d""",x\n`;
  const csv = parseDelimitedCards(quoted, { delimiter: "," });
  assert.deepEqual(csv[0], { front: "a, b", back: 'c "d"', format: "basic", tags: ["x"] });

  const deck: StudyDeck = {
    schemaVersion: 1, id: "d", name: "Deck", tags: [],
    cards: proposalsToCards(rows, (i) => `card-${i}`, "2026-08-25T00:00:00.000Z"),
    createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
  };
  // CSV export re-imports to the same fronts/backs.
  const reimported = parseDelimitedCards(deckToCsv(deck), { delimiter: "," }).slice(1);
  assert.deepEqual(reimported.map((c) => [c.front, c.back]), deck.cards.map((c) => [c.front, c.back]));
  assert.match(deckToMarkdown(deck), /\| Front \| Back \| Tags \|/);
});

// --- store -----------------------------------------------------------------

test("store — deck files are commit-clean (canonical, stable) and per-deck", async () => {
  await withTempWorkspaceAsync(async (ws) => {
    const deck: StudyDeck = {
      schemaVersion: 1, id: "Rust Basics", name: "Rust Basics", tags: ["rust"],
      cards: [card("c1", "ownership?", "each value has one owner")],
      createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
    };
    saveStudyDeck(ws, deck);
    const file = path.join(decksDir(ws), "rust-basics.json");
    const first = fs.readFileSync(file, "utf8");
    assert.ok(first.endsWith("\n"), "trailing newline");
    assert.match(first, /^\{\n  "cards":/, "keys sorted → cards first");
    // Byte-stable: saving the same deck again produces the identical file.
    saveStudyDeck(ws, deck);
    assert.equal(fs.readFileSync(file, "utf8"), first);

    assert.equal(readStudyDeck(ws, "Rust Basics")?.name, "Rust Basics");
    assert.equal(listStudyDecks(ws).length, 1);
    deleteStudyDeck(ws, "Rust Basics");
    assert.equal(readStudyDeck(ws, "Rust Basics"), null);
    assert.deepEqual(listStudyDecks(ws), []);
    // A malformed file contributes nothing.
    fs.mkdirSync(decksDir(ws), { recursive: true });
    fs.writeFileSync(path.join(decksDir(ws), "junk.json"), "{ not json", "utf8");
    assert.deepEqual(listStudyDecks(ws), []);
  });
});

test("store — progress is per-user and isolated", async () => {
  await withTempWorkspaceAsync(async (ws) => {
    assert.deepEqual(readStudyProgress(ws, "alice").schedules, {});
    const alice = readStudyProgress(ws, "alice");
    alice.schedules["c1"] = applyGrade(newSchedule("c1", AUG25), "good", AUG25);
    alice.reviewsByDay["2026-08-25"] = 1;
    alice.updatedAt = AUG25.toISOString();
    saveStudyProgress(ws, alice);

    assert.equal(readStudyProgress(ws, "alice").schedules["c1"]?.state, "review");
    // Bob's progress is untouched by Alice's.
    assert.deepEqual(readStudyProgress(ws, "bob").schedules, {});
  });
});

// --- generation ------------------------------------------------------------

test("generate — parse tolerates fences/prose, validates, bounds, stamps provenance", () => {
  const reply = 'Here are the cards:\n```json\n[{"front":"What is SM-2?","back":"A spaced-repetition algorithm","tags":["srs","x","y","z","w","v","EXTRA"]},{"front":"","back":"skip me"},{"q":"Alt keys?","a":"handled"}]\n```';
  const cards = parseCardProposals(reply, { kind: "adr", number: "49" });
  assert.equal(cards.length, 2); // the empty-front row dropped; q/a aliases accepted
  assert.equal(cards[0]!.front, "What is SM-2?");
  assert.equal(cards[0]!.tags.length, 6); // capped
  assert.deepEqual(cards[0]!.provenance, { kind: "adr", number: "49" });
  assert.equal(cards[1]!.front, "Alt keys?");
  // A malformed reply yields [] — never a half-card.
  assert.deepEqual(parseCardProposals("not json at all"), []);
  assert.deepEqual(parseCardProposals("[ broken"), []);
});

test("generate — prompt bounds the source; profile orders the sources (D2)", () => {
  const { system, user } = buildGenerationPrompt("x".repeat(50_000), { count: 8, focus: "APIs" });
  assert.match(system, /JSON array/);
  assert.match(user, /Focus on: APIs/);
  assert.ok(user.length < 25_000, "source clipped");

  // Engineering leads with decisions + the map; every profile still lists all 4.
  const eng = profileGenerationSources("engineering").map((s) => s.kind);
  assert.equal(eng[0], "decisions");
  assert.ok(eng.includes("atlas") && eng.includes("text"));
  const study = profileGenerationSources("study").map((s) => s.kind);
  assert.equal(study[0], "doc");
  assert.equal(new Set(profileGenerationSources("custom").map((s) => s.kind)).size, 4);
});

test("stats — new/learning/review/due counts + streak are honest", () => {
  const deck: StudyDeck = {
    schemaVersion: 1, id: "d", name: "D", tags: [],
    cards: [card("a", "1", "1"), card("b", "2", "2"), card("c", "3", "3")],
    createdAt: "x", updatedAt: "x",
  };
  const progress = {
    schemaVersion: 1, user: "u", reviewsByDay: { "2026-08-25": 3, "2026-08-24": 2 },
    updatedAt: "x",
    schedules: {
      a: { ...newSchedule("a", AUG25), state: "review" as const, dueOn: "2026-08-20" }, // due
      b: { ...newSchedule("b", AUG25), state: "learning" as const, dueOn: "2026-09-01" }, // future
      // c has no schedule → new
    },
  };
  const st = deckStats(deck, progress, AUG25);
  assert.equal(st.newCards, 1);
  assert.equal(st.learningCards, 1);
  assert.equal(st.reviewCards, 1);
  assert.equal(st.dueCards, 1);
  assert.equal(reviewStreak(progress, AUG25), 2); // 25th + 24th
});
