/** Number closeness, shared by `toBeCloseTo` and `expect.closeTo`. */

import { TestError } from '@e2e-dev/core/lib/internal/errors';
import type { AsymmetricMatcher } from '@e2e-dev/core/lib/types';

/**
 * Jest's rule: the difference must be under half a unit of the last kept
 * digit, so 2 digits around 60 accepts 59.996 and rejects 59.99. Infinite
 * values are close only when they are the same infinity.
 */
export function isCloseTo(actual: number, expected: number, digits: number): boolean {
  return (
    actual === expected ||
    (Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 10 ** -digits / 2)
  );
}

export function validDigits(digits: unknown): digits is number {
  return typeof digits === 'number' && Number.isInteger(digits) && digits >= 0;
}

/** `expect.closeTo`: a number within `digits` decimal digits of `expected`, wherever `toEqual` rules compare. */
export class CloseTo implements AsymmetricMatcher {
  constructor(
    private readonly expected: number,
    private readonly digits = 2,
  ) {
    if (typeof expected !== 'number') {
      throw new TestError('INVALID_ARGUMENT', `expect.closeTo takes a number, got ${String(expected)}`);
    }
    if (!validDigits(digits)) {
      throw new TestError('INVALID_ARGUMENT', `expect.closeTo digits must be a non-negative integer, got ${String(digits)}`);
    }
  }

  asymmetricMatch(other: unknown): boolean {
    return typeof other === 'number' && isCloseTo(other, this.expected, this.digits);
  }

  toString(): string {
    return 'CloseTo';
  }

  toAsymmetricMatcher(): string {
    return `CloseTo ${this.expected} (${this.digits} digits)`;
  }
}
