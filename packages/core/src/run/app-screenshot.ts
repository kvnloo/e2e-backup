/** `app.screenshot()`: the engine's screenshot of the viewport or the whole page, cut to a clip when the call gives one. */

import { rmSync } from 'node:fs';
import path from 'node:path';
import { describeValue } from '../config/validate.ts';
import { TestError } from '../internal/errors.ts';
import { isPlainObject, rejectUnknownOptions } from '../internal/options.ts';
import { clipOutsideViewport, cutScreenshotFile, describeClip, parseScreenshotRegion, type ScreenshotRegion } from '../internal/screenshot-region.ts';
import type { LocatorEngine } from '../locator/engine.ts';

/** One checked `app.screenshot()` call. */
export interface AppScreenshotCall {
  readonly label: string | undefined;
  readonly region: ScreenshotRegion;
}

const API = 'app.screenshot()';
const OPTION_KEYS = ['fullPage', 'clip'] as const;

/** Checks the arguments of `app.screenshot(label?, options?)` or `app.screenshot(options)`; `INVALID_ARGUMENT` before anything is captured. */
export function parseAppScreenshotCall(labelOrOptions: unknown, maybeOptions: unknown): AppScreenshotCall {
  const label = typeof labelOrOptions === 'string' ? labelOrOptions : undefined;
  if (label === undefined && labelOrOptions !== undefined && maybeOptions !== undefined) {
    throw new TestError('INVALID_ARGUMENT', `${API} takes its options once: as the first argument, or after a label`);
  }
  const given = label === undefined && labelOrOptions !== undefined ? labelOrOptions : maybeOptions;
  let options: Record<string, unknown> | undefined;
  if (given !== undefined) {
    if (!isPlainObject(given)) throw new TestError('INVALID_ARGUMENT', `${API} takes a label for the file's name, options, or both, got ${describeValue(given)}`);
    options = given;
  }
  rejectUnknownOptions(API, options, OPTION_KEYS);
  return { label, region: parseScreenshotRegion(API, options) };
}

/** The step label of a call: its label, then what part of the screen it keeps when that is not the viewport. */
export function describeAppScreenshot({ label, region }: AppScreenshotCall): string {
  const parts = [
    ...(label === undefined ? [] : [label]),
    ...(region.fullPage ? ['full page'] : []),
    ...(region.clip === undefined ? [] : [`clip ${describeClip(region.clip)}`]),
  ];
  return parts.join(', ');
}

/**
 * Captures one `app.screenshot()` call and returns the file's path relative
 * to `artifactsDir`, as the engine named it. A full page, clipped or not, is
 * the engine's to capture. A clip of the viewport is cut here from the
 * engine's screenshot, at the screenshot's own pixel density, so it works on
 * every engine; the file never outlives a call that failed to cut it.
 */
export async function captureAppScreenshot(engine: LocatorEngine, artifactsDir: string, { label, region }: AppScreenshotCall): Promise<string> {
  const { fullPage, clip } = region;
  const { artifacts } = engine.session;
  if (fullPage) return artifacts.screenshot(label, engine.operation(), { fullPage: true, ...(clip === undefined ? {} : { clip }) });
  if (clip === undefined) return artifacts.screenshot(label, engine.operation());
  const deadline = engine.deadline();
  const viewport = await engine.viewport(deadline);
  const relative = await artifacts.screenshot(label, engine.operationWithin(deadline));
  const file = path.join(artifactsDir, relative);
  let kept = false;
  try {
    if (!cutScreenshotFile(file, viewport.width, clip, `${API} with a clip`)) throw clipOutsideViewport(API, clip, viewport);
    kept = true;
    return relative;
  } finally {
    if (!kept) rmSync(file, { force: true });
  }
}
