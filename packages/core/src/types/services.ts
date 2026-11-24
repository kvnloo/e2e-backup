/**
 * The types of the services a config declares: what `defineService` takes,
 * and the value a test and a command's `env` function receive for each.
 * Re-exported from `types.ts`.
 */

/** What a service's `start` receives. */
export interface ServiceStartContext {
  /**
   * Aborts when the runner stops waiting for the service: while it starts,
   * when the run is cancelled or the service hasn't yielded within 60
   * seconds, and while it stops, when the code after the `yield` hasn't
   * finished within 10 seconds. A normal stop doesn't abort it.
   */
  readonly signal: AbortSignal;
}

/**
 * A dependency of the app under test (an email API, an OAuth provider, a
 * database) that the runner starts before the app commands and stops at the
 * end of the run. One instance is shared by every worker.
 */
export interface Service<Value extends object = object> {
  /**
   * An async generator that yields once. The code before the `yield` starts
   * the service, the yielded object is what the config and the tests get,
   * and the code after the `yield` stops it.
   */
  start(context: ServiceStartContext): AsyncGenerator<Value, void, undefined>;
}

/** The services of a config, by name. */
export type ServiceMap = Readonly<Record<string, Service>>;

/** Values a test receives as they are: structured-clone types the runner copies without walking them. */
type CopiedValue = Date | RegExp | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | ArrayBufferLike | ArrayBufferView | Error;

/**
 * A yielded value as a test sees it: plain objects and arrays keep their
 * shape, and every function becomes an async function that the runner
 * calls in its process.
 */
export type ServiceValue<Value> = Value extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<Awaited<Result>>
  : Value extends CopiedValue
    ? Value
    : Value extends object
      ? { [Key in keyof Value]: ServiceValue<Value[Key]> }
      : Value;

/** The value of each service in `Services`, by name, as a test and a command's `env` function receive it. */
export type ServiceValues<Services> = {
  readonly [Name in keyof Services]: Services[Name] extends Service<infer Value> ? ServiceValue<Value> : never;
};
