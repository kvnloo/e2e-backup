/**
 * Config file helpers: `defineConfig` preserves the config's inferred type,
 * and `defineService` defines a single service.
 */

import type { Service } from '@e2e-dev/core/lib/types';
import type { E2EConfig } from '../run-types.ts';

/**
 * Returns `config` as it is, with its inferred type, so `typeof config` can
 * type the fixtures of `test.extend`. A key that `E2EConfig` doesn't have
 * is a type error, as with `satisfies E2EConfig`.
 */
export function defineConfig<const Config extends E2EConfig>(
  config: Config & { readonly [Key in Exclude<keyof Config, keyof E2EConfig>]: never },
): Config {
  return config;
}

/**
 * Returns `service` unchanged, preserving the inferred type that `start` yields
 * for tests.
 */
export function defineService<Value extends object>(service: Service<Value>): Service<Value> {
  return service;
}
