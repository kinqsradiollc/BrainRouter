/**
 * POLISH-2 (0.4.13) — repair a citation garble some weak models emit.
 *
 * Instead of a literal colon in a `file:line` citation, certain local models emit a
 * sentinel-looking token such as `*#COLON|*` (also seen as `#COLON|`, `*#COLON*`,
 * `#COLON`). This restores the colon so citations render correctly. Surgical: only the
 * known garble is touched — ordinary prose is left untouched. Pure.
 */
const COLON_GARBLE = /\*?#COLON\|?\*?/g;

export function sanitizeModelArtifacts(text: string): string {
  if (!text || text.indexOf('#COLON') === -1) return text;
  return text.replace(COLON_GARBLE, ':');
}
