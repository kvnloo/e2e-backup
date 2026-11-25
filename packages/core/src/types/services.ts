/**
 * Types for configured services, including the input to `defineService` and
 * the values tests receive.
 * Re-exported from `types.ts`.
 */

/** Context passed to a service's `start` function. */
export type ServiceStartContext = {
  /**
   * Aborts in these cases:
   *
   * - Startup is cancelled, or the service doesn't yield within 60 seconds.
   * - The code after `yield` doesn't finish within 10 seconds.
   * - A second Ctrl+C arrives while services are stopping.
   */
  readonly signal: AbortSignal;
};

/**
 * A dependency of the app under test (like an email API, an OAuth provider,
 * or a database) started before the app commands and stopped at the end of
 * the run. One instance is shared across all workers.
 */
export type Service<Value extends object = object> = {
  /**
   * Starts the dependency and stops it when the run ends. This async generator
   * yields the service value once, and tests receive it.
   */
  start(context: ServiceStartContext): AsyncGenerator<Value, void, undefined>;
};

/** Configured services, keyed by name. */
export type ServiceMap = Readonly<Record<string, Service>>;

/** Built-in classes that keep their type when copied with `v8.serialize`. */
type CopiedValue = Date | RegExp | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | ArrayBuffer | ArrayBufferView | Error;

/**
 * A yielded service value as seen in tests. Plain objects and arrays keep
 * their shape, and every function becomes an async function called in the
 * runner process. `SharedArrayBuffer` can't be copied, so it maps to `never`.
 */
export type ServiceValue<Value> = Value extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<Awaited<Result>>
  : Value extends SharedArrayBuffer
    ? never
    : Value extends CopiedValue
      ? Value
      : Value extends object
        ? { [Key in keyof Value]: ServiceValue<Value[Key]> }
        : Value;

/** Service values from `Services`, keyed by name, as tests receive them. */
export type ServiceValues<Services> = {
  readonly [Name in keyof Services]: Services[Name] extends Service<infer Value> ? ServiceValue<Value> : never;
};
