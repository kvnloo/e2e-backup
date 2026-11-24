/**
 * The two helpers a config file calls: `defineConfig`, which types an `env`
 * function's `services` from the config's own `services`, and
 * `defineService`, which declares one service.
 */

import { ConfigurationError } from '@e2e-dev/core/lib/internal/errors';
import { isPlainObject, rejectUnknownKeys } from '@e2e-dev/core/lib/internal/options';
import type { Service, ServiceMap, ServiceValues } from '@e2e-dev/core/lib/types';
import type { E2EConfig } from '../run-types.ts';

/**
 * Returns `config` as it is. Its type is the config's own, so `typeof config`
 * can type the fixtures of `test.extend`. Calling it instead of ending the
 * object in `satisfies E2EConfig` types the `services` an `app.command.env`
 * function receives from the config's `services`.
 */
export function defineConfig<Services extends ServiceMap = {}, const Config extends E2EConfig<ServiceValues<Services>> = E2EConfig<ServiceValues<Services>>>(
  config: Config & { readonly services?: Services },
): Config {
  return config;
}

/**
 * Declares a service: an object with a `start` async generator. The code
 * before its `yield` starts the service, the yielded object is the value the
 * config and the tests get, and the code after the `yield` stops it.
 */
export function defineService<Value extends object>(service: Service<Value>): Service<Value> {
  if (!isPlainObject(service)) {
    throw new ConfigurationError('INVALID_CONFIG', 'defineService takes an object, such as defineService({ async *start() { ... } })');
  }
  rejectUnknownKeys('defineService', service, ['start']);
  if (typeof service.start !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', 'defineService needs a start async generator, such as defineService({ async *start() { ... } })');
  }
  return service;
}
