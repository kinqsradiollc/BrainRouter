/**
 * Skill Pre-warming Pipeline
 *
 * Tracks persistent skill activation potential. When a skill potential crosses
 * the configured threshold, its registered extraction hints are proactively
 * injected into `appendSystemContext` as a `<skill-prewarm>` block.
 *
 * This is opt-in via BRAINROUTER_PREWARM_ENABLED=true (disabled by default).
 */

import type { IMemoryStore } from "@brainrouter/types";

export interface PrewarmResult {
  skillName: string;
  potential: number;
  hints: string;
}

export interface SkillActivationConfig {
  halfLifeMinutes: number;
  minTurnDecay: number;
  threshold: number;
  spikeAmount: number;
  maxPotential: number;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getActivationConfig(overrides: Partial<SkillActivationConfig> = {}): SkillActivationConfig {
  const halfLifeMinutes = overrides.halfLifeMinutes
    ?? parseNumber(process.env.BRAINROUTER_SKILL_HALF_LIFE_MINUTES, 10);
  const minTurnDecay = overrides.minTurnDecay
    ?? parseNumber(process.env.BRAINROUTER_SKILL_MIN_TURN_DECAY, 0.05);
  const threshold = overrides.threshold
    ?? parseNumber(process.env.BRAINROUTER_SKILL_PREWARM_THRESHOLD, 0.3);
  const spikeAmount = overrides.spikeAmount
    ?? parseNumber(process.env.BRAINROUTER_SKILL_SPIKE_AMOUNT, 1.0);
  const maxPotential = overrides.maxPotential
    ?? parseNumber(process.env.BRAINROUTER_SKILL_MAX_POTENTIAL, 4.0);

  return {
    halfLifeMinutes: halfLifeMinutes > 0 ? halfLifeMinutes : 10,
    minTurnDecay: minTurnDecay >= 0 && minTurnDecay < 1 ? minTurnDecay : 0.05,
    threshold: threshold >= 0 ? threshold : 0.3,
    spikeAmount: spikeAmount >= 0 ? spikeAmount : 1.0,
    maxPotential: maxPotential > 0 ? maxPotential : 4.0,
  };
}

export function decayPotential(params: {
  potential: number;
  lastDecayTime: string;
  now?: Date;
  halfLifeMinutes?: number;
  minTurnDecay?: number;
}): number {
  const config = getActivationConfig({
    halfLifeMinutes: params.halfLifeMinutes,
    minTurnDecay: params.minTurnDecay,
  });
  const lastDecayMs = Date.parse(params.lastDecayTime);
  if (!Number.isFinite(params.potential) || params.potential <= 0) return 0;

  const nowMs = (params.now ?? new Date()).getTime();
  const elapsedMinutes = Number.isFinite(lastDecayMs)
    ? Math.max(0, (nowMs - lastDecayMs) / 60_000)
    : 0;
  const lambda = Math.log(2) / config.halfLifeMinutes;
  const timeDecayed = params.potential * Math.exp(-lambda * elapsedMinutes);
  const turnDecayed = params.potential * (1 - config.minTurnDecay);
  return Math.max(0, Math.min(timeDecayed, turnDecayed));
}

/**
 * Increase a skill's activation potential after explicit skill use.
 *
 * The existing potential is decayed up to `now`, then the spike is applied and
 * capped. The result is persisted so activation survives process restarts.
 */
export function spikeSkill(params: {
  userId: string;
  skillName: string;
  store: IMemoryStore;
  now?: Date;
  config?: Partial<SkillActivationConfig>;
}) {
  const skillName = params.skillName.trim();
  if (!skillName) return null;

  const config = getActivationConfig(params.config);
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const existing = params.store
    .getSkillActivations(params.userId)
    .find((record) => record.skillName === skillName);
  const decayed = existing
    ? decayPotential({
      potential: existing.potential,
      lastDecayTime: existing.lastDecayTime,
      now,
      halfLifeMinutes: config.halfLifeMinutes,
      minTurnDecay: config.minTurnDecay,
    })
    : 0;
  const potential = Math.min(config.maxPotential, decayed + config.spikeAmount);
  const activation = { skillName, potential, lastDecayTime: nowIso };
  params.store.upsertSkillActivations(params.userId, [activation]);
  return activation;
}

/**
 * Detect which skills qualify for pre-warming based on persistent activation potential.
 * Returns an array of skill names and their hints, sorted by potential.
 */
export function detectPrewarmSkills(params: {
  userId: string;
  store: IMemoryStore;
  threshold?: number;
  excludeSkill?: string;
  now?: Date;
  config?: Partial<SkillActivationConfig>;
}): PrewarmResult[] {
  const {
    userId,
    store,
    excludeSkill,
  } = params;

  const config = getActivationConfig({ ...params.config, threshold: params.threshold });
  const now = params.now ?? new Date();
  const activations = store.getSkillActivations(userId);
  if (activations.length === 0) return [];

  const decayedActivations = activations.map((activation) => ({
    skillName: activation.skillName,
    potential: decayPotential({
      potential: activation.potential,
      lastDecayTime: activation.lastDecayTime,
      now,
      halfLifeMinutes: config.halfLifeMinutes,
      minTurnDecay: config.minTurnDecay,
    }),
    lastDecayTime: activation.lastDecayTime,
  }));

  const results: PrewarmResult[] = [];
  for (const activation of decayedActivations) {
    if (activation.skillName === excludeSkill) continue;
    if (activation.potential < config.threshold) continue;

    const hints = store.getSkillHints(activation.skillName);
    if (!hints) continue; // No hints registered — nothing useful to inject

    results.push({ skillName: activation.skillName, potential: activation.potential, hints });
  }

  results.sort((a, b) => b.potential - a.potential || a.skillName.localeCompare(b.skillName));
  return results;
}

/**
 * Build the `<skill-prewarm>` block for injection into `appendSystemContext`.
 * Returns an empty string if no skills qualify.
 */
export function buildPrewarmBlock(prewarmResults: PrewarmResult[]): string {
  if (prewarmResults.length === 0) return "";

  const sections = prewarmResults.map(({ skillName, potential, hints }) =>
    `  [${skillName}] (activation ${potential.toFixed(2)})\n  ${hints.split("\n").join("\n  ")}`
  );

  return `<skill-prewarm>\n  Skills detected as currently active — hints pre-loaded:\n\n${sections.join("\n\n---\n\n")}\n</skill-prewarm>`;
}
