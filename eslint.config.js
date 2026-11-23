import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'captures/**', '.scratch/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Existing codebase has unused helpers/vars/params; warn instead of blocking Slice 3.
      'no-unused-vars': 'warn',
      // Existing codebase uses empty catch {} blocks (e.g. localStorage/JSON fallbacks).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ESLint 10 recommended rule fires on existing assignments in src/audio.js, stream.js, trail.js.
      'no-useless-assignment': 'warn',
    },
  },
  {
    files: ['tools/**/*.mjs', '*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        // Exposed on window by src/main.js and read inside page.evaluate() in tools/playtest.mjs.
        __game: 'readonly',
      },
    },
    rules: {
      // Existing tools/chrome.mjs uses empty catch {} blocks for JSON parsing fallback.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
