import { defineConfig } from 'vitest/config';

/**
 * Unit tests project captured Chromium reads and check the options, fully in
 * parallel. A real Electron app is the Electron testbed's.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
  },
});
