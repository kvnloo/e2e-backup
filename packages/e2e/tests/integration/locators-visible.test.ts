/**
 * `locators.visible` from a config file, read again in each worker. With the
 * top-level value, the fixture page's hidden nodes are skipped. A target's
 * value overrides it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';

/** Returns a config with `locators: { visible: true }` and one web target, appending `target` to its fields. */
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

/**
 * Returns a test for a target whose `locators.visible` resolves to `visible`.
 * A zero-size checkbox stays in the accessibility tree, so a role query
 * matches it unless the query sets `visible: true`.
 */
function suite(visible: boolean): string {
  const byDefault = visible ? 0 : 1;

  return `import { test, expect } from 'e2e';

test('counts hidden nodes', async ({ app, browser, screen }) => {
  await app.open();
  await expect(screen.getByText('Hidden content')).toHaveCount(${String(byDefault)});
  await expect(screen.getByTestId('hidden-svg')).toHaveCount(${String(byDefault)});
  await expect(screen.getByText('Hidden content', { visible: ${String(!visible)} })).toHaveCount(${String(1 - byDefault)});

  await browser.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<label><input type="checkbox" style="opacity:0;width:0;height:0;margin:0;position:absolute">Agree</label>');
  });
  await expect(screen.getByRole('checkbox', 'Agree')).toHaveCount(1);
  await expect(screen.getByRole('checkbox', 'Agree', { visible: true })).toHaveCount(0);
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
    ['skips hidden nodes on a target that inherits visible: true', '', true],
    ['keeps hidden nodes on a target that sets visible: false', ', locators: { visible: false }', false],
  ])('%s', async (_title, target, visible) => {
    const { outcome, project } = await runProjectWithConfigFile({ 'tests/hidden.e2e.ts': suite(visible) }, { appUrl: app.url, configSource: config(target) });
    projects.push(project);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.status, JSON.stringify(outcome.results[0]?.attempts[0]?.error)).toBe('passed');
  }, 240_000);
});
