import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', '.wxt/**', 'coverage/**', 'node_modules/**', 'playwright-report/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    /* Typed linting, scoped to the TypeScript that tsconfig.json actually
       covers. Needed by no-implied-eval, and worth the cost on a codebase
       whose job is deciding what to hand the network stack. */
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}', 'e2e/**/*.ts', '*.config.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* The type-aware counterpart to no-implied-eval: it catches a string
         reaching setTimeout through a variable, which the syntactic rule
         cannot see. Scoped to exactly the files the project service knows
         about -- a type-aware rule applied to a file without type information
         is a hard ESLint crash, not a skipped check. */
      '@typescript-eslint/no-implied-eval': 'error',
    },
  },

  {
    rules: {
      /* Invariant 5: no dynamic code execution. The manifest V3 CSP already
         blocks eval in extension pages, but a lint failure names the line
         instead of surfacing as a runtime error nobody sees. */
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      /* Invariant 1: no network egress. The CI guard greps the built bundle,
         which is the authoritative check; this catches it at author time. */
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Headsmith makes no network requests. See SECURITY.md.' },
        { name: 'XMLHttpRequest', message: 'Headsmith makes no network requests.' },
        { name: 'WebSocket', message: 'Headsmith makes no network requests.' },
        { name: 'EventSource', message: 'Headsmith makes no network requests.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'navigator', property: 'sendBeacon', message: 'Headsmith makes no network requests.' },
        { object: 'chrome', property: 'webRequest', message: 'Headsmith is declarativeNetRequest-only.' },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    /* src/core is the pure decision layer: schema, policy, planning, the rule
       compiler and the vault. Keeping chrome.* out of it is what lets the
       compiler be snapshot-tested without a browser, and what keeps the
       "would this profile release a credential?" question answerable from a
       plain object. The CI guard enforces the same rule against the built
       output; this is the author-time half. */
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: 'src/core must stay free of browser APIs. Put the chrome.* call in src/platform and pass the result in.' },
        { name: 'browser', message: 'src/core must stay free of browser APIs.' },
        { name: 'fetch', message: 'Headsmith makes no network requests.' },
        { name: 'XMLHttpRequest', message: 'Headsmith makes no network requests.' },
        { name: 'WebSocket', message: 'Headsmith makes no network requests.' },
        { name: 'EventSource', message: 'Headsmith makes no network requests.' },
      ],
    },
  },

  {
    files: ['src/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  {
    files: ['test/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    rules: {
      /* Test doubles legitimately stand in for browser globals. */
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  /* Last, so it wins: the guard scripts are plain ESM run by node before
     anything is built, deliberately outside the TypeScript project -- a guard
     that needs the build to succeed before it can run is not much of a guard.
     Type-aware rules cannot apply to files the project service does not know
     about, so they are switched off here rather than earlier, where the
     project-wide rules block would turn them back on. */
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
      ecmaVersion: 'latest',
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
