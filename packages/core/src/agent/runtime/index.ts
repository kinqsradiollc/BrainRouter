// Barrel for the agent `runtime` concern: the engine's facade-split
// implementation modules (runTurn / session / lifecycle / executeLocalTool),
// paired with the top-level `agent.ts` facade that composes them. Sub-structure
// only — no behavior change; modules keep their original public surface.
export * from './runTurn.impl.js';
export * from './session.impl.js';
export * from './lifecycle.impl.js';
export * from './executeLocalTool.impl.js';
