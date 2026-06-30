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
      // Refactor P1: import a package's public entrypoint, never its compiled
      // `dist/*` internals. WARN now (debt) → ERROR after the migration.
      'no-restricted-imports': ['warn', {
        patterns: [
          {
            group: ['@kinqs/*/dist/**'],
            message: 'Import from the package public entrypoint, not its compiled dist/* internals (Refactor P1 — migrate to a curated core entrypoint).',
          },
        ],
      }],
    },
  },
  // Keep ESLint out of Prettier's lane (must be last).
  prettier,
];
