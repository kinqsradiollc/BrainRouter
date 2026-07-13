/**
 * Screen inference v1 — the simplest mapping: one route/screen source file → one
 * manifest screen. A file living under pages/ · routes/ · screens/ · views/ (or a
 * Next.js `app/**​/page.tsx`) is a screen; everything else contributes its testIDs
 * to a synthetic shared screen. Hierarchy/navigation edges are a later enhancement
 * (explicitly out of scope for v1).
 */

/** The synthetic screen that collects testIDs from non-screen files. */
export const SHARED_SCREEN_ID = '__shared__';
export const SHARED_SCREEN_TITLE = 'Shared';

const SCREEN_DIR_RE = /(?:^|[\\/])(?:pages|routes|screens|views)[\\/]/i;
const NEXT_APP_PAGE_RE = /(?:^|[\\/])app[\\/].*[\\/]?page\.[jt]sx?$/i;
const FRAMEWORK_BASENAMES = /^(?:page|index|route|layout|screen|view)$/i;
// Broad mode (zero-instrumentation): also treat these dirs + component-name
// suffixes as screens, so an app that uses no data-testid (its UI lives in
// panels/*, *Dialog, *View, …) still maps to real screens rather than one
// "Shared" bucket. Off by default — precise (data-testid) behaviour is unchanged.
const BROAD_SCREEN_DIR_RE = /(?:^|[\\/])(?:panels|dialogs)[\\/]/i;
const COMPONENT_SCREEN_RE = /(?:Panel|Dialog|View|Screen|Page|Modal|Thread|Composer|Sidebar)\.[jt]sx?$/;

export interface ScreenClass {
  isScreen: boolean;
  id: string;
  title: string;
  route: string | null;
}

function toForward(p: string): string {
  return p.replace(/\\/g, '/');
}

function basenameNoExt(path: string): string {
  const file = toForward(path).split('/').pop() ?? '';
  return file.replace(/\.[jt]sx?$/i, '');
}

/** `UserProfile` / `user_profile` / `user profile` → `user-profile`. */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** `user-profile` / `UserProfile` → `User Profile`. */
export function humanize(name: string): string {
  return kebab(name)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function routeFrom(id: string): string {
  if (id === 'home' || id === 'index' || id === '') return '/';
  return `/${id}`;
}

/** Classify a workspace-relative path into a screen (or the shared bucket).
 *  `broad` also accepts panels/dialogs dirs + component-name suffixes as screens. */
export function classifyScreen(relPath: string, opts: { broad?: boolean } = {}): ScreenClass {
  const norm = toForward(relPath);
  const isScreen =
    SCREEN_DIR_RE.test(norm) ||
    NEXT_APP_PAGE_RE.test(norm) ||
    (!!opts.broad && (BROAD_SCREEN_DIR_RE.test(norm) || COMPONENT_SCREEN_RE.test(norm)));

  let nameSource = basenameNoExt(norm);
  // Next.js-style `app/login/page.tsx` — the folder names the screen.
  if (FRAMEWORK_BASENAMES.test(nameSource)) {
    const parts = norm.split('/');
    nameSource = parts[parts.length - 2] ?? nameSource;
  }

  const id = kebab(nameSource) || 'screen';
  return {
    isScreen,
    id,
    title: humanize(nameSource) || 'Screen',
    route: isScreen ? routeFrom(id) : null,
  };
}
