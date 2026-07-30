/**
 * First-match orchestration-profile discovery across reviewed workspace,
 * enabled-plugin, and bundled sources.
 *
 * Higher-precedence files claim their ID even when invalid. This prevents a
 * malformed local override from silently activating a lower-precedence plan;
 * callers receive an unavailable diagnostic and must fall back to direct
 * primary execution.
 */
import path from 'node:path';
import type { PluginContributions } from '../../plugin/loader.js';
import {
  bundledOrchestrationProfileReferences,
  loadBundledOrchestrationProfiles,
} from './orchestrationProfileCatalog.js';
import {
  listOrchestrationProfileDefinitionFiles,
  readOrchestrationProfileDefinitionFile,
  type OrchestrationProfileDefinition,
  type OrchestrationProfileReferenceCatalog,
} from './orchestrationProfileDefinitionFile.js';

export const ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES = 256;

export type OrchestrationProfileSourceKind =
  | 'workspace-local'
  | 'workspace'
  | 'plugin'
  | 'bundled';

export interface ResolvedOrchestrationProfileSource {
  kind: OrchestrationProfileSourceKind;
  /** Safe display provenance; never an absolute path. */
  provenance: string;
}

export interface ResolvedOrchestrationProfileEntry {
  id: string;
  definition: OrchestrationProfileDefinition;
  source: ResolvedOrchestrationProfileSource;
}

export type OrchestrationProfileSourceDiagnosticCode =
  | 'collision'
  | 'invalid-definition'
  | 'unavailable-reference'
  | 'source-limit';

export interface OrchestrationProfileSourceDiagnostic {
  code: OrchestrationProfileSourceDiagnosticCode;
  id?: string;
  source: ResolvedOrchestrationProfileSource;
  message: string;
  shadowedBy?: ResolvedOrchestrationProfileSource;
}

export interface ResolvedOrchestrationProfileCatalog {
  entries: ReadonlyMap<string, ResolvedOrchestrationProfileEntry>;
  /** IDs claimed by a higher-precedence source whose definition failed closed. */
  unavailableIds: ReadonlySet<string>;
  diagnostics: readonly OrchestrationProfileSourceDiagnostic[];
}

export interface ResolveOrchestrationProfileSourcesOptions {
  workspaceRoot: string;
  /**
   * Pass only the output of the enabled-plugin loader. Disabled plugins must
   * never be supplied as plan sources.
   */
  pluginContributions?: Pick<PluginContributions, 'orchestrationProfileFiles'>;
  references?: OrchestrationProfileReferenceCatalog;
  /** Test/package-validation seam. */
  bundledProfilesDir?: string;
}

interface FileCandidate {
  id: string;
  filePath: string;
  boundaryRoot: string;
  containmentRoot: string;
  source: ResolvedOrchestrationProfileSource;
}

/** Resolve the whole-definition catalog using ADR precedence and fail-closed claims. */
export function resolveOrchestrationProfileSources(
  options: ResolveOrchestrationProfileSourcesOptions,
): ResolvedOrchestrationProfileCatalog {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const references = options.references ?? bundledOrchestrationProfileReferences();
  const entries = new Map<string, ResolvedOrchestrationProfileEntry>();
  const unavailableIds = new Set<string>();
  const diagnostics: OrchestrationProfileSourceDiagnostic[] = [];
  const claimed = new Map<string, ResolvedOrchestrationProfileSource>();

  const acceptFile = (candidate: FileCandidate): void => {
    const prior = claimed.get(candidate.id);
    if (prior) {
      diagnostics.push({
        code: 'collision',
        id: candidate.id,
        source: candidate.source,
        shadowedBy: prior,
        message: `Orchestration profile "${candidate.id}" from ${candidate.source.provenance} is shadowed by ${prior.provenance}.`,
      });
      return;
    }
    claimed.set(candidate.id, candidate.source);
    try {
      const definition = readOrchestrationProfileDefinitionFile(
        candidate.filePath,
        references,
        candidate.boundaryRoot,
        candidate.containmentRoot,
      );
      entries.set(candidate.id, {
        id: candidate.id,
        definition,
        source: candidate.source,
      });
    } catch (error) {
      unavailableIds.add(candidate.id);
      const message = error instanceof Error
        ? boundedDiagnostic(error.message)
        : 'Orchestration profile definition is unavailable.';
      diagnostics.push({
        code: unavailableReference(message)
          ? 'unavailable-reference'
          : 'invalid-definition',
        id: candidate.id,
        source: candidate.source,
        message,
      });
    }
  };

  for (const source of workspaceSources(workspaceRoot, diagnostics)) {
    for (const candidate of source) acceptFile(candidate);
  }

  const pluginFiles = options.pluginContributions?.orchestrationProfileFiles ?? [];
  const orderedPluginFiles = [...pluginFiles]
    .sort((left, right) =>
      left.pluginName.localeCompare(right.pluginName)
      || left.path.localeCompare(right.path));
  if (orderedPluginFiles.length > ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES) {
    diagnostics.push({
      code: 'source-limit',
      source: { kind: 'plugin', provenance: 'enabled-plugins' },
      message: `Enabled plugin orchestration profiles exceed the ${ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES}-file discovery limit.`,
    });
  }
  for (const entry of orderedPluginFiles.slice(0, ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES)) {
    if (!entry.path.endsWith('.json')) continue;
    const directory = path.dirname(entry.path);
    acceptFile({
      id: path.basename(entry.path, '.json'),
      filePath: entry.path,
      boundaryRoot: directory,
      containmentRoot: directory,
      source: { kind: 'plugin', provenance: `plugin:${entry.pluginName}` },
    });
  }

  const bundled = loadBundledOrchestrationProfiles({
    ...(options.bundledProfilesDir
      ? { profilesDir: options.bundledProfilesDir }
      : {}),
    references,
  });
  for (const definition of bundled.slice(0, ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES)) {
    const source = { kind: 'bundled', provenance: 'bundled' } as const;
    const prior = claimed.get(definition.id);
    if (prior) {
      diagnostics.push({
        code: 'collision',
        id: definition.id,
        source,
        shadowedBy: prior,
        message: `Orchestration profile "${definition.id}" from bundled is shadowed by ${prior.provenance}.`,
      });
      continue;
    }
    claimed.set(definition.id, source);
    entries.set(definition.id, { id: definition.id, definition, source });
  }

  return { entries, unavailableIds, diagnostics };
}

/** Resolve one usable definition; invalid higher-precedence claims return undefined. */
export function findResolvedOrchestrationProfile(
  catalog: ResolvedOrchestrationProfileCatalog,
  id: string,
): ResolvedOrchestrationProfileEntry | undefined {
  return catalog.entries.get(id.trim());
}

function workspaceSources(
  workspaceRoot: string,
  diagnostics: OrchestrationProfileSourceDiagnostic[],
): FileCandidate[][] {
  return [
    candidatesFromDirectory(
      path.join(workspaceRoot, '.brainrouter', 'orchestration-profiles'),
      workspaceRoot,
      { kind: 'workspace-local', provenance: 'workspace-local' },
      diagnostics,
    ),
    candidatesFromDirectory(
      path.join(workspaceRoot, 'orchestration-profiles'),
      workspaceRoot,
      { kind: 'workspace', provenance: 'workspace' },
      diagnostics,
    ),
  ];
}

function candidatesFromDirectory(
  directory: string,
  containmentRoot: string,
  source: ResolvedOrchestrationProfileSource,
  diagnostics: OrchestrationProfileSourceDiagnostic[],
): FileCandidate[] {
  const files = listOrchestrationProfileDefinitionFiles(
    directory,
    directory,
    containmentRoot,
  );
  if (files.length > ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES) {
    diagnostics.push({
      code: 'source-limit',
      source,
      message: `${source.provenance} orchestration profiles exceed the ${ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES}-file discovery limit.`,
    });
  }
  return files
    .slice(0, ORCHESTRATION_PROFILE_MAX_CONTRIBUTED_FILES)
    .map((filePath) => ({
      id: path.basename(filePath, '.json'),
      filePath,
      boundaryRoot: directory,
      containmentRoot,
      source,
    }));
}

function unavailableReference(message: string): boolean {
  return message.includes('unknown references')
    || message.includes('no registered output contract');
}

function boundedDiagnostic(message: string): string {
  return message.length <= 1024
    ? message
    : `${message.slice(0, 1021)}...`;
}
