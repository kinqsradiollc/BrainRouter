/**
 * P23-2 bundled orchestration-profile catalog.
 *
 * Bundled plan JSON is package data, but it still crosses the same strict
 * parser/reference boundary as future plugin and workspace plans. This loader
 * derives role and skill references from the physical bundled catalogs,
 * provides the registered activation/output vocabularies, and fails loudly on
 * invalid package assets so a release cannot ship a partially usable catalog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listAgentDefinitionFiles,
  readAgentDefinitionFile,
  type AgentDefinition,
} from '../agents/agentDefinitionFile.js';
import { BUILT_IN_OUTPUT_CONTRACTS } from '../roles/outputContracts.js';
import { inspectWorkspaceProfilePlugins } from '../../workspace/profilePlugins.js';
import {
  listOrchestrationProfileDefinitionFiles,
  readOrchestrationProfileDefinitionFile,
  type OrchestrationProfileDefinition,
  type OrchestrationProfileReferenceCatalog,
  type OrchestrationProfileRoleReference,
} from './orchestrationProfileDefinitionFile.js';

const BUNDLED_ORCHESTRATION_PROFILES_DIR = fileURLToPath(
  new URL('../../../orchestration-profiles', import.meta.url),
);
const BUNDLED_AGENTS_DIR = fileURLToPath(new URL('../../../agents', import.meta.url));
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../../skills', import.meta.url));

export const ORCHESTRATION_ACTIVATION_SIGNAL_IDS: ReadonlySet<string> = new Set([
  'architecture-design',
  'academic-paper',
  'bug-fix',
  'citation-review',
  'critique',
  'dataset-audit',
  'evidence-collection',
  'experiment',
  'implementation',
  'investigation',
  'learning-assessment',
  'multi-surface-change',
  'question-decomposition',
  'remediation',
  'reproducibility-check',
  'review',
  'small-scope',
  'source-explanation',
  'writing-revision',
]);

export const ORCHESTRATION_OUTPUT_CONTRACT_IDS: ReadonlySet<string> = new Set(
  Object.keys(BUILT_IN_OUTPUT_CONTRACTS),
);

/** Load the authoritative references accepted by bundled plan files. */
export function bundledOrchestrationProfileReferences(options: {
  agentsDir?: string;
  skillsDir?: string;
  profileSkillIds?: Iterable<string>;
  additionalSkillIds?: Iterable<string>;
  additionalRoles?: Iterable<readonly [string, OrchestrationProfileRoleReference]>;
} = {}): OrchestrationProfileReferenceCatalog {
  const agentsDir = options.agentsDir ?? BUNDLED_AGENTS_DIR;
  const roles = new Map(
    listAgentDefinitionFiles(agentsDir)
      .map((filePath) => readAgentDefinitionFile(filePath))
      .map((definition) => [
        definition.id,
        orchestrationProfileRoleReference(definition),
      ] as const),
  );
  const coreSkillIds = listBundledSkillIds(options.skillsDir ?? BUNDLED_SKILLS_DIR);
  const profileSkillIds = options.profileSkillIds === undefined
    ? inspectWorkspaceProfilePlugins().available.flatMap((plugin) => [...plugin.skillIds])
    : [...options.profileSkillIds];
  const additionalSkillIds = options.additionalSkillIds === undefined
    ? []
    : [...options.additionalSkillIds];
  for (const [id, reference] of options.additionalRoles ?? []) roles.set(id, reference);
  return {
    roles,
    skillIds: new Set([...coreSkillIds, ...profileSkillIds, ...additionalSkillIds]),
    signalIds: ORCHESTRATION_ACTIVATION_SIGNAL_IDS,
  };
}

/** Load every valid bundled plan. Package asset corruption is a release error. */
export function loadBundledOrchestrationProfiles(options: {
  profilesDir?: string;
  references?: OrchestrationProfileReferenceCatalog;
} = {}): OrchestrationProfileDefinition[] {
  const profilesDir = options.profilesDir ?? BUNDLED_ORCHESTRATION_PROFILES_DIR;
  const references = options.references ?? bundledOrchestrationProfileReferences();
  return listOrchestrationProfileDefinitionFiles(profilesDir)
    .map((filePath) => readOrchestrationProfileDefinitionFile(
      filePath,
      references,
      profilesDir,
      profilesDir,
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Resolve one bundled plan by stable ID. */
export function findBundledOrchestrationProfile(
  id: string,
): OrchestrationProfileDefinition | undefined {
  const normalized = id.trim();
  return loadBundledOrchestrationProfiles().find((profile) => profile.id === normalized);
}

function listBundledSkillIds(root: string): Set<string> {
  const result = new Set<string>();
  let categories: fs.Dirent[];
  try {
    categories = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const category of categories) {
    if (!category.isDirectory() || category.isSymbolicLink()) continue;
    const categoryDir = path.join(root, category.name);
    let skills: fs.Dirent[];
    try {
      skills = fs.readdirSync(categoryDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const skill of skills) {
      if (!skill.isDirectory() || skill.isSymbolicLink()) continue;
      const skillFile = path.join(categoryDir, skill.name, 'SKILL.md');
      try {
        const stat = fs.lstatSync(skillFile);
        if (stat.isFile() && !stat.isSymbolicLink()) result.add(skill.name);
      } catch {
        // A malformed package asset is omitted from the reference set, causing
        // any plan that names it to fail through the strict profile parser.
      }
    }
  }
  return result;
}

export function orchestrationProfileRoleReference(
  definition: AgentDefinition,
): OrchestrationProfileRoleReference {
  if (definition.outputContract === null) {
    return {
      defaultAccess: definition.defaultAccess,
      outputContract: null,
    };
  }
  if (typeof definition.outputContract !== 'string') {
    throw new Error(
      `Orchestration role ${definition.id} has an invalid output contract reference.`,
    );
  }
  const contract = BUILT_IN_OUTPUT_CONTRACTS[definition.outputContract];
  if (!contract) {
    throw new Error(
      `Orchestration role ${definition.id} references unknown output contract ${definition.outputContract}.`,
    );
  }
  return {
    defaultAccess: definition.defaultAccess,
    outputContract: {
      id: contract.id,
      sectionAliases: new Set(contract.fields.map((field) => sectionAlias(field.heading))),
    },
  };
}

function sectionAlias(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
