import { SCROLL_STEP, type Momentum, type ScrollDirection, type SwipeAction } from '../engine/contract.ts';
import type { SwipeSpeed } from '../types.ts';
import { TestError } from './errors.ts';

/** Drag durations for each `speed`. `normal` is Maestro's swipe duration, and `slow` and `fast` are Espresso's. */
const SWIPE_DURATIONS: Readonly<Record<SwipeSpeed, number>> = { slow: 1500, normal: 400, fast: 150 };

/** The swipe used when a test doesn't set `distance` or `speed` (half the scroll container at `normal` speed). */
export const SWIPE = { distance: 0.5, durationMs: SWIPE_DURATIONS.normal } as const;

/**
 * The `momentum` core sends beside its own scroll steps (`scrollUntilVisible`
 * and the agent's scrolls), for an engine that reads it instead of
 * `distance` and `durationMs`. It's what those steps sent before.
 */
export const STEP_MOMENTUM: Momentum = 'slow';

/**
 * The swipe each deprecated `momentum` stands for. `fast` is the longest
 * single drag, so it stays one drag on a device.
 */
const MOMENTUM: Readonly<Record<Momentum, { readonly distance: number; readonly durationMs: number }>> = {
  slow: { distance: 0.25, durationMs: SWIPE_DURATIONS.slow },
  none: SWIPE,
  fast: { distance: SCROLL_STEP.distance, durationMs: SWIPE_DURATIONS.fast },
};

const DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);

const WARNED_MOMENTUM = Symbol.for('e2e.swipe.momentum.warned');

/** A swipe on the wire. An older client sends `momentum` without `distance` or `durationMs`. */
export type WireSwipeAction = Omit<SwipeAction, 'distance' | 'durationMs'> & Partial<Pick<SwipeAction, 'distance' | 'durationMs'>>;

/**
 * Builds the swipe action for `direction` from a test's `distance` and
 * `speed`. A value the test doesn't set comes from its deprecated
 * `momentum`, else from `defaults`. A warning is printed the first time
 * `momentum` is used in a process, and `momentum` goes on the action too,
 * for an engine that reads it. It throws INVALID_ARGUMENT for an unknown
 * `direction`, a `distance` outside (0, 1], or an unknown `speed`.
 */
export function swipeAction(
  api: string,
  direction: ScrollDirection,
  options: { readonly distance?: number; readonly speed?: SwipeSpeed; readonly momentum?: Momentum } | undefined,
  defaults: { readonly distance: number; readonly durationMs: number },
): SwipeAction {
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) {
    throw new TestError('INVALID_ARGUMENT', `${api} direction must be 'up', 'down', 'left', or 'right', got ${String(direction)}`);
  }

  const momentum = options?.momentum;
  const legacy = momentum === undefined ? undefined : MOMENTUM[momentum];
  if (momentum !== undefined && Reflect.get(process, WARNED_MOMENTUM) !== true) {
    Object.defineProperty(process, WARNED_MOMENTUM, { value: true });
    process.stderr.write('e2e: [warning] swipe momentum is deprecated. Pass distance and speed.\n');
  }

  const distance = options?.distance === undefined ? (legacy?.distance ?? defaults.distance) : options.distance;
  if (typeof distance !== 'number' || !(distance > 0 && distance <= 1)) {
    throw new TestError('INVALID_ARGUMENT', `${api} distance must be a number above 0 and at most 1, got ${String(distance)}`);
  }

  const speed = options?.speed;
  if (speed !== undefined && (typeof speed !== 'string' || !Object.hasOwn(SWIPE_DURATIONS, speed))) {
    throw new TestError('INVALID_ARGUMENT', `${api} speed must be 'slow', 'normal', or 'fast', got ${String(speed)}`);
  }

  return {
    kind: 'swipe',
    direction,
    distance,
    durationMs: speed === undefined ? (legacy?.durationMs ?? defaults.durationMs) : SWIPE_DURATIONS[speed],
    ...(momentum === undefined ? {} : { momentum }),
  };
}

/**
 * Fills in `distance` and `durationMs` on a swipe from an older client that
 * sends neither. They come from its deprecated `momentum`, or from the
 * default swipe when it has none.
 */
export function upgradeSwipe(action: WireSwipeAction): SwipeAction {
  const legacy = action.momentum === undefined ? undefined : MOMENTUM[action.momentum];
  return {
    ...action,
    distance: action.distance ?? legacy?.distance ?? SWIPE.distance,
    durationMs: action.durationMs ?? legacy?.durationMs ?? SWIPE.durationMs,
  };
}
