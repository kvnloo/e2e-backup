/**
 * A read whose ref another lookup superseded says nothing about the node: a
 * matcher or `waitFor` that accepts absence samples again instead of passing
 * on it.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const banner: SemanticNode = { ref: { id: 'banner', revision: '' }, role: 'alert', name: 'Saved', testId: 'banner' };

/**
 * A screen that always shows the banner, with the first two lookups answered
 * together: the second supersedes the first one's ref before it is read.
 */
function racedScreen() {
  let lookups = 0;
  let release: () => void = () => {};
  const together = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { screen } = screenOver({
    locate: async (expression) => {
      lookups += 1;
      if (lookups === 2) release();
      if (lookups <= 2) await together;
      return resolveExpression(expression, [banner]);
    },
    observe: () => snapshot([banner]),
    timeoutMs: 300,
  });
  return screen.getByTestId('banner');
}

const outcome = (promise: Promise<void>) => promise.then(() => 'passed', (error: { code?: string }) => error.code);

describe('a read superseded by a concurrent lookup', () => {
  it.each([
    ['not.toBeVisible', (locator: ReturnType<typeof racedScreen>) => expectFixture(locator).not.toBeVisible()],
    ['not.toBeAttached', (locator: ReturnType<typeof racedScreen>) => expectFixture(locator).not.toBeAttached()],
    ['toBeHidden', (locator: ReturnType<typeof racedScreen>) => expectFixture(locator).toBeHidden()],
  ])('does not pass %s on a node that is still there', async (_name, assert) => {
    const locator = racedScreen();
    const [first, second] = await Promise.all([outcome(assert(locator)), outcome(assert(locator))]);
    expect([first, second]).toEqual(['ASSERTION_FAILED', 'ASSERTION_FAILED']);
  });

  it('does not end waitFor hidden or detached on a node that is still there', async () => {
    for (const state of ['hidden', 'detached'] as const) {
      const locator = racedScreen();
      const wait = () => outcome(locator.waitFor({ state }));
      expect(await Promise.all([wait(), wait()])).toEqual(['LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND']);
    }
  });
});
