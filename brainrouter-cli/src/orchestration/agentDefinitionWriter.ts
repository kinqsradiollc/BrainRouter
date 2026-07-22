/** Guarded persistence for project-scoped executable agent definitions. */
import path from 'node:path';
import {
  parseAgentDefinition,
} from '@kinqs/brainrouter-core/orchestration';
import { writeWorkspaceFileAtomic } from '@kinqs/brainrouter-core/workspace';
import type { BuiltAgentDefinition } from './agentDefValidation.js';

const AGENTS_DIRECTORY = '.brainrouter/agents';

export interface WriteAgentDefinitionOptions {
  /** Replace an existing regular definition; false is create-only. */
  force?: boolean;
}

/**
 * Validate against the runtime reader, then durably write without following
 * project links or exposing a partial JSON file.
 */
export function writeProjectAgentDefinition(
  workspaceRoot: string,
  definition: BuiltAgentDefinition,
  options: WriteAgentDefinitionOptions = {},
): string {
  const contents = `${JSON.stringify(definition, null, 2)}\n`;
  parseAgentDefinition(contents, definition.id);
  const relativePath = path.posix.join(AGENTS_DIRECTORY, `${definition.id}.json`);
  return writeWorkspaceFileAtomic(workspaceRoot, relativePath, contents, {
    mode: 0o600,
    exclusive: !options.force,
  });
}
