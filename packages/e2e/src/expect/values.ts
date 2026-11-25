/** Synchronous plain-value matchers. */

import { types } from 'node:util';
import { arrayBufferEquality, equals, iterableEquality, sparseArrayEquality, subsetEquality, typeEquality } from '@vitest/expect';
import { DEFAULT_PASS_OPTIONS } from '@e2e-dev/core/lib/config/validate';
import { currentAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { errorMessage, TestError } from '@e2e-dev/core/lib/internal/errors';
import { cancelledError, withAbort } from '@e2e-dev/core/lib/internal/time';
import { testPattern } from '@e2e-dev/core/lib/internal/regexp';
import { describeIssue, requireStandardSchema } from '@e2e-dev/core/lib/internal/standard-schema';
import { runningSuiteHook } from '@e2e-dev/core/lib/internal/test-timeout';
import { toTextPattern } from '@e2e-dev/core/lib/internal/text';
import { printableUrl } from '@e2e-dev/core/lib/internal/urls';
import type { Class, NegatedPromisedValueExpectation, NegatedValueExpectation, PassOptions, PromisedValueExpectation, PropertyPath, StandardSchemaV1, ThrowExpectation, ValueExpectation, ValueMatcherName, WebResponse } from '@e2e-dev/core/lib/types';
import { format, formatStrict } from './format.ts';
import { isCloseTo, validDigits } from './close-to.ts';
import { withMessage } from './heading.ts';
import { checkOptions, retry, track } from './retry.ts';
import { describeExpected, isInstance, matchesThrown } from './thrown.ts';

function fail(message: string): never {
  throw new TestError('ASSERTION_FAILED', message);
}

/** A promised expectation of either polarity: one object serves both, as the class below does. */
type Promised<T> = PromisedValueExpectation<T> & NegatedPromisedValueExpectation<T>;

class ValueExpectationImpl<T> implements ValueExpectation<T>, NegatedValueExpectation<T> {
  constructor(
    private readonly actual: T,
    private readonly negated: boolean,
    /** The caller's label for this check, opening every failure message. */
    private readonly message: string | undefined,
    /** Set by `.resolves` and `.rejects`: what the promise settled with, which `toThrow` may check without a call. */
    private readonly settledBy?: 'resolves' | 'rejects',
  ) {}

  /** One class serves the positive and negated forms, so `.not` is the class and not either interface. */
  get not(): ValueExpectationImpl<T> {
    return new ValueExpectationImpl(this.actual, !this.negated, this.message, this.settledBy);
  }

  get resolves(): Promised<Awaited<T>> {
    return promised(this.actual, 'resolves', this.negated, this.message);
  }

  get rejects(): Promised<unknown> {
    return promised(this.actual, 'rejects', this.negated, this.message);
  }

  /** Retries the function passed to `expect` until the assertion passes or the deadline is reached. */
  async toPass(options: PassOptions = {}): Promise<void> {
    const { actual: block, negated, message } = this;
    const label = `expect(...).${negated ? 'not.' : ''}toPass()`;
    if (typeof block !== 'function') {
      throw new TestError('INVALID_ARGUMENT', `${label} requires a function`);
    }

    checkOptions(label, options);
    const context = currentAttempt() ?? runningSuiteHook();
    await retry((): unknown => block(), (result) => {
      if ('error' in result) {
        if (negated) return { value: undefined };
        return { last: errorMessage(result.error), cause: result.error };
      }
      return negated ? { last: 'the block passed' } : { value: undefined };
    }, {
      api: label,
      label,
      timeout: options.timeout ?? context?.toPass?.timeout ?? DEFAULT_PASS_OPTIONS.timeout,
      intervals: options.intervals ?? context?.toPass?.intervals ?? DEFAULT_PASS_OPTIONS.intervals,
      message,
      noSample: 'no try completed',
    }, context);
  }

  /** Messages are thunks: formatting large values is paid only on failure. */
  private check(condition: boolean, positive: () => string, negative: () => string): void {
    if (this.negated) {
      if (condition) this.fail(negative());
      return;
    }
    if (!condition) this.fail(positive());
  }

  private fail(detail: string): never {
    fail(withMessage(this.message, detail));
  }

  toBe(expected: T): void {
    this.check(
      Object.is(this.actual, expected),
      () => `expected ${format(this.actual)} to be ${format(expected)}`,
      () => `expected ${format(this.actual)} not to be ${format(expected)}`,
    );
  }

  toEqual(expected: unknown): void {
    this.check(
      equals(this.actual, expected, [iterableEquality]),
      () => `expected ${format(this.actual)} to equal ${format(expected)}`,
      () => `expected ${format(this.actual)} not to equal ${format(expected)}`,
    );
  }

  /** Jest's `toStrictEqual` testers: class types, array holes, and `undefined` properties count. */
  toStrictEqual(expected: unknown): void {
    this.check(
      equals(this.actual, expected, [iterableEquality, typeEquality, sparseArrayEquality, arrayBufferEquality], true),
      () => `expected ${formatStrict(this.actual)} to strictly equal ${formatStrict(expected)}`,
      () => `expected ${formatStrict(this.actual)} not to strictly equal ${formatStrict(expected)}`,
    );
  }

  toMatchObject(expected: object): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'object' || actual === null) {
      fail(`toMatchObject requires an object, got ${format(actual)}`);
    }
    if (typeof expected !== 'object' || expected === null) {
      fail(`toMatchObject takes an object to match against, got ${format(expected)}`);
    }
    this.check(
      equals(actual, expected, [iterableEquality, subsetEquality]),
      () => `expected ${format(actual)} to match object ${format(expected)}`,
      () => `expected ${format(actual)} not to match object ${format(expected)}`,
    );
  }

  toBeTruthy(): void {
    this.check(
      Boolean(this.actual),
      () => `expected ${format(this.actual)} to be truthy`,
      () => `expected ${format(this.actual)} not to be truthy`,
    );
  }

  toBeFalsy(): void {
    this.check(
      !this.actual,
      () => `expected ${format(this.actual)} to be falsy`,
      () => `expected ${format(this.actual)} not to be falsy`,
    );
  }

  toBeNull(): void {
    this.check(
      this.actual === null,
      () => `expected ${format(this.actual)} to be null`,
      () => `expected value not to be null`,
    );
  }

  toBeUndefined(): void {
    this.check(
      this.actual === undefined,
      () => `expected ${format(this.actual)} to be undefined`,
      () => `expected value not to be undefined`,
    );
  }

  toBeDefined(): void {
    this.check(
      this.actual !== undefined,
      () => `expected ${format(this.actual)} to be defined`,
      () => `expected ${format(this.actual)} not to be defined`,
    );
  }

  toHaveLength(expected: number): void {
    const actual = this.actual as unknown;
    const length = (actual as { length?: unknown } | null | undefined)?.length;
    if ((typeof actual !== 'object' && typeof actual !== 'string' && typeof actual !== 'function') || typeof length !== 'number') {
      fail(`toHaveLength requires a value with a numeric length, got ${format(actual)}`);
    }
    this.check(
      length === expected,
      () => `expected ${format(actual)} to have length ${expected}, got ${length}`,
      () => `expected ${format(actual)} not to have length ${expected}`,
    );
  }

  toHaveProperty(path: PropertyPath, ...expected: [] | [expected: unknown]): void {
    const keys = typeof path === 'string' ? path.split('.') : [...path];
    if (keys.length === 0 || keys.some((key) => key === '')) {
      fail(`toHaveProperty takes a dotted path or an array of keys, got ${format(path)}`);
    }
    const label = keys.map(String).join('.');
    const found = lookup(this.actual, keys);
    if (expected.length === 0) {
      this.check(
        found.present,
        () => `expected ${format(this.actual)} to have property "${label}"`,
        () => `expected ${format(this.actual)} not to have property "${label}"`,
      );
      return;
    }
    const [value] = expected;
    this.check(
      found.present && equals(found.value, value, [iterableEquality]),
      () =>
        found.present
          ? `expected property "${label}" of ${format(this.actual)} to equal ${format(value)}, got ${format(found.value)}`
          : `expected ${format(this.actual)} to have property "${label}" equal to ${format(value)}`,
      () => `expected property "${label}" of ${format(this.actual)} not to equal ${format(value)}`,
    );
  }

  toContain(expected: unknown): void {
    let contains: boolean;
    const actual = this.actual as unknown;
    if (typeof actual === 'string') {
      if (typeof expected !== 'string') {
        fail(`toContain on a string requires a string, got ${format(expected)}`);
      }
      contains = actual.includes(expected);
    } else if (isCollection(actual)) {
      contains = hasEqualItem(actual, expected);
    } else {
      fail(`toContain requires a string or collection, got ${format(actual)}`);
    }
    this.check(
      contains,
      () => `expected ${format(this.actual)} to contain ${format(expected)}`,
      () => `expected ${format(this.actual)} not to contain ${format(expected)}`,
    );
  }

  toContainEqual(expected: unknown): void {
    const actual = this.actual as unknown;
    if (!isCollection(actual)) fail(`toContainEqual requires a collection, got ${format(actual)}`);
    this.check(
      hasEqualItem(actual, expected),
      () => `expected ${format(actual)} to contain an item equal to ${format(expected)}`,
      () => `expected ${format(actual)} not to contain an item equal to ${format(expected)}`,
    );
  }

  toBeInstanceOf(expected: Class): void {
    const actual = this.actual as unknown;
    const name = (expected as { name?: unknown } | null | undefined)?.name;
    const label = typeof name === 'string' && name !== '' ? name : 'the class';
    this.check(
      isInstance('toBeInstanceOf', actual, expected),
      () => `expected ${formatStrict(actual)} to be an instance of ${label}`,
      () => `expected ${formatStrict(actual)} not to be an instance of ${label}`,
    );
  }

  /**
   * Calls the function and checks what it threw. A rejection is checked as
   * it is, without a call, and so is an error a promise resolved with, as in
   * Jest.
   */
  toThrow(expected?: ThrowExpectation): void {
    const wanted = describeExpected(expected);
    const actual = this.actual as unknown;
    let outcome: { readonly thrown: unknown } | { readonly returned: unknown };
    const rejected = this.settledBy === 'rejects';
    if (rejected || (this.settledBy === 'resolves' && actual instanceof Error)) {
      outcome = { thrown: actual };
    } else {
      if (typeof actual !== 'function') fail(`toThrow requires a function, got ${format(actual)}`);
      try {
        outcome = { returned: (actual as () => unknown)() };
      } catch (thrown) {
        outcome = { thrown };
      }
    }
    const not = this.negated ? 'not ' : '';
    const claim = rejected
      ? `expected the promise ${not}to reject${wanted === '' ? '' : ' with'}${wanted}`
      : `expected the function ${not}to throw${wanted}`;
    const got = (): string => {
      if ('thrown' in outcome) return `it ${rejected ? 'rejected with' : 'threw'} ${format(outcome.thrown)}`;
      if (!types.isPromise(outcome.returned)) return 'it did not throw';
      // The failure below already reports the call; its rejection must not surface as a second, unhandled error.
      outcome.returned.catch(() => undefined);
      return 'it returned a promise; for an async function use `await expect(promise).rejects.toThrow()`';
    };
    const failure = (): string => `${claim}, but ${got()}`;
    this.check('thrown' in outcome && matchesThrown(outcome.thrown, expected), failure, failure);
  }

  toMatch(expected: string | RegExp): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'string') {
      fail(`toMatch requires a string, got ${format(actual)}`);
    }
    // A global or sticky RegExp keeps `lastIndex` between tests; a matcher
    // that is polled must see the same answer for the same value every time.
    const pattern = toTextPattern(expected);
    const matches =
      pattern.kind === 'string'
        ? actual.includes(pattern.value)
        : testPattern(pattern.source, pattern.flags, actual);
    this.check(
      matches,
      () => `expected ${format(actual)} to match ${format(expected)}`,
      () => `expected ${format(actual)} not to match ${format(expected)}`,
    );
  }

  toBeGreaterThan(expected: number): void {
    this.compareNumber('toBeGreaterThan', expected, (actual) => actual > expected, 'greater than');
  }

  toBeGreaterThanOrEqual(expected: number): void {
    this.compareNumber('toBeGreaterThanOrEqual', expected, (actual) => actual >= expected, 'greater than or equal to');
  }

  toBeLessThan(expected: number): void {
    this.compareNumber('toBeLessThan', expected, (actual) => actual < expected, 'less than');
  }

  toBeLessThanOrEqual(expected: number): void {
    this.compareNumber('toBeLessThanOrEqual', expected, (actual) => actual <= expected, 'less than or equal to');
  }

  toBeCloseTo(expected: number, digits = 2): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`toBeCloseTo requires a number, got ${format(actual)}`);
    if (!validDigits(digits)) fail(`toBeCloseTo digits must be a non-negative integer, got ${format(digits)}`);
    this.check(
      isCloseTo(actual, expected, digits),
      () => `expected ${actual} to be close to ${expected} (${digits} digits)`,
      () => `expected ${actual} not to be close to ${expected} (${digits} digits)`,
    );
  }

  /**
   * Validates synchronously: a matcher returns before anything could await
   * it. The output is the schema's (defaults applied, transforms run); a
   * negated check returns nothing, as its type says.
   */
  toMatchSchema<Schema extends StandardSchemaV1>(schema: Schema): StandardSchemaV1.InferOutput<Schema> {
    requireStandardSchema(schema, 'toMatchSchema schema');
    const result = schema['~standard'].validate(this.actual);
    if (types.isPromise(result)) {
      result.catch(() => undefined);
      throw new TestError(
        'INVALID_ARGUMENT',
        'toMatchSchema takes a synchronous schema, and this one validates asynchronously (an async refinement or transform); await schema["~standard"].validate(value) yourself instead',
      );
    }
    this.check(
      result.issues === undefined,
      () => `expected ${format(this.actual)} to match the schema:\n${(result.issues ?? []).map((issue) => `- ${describeIssue(issue)}`).join('\n')}`,
      () => `expected ${format(this.actual)} not to match the schema`,
    );
    // One implementation serves the positive, negated, and soft forms, so the output is cast to the caller's type.
    return (this.negated || result.issues !== undefined ? undefined : result.value) as StandardSchemaV1.InferOutput<Schema>;
  }

  /**
   * A status from 200 to 299, with `status` and `url` read once each. A value
   * that is not a response fails negated too, like the number matchers, and
   * the message names only its kind: a look-alike object may hold a URL with
   * a token, or getters.
   */
  toBeOK(): void {
    const fields = responseFields(this.actual);
    if (fields === undefined) this.fail(`toBeOK requires a response, got ${kindOf(this.actual)}`);
    const { status, url } = fields;
    this.check(
      status >= 200 && status <= 299,
      () => `expected a 2xx status, got ${status}${responseSource(url)}`,
      () => `expected a status outside 2xx, got ${status}${responseSource(url)}`,
    );
  }

  /** The one body of the four ordering matchers: a number on the left, a phrase for the message. */
  private compareNumber(name: string, expected: number, holds: (actual: number) => boolean, phrase: string): void {
    const actual = this.actual as unknown;
    if (typeof actual !== 'number') fail(`${name} requires a number, got ${format(actual)}`);
    this.check(
      holds(actual),
      () => `expected ${actual} to be ${phrase} ${expected}`,
      () => `expected ${actual} not to be ${phrase} ${expected}`,
    );
  }
}

/**
 * The two fields toBeOK reads of a `WebResponse`, each read once, `url` only
 * after `status` is a number; `undefined` when either is missing or mistyped.
 */
function responseFields(value: unknown): Pick<WebResponse, 'status' | 'url'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { status } = value as { status?: unknown };
  if (typeof status !== 'number') return undefined;
  const { url } = value as { url?: unknown };
  return typeof url === 'string' ? { status, url } : undefined;
}

/** A value's kind for a message that must not print the value itself. */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return 'an object without a numeric status and a string url';
  return `a ${typeof value}`;
}

/** ` from <origin><path>` of an http(s) URL, never its credentials, query, or fragment; nothing for any other URL. */
function responseSource(url: string): string {
  const protocol = URL.canParse(url) ? new URL(url).protocol : undefined;
  return protocol === 'http:' || protocol === 'https:' ? ` from ${printableUrl(url)}` : '';
}

/**
 * Walks `keys` into `value`; `present` says whether the whole path resolved.
 * A primitive on the way is read through its wrapper object, as Jest does,
 * so a string has its `length` and indices; `null` and `undefined` have no
 * properties.
 */
function lookup(value: unknown, keys: readonly (string | number)[]): { present: boolean; value: unknown } {
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || current === undefined) return { present: false, value: undefined };
    const holder: object = Object(current);
    if (!(key in holder)) return { present: false, value: undefined };
    current = (holder as Record<string | number, unknown>)[key];
  }
  return { present: true, value: current };
}

function isCollection(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value;
}

/** Whether an item of the collection equals `expected` by `toEqual` rules. */
function hasEqualItem(collection: Iterable<unknown>, expected: unknown): boolean {
  return [...collection].some((item) => equals(item, expected, [iterableEquality]));
}

/** `satisfies` keeps this list equal to the ValueExpectation matcher set. */
const VALUE_MATCHERS = {
  toBe: true,
  toEqual: true,
  toStrictEqual: true,
  toMatchObject: true,
  toBeTruthy: true,
  toBeFalsy: true,
  toBeNull: true,
  toBeUndefined: true,
  toBeDefined: true,
  toHaveLength: true,
  toHaveProperty: true,
  toContain: true,
  toContainEqual: true,
  toMatch: true,
  toBeGreaterThan: true,
  toBeGreaterThanOrEqual: true,
  toBeLessThan: true,
  toBeLessThanOrEqual: true,
  toBeCloseTo: true,
  toBeInstanceOf: true,
  toThrow: true,
  toMatchSchema: true,
  toBeOK: true,
} satisfies Record<ValueMatcherName, true>;

export const VALUE_MATCHER_NAMES = Object.keys(VALUE_MATCHERS) as ValueMatcherName[];

export type ValueMatcher = (this: unknown, ...args: unknown[]) => unknown;

/** The promise's value for `.resolves` or its rejection for `.rejects`; the other outcome fails the assertion. */
async function settled(
  actual: unknown,
  kind: 'resolves' | 'rejects',
  message: string | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (typeof (actual as { then?: unknown } | null | undefined)?.then !== 'function') {
    throw new TestError('INVALID_ARGUMENT', `expect(...).${kind} requires a promise, got ${format(actual)}`);
  }
  const settling = Promise.resolve(actual as PromiseLike<unknown>).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const outcome = await (signal === undefined ? settling : withAbort(settling, signal, cancelledError));
  if (kind === 'resolves') {
    if ('value' in outcome) return outcome.value;
    // No `cause`: a report takes its source line from the cause's stack, and the line to show is this call's.
    fail(withMessage(message, `expected the promise to resolve, but it rejected with ${format(outcome.error)}`));
  }
  if ('error' in outcome) return outcome.error;
  fail(withMessage(message, `expected the promise to reject, but it resolved with ${format(outcome.value)}`));
}

/**
 * Every value matcher run on what the promise settles with. The call is
 * tracked like a poll, so a phase that returns without awaiting it fails
 * instead of losing the assertion.
 */
function promised<T>(
  actual: unknown,
  kind: 'resolves' | 'rejects',
  negated: boolean,
  message: string | undefined,
): Promised<T> {
  const matchers = Object.fromEntries(
    VALUE_MATCHER_NAMES.map((name) => [
      name,
      (...args: unknown[]) =>
        track(`expect(...).${kind}.${negated ? 'not.' : ''}${name}(...)`, async (signal) => {
          const expectation = new ValueExpectationImpl(await settled(actual, kind, message, signal), negated, message, kind);
          return (expectation[name] as ValueMatcher).apply(expectation, args);
        }),
    ]),
  );
  return {
    ...matchers,
    get not() {
      return promised<T>(actual, kind, !negated, message);
    },
  } as Promised<T>;
}

export function createValueExpectation<T>(actual: T, message?: string): ValueExpectation<T> {
  return new ValueExpectationImpl(actual, false, message);
}
