/**
 * The values of the services `e2e run` started, as the `services` fixture
 * hands them out in this process. A worker sets them when it boots, and an
 * in-process run sets them for its tests. Everywhere else no service runs:
 * the fixture holds what an entry point that starts none gave
 * (`setUnstartedServices`), or nothing.
 */

let started: Readonly<Record<string, unknown>> | undefined;

let unstarted: Readonly<Record<string, unknown>> = Object.freeze({});

/** Makes `values` what the `services` fixture holds in this process; `undefined` takes them back. */
export function setServiceValues(values: Readonly<Record<string, unknown>> | undefined): void {
  started = values;
}

/**
 * Makes `values` what the `services` fixture holds while no run set its own:
 * the services of an entry point that starts none (`e2e mcp`, `openHost`),
 * whose reads say so.
 */
export function setUnstartedServices(values: Readonly<Record<string, unknown>>): void {
  unstarted = values;
}

/** Returns what the `services` fixture holds in this process. */
export function serviceValues(): Readonly<Record<string, unknown>> {
  return started ?? unstarted;
}
