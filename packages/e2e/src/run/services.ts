/**
 * The services a run starts. Each one's generator runs up to its `yield`
 * before the app commands start, and is resumed after they stop. Workers get
 * a copy of the yielded values. Each function in them becomes an async
 * function that sends a call to the runner process. The runner calls the
 * real function there and sends the result back.
 */

import { deserialize, serialize } from 'node:v8';
import { errorMessage, InfrastructureError, ConfigurationError, TestError } from '@e2e-dev/core/lib/internal/errors';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';
import type { Service } from '@e2e-dev/core/lib/types';

/**
 * How long a service may take to yield, and how long the code after its
 * `yield` may take, in milliseconds: an app command's default
 * `startupTimeout` and `shutdownTimeout`. Only the test harness changes them.
 */
const SERVICE_LIMITS: ServiceLimits = { startMs: 60_000, stopMs: 10_000 };

/** What a wait resolves to once the runner stops waiting. */
const ABORTED = Symbol('aborted');

/** A path into a yielded value: the service name, then object keys and array indexes. */
type ValuePath = readonly (string | number)[];

/**
 * The services' values as they cross to a worker: the values by service
 * name, with `null` where a function was, serialized in base64, and the path
 * of each function. A call names a function by its index in `functions`.
 */
export interface ServiceWire {
  readonly data: string;
  readonly functions: readonly ValuePath[];
}

/** The answer to one call: the result or the thrown error, serialized in base64. */
export type ServiceReply = { readonly result: string } | { readonly error: string };

/** Sends a call of function `call` with the serialized `args` to the runner process. */
export type ServiceCaller = (call: number, args: string) => Promise<ServiceReply>;

/** A service whose generator yielded, waiting at its `yield` to be stopped. */
interface StartedService {
  readonly name: string;
  readonly generator: AsyncGenerator<object, void, undefined>;
  readonly controller: AbortController;
}

/** How long the runner waits for a service to start and to stop, in milliseconds. */
interface ServiceLimits {
  readonly startMs: number;
  readonly stopMs: number;
}

/** Hooks a run narrates each service's start through. */
export interface ServiceHooks {
  starting(name: string): void;
  ready(name: string, durationMs: number): void;
}

/** The started services of a run: what the workers receive, the calls they send, and the stop. */
export interface RunServices {
  /** The values as they cross to a worker. */
  readonly wire: ServiceWire;
  /** Calls one function with serialized arguments, and resolves to its serialized result or error. */
  readonly call: ServiceCaller;
  /** Stops every started service, in reverse order. Each failure goes to `onFailure`, and none skips another service's stop. */
  stop(onFailure: (cause: unknown) => void): Promise<void>;
}

/** The values a run with no services hands out. */
export const NO_SERVICES: RunServices = {
  wire: { data: encode({}), functions: [] },
  call: async () => ({ error: encode(new Error('this run has no services')) }),
  stop: async () => undefined,
};

/**
 * Starts `services` in order and checks each yielded value. Nothing more
 * starts once `signal` aborted. If one fails to start, the ones already
 * started are stopped before the failure is thrown. `limits` replaces the
 * start and stop limits for the test harness.
 */
export async function startServices(
  services: ReadonlyMap<string, Service>,
  signal: AbortSignal,
  hooks: ServiceHooks,
  limits: Partial<ServiceLimits> = {},
): Promise<RunServices> {
  const { startMs, stopMs } = { ...SERVICE_LIMITS, ...limits };
  const started: StartedService[] = [];
  const values: Record<string, unknown> = {};
  const functions: { readonly path: ValuePath; readonly fn: (...args: unknown[]) => unknown }[] = [];
  const stop = async (onFailure: (cause: unknown) => void): Promise<void> => {
    for (const service of started.splice(0).toReversed()) {
      try {
        await stopService(service, stopMs);
      } catch (cause) {
        onFailure(cause);
      }
    }
  };

  let wire: ServiceWire;
  try {
    for (const [name, service] of services) {
      if (signal.aborted) break;
      hooks.starting(name);
      const startedAt = Date.now();
      const yielded = await startService(name, service, signal, startMs);
      if (yielded === undefined) break;
      started.push(yielded.service);
      if (!isPlainObject(yielded.value)) {
        throw new ConfigurationError(
          'INVALID_SERVICE_VALUE',
          `service "${name}" yielded ${describe(yielded.value)}; yield a plain object, such as { url }`,
        );
      }
      values[name] = copyValue(yielded.value, [name], functions, new Set());
      hooks.ready(name, Date.now() - startedAt);
    }
    wire = { data: encode(values), functions: functions.map(({ path }) => path) };
  } catch (cause) {
    // A cleanup failure after a failed start is dropped: the startup failure is the one reported.
    await stop(() => undefined);
    throw cause;
  }

  return {
    wire,
    call: async (call, args) => {
      const entry = functions[call];
      if (entry === undefined) return { error: encode(new Error(`no service function has index ${call}`)) };
      try {
        const result = await Reflect.apply(entry.fn, undefined, deserialize(Buffer.from(args, 'base64')) as unknown[]);
        try {
          return { result: encode(result) };
        } catch (cause) {
          return { error: encode(new Error(`it returned a value that can't be copied to the test: ${errorMessage(cause)}`)) };
        }
      } catch (cause) {
        try {
          return { error: encode(cause) };
        } catch {
          return { error: encode(new Error(errorMessage(cause))) };
        }
      }
    },
    stop,
  };
}

/**
 * Runs one service's generator up to its `yield`. Resolves to undefined when
 * `signal` aborted first: the run was cancelled. The service's own signal
 * aborts then, or once it hasn't yielded within the start limit, and a
 * service that yields after the runner stopped waiting is stopped right away.
 */
async function startService(
  name: string,
  service: Service,
  signal: AbortSignal,
  limitMs: number,
): Promise<{ readonly service: StartedService; readonly value: unknown } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new InfrastructureError('SERVICE_START_FAILED', `service "${name}" didn't yield within ${limitMs / 1000} seconds`)), limitMs);
  const cancel = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });

  try {
    let generator: AsyncGenerator<object, void, undefined>;
    try {
      generator = service.start({ signal: controller.signal });
    } catch (cause) {
      throw startFailure(name, cause);
    }
    if (typeof generator !== 'object' || generator === null || typeof generator.next !== 'function') {
      void Promise.resolve(generator).catch(() => undefined);
      throw new InfrastructureError('SERVICE_START_FAILED', `service "${name}" start must be an async generator function: async *start() { ... }`);
    }

    const next = generator.next();
    const first = await Promise.race([next, whenAborted(controller.signal)]).catch((cause: unknown) => {
      throw startFailure(name, cause);
    });
    if (first === ABORTED) {
      void next.then((late) => (late.done === true ? undefined : generator.next())).catch(() => undefined);
      if (signal.aborted) return undefined;
      throw controller.signal.reason;
    }
    if (first.done === true) {
      throw new InfrastructureError(
        'SERVICE_START_FAILED',
        `service "${name}" finished without yielding; yield its value once, between the code that starts it and the code that stops it`,
      );
    }
    return { service: { name, generator, controller }, value: first.value };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/**
 * Resumes one service's generator past its `yield`, which runs its stop
 * code. Its signal aborts once that code hasn't finished within the stop
 * limit, and the runner stops waiting. A second `yield` is a failure, and
 * `return()` ends the generator so its `finally` blocks run.
 */
async function stopService({ name, generator, controller }: StartedService, limitMs: number): Promise<void> {
  const timer = setTimeout(() => controller.abort(), limitMs);
  const untilAborted = async <T>(promise: Promise<T>): Promise<T> => {
    const outcome = await Promise.race([promise, whenAborted(controller.signal)]).catch((cause: unknown) => {
      throw new InfrastructureError('SERVICE_STOP_FAILED', `service "${name}" failed to stop: ${errorMessage(cause)}`, { cause });
    });
    if (outcome !== ABORTED) return outcome;
    void promise.catch(() => undefined);
    throw new InfrastructureError('SERVICE_STOP_FAILED', `service "${name}" didn't stop within ${limitMs / 1000} seconds`);
  };

  try {
    const next = await untilAborted(generator.next());
    if (next.done !== true) {
      await untilAborted(generator.return(undefined));
      throw new InfrastructureError(
        'SERVICE_STOP_FAILED',
        `service "${name}" yielded a second time; a service yields once, and the code after its yield stops it`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A failure of a service's start code, naming the service. */
function startFailure(name: string, cause: unknown): InfrastructureError {
  return new InfrastructureError('SERVICE_START_FAILED', `service "${name}" failed to start: ${errorMessage(cause)}`, { cause });
}

/** Resolves to `ABORTED` once `signal` aborts. */
function whenAborted(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(ABORTED);
    else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });
}

/**
 * Copies a yielded value for the workers. Plain objects and arrays are
 * walked. A function is added to `functions` and left out as `null`. Any
 * other value must survive the copy the workers get (`encode`). A value the
 * copy turns into a plain object is a class instance that would lose its
 * class, so it's refused.
 */
function copyValue(
  value: unknown,
  path: ValuePath,
  functions: { readonly path: ValuePath; readonly fn: (...args: unknown[]) => unknown }[],
  ancestors: Set<object>,
): unknown {
  if (typeof value === 'function') {
    functions.push({ path, fn: value as (...args: unknown[]) => unknown });
    return null;
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) throw invalidValue(path, 'a value', " that refers to itself, which can't be copied to the workers");
    ancestors.add(value);
    const copy = Array.isArray(value)
      ? value.map((item: unknown, index) => copyValue(item, [...path, index], functions, ancestors))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyValue(item, [...path, key], functions, ancestors)]));
    ancestors.delete(value);
    return copy;
  }
  let clone: unknown;
  try {
    clone = decode(encode(value));
  } catch (cause) {
    throw invalidValue(path, 'a value', ` that can't be copied to the workers: ${errorMessage(cause)}`);
  }
  if (isPlainObject(clone)) {
    throw invalidValue(path, describe(value), ", which loses its class when it's copied to the workers; wrap the data tests need in a plain object");
  }
  return value;
}

/** A yielded value that can't reach the workers: `what` it is, where in the service's value, and the `problem`. */
function invalidValue(path: ValuePath, what: string, problem: string): ConfigurationError {
  const [name, ...rest] = path;
  return new ConfigurationError('INVALID_SERVICE_VALUE', `service "${String(name)}" yielded ${what} at ${pathLabel(rest)}${problem}`);
}

/** A path as code would write it: `email.clear`, `email.inboxes[0].read`. */
function pathLabel(path: ValuePath): string {
  return path.map((key, index) => (typeof key === 'number' ? `[${key}]` : index === 0 ? key : `.${key}`)).join('');
}

/** Names a value in an error: its class, or its type. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object') return typeof value;
  const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === 'string' && name !== '' ? `an instance of ${name}` : 'an object with a prototype';
}

/** Serializes a value with `v8.serialize`, in base64 for the worker channel. */
function encode(value: unknown): string {
  return serialize(value).toString('base64');
}

/** Reads a value `encode` serialized. */
function decode(data: string): unknown {
  return deserialize(Buffer.from(data, 'base64'));
}

/**
 * The services' values as tests get them, built from `wire`: a copy of the
 * data, with every function replaced by an async function that sends its
 * call through `caller` and resolves to a copy of the result. A thrown error
 * comes back as a copy too, its message naming the service and the function.
 */
export function copyServiceValues(wire: ServiceWire, caller: ServiceCaller): Readonly<Record<string, unknown>> {
  const functions = new Map(wire.functions.map((path, index) => [JSON.stringify(path), index]));
  const attach = (value: unknown, path: ValuePath): unknown => {
    const index = functions.get(JSON.stringify(path));
    if (index !== undefined) return serviceFunction(index, `services.${pathLabel(path)}()`, caller);
    if (Array.isArray(value)) return value.map((item: unknown, position) => attach(item, [...path, position]));
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, attach(item, [...path, key])]));
    return value;
  };
  const data = decode(wire.data);
  return isPlainObject(data) ? Object.fromEntries(Object.entries(data).map(([name, value]) => [name, attach(value, [name])])) : {};
}

/** One function of a service's value as tests get it; `label` names it in errors (`services.email.clear()`). */
function serviceFunction(index: number, label: string, caller: ServiceCaller): (...args: unknown[]) => Promise<unknown> {
  return async (...args) => {
    // Taken before the call leaves, so a failure points at the test line that made it.
    const callSite = new Error();
    let encoded: string;
    try {
      encoded = encode(args);
    } catch (cause) {
      throw new TestError('INVALID_ARGUMENT', `${label} takes arguments that can be copied to the runner process: ${errorMessage(cause)}`);
    }
    const reply = await caller(index, encoded);
    if ('result' in reply) return decode(reply.result);
    const copy = decode(reply.error);
    const error = copy instanceof Error ? copy : new Error(String(copy));
    error.message = `${label} failed: ${error.message}`;
    const frames = (stack: string | undefined): string[] => (stack ?? '').split('\n').filter((line) => line.trimStart().startsWith('at '));
    error.stack = [`${error.name}: ${error.message}`, ...frames(copy instanceof Error ? copy.stack : undefined), ...frames(callSite.stack)].join('\n');
    return Promise.reject(error);
  };
}

/**
 * The `services` an `app.command.env` function and the `services` fixture
 * get where no service runs (`where` is `e2e mcp` or `openHost`). Reading one
 * throws an error that says so and names the service, instead of a
 * `TypeError` on `undefined`. A symbol, `then`, and the names every object
 * has read as on an empty object, so awaiting or printing it still works.
 */
export function unstartedServices(where: string): Readonly<Record<string, unknown>> {
  return new Proxy(
    {},
    {
      get: (target, name) => {
        if (typeof name !== 'string' || name === 'then' || name in Object.prototype) return Reflect.get(target, name);
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `${where} doesn't start services, so services.${name} isn't available here; run the tests with e2e run, or give the app this value another way`,
        );
      },
    },
  );
}
