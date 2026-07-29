// Flat ESLint config. Architectural dependency direction is enforced by
// scripts/check-package-boundaries.mjs; this config also rejects the most
// common deep-Core violation while editors and staged-file hooks are running.
// Formatting is owned by Prettier (eslint-config-prettier turns off any
// conflicting rules).
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
      // Import @kinqs/brainrouter-core through a curated public entrypoint,
      // never its compiled `dist/*` internals.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@kinqs/brainrouter-core/dist/**'],
              message:
                'Import from a curated entrypoint (e.g. @kinqs/brainrouter-core/agent), not compiled dist/* internals. The core public API is the per-subsystem entrypoints (Refactor P1).',
            },
          ],
        },
      ],
    },
  },
  // Keep ESLint out of Prettier's lane (must be last).
  prettier,
];
