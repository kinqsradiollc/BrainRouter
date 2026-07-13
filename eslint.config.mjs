// Flat ESLint config — first pass. The point of this config is ARCHITECTURE
// ENFORCEMENT, not a style/rule flood: it bans deep compiled-internal imports
// across package boundaries (the 442 `@kinqs/*/dist/*` imports the Refactor plan
// targets) as WARN, so the debt is surfaced without a flag-day. Promote to ERROR
// once Refactor P1 migrates them to curated package entrypoints, and add the
// back-edge bans then. Formatting is owned by Prettier (eslint-config-prettier
// turns off any conflicting rules).
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/dist-electron/**',
      '**/build/**',
      // Ephemeral git worktrees (agent fleets / PR-verify checkouts) are full copies
      // of the tree at other commits — never the source of truth, and they trip the
      // no-restricted-imports rule with their older deep-dist imports. Never lint them.
      '**/.worktrees/**',
      '**/.claude/worktrees/**',
      '**/.next/**',
      '**/.open-next/**',
      '**/.wrangler/**',
      '**/.turbo/**',
      '**/release/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      // vendored / content dirs — never lint these
      'openSrc/**',
      'brainrouter-changelog/**',
      'brainrouter-roadmap/**',
      'brainrouter-docs/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    // Register these plugins so the codebase's existing inline `eslint-disable`
    // directives (react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any)
    // resolve to a known rule — their rules are intentionally NOT enabled yet
    // (that ratchets in later); unused directives are silenced for this first pass.
    plugins: { '@typescript-eslint': tsPlugin, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // Refactor P1 (complete for core): import @kinqs/brainrouter-core through a
      // curated subsystem entrypoint (`@kinqs/brainrouter-core/<subsystem>`), never
      // its compiled `dist/*` internals. The migration is done — every consumer is
      // off deep imports and core's `./dist/*` wildcard export is gone — so this is
      // ERROR to keep the boundary closed. Other @kinqs packages aren't god-packages
      // and are intentionally deep-imported in a couple of browser-bundle-sensitive
      // spots, so they are not banned here.
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@kinqs/brainrouter-core/dist/**'],
            message: 'Import from a curated entrypoint (e.g. @kinqs/brainrouter-core/agent), not compiled dist/* internals. The core public API is the per-subsystem entrypoints (Refactor P1).',
          },
          {
            group: ['@kinqs/brainrouter-ui-test/dist/**'],
            message: 'Import from the @kinqs/brainrouter-ui-test barrel, not compiled dist/* internals (brainrouter-rules/01 §3). The barrel re-exports the full public surface and is browser-safe (no node built-ins).',
          },
        ],
      }],
    },
  },
  {
    // The desktop renderer is a browser (vite) bundle. A core subsystem's curated
    // entrypoint re-exports its FULL surface — including Node-only modules
    // (node:fs / node:crypto) that vite can't externalize for the browser, e.g.
    // `randomUUID`. So the renderer intentionally deep-imports the specific
    // browser-safe core modules it needs (the same reason types/atlas-ops is
    // deep-imported). Exempt it from the core deep-import ban. The Electron host
    // (electron/**) runs in Node and DOES use the curated entrypoints.
    files: ['brainrouter-desktop/src/**/*.ts', 'brainrouter-desktop/src/**/*.tsx'],
    // The renderer keeps the CORE deep-import exception (core's full surface pulls
    // node:fs/crypto that vite can't externalize). But @kinqs/brainrouter-ui-test's
    // barrel is browser-safe, so its dist/* stays banned here too — use the barrel.
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@kinqs/brainrouter-ui-test/dist/**'],
          message: 'Import from the @kinqs/brainrouter-ui-test barrel, not compiled dist/* internals (brainrouter-rules/01 §3).',
        }],
      }],
    },
  },
  // Keep ESLint out of Prettier's lane (must be last).
  prettier,
];
