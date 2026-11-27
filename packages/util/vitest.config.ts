import { defineConfig } from 'vitest/config';

/** The addon against the JavaScript it replaces, on the same inputs. Needs a checkout build: `pnpm build:native`. */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    pool: 'forks',
  },
});
