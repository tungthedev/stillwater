import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    include: ['src/**/*.test.js', 'tests/**/*.test.js', 'tools/**/*.test.mjs'],
  },
});
