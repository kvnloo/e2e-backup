/** expect.poll: re-reads a value until a synchronous matcher passes. */

import { DEFAULT_PASS_OPTIONS } from '@e2e-dev/core/lib/config/validate';
import { errorMessage, isE2EError } from '@e2e-dev/core/lib/internal/errors';
import { runningSuiteHook } from '@e2e-dev/core/lib/internal/test-timeout';
import type { PollExpectation, PollOptions, ValueMatcherName } from '@e2e-dev/core/lib/types';
import { currentAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { checkOptions, retry } from './retry.ts';
import { createValueExpectation, VALUE_MATCHER_NAMES, type ValueMatcher } from './values.ts';

/** Outside an attempt or hook (a standalone script) there is no config to read `assertionTimeout` from. */
const DEFAULT_TIMEOUT_MS = 5000;
const WARNED_INTERVAL = Symbol.for('e2e.expect.poll.interval.warned');

function isNotYet(error: unknown): boolean {
  return isE2EError(error) && error.code === 'ASSERTION_FAILED';
}

/** Runs the chosen value matcher on each completed read. */
function pollMatcher(
  read: () => unknown,
  options: PollOptions,
  negated: boolean,
  name: ValueMatcherName,
  args: unknown[],
): Promise<unknown> {
  const context = currentAttempt() ?? runningSuiteHook();
  return retry(read, (result) => {
    if ('error' in result) return { last: errorMessage(result.error) };

    const expectation = createValueExpectation(result.value);
    const target = negated ? expectation.not : expectation;
    try {
      return { value: (target[name] as ValueMatcher).apply(target, args) };
    } catch (error) {
      if (!isNotYet(error)) throw error;
      return { last: errorMessage(error) };
    }
  }, {
    api: 'expect.poll',
    label: `expect.poll(...).${negated ? 'not.' : ''}${name}(...)`,
    timeout: options.timeout ?? context?.assertionTimeout ?? DEFAULT_TIMEOUT_MS,
    intervals: options.intervals ?? (options.interval === undefined ? DEFAULT_PASS_OPTIONS.intervals : [options.interval]),
    message: options.message,
    noSample: 'no read completed',
  }, context);
}

function build<T>(
  read: () => T | Promise<T>,
  options: PollOptions,
  negated: boolean,
): PollExpectation<T> {
  const matchers = Object.fromEntries(
    VALUE_MATCHER_NAMES.map((name) => [
      name,
      (...args: unknown[]) => pollMatcher(read, options, negated, name, args),
    ]),
  );
  return {
    ...matchers,
    get not() {
      return build(read, options, !negated);
    },
  } as PollExpectation<T>;
}

/** Re-reads `read` until the chosen value matcher holds or `options.timeout` passes. */
export function createPollExpectation<T>(
  read: () => T | Promise<T>,
  options: PollOptions = {},
): PollExpectation<T> {
  checkOptions('expect.poll', options);
  if (options.interval !== undefined && Reflect.get(process, WARNED_INTERVAL) !== true) {
    Object.defineProperty(process, WARNED_INTERVAL, { value: true });
    process.stderr.write('e2e: [warning] expect.poll interval is deprecated. Pass intervals: [<ms>].\n');
  }
  return build(read, options, false);
}
