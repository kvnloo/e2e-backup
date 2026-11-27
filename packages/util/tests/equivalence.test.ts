/**
 * The addon against the JavaScript it replaces (`tests/reference.ts`), on
 * every PNG the repository tracks and on generated inputs: the same pixels,
 * the same counts, and the same diff pictures, byte for byte.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, NativeImage, pngSize, processPng, type ImageBox } from '../src/index.ts';
import * as reference from './reference.ts';
import { writePng, type PngSpec } from './png-writer.ts';
import { below, random } from './random.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const TRACKED = execFileSync('git', ['ls-files', '*.png'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const PNGS = TRACKED.map((file) => ({ file, bytes: new Uint8Array(readFileSync(path.join(ROOT, file))) }));

/** Whether two byte arrays hold the same bytes; `toEqual` on megabytes prints megabytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

/** The images the repository tracks, decoded by the reference, largest last so a failure shows on a small one first. */
const DECODED = PNGS.map(({ file, bytes }) => ({ file, bytes, image: reference.decodePng(bytes) })).toSorted((a, b) => a.image.data.length - b.image.data.length);

/** A random RGBA image; `opaque` keeps alpha at 255, as most screenshots have it. */
function noise(seed: number, width: number, height: number, opaque: boolean): reference.RgbaImage {
  const next = random(seed);
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 1) data[at] = opaque && at % 4 === 3 ? 255 : below(next, 256);
  return { width, height, data };
}

/** Changes a share of the pixels by up to `amount` per channel, and a few alphas when `alpha` is set. */
function perturb(image: reference.RgbaImage, seed: number, share: number, amount: number, alpha: boolean): reference.RgbaImage {
  const next = random(seed);
  const data = new Uint8Array(image.data);
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    if (next() >= share) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const at = pixel * 4 + channel;
      data[at] = Math.max(0, Math.min(255, data[at]! + below(next, 2 * amount + 1) - amount));
    }
    if (alpha && next() < 0.3) data[pixel * 4 + 3] = below(next, 256);
  }
  return { width: image.width, height: image.height, data };
}

/** The image moved `dx` pixels right, the uncovered column repeated: edges land one pixel over, as anti-aliasing does. */
function shift(image: reference.RgbaImage, dx: number): reference.RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const from = (y * image.width + Math.max(0, x - dx)) * 4;
      data.set(image.data.subarray(from, from + 4), (y * image.width + x) * 4);
    }
  }
  return { width: image.width, height: image.height, data };
}

describe('decoding', () => {
  it(`decodes every PNG the repository tracks (${PNGS.length}) to the reference's pixels`, async () => {
    expect(PNGS.length).toBeGreaterThan(10);
    for (const { file, bytes, image } of DECODED) {
      const native = await decodePng(bytes);
      expect([native.width, native.height], file).toEqual([image.width, image.height]);
      expect(same(native.pixels(), image.data), file).toBe(true);
      expect(pngSize(bytes), file).toEqual({ width: image.width, height: image.height });
    }
  });

  it('decodes every color type, bit depth, palette, transparent color, and interlacing to the reference\'s pixels', async () => {
    const next = random(7);
    const cases: PngSpec[] = [];
    const sizes = [[1, 1], [3, 2], [9, 7], [17, 5]] as const;
    const depths: Record<PngSpec['colorType'], readonly PngSpec['bitDepth'][]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const;
    for (const colorType of [0, 2, 3, 4, 6] as const) {
      for (const bitDepth of depths[colorType]) {
        for (const [width, height] of sizes) {
          for (const interlaced of [false, true]) {
            for (const withTransparent of colorType === 4 || colorType === 6 ? [false] : [false, true]) {
              const max = colorType === 3 ? Math.min(2 ** bitDepth, 6) : 2 ** bitDepth;
              const samples = Array.from({ length: width * height * channels[colorType] }, () => below(next, max));
              const palette = colorType === 3 ? Array.from({ length: max }, () => [below(next, 256), below(next, 256), below(next, 256)] as const) : undefined;
              let transparent: number[] | undefined;
              if (withTransparent) {
                if (colorType === 3) transparent = Array.from({ length: max - 1 }, () => below(next, 256));
                else transparent = Array.from({ length: channels[colorType] }, (_, at) => samples[at]!);
              }
              cases.push({ width, height, colorType, bitDepth, samples, interlaced, ...(palette === undefined ? {} : { palette }), ...(transparent === undefined ? {} : { transparent }) });
            }
          }
        }
      }
    }
    for (const spec of cases) {
      const bytes = writePng(spec);
      const label = `type ${spec.colorType}, ${spec.bitDepth} bits, ${spec.width}x${spec.height}${spec.interlaced === true ? ', interlaced' : ''}${spec.transparent === undefined ? '' : ', tRNS'}`;
      const expected = reference.decodePng(bytes);
      const native = await decodePng(bytes);
      expect(same(native.pixels(), expected.data), label).toBe(true);
    }
    expect(cases.length).toBeGreaterThan(200);
  });

  it('refuses bytes that are not a PNG, as the reference does', async () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([1, 2, 3]), Buffer.from('GIF89a, not a PNG at all')]) {
      expect(() => reference.decodePng(bytes)).toThrow();
      await expect(decodePng(bytes)).rejects.toThrow();
    }
  });
});

describe('encoding', () => {
  it('writes PNGs the reference decodes to the same pixels', async () => {
    for (const { file, image } of DECODED) {
      const png = await NativeImage.fromRgba(image.data, image.width, image.height).encode();
      expect(same(reference.decodePng(png).data, image.data), file).toBe(true);
    }
  });
});

describe('resampling', () => {
  it('resamples every tracked PNG to the reference\'s pixels at the sizes callers ask for', async () => {
    for (const { file, bytes, image } of DECODED.filter((entry) => entry.image.width * entry.image.height <= 3_000_000)) {
      const long = Math.max(image.width, image.height);
      const model = Math.min(1, 768 / long);
      const sizes = [
        [Math.max(1, Math.round(image.width * model)), Math.max(1, Math.round(image.height * model))],
        [Math.max(1, Math.round(image.width / 2)), Math.max(1, Math.round(image.height / 2))],
        [Math.max(1, Math.round(image.width / 3)), Math.max(1, Math.round(image.height / 3))],
        [Math.max(1, image.width - 1), Math.max(1, image.height - 1)],
        [1, 1],
        [3, 7],
      ] as const;
      for (const [width, height] of sizes) {
        const native = await processPng(bytes, { resize: { width, height }, output: 'image' });
        expect(same(native.pixels(), reference.resampleImage(image, width, height).data), `${file} to ${width}x${height}`).toBe(true);
      }
    }
  });

  it('resamples random images, up and down, to the reference\'s pixels', async () => {
    const next = random(11);
    for (let round = 0; round < 60; round += 1) {
      const image = noise(round, 1 + below(next, 90), 1 + below(next, 90), round % 2 === 0);
      const bytes = reference.encodePng(image);
      const width = 1 + below(next, 130);
      const height = 1 + below(next, 130);
      const native = await processPng(bytes, { resize: { width, height }, output: 'image' });
      expect(same(native.pixels(), reference.resampleImage(image, width, height).data), `round ${round}`).toBe(true);
    }
  });
});

describe('cropping and painting', () => {
  it('crops and paints boxes at fractional, negative, outside, and NaN coordinates as the reference does', async () => {
    const next = random(13);
    const coordinate = (limit: number): number => {
      const pick = below(next, 6);
      if (pick === 0) return -below(next, 20) - 0.5;
      if (pick === 1) return below(next, limit) + 0.5;
      if (pick === 2) return limit + below(next, 10);
      if (pick === 3) return next() * limit;
      if (pick === 4 && next() < 0.1) return Number.NaN;
      return below(next, limit);
    };
    for (let round = 0; round < 200; round += 1) {
      const image = noise(100 + round, 1 + below(next, 60), 1 + below(next, 60), true);
      const bytes = reference.encodePng(image);
      const boxes: ImageBox[] = Array.from({ length: below(next, 5) }, () => ({ x: coordinate(image.width), y: coordinate(image.height), width: coordinate(image.width), height: coordinate(image.height) }));
      const color = [below(next, 256), below(next, 256), below(next, 256)] as const;
      const crop: ImageBox = { x: coordinate(image.width), y: coordinate(image.height), width: coordinate(image.width) + 1, height: coordinate(image.height) + 1 };
      const clipped = reference.clipBox(image, crop);
      const expected = clipped === undefined ? undefined : reference.fillBoxes(reference.cropImage(image, clipped), boxes, color);
      const run = processPng(bytes, { crop, fill: { boxes, color }, output: 'image' });
      if (expected === undefined) {
        await expect(run, `round ${round}`).rejects.toThrow('no pixels inside');
        continue;
      }
      const native = await run;
      expect([native.width, native.height], `round ${round}`).toEqual([expected.width, expected.height]);
      expect(same(native.pixels(), expected.data), `round ${round}`).toBe(true);
    }
  });
});

describe('comparing', () => {
  const thresholds = [0, 0.01, 0.05, 0.1, 0.2, 0.5];
  const tolerance = (threshold: number) => ({ threshold, maxDiffPixels: undefined, maxDiffPixelRatio: undefined });

  /** Compares one pair on both sides at every threshold: the count, the verdict, and the diff picture. */
  async function check(label: string, expected: reference.RgbaImage, actual: reference.RgbaImage): Promise<void> {
    const left = NativeImage.fromRgba(expected.data, expected.width, expected.height);
    const right = NativeImage.fromRgba(actual.data, actual.width, actual.height);
    for (const threshold of thresholds) {
      expect(await left.compare(right, tolerance(threshold)), `${label} at ${threshold}`).toEqual(reference.compareImages(expected, actual, tolerance(threshold)));
      const diff = await left.diff(right, threshold);
      expect(same(diff.pixels(), reference.diffImage(expected, actual, threshold).data), `${label} diff at ${threshold}`).toBe(true);
    }
  }

  it('counts and draws the difference of tracked screenshots and their perturbed, shifted, and translucent copies as pixelmatch does', async () => {
    const screenshots = DECODED.filter((entry) => entry.image.width * entry.image.height <= 1_500_000);
    for (const [index, { file, image }] of screenshots.entries()) {
      await check(`${file} itself`, image, image);
      await check(`${file} perturbed`, image, perturb(image, index, 0.02, 30, false));
      await check(`${file} shifted`, image, shift(image, 1));
      await check(`${file} translucent`, image, perturb(image, index + 1000, 0.05, 5, true));
    }
  });

  it('counts and draws the difference of random images, opaque and translucent, as pixelmatch does', async () => {
    for (let round = 0; round < 40; round += 1) {
      const opaque = round % 2 === 0;
      const image = noise(500 + round, 32 + round, 24, opaque);
      await check(`noise ${round}`, image, perturb(image, round, 0.3, 4 + round, !opaque));
      await check(`noise ${round} vs other`, image, noise(900 + round, 32 + round, 24, opaque));
    }
  });

  it('applies maxDiffPixels and maxDiffPixelRatio as the reference does', async () => {
    const image = noise(1, 40, 30, true);
    const other = perturb(image, 2, 0.05, 80, false);
    const left = NativeImage.fromRgba(image.data, image.width, image.height);
    const right = NativeImage.fromRgba(other.data, other.width, other.height);
    for (const maxDiffPixels of [undefined, 0, 10, 60, 1000]) {
      for (const maxDiffPixelRatio of [undefined, 0, 0.01, 0.05, 1]) {
        const options = { threshold: 0.1, maxDiffPixels, maxDiffPixelRatio };
        expect(await left.compare(right, options), JSON.stringify(options)).toEqual(reference.compareImages(image, other, options));
      }
    }
    const small = NativeImage.fromRgba(new Uint8Array(4), 1, 1);
    expect(await left.compare(small, tolerance(0.1))).toEqual(reference.compareImages(image, { width: 1, height: 1, data: new Uint8Array(4) }, tolerance(0.1)));
  });
});
