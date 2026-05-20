# Codex Tasks - Skill Activation Potential Routing

- [ ] Create database table `skill_activations` and add helper methods in [sqlite.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/memory/store/sqlite.ts)
- [ ] Implement exponential decay calculation and skill spiking logic in [skill-prewarm.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/memory/pipeline/skill-prewarm.ts)
- [ ] Connect `memoryEngine.spikeSkill` inside [memory_recall.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/tools/memory_recall.ts) and [memory_capture_turn.ts](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/src/tools/memory_capture_turn.ts)
- [ ] Add unit tests in a new test file `mcp/src/__tests__/skill-activation.test.ts`
- [ ] Verify test suite passes and verify activation decay works as expected
