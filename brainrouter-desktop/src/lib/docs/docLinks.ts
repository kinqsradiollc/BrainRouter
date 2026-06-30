/**
 * Pure link-routing helpers for the Editor's Markdown preview. A Markdown link
 * must never navigate the app window (Electron would treat a relative href as a
 * same-origin nav and destroy the SPA, or pop a window). The preview intercepts
 * every click and routes via these helpers; kept dependency-free + unit-testable.
 */

/** Matches an absolute/scheme-relative URL: http(s)://, //host, app:// … */
export const EXTERNAL_HREF = /^([a-z][\w+.-]*:)?\/\//i;

/** True for links that should open in the system browser, not the editor. */
export function isExternalHref(href: string): boolean {
  return EXTERNAL_HREF.test(href) || href.startsWith('mailto:');
}

/**
 * Resolve a relative Markdown link against the current doc's directory, producing
 * a normalized workspace-relative path (handles `./`, `../`, and bare names).
 * `currentPath` is the open doc's workspace-relative path (or null at root).
 */
export function resolveDocHref(currentPath: string | null, href: string): string {
  const baseDir = currentPath && currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
  const stack = baseDir ? baseDir.split('/') : [];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}
