# Codex Implementation Plan - Skill Activation Potential Routing

Borrowing the Spiking Neural Network (SNN) potential decay concept from the prototypes to implement a dynamic, temporal skill routing model in BrainRouter. This replaces the binary window-based prewarming method with a continuous activation-energy model.

## User Review Required

> [!IMPORTANT]
> This change replaces the existing binary count strategy (`detectPrewarmSkills` scanning the last 10 L1 memories of type `skill_context`) with a persistent database-backed activation potential system.
> - **State Persistence:** Skill potentials are stored in SQLite under a new `skill_activations` table. This allows skill routing and prewarming states to survive MCP server restarts.
> - **Exponential Decay:** Instead of a rigid window (e.g., last 10 messages), activation decays continuously over time.

## Open Questions

> [!NOTE]
> 1. **Decay Style:** We propose **time-based exponential decay** using a configurable half-life (e.g., `BRAINROUTER_SKILL_HALF_LIFE_MINUTES = 10`). This means a skill's activation potential drops by 50% every 10 minutes of inactivity. Alternatively, we could do turn-based decay (e.g., -0.2 per turn). We propose a hybrid: time-based decay, but with a minimum turn-based decay (e.g., at least 5% decay per turn) to ensure decay happens even in rapid succession.
> 2. **Lateral Excitation:** In SNNs, neurons can excite neighbors. For this initial version, we will only directly excite the active skill. We can support lateral excitation in the future if a skill dependency graph is defined.

## Proposed Changes

### Database Component

#### [MODIFY] [sqlite.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/memory/store/sqlite.ts)
- Add a new table `skill_activations`:
  ```sql
  CREATE TABLE IF NOT EXISTS skill_activations (
    user_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    potential REAL DEFAULT 0.0,
    last_decay_time TEXT NOT NULL,
    PRIMARY KEY (user_id, skill_name)
  )
  ```
- Expose the following methods on `SqliteMemoryStore` (and update the `IMemoryStore` interface in types if necessary):
  - `getSkillActivations(userId: string): Array<{ skillName: string, potential: number, lastDecayTime: string }>`
  - `upsertSkillActivations(userId: string, activations: Array<{ skillName: string, potential: number, lastDecayTime: string }>): void`

### Skill Prewarming & Pipeline

#### [MODIFY] [skill-prewarm.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/memory/pipeline/skill-prewarm.ts)
- Refactor `detectPrewarmSkills`:
  - Fetch all current skill activations for the user from the database.
  - Calculate decay for each skill based on elapsed time:
    $$Potential_{new} = Potential_{old} \times e^{-\lambda \Delta t}$$
    where $\lambda = \ln(2) / HalfLife$ and $\Delta t$ is elapsed time in minutes.
  - Update decayed potentials back to the database.
  - Return skills where $Potential \ge Threshold$ (default: `0.3`), sorted by potential descending.
- Add helper `spikeSkill(userId: string, skillName: string)`:
  - Fetch or initialize the potential of `skillName`.
  - Calculate decay up to the current time.
  - Apply the spike: $Potential_{new} = \min(MaxPotential, Potential_{decayed} + SpikeAmount)$
    - Default $SpikeAmount = 1.0$, $MaxPotential = 4.0$.
  - Save the spiked potential and update `last_decay_time` to current time.

### MCP Tools Integration

#### [MODIFY] [memory_recall.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/tools/memory_recall.ts)
- Inside `handleMemoryRecall`, if `activeSkill` is provided in parameters, call `memoryEngine.spikeSkill(userId, activeSkill)` before running recall.

#### [MODIFY] [memory_capture_turn.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/tools/memory_capture_turn.ts)
- Inside `handleMemoryCaptureTurn`, if `activeSkill` is provided in parameters, call `memoryEngine.spikeSkill(userId, activeSkill)`.

---

## Verification Plan

### Automated Tests
- Write unit tests in a new file `mcp/src/__tests__/skill-activation.test.ts` to verify:
  - Spiking a skill increases its potential and caps at `MaxPotential`.
  - Exponential decay correctly decreases potentials over simulated elapsed time.
  - Database persistence: reading and writing skill potentials works correctly.

### Manual Verification
- Run a simulation script to spike a skill, sleep for 2 seconds (with a simulated high decay rate), and verify that its activation potential decays correctly.
