/** Shared helpers for the agent-device engine: error constructors, filenames, PNG headers, gestures, the screen location and size. */

import type { CaptureScreenshotResult, PressOptions } from 'agent-device';
import { EngineError, withTimeout, type ScrollDirection, type ViewportSize } from '@e2e-dev/core/engine';
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
   * it is refused unsent. An input that does not answer in time may have
   * landed, so it is `ACTION_MAY_HAVE_COMMITTED` and the runner never repeats it.
   */
  send<T>(dispatch: (signal: AbortSignal) => Promise<T>, holdMs = 0): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining <= 0) return Promise.reject(this.spent());
    if (holdMs >= remaining) {
      return Promise.reject(
        new EngineError(
          'NOT_ACTIONABLE',
          `${this.label} holds for ${holdMs} ms, but only ${Math.floor(remaining)} ms of its timeout are left; raise the timeout or shorten the hold`,
          { retryable: false },
        ),
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
/** Where a drag ends at the latest, as a share of the box in from the far edge. */
const DRAG_END = 0.1;

/**
 * The drags that scroll `box`'s content `direction` by `distance` of the box,
 * as Appium's WebDriverAgent scrolls. Scrolling down reveals what is below, so
 * the finger travels up. Each drag starts a quarter in from the edge the
 * content comes from, centred on the other axis, so it starts on the content
 * and not on a footer or tab bar along that edge. It ends no closer than a
 * tenth to the far edge, so one drag moves 0.65 of the box at most. A longer
 * distance is split into equal drags from the same start.
 */
export function swipeDrags(box: Rect, direction: ScrollDirection, distance: number): Drag[] {
  const vertical = direction === 'up' || direction === 'down';
  const extent = vertical ? box.height : box.width;
  const sign = direction === 'down' || direction === 'right' ? -1 : 1;
  const start = (vertical ? box.y : box.x) + extent * (sign < 0 ? 1 - DRAG_START : DRAG_START);
  const count = Math.ceil(distance / (1 - DRAG_START - DRAG_END));
  const travel = (sign * extent * distance) / count;
  const drag = vertical
    ? { x: box.x + box.width / 2, y: start, dx: 0, dy: travel }
    : { x: start, y: box.y + box.height / 2, dx: travel, dy: 0 };
  return Array.from({ length: count }, () => drag);
}

/**
 * The drag that moves `rect` to the middle of `container`, as Maestro's
 * `centerElement` does: only when the node's centre is more than a fifth of
 * the container away from the middle, so a node in the outer part, where
 * a sticky header or footer can cover it, comes clear of it. It is vertical
 * only: a node in a vertical list often sits off the list's horizontal
 * middle, and a sideways drag on a row can set off the row's swipe action.
 */
export function centringDrag(rect: Rect, container: Rect): Drag | undefined {
  const offset = rect.y + rect.height / 2 - (container.y + container.height / 2);
  if (Math.abs(offset) <= container.height / 5) return undefined;
  return swipeDrags(container, offset > 0 ? 'down' : 'up', Math.abs(offset) / container.height)[0];
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
