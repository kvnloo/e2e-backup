/** The fixtures an `electron()` target contributes, as types only. */

import type { Electron } from './electron.ts';

/** What a session on an `electron()` target holds beside `screen` and `app`: the `electron` fixture. */
export interface ElectronFixtures {
  readonly electron: Electron;
}
