import type { ScrollDirection, SwipeAction } from '../engine/contract.ts';
import type { SwipeSpeed } from '../types.ts';
import { TestError } from './errors.ts';

/** How long each drag takes for a `speed`: Maestro's swipe for `normal`, and Espresso's fast and slow swipes. */
const SWIPE_DURATIONS: Readonly<Record<SwipeSpeed, number>> = { slow: 1500, normal: 400, fast: 150 };

/** A plain swipe's gesture when a test names no `distance` or `speed`: half the scroll container, at `normal` speed. */
export const SWIPE = { distance: 0.5, durationMs: SWIPE_DURATIONS.normal } as const;

/**
 * The swipe action for `direction`, with a test's `distance` and `speed`
 * over `defaults`. A `distance` outside (0, 1] or an unknown `speed` is
 * INVALID_ARGUMENT.
 */
export function swipeAction(
  api: string,
  direction: ScrollDirection,
  options: { readonly distance?: number; readonly speed?: SwipeSpeed } | undefined,
  defaults: { readonly distance: number; readonly durationMs: number },
): SwipeAction {
  const distance = options?.distance ?? defaults.distance;
  if (typeof distance !== 'number' || !(distance > 0 && distance <= 1)) {
    throw new TestError('INVALID_ARGUMENT', `${api} distance must be a number above 0 and at most 1, got ${String(distance)}`);
  }

  const speed = options?.speed;
  if (speed !== undefined && !Object.hasOwn(SWIPE_DURATIONS, speed)) {
    throw new TestError('INVALID_ARGUMENT', `${api} speed must be 'slow', 'normal', or 'fast', got ${String(speed)}`);
  }

  return { kind: 'swipe', direction, distance, durationMs: speed === undefined ? defaults.durationMs : SWIPE_DURATIONS[speed] };
}
