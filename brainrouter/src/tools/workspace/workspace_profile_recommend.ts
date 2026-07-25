/**
 * B3 — catalog-bounded workspace profile recommendation.
 *
 * The handler intersects the shared preset with the live server skill/persona
 * registry and package-owned profile plugins. Its result is advisory only and
 * does not alter tool visibility, authentication, RBAC, or execution policy.
 */
import {
  inspectWorkspaceProfilePlugins,
  isWorkspaceProfileId,
  listDomainPersonas,
  recommendWorkspaceProfileServing,
  WORKSPACE_PROFILES,
  type WorkspaceProfilePluginCatalog,
} from "@kinqs/brainrouter-core/workspace";
import { z } from "zod";
import type { Registry } from "../../registry.js";

export const workspaceProfileRecommendToolSchema = {
  name: "workspace_profile_recommend",
  description: "Recommend the currently servable skill packs, domain persona, capabilities, and starter skills for one workspace profile. Advisory only; this never grants access or changes runtime policy.",
  inputSchema: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        enum: WORKSPACE_PROFILES.map((preset) => preset.id),
        description: "The reviewed workspace profile preference.",
      },
    },
    required: ["profile"],
    additionalProperties: false,
  },
} as const;

const workspaceProfileRecommendInput = z.object({
  profile: z.string().refine(isWorkspaceProfileId),
}).strict();

export interface WorkspaceProfileRecommendOptions {
  /** Immutable catalog snapshot seam for tests and long-lived hosts. */
  profilePlugins?: WorkspaceProfilePluginCatalog;
  /** Domain-persona snapshot seam; production resolves package/workspace personas. */
  personaIds?: readonly string[];
}

export async function handleWorkspaceProfileRecommend(
  registry: Registry,
  args: unknown,
  options: WorkspaceProfileRecommendOptions = {},
) {
  const params = workspaceProfileRecommendInput.parse(args ?? {});
  try {
    const recommendation = recommendWorkspaceProfileServing(params.profile, {
      profilePlugins: options.profilePlugins ?? inspectWorkspaceProfilePlugins(),
      personaIds: options.personaIds ?? listDomainPersonas(
        registry.getLocalRoot() ?? process.cwd(),
      ).map((persona) => persona.id),
      skillIds: registry.listSkills().map((skill) => skill.name),
    });
    if (!recommendation) {
      return errorResult("invalid_profile");
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(recommendation),
      }],
    };
  } catch {
    return errorResult("internal_error");
  }
}

function errorResult(code: "invalid_profile" | "internal_error") {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: { code } }),
    }],
  };
}
