/**
 * RGBA images a test builds or reads in JavaScript, through `@napi-rs/image`:
 * the runner hands pixels to `@e2e-dev/util` and never holds them here, so a
 * fake engine's screenshot and a check of a written PNG need their own codec.
 */

import { JsColorType, Transformer } from '@napi-rs/image';

/** An 8-bit RGBA image, rows top to bottom. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** PNG bytes of an RGBA image. */
export function encodeRgbaPng(image: RgbaImage): Uint8Array {
  return new Uint8Array(Transformer.fromRgbaPixels(image.data, image.width, image.height).pngSync());
}

/** The RGBA pixels of a PNG the runner wrote, which is always 8-bit RGBA. */
export function decodeRgbaPng(bytes: Uint8Array): RgbaImage {
  const image = new Transformer(bytes);
  const { width, height, format, colorType } = image.metadataSync();
  if (format !== 'png' || colorType !== JsColorType.Rgba8) throw new Error(`expected an 8-bit RGBA PNG, got ${format} color type ${colorType}`);
  return { width, height, data: new Uint8Array(image.rawPixelsSync()) };
}
