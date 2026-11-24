/**
 * `locators.visible` from a config file, read again in each worker. With the
 * top-level value, the fixture page's hidden nodes are skipped. A target's
 * value takes precedence over it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { runProjectWithConfigFile, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [
    { name: 'inherits', engine: web(), app: { url: process.env.APP_URL! } },
    { name: 'overrides', engine: web(), app: { url: process.env.APP_URL! }, locators: { visible: false } },
  ],
  locators: { visible: true },
  assertionTimeout: 500,
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`;

const SUITE = `import { test, expect } from 'e2e';

test('skips hidden nodes', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByText('Hidden content', { visible: false })).toHaveCount(1);
  await expect(screen.getByTestId('hidden-svg', { visible: false })).toHaveCount(1);
  await expect(screen.getByTestId('hidden-svg')).toHaveCount(0);
  await expect(screen.getByText('Hidden content')).toHaveCount(0);
});
`;

describe('locators.visible', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProjectWithConfigFile({ 'tests/hidden.e2e.ts': SUITE }, { appUrl: app.url, configSource: CONFIG }));
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('skips hidden nodes on a target that inherits visible: true', () => {
    const result = outcome.results.find((candidate) => candidate.target.name === 'inherits');
    expect(result?.status, JSON.stringify(result?.attempts[0]?.error)).toBe('passed');
  });

  it('keeps hidden nodes on a target that sets visible: false', () => {
    const result = outcome.results.find((candidate) => candidate.target.name === 'overrides');
    expect(result?.status).toBe('failed');
    expect(result?.attempts[0]?.error?.message).toContain('getByTestId("hidden-svg")');
  });
});
