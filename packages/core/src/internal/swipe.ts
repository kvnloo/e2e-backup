import type { Momentum, ScrollDirection, SwipeAction } from '../engine/contract.ts';
import type { SwipeSpeed } from '../types.ts';
import { TestError } from './errors.ts';

/** Drag durations for each `speed`. `normal` is Maestro's swipe duration, and `slow` and `fast` are Espresso's. */
const SWIPE_DURATIONS: Readonly<Record<SwipeSpeed, number>> = { slow: 1500, normal: 400, fast: 150 };

/** The swipe used when a test doesn't set `distance` or `speed` (half the scroll container at `normal` speed). */
export const SWIPE = { distance: 0.5, durationMs: SWIPE_DURATIONS.normal } as const;

/**
 * The `distance` and `speed` each deprecated `momentum` stands for. `fast`
 * is 0.65, the longest single drag on a device, so it stays one drag.
 */
const MOMENTUM: Readonly<Record<Momentum, { readonly distance: number; readonly speed: SwipeSpeed }>> = {
  slow: { distance: 0.25, speed: 'slow' },
  none: { distance: 0.5, speed: 'normal' },
  fast: { distance: 0.65, speed: 'fast' },
};

const WARNED_MOMENTUM = Symbol.for('e2e.swipe.momentum.warned');

/**
 * Builds the swipe action for `direction` from a test's `distance` and
 * `speed`, with `defaults` for the ones it doesn't set. A deprecated
 * `momentum` fills in the ones a test doesn't set, and the first one in a
 * process prints a warning. It throws INVALID_ARGUMENT for a `distance`
 * outside (0, 1] or an unknown `speed`.
 */
export function swipeAction(
  api: string,
  direction: ScrollDirection,
  options: { readonly distance?: number; readonly speed?: SwipeSpeed; readonly momentum?: Momentum } | undefined,
  defaults: { readonly distance: number; readonly durationMs: number },
): SwipeAction {
  const legacy = options?.momentum === undefined ? undefined : MOMENTUM[options.momentum];
  if (options?.momentum !== undefined && Reflect.get(process, WARNED_MOMENTUM) !== true) {
    Object.defineProperty(process, WARNED_MOMENTUM, { value: true });
    process.stderr.write('e2e: [warning] swipe momentum is deprecated. Pass distance and speed.\n');
  }

  const distance = options?.distance === undefined ? (legacy?.distance ?? defaults.distance) : options.distance;
  if (typeof distance !== 'number' || !(distance > 0 && distance <= 1)) {
    throw new TestError('INVALID_ARGUMENT', `${api} distance must be a number above 0 and at most 1, got ${String(distance)}`);
  }

  const speed = options?.speed === undefined ? legacy?.speed : options.speed;
  if (speed !== undefined && (typeof speed !== 'string' || !Object.hasOwn(SWIPE_DURATIONS, speed))) {
    throw new TestError('INVALID_ARGUMENT', `${api} speed must be 'slow', 'normal', or 'fast', got ${String(speed)}`);
  }

  return { kind: 'swipe', direction, distance, durationMs: speed === undefined ? defaults.durationMs : SWIPE_DURATIONS[speed] };
}

/**
 * Fills in the `distance` and `durationMs` of a swipe from a client older
 * than them, from its deprecated `momentum` or else the default swipe.
 */
export function upgradeSwipe(action: Omit<SwipeAction, 'distance' | 'durationMs'> & Partial<Pick<SwipeAction, 'distance' | 'durationMs'>>): SwipeAction {
  const legacy = action.momentum === undefined ? undefined : MOMENTUM[action.momentum];
  return {
    ...action,
    distance: action.distance ?? legacy?.distance ?? SWIPE.distance,
    durationMs: action.durationMs ?? (legacy === undefined ? SWIPE.durationMs : SWIPE_DURATIONS[legacy.speed]),
  };
}
