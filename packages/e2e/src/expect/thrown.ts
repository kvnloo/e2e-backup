/** What `toThrow` compares: a thrown value or a rejection against the caller's expectation. */

import { isAsymmetric } from '@vitest/expect';
import { TestError } from '@e2e-dev/core/lib/internal/errors';
import { testPattern } from '@e2e-dev/core/lib/internal/regexp';
import type { ThrowExpectation } from '@e2e-dev/core/lib/types';
import { format } from './format.ts';

/** A thrown value's message as Jest reads it: its `message` when that is a string, else the value as text. */
function messageOf(value: unknown): string {
  const message = (value as { message?: unknown } | null | undefined)?.message;
  if (typeof message === 'string') return message;
  return typeof value === 'object' && value !== null ? format(value) : String(value);
}

/** The messages down an error's `cause` chain, so two errors with the same message and different causes differ. */
function causeChain(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current = error; !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    messages.push(messageOf(current));
    if (!((current as { cause?: unknown } | null | undefined)?.cause instanceof Error)) break;
  }
  return messages;
}

/** `value instanceof expected`, with a value that is not a class refused by the matcher's name. */
export function isInstance(matcher: string, value: unknown, expected: unknown): boolean {
  if (typeof expected === 'function') {
    try {
      // A primitive on the left is false before the right side is looked at, so an object asks first.
      void ({} instanceof expected);
      return value instanceof expected;
    } catch {
      // an arrow function or a method has no prototype to test against
    }
  }
  throw new TestError('INVALID_ARGUMENT', `${matcher} takes a class, got ${format(expected)}`);
}

/** How the expectation reads after "to throw" in a failure; empty when any thrown value passes. */
export function describeExpected(expected: ThrowExpectation | undefined): string {
  if (expected === undefined) return '';
  if (typeof expected === 'string') return ` an error with a message containing ${format(expected)}`;
  if (expected instanceof RegExp) return ` an error with a message matching ${format(expected)}`;
  if (typeof expected === 'function') return ` an instance of ${expected.name || 'the class'}`;
  if (isAsymmetric(expected)) return ` a value matching ${format(expected)}`;
  if (typeof expected === 'object' && expected !== null && typeof (expected as { message?: unknown }).message === 'string') {
    return ` an error with the message ${format((expected as { message: string }).message)}`;
  }
  throw new TestError(
    'INVALID_ARGUMENT',
    `toThrow takes a string, a RegExp, an error class, an error, or an asymmetric matcher, got ${format(expected)}`,
  );
}

/**
 * Jest's rules: a string is a substring of the message, a RegExp tests it, a
 * class is `instanceof`, and an error must have the same message and the
 * same messages down its `cause` chain.
 */
export function matchesThrown(thrown: unknown, expected: ThrowExpectation | undefined): boolean {
  if (expected === undefined) return true;
  if (typeof expected === 'string') return messageOf(thrown).includes(expected);
  // A global or sticky RegExp keeps `lastIndex`; the same error must match the same way every time.
  if (expected instanceof RegExp) return testPattern(expected.source, expected.flags.replace(/[gy]/g, ''), messageOf(thrown));
  if (typeof expected === 'function') return isInstance('toThrow', thrown, expected);
  if (isAsymmetric(expected)) return expected.asymmetricMatch(thrown);
  const [wanted, got] = [causeChain(expected), causeChain(thrown)];
  return wanted.length === got.length && wanted.every((message, index) => message === got[index]);
}
