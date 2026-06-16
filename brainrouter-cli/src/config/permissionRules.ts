/**
 * T7 — pure editor for the cli.permissions rule set ({allow, deny}). The desktop
 * Settings → Permissions editor and the inline "always allow" path both funnel
 * through this so the merge semantics (dedupe, trim, idempotent remove) live in
 * one tested place. Deny wins at the gate; allow downgrades ask → these helpers
 * only maintain the lists, not the evaluation.
 */
export interface RuleSet {
  allow: string[];
  deny: string[];
}

export type RuleKind = 'allow' | 'deny';
export type RuleOp = 'add' | 'remove';

export function normalizeRuleSet(rules: Partial<RuleSet> | undefined): RuleSet {
  return { allow: [...(rules?.allow ?? [])], deny: [...(rules?.deny ?? [])] };
}

/** Add or remove a rule from the given list, returning a NEW rule set. Add is
 *  idempotent (no duplicates); remove is a no-op when absent. Empty rules are
 *  rejected on add. */
export function applyRuleEdit(rules: Partial<RuleSet> | undefined, op: RuleOp, kind: RuleKind, rule: string): RuleSet {
  const next = normalizeRuleSet(rules);
  const trimmed = rule.trim();
  const list = next[kind];
  if (op === 'add') {
    if (trimmed && !list.includes(trimmed)) list.push(trimmed);
  } else {
    const i = list.indexOf(trimmed);
    if (i >= 0) list.splice(i, 1);
  }
  return next;
}
