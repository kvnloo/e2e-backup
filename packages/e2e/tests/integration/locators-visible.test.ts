/**
 * `locators.visible` from a config file, read again in each worker. With the
 * top-level value, the fixture page's hidden nodes are skipped. A target's
 * value takes precedence over it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';

/** Returns a config with `locators: { visible: true }` and one web target, with `target` added to the target. */
function config(target: string): string {
  return `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! }${target} }],
  locators: { visible: true },
  assertionTimeout: 500,
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`;
}

/** Returns a test that expects `count` matches of each hidden node, and the other count when the query sets `visible`. */
function suite(count: number): string {
  return `import { test, expect } from 'e2e';

test('counts hidden nodes', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByText('Hidden content')).toHaveCount(${String(count)});
  await expect(screen.getByTestId('hidden-svg')).toHaveCount(${String(count)});
  await expect(screen.getByText('Hidden content', { visible: ${String(count === 1)} })).toHaveCount(${String(1 - count)});
});
`;
}

describe('locators.visible', () => {
  let app: FixtureApp;
  const projects: FixtureProject[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    for (const project of projects) project.cleanup();
    await app?.close();
  });

  it.each([
    ['skips hidden nodes on a target that inherits visible: true', '', 0],
    ['keeps hidden nodes on a target that sets visible: false', ', locators: { visible: false }', 1],
  ])('%s', async (_title, target, count) => {
    const { outcome, project } = await runProjectWithConfigFile({ 'tests/hidden.e2e.ts': suite(count) }, { appUrl: app.url, configSource: config(target) });
    projects.push(project);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.status, JSON.stringify(outcome.results[0]?.attempts[0]?.error)).toBe('passed');
  }, 240_000);
});
