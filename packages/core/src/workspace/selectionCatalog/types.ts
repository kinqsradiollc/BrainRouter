import type { LocalToolEntry } from '../../tool/registry/registry.js';
import type { LocalToolAvailabilityContext } from '../../tool/registry/executors.js';

export const WORKSPACE_SELECTION_CATALOG_MAX_ENTRIES = 512;
export const WORKSPACE_SELECTION_STABLE_ID = /^[a-z][a-z0-9_-]{0,127}$/;

export type WorkspaceSelectionCatalogKind =
  | 'role'
  | 'capability'
  | 'tool-group'
  | 'tool'
  | 'skill-pack'
  | 'skill'
  | 'runtime-tool';

export type WorkspaceSelectionCatalogSource =
  | 'core'
  | 'extension'
  | 'bundled'
  | 'plugin'
  | 'profile-plugin'
  | 'capability-plugin'
  | 'pack'
  | 'user'
  | 'workspace'
  | 'runtime';

export interface WorkspaceSelectionCatalogEntry {
  id: string;
  kind: WorkspaceSelectionCatalogKind;
  label: string;
  description: string;
  category: string;
  source: WorkspaceSelectionCatalogSource;
  provenance: string;
  persistable: boolean;
  selectable: boolean;
  blockedReason?: string;
  accessTier?: LocalToolEntry['accessTier'];
  actionKind?: LocalToolEntry['actionKind'];
  requiredCapabilityOrExtension?: string;
  /** Capability that activates this implementation payload. */
  managedByCapability?: string;
  runtimeAvailabilityPrerequisites: string[];
  expandsTo?: string[];
}

export interface WorkspaceSelectionCatalog {
  entries: WorkspaceSelectionCatalogEntry[];
  /** Content-free digest used to detect a stale review before write. */
  fingerprint: string;
}

export interface LiveRuntimeToolDescriptor {
  id: string;
  label?: string;
  description?: string;
  category?: string;
}

export interface ContributedWorkspaceSkillRoot {
  /** Safe plugin identifier used only for display provenance. */
  pluginName: string;
  /** Host-resolved directory; never returned in catalog output. */
  path: string;
  selectable: boolean;
  blockedReason?: string;
}

/** Prompt-free role metadata resolved by the host from the runtime registry. */
export interface WorkspaceRoleCatalogDescriptor {
  id: string;
  label: string;
  description: string;
  source: Extract<WorkspaceSelectionCatalogSource, 'bundled' | 'pack' | 'user' | 'workspace'>;
  provenance: string;
}

export interface WorkspaceSelectionCatalogOptions {
  availability?: LocalToolAvailabilityContext;
  /** Skill roots derived from normal plugin discovery, never renderer input. */
  contributedSkillRoots?: readonly ContributedWorkspaceSkillRoot[];
  /** Precedence-resolved executable roles; role prompts never cross this boundary. */
  roles?: readonly WorkspaceRoleCatalogDescriptor[];
  /**
   * Safe live names only. These rows are informational and can never be copied
   * into a manifest selection.
   */
  runtimeTools?: readonly LiveRuntimeToolDescriptor[];
}

export interface ReviewedWorkspaceToolSelection {
  profiles: readonly string[];
  enabled: readonly string[];
  deny: readonly string[];
}

export interface ReviewedWorkspaceSkillSelection {
  packs: readonly string[];
  enabled: readonly string[];
  disabled: readonly string[];
}

export interface ReviewedWorkspaceRoleSelection {
  availableRoles: readonly string[];
  disabledRoles: readonly string[];
}

export interface ReviewedWorkspaceCapabilitySelection {
  enabled: readonly string[];
  disabled: readonly string[];
}

export type WorkspaceSelectionReviewIssueCode =
  | 'invalid-id'
  | 'unknown-entry'
  | 'wrong-kind'
  | 'not-persistable'
  | 'blocked-entry'
  | 'stale-catalog';

export interface WorkspaceSelectionReviewIssue {
  field:
    | 'availableRoles'
    | 'disabledRoles'
    | 'capabilitiesEnabled'
    | 'capabilitiesDisabled'
    | 'profiles'
    | 'enabled'
    | 'deny'
    | 'packs'
    | 'disabled'
    | 'catalog';
  id?: string;
  code: WorkspaceSelectionReviewIssueCode;
  reason: string;
}

export type WorkspaceSelectionReviewResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: WorkspaceSelectionReviewIssue[] };

export interface WorkspaceToolSelectionMigrationDiagnostic {
  required: boolean;
  sourceVersion: number;
  unknownProfileCount: number;
  unknownEnabledCount: number;
  blockedSelectionCount: number;
}
