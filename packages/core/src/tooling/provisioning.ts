/**
 * ADR-028 I1/I2 — what is missing, what it unlocks, and how to get it.
 *
 * The stack feature shipped and then sat unused because `gh-stack` was not
 * installed. A1 was correctly reporting it unavailable the whole time — which
 * is a different failure from the ones this ADR has been fixing. Not a false
 * claim, but a true one nobody acted on.
 *
 * **Nothing here installs anything.** This produces the plan; a human clicks.
 * Installing software on someone's machine without asking is not a convenience,
 * it is a compromise — a developer tool that quietly runs a package manager has
 * taken a decision belonging to the person whose machine it is, and "it was only
 * a CLI extension" is the reasoning behind every supply-chain incident worth
 * naming.
 */

export interface ToolRequirement {
  id: string;
  /** What it is called, as a person would say it. */
  label: string;
  /** What stops working without it — never "required", always the consequence. */
  unlocks: string;
  /** The exact command, shown in full BEFORE it runs. */
  installCommand: string;
  /** True when the app genuinely cannot run without it. */
  essential: boolean;
}

/**
 * What BrainRouter looks for.
 *
 * `gh` is not bundled and that is not close. Shipping it would mean carrying a
 * binary we do not maintain, on three platforms, that talks to GitHub with the
 * user's credentials — and owning its CVEs on our release cadence rather than
 * its own. A tool that authenticates to a forge should be updated by whoever
 * writes it (I2).
 */
export const TOOL_REQUIREMENTS: readonly ToolRequirement[] = [
  {
    id: 'git',
    label: 'Git',
    unlocks: 'everything that reads or writes a repository',
    installCommand: 'xcode-select --install',
    essential: true,
  },
  {
    id: 'gh',
    label: 'GitHub CLI',
    unlocks: 'opening pull requests, reading checks, and reviewing from the app',
    installCommand: 'brew install gh',
    essential: false,
  },
  {
    id: 'gh-stack',
    label: 'the gh-stack extension',
    unlocks: 'stacked pull requests — one chain of layers instead of one large change',
    installCommand: 'gh extension install github/gh-stack',
    essential: false,
  },
];

export interface ToolStatus {
  id: string;
  present: boolean;
  /** The version found, when we could read one. */
  version?: string;
}

export type ProvisionAction =
  /** Everything needed is here. */
  | { kind: 'ready' }
  /** Something is missing and installing it is one command. */
  | { kind: 'offer'; missing: ToolRequirement[]; message: string }
  /** Something ESSENTIAL is missing — stated, still not auto-installed. */
  | { kind: 'blocked'; missing: ToolRequirement[]; message: string };

export interface ProvisionState {
  /** Requirement ids the person has already declined. */
  declined: ReadonlySet<string>;
}

/**
 * Decide what to say about the tooling, once per launch.
 *
 * A declined offer is not repeated. Asking again next launch is how a prompt
 * becomes noise, and then the one that matters is dismissed reflexively
 * (ADR-027 §1). The person can still install from settings whenever they want.
 */
export function planProvisioning(
  statuses: readonly ToolStatus[],
  state: ProvisionState = { declined: new Set() },
  requirements: readonly ToolRequirement[] = TOOL_REQUIREMENTS,
): ProvisionAction {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const missing = requirements.filter((r) => !byId.get(r.id)?.present);

  const essential = missing.filter((r) => r.essential);
  if (essential.length > 0) {
    return {
      kind: 'blocked',
      missing: essential,
      message:
        `${listOf(essential.map((r) => r.label))} ${essential.length === 1 ? 'is' : 'are'} not installed, ` +
        `and ${essential.length === 1 ? 'it is' : 'they are'} needed for ${essential[0]!.unlocks}.`,
    };
  }

  const offerable = missing.filter((r) => !state.declined.has(r.id));
  if (offerable.length === 0) return { kind: 'ready' };

  return {
    kind: 'offer',
    missing: offerable,
    // Leads with what it UNLOCKS. "gh-stack is not installed" is a fact about
    // your machine; "stacked pull requests are unavailable" is a fact about
    // what you can do, and only the second tells you whether to care.
    message: offerable.length === 1
      ? `${capitalise(offerable[0]!.unlocks)} — needs ${offerable[0]!.label}.`
      : `${offerable.length} features are unavailable: ${listOf(offerable.map((r) => r.unlocks))}.`,
  };
}

/**
 * The command shown before it runs.
 *
 * Shown in full, always, because someone who would rather run it themselves —
 * in their own shell, having read it — must be able to. A one-click install
 * whose command is hidden is asking for trust it has not earned.
 */
export function installPreview(requirement: ToolRequirement): string {
  return [
    `This runs: ${requirement.installCommand}`,
    `It installs ${requirement.label}, which enables ${requirement.unlocks}.`,
    'You can run it yourself instead — nothing here happens without your click.',
  ].join('\n');
}

function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
