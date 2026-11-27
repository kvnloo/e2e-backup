/**
 * `app.screenshot()` checks its label and options before it captures, cuts a
 * clip of the viewport from the engine's screenshot at its own pixel density
 * on any engine, and hands a full page, clipped or not, to an engine that
 * declares `fullPageScreenshots`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineScreenshotOptions } from '@e2e-dev/core/lib/engine/index';
import { decodePng, encodePng, type RgbaImage } from '@e2e-dev/core/lib/internal/image';
import { captureAppScreenshot, describeAppScreenshot, parseAppScreenshotCall } from '@e2e-dev/core/lib/run/app-screenshot';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const VIEWPORT = { width: 100, height: 50 };
const RED = [255, 0, 0, 255] as const;
const WHITE = [255, 255, 255, 255] as const;

let artifactsDir: string;
beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-app-screenshot-'));
  mkdirSync(path.join(artifactsDir, 'screenshots'));
});
afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

/** The viewport at `scale` image pixels per CSS pixel, white, with `box` (in CSS pixels) red. */
function screenImage(scale: number, box: { x: number; y: number; width: number; height: number }): RgbaImage {
  const width = VIEWPORT.width * scale;
  const height = VIEWPORT.height * scale;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= box.x * scale && x < (box.x + box.width) * scale && y >= box.y * scale && y < (box.y + box.height) * scale;
      data.set(inside ? RED : WHITE, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** An engine whose every screenshot is `image`, recording the options each capture was asked for. */
function engineWith(image: RgbaImage, fullPageScreenshots?: boolean) {
  const asked: (EngineScreenshotOptions | undefined)[] = [];
  const { engine } = screenOver({
    locate: () => [],
    observe: () => snapshot([], { viewport: VIEWPORT }),
    screenshot: (label, options) => {
      asked.push(options);
      const relative = `screenshots/${String(asked.length).padStart(3, '0')}${label === undefined ? '' : `-${label}`}.png`;
      writeFileSync(path.join(artifactsDir, relative), encodePng(image));
      return relative;
    },
    artifactsDir,
    timeoutMs: 2_000,
    ...(fullPageScreenshots === undefined ? {} : { fullPageScreenshots }),
  });
  return { engine, asked };
}

describe('parseAppScreenshotCall', () => {
  it('takes a label, options, or both', () => {
    expect(parseAppScreenshotCall(undefined, undefined)).toEqual({ label: undefined, region: { fullPage: false, clip: undefined } });
    expect(parseAppScreenshotCall('home', undefined)).toEqual({ label: 'home', region: { fullPage: false, clip: undefined } });
    expect(parseAppScreenshotCall({ fullPage: true }, undefined)).toEqual({ label: undefined, region: { fullPage: true, clip: undefined } });
    expect(parseAppScreenshotCall(undefined, { fullPage: true })).toEqual({ label: undefined, region: { fullPage: true, clip: undefined } });
    expect(parseAppScreenshotCall('home', { clip: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ label: 'home', region: { fullPage: false, clip: { x: 1, y: 2, width: 3, height: 4 } } });
  });

  it.each([
    ['a label that is not a string', 42, undefined, /takes a label for the file's name, options, or both/],
    ['options twice', { fullPage: true }, { fullPage: true }, /takes its options once/],
    ['an unknown option', { path: 'home.png' }, undefined, /path/],
    ['a fullPage that is not a boolean', { fullPage: 'yes' }, undefined, /fullPage must be a boolean/],
    ['a clip that is not an object', { clip: [0, 0, 10, 10] }, undefined, /clip must be \{ x, y, width, height \}/],
    ['a clip side left out', { clip: { x: 0, y: 0, width: 10 } }, undefined, /clip must be/],
    ['a clip side that is not finite', { clip: { x: 0, y: Number.NaN, width: 10, height: 10 } }, undefined, /clip must be/],
    ['an empty clip', { clip: { x: 0, y: 0, width: 0, height: 10 } }, undefined, /got 0x10/],
    ['a negative clip size', { clip: { x: 0, y: 0, width: 10, height: -1 } }, undefined, /got 10x-1/],
    ['an unknown clip key', { clip: { x: 0, y: 0, width: 10, height: 10, scale: 2 } }, undefined, /scale/],
  ])('refuses %s with INVALID_ARGUMENT', (_name, first, second, message) => {
    let thrown: unknown;
    try {
      parseAppScreenshotCall(first, second);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(message) });
  });

  it('labels the step with what part of the screen it keeps', () => {
    expect(describeAppScreenshot({ label: undefined, region: { fullPage: false, clip: undefined } })).toBe('');
    expect(describeAppScreenshot({ label: 'home', region: { fullPage: true, clip: { x: 0, y: 10, width: 20, height: 30 } } })).toBe(
      'home, full page, clip { x: 0, y: 10, width: 20, height: 30 }',
    );
  });
});

describe('captureAppScreenshot', () => {
  it('cuts a clip of the viewport at the screenshot\'s own pixel density', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    const { engine, asked } = engineWith(screenImage(2, box));
    const relative = await captureAppScreenshot(engine, artifactsDir, { label: 'card', region: { fullPage: false, clip: box } });
    expect(relative).toBe('screenshots/001-card.png');
    expect(asked).toEqual([undefined]);
    const image = decodePng(readFileSync(path.join(artifactsDir, relative)));
    expect({ width: image.width, height: image.height }).toEqual({ width: 60, height: 30 });
    expect([...image.data.subarray(0, 4)]).toEqual([...RED]);
    expect([...image.data.subarray(image.data.length - 4)]).toEqual([...RED]);
  });

  it('keeps the part of a clip inside the viewport', async () => {
    const { engine } = engineWith(screenImage(1, { x: 0, y: 0, width: 0, height: 0 }));
    const relative = await captureAppScreenshot(engine, artifactsDir, { label: undefined, region: { fullPage: false, clip: { x: 90, y: -10, width: 50, height: 20 } } });
    const image = decodePng(readFileSync(path.join(artifactsDir, relative)));
    expect({ width: image.width, height: image.height }).toEqual({ width: 10, height: 10 });
  });

  it('refuses a clip outside the viewport and keeps no file', async () => {
    const { engine } = engineWith(screenImage(1, { x: 0, y: 0, width: 0, height: 0 }));
    await expect(captureAppScreenshot(engine, artifactsDir, { label: 'far', region: { fullPage: false, clip: { x: 0, y: 400, width: 10, height: 10 } } })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/clip \{ x: 0, y: 400, width: 10, height: 10 \} is outside the 100x50 viewport; .*pass fullPage/),
    });
    expect(existsSync(path.join(artifactsDir, 'screenshots', '001-far.png'))).toBe(false);
  });

  it('hands a full page and its clip to an engine that declares fullPageScreenshots, and leaves its file as it wrote it', async () => {
    const image = screenImage(1, { x: 0, y: 0, width: 5, height: 5 });
    const { engine, asked } = engineWith(image, true);
    const clip = { x: 0, y: 300, width: 100, height: 40 };
    const relative = await captureAppScreenshot(engine, artifactsDir, { label: undefined, region: { fullPage: true, clip } });
    expect(asked).toEqual([{ fullPage: true, clip }]);
    expect(decodePng(readFileSync(path.join(artifactsDir, relative)))).toEqual(image);
    await captureAppScreenshot(engine, artifactsDir, { label: undefined, region: { fullPage: true, clip: undefined } });
    expect(asked[1]).toEqual({ fullPage: true });
  });

  it('refuses a full page on an engine that does not declare fullPageScreenshots, before it captures', async () => {
    const { engine, asked } = engineWith(screenImage(1, { x: 0, y: 0, width: 5, height: 5 }));
    await expect(captureAppScreenshot(engine, artifactsDir, { label: undefined, region: { fullPage: true, clip: undefined } })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringMatching(/cannot capture the whole page: engine fake does not declare fullPageScreenshots/),
    });
    expect(asked).toEqual([]);
  });
});
