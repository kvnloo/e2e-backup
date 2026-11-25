/**
 * The Electron surface: one app per attempt, launched by `app.open()` with
 * an empty user-data directory of the attempt's own, its windows read
 * through Chromium's accessibility tree over the DevTools protocol and
 * driven with trusted input events. Everything here goes through public
 * APIs: Playwright's `_electron` launcher and `CDPSession`, and the engine
 * contract of `@e2e-dev/core/engine`.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, type CDPSession, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import {
  ConfigurationError,
  EngineError,
  expressionSelectors,
  parseKey,
  raceAbort,
  resolveExpression,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type ScrollDirection,
  type SemanticNode,
  type ViewportPoint,
} from '@e2e-dev/core/engine';
import { describeExecutable, ensureElectronBinary, resolveExecutable } from './executable.ts';
import type { ResolvedElectronOptions } from './options.ts';
import { projectTree, unmaskableCount, type AXNode, type ProjectionMode, type SnapshotDocument, type WindowGeometry } from './tree.ts';

/** The observation root's id: one surface, one root, whichever window it reads. */
const ROOT_ID = 'window';

/** The isolated world the engine's own page-side reads run in, apart from the app's globals. */
const WORLD_NAME = '__e2e_electron__';

/** Everything that can hold a secure value or show another document in a screenshot: masked, or the capture is not taken. */
const MASKED_SELECTOR = 'input[type=password i], iframe, frame, webview';

/** How long a long press holds by default. */
const LONG_PRESS_MS = 800;

/** One open window of the app: its page and the serial its node ids carry. */
interface AppWindow {
  readonly page: Page;
  readonly serial: number;
}

/** One window's raw read: the accessibility tree, the DOM snapshot of the same document, and its geometry. */
interface RawRead {
  readonly window: AppWindow;
  readonly ax: readonly AXNode[];
  readonly document: SnapshotDocument;
  readonly strings: readonly string[];
  readonly geometry: WindowGeometry;
  readonly title: string;
  readonly url: string;
}

/** A window of the running app, as the `electron` fixture lists it. */
export interface ElectronWindow {
  /** Its position among the open windows, in the order they opened: what `useWindow` and the agent's tab tools take. */
  readonly index: number;
  readonly title: string;
  readonly url: string;
  /** Whether `screen` and the agent read and act in this window. */
  readonly shown: boolean;
}

/** Which window `useWindow` picks: a position, or the first whose title or URL matches. */
export type WindowMatcher = number | { readonly title?: string | RegExp; readonly url?: string | RegExp };

/** A page-side check's answer: ok, or why the node cannot take the action yet. */
type Readiness = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function stale(message: string, cause?: unknown): EngineError {
  return new EngineError('NODE_STALE', message, { retryable: true, ...(cause === undefined ? {} : { cause }) });
}

function notActionable(message: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', message, { retryable: false });
}

/** Protocol and Playwright failures that mean the node, or the document it was in, is gone. */
const GONE = /No node found|Could not find node|Node is detached|No node with given id|Cannot find context with specified id|Execution context was destroyed|Cannot find object with id|Node is not an element|frame was detached/i;
/** Failures that mean the window, or the whole app, closed. */
const CLOSED = /Target (page, context or browser )?(has been )?closed|Target closed|has been closed|Session closed|browser has disconnected|Protocol error.*Target/i;

/**
 * Translates a failure into the engine error taxonomy. `committed` says
 * input may already have reached the app: then a timeout or a vanished node
 * is `ACTION_MAY_HAVE_COMMITTED`, never something the harness retries.
 */
function translate(cause: unknown, label: string, committed: boolean): Error {
  // A refusal by policy (a screenshot it cannot mask) is the harness's to report as it is.
  if (cause instanceof ConfigurationError) return cause;
  if (cause instanceof EngineError) {
    if (committed && (cause.code === 'OPERATION_TIMEOUT' || cause.retryable)) {
      return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label}: ${cause.message}; its input may have reached the app`, { retryable: false, cause });
    }
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  if (CLOSED.test(message)) return new EngineError('INVALID_STATE', `${label}: the window closed (${message.split('\n')[0]})`, { retryable: false, cause });
  if (GONE.test(message)) {
    if (committed) return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label}: the node went away while the input was sent`, { retryable: false, cause });
    return stale(`${label}: the node is no longer in the window`, cause);
  }
  return new EngineError(committed ? 'ACTION_MAY_HAVE_COMMITTED' : 'ENGINE_FAILURE', `${label} failed: ${message.split('\n')[0]}`, { retryable: false, cause });
}

/** The PNG's own size, read from its header. */
function pngSize(data: Uint8Array): { readonly width: number; readonly height: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A file name a label cannot turn into a path: letters, digits, dashes. */
function fileLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
}

function wheelDelta(direction: ScrollDirection, distance: number): [number, number] {
  switch (direction) {
    case 'down':
      return [0, distance];
    case 'up':
      return [0, -distance];
    case 'right':
      return [distance, 0];
    case 'left':
      return [-distance, 0];
  }
}

function swipeDistance(extent: number, momentum: Momentum): number {
  const ratio = momentum === 'fast' ? 1.5 : momentum === 'slow' ? 0.75 : 0.5;
  return Math.max(1, Math.round(extent * ratio));
}

/** Rounds a point to whole CSS pixels: Chromium truncates fractional pointer coordinates. */
function whole(point: ViewportPoint): ViewportPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function modifierKey(modifier: string): string {
  return modifier === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : modifier;
}

export class ElectronSurface {
  private projectRoot = process.cwd();
  private appInfo: EngineAppInfo = {};
  private runEnv: Readonly<Record<string, string | undefined>> = {};
  private executable: string | undefined;
  private attempt: EngineAttemptContext | undefined;
  private userDataDir: string | undefined;
  private app: ElectronApplication | undefined;
  private readonly windowsByPage = new Map<Page, AppWindow>();
  private shown: AppWindow | undefined;
  private nextSerial = 1;
  private artifactCounter = 0;
  private readonly sessions = new WeakMap<Page, Promise<CDPSession>>();
  private readonly worlds = new WeakMap<Page, Promise<number>>();

  constructor(private readonly options: ResolvedElectronOptions) {}

  // --- run and worker lifecycle ---

  async prepare(info: EnginePrepareInfo): Promise<void> {
    await ensureElectronBinary(info.projectRoot, this.options.executablePath, info.log, info.signal);
  }

  doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const executable = describeExecutable(info.projectRoot, this.options.executablePath);
    return Promise.resolve([{ id: 'electron', status: executable.status, message: executable.message }]);
  }

  async init(info: EngineInitInfo): Promise<void> {
    this.projectRoot = info.projectRoot;
    this.appInfo = info.app;
    this.runEnv = info.env;
    this.executable = await resolveExecutable(info.projectRoot, this.options.executablePath);
  }

  startAttempt(context: EngineAttemptContext): Promise<void> {
    this.attempt = context;
    this.artifactCounter = 0;
    // The app's data lives here for the whole attempt: `app.restart()` keeps it, `app.clearState()` empties it.
    this.userDataDir = mkdtempSync(path.join(tmpdir(), 'e2e-electron-'));
    return Promise.resolve();
  }

  async endAttempt(context: EngineCleanupContext): Promise<void> {
    await this.quit(context);
    if (this.userDataDir !== undefined) rmSync(this.userDataDir, { recursive: true, force: true });
    this.userDataDir = undefined;
    this.attempt = undefined;
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    await this.endAttempt(context);
  }

  // --- the app ---

  /** Quits the running app, if any: a graceful close within the budget, then the process killed. */
  private async quit(budget: { readonly timeoutMs: number }): Promise<void> {
    const app = this.app;
    this.app = undefined;
    this.windowsByPage.clear();
    this.shown = undefined;
    if (app === undefined) return;
    const child = app.process();
    const closed = app.close().then(() => true, () => false);
    const timedOut = sleep(Math.max(1, Math.min(budget.timeoutMs, 10_000))).then(() => false);
    if (!(await Promise.race([closed, timedOut]))) child.kill('SIGKILL');
  }

  /** `app.open()` and `app.restart()`: quits the app if it runs and launches it again on the attempt's app data. */
  async restart(operation: OperationContext): Promise<void> {
    await this.quit({ timeoutMs: Math.min(operation.timeoutMs, 10_000) });
    await this.launch(operation);
  }

  /** `app.clearState()`: quits the app, empties its data, and launches it again. */
  async reset(operation: OperationContext): Promise<void> {
    await this.quit({ timeoutMs: Math.min(operation.timeoutMs, 10_000) });
    if (this.userDataDir !== undefined) {
      rmSync(this.userDataDir, { recursive: true, force: true });
      mkdirSync(this.userDataDir, { recursive: true });
    }
    await this.launch(operation);
  }

  private launchEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.runEnv)) if (value !== undefined) env[key] = value;
    // A runner started from an Electron-based editor inherits this, and the binary would run as plain Node.js.
    delete env['ELECTRON_RUN_AS_NODE'];
    return { ...env, ...this.options.env };
  }

  private async launch(operation: OperationContext): Promise<void> {
    const attempt = this.attempt;
    if (attempt === undefined || this.userDataDir === undefined) throw new EngineError('INVALID_STATE', 'app.open() runs inside a test: no attempt is running', { retryable: false });
    if (this.executable === undefined) throw new EngineError('INVALID_STATE', 'the electron engine was not initialized', { retryable: false });
    const { appPath, launchArguments } = this.appInfo;
    const args = [
      `--user-data-dir=${this.userDataDir}`,
      ...this.options.args,
      ...(appPath === undefined ? [] : [path.resolve(this.projectRoot, appPath)]),
      ...(launchArguments ?? []),
    ];
    const timeout = Math.max(1, Math.min(operation.timeoutMs, this.options.launchTimeoutMs));
    let app: ElectronApplication;
    try {
      app = await raceAbort(
        () => _electron.launch({ executablePath: this.executable!, args, cwd: this.projectRoot, env: this.launchEnv(), timeout }),
        operation.signal,
        'launching the app',
      );
    } catch (cause) {
      if (cause instanceof EngineError) throw cause;
      const message = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
      throw new EngineError('ENGINE_FAILURE', `could not launch ${this.executable}${appPath === undefined ? '' : ` with ${appPath}`}: ${message}`, { retryable: false, cause });
    }
    this.app = app;
    app.on('window', (page) => this.track(app, page));
    app.on('console', (message) => {
      this.attempt?.appLog({ source: 'console', level: levelOf(message.type()), text: `[main] ${message.text()}` });
    });
    app.on('close', () => {
      if (this.app === app) {
        this.windowsByPage.clear();
        this.shown = undefined;
      }
    });
    for (const page of app.windows()) this.track(app, page);
    try {
      const first = await raceAbort(() => app.firstWindow({ timeout }), operation.signal, 'waiting for the first window');
      this.track(app, first);
      await raceAbort(() => first.waitForLoadState('domcontentloaded', { timeout }), operation.signal, 'waiting for the first window to load');
    } catch (cause) {
      await this.quit({ timeoutMs: 5_000 });
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('OPERATION_TIMEOUT', `the app opened no window within ${timeout}ms`, { retryable: false, cause });
    }
    try {
      const versions = await app.evaluate(() => ({ electron: process.versions.electron ?? '', chromium: process.versions.chrome ?? '' }));
      attempt.environment({ electron: versions.electron, chromium: versions.chromium });
    } catch {
      // A packaged app may disable the inspector's evaluation; the versions are provenance only.
    }
  }

  /** Registers a window the app opened: its node ids get a serial of their own, and its log reaches the attempt. */
  private track(app: ElectronApplication, page: Page): void {
    if (this.app !== app || this.windowsByPage.has(page) || page.isClosed()) return;
    const window: AppWindow = { page, serial: this.nextSerial++ };
    this.windowsByPage.set(page, window);
    this.shown ??= window;
    page.on('console', (message) => this.attempt?.appLog({ source: 'console', level: levelOf(message.type()), text: message.text() }));
    page.on('pageerror', (error) => this.attempt?.appLog({ source: 'error', level: 'error', text: error.message }));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.worlds.delete(page);
        if (this.shown === window) this.attempt?.navigation(frame.url());
      }
    });
    page.on('close', () => {
      this.windowsByPage.delete(page);
      if (this.shown === window) this.shown = [...this.windowsByPage.values()].at(-1);
    });
  }

  /** The open windows, in the order they opened. */
  private openWindows(): AppWindow[] {
    return [...this.windowsByPage.values()].filter((window) => !window.page.isClosed()).toSorted((a, b) => a.serial - b.serial);
  }

  /** The window `screen` and the agent read: the one chosen, else the newest still open. */
  private current(): AppWindow | undefined {
    if (this.shown !== undefined && !this.shown.page.isClosed()) return this.shown;
    this.shown = this.openWindows().at(-1);
    return this.shown;
  }

  private requireWindow(): AppWindow {
    const window = this.current();
    if (window === undefined) {
      throw new EngineError('INVALID_STATE', this.app === undefined ? 'the app is not running: open it with app.open()' : 'the app has no open window', { retryable: false });
    }
    return window;
  }

  // --- the DevTools protocol ---

  private session(page: Page): Promise<CDPSession> {
    let session = this.sessions.get(page);
    if (session === undefined) {
      session = page.context().newCDPSession(page);
      this.sessions.set(page, session);
      session.catch(() => this.sessions.delete(page));
    }
    return session;
  }

  /** The execution context of the engine's isolated world in the window's main frame, made once per document. */
  private world(page: Page): Promise<number> {
    let world = this.worlds.get(page);
    if (world === undefined) {
      world = (async () => {
        const session = await this.session(page);
        const { frameTree } = await session.send('Page.getFrameTree');
        const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false });
        return executionContextId;
      })();
      this.worlds.set(page, world);
      world.catch(() => this.worlds.delete(page));
    }
    return world;
  }

  /**
   * Calls `fn` on a node in the isolated world, `this` bound to it. The node
   * is resolved fresh from its backend id, so a node the document dropped
   * fails as stale.
   */
  private async callOn<T>(window: AppWindow, backendNodeId: number, fn: string, args: readonly unknown[] = []): Promise<T> {
    const session = await this.session(window.page);
    const executionContextId = await this.world(window.page);
    const { object } = await session.send('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup: WORLD_NAME });
    if (object.objectId === undefined) throw stale(`node ${backendNodeId} is no longer in the window`);
    try {
      const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value as T;
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: WORLD_NAME }).catch(() => undefined);
    }
  }

  /** Evaluates an expression in the window's isolated world. */
  private async evaluateIn<T>(window: AppWindow, expression: string): Promise<T> {
    const session = await this.session(window.page);
    const contextId = await this.world(window.page);
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  }

  /** Reads the window: its accessibility tree and a DOM snapshot of the same document, with the geometry joining them. */
  private async read(window: AppWindow): Promise<RawRead> {
    const session = await this.session(window.page);
    const [{ nodes }, snapshot, metrics] = await Promise.all([
      session.send('Accessibility.getFullAXTree'),
      session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }),
      session.send('Page.getLayoutMetrics'),
    ]);
    const css = metrics.cssLayoutViewport;
    const device = metrics.layoutViewport;
    const document = snapshot.documents[0];
    if (document === undefined) throw stale('the window has no document yet');
    return {
      window,
      ax: nodes,
      document,
      strings: snapshot.strings,
      geometry: {
        scale: css.clientWidth > 0 ? device.clientWidth / css.clientWidth : 1,
        scrollX: metrics.cssVisualViewport.pageX,
        scrollY: metrics.cssVisualViewport.pageY,
        width: metrics.cssVisualViewport.clientWidth,
        height: metrics.cssVisualViewport.clientHeight,
      },
      title: snapshot.strings[document.title] ?? '',
      url: window.page.url(),
    };
  }

  private project(raw: RawRead, mode: ProjectionMode, keep?: ReadonlySet<number>): EngineSnapshot {
    const { serial } = raw.window;
    const projection = projectTree(raw.ax, raw.document, raw.strings, raw.geometry, {
      mode,
      ...(keep === undefined ? {} : { keep }),
      testIdAttribute: this.options.testIdAttribute,
      idOf: (backendNodeId) => `${serial}.${backendNodeId}`,
      rootId: ROOT_ID,
      ...(raw.title === '' ? {} : { title: raw.title }),
    });
    const open = this.openWindows();
    const active = open.indexOf(raw.window);
    return {
      location: raw.url,
      root: projection.root,
      viewport: { width: raw.geometry.width, height: raw.geometry.height },
      ...(projection.truncated ? { truncated: true } : {}),
      ...(open.length > 1 && active >= 0 ? { tabs: { count: open.length, active } } : {}),
    };
  }

  // --- reading ---

  async observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    const window = this.current();
    if (window === undefined) return { root: { ref: { id: ROOT_ID, revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } };
    return await this.bounded(operation, 'observe', false, async () => {
      const raw = await this.read(window);
      const snapshot = this.project(raw, 'tree');
      if (options?.pixels !== true) return snapshot;
      const masks = window.page.locator(MASKED_SELECTOR);
      const masked = await masks.count();
      // A secure field or nested document in a closed shadow root is out of every selector's reach: the pixels are withheld, and the count says so.
      if (unmaskableCount(raw.document, raw.strings) > 0) return { ...snapshot, maskedRegionCount: masked };
      return { ...snapshot, pixels: await this.capture(window, masks), maskedRegionCount: masked };
    });
  }

  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const window = this.current();
    if (window === undefined) return [];
    return await this.bounded(operation, 'locate', false, async () => {
      const raw = await this.read(window);
      const sink = this.attempt?.screen;
      if (sink !== undefined) {
        try {
          sink(this.project(raw, 'tree'));
        } catch {
          // The trace is evidence; a sink that throws never fails the step.
        }
      }
      // `resolveExpression` takes the selector answer synchronously, so every selector in the expression is queried first;
      // the elements they match stay in the tree even where Chromium's tree leaves them out.
      const selected = new Map<string, ReadonlySet<number>>();
      for (const selector of expressionSelectors(expression)) selected.set(selector, await this.querySelectorAll(window, selector));
      const keep = new Set([...selected.values()].flatMap((ids) => [...ids]));
      const { root } = this.project(raw, 'node', keep);
      const idOf = (backendNodeId: number): string => `${window.serial}.${backendNodeId}`;
      return resolveExpression(expression, [root], {
        selector: (selector, candidates) => {
          const ids = new Set([...(selected.get(selector) ?? [])].map(idOf));
          return candidates.filter((node) => ids.has(node.ref.id));
        },
      });
    });
  }

  /** The backend ids of the elements a CSS selector matches in the window's document. */
  private async querySelectorAll(window: AppWindow, selector: string): Promise<ReadonlySet<number>> {
    const session = await this.session(window.page);
    const { root } = await session.send('DOM.getDocument', { depth: 0 });
    let nodeIds: readonly number[];
    try {
      ({ nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }));
    } catch (cause) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', `${JSON.stringify(selector)} is not a CSS selector this window can match: ${(cause as Error).message.split('\n')[0]}`, { retryable: false, cause });
    }
    const ids = new Set<number>();
    for (const nodeId of nodeIds) {
      const { node } = await session.send('DOM.describeNode', { nodeId });
      ids.add(node.backendNodeId);
    }
    return ids;
  }

  // --- acting ---

  /** The window and backend node a ref names, or a stale error when it is gone or from another window. */
  private bind(ref: NodeRef): { readonly window: AppWindow; readonly backendNodeId: number } {
    const match = /^(\d+)\.(\d+)$/.exec(ref.id);
    if (match === null) throw stale(`node ${ref.id} is not a node of this app`);
    const serial = Number(match[1]);
    const window = this.current();
    if (window === undefined || window.serial !== serial) throw stale(`node ${ref.id} is in a window that is not shown now`);
    return { window, backendNodeId: Number(match[2]) };
  }

  /** Runs `work` within the operation's budget and signal, failures translated. */
  private async bounded<T>(operation: OperationContext, label: string, committed: boolean, work: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await raceAbort(
        () =>
          Promise.race([
            work(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new EngineError('OPERATION_TIMEOUT', `${label} timed out after ${operation.timeoutMs}ms`, { retryable: false })), Math.max(1, operation.timeoutMs));
            }),
          ]),
        operation.signal,
        label,
      );
    } catch (cause) {
      throw translate(cause, label, committed);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The agent reads the screen right after acting, so its actions let the UI settle first; a test's own steps verify with `expect`. */
  private async settle(operation: OperationContext): Promise<void> {
    if (operation.origin === 'agent') await sleep(Math.min(this.options.settleMs, operation.timeoutMs), operation.signal);
  }

  /**
   * Waits until the node can take a pointer action, then returns the point
   * to send it to: in the document, laid out with a box, enabled when
   * `enabled` asks, scrolled into view, and the topmost thing at its centre
   * (or a label for it). Gives up with the last reason at the deadline.
   */
  private async actionablePoint(window: AppWindow, backendNodeId: number, operation: OperationContext, enabled: boolean, deadline: number): Promise<ViewportPoint> {
    const session = await this.session(window.page);
    let reason = 'it never became actionable';
    for (;;) {
      if (operation.signal.aborted) throw new EngineError('CANCELLED', 'the action was cancelled', { retryable: false });
      const state = await this.callOn<Readiness>(window, backendNodeId, CHECK_ENABLED, [enabled]);
      if (state.ok) {
        await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => this.callOn(window, backendNodeId, SCROLL_INTO_VIEW));
        const { quads } = await session.send('DOM.getContentQuads', { backendNodeId }).catch((cause: unknown) => {
          if (cause instanceof Error && GONE.test(cause.message)) throw cause;
          return { quads: [] as number[][] };
        });
        const quad = quads.find((candidate) => area(candidate) > 0);
        if (quad === undefined) reason = 'it has no box on screen (hidden, or empty)';
        else {
          const point = whole(centre(quad));
          const hit = await this.callOn<Readiness>(window, backendNodeId, HIT_TEST, [point.x, point.y]);
          if (hit.ok) return point;
          reason = hit.reason;
        }
      } else reason = state.reason;
      if (Date.now() >= deadline) throw notActionable(`node ${backendNodeId} cannot take the action: ${reason}`);
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())), operation.signal);
    }
  }

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    if (ref.id === ROOT_ID) {
      const window = this.requireWindow();
      if (action.kind === 'scrollIntoView') return;
      if (action.kind !== 'swipe') throw notActionable(`the window takes swipe and scrollIntoView only, not ${action.kind}; act on a node`);
      await this.bounded(operation, 'swipe', true, async () => {
        const size = await this.evaluateIn<{ width: number; height: number }>(window, '({ width: innerWidth, height: innerHeight })');
        await window.page.mouse.move(Math.round(size.width / 2), Math.round(size.height / 2));
        await this.wheel(window, action.direction, action.momentum ?? 'none', size);
      });
      await this.settle(operation);
      return;
    }
    const { window, backendNodeId } = this.bind(ref);
    // The wait for actionability ends a little before the operation does, so it reports why the node never became actionable.
    const deadline = Date.now() + Math.max(0, operation.timeoutMs - Math.min(250, operation.timeoutMs / 10));
    const { mouse, keyboard } = window.page;
    let committed = false;
    const commit = <T>(work: Promise<T>): Promise<T> => {
      committed = true;
      return work;
    };
    const label = action.kind;
    try {
      await this.bounded(operation, label, false, async () => {
        switch (action.kind) {
          case 'tap':
          case 'doubleTap':
          case 'secondaryTap':
          case 'multiTap': {
            const point = await this.actionablePoint(window, backendNodeId, operation, true, deadline);
            const clickCount = action.kind === 'doubleTap' ? 2 : action.kind === 'multiTap' ? action.count : 1;
            const modifiers = (action.modifiers ?? []).map(modifierKey);
            await commit(this.withModifiers(window, modifiers, () => mouse.click(point.x, point.y, { clickCount, button: action.kind === 'secondaryTap' ? 'right' : 'left' })));
            return;
          }
          case 'hover': {
            const point = await this.actionablePoint(window, backendNodeId, operation, false, deadline);
            await commit(mouse.move(point.x, point.y));
            return;
          }
          case 'longPress': {
            const point = await this.actionablePoint(window, backendNodeId, operation, true, deadline);
            await mouse.move(point.x, point.y);
            await commit(mouse.down());
            await sleep(action.durationMs ?? LONG_PRESS_MS, operation.signal);
            await mouse.up();
            return;
          }
          case 'focus':
            await commit(this.callOn(window, backendNodeId, FOCUS));
            return;
          case 'blur':
            await commit(this.callOn(window, backendNodeId, BLUR));
            return;
          case 'scrollIntoView': {
            const session = await this.session(window.page);
            await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => this.callOn(window, backendNodeId, SCROLL_INTO_VIEW));
            return;
          }
          case 'fill':
          case 'clear': {
            const value = action.kind === 'fill' ? action.value : '';
            await this.waitReady(window, backendNodeId, operation, CHECK_EDITABLE, deadline);
            await commit(this.callOn(window, backendNodeId, SELECT_CONTENTS));
            if (value === '') await keyboard.press('Delete');
            else await keyboard.insertText(value);
            return;
          }
          case 'check':
          case 'uncheck': {
            const want = action.kind === 'check';
            const now = await this.callOn<boolean | null>(window, backendNodeId, READ_CHECKED);
            if (now === null) throw new EngineError('UNSUPPORTED_CAPABILITY', `node ${backendNodeId} has no checked state to ${action.kind}`, { retryable: false });
            if (now === want) return;
            const point = await this.actionablePoint(window, backendNodeId, operation, true, deadline);
            await commit(mouse.click(point.x, point.y));
            if ((await this.callOn<boolean | null>(window, backendNodeId, READ_CHECKED)) !== want) {
              throw notActionable(`clicking node ${backendNodeId} did not ${action.kind} it`);
            }
            return;
          }
          case 'press': {
            const parsed = parseKey(action.key);
            if (parsed === undefined) throw new EngineError('UNSUPPORTED_CAPABILITY', `${JSON.stringify(action.key)} is not a key of the contract grammar`, { retryable: false });
            await this.waitReady(window, backendNodeId, operation, CHECK_CONNECTED, deadline);
            await commit(this.callOn(window, backendNodeId, FOCUS));
            await keyboard.press(playwrightKey(action.key));
            return;
          }
          case 'selectOption': {
            await this.waitReady(window, backendNodeId, operation, CHECK_SELECT, deadline);
            const option = typeof action.value === 'string' ? { label: action.value } : action.value;
            const outcome = await commit(this.callOn<Readiness>(window, backendNodeId, SELECT_OPTION, [option]));
            if (!outcome.ok) throw notActionable(outcome.reason);
            return;
          }
          case 'setInputFiles':
          case 'setInputFilePayloads': {
            if (action.kind === 'setInputFilePayloads') throw new EngineError('UNSUPPORTED_CAPABILITY', 'in-memory files are not supported; pass file paths', { retryable: false });
            await this.waitReady(window, backendNodeId, operation, CHECK_FILE_INPUT, deadline);
            const session = await this.session(window.page);
            await commit(session.send('DOM.setFileInputFiles', { files: action.paths.map((file) => path.resolve(this.projectRoot, file)), backendNodeId }));
            return;
          }
          case 'dragTo': {
            const target = this.bind(action.target);
            const from = await this.actionablePoint(window, backendNodeId, operation, true, deadline);
            const session = await this.session(window.page);
            await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }).catch(() => undefined);
            const { quads } = await session.send('DOM.getContentQuads', { backendNodeId: target.backendNodeId });
            const quad = quads.find((candidate) => area(candidate) > 0);
            if (quad === undefined) throw notActionable('the drop target has no box on screen');
            await commit(this.drag(window, from, whole(centre(quad))));
            return;
          }
          case 'swipe': {
            const point = await this.actionablePoint(window, backendNodeId, operation, false, deadline);
            const session = await this.session(window.page);
            const { quads } = await session.send('DOM.getContentQuads', { backendNodeId });
            const quad = quads.find((candidate) => area(candidate) > 0)!;
            const box = boxOf(quad);
            await mouse.move(point.x, point.y);
            await commit(this.wheel(window, action.direction, action.momentum ?? 'none', box));
            return;
          }
        }
      });
    } catch (cause) {
      throw translate(cause, label, committed);
    }
    await this.settle(operation);
  }

  /** Waits until a page-side check passes, for actions that need no point. */
  private async waitReady(window: AppWindow, backendNodeId: number, operation: OperationContext, check: string, deadline: number): Promise<void> {
    for (;;) {
      const state = await this.callOn<Readiness>(window, backendNodeId, check);
      if (state.ok) return;
      if (Date.now() >= deadline) throw notActionable(`node ${backendNodeId} cannot take the action: ${state.reason}`);
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())), operation.signal);
    }
  }

  private async withModifiers(window: AppWindow, modifiers: readonly string[], work: () => Promise<void>): Promise<void> {
    const { keyboard } = window.page;
    for (const modifier of modifiers) await keyboard.down(modifier);
    try {
      await work();
    } finally {
      for (const modifier of modifiers.toReversed()) await keyboard.up(modifier);
    }
  }

  private async wheel(window: AppWindow, direction: ScrollDirection, momentum: Momentum, box: { readonly width: number; readonly height: number }): Promise<void> {
    const distance = swipeDistance(direction === 'up' || direction === 'down' ? box.height : box.width, momentum);
    const [deltaX, deltaY] = wheelDelta(direction, distance);
    await window.page.mouse.wheel(deltaX, deltaY);
    await this.evaluateIn(window, NEXT_FRAME);
  }

  private async drag(window: AppWindow, from: ViewportPoint, to: ViewportPoint, durationMs?: number, signal?: AbortSignal): Promise<void> {
    const { mouse } = window.page;
    await mouse.move(from.x, from.y);
    await mouse.down();
    try {
      const steps = durationMs === undefined ? 2 : Math.max(2, Math.round(durationMs / 16));
      for (let step = 1; step <= steps; step += 1) {
        await mouse.move(Math.round(from.x + ((to.x - from.x) * step) / steps), Math.round(from.y + ((to.y - from.y) * step) / steps));
        if (durationMs !== undefined) await sleep(durationMs / steps, signal);
      }
    } finally {
      await mouse.up();
    }
  }

  async performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    const window = this.requireWindow();
    const at = whole(point);
    const { mouse } = window.page;
    await this.bounded(operation, action.kind, true, async () => {
      switch (action.kind) {
        case 'tap':
          await mouse.click(at.x, at.y);
          return;
        case 'doubleTap':
          await mouse.click(at.x, at.y, { clickCount: 2 });
          return;
        case 'secondaryTap':
          await mouse.click(at.x, at.y, { button: 'right' });
          return;
        case 'hover':
          await mouse.move(at.x, at.y);
          return;
        case 'longPress':
          await mouse.move(at.x, at.y);
          await mouse.down();
          await sleep(action.durationMs ?? LONG_PRESS_MS, operation.signal);
          await mouse.up();
          return;
        case 'dragTo':
          await this.drag(window, at, whole(action.target));
          return;
        case 'swipeTo':
          await this.drag(window, at, whole(action.target), action.durationMs ?? 300, operation.signal);
          return;
        case 'swipe': {
          await mouse.move(at.x, at.y);
          const size = await this.evaluateIn<{ width: number; height: number }>(window, '({ width: innerWidth, height: innerHeight })');
          await this.wheel(window, action.direction, action.momentum ?? 'none', size);
          return;
        }
      }
    });
    await this.settle(operation);
  }

  async typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    const window = this.requireWindow();
    await this.bounded(operation, 'keyboard.type', true, async () => {
      const editable = await this.evaluateIn<boolean>(window, FOCUSED_EDITABLE);
      if (!editable) throw notActionable('nothing that takes text has keyboard focus; tap the field first');
      if (options.replace) {
        await window.page.keyboard.press('ControlOrMeta+A');
        await window.page.keyboard.press('Delete');
      }
      await window.page.keyboard.type(text);
    });
    await this.settle(operation);
  }

  async pressKey(key: string, operation: OperationContext): Promise<void> {
    const window = this.requireWindow();
    await this.bounded(operation, 'keyboard.press', true, () => window.page.keyboard.press(playwrightKey(key)));
    await this.settle(operation);
  }

  // --- windows as tabs ---

  async switchTab(index: number, operation: OperationContext): Promise<void> {
    const window = this.openWindows()[index];
    if (window === undefined) throw notActionable(`the app has ${this.openWindows().length} windows; there is no window ${index}`);
    this.shown = window;
    await this.bounded(operation, 'switch window', false, () => window.page.bringToFront());
  }

  async closeTab(index: number, operation: OperationContext): Promise<void> {
    const window = this.openWindows()[index];
    if (window === undefined) throw notActionable(`the app has ${this.openWindows().length} windows; there is no window ${index}`);
    await this.bounded(operation, 'close window', true, () => window.page.close());
  }

  // --- what the fixture asks ---

  async windows(): Promise<readonly ElectronWindow[]> {
    const shown = this.current();
    return await Promise.all(
      this.openWindows().map(async (window, index) => ({
        index,
        title: await window.page.title().catch(() => ''),
        url: window.page.url(),
        shown: window === shown,
      })),
    );
  }

  /** Makes the first open window `which` matches the one read and acted in, waiting for it to open until the operation's deadline. */
  async useWindow(which: WindowMatcher, operation: OperationContext): Promise<ElectronWindow> {
    const deadline = Date.now() + operation.timeoutMs;
    for (;;) {
      const listed = await this.windows();
      const found = listed.find((window) => matchesWindow(window, which));
      if (found !== undefined) {
        this.shown = this.openWindows()[found.index];
        await this.shown?.page.bringToFront().catch(() => undefined);
        return { ...found, shown: true };
      }
      if (Date.now() >= deadline || operation.signal.aborted) {
        throw notActionable(`no window matches ${describeMatcher(which)}; open: ${listed.map((window) => JSON.stringify(window.title)).join(', ') || 'none'}`);
      }
      await sleep(100, operation.signal);
    }
  }

  /** Runs a function in the app's main process. */
  async evaluate<R, A>(fn: (electron: any, arg: A) => R | Promise<R>, arg: A, operation: OperationContext): Promise<R> {
    const app = this.app;
    if (app === undefined) throw new EngineError('INVALID_STATE', 'the app is not running: open it with app.open()', { retryable: false });
    return await this.bounded(operation, 'electron.evaluate', true, () => app.evaluate(fn as never, arg) as Promise<R>);
  }

  // --- pixels ---

  /** A CSS-scale screenshot of the window with the masks painted over. */
  private async capture(window: AppWindow, masks: Locator): Promise<ObservationPixels> {
    const data = new Uint8Array(await window.page.screenshot({ scale: 'css', mask: [masks], maskColor: '#000000', caret: 'hide' }));
    const size = pngSize(data);
    const css = await this.evaluateIn<number>(window, 'innerWidth');
    return { data, mediaType: 'image/png', width: size.width, height: size.height, scale: css > 0 ? size.width / css : 1 };
  }

  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const window = this.requireWindow();
    const attempt = this.attempt;
    if (attempt === undefined) throw new EngineError('INVALID_STATE', 'a screenshot is taken inside a test', { retryable: false });
    return await this.bounded(operation, 'screenshot', false, async () => {
      this.artifactCounter += 1;
      const name = `${String(this.artifactCounter).padStart(3, '0')}${label === undefined || fileLabel(label) === '' ? '' : `-${fileLabel(label)}`}.png`;
      const relative = path.posix.join('screenshots', name);
      const absolute = path.join(attempt.artifactsDir, relative);
      const raw = await this.read(window);
      const unmaskable = unmaskableCount(raw.document, raw.strings);
      if (unmaskable > 0) {
        throw new ConfigurationError('POLICY_DENIED', `the window shows ${unmaskable} password field${unmaskable === 1 ? '' : 's'} or nested document${unmaskable === 1 ? '' : 's'} inside a closed shadow root, which no mask reaches, so the screenshot is withheld`);
      }
      mkdirSync(path.dirname(absolute), { recursive: true });
      await window.page.screenshot({ path: absolute, mask: [window.page.locator(MASKED_SELECTOR)], maskColor: '#000000', caret: 'hide' });
      return relative;
    });
  }
}

function levelOf(type: string): 'error' | 'warning' | 'info' {
  return type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
}

function matchesWindow(window: ElectronWindow, which: WindowMatcher): boolean {
  if (typeof which === 'number') return window.index === which;
  const test = (pattern: string | RegExp | undefined, value: string): boolean =>
    pattern === undefined || (typeof pattern === 'string' ? value === pattern : new RegExp(pattern.source, pattern.flags).test(value));
  return test(which.title, window.title) && test(which.url, window.url);
}

function describeMatcher(which: WindowMatcher): string {
  if (typeof which === 'number') return `index ${which}`;
  return [which.title === undefined ? '' : `title ${String(which.title)}`, which.url === undefined ? '' : `url ${String(which.url)}`].filter(Boolean).join(' and ') || 'any window';
}

/** The contract's key grammar in Playwright's spelling: the same names, `Space` as the space character. */
function playwrightKey(key: string): string {
  return key === 'Space' ? ' ' : key.replace(/\+Space$/, '+ ');
}

function centre(quad: readonly number[]): ViewportPoint {
  return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
}

function boxOf(quad: readonly number[]): { readonly width: number; readonly height: number } {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function area(quad: readonly number[]): number {
  const box = boxOf(quad);
  return box.width * box.height;
}

// Page-side functions, run in the engine's isolated world with `this` bound to the node. A text node acts through its element.

const ELEMENT = 'const element = this.nodeType === 1 ? this : this.parentElement;';

const CHECK_CONNECTED = `function () { ${ELEMENT}
  if (!element || !element.isConnected) return { ok: false, reason: 'it is no longer in the document' };
  return { ok: true };
}`;

const CHECK_ENABLED = `function (enabled) { ${ELEMENT}
  if (!element || !element.isConnected) return { ok: false, reason: 'it is no longer in the document' };
  if (enabled) {
    const control = element.closest('button, input, select, textarea, fieldset, [aria-disabled]');
    if (control && (control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true')) return { ok: false, reason: 'it is disabled' };
  }
  const style = getComputedStyle(element);
  if (style.visibility !== 'visible') return { ok: false, reason: 'it is not visible' };
  return { ok: true };
}`;

const HIT_TEST = `function (x, y) { ${ELEMENT}
  if (!element || !element.isConnected) return { ok: false, reason: 'it is no longer in the document' };
  const root = element.getRootNode();
  let hit = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
  if (!hit) return { ok: false, reason: 'its centre is outside the window' };
  if (hit === element || element.contains(hit)) return { ok: true };
  if (hit.tagName === 'LABEL' && (hit.control === element || hit.contains(element))) return { ok: true };
  const what = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '');
  return { ok: false, reason: 'another element (' + what + ') would receive the click' };
}`;

const SCROLL_INTO_VIEW = `function () { ${ELEMENT}
  if (element) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}`;

const FOCUS = `function () { ${ELEMENT}
  if (!element) throw new Error('Node is detached');
  element.focus();
}`;

const BLUR = `function () { ${ELEMENT}
  if (!element) throw new Error('Node is detached');
  element.blur();
}`;

const TEXT_INPUT_TYPES = "['', 'text', 'password', 'email', 'search', 'tel', 'url', 'number']";

const CHECK_EDITABLE = `function () { ${ELEMENT}
  if (!element || !element.isConnected) return { ok: false, reason: 'it is no longer in the document' };
  const tag = element.tagName;
  const field = tag === 'TEXTAREA' || (tag === 'INPUT' && ${TEXT_INPUT_TYPES}.includes((element.getAttribute('type') || '').toLowerCase()));
  if (!field && !element.isContentEditable) return { ok: false, reason: 'it is not a text field' };
  if (element.matches(':disabled')) return { ok: false, reason: 'it is disabled' };
  if (field && element.readOnly) return { ok: false, reason: 'it is read-only' };
  return { ok: true };
}`;

const SELECT_CONTENTS = `function () { ${ELEMENT}
  element.focus();
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    element.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = element.ownerDocument.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;

const READ_CHECKED = `function () { ${ELEMENT}
  if (!element) throw new Error('Node is detached');
  if (element.tagName === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) return element.checked;
  const aria = element.getAttribute('aria-checked') ?? element.getAttribute('aria-pressed');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  return null;
}`;

const CHECK_SELECT = `function () { ${ELEMENT}
  if (!element || !element.isConnected) return { ok: false, reason: 'it is no longer in the document' };
  if (element.tagName !== 'SELECT') return { ok: false, reason: 'it is not a <select>' };
  if (element.matches(':disabled')) return { ok: false, reason: 'it is disabled' };
  return { ok: true };
}`;

const SELECT_OPTION = `function (wanted) { ${ELEMENT}
  const options = Array.from(element.options);
  const index = options.findIndex((option, at) =>
    wanted.index !== undefined ? at === wanted.index : wanted.value !== undefined ? option.value === wanted.value : option.label === wanted.label || option.text.trim() === wanted.label);
  if (index < 0) return { ok: false, reason: 'no option matches ' + JSON.stringify(wanted) + '; the options are ' + options.map((option) => JSON.stringify(option.label)).join(', ') };
  if (options[index].disabled) return { ok: false, reason: 'option ' + JSON.stringify(options[index].label) + ' is disabled' };
  element.focus();
  element.selectedIndex = index;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}`;

const CHECK_FILE_INPUT = `function () { ${ELEMENT}
  if (!element || !element.isConnected) return { ok: false, reason: 'it is no longer in the document' };
  if (element.tagName !== 'INPUT' || element.type !== 'file') return { ok: false, reason: 'it is not a file input' };
  if (element.matches(':disabled')) return { ok: false, reason: 'it is disabled' };
  return { ok: true };
}`;

const FOCUSED_EDITABLE = `(() => {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  if (!active) return false;
  if (active.tagName === 'IFRAME' || active.tagName === 'WEBVIEW') return true;
  if (active.isContentEditable) return true;
  if (active.tagName === 'TEXTAREA') return !active.readOnly && !active.disabled;
  if (active.tagName === 'INPUT') return ${TEXT_INPUT_TYPES}.includes((active.getAttribute('type') || '').toLowerCase()) && !active.readOnly && !active.disabled;
  return false;
})()`;

const NEXT_FRAME = `document.visibilityState === 'hidden' ? Promise.resolve() : new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))`;
