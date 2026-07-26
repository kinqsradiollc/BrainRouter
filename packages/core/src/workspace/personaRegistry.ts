/**
 * Deterministic registry for validated JSON persona definitions.
 *
 * Discovery supplies candidates in precedence order. The registry keeps the
 * first valid definition for an id, records collision provenance, and reports
 * invalid candidates without allowing a lower-trust file to alter authority.
 */
import path from 'node:path';
import {
  readPersonaDefinitionFile,
  type PersonaDefinition,
} from './personaDefinitionFile.js';

export type PersonaSource = 'workspace' | 'local' | 'plugin' | 'bundled';

export interface PersonaCandidate {
  source: PersonaSource;
  scope: string;
  filePath: string;
  boundaryRoot?: string;
  containmentRoot?: string;
}

export interface RegisteredPersona extends PersonaDefinition {
  source: PersonaSource;
  filePath: string;
  qualifiedName: string;
  collides?: boolean;
  shadowedBy?: string[];
}

export interface PersonaRegistryDiagnostic {
  filePath: string;
  scope: string;
  code: 'invalid' | 'shadowed';
  message: string;
}

export interface PersonaRegistry {
  personas: RegisteredPersona[];
  diagnostics: PersonaRegistryDiagnostic[];
}

/** Build a stable registry from candidates already ordered by precedence. */
export function buildPersonaRegistry(candidates: readonly PersonaCandidate[]): PersonaRegistry {
  const winners = new Map<string, RegisteredPersona>();
  const diagnostics: PersonaRegistryDiagnostic[] = [];

  for (const candidate of candidates) {
    let definition: PersonaDefinition;
    try {
      const boundaryRoot = candidate.boundaryRoot ?? path.dirname(candidate.filePath);
      definition = readPersonaDefinitionFile(
        candidate.filePath,
        boundaryRoot,
        candidate.containmentRoot ?? boundaryRoot,
      );
    } catch (error) {
      diagnostics.push({
        filePath: candidate.filePath,
        scope: candidate.scope,
        code: 'invalid',
        message: error instanceof Error ? error.message : 'Persona definition is invalid.',
      });
      continue;
    }

    const winner = winners.get(definition.id);
    if (!winner) {
      winners.set(definition.id, {
        ...definition,
        source: candidate.source,
        filePath: candidate.filePath,
        qualifiedName: `${candidate.scope}:${definition.id}`,
      });
      continue;
    }

    winner.collides = true;
    winner.shadowedBy = [...new Set([...(winner.shadowedBy ?? []), candidate.scope])];
    diagnostics.push({
      filePath: candidate.filePath,
      scope: candidate.scope,
      code: 'shadowed',
      message: `Persona ${definition.id} is shadowed by ${winner.qualifiedName}.`,
    });
  }

  return {
    personas: [...winners.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
  };
}

/** Resolve one persona from an already-built registry. */
export function findRegisteredPersona(
  registry: PersonaRegistry,
  id: string,
): RegisteredPersona | undefined {
  const normalized = id.trim();
  return registry.personas.find((persona) => persona.id === normalized);
}
