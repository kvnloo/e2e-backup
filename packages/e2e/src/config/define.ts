/**
 * Config file helpers. `defineConfig` preserves the config's inferred type
 * and types `services` in `env` functions from the config's `services`.
 * `defineService` defines a single service.
 */

import type { Service, ServiceMap, ServiceValues } from '@e2e-dev/core/lib/types';
import type { E2EConfig } from '../run-types.ts';

/**
 * Returns `config` unchanged with its inferred type, so `typeof config` can
 * type the fixtures of `test.extend`. Use it instead of `satisfies E2EConfig`
 * so `services` in an `app.command.env` function is typed from the config's
 * `services`.
 */
export function defineConfig<Services extends ServiceMap = {}, const Config extends E2EConfig<ServiceValues<Services>> = E2EConfig<ServiceValues<Services>>>(
  config: Config & { readonly services?: Services } & { readonly [Key in Exclude<keyof Config, keyof E2EConfig>]: never },
): Config {
  return config;
}

/**
 * Returns `service` unchanged, preserving the inferred type that `start`
 * yields for both the config and tests.
 */
export function defineService<Value extends object>(service: Service<Value>): Service<Value> {
  return service;
}
