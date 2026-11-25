/**
 * What the Electron engine is given: its options. The app under test is the
 * target's `app` (`appPath`, `launchArguments`); these options only say how
 * the engine starts Electron and reads its windows.
 */

import { ConfigurationError, rejectUnknownKeys } from '@e2e-dev/core/engine';

/**
 * Options of the Electron engine. Every optional value also accepts
 * `undefined`, so values read straight from `process.env` need no
 * conditional spread.
 */
export interface ElectronOptions {
  /**
   * The executable to start: a packaged app's binary, or an Electron binary
   * of your own; relative to the project root. Default: the `electron`
   * package installed in the project, which runs the target's `app.appPath`.
   */
  readonly executablePath?: string | undefined;
  /**
   * Command-line switches passed before the app path, for Electron or
   * Chromium (`--disable-gpu`, `--lang=de`). The engine passes its own
   * `--user-data-dir`, so every attempt starts with empty app data.
   */
  readonly args?: readonly string[] | undefined;
  /** Variables added to the app's environment, over the run's own. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** How long `app.open()` waits for the app's first window, in milliseconds. Default 30000. */
  readonly launchTimeout?: number | undefined;
  /** The attribute `getByTestId` reads. Default `data-testid`. */
  readonly testIdAttribute?: string | undefined;
  /**
   * How long the engine waits after an action the agent took before the
   * agent observes again, in milliseconds; `false` skips the wait. A test's
   * own steps never wait: `expect` polls their outcome. Default 100.
   */
  readonly settle?: number | false | undefined;
}

const OPTION_KEYS = Object.keys({
  executablePath: true,
  args: true,
  env: true,
  launchTimeout: true,
  testIdAttribute: true,
  settle: true,
} satisfies Record<keyof ElectronOptions, true>);

/** The options with defaults applied, checked once at config load. */
export interface ResolvedElectronOptions {
  readonly executablePath?: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly launchTimeoutMs: number;
  readonly testIdAttribute: string;
  readonly settleMs: number;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

/** Whether a launch argument sets Chromium's profile directory, which the engine owns: every attempt gets an empty one. */
export function setsUserDataDir(argument: string): boolean {
  return /^--user-data-dir(=|$)/.test(argument);
}
const DEFAULT_SETTLE_MS = 100;

/**
 * An attribute name the document grammar accepts (XML `Name`, ASCII): a value
 * outside it could never be on an element, so `getByTestId` would match
 * nothing and every `testId` query would fail silently.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

/** Checks the option bag the way every config option is checked: unknown keys and wrong types fail the config load. */
export function resolveOptions(options: ElectronOptions | undefined): ResolvedElectronOptions {
  // Only a missing bag defaults: a null one (from JSON an agent wrote for e2e mcp) is a config error, not the defaults.
  const bag: ElectronOptions = options === undefined ? {} : options;
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) throw new ConfigurationError('INVALID_CONFIG', 'electron() options must be an object');
  rejectUnknownKeys('electron() options', bag, OPTION_KEYS);
  const { executablePath, args, env, launchTimeout, testIdAttribute, settle } = bag;
  if (executablePath !== undefined && (typeof executablePath !== 'string' || executablePath === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ executablePath }) must be a path to an executable');
  }
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ args }) must be an array of strings');
  }
  if (args?.some(setsUserDataDir) === true) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ args }) must not set --user-data-dir: the engine gives every attempt an empty one of its own');
  }
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string'))) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ env }) must be an object of variable name to string value');
  }
  if (launchTimeout !== undefined && (!Number.isInteger(launchTimeout) || launchTimeout < 1)) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ launchTimeout }) must be a whole number of milliseconds, at least 1');
  }
  if (testIdAttribute !== undefined && (typeof testIdAttribute !== 'string' || !ATTRIBUTE_NAME.test(testIdAttribute))) {
    throw new ConfigurationError('INVALID_CONFIG', `electron({ testIdAttribute }) must be an attribute name such as "data-testid", got ${JSON.stringify(testIdAttribute)}`);
  }
  if (settle !== undefined && settle !== false && (!Number.isInteger(settle) || settle < 0)) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ settle }) must be a whole number of milliseconds, or false');
  }
  return {
    ...(executablePath === undefined ? {} : { executablePath }),
    args: args ?? [],
    env: env ?? {},
    launchTimeoutMs: launchTimeout ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    testIdAttribute: testIdAttribute ?? 'data-testid',
    settleMs: settle === false ? 0 : (settle ?? DEFAULT_SETTLE_MS),
  };
}
