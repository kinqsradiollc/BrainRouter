/**
 * Command service (ADR-008, Wave 2) — a stateless port over the pure slash-command
 * registry/help helpers (token extraction, duplicate + drift detection between the
 * completion list and /help). Additive and behaviour-preserving: every method
 * delegates to the existing registry functions. The static catalog stays
 * importable. No logic moved or removed.
 */
import {
  helpEntryTokens, helpCommandTokens, helpPrimaryCommands, helpEntryRows,
  findDuplicates, registryDrift, type HelpCategoryLike, type RegistryDrift,
} from "./registry.js";

/** The command-registry helpers contract (all pure). */
export interface ICommandService {
  entryTokens(cmd: string): string[];
  commandTokens(categories: HelpCategoryLike[]): string[];
  primaryCommands(categories: HelpCategoryLike[]): string[];
  entryRows(categories: HelpCategoryLike[]): string[];
  findDuplicates(names: readonly string[]): string[];
  registryDrift(slashCommands: readonly string[], helpTokens: readonly string[]): RegistryDrift;
}

/** {@link ICommandService} backed by the in-process command registry — delegates only. */
export class CommandService implements ICommandService {
  entryTokens(cmd: string): string[] {
    return helpEntryTokens(cmd);
  }
  commandTokens(categories: HelpCategoryLike[]): string[] {
    return helpCommandTokens(categories);
  }
  primaryCommands(categories: HelpCategoryLike[]): string[] {
    return helpPrimaryCommands(categories);
  }
  entryRows(categories: HelpCategoryLike[]): string[] {
    return helpEntryRows(categories);
  }
  findDuplicates(names: readonly string[]): string[] {
    return findDuplicates(names);
  }
  registryDrift(slashCommands: readonly string[], helpTokens: readonly string[]): RegistryDrift {
    return registryDrift(slashCommands, helpTokens);
  }
}

/** Construct a command service. */
export function createCommandService(): ICommandService {
  return new CommandService();
}
