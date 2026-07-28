/**
 * Safe persona metadata and reviewed-selection contract for workspace setup.
 *
 * Persona prompts and filesystem paths never cross the catalog boundary.
 */
import { fileURLToPath } from 'node:url';
import { listPersonaDefinitionFiles, readPersonaDefinitionFile } from '../personaDefinitionFile.js';

export interface WorkspacePersonaCatalogDescriptor {
  id: string;
  label: string;
  description: string;
  source: 'bundled' | 'plugin' | 'user' | 'workspace';
  provenance: string;
}

export interface ReviewedWorkspacePersonaSelection {
  default: string;
  enabled: readonly string[];
}

const BUNDLED_PERSONAS_ROOT = fileURLToPath(new URL('../../../personas', import.meta.url));

/** Load prompt-free metadata for package-owned personas used by standalone catalogs. */
export function bundledWorkspacePersonaCatalogDescriptors(): WorkspacePersonaCatalogDescriptor[] {
  return listPersonaDefinitionFiles(BUNDLED_PERSONAS_ROOT).flatMap((filePath) => {
    try {
      const persona = readPersonaDefinitionFile(filePath, BUNDLED_PERSONAS_ROOT, BUNDLED_PERSONAS_ROOT);
      return [
        {
          id: persona.id,
          label: persona.displayName,
          description: persona.description,
          source: 'bundled' as const,
          provenance: 'bundled-personas',
        },
      ];
    } catch {
      return [];
    }
  });
}
