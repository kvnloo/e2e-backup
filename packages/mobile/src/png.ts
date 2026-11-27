/**
 * Screenshot masking policy: each secure region, rounded outward to whole
 * pixels, painted opaque black. `@e2e-dev/util` decodes, paints, and encodes
 * in one call off the JavaScript thread, whatever the PNG's color type or
 * bit depth, and writes 8-bit RGBA.
 */
import { loadNativeUtil, processPng } from '@e2e-dev/util';
import type { Rect } from './support.ts';

// Loaded with the engine, not on the first masked screenshot: a mask that
// could not run then would withhold every screenshot of a secure screen.
loadNativeUtil();

/** Paints each requested rectangle opaque black, rounding outward and clipping to the image. */
export async function maskPng(bytes: Uint8Array, rects: readonly Rect[]): Promise<Uint8Array> {
  if (rects.length === 0) return bytes;
  const boxes = rects.map((rect) => {
    const x = Math.floor(rect.x);
    const y = Math.floor(rect.y);
    return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y };
  });
  return processPng(bytes, { fill: { boxes, color: [0, 0, 0] }, output: 'png' });
}
