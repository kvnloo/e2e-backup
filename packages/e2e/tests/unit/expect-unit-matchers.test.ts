import { describe, expect as vexpect, it } from 'vitest';
import { z } from 'zod';
import { publishAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { PollScope, runInPollScope } from '@e2e-dev/core/lib/expect/poll-scope';
import { SoftFailures } from '@e2e-dev/core/lib/expect/soft';
import { TestError } from '@e2e-dev/core/lib/internal/errors';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { expect as e2eExpect } from '../../src/expect/index.ts';

function thrownBy(run: () => unknown): TestError {
  try {
    run();
  } catch (error) {
    vexpect(error).toBeInstanceOf(TestError);
    return error as TestError;
  }
  return vexpect.fail('expected the matcher to throw');
}

function failsWith(run: () => unknown, message: string): void {
  const error = thrownBy(run);
  vexpect(error.code).toBe('ASSERTION_FAILED');
  vexpect(error.message).toBe(message);
}

async function rejectionOf(promise: Promise<unknown>): Promise<TestError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  vexpect(error).toBeInstanceOf(TestError);
  return error as TestError;
}

async function rejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(promise);
  vexpect(error.code).toBe('ASSERTION_FAILED');
  vexpect(error.message).toBe(message);
}

class Order {
  constructor(readonly id: number) {}
}

class PaymentError extends Error {}

function declined(): never {
  throw new PaymentError('card declined');
}

describe('toStrictEqual', () => {
  it('passes on the same structure and class', () => {
    e2eExpect({ a: [1, { b: 2 }] }).toStrictEqual({ a: [1, { b: 2 }] });
    e2eExpect(new Order(1)).toStrictEqual(new Order(1));
    e2eExpect({ id: 1 }).toStrictEqual({ id: e2eExpect.any(Number) });
    e2eExpect({ id: 1 }).not.toStrictEqual({ id: 2 });
  });

  it('tells an undefined property from a missing one, where toEqual does not', () => {
    e2eExpect({ a: 1, b: undefined }).toEqual({ a: 1 });
    failsWith(
      () => e2eExpect({ a: 1, b: undefined }).toStrictEqual({ a: 1 }),
      'expected { a: 1, b: undefined } to strictly equal { a: 1 }',
    );
    e2eExpect({ a: 1, b: undefined }).not.toStrictEqual({ a: 1 });
  });

  it('tells an array hole from undefined, where toEqual does not', () => {
    const sparse: unknown[] = [];
    sparse[1] = 1;
    e2eExpect(sparse).toEqual([undefined, 1]);
    failsWith(() => e2eExpect(sparse).toStrictEqual([undefined, 1]), 'expected [ <1 empty item>, 1 ] to strictly equal [ undefined, 1 ]');
  });

  it('compares class types, where toEqual does not', () => {
    e2eExpect(new Order(1)).toEqual({ id: 1 });
    failsWith(() => e2eExpect(new Order(1)).toStrictEqual({ id: 1 }), 'expected Order { id: 1 } to strictly equal { id: 1 }');
    failsWith(() => e2eExpect({ id: 1 }).not.toStrictEqual({ id: 1 }), 'expected { id: 1 } not to strictly equal { id: 1 }');
  });
});

describe('toContainEqual', () => {
  it('finds an item by toEqual rules in an array or a Set', () => {
    e2eExpect([{ sku: 'a' }, { sku: 'b' }]).toContainEqual({ sku: 'b' });
    e2eExpect(new Set([{ sku: 'a' }])).toContainEqual({ sku: 'a' });
    e2eExpect([{ sku: 'a', qty: 2 }]).toContainEqual(e2eExpect.objectContaining({ sku: 'a' }));
    e2eExpect([{ sku: 'a' }]).not.toContainEqual({ sku: 'c' });
  });

  it('fails with the collection and the item', () => {
    failsWith(() => e2eExpect([{ sku: 'a' }]).toContainEqual({ sku: 'c' }), 'expected [{"sku":"a"}] to contain an item equal to {"sku":"c"}');
    failsWith(
      () => e2eExpect([{ sku: 'a' }]).not.toContainEqual({ sku: 'a' }),
      'expected [{"sku":"a"}] not to contain an item equal to {"sku":"a"}',
    );
  });

  it('refuses a value that is not a collection, negated too', () => {
    failsWith(() => e2eExpect('abc').toContainEqual('a'), 'toContainEqual requires a collection, got "abc"');
    failsWith(() => e2eExpect(1).not.toContainEqual(1), 'toContainEqual requires a collection, got 1');
  });
});

describe('toBeInstanceOf', () => {
  it('checks instanceof, subclasses included', () => {
    e2eExpect(new PaymentError('x')).toBeInstanceOf(PaymentError);
    e2eExpect(new PaymentError('x')).toBeInstanceOf(Error);
    e2eExpect(new Order(1)).not.toBeInstanceOf(Error);
    e2eExpect(1).not.toBeInstanceOf(Number);
  });

  it('fails with the value and the class name', () => {
    failsWith(() => e2eExpect(new Order(1)).toBeInstanceOf(Error), 'expected Order { id: 1 } to be an instance of Error');
    failsWith(() => e2eExpect(new Order(1)).not.toBeInstanceOf(Order), 'expected Order { id: 1 } not to be an instance of Order');
    failsWith(() => e2eExpect(null).toBeInstanceOf(Order), 'expected null to be an instance of Order');
  });

  it('refuses an argument that is not a class', () => {
    const error = thrownBy(() => e2eExpect(1).toBeInstanceOf((() => 1) as never));
    vexpect(error.code).toBe('INVALID_ARGUMENT');
    vexpect(error.message).toBe('toBeInstanceOf takes a class, got [Function anonymous]');
    vexpect(thrownBy(() => e2eExpect(1).toBeInstanceOf('Order' as never)).code).toBe('INVALID_ARGUMENT');
  });
});

describe('toThrow', () => {
  it('passes when the function throws anything, and fails when it returns', () => {
    e2eExpect(declined).toThrow();
    e2eExpect(() => {
      throw 'a string';
    }).toThrow();
    e2eExpect(() => 1).not.toThrow();
    failsWith(() => e2eExpect(() => 1).toThrow(), 'expected the function to throw, but it did not throw');
    failsWith(() => e2eExpect(declined).not.toThrow(), 'expected the function not to throw, but it threw [PaymentError: card declined]');
  });

  it('a string is a substring of the message', () => {
    e2eExpect(declined).toThrow('declined');
    e2eExpect(declined).not.toThrow('expired');
    e2eExpect(() => {
      throw 'plain text';
    }).toThrow('plain');
    failsWith(
      () => e2eExpect(declined).toThrow('expired'),
      'expected the function to throw an error with a message containing "expired", but it threw [PaymentError: card declined]',
    );
    failsWith(
      () => e2eExpect(() => 1).toThrow('expired'),
      'expected the function to throw an error with a message containing "expired", but it did not throw',
    );
    failsWith(
      () => e2eExpect(declined).not.toThrow('card'),
      'expected the function not to throw an error with a message containing "card", but it threw [PaymentError: card declined]',
    );
  });

  it('a RegExp tests the message, the same way on every call', () => {
    const sticky = /declined/g;
    e2eExpect(declined).toThrow(sticky);
    e2eExpect(declined).toThrow(sticky);
    e2eExpect(declined).not.toThrow(/^declined/);
    failsWith(
      () => e2eExpect(declined).toThrow(/expired/i),
      'expected the function to throw an error with a message matching /expired/i, but it threw [PaymentError: card declined]',
    );
  });

  it('a class is an instanceof check', () => {
    e2eExpect(declined).toThrow(PaymentError);
    e2eExpect(declined).toThrow(Error);
    e2eExpect(declined).not.toThrow(TypeError);
    failsWith(
      () => e2eExpect(declined).toThrow(TypeError),
      'expected the function to throw an instance of TypeError, but it threw [PaymentError: card declined]',
    );
  });

  it('an error compares its message and its cause chain, not its class', () => {
    e2eExpect(declined).toThrow(new Error('card declined'));
    e2eExpect(declined).not.toThrow(new Error('card'));
    const withCause = (): never => {
      throw new Error('checkout failed', { cause: new Error('card declined') });
    };
    e2eExpect(withCause).toThrow(new Error('checkout failed', { cause: new Error('card declined') }));
    e2eExpect(withCause).not.toThrow(new Error('checkout failed', { cause: new Error('timeout') }));
    e2eExpect(withCause).not.toThrow(new Error('checkout failed'));
    failsWith(
      () => e2eExpect(declined).toThrow(new Error('card')),
      'expected the function to throw an error with the message "card", but it threw [PaymentError: card declined]',
    );
  });

  it('an asymmetric matcher is asked about the thrown value', () => {
    const coded = (): never => {
      throw Object.assign(new Error('no'), { code: 'E_DECLINED' });
    };
    e2eExpect(coded).toThrow(e2eExpect.objectContaining({ code: 'E_DECLINED' }));
    failsWith(
      () => e2eExpect(coded).toThrow(e2eExpect.objectContaining({ code: 'E_OTHER' })),
      'expected the function to throw a value matching ObjectContaining {"code":"E_OTHER"}, but it threw [Error: no]',
    );
  });

  it('calls the function once', () => {
    let calls = 0;
    e2eExpect(() => {
      calls += 1;
      throw new Error('x');
    }).toThrow('x');
    vexpect(calls).toBe(1);
  });

  it('points an async function at rejects, and leaves no unhandled rejection behind', async () => {
    failsWith(
      () => e2eExpect(async () => declined()).toThrow(),
      'expected the function to throw, but it returned a promise; for an async function use `await expect(promise).rejects.toThrow()`',
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it('refuses a value that is not a function, and an expectation of no known kind', () => {
    failsWith(() => e2eExpect(1).toThrow(), 'toThrow requires a function, got 1');
    failsWith(() => e2eExpect(new Error('x')).not.toThrow(), 'toThrow requires a function, got [Error: x]');
    const error = thrownBy(() => e2eExpect(declined).toThrow(1 as never));
    vexpect(error.code).toBe('INVALID_ARGUMENT');
    vexpect(error.message).toBe('toThrow takes a string, a RegExp, an error class, an error, or an asymmetric matcher, got 1');
  });

  it('carries the caller message', () => {
    failsWith(() => e2eExpect(() => 1, 'the parser').toThrow(), 'the parser: expected the function to throw, but it did not throw');
  });
});

describe('expect.closeTo', () => {
  it('stands in for a number inside the structural matchers', () => {
    e2eExpect({ total: 0.1 + 0.2 }).toEqual({ total: e2eExpect.closeTo(0.3) });
    e2eExpect({ total: 0.1 + 0.2 }).toStrictEqual({ total: e2eExpect.closeTo(0.3, 10) });
    e2eExpect([0.1 + 0.2]).toContainEqual(e2eExpect.closeTo(0.3));
    e2eExpect({ total: 0.31 }).toMatchObject({ total: e2eExpect.closeTo(0.3, 1) });
    e2eExpect({ total: 0.31 }).not.toEqual({ total: e2eExpect.closeTo(0.3) });
    e2eExpect({ total: '0.3' }).not.toEqual({ total: e2eExpect.closeTo(0.3) });
    e2eExpect(Number.POSITIVE_INFINITY).toEqual(e2eExpect.closeTo(Number.POSITIVE_INFINITY));
    e2eExpect(Number.NEGATIVE_INFINITY).not.toEqual(e2eExpect.closeTo(Number.POSITIVE_INFINITY));
  });

  it('uses the rule of toBeCloseTo: half a unit of the last digit', () => {
    e2eExpect(59.996).toEqual(e2eExpect.closeTo(60));
    e2eExpect(59.99).not.toEqual(e2eExpect.closeTo(60));
    e2eExpect(59.99).toEqual(e2eExpect.closeTo(60, 1));
  });

  it('reads as the number and digits in a failure', () => {
    failsWith(
      () => e2eExpect({ total: 0.31 }).toEqual({ total: e2eExpect.closeTo(0.3) }),
      'expected {"total":0.31} to equal {"total":"CloseTo 0.3 (2 digits)"}',
    );
  });

  it('refuses a sample that is not a number and digits that are not a count', () => {
    vexpect(thrownBy(() => e2eExpect.closeTo('1' as never)).message).toBe('expect.closeTo takes a number, got 1');
    const error = thrownBy(() => e2eExpect.closeTo(1, -1));
    vexpect(error.code).toBe('INVALID_ARGUMENT');
    vexpect(error.message).toBe('expect.closeTo digits must be a non-negative integer, got -1');
  });
});

describe('resolves', () => {
  it('runs a value matcher on what the promise resolves with', async () => {
    await e2eExpect(Promise.resolve(1)).resolves.toBe(1);
    await e2eExpect(Promise.resolve({ a: [1] })).resolves.toEqual({ a: [1] });
    await e2eExpect(Promise.resolve(new Order(1))).resolves.toBeInstanceOf(Order);
    await e2eExpect(Promise.resolve('paid')).resolves.toMatch(/^pa/);
    await e2eExpect(Promise.resolve([{ sku: 'a' }])).resolves.toContainEqual({ sku: 'a' });
    await rejectsWith(e2eExpect(Promise.resolve(1)).resolves.toBe(2), 'expected 1 to be 2');
  });

  it('negates the matcher, before or after resolves, never the settling', async () => {
    await e2eExpect(Promise.resolve(1)).resolves.not.toBe(2);
    await e2eExpect(Promise.resolve(1)).not.resolves.toBe(2);
    await rejectsWith(e2eExpect(Promise.resolve(1)).resolves.not.toBe(1), 'expected 1 not to be 1');
    await rejectsWith(e2eExpect(Promise.resolve(1)).not.resolves.toBe(1), 'expected 1 not to be 1');
    await e2eExpect(Promise.resolve(1)).resolves.not.not.toBe(1);
    await rejectsWith(
      e2eExpect(Promise.reject<number>(new Error('boom'))).resolves.not.toBe(1),
      'expected the promise to resolve, but it rejected with [Error: boom]',
    );
  });

  it('fails on a rejection, with the rejection as the cause', async () => {
    const boom = new Error('boom');
    const error = await rejectionOf(e2eExpect(Promise.reject<number>(boom), 'the order').resolves.toBe(1));
    vexpect(error.code).toBe('ASSERTION_FAILED');
    vexpect(error.message).toBe('the order: expected the promise to resolve, but it rejected with [Error: boom]');
    vexpect(error.cause).toBe(boom);
  });

  it('resolves toMatchSchema to the schema output', async () => {
    const output = await e2eExpect(Promise.resolve({ id: '7' })).resolves.toMatchSchema(z.object({ id: z.coerce.number() }));
    vexpect(output).toEqual({ id: 7 });
  });

  it('takes a thenable, and refuses anything else as a rejected promise', async () => {
    // oxlint-disable-next-line unicorn/no-thenable -- a thenable that is not a Promise is the case under test
    const thenable = { then: (done: (value: number) => void) => done(3) };
    await e2eExpect(thenable).resolves.toBe(3 as never);
    const error = await rejectionOf(e2eExpect(1).resolves.toBe(1));
    vexpect(error.code).toBe('INVALID_ARGUMENT');
    vexpect(error.message).toBe('expect(...).resolves requires a promise, got 1');
  });
});

describe('rejects', () => {
  it('runs a value matcher on the rejection', async () => {
    await e2eExpect(Promise.reject(new PaymentError('card declined'))).rejects.toBeInstanceOf(PaymentError);
    await e2eExpect(Promise.reject(new PaymentError('card declined'))).rejects.toMatchObject({ message: 'card declined' });
    await e2eExpect(Promise.reject('no')).rejects.toBe('no');
    await e2eExpect(Promise.reject('no')).rejects.not.toBe('yes');
    await e2eExpect(Promise.reject('no')).not.rejects.toBe('yes');
    await rejectsWith(e2eExpect(Promise.reject('no')).rejects.toBe('yes'), 'expected "no" to be "yes"');
  });

  it('toThrow checks the rejection without calling it', async () => {
    const rejected = (): Promise<never> => Promise.reject(new PaymentError('card declined'));
    await e2eExpect(rejected()).rejects.toThrow();
    await e2eExpect(rejected()).rejects.toThrow('declined');
    await e2eExpect(rejected()).rejects.toThrow(/^card/);
    await e2eExpect(rejected()).rejects.toThrow(PaymentError);
    await e2eExpect(rejected()).rejects.toThrow(new Error('card declined'));
    await e2eExpect(rejected()).rejects.not.toThrow(TypeError);
    await e2eExpect(Promise.reject('plain text')).rejects.toThrow('plain');
    await rejectsWith(
      e2eExpect(rejected()).rejects.toThrow('expired'),
      'expected the promise to reject with an error with a message containing "expired", but it rejected with [PaymentError: card declined]',
    );
    await rejectsWith(
      e2eExpect(rejected()).rejects.not.toThrow(),
      'expected the promise not to reject, but it rejected with [PaymentError: card declined]',
    );
  });

  it('fails on a promise that resolves, negated too', async () => {
    await rejectsWith(e2eExpect(Promise.resolve(1)).rejects.toThrow(), 'expected the promise to reject, but it resolved with 1');
    await rejectsWith(
      e2eExpect(Promise.resolve(1), 'the charge').rejects.not.toBe(2),
      'the charge: expected the promise to reject, but it resolved with 1',
    );
  });
});

describe('resolves and rejects inside a test', () => {
  it('fails the phase that returned without awaiting, at the line of the call, and cancels it', async () => {
    const scope = new PollScope('the test body');
    const never = new Promise<number>(() => undefined);
    const pending = runInPollScope(scope, () => e2eExpect(never).resolves.toBe(1));
    const error = scope.close();
    vexpect(error?.code).toBe('STEP_NOT_AWAITED');
    vexpect(error?.message).toBe(
      'the test body returned before expect(...).resolves.toBe(...) finished; put `await` in front of every expect.poll, resolves, rejects, and toPass matcher',
    );
    vexpect(error?.stack).toContain('expect-unit-matchers.test.ts');
    vexpect(await pending.then(() => undefined, (cause: unknown) => cause)).toMatchObject({ code: 'CANCELLED' });
  });

  it('expect.soft keeps a promised failure and resolves', async () => {
    const end = new AbortController();
    const soft = new SoftFailures();
    publishAttempt(
      {
        attemptId: 'attempt',
        owner: 'suite',
        testKind: 'test',
        assertionTimeout: 5000,
        budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)),
        soft,
      },
      end.signal,
    );
    try {
      await e2eExpect.soft(Promise.resolve(1)).resolves.toBe(2);
      await e2eExpect.soft(Promise.resolve(1)).resolves.not.toBe(1);
      await e2eExpect.soft(Promise.resolve(1)).rejects.toThrow();
      await e2eExpect.soft(Promise.resolve(1)).resolves.toBe(1);
      vexpect(await e2eExpect.soft(Promise.resolve('x')).resolves.toMatchSchema(z.number())).toBeUndefined();
      vexpect(soft.close()?.message.split('\n').slice(0, 4)).toEqual([
        '4 soft assertions failed',
        '1. expected 1 to be 2',
        '2. expected 1 not to be 1',
        '3. expected the promise to reject, but it resolved with 1',
      ]);
    } finally {
      end.abort();
    }
  });
});

describe('the new matchers under expect.poll', () => {
  it('re-reads until a strict or instance matcher holds', async () => {
    let reads = 0;
    const read = (): unknown => (++reads < 3 ? { id: 1, note: undefined } : { id: 1 });
    await e2eExpect.poll(read, { intervals: [1] }).toStrictEqual({ id: 1 });
    vexpect(reads).toBe(3);
    await e2eExpect.poll(() => [{ sku: 'a' }], { intervals: [1] }).toContainEqual({ sku: 'a' });
    await e2eExpect.poll(() => new Order(1), { intervals: [1] }).toBeInstanceOf(Order);
  });
});
