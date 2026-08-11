/**
 * Pure template outcomes shared by local and remote Notes hosts.
 *
 * Copy planning lives in `gesturePlan`; this module owns the user-facing
 * summary of that plan so a browser host does not have to reproduce Core's
 * explanation of internal reference rewrites.
 */
export interface InstantiateResult {
  ok: boolean;
  /** The new page's id, or null when the template was gone. */
  pageId: string | null;
  /** How many blocks the template brought with it — what the surface reports. */
  blocks: number;
  /** How many internal references were rewritten to point at the copy. */
  rewritten: number;
}

/** The sentence a surface shows after instantiating, so the rewrite is not silent. */
export function describeInstantiation(result: InstantiateResult): string {
  if (!result.ok) return 'That template is no longer here.';
  const blocks = `${result.blocks} block${result.blocks === 1 ? '' : 's'}`;
  if (result.rewritten === 0) return `New page from the template — ${blocks}.`;
  const links = `${result.rewritten} link${result.rewritten === 1 ? '' : 's'}`;
  return `New page from the template — ${blocks}, and ${links} inside it now point at this copy `
    + 'rather than at the template.';
}
