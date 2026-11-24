import type { Momentum, ScrollDirection, SwipeAction } from '../engine/contract.ts';
import type { SwipeSpeed } from '../types.ts';
import { TestError } from './errors.ts';

/** Drag durations for each `speed`. `normal` is Maestro's swipe duration, and `slow` and `fast` are Espresso's. */
const SWIPE_DURATIONS: Readonly<Record<SwipeSpeed, number>> = { slow: 1500, normal: 400, fast: 150 };

/** The swipe used when a test doesn't set `distance` or `speed` (half the scroll container at `normal` speed). */
export const SWIPE = { distance: 0.5, durationMs: SWIPE_DURATIONS.normal } as const;

/** The `distance` and `speed` each deprecated `momentum` stands for. */
const MOMENTUM: Readonly<Record<Momentum, { readonly distance: number; readonly speed: SwipeSpeed }>> = {
  slow: { distance: 0.25, speed: 'slow' },
  none: { distance: 0.5, speed: 'normal' },
  fast: { distance: 0.8, speed: 'fast' },
};

const WARNED_MOMENTUM = Symbol.for('e2e.swipe.momentum.warned');

/**
 * Builds the swipe action for `direction` from a test's `distance` and
 * `speed`, with `defaults` for the ones it doesn't set. A deprecated
 * `momentum` fills in the ones a test doesn't set, and the first one in a
 * process prints a warning. It throws INVALID_ARGUMENT for a `distance`
 * outside (0, 1], an unknown `speed`, or an unknown `momentum`.
 */
export function swipeAction(
  api: string,
  direction: ScrollDirection,
  options: { readonly distance?: number; readonly speed?: SwipeSpeed; readonly momentum?: Momentum } | undefined,
  defaults: { readonly distance: number; readonly durationMs: number },
): SwipeAction {
  const momentum = options?.momentum;
  if (momentum !== undefined && !Object.hasOwn(MOMENTUM, momentum)) {
    throw new TestError('INVALID_ARGUMENT', `${api} momentum must be 'slow', 'none', or 'fast', got ${String(momentum)}`);
  }
  const legacy = momentum === undefined ? undefined : MOMENTUM[momentum];
  if (legacy !== undefined && Reflect.get(process, WARNED_MOMENTUM) !== true) {
    Object.defineProperty(process, WARNED_MOMENTUM, { value: true });
    process.stderr.write('e2e: [warning] swipe momentum is deprecated. Pass distance and speed.\n');
  }

  const distance = options?.distance ?? legacy?.distance ?? defaults.distance;
  if (typeof distance !== 'number' || !(distance > 0 && distance <= 1)) {
    throw new TestError('INVALID_ARGUMENT', `${api} distance must be a number above 0 and at most 1, got ${String(distance)}`);
  }

  const speed = options?.speed ?? legacy?.speed;
  if (speed !== undefined && !Object.hasOwn(SWIPE_DURATIONS, speed)) {
    throw new TestError('INVALID_ARGUMENT', `${api} speed must be 'slow', 'normal', or 'fast', got ${String(speed)}`);
  }

  return { kind: 'swipe', direction, distance, durationMs: speed === undefined ? defaults.durationMs : SWIPE_DURATIONS[speed] };
}
