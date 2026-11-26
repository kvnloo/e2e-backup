/** `AttemptVerdict`: what a running attempt's `testInfo.status` and `errors` read as failures land. */

import { describe, expect, it } from 'vitest';
import { serializeError, TestError, TestTimeoutError } from '@e2e-dev/core/lib/internal/errors';
import { AttemptVerdict } from '../../src/run/attempt-verdict.ts';
import type { CaughtRuntimeSkip } from '../../src/internal/skip.ts';

function verdict(options: { interrupted?: boolean; expectedFailure?: string } = {}): AttemptVerdict {
  return new AttemptVerdict({
    expectedFailure: options.expectedFailure,
    interrupted: () => options.interrupted ?? false,
    serialize: (error, phase) => serializeError(error, { phase }),
  });
}

describe('AttemptVerdict', () => {
  it('has no status while the body runs, and passes once it settles', () => {
    const attempt = verdict();
    expect(attempt.status()).toBeUndefined();
    expect(attempt.settle()).toBe('passed');
    expect(attempt.status()).toBe('passed');
    expect(attempt.errors()).toEqual([]);
  });

  it('keeps the first failure as the verdict and the later ones beside it', () => {
    const attempt = verdict();
    expect(attempt.fail(new TestError('ASSERTION_FAILED', 'first'), 'body').primary).toBe(true);
    expect(attempt.status()).toBe('failed');
    expect(attempt.fail(new Error('second'), 'afterEach').primary).toBe(false);
    expect(attempt.errors().map((error) => [error.code, error.phase])).toEqual([
      ['ASSERTION_FAILED', 'body'],
      ['ERROR', 'afterEach'],
    ]);
  });

  it('turns a settled pass into a failure when teardown fails', () => {
    const attempt = verdict();
    expect(attempt.settle()).toBe('passed');
    attempt.fail(new Error('afterEach boom'), 'afterEach');
    expect(attempt.status()).toBe('failed');
    expect(attempt.serializedFailure()).toMatchObject({ code: 'ERROR', phase: 'afterEach' });
  });

  it('classifies timeouts, interrupts, and skips', () => {
    const timedOut = verdict();
    timedOut.timeOut();
    timedOut.fail(new TestTimeoutError('test timed out'), 'body');
    expect(timedOut.status()).toBe('timed-out');

    const interrupted = verdict({ interrupted: true });
    interrupted.fail(new Error('stopped'), 'body');
    expect(interrupted.status()).toBe('interrupted');

    const skipped = verdict();
    const skip: CaughtRuntimeSkip = { reason: 'not today' };
    skipped.skip(skip);
    expect(skipped.status()).toBe('skipped');
    expect(skipped.skipped).toBe(skip);
  });

  it('keeps the first expected-failure reason', () => {
    const attempt = verdict({ expectedFailure: 'from the option' });
    attempt.expectFailure('from test.fail');
    expect(attempt.expectedFailure).toBe('from the option');
    const marked = verdict();
    marked.expectFailure('first');
    marked.expectFailure('second');
    expect(marked.expectedFailure).toBe('first');
  });

  it('notes an error without making it the verdict', () => {
    const attempt = verdict();
    expect(attempt.note(new Error('soft'), 'body')).toMatchObject({ code: 'ERROR', phase: 'body' });
    expect(attempt.failure).toBeUndefined();
    expect(attempt.settle()).toBe('passed');
    expect(attempt.errors()).toHaveLength(1);
  });
});
