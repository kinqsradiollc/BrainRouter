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
        ],
      }],
    },
  },
  // Keep ESLint out of Prettier's lane (must be last).
  prettier,
];
