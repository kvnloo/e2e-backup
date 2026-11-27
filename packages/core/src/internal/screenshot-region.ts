/**
 * The part of the screen a screenshot keeps, as `app.screenshot()` and
 * `toHaveScreenshot` take it, and the cut of an engine's screenshot file,
 * which `locator.screenshot()` shares.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { describeValue } from '../config/validate.ts';
import { ConfigurationError, isE2EError, TestError } from './errors.ts';
import { clipBox, cropImage, decodePng, encodePng, type ImageBox, type RgbaImage } from './image.ts';
import { isPlainObject, rejectUnknownOptions } from './options.ts';

const CLIP_KEYS = ['x', 'y', 'width', 'height'] as const;

/** The part of the screen a screenshot keeps: the viewport or the whole page, cut to a clip when there is one. */
export interface ScreenshotRegion {
  readonly fullPage: boolean;
  /** In CSS pixels from the viewport's top-left corner, or the page's with `fullPage`. */
  readonly clip: ImageBox | undefined;
}

/** The `fullPage` and `clip` options of `api`, checked; `INVALID_ARGUMENT` before anything is captured. */
export function parseScreenshotRegion(api: string, options: { readonly fullPage?: unknown; readonly clip?: unknown } | undefined): ScreenshotRegion {
  return { fullPage: parseFullPage(api, options?.fullPage), clip: parseClip(api, options?.clip) };
}

/** A clip of the viewport with nothing of the viewport inside it, which no wait can fix. */
export function clipOutsideViewport(api: string, clip: ImageBox, viewport: { readonly width: number; readonly height: number }): TestError {
  return new TestError(
    'INVALID_ARGUMENT',
    `${api} clip ${describeClip(clip)} is outside the ${viewport.width}x${viewport.height} viewport; measure it from the viewport's top-left corner, or pass fullPage to measure it from the page's`,
  );
}

/** The `fullPage` option: a boolean, false when left out. */
function parseFullPage(api: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TestError('INVALID_ARGUMENT', `${api} option fullPage must be a boolean, got ${describeValue(value)}`);
  return value;
}

/** The `clip` option: `{ x, y, width, height }` in finite CSS pixels, with a width and height above 0. */
function parseClip(api: string, value: unknown): ImageBox | undefined {
  if (value === undefined) return undefined;
  const shape = `${api} option clip must be { x, y, width, height } in CSS pixels, with a width and height above 0`;
  if (!isPlainObject(value)) throw new TestError('INVALID_ARGUMENT', `${shape}, got ${describeValue(value)}`);
  rejectUnknownOptions(`${api} option clip`, value, CLIP_KEYS);
  const { x, y, width, height } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    throw new TestError('INVALID_ARGUMENT', shape);
  }
  if (width <= 0 || height <= 0) throw new TestError('INVALID_ARGUMENT', `${shape}, got ${width}x${height}`);
  return { x, y, width, height };
}

/** A clip as a step label or a failure names it. */
export function describeClip(clip: ImageBox): string {
  return `{ x: ${clip.x}, y: ${clip.y}, width: ${clip.width}, height: ${clip.height} }`;
}

/**
 * Cuts the engine's screenshot at `file` to `box`, in the CSS pixels of a
 * viewport `viewportWidth` wide, at the screenshot's own pixel density, and
 * rewrites the file. Returns false, leaving the file as it was, when none of
 * the box is in the image. `api` names the caller when the engine's
 * screenshot is not a PNG.
 */
export function cutScreenshotFile(file: string, viewportWidth: number, box: ImageBox, api: string): boolean {
  const image = decodeScreenshot(file, api);
  // One scale for both axes, from the width, as the engines place their own masks.
  const scale = image.width / viewportWidth;
  const kept = clipBox(image, { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale });
  if (kept === undefined) return false;
  writeFileSync(file, encodePng(cropImage(image, kept)));
  return true;
}

/** An engine's screenshot as pixels, for `api` to cut. An engine may write another format, which a plain `app.screenshot()` passes on and a cut cannot read. */
function decodeScreenshot(file: string, api: string): RgbaImage {
  const bytes = readFileSync(file);
  try {
    return decodePng(bytes);
  } catch (cause) {
    if (isE2EError(cause)) throw cause;
    throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `${api} cuts a PNG of the viewport, and this engine's screenshot is not one`, { cause });
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
