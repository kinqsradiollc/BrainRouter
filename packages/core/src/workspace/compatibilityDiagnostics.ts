import {
  TELEMETRY_EVENTS,
  type TelemetryEvent,
} from '../telemetry/events/contracts.js';
import {
  isTelemetryEnabled,
  recordTelemetry,
} from '../telemetry/recorder/telemetry.js';

export type WorkspaceCompatibilityDiagnosticCode =
  | 'legacy_markdown_persona'
  | 'persona_collision'
  | 'legacy_manifest_agents'
  | 'legacy_orchestration_defaults'
  | 'typescript_orchestration_defaults'
  | 'implicit_same_id_pairing'
  | 'legacy_frontend_persona';

export interface WorkspaceCompatibilityDiagnostic {
  code: WorkspaceCompatibilityDiagnosticCode;
  surface: 'persona' | 'manifest';
  severity: 'info' | 'warning';
  message: string;
  source?: 'workspace' | 'local' | 'plugin' | 'bundled';
  /** Local diagnostic evidence only; never copied into telemetry props. */
  filePath?: string;
  count?: number;
}

export interface CompatibilityTelemetrySummary {
  readerEvents: number;
  ambiguityEvents: number;
  byCode: Partial<Record<WorkspaceCompatibilityDiagnosticCode, number>>;
  lastSeenAt?: string;
}

const recorded = new Set<string>();

/**
 * Record metadata-only compatibility use once per workspace/code/source for
 * this process. Paths, persona ids, prompts, manifest values, and other
 * content are deliberately excluded from telemetry.
 */
export function recordWorkspaceCompatibilityDiagnostics(
  workspaceRoot: string,
  diagnostics: readonly WorkspaceCompatibilityDiagnostic[],
): void {
  if (!isTelemetryEnabled()) return;
  for (const diagnostic of diagnostics) {
    const key = [
      workspaceRoot,
      diagnostic.surface,
      diagnostic.code,
      diagnostic.source ?? 'none',
    ].join('\u0000');
    if (recorded.has(key)) continue;
    recorded.add(key);
    const ambiguity = diagnostic.code === 'persona_collision'
      || diagnostic.code === 'implicit_same_id_pairing';
    recordTelemetry({
      name: ambiguity
        ? TELEMETRY_EVENTS.compatibility_ambiguity_detected
        : TELEMETRY_EVENTS.compatibility_reader_used,
      props: {
        surface: diagnostic.surface,
        code: diagnostic.code,
        source: diagnostic.source ?? 'unknown',
        count: Math.max(1, Math.floor(diagnostic.count ?? 1)),
      },
    });
  }
}

/** Aggregate a local telemetry export into the evidence needed for a later gate. */
export function summarizeCompatibilityTelemetry(
  events: readonly TelemetryEvent[],
): CompatibilityTelemetrySummary {
  const summary: CompatibilityTelemetrySummary = {
    readerEvents: 0,
    ambiguityEvents: 0,
    byCode: {},
  };
  for (const event of events) {
    if (event.name !== TELEMETRY_EVENTS.compatibility_reader_used
      && event.name !== TELEMETRY_EVENTS.compatibility_ambiguity_detected) continue;
    if (event.name === TELEMETRY_EVENTS.compatibility_reader_used) summary.readerEvents += 1;
    else summary.ambiguityEvents += 1;
    const code = event.props?.code;
    if (typeof code === 'string' && isCompatibilityCode(code)) {
      const count = typeof event.props?.count === 'number'
        ? Math.max(1, Math.floor(event.props.count))
        : 1;
      summary.byCode[code] = (summary.byCode[code] ?? 0) + count;
    }
    if (!summary.lastSeenAt || event.at > summary.lastSeenAt) {
      summary.lastSeenAt = event.at;
    }
  }
  return summary;
}

function isCompatibilityCode(value: string): value is WorkspaceCompatibilityDiagnosticCode {
  return [
    'legacy_markdown_persona',
    'persona_collision',
    'legacy_manifest_agents',
    'legacy_orchestration_defaults',
    'typescript_orchestration_defaults',
    'implicit_same_id_pairing',
    'legacy_frontend_persona',
  ].includes(value);
}
