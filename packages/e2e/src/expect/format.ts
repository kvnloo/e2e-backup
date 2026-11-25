/** How a value reads in a value matcher's failure message. */

import { inspect } from 'node:util';
import { isAsymmetric } from '@vitest/expect';
import type { AsymmetricMatcher } from '@e2e-dev/core/lib/types';

/**
 * An asymmetric matcher as it reads in a failure: `Any<Number>` and
 * `Anything` describe themselves; the rest print their name and sample,
 * `ObjectContaining {"id":1}`.
 */
function describeMatcher(matcher: AsymmetricMatcher): string {
  const own = (matcher as { toAsymmetricMatcher?: () => string }).toAsymmetricMatcher?.();
  if (own !== undefined) return own;
  const sample = (matcher as { sample?: unknown }).sample;
  return `${matcher.toString()} ${format(sample)}`;
}

/** `TypeError: boom`, the way an uncaught error opens; a subclass that kept the name `Error` reads by its class. */
function describeError(error: Error): string {
  const className: unknown = (error.constructor as { name?: unknown } | undefined)?.name;
  const name = error.name === 'Error' && typeof className === 'string' && className !== '' ? className : error.name;
  return error.message === '' ? name : `${name}: ${error.message}`;
}

export function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (isAsymmetric(value)) return describeMatcher(value);
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) return `[${describeError(value)}]`;
  try {
    const json = JSON.stringify(value, (_key, nested: unknown) => {
      if (isAsymmetric(nested)) return describeMatcher(nested);
      // An Error has no enumerable properties, so it would print as {}.
      return nested instanceof Error ? `[${describeError(nested)}]` : nested;
    });
    if (json !== undefined) return json;
  } catch {
    // fall through
  }
  return String(value);
}

/**
 * A value with what `toStrictEqual` compares and JSON drops: class names,
 * `undefined` properties, and array holes. `Order { id: 1, note: undefined }`.
 */
export function formatStrict(value: unknown): string {
  return inspect(value, { depth: 8, breakLength: Infinity, maxArrayLength: 50, maxStringLength: 200 });
}
