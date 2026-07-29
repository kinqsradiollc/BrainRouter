/**
 * Workspace-manifest compatibility translation diagnostics.
 *
 * A25-5d2: inspects legacy manifest shape without reading files or copying
 * content into telemetry. Normal v2 aliases remain diagnostic-free.
 */
import type { WorkspaceCompatibilityDiagnostic } from '../../compatibilityDiagnostics.js';

export function diagnoseWorkspaceManifestCompatibility(
  raw: Record<string, unknown>,
): WorkspaceCompatibilityDiagnostic[] {
  const diagnostics: WorkspaceCompatibilityDiagnostic[] = [];
  const agents = asRecord(raw.agents);
  const persona = asRecord(raw.persona);
  const orchestration = asRecord(raw.orchestration);
  const hasLegacyAgents = Object.keys(agents).length > 0;
  const hasPersona = Object.keys(persona).length > 0;
  const hasOrchestration = Object.keys(orchestration).length > 0;
  const legacyIds = [
    ...(typeof agents.default === 'string' ? [agents.default] : []),
    ...(Array.isArray(agents.enabled)
      ? agents.enabled
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 256)
      : []),
  ].filter((value, index, values) =>
    value.trim() && values.indexOf(value) === index);

  if (hasLegacyAgents && !hasPersona) {
    diagnostics.push({
      code: 'legacy_manifest_agents',
      surface: 'manifest',
      severity: 'info',
      message:
        'Legacy manifest agent selection was normalized into the persona contract.',
      count: legacyIds.length || 1,
    });
  }
  if (hasLegacyAgents && !hasOrchestration) {
    diagnostics.push({
      code: 'legacy_orchestration_defaults',
      surface: 'manifest',
      severity: 'info',
      message:
        'Legacy manifest agent selection required compatibility orchestration defaults.',
      count: legacyIds.length || 1,
    });
  }
  if (hasLegacyAgents && !hasPersona && !hasOrchestration &&
      legacyIds.length > 0) {
    diagnostics.push({
      code: 'implicit_same_id_pairing',
      surface: 'manifest',
      severity: 'warning',
      message:
        'Legacy persona ids were implicitly paired with same-id orchestration roles.',
      count: legacyIds.length,
    });
  }
  if (legacyIds.includes('frontend-builder')) {
    diagnostics.push({
      code: 'legacy_frontend_persona',
      surface: 'manifest',
      severity: 'info',
      message:
        'Legacy frontend persona selection was normalized to engineer plus the frontend capability.',
      count: 1,
    });
  }
  return diagnostics;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
