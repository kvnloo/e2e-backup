/**
 * The JavaScript `@e2e-dev/util` replaces, as `@e2e-dev/core`'s
 * `internal/image.ts` had it: `@napi-rs/image` for the codec, a box filter
 * and box painting in JavaScript, and pixelmatch 8 for comparison. The tests
 * hold the addon to it byte for byte, and the benchmarks time against it.
 */

import { endianness } from 'node:os';
import { FilterType, JsColorType, Transformer } from '@napi-rs/image';
import pixelmatch from 'pixelmatch';
import type { ImageBox, ImageComparison, ImageTolerance } from '../src/index.ts';

/** An RGBA image, 8 bits per channel, rows top to bottom. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const LITTLE_ENDIAN = endianness() === 'LE';

const LAYOUTS: Readonly<Partial<Record<JsColorType, { readonly channels: number; readonly wide: boolean }>>> = {
  [JsColorType.L8]: { channels: 1, wide: false },
  [JsColorType.La8]: { channels: 2, wide: false },
  [JsColorType.Rgba8]: { channels: 4, wide: false },
  [JsColorType.L16]: { channels: 1, wide: true },
  [JsColorType.La16]: { channels: 2, wide: true },
  [JsColorType.Rgb16]: { channels: 3, wide: true },
  [JsColorType.Rgba16]: { channels: 4, wide: true },
};

function plain(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const decoder = new Transformer(bytes);
  const { width, height, format, colorType } = decoder.metadataSync();
  if (format !== 'png') throw new Error(`not a PNG: the bytes are ${format}`);
  const rgb = colorType === JsColorType.Rgb8;
  const raw = (rgb ? decoder.opacity(1) : decoder).rawPixelsSync();
  const layout = LAYOUTS[rgb ? JsColorType.Rgba8 : colorType];
  if (layout === undefined) throw new Error(`unsupported PNG color type ${colorType}`);
  const { channels, wide } = layout;
  if (raw.length !== width * height * channels * (wide ? 2 : 1)) throw new Error('the decoded PNG pixels do not fill its size');
  const bytesOut = plain(raw);
  if (channels === 4 && !wide) return { width, height, data: bytesOut };
  return { width, height, data: spread(wide ? narrow(bytesOut) : bytesOut, channels, width * height) };
}

export function encodePng(image: RgbaImage): Uint8Array {
  return plain(Transformer.fromRgbaPixels(image.data, image.width, image.height).pngSync({ filterType: FilterType.Adaptive }));
}

function narrow(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Uint8Array(bytes.length / 2);
  for (let at = 0; at < samples.length; at += 1) samples[at] = Math.round((view.getUint16(at * 2, LITTLE_ENDIAN) * 255) / 65535);
  return samples;
}

function spread(samples: Uint8Array, channels: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4);
  const gray = channels <= 2;
  const alpha = channels === 2 || channels === 4;
  for (let pixel = 0, from = 0, to = 0; pixel < pixels; pixel += 1, from += channels, to += 4) {
    const r = samples[from]!;
    out[to] = r;
    out[to + 1] = gray ? r : samples[from + 1]!;
    out[to + 2] = gray ? r : samples[from + 2]!;
    out[to + 3] = alpha ? samples[from + channels - 1]! : 255;
  }
  return out;
}

export function resampleImage(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) return image;
  const target = new Uint8Array(width * height * 4);
  const source = image.data;
  const xRatio = image.width / width;
  const yRatio = image.height / height;
  for (let ty = 0; ty < height; ty += 1) {
    const y0 = Math.floor(ty * yRatio);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((ty + 1) * yRatio)));
    for (let tx = 0; tx < width; tx += 1) {
      const x0 = Math.floor(tx * xRatio);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((tx + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        let offset = (y * image.width + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          r += source[offset]!;
          g += source[offset + 1]!;
          b += source[offset + 2]!;
          a += source[offset + 3]!;
          offset += 4;
          count += 1;
        }
      }
      const at = (ty * width + tx) * 4;
      target[at] = Math.round(r / count);
      target[at + 1] = Math.round(g / count);
      target[at + 2] = Math.round(b / count);
      target[at + 3] = Math.round(a / count);
    }
  }
  return { width, height, data: target };
}

export function clipBox(image: Pick<RgbaImage, 'width' | 'height'>, box: ImageBox): ImageBox | undefined {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(image.width, Math.round(box.x + box.width));
  const y1 = Math.min(image.height, Math.round(box.y + box.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

export function cropImage(image: RgbaImage, box: ImageBox): RgbaImage {
  const data = new Uint8Array(box.width * box.height * 4);
  for (let row = 0; row < box.height; row += 1) {
    const from = ((box.y + row) * image.width + box.x) * 4;
    data.set(image.data.subarray(from, from + box.width * 4), row * box.width * 4);
  }
  return { width: box.width, height: box.height, data };
}

export function fillBoxes(image: RgbaImage, boxes: readonly ImageBox[], color: readonly [number, number, number]): RgbaImage {
  const data = new Uint8Array(image.data);
  for (const box of boxes) {
    const clipped = clipBox(image, box);
    if (clipped === undefined) continue;
    const row = new Uint8Array(clipped.width * 4).fill(255);
    for (let at = 0; at < row.length; at += 4) row.set(color, at);
    for (let y = clipped.y; y < clipped.y + clipped.height; y += 1) data.set(row, (y * image.width + clipped.x) * 4);
  }
  return { width: image.width, height: image.height, data };
}

export function compareImages(expected: RgbaImage, actual: RgbaImage, tolerance: ImageTolerance): ImageComparison {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      kind: 'size',
      expected: { x: 0, y: 0, width: expected.width, height: expected.height },
      actual: { x: 0, y: 0, width: actual.width, height: actual.height },
    };
  }
  const { width, height } = expected;
  const diffPixels = pixelmatch(expected.data, actual.data, null, width, height, { threshold: tolerance.threshold });
  const total = width * height;
  const byRatio = tolerance.maxDiffPixelRatio === undefined ? undefined : total * tolerance.maxDiffPixelRatio;
  const allowed =
    tolerance.maxDiffPixels !== undefined && byRatio !== undefined
      ? Math.min(tolerance.maxDiffPixels, byRatio)
      : (tolerance.maxDiffPixels ?? byRatio ?? 0);
  if (diffPixels <= allowed) return { kind: 'match', diffPixels };
  return { kind: 'pixels', diffPixels, ratio: total === 0 ? 0 : diffPixels / total };
}

export function diffImage(expected: RgbaImage, actual: RgbaImage, threshold: number): RgbaImage {
  const { width, height } = expected;
  const data = new Uint8Array(width * height * 4);
  pixelmatch(expected.data, actual.data, data, width, height, { threshold });
  return { width, height, data };
}
