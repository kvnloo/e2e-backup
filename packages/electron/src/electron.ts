/**
 * The `electron` fixture: what a test asks of the Electron app itself rather
 * than of a control in a window. The harness records each call as an
 * `electron.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, stepTimeout, type EngineFixtureContext, type Locator } from '@e2e-dev/core/engine';
import type { ElectronSurface, ElectronWindow, WindowMatcher } from './surface.ts';

/**
 * The main process's `electron` module as a function passed to `evaluate`
 * receives it. Typed loosely: this package does not depend on Electron's
 * types; annotate the parameter with `typeof import('electron')` in a project
 * that has them.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the module's type is the project's Electron version's, which this package cannot name
export type ElectronMainModule = any;

/** Deterministic Electron app management exposed to tests as `electron`. */
export interface Electron {
  /**
   * Runs `fn` in the app's main process and returns what it returns, which
   * must be serializable. `fn` is sent as source text: it cannot close over
   * the test's variables, so pass them as `arg`. Code with the main
   * process's full authority, as trusted as the test itself.
   */
  evaluate<R, A = undefined>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  /** The app's open windows, in the order they opened, the one `screen` reads marked `shown`. */
  windows(): Promise<readonly ElectronWindow[]>;
  /**
   * Reads and acts in another window from now on: the window at a position,
   * or the first whose title or URL matches (a string exactly, or a RegExp).
   * Waits for such a window to open, up to `timeout` milliseconds or else
   * the action timeout.
   */
  useWindow(which: WindowMatcher, options?: { readonly timeout?: number }): Promise<ElectronWindow>;
  /**
   * A locator for a CSS selector in the window `screen` reads, for an element
   * no role, label, text, or test id names. It matches in the window's
   * document and in each open shadow root, one root at a time, and never
   * enters a frame.
   */
  locator(selector: string): Locator;
}

export function createElectronFixture(surface: ElectronSurface, context: EngineFixtureContext): Electron {
  const electron: Electron = {
    async evaluate(fn, arg) {
      return await surface.evaluate(fn, arg as never, context.operation());
    },
    async windows() {
      return await surface.windows();
    },
    async useWindow(which, options) {
      return await surface.useWindow(which, context.operation(stepTimeout(options?.timeout, 'electron.useWindow')));
    },
    locator(selector) {
      if (typeof selector !== 'string' || selector.trim() === '') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.locator() takes a CSS selector string');
      return context.locator({ kind: 'selector', selector });
    },
  };
  return context.fixture('electron', electron, {
    evaluate: { kind: 'resource' },
    windows: { kind: 'resource' },
    useWindow: { kind: 'resource', timeout: (_which, options) => options?.timeout, label: (which) => (typeof which === 'number' ? String(which) : JSON.stringify({ ...which, title: which.title?.toString(), url: which.url?.toString() })) },
  });
}
