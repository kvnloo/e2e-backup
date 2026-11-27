/**
 * The pixel work e2e does on a step, each as the JavaScript did it
 * (`tests/reference.ts`: `@napi-rs/image` and loops on the JavaScript
 * thread) and as `@e2e-dev/util` does it, on real browser screenshots.
 */

import { decodePng, NativeImage, processPng } from '../src/index.ts';
import * as reference from '../tests/reference.ts';
import { screenshots } from '../tests/screenshots.ts';

/** One kind of work, both ways. */
export interface Case {
  readonly name: string;
  readonly when: string;
  readonly old: () => unknown;
  readonly native: () => Promise<unknown>;
}

const exact = { threshold: 0.1, maxDiffPixels: undefined, maxDiffPixelRatio: undefined };

/** Every case, with its inputs decoded once up front. */
export async function cases(): Promise<readonly Case[]> {
  const shots = new Map((await screenshots()).map(({ name, bytes }) => [name, bytes]));
  const desktop = shots.get('desktop-2560x1440')!;
  const phone = shots.get('phone-1170x2532')!;
  const decoded = reference.decodePng(desktop);
  const nativeDecoded = await decodePng(desktop);
  const stored = reference.decodePng(shots.get('desktop-1280x720')!);
  const changed = reference.decodePng(shots.get('desktop-1280x720-word')!);
  const nativeStored = NativeImage.fromRgba(stored.data, stored.width, stored.height);
  const nativeSame = NativeImage.fromRgba(stored.data, stored.width, stored.height);
  const nativeChanged = NativeImage.fromRgba(changed.data, changed.width, changed.height);
  const masks = [
    { x: 296, y: 136, width: 866, height: 38 },
    { x: 1172, y: 136, width: 72, height: 38 },
    { x: 840, y: 400, width: 120, height: 300 },
  ];
  const phoneMasks = [{ x: 60.4, y: 300.2, width: 900.7, height: 120.3 }].map((rect) => ({
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.ceil(rect.x + rect.width) - Math.floor(rect.x),
    height: Math.ceil(rect.y + rect.height) - Math.floor(rect.y),
  }));
  return [
    {
      name: 'decode 2560x1440',
      when: 'every PNG read',
      old: () => reference.decodePng(desktop),
      native: () => decodePng(desktop),
    },
    {
      name: 'encode 2560x1440',
      when: 'writing a screenshot or an attachment',
      old: () => reference.encodePng(decoded),
      native: () => nativeDecoded.encode(),
    },
    {
      name: 'model downscale 2560x1440 to 768x432',
      when: 'every agent observation with pixels (sizeForModel)',
      old: () => reference.encodePng(reference.resampleImage(reference.decodePng(desktop), 768, 432)),
      native: () => processPng(desktop, { resize: { width: 768, height: 432 }, output: 'png' }),
    },
    {
      name: 'toHaveScreenshot capture 2560x1440 to 1280x720, 3 masks',
      when: 'every toHaveScreenshot poll',
      old: () => reference.fillBoxes(reference.resampleImage(reference.decodePng(desktop), 1280, 720), masks, [255, 0, 255]),
      native: () => processPng(desktop, { resize: { width: 1280, height: 720 }, fill: { boxes: masks, color: [255, 0, 255] }, output: 'image' }),
    },
    {
      name: 'compare 1280x720, identical',
      when: 'every toHaveScreenshot poll that matches',
      old: () => reference.compareImages(stored, stored, exact),
      native: () => nativeStored.compare(nativeSame, exact),
    },
    {
      name: 'compare 1280x720, one word changed',
      when: 'every toHaveScreenshot poll that does not match yet',
      old: () => reference.compareImages(stored, changed, exact),
      native: () => nativeStored.compare(nativeChanged, exact),
    },
    {
      name: 'diff picture 1280x720 and encode',
      when: 'a toHaveScreenshot failure',
      old: () => reference.encodePng(reference.diffImage(stored, changed, 0.1)),
      native: async () => (await nativeStored.diff(nativeChanged, 0.1)).encode(),
    },
    {
      name: 'mask 1170x2532 phone screenshot',
      when: 'every masked mobile screenshot (maskPng)',
      old: () => reference.encodePng(reference.fillBoxes(reference.decodePng(phone), phoneMasks, [0, 0, 0])),
      native: () => processPng(phone, { fill: { boxes: phoneMasks, color: [0, 0, 0] }, output: 'png' }),
    },
  ];
}
