import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';

/**
 * How registration tells the module loader that the module at a path
 * registered a test or a hook while it was evaluating, whichever copy of e2e
 * either one is. The loader then evaluates that module again with every test
 * file that imports it (`esm-hooks.ts`, "Registrars"). Unset where no loader
 * runs.
 */
export const registrarModuleSlot = realmSlot<(file: string) => void>('e2e.registrar-module.v1');

/** The loader's original URL for a module it reloaded, shared across copies of e2e. */
export const originalModuleURLSlot = realmSlot<(url: string) => string | undefined>('e2e.original-module-url.v1');
