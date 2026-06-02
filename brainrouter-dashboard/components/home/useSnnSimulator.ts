"use client";

import { useState } from "react";

export interface MockSkill {
  name: string;
  potential: number;
  threshold: number;
  hints: string;
}

/**
 * Encapsulates the interactive "Spiking Neural Network" skill-routing demo on
 * the landing page: per-skill activation potentials, the threshold-crossing
 * prewarm log, and the spike/decay turn dynamics. Extracted from `app/page.tsx`
 * so the page component stays a thin layout shell.
 */
export function useSnnSimulator() {
  const [mockSkills, setMockSkills] = useState<MockSkill[]>([
    { name: "UI-Styling", potential: 0.15, threshold: 0.3, hints: "Always inject Tailwind responsive grids..." },
    { name: "Data-Visualization", potential: 0.25, threshold: 0.3, hints: "Use seaborn, hex #34C28E for accent curves..." },
    { name: "Customer-Relations", potential: 0.05, threshold: 0.3, hints: "Include subscription tier & de-escalation checklist..." }
  ]);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([
    "SNN routing potentials initialized.",
    "System listening for active skill tool triggers."
  ]);

  const spikeSkill = (name: string) => {
    setMockSkills(prev => prev.map(skill => {
      if (skill.name === name) {
        const newPotential = Math.min(4.0, skill.potential + 1.2);
        const didCross = newPotential >= 0.3 && skill.potential < 0.3;

        setConsoleLogs(logs => [
          ...logs,
          `[SNN SPIKER] Spiked potential for '${name}' by +1.2. New charge: ${newPotential.toFixed(2)}/4.0`,
          ...(didCross ? [`[L2 PREWARM] '${name}' crossed 0.3 threshold! Guidelines now ACTIVE.`] : [])
        ]);
        return { ...skill, potential: newPotential };
      }
      return skill;
    }));
  };

  const decaySkills = () => {
    setMockSkills(prev => prev.map(skill => {
      const newPotential = Math.max(0.0, skill.potential * 0.7);
      const didDeactivate = newPotential < 0.3 && skill.potential >= 0.3;

      setConsoleLogs(logs => [
        ...logs,
        `[SNN DECAY] Applied turn decay to potentials.`,
        ...(didDeactivate ? [`[L2 PREWARM] '${skill.name}' potential fell below 0.3. Guidelines DEACTIVATED.`] : [])
      ]);
      return { ...skill, potential: newPotential };
    }));
  };

  const prewarmedSkills = mockSkills.filter(s => s.potential >= 0.3);

  return {
    mockSkills,
    consoleLogs,
    prewarmedSkills,
    spikeSkill,
    decaySkills,
  };
}
