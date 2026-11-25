/** `screen.scrollTo` and `locator.scrollTo` over a fake engine: what reaches the engine, the step, and the refusals. */

import { describe, expect, it, vi } from 'vitest';
import {
  EngineError,
  LOCATOR_ACTION_KINDS,
  resolveExpression,
  type LocatorAction,
  type LocatorActionKind,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
} from '@e2e-dev/core/lib/engine/index';
import { createScopedScreen, screenInternals } from '@e2e-dev/core/lib/locator/screen';
import type { ScrollEdge } from '@e2e-dev/core/lib/types';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const FEED = { ref: { id: 'feed', revision: '' }, role: 'list' as const, name: 'Feed', testId: 'feed' };
const TITLE = { ref: { id: 'title', revision: '' }, role: 'heading' as const, name: 'Inbox' };
const NODES = [TITLE, FEED];

/** A screen over one list, keeping every action and the ref it was addressed to. */
function feedScreen(options: {
  actions?: readonly LocatorActionKind[];
  perform?: (action: LocatorAction, operation: OperationContext) => Promise<void>;
  timeoutMs?: number;
} = {}) {
  const received: { ref: string; action: LocatorAction }[] = [];
  const locate = vi.fn(async (expression: LocatorExpression) => resolveExpression(expression, NODES));
  const { screen, steps } = screenOver({
    locate,
    observe: () => snapshot(NODES),
    perform: async (ref: NodeRef, action, operation) => {
      received.push({ ref: ref.id, action });
      await options.perform?.(action, operation);
    },
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { screen, steps, received, locate };
}

describe('scrollTo', () => {
  it('scrolls the screen through the observation root, one step named by the edge', async () => {
    const { screen, steps, received } = feedScreen();
    await screen.scrollTo('bottom');
    expect(received).toEqual([{ ref: 'root', action: { kind: 'scrollTo', edge: 'bottom' } }]);
    expect(steps.all()).toEqual([expect.objectContaining({ api: 'screen.scrollTo', label: 'bottom', status: 'passed' })]);
  });

  it('scrolls a located node, its step naming the node and the edge', async () => {
    const { screen, steps, received } = feedScreen();
    await screen.getByTestId('feed').scrollTo('left', { timeout: 500 });
    expect(received).toEqual([{ ref: 'feed', action: { kind: 'scrollTo', edge: 'left' } }]);
    expect(steps.all()).toEqual([
      expect.objectContaining({ api: 'locator.scrollTo', label: 'getByTestId("feed") → left', status: 'passed' }),
    ]);
  });

  it.each(['middle', 'bottomRight', 0, undefined])('refuses the edge %j before any lookup, action, or step', async (edge) => {
    const { screen, steps, received, locate } = feedScreen();
    for (const call of [() => screen.scrollTo(invalid<ScrollEdge>(edge)), () => screen.getByTestId('feed').scrollTo(invalid<ScrollEdge>(edge))]) {
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringMatching(/^scrollTo takes an edge: 'top', 'bottom', 'left', 'right'; got /),
      });
    }
    expect(locate).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(steps.all()).toEqual([]);
  });

  it('refuses an option it does not take on the screen', async () => {
    const { screen, steps } = feedScreen();
    await expect(Promise.resolve().then(() => screen.scrollTo('top', invalid({ behavior: 'smooth' })))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/^scrollTo options has no key "behavior"/),
    });
    expect(steps.all()).toEqual([]);
  });

  it('is UNSUPPORTED_CAPABILITY on an engine that does not declare it, before any lookup', async () => {
    const { screen, received, locate } = feedScreen({ actions: LOCATOR_ACTION_KINDS });
    await expect(screen.scrollTo('bottom')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('the "scrollTo" action is not available on this target'),
    });
    await expect(screen.getByTestId('feed').scrollTo('bottom')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(locate).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it.each(['OPERATION_TIMEOUT', 'ACTION_MAY_HAVE_COMMITTED'] as const)(
    'says the edge was not reached when the engine reports its cut budget as %s',
    async (code) => {
      const perform = async (_action: LocatorAction, operation: OperationContext): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, operation.timeoutMs + 20));
        throw new EngineError(code, 'still moving', { retryable: false });
      };
      const { screen } = feedScreen({ perform, timeoutMs: 50 });
      await expect(screen.scrollTo('bottom')).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringMatching(/^scrollTo\('bottom'\) did not reach the edge within \d+ms \(still moving\)$/),
      });
      await expect(screen.getByTestId('feed').scrollTo('top')).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringMatching(/^scrollTo\('top'\) did not reach the edge within \d+ms \(still moving\): getByTestId\("feed"\)$/),
      });
    },
  );

  it('says the edge was not reached when the engine stops before the deadline, as engines leave themselves a margin', async () => {
    const perform = async (): Promise<void> => {
      throw new EngineError('OPERATION_TIMEOUT', 'the content was still moving after 4 drags when the budget ran out', { retryable: false });
    };
    const { screen } = feedScreen({ perform });
    await expect(screen.getByTestId('feed').scrollTo('bottom')).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringMatching(/^scrollTo\('bottom'\) did not reach the edge within \d+ms \(the content was still moving after 4 drags when the budget ran out\): getByTestId\("feed"\)$/),
    });
  });

  it('keeps a locate that timed out before anything was sent as the locate failure', async () => {
    const { screen, received } = feedScreen({ timeoutMs: 50 });
    const failure = await screen.getByTestId('missing').scrollTo('bottom').catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(received).toEqual([]);
  });

  it('refuses a frame\'s screen, whose root is the screen around the frame', async () => {
    const { screen, received } = feedScreen();
    const frame = createScopedScreen(screenInternals(screen)!.context, (expression) => expression);
    await expect(Promise.resolve().then(() => frame.scrollTo('bottom'))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('call it on a locator inside the frame'),
    });
    expect(received).toEqual([]);
  });

  it('keeps an engine failure that is not the deadline as the engine reported it', async () => {
    const perform = async (): Promise<void> => {
      throw new EngineError('NOT_ACTIONABLE', 'the soft keyboard covers everything there is to scroll', { retryable: false });
    };
    const { screen } = feedScreen({ perform });
    await expect(screen.scrollTo('bottom')).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'the soft keyboard covers everything there is to scroll',
    });
  });
});
