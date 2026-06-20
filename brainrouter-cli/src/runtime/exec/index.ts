/**
 * REFAC-EXEC-MODULE (0.4.6) — the execution-policy + sandbox namespace.
 *
 * Consolidates the command-execution concerns (policy decision, sandbox,
 * path containment, named profiles, dangerous-command + bang parsing) that
 * were scattered across `runtime/` into one module, mirroring Codex's
 * `execpolicy` / `sandboxing` / `exec` crate boundary. This barrel is the
 * single entry point; it's also where the 0.4.7 exec items (command-segment
 * policy, sandbox fail-closed, approval-prefix guard) will hang.
 */
export * from '@kinqs/brainrouter-core/dist/exec/execPolicy.js';
export * from '@kinqs/brainrouter-core/dist/exec/sandbox.js';
export * from '@kinqs/brainrouter-core/dist/exec/pathPolicy.js';
export * from './policyProfiles.js';
export * from '@kinqs/brainrouter-core/dist/exec/dangerousCommand.js';
export * from './bangCommand.js';
