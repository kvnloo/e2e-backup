/** How a value reads in a value matcher's failure message. */

import { inspect } from 'node:util';
import { hasAsymmetric, isAsymmetric } from '@vitest/expect';
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

/**
 * `[TypeError: boom]`, the way an uncaught error opens; a subclass that kept
 * the name `Error` reads by its class. Own properties follow, since equality
 * compares them: `[HttpError: failed] {"status":404}`.
 */
function describeError(error: Error): string {
  const className: unknown = (error.constructor as { name?: unknown } | undefined)?.name;
  const name = error.name === 'Error' && typeof className === 'string' && className !== '' ? className : error.name;
  const head = `[${error.message === '' ? name : `${name}: ${error.message}`}]`;
  const own = Object.fromEntries(Object.entries(error).filter(([key]) => key !== 'name' && key !== 'message'));
  return Object.keys(own).length === 0 ? head : `${head} ${format(own)}`;
}

export function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (isAsymmetric(value)) return describeMatcher(value);
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) return describeError(value);
  try {
    const json = JSON.stringify(value, (_key, nested: unknown) => {
      if (isAsymmetric(nested)) return describeMatcher(nested);
      // An Error has no enumerable properties, so it would print as {}.
      return nested instanceof Error ? describeError(nested) : nested;
    });
    if (json !== undefined) return json;
  } catch {
    // fall through
  }
  return String(value);
}

/**
 * A copy of `value` in which every asymmetric matcher inspects as its
 * description. Only arrays and plain objects are copied, holes and
 * `undefined` properties kept: an expected literal holds its matchers there.
 */
function withDescribedMatchers(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (isAsymmetric(value)) return { [inspect.custom]: () => describeMatcher(value) };
  const plain = Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
  if (!plain) return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  // Setting the length leaves holes, so an index the loop below skips stays a hole.
  if (Array.isArray(copy) && Array.isArray(value)) copy.length = value.length;
  seen.set(value, copy);
  for (const [key, nested] of Object.entries(value)) Reflect.set(copy, key, withDescribedMatchers(nested, seen));
  return copy;
}

/**
 * A value with what `toStrictEqual` compares and JSON drops: class names,
 * `undefined` properties, and array holes. `Order { id: 1, note: undefined }`.
 */
export function formatStrict(value: unknown): string {
  const shown = hasAsymmetric(value) ? withDescribedMatchers(value, new Map()) : value;
  return inspect(shown, { depth: 8, compact: true, breakLength: Infinity, maxArrayLength: 50, maxStringLength: 200 });
}
