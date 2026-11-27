/**
 * Images in e2e: PNG decoding and encoding, resampling, cropping, painting
 * boxes, and comparing two images, all done by `@e2e-dev/util` in Rust on a
 * native worker pool. Every call that touches pixels returns a Promise and
 * leaves the JavaScript thread free; a decoded image stays on the native
 * side as an `Image`.
 */

import * as util from '@e2e-dev/util';
import { InfrastructureError } from './errors.ts';

/** A decoded image, 8 bits per channel RGBA, held on the native side. */
export type Image = util.NativeImage;
export type { ImageBox, ImageComparison, ImageTolerance } from '@e2e-dev/util';
type ImageBox = util.ImageBox;

/**
 * Runs a call into `@e2e-dev/util`, turning an addon that cannot load into
 * `IMAGE_CODEC_UNAVAILABLE`. The addon loads with the first call rather than
 * when e2e loads, so a command or a test that touches no screenshot
 * (`--version`, `--help`, `doctor`) runs without it. Any other error is the
 * image's: a caller decides what bytes that are not a PNG mean.
 */
async function native<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw codecError(cause);
  }
}

/** The synchronous form of `native`. */
function nativeSync<T>(call: () => T): T {
  try {
    return call();
  } catch (cause) {
    throw codecError(cause);
  }
}

/** `IMAGE_CODEC_UNAVAILABLE` for an addon that cannot load, naming the package and the way back; anything else as it is. */
function codecError(cause: unknown): unknown {
  if (!(cause instanceof util.NativeUtilUnavailableError)) return cause;
  const reason = cause.cause instanceof Error ? cause.cause.message.split('\n', 1)[0] : cause.message;
  const fix = cause.packageName === undefined
    ? `it has no native build for ${cause.platform}`
    : cause.notInstalled
      ? `its native build for ${cause.platform} (${cause.packageName}) is not installed. npm skips it with --omit=optional, or when package-lock.json was written on another platform (npm/cli#4828): install again without --omit=optional, or delete package-lock.json and node_modules and run npm install`
      : `it could not be loaded (${reason})`;
  return new InfrastructureError('IMAGE_CODEC_UNAVAILABLE', `e2e reads and writes screenshots with @e2e-dev/util, and ${fix}`, { cause });
}

/** The width and height a PNG's header states, without decoding it; undefined when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  return nativeSync(() => util.pngSize(bytes));
}

/** Decodes PNG bytes to 8-bit RGBA: any color type, at 1 to 16 bits or with a palette; rejects anything else. */
export function decodePng(bytes: Uint8Array): Promise<Image> {
  return native(() => util.decodePng(bytes));
}

/** Encodes an image as PNG bytes, each row adaptively filtered. */
export function encodePng(image: Image): Promise<Uint8Array> {
  return native(() => image.encode());
}

/**
 * Decodes a PNG and resamples it (a box filter), crops it (the box clipped
 * to the image first), and paints boxes over it, in that order, in one call:
 * `output: 'png'` encodes the result, `output: 'image'` keeps it decoded.
 */
export function processPng(bytes: Uint8Array, steps: util.ProcessSteps & { readonly output: 'png' }): Promise<Uint8Array>;
export function processPng(bytes: Uint8Array, steps: util.ProcessSteps & { readonly output: 'image' }): Promise<Image>;
export function processPng(bytes: Uint8Array, steps: util.ProcessSteps & { readonly output: 'png' | 'image' }): Promise<Uint8Array | Image> {
  return native<Uint8Array | Image>(() => (steps.output === 'png' ? util.processPng(bytes, { ...steps, output: 'png' }) : util.processPng(bytes, { ...steps, output: 'image' })));
}

/** The part of `box` inside the image, on whole pixels; undefined when none of it is. */
export function clipBox(image: { readonly width: number; readonly height: number }, box: ImageBox): ImageBox | undefined {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(image.width, Math.round(box.x + box.width));
  const y1 = Math.min(image.height, Math.round(box.y + box.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

/**
 * Compares `actual` against `expected`. They match when they have one size
 * and at most the tolerated number of pixels differ: `maxDiffPixels`, a
 * `maxDiffPixelRatio` share of the image, the smaller of the two when both are
 * set, and none when neither is. It only counts: a caller polling for a match
 * compares many times and draws the difference once, with `diffImage`.
 */
export function compareImages(expected: Image, actual: Image, tolerance: util.ImageTolerance): Promise<util.ImageComparison> {
  return native(() => expected.compare(actual, tolerance));
}

/**
 * The picture of how two images of one size differ, for a failure to attach:
 * `expected` faded, with every pixel `compareImages` counts at `threshold`
 * painted over it.
 */
export function diffImage(expected: Image, actual: Image, threshold: number): Promise<Image> {
  return native(() => expected.diff(actual, threshold));
}
