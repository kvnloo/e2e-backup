import type { ScrollDirection, SwipeAction } from '../engine/contract.ts';
import type { SwipeSpeed } from '../types.ts';
import { TestError } from './errors.ts';

/** Drag durations for each `speed`. `normal` is Maestro's swipe duration, and `slow` and `fast` are Espresso's. */
const SWIPE_DURATIONS: Readonly<Record<SwipeSpeed, number>> = { slow: 1500, normal: 400, fast: 150 };

/** The swipe used when a test doesn't set `distance` or `speed` (half the scroll container at `normal` speed). */
export const SWIPE = { distance: 0.5, durationMs: SWIPE_DURATIONS.normal } as const;

/**
 * Builds the swipe action for `direction` from a test's `distance` and
 * `speed`, with `defaults` for the ones it doesn't set. It throws
 * INVALID_ARGUMENT for a `distance` outside (0, 1] or an unknown `speed`.
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
