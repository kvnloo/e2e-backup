/** Shared helpers for the agent-device engine: error constructors, filenames, PNG headers, gestures, the screen location and size. */

import type { AppDeployResult, CaptureScreenshotResult, PressOptions } from 'agent-device';
import { EngineError, SCROLL_STEP, withTimeout, type ScrollDirection, type ViewportSize } from '@e2e-dev/core/engine';
import type { AgentDeviceClient } from './options.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Whether a point lies inside a rect, edges included. */
export function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * A scroll container's box, and whether agent-device reports content hidden
 * above or below it.
 */
export interface ScrollBox extends Rect {
  readonly hiddenAbove: boolean;
  readonly hiddenBelow: boolean;
}

export function cancelled(text: string): EngineError {
  return new EngineError('CANCELLED', text, { retryable: false });
}

/**
 * The least time an input gets to answer once sent, however little budget
 * was left: a tap that lands is then not reported as cut off.
 */
const MIN_ANSWER_MS = 250;

/**
 * One operation's budget (its `timeoutMs`), which the harness signal does not
 * enforce. Every device command the operation sends runs under it: the
 * inputs through `send`, the snapshots and screenshots through `read`.
 */
export class InputBudget {
  private readonly endsAt: number;
  private sent = false;

  /**
   * `track` keeps the SDK request in flight, past a timeout that abandons
   * it, until its promise settles. Cancellation can settle that promise
   * before already accepted native work ends.
   */
  constructor(
    private readonly label: string,
    timeoutMs: number,
    private readonly track: <T>(pending: Promise<T>) => Promise<T>,
    private readonly signal: AbortSignal,
  ) {
    this.endsAt = Date.now() + timeoutMs;
  }

  /**
   * Press requests receive caller cancellation and are cancelled when this
   * wait expires, including its existing acknowledgement allowance.
   */
  press(client: AgentDeviceClient, options: PressOptions): Promise<unknown> {
    return this.send((signal) => client.interactions.press({ ...options, signal }));
  }

  /**
   * Sends one input with what is left of the budget. With none left it sends
   * nothing: `OPERATION_TIMEOUT`, or `ACTION_MAY_HAVE_COMMITTED` once an
   * earlier input of this operation went out. A gesture that holds (`holdMs`)
   * at least as long as the budget left could only be cut off mid-gesture, so
   * it is refused unsent: `NOT_ACTIONABLE`, or `ACTION_MAY_HAVE_COMMITTED`
   * once an earlier input went out. An input that does not answer in time
   * may have landed, so it is `ACTION_MAY_HAVE_COMMITTED` and the runner
   * never repeats it.
   */
  send<T>(dispatch: (signal: AbortSignal) => Promise<T>, holdMs = 0): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining <= 0) return Promise.reject(this.spent());
    if (holdMs >= remaining) {
      const left = `holds for ${holdMs} ms, but only ${Math.floor(remaining)} ms of its timeout are left`;
      return Promise.reject(
        this.sent
          ? new EngineError('ACTION_MAY_HAVE_COMMITTED', `${this.label} sent part of its input, and the next part ${left}. Raise the timeout`, { retryable: false })
          : new EngineError('NOT_ACTIONABLE', `${this.label} ${left}; raise the timeout or shorten the hold`, { retryable: false }),
      );
    }
    const answerMs = Math.max(remaining, MIN_ANSWER_MS);
    const deadline = new AbortController();
    const requestSignal = AbortSignal.any([this.signal, deadline.signal]);
    const pending = this.track(dispatch(requestSignal));
    this.sent = true;
    return withTimeout(pending, answerMs, () => {
      deadline.abort();
      return this.maybeCommitted();
    });
  }

  /**
   * Runs one device read with what is left of the budget. With none left it
   * reads nothing. A read that does not answer in time is `OPERATION_TIMEOUT`,
   * or `ACTION_MAY_HAVE_COMMITTED` once an input of this operation went out,
   * so the runner never repeats that input.
   */
  read<T>(dispatch: () => Promise<T>): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining <= 0) return Promise.reject(this.spent());
    return withTimeout(this.track(dispatch()), remaining, () =>
      this.sent
        ? this.maybeCommitted()
        : new EngineError('OPERATION_TIMEOUT', `${this.label} timed out before the device answered`, { retryable: false }),
    );
  }

  /** Whether an input of this operation went out. */
  get hasSent(): boolean {
    return this.sent;
  }

  /** Milliseconds left of the budget; zero or less once it is spent. */
  remainingMs(): number {
    return this.endsAt - Date.now();
  }

  /** The failure of a command the spent budget did not send. */
  private spent(): EngineError {
    return this.sent
      ? this.maybeCommitted()
      : new EngineError('OPERATION_TIMEOUT', `${this.label} timed out before it was sent`, { retryable: false });
  }

  private maybeCommitted(): EngineError {
    return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${this.label} timed out before the device answered; its input may have been dispatched`, {
      retryable: false,
    });
  }
}

export function invalidState(text: string): EngineError {
  return new EngineError('INVALID_STATE', text, { retryable: false });
}

export function notActionable(text: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', text, { retryable: false });
}

export function unsupported(text: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

/** Constrains a caller-supplied artifact label to a safe filename. */
export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Reads the dimensions out of a PNG's IHDR chunk; undefined for anything else. */
export function readPngSize(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  for (const [offset, byte] of PNG_SIGNATURE.entries()) {
    if (data[offset] !== byte) return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** One finger drag in logical pixels, as agent-device's `pan` takes it: where it starts and how far it travels. */
export interface Drag {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
}

/** Where a drag starts, as a share of the box in from the edge the content comes from. */
const DRAG_START = 0.25;

/**
 * Returns the drags that scroll `box`'s content in `direction` by `distance`
 * of the box, the way Appium's WebDriverAgent scrolls. Scrolling down shows
 * what is below, so the finger travels up. Each drag starts a quarter in from
 * the edge the content comes from, centred on the other axis, so it starts on
 * the content instead of a footer or tab bar along that edge. One drag
 * moves `SCROLL_STEP.distance` of the box at most, so it ends a tenth from
 * the far edge. A longer distance is split into equal drags from the same
 * start.
 */
export function swipeDrags(box: Rect, direction: ScrollDirection, distance: number): Drag[] {
  const vertical = direction === 'up' || direction === 'down';
  const extent = vertical ? box.height : box.width;
  const sign = direction === 'down' || direction === 'right' ? -1 : 1;
  const start = (vertical ? box.y : box.x) + extent * (sign < 0 ? 1 - DRAG_START : DRAG_START);
  const count = Math.ceil(distance / SCROLL_STEP.distance);
  const travel = (sign * extent * distance) / count;
  const drag = vertical
    ? { x: box.x + box.width / 2, y: start, dx: 0, dy: travel }
    : { x: start, y: box.y + box.height / 2, dx: travel, dy: 0 };
  return Array.from({ length: count }, () => drag);
}

/**
 * Returns the drags that move `rect` to the middle of `container`, or none
 * when the node stays where it is:
 *
 * - Without `center`, a node inside its container, edges included, stays. A
 *   pull-to-refresh list takes a drag on its first row as a refresh. A row
 *   flush with an edge that has content hidden past it counts as cut off,
 *   since agent-device clips a row's box to the screen.
 * - With `center`, a node also moves when its centre is more than a fifth
 *   of the container from the middle, as with Maestro's `centerElement`. A
 *   node that far out can be under a sticky header or footer. It moves only
 *   toward a side with content hidden past it, so a list at its top isn't
 *   pulled down.
 *
 * The drags are vertical only. A node in a vertical list often sits off the
 * list's horizontal middle, and a sideways drag on a row can trigger the
 * row's swipe action.
 */
export function centringDrags(rect: Rect, container: ScrollBox, center: boolean): Drag[] {
  const top = container.y;
  const bottom = container.y + container.height;
  const cutAbove = rect.y < top || (container.hiddenAbove && rect.y <= top);
  const cutBelow = rect.y + rect.height > bottom || (container.hiddenBelow && rect.y + rect.height >= bottom);
  const offset = rect.y + rect.height / 2 - (top + container.height / 2);
  const direction = offset > 0 ? 'down' : 'up';
  if (!cutAbove && !cutBelow) {
    const far = center && Math.abs(offset) > container.height / 5;
    const hidden = direction === 'down' ? container.hiddenBelow : container.hiddenAbove;
    if (!far || !hidden) return [];
  }
  return swipeDrags(container, direction, Math.abs(offset) / container.height);
}

/**
 * The location a device surface reports in a snapshot: the foreground app
 * and the screen shown, `<app> / <screen title>`. A simulator has no address
 * bar, so this is an opaque address the harness shows to the model and the
 * report and anchors trace replay on; it changes exactly when the app or its
 * screen changes. It is deliberately not a URL: no scheme, no colon, so the
 * harness never mistakes it for one and applies an origin policy to it.
 * Undefined when neither the app nor a title is known.
 */
export function screenLocation(app: string | undefined, title: string | undefined): string | undefined {
  const parts = [app, title]
    .map((part) => (part === undefined ? '' : part.replaceAll(/\s+/g, ' ').trim()))
    .filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join(' / ');
}

/** The screenshot fields a viewport probe reads off agent-device's response. */
export type RawScreenshotResult = Partial<Pick<CaptureScreenshotResult, 'path' | 'width' | 'height' | 'logicalWidth' | 'logicalHeight' | 'pixelDensity'>>;

/**
 * The device's logical screen size as its screenshot reports it, in points:
 * the logical dimensions when given, else the pixel dimensions over the
 * density. Undefined when the response carries neither.
 */
export function logicalScreenSize(
  result: RawScreenshotResult,
): ViewportSize | undefined {
  const logical =
    result.logicalWidth !== undefined && result.logicalHeight !== undefined
      ? { width: result.logicalWidth, height: result.logicalHeight }
      : result.width !== undefined && result.height !== undefined && result.pixelDensity !== undefined && result.pixelDensity > 0
        ? { width: result.width / result.pixelDensity, height: result.height / result.pixelDensity }
        : undefined;
  if (logical === undefined || logical.width <= 0 || logical.height <= 0) return undefined;
  return logical;
}

/**
 * The install fields this engine reads off agent-device's response. Its
 * `app` is left out: it echoes the `app` passed in, else the identity, else
 * the build's path, so it cannot tell an id from a file.
 */
export type InstallIdentity = Pick<AppDeployResult, 'appId' | 'bundleId' | 'package'>;

/**
 * The app an install of `build` opens by: the identity agent-device reported,
 * else the `app` it was installed as. Fails when neither names one, saying
 * to name it with `namedBy`.
 */
export function installedIdentity(result: InstallIdentity, app: string | undefined, build: string, namedBy: string): { app: string; bundleId?: string } {
  const identity = result.bundleId ?? result.package ?? result.appId;
  const opensBy = identity ?? app;
  if (opensBy === undefined) {
    throw new EngineError(
      'ENGINE_FAILURE',
      `installed ${build}, but agent-device reported no bundle id or package for it, so nothing can open it: name the app with ${namedBy}`,
      { retryable: false },
    );
  }
  return { app: opensBy, ...(identity === undefined ? {} : { bundleId: identity }) };
}
