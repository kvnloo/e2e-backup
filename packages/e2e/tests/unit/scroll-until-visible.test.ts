/**
 * `screen.scrollUntilVisible`: polls the target through the locator engine
 * and swipes the viewport between polls. What the engine sees is a step of
 * 0.65 of the scroll container over 800 ms in the requested direction,
 * addressed to the observation root, repeated until the target reads as
 * visible or the deadline passes, then the target brought into view when
 * the engine can. Every swipe is
 * bounded by that deadline. The target, like a `dragTo` target and a
 * `filter({ has })` locator, has to come from the same target's screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError, resolveExpression, type NodeRef, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import { sleep } from '@e2e-dev/core/lib/internal/time';
import type { Locator, Screen } from '@e2e-dev/core/lib/types';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';

const TARGET: SemanticNode = { ref: { id: 'target', revision: '' }, role: 'button', name: 'Accept', text: 'Accept' };
const HIDDEN_TARGET: SemanticNode = { ...TARGET, states: { hidden: true } };
/** The scroll container every screen shows, with whatever it has scrolled to as its children. */
const feed = (...children: readonly SemanticNode[]): SemanticNode => ({
  ref: { id: 'feed', revision: '' },
  role: 'list',
  name: 'Feed',
  ...(children.length === 0 ? {} : { children }),
});
const ROOT: NodeRef = { id: 'root', revision: '' };
const VIEWPORT = { width: 390, height: 844 } as const;
const SWIPE_MS = 16;
type ScrollOptions = Parameters<Screen['scrollUntilVisible']>[1];

interface Swipe {
  readonly ref: string;
  readonly direction: string;
  readonly distance: number;
  readonly durationMs: number;
}

/** The step a scroll takes when a test names no distance or speed. */
const STEP = { distance: 0.65, durationMs: 800 } as const;

interface ScrollScript {
  /** What the screen shows before any swipe, then after each; the last entry stays. */
  readonly screens: readonly (readonly SemanticNode[])[];
  /** Whether the engine declares the swipe action; default true. */
  readonly swipeable?: boolean;
  /** Whether the engine declares `scrollIntoView` too; default false. */
  readonly bringsIntoView?: boolean;
  /**
   * Every swipe hangs, then fails as an engine reporting a timeout does: `true`
   * for the whole operation budget, as one honouring `timeoutMs` does, or a
   * number of milliseconds of its own clock.
   */
  readonly hang?: boolean | number;
  /** The action timeout of the locator engine; default 1000 ms. */
  readonly actionTimeout?: number;
}

/** A screen over a fake engine that pages through `screens` one swipe at a time and logs every swipe. */
function scrollScreen(script: ScrollScript) {
  const swipes: Swipe[] = [];
  const broughtIntoView: string[] = [];
  const current = (): readonly SemanticNode[] =>
    script.screens[Math.min(swipes.length, script.screens.length - 1)] ?? [];
  const { screen, steps } = screenOver({
    // The root stays one node whatever is on screen, since a viewport swipe is addressed to it.
    observe: () => ({ root: { ref: ROOT, role: 'root', children: current() }, viewport: VIEWPORT }),
    locate: (expression) => resolveExpression(expression, current()),
    ...(script.swipeable === false
      ? {}
      : {
          actions: script.bringsIntoView === true ? ['swipe', 'scrollIntoView'] : ['swipe'],
          perform: async (ref, action, operation) => {
            if (action.kind === 'scrollIntoView') {
              broughtIntoView.push(ref.id);
              return;
            }
            if (action.kind !== 'swipe') throw new Error(`unexpected ${action.kind}`);
            if (script.hang !== undefined && script.hang !== false) {
              const budget = script.hang === true ? operation.timeoutMs : script.hang;
              await sleep(budget);
              throw new EngineError('OPERATION_TIMEOUT', `swipe exceeded ${budget} ms`, { retryable: false });
            }
            // A swipe resolves once the scroll it caused is on screen, a frame or more later.
            await sleep(SWIPE_MS);
            swipes.push({ ref: ref.id, direction: action.direction, distance: action.distance, durationMs: action.durationMs });
          },
        }),
    timeoutMs: script.actionTimeout ?? 1_000,
  });
  return { screen, steps, swipes, broughtIntoView };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setTimerTickMode('nextTimerAsync');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('screen.scrollUntilVisible', () => {
  it('on a locator, swipes that node instead of the viewport, so a scroll container pages', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[feed()], [feed()], [feed(TARGET)]] });
    await screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([
      { ref: 'feed', direction: 'down', ...STEP },
      { ref: 'feed', direction: 'down', ...STEP },
    ]);
  });

  it('takes a direction, a distance, and a speed for each step, on the screen and on a locator', async () => {
    const viewport = scrollScreen({ screens: [[], [TARGET]] });
    await viewport.screen.scrollUntilVisible(viewport.screen.getByText('Accept'), { direction: 'up', distance: 0.4, speed: 'fast' });
    expect(viewport.swipes).toEqual([{ ref: 'root', direction: 'up', distance: 0.4, durationMs: 150 }]);
    const { screen, swipes } = scrollScreen({ screens: [[feed()], [feed(TARGET)]] });
    await screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { direction: 'right', speed: 'slow' });
    expect(swipes).toEqual([{ ref: 'feed', direction: 'right', distance: 0.65, durationMs: 1500 }]);
  });

  it.each([
    ['momentum, which distance and speed replaced', { momentum: 'fast' }],
    ['a distance of 0', { distance: 0 }],
    ['a distance above 1', { distance: 1.5 }],
    ['a speed that is not a preset', { speed: 'warp' }],
  ])('refuses %s before any swipe', async (_label, options) => {
    const { screen, swipes } = scrollScreen({ screens: [[], [TARGET]] });
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), invalid<ScrollOptions>(options))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(swipes).toEqual([]);
  });

  it('brings the target into view once it shows, when the engine can', async () => {
    const { screen, swipes, broughtIntoView } = scrollScreen({ screens: [[], [TARGET]], bringsIntoView: true });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([{ ref: 'root', direction: 'down', ...STEP }]);
    expect(broughtIntoView).toEqual(['target']);
  });

  it('sends no gesture for a target visible on the first read', async () => {
    const { screen, swipes, broughtIntoView } = scrollScreen({ screens: [[TARGET]], bringsIntoView: true });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([]);
    expect(broughtIntoView).toEqual([]);
  });

  it('returns at once when the target is already visible, with no swipe', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([]);
  });

  it('steps down at the observation root until the target appears, then stops', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[], [], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([
      { ref: 'root', direction: 'down', ...STEP },
      { ref: 'root', direction: 'down', ...STEP },
    ]);
  });

  it('keeps scrolling past a target the engine reports hidden', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[HIDDEN_TARGET], [HIDDEN_TARGET], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toHaveLength(2);
  });

  it('fails as LOCATOR_NOT_FOUND naming the locator once the deadline passes, and records the failed step', async () => {
    const { screen, steps, swipes } = scrollScreen({ screens: [[]] });
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { speed: 'fast', timeout: 250 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
      details: { locator: 'getByText("Accept")', name: 'Accept', waitedMs: expect.any(Number) },
    });
    expect(swipes.length).toBeGreaterThanOrEqual(1);
    expect(steps.all()).toEqual([
      expect.objectContaining({
        kind: 'screen',
        api: 'screen.scrollUntilVisible',
        label: 'getByText("Accept")',
        status: 'failed',
        error: expect.objectContaining({ code: 'LOCATOR_NOT_FOUND' }),
      }),
    ]);
  });

  it('bounds a viewport swipe by its own deadline: a hung swipe is LOCATOR_NOT_FOUND within the scroll timeout, not the action timeout', async () => {
    const { screen, steps } = scrollScreen({ screens: [[]], hang: true, actionTimeout: 5_000 });
    const started = Date.now();
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { speed: 'fast', timeout: 250 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(steps.all()).toEqual([expect.objectContaining({ api: 'screen.scrollUntilVisible', status: 'failed' })]);
  });

  it('bounds a locator swipe by the same deadline', async () => {
    const { screen, steps } = scrollScreen({ screens: [[feed()]], hang: true, actionTimeout: 5_000 });
    const started = Date.now();
    await expect(
      screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { speed: 'fast', timeout: 250 }),
    ).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
      cause: expect.objectContaining({ code: 'ACTION_FAILED', cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }) }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(steps.all()).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'LOCATOR_NOT_FOUND' }) }),
    ]);
  });

  it('owns the outcome whichever timer fires first: a swipe timing out on the budget the deadline left it is LOCATOR_NOT_FOUND', async () => {
    // A swipe whose budget is the deadline's remainder, ending on the engine's
    // own clock a moment before this one reads the deadline as passed.
    const { screen } = scrollScreen({ screens: [[]], hang: 110, actionTimeout: 5_000 });
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { speed: 'fast', timeout: 200 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
  });

  it('sends no step whose drag cannot finish before the deadline, and fails as LOCATOR_NOT_FOUND', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[], [TARGET]] });
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { timeout: 500 })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(swipes).toEqual([]);
  });

  it('keeps an engine timeout far from the deadline as the action failure it is', async () => {
    const { screen, steps } = scrollScreen({ screens: [[feed()]], hang: 20, actionTimeout: 5_000 });
    await expect(
      screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { timeout: 30_000 }),
    ).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'operation timed out: getByRole("list", name: "Feed")',
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
    expect(steps.all()).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'ACTION_FAILED' }) }),
    ]);
  });

  it('rejects a target that is not an e2e locator before recording a step', async () => {
    const { screen, steps, swipes } = scrollScreen({ screens: [[TARGET]] });
    await expect(screen.scrollUntilVisible(invalid<Locator>({}))).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
      message: 'scrollUntilVisible requires an e2e locator',
    });
    expect(steps.all()).toEqual([]);
    expect(swipes).toEqual([]);
  });

  it('on a locator, labels the step with the target, whose description carries the scope once', async () => {
    const { screen, steps } = scrollScreen({ screens: [[feed()], [feed(TARGET)]] });
    const container = screen.getByRole('list', { name: 'Feed' });
    await container.scrollUntilVisible(container.getByText('Accept'));
    expect(steps.all()).toEqual([
      expect.objectContaining({
        api: 'screen.scrollUntilVisible',
        label: 'getByRole("list", name: "Feed") >> getByText("Accept")',
        status: 'passed',
      }),
    ]);
  });

  it('needs the swipe action only once it has to scroll: a visible target passes on an engine without one', async () => {
    const visible = scrollScreen({ screens: [[TARGET]], swipeable: false });
    await visible.screen.scrollUntilVisible(visible.screen.getByText('Accept'));
    const absent = scrollScreen({ screens: [[]], swipeable: false });
    await expect(absent.screen.scrollUntilVisible(absent.screen.getByText('Accept'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});

describe("a locator made by another target's screen", () => {
  const FOREIGN = "the one given belongs to another target's screen or another attempt";
  const targets = () => ({
    web: scrollScreen({ screens: [[TARGET]] }),
    mobile: scrollScreen({ screens: [[TARGET]] }),
  });

  it('is refused by scrollUntilVisible before any step on either target', async () => {
    const { web, mobile } = targets();
    await expect(web.screen.scrollUntilVisible(mobile.screen.getByText('Accept'))).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
      message: `scrollUntilVisible requires a locator made by this screen; ${FOREIGN}`,
    });
    expect(web.steps.all()).toEqual([]);
    expect(web.swipes).toEqual([]);
    expect(mobile.swipes).toEqual([]);
  });

  it('is refused by dragTo', () => {
    const { web, mobile } = targets();
    expect(() => web.screen.getByText('Accept').dragTo(mobile.screen.getByText('Accept'))).toThrowError(
      expect.objectContaining({
        code: 'INVALID_LOCATOR',
        message: `dragTo requires a locator made by this screen; ${FOREIGN}`,
      }),
    );
    expect(web.steps.all()).toEqual([]);
  });

  it('is refused by filter({ has })', () => {
    const { web, mobile } = targets();
    expect(() => web.screen.getByRole('list').filter({ has: mobile.screen.getByText('Accept') })).toThrowError(
      expect.objectContaining({
        code: 'INVALID_LOCATOR',
        message: `filter({ has }) requires a locator made by this screen; ${FOREIGN}`,
      }),
    );
  });
});
