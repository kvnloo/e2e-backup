/** Sizes the addon refuses before it allocates anything: a failed allocation would abort the process it runs in. */

import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, NativeImage, processPng } from '../src/index.ts';
import * as reference from './reference.ts';

/** A valid 1x1 PNG whose header states `width` by `height` instead. */
function claiming(width: number, height: number): Uint8Array {
  const png = Buffer.from(reference.encodePng({ width: 1, height: 1, data: new Uint8Array(4) }));
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

describe('limits', () => {
  it('rejects a PNG whose header asks for more than an image may hold, without allocating it', async () => {
    await expect(decodePng(claiming(40_000, 40_000))).rejects.toThrow('MiB an image may hold');
    await expect(processPng(claiming(40_000, 40_000), { output: 'png' })).rejects.toThrow('MiB an image may hold');
  });

  it('rejects a resize to more than an image may hold, and a size that is not whole pixels in range', async () => {
    const png = reference.encodePng({ width: 1, height: 1, data: new Uint8Array(4) });
    await expect(processPng(png, { resize: { width: 100_000, height: 100_000 }, output: 'image' })).rejects.toThrow('MiB an image may hold');
    for (const width of [2 ** 32 + 1, 0, -1, 1.5, Number.NaN]) {
      await expect(processPng(png, { resize: { width, height: 1 }, output: 'image' })).rejects.toThrow('whole pixels');
      expect(() => NativeImage.fromRgba(new Uint8Array(4), width, 1)).toThrow('whole pixels');
    }
  });
});
