/**
 * Adapted from microsoft/playwright tests/page/page-screenshot.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.screenshot()` is `app.screenshot()`, read back with
 * @napi-rs/image, and a `mask` is the `toHaveScreenshot` option, compared against the same viewport with
 * boxes of the mask color painted over the masked elements. Playwright's golden images belong to
 * its own renderer setup, so a golden comparison becomes a check of the pixels it shows: a clip
 * against the same box cut from a viewport screenshot, a full page against the viewport scrolled
 * to each part of it.
 */

/*
 * Not ported:
 * - should capture blinking caret if explicitly asked for: e2e has no `caret` option; its screenshots always hide the caret.
 * - should take fullPage screenshots and mask elements outside of it: `app.screenshot` has no `mask`
 *   option; `toHaveScreenshot({ fullPage, mask })` covers the same masks below.
 * - should allow transparency: e2e has no `omitBackground` option.
 * - should render white background on jpeg file: e2e screenshots are PNG only.
 * - should produce a valid webp screenshot: e2e screenshots are PNG only.
 * - path option should detect webp: e2e has no `path` or `type` option.
 * - quality option should work for webp: e2e has no `quality` option.
 * - webp screenshots should be lossless by default: e2e screenshots are PNG only.
 * - should allow transparency with webp: e2e has no `omitBackground` option.
 * - quality option should throw for webp when out of range: e2e has no `quality` option.
 * - should work with odd clip size on Retina displays: the testbed sets no device scale factor.
 * - should work for webgl: golden only, and headless WebGL renders differently per GPU backend.
 * - path option should work: e2e has no `path` option.
 * - path option should create subdirectories: e2e has no `path` option.
 * - path option should detect jpeg: e2e has no `path` option.
 * - path option should throw for unsupported mime type: e2e has no `path` option.
 * - quality option should throw for png: e2e has no `quality` option.
 * - zero quality option should throw for png: e2e has no `quality` option.
 * - quality option should work for jpeg: e2e has no `quality` option.
 * - should prefer type over extension: e2e has no `path` or `type` option.
 * - should take fullPage screenshots during navigation: a test runs its steps one at a time, so a reload
 *   cannot run while a screenshot is taken.
 * - mask option should work with elementhandle: element handles.
 * - mask option should hide elements based on attr: e2e has no `style` option.
 * - mask option should remove elements based on attr: e2e has no `style` option.
 * - page screenshot animations (all 13 tests): e2e has no `animations` option.
 * - should throw if screenshot size is too large: Chromium takes the largest size the test uses; the
 *   error it checks is Firefox's and WebKit's.
 * - page screenshot should capture css transform: golden only, of a 3D transform with no stable pixel to check.
 * The `fullPage` option of should work while navigating and should work with Array deleted is dropped: they take the viewport.
 * should run in parallel takes its three clips one at a time: a test runs its steps one at a time.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, type Browser, type WebApp } from '@e2e-dev/web';
import { expect } from 'e2e';
import { JsColorType, Transformer } from '@napi-rs/image';
import { content, CROSS, PREFIX } from './helpers.ts';

const stored = new Set<string>();

/** One element a mask covers: a selector and its match index, inside the iframe `frame` matches when set. */
interface MaskTarget {
  readonly frame?: string;
  readonly selector: string;
  readonly index: number;
}

/** A decoded screenshot: 8-bit RGBA, rows top to bottom. */
interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The RGB or RGBA PNG at `file`, decoded to RGBA. */
function readPng(file: string): Rgba {
  const image = new Transformer(readFileSync(file));
  const { width, height, format, colorType } = image.metadataSync();
  if (format !== 'png') throw new Error(`${file} is not a PNG: the bytes are ${format}`);
  const raw = image.rawPixelsSync();
  if (colorType === JsColorType.Rgba8) return { width, height, data: raw };
  if (colorType !== JsColorType.Rgb8) throw new Error(`${file} is neither an RGB nor an RGBA PNG: color type ${colorType}`);
  const data = new Uint8Array(width * height * 4);
  for (let from = 0, to = 0; from < raw.length; from += 3, to += 4) {
    data.set(raw.subarray(from, from + 3), to);
    data[to + 3] = 255;
  }
  return { width, height, data };
}

/** The red, green, and blue of the pixel at (`x`, `y`). */
function rgb(png: Rgba, x: number, y: number): [number, number, number] {
  const offset = (y * png.width + x) * 4;
  return [png.data[offset]!, png.data[offset + 1]!, png.data[offset + 2]!];
}

/** Whether two colors are the same within `slack` per channel. */
function near(actual: readonly number[], expected: readonly number[], slack = 3): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= slack);
}

/** The pixels of `box` cut out of `png`, rounded out to whole pixels. */
function crop(png: Rgba, box: { x: number; y: number; width: number; height: number }): Buffer {
  const left = Math.floor(box.x);
  const top = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width);
  const bottom = Math.ceil(box.y + box.height);
  const rows: Uint8Array[] = [];
  for (let y = top; y < bottom; y++) rows.push(png.data.subarray((y * png.width + left) * 4, (y * png.width + right) * 4));
  return Buffer.concat(rows);
}

/** Where `toHaveScreenshot(name)` in this file reads its stored screenshot on the `web` target. */
function storedPath(name: string): string {
  return path.join(import.meta.dirname, 'screenshot.e2e.ts-snapshots', `${name}-web-${process.platform}.png`);
}

/**
 * Paints a `color` box over each of `targets`, as a `mask` would cover it, keeps the viewport as
 * the stored screenshot `name`, then takes the boxes away.
 */
async function storeMaskedReference(browser: Browser, app: WebApp, name: string, targets: readonly MaskTarget[], color = '#ff00ff'): Promise<void> {
  await browser.evaluate(`({ targets, color }) => {
    for (const { frame, selector, index } of targets) {
      const host = frame === undefined ? undefined : document.querySelector(frame);
      const origin = host === undefined ? { left: 0, top: 0 } : host.getBoundingClientRect();
      const offset = host === undefined ? { left: 0, top: 0 } : { left: host.clientLeft, top: host.clientTop };
      const element = (host === undefined ? document : host.contentDocument).querySelectorAll(selector)[index];
      const rect = element.getBoundingClientRect();
      const box = document.createElement('div');
      box.setAttribute('data-test-mask', '');
      box.style.cssText = 'position: fixed; z-index: 2147483647; pointer-events: none; margin: 0; border: 0; padding: 0;';
      box.style.left = (origin.left + offset.left + rect.left) + 'px';
      box.style.top = (origin.top + offset.top + rect.top) + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      box.style.background = color;
      document.documentElement.appendChild(box);
    }
  }`, { targets: targets.map((target) => ({ ...target })), color });
  await storeReference(app, name);
  await browser.evaluate("() => { for (const box of document.querySelectorAll('[data-test-mask]')) box.remove(); }");
}

/** Keeps the viewport, as `app.screenshot` takes it, as the stored screenshot `name` until the test ends. */
async function storeReference(app: WebApp, name: string): Promise<void> {
  const file = storedPath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  stored.add(file);
  copyFileSync(await app.screenshot(name), file);
}

/** Appends an iframe with `id` loading `url`, Playwright's `attachFrame`, once it has loaded. */
async function attachFrame(browser: Browser, id: string, url: string): Promise<void> {
  await browser.evaluate(`async ({ id, url }) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.id = id;
    document.body.appendChild(frame);
    await new Promise((x) => (frame.onload = x));
  }`, { id, url });
}

/** Adds a `<style>` with `css` to the page, Playwright's `addStyleTag({ content })`. */
async function addStyleTag(browser: Browser, css: string): Promise<void> {
  await browser.evaluate("(css) => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); }", css);
}

test.afterEach(() => {
  for (const file of stored) rmSync(file, { force: true });
  stored.clear();
});

test.describe('page screenshot', { platforms: ['web'], tags: ['playwright'] }, () => {
  test('should work', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const screenshot = readPng(await app.screenshot());
    expect([screenshot.width, screenshot.height]).toEqual([500, 500]);
    expect(rgb(screenshot, 0, 0)).toEqual([169, 169, 169]);
    expect(near(rgb(screenshot, 3, 3), [255, 204, 204])).toBe(true);
    expect(near(rgb(screenshot, 453, 453), [255, 204, 207])).toBe(true);
  });

  test('should not capture blinking caret by default', async ({ app, browser }) => {
    await browser.goto(content(`
      <link rel=stylesheet href="${CROSS}/injectedstyle.css">
      <style>
        div {
          caret-color: #000 !important;
        }
      </style>
      <div contenteditable="true"></div>
    `));
    const div = browser.locator('div');
    await div.pressSequentially('foo bar');
    const box = (await div.boundingBox())!;
    const screenshot = crop(readPng(await app.screenshot()), box);
    for (let i = 0; i < 10; ++i) {
      await new Promise((x) => setTimeout(x, 150));
      const newScreenshot = crop(readPng(await app.screenshot()), box);
      expect(newScreenshot.equals(screenshot)).toBe(true);
    }
  });

  test('should capture blinking caret in shadow dom', async ({ app, browser }) => {
    await browser.goto('/empty.html');
    await browser.evaluate(`() => {
      class CustomElementContainer extends HTMLElement {
        #shadowRoot;
        constructor() {
          super();
          this.#shadowRoot = this.attachShadow({ mode: 'open' });
          this.#shadowRoot.innerHTML = '<custom-element-input-wrapper><input type="text"/></custom-element-input-wrapper>';
        }
      }
      class CustomElementInputWrapper extends HTMLElement {
        #shadowRoot;
        constructor() {
          super();
          this.#shadowRoot = this.attachShadow({ mode: 'open' });
          this.#shadowRoot.innerHTML = '<style>:host { all: initial; }</style><slot/>';
        }
      }
      customElements.define('custom-element-input-wrapper', CustomElementInputWrapper);
      customElements.define('custom-element-container', CustomElementContainer);

      const container = document.createElement('custom-element-container');
      document.body.appendChild(container);
    }`);

    const input = browser.locator('input');
    await input.focus();

    const box = (await input.boundingBox())!;
    const screenshot = crop(readPng(await app.screenshot()), box);
    let hasDifferentScreenshots = false;
    for (let i = 0; !hasDifferentScreenshots && i < 10; ++i) {
      await new Promise((x) => setTimeout(x, 150));
      const newScreenshot = crop(readPng(await app.screenshot()), box);
      hasDifferentScreenshots = !newScreenshot.equals(screenshot);
    }
    expect(hasDifferentScreenshots).toBe(false);
  });

  test('should work for canvas', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/screenshots/canvas.html');
    const screenshot = readPng(await app.screenshot());
    expect(rgb(screenshot, 8 + 30, 8 + 30)).toEqual([0, 0, 0]);
    expect(rgb(screenshot, 8 + 120, 8 + 120)).toEqual([0, 0, 0]);
    expect(rgb(screenshot, 8 + 60, 8 + 60)).toEqual([255, 255, 255]);
    expect(rgb(screenshot, 8 + 75, 8 + 75)).toEqual([255, 255, 255]);
    expect(rgb(screenshot, 8 + 140, 8 + 140)).toEqual([255, 255, 255]);
  });

  test('should capture canvas changes', async ({ app, browser }) => {
    await browser.goto(content('<canvas></canvas>'));
    await browser.evaluate(`() => {
      const canvas = document.querySelector('canvas');
      canvas.width = 600;
      canvas.height = 600;
    }`);

    /** Draws the horizontal line of `step`, 100 pixels below the one before. */
    async function addLine(step: number): Promise<void> {
      await browser.evaluate(`(n) => {
        const canvas = document.querySelector('canvas');
        const ctx = canvas.getContext('2d');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, n * 100);
        ctx.lineTo(300, n * 100);
        ctx.stroke();
      }`, step);
    }

    /** Whether the line of `step` shows in `screenshot`: the canvas sits at the body margin, 8 pixels in. */
    function hasLine(screenshot: Rgba, step: number): boolean {
      const y = 8 + step * 100;
      return [y - 1, y].some((row) => row >= 8 && rgb(screenshot, 8 + 150, row)[0] < 200);
    }

    for (let i = 0; i < 3; i++) {
      await addLine(i);
      await new Promise((f) => setTimeout(f, 100));
      const screenshot = readPng(await app.screenshot());
      for (let step = 0; step < 3; step++) expect(hasLine(screenshot, step)).toBe(step <= i);
    }
  });

  test('should work for translateZ', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/screenshots/translateZ.html');
    const screenshot = readPng(await app.screenshot());
    expect(rgb(screenshot, 120, 120)).toEqual([255, 0, 0]);
    expect(rgb(screenshot, 175, 175)).toEqual([0, 128, 0]);
    expect(rgb(screenshot, 230, 230)).toEqual([0, 128, 0]);
    expect(rgb(screenshot, 300, 300)).toEqual([255, 255, 255]);
  });

  test('should work while navigating', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/redirectloop1.html');
    for (let i = 0; i < 10; i++) {
      const screenshot = readPng(await app.screenshot());
      expect([screenshot.width, screenshot.height]).toEqual([500, 500]);
    }
  });

  test('should work with iframe in shadow', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid-iframe-in-shadow.html');
    await expect(browser.frameLocator('iframe').locator('div').first()).toBeVisible();
    const screenshot = readPng(await app.screenshot());
    expect(near(rgb(screenshot, 3, 3), [255, 204, 204])).toBe(true);
    expect(rgb(screenshot, 400, 400)).toEqual([255, 255, 255]);
  });

  test('should not issue resize event', async ({ app, browser }) => {
    await browser.goto('/grid.html');
    await browser.evaluate("() => { window.__resized = false; window.addEventListener('resize', () => { window.__resized = true; }); }");
    await app.screenshot();
    expect(await browser.evaluate('window.__resized')).toBe(false);
  });

  test('should work with Array deleted', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    await browser.evaluate('() => { delete window.Array; }');
    const screenshot = readPng(await app.screenshot());
    expect([screenshot.width, screenshot.height]).toEqual([500, 500]);
    expect(near(rgb(screenshot, 3, 3), [255, 204, 204])).toBe(true);
  });

  test('should clip rect', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const clip = { x: 50, y: 100, width: 150, height: 100 };
    const screenshot = readPng(await app.screenshot({ clip }));
    expect([screenshot.width, screenshot.height]).toEqual([150, 100]);
    expect(crop(screenshot, { x: 0, y: 0, width: 150, height: 100 }).equals(crop(readPng(await app.screenshot()), clip))).toBe(true);
  });

  test('should clip rect with fullPage', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const clip = { x: 50, y: 100, width: 150, height: 100 };
    const unscrolled = crop(readPng(await app.screenshot()), clip);
    await browser.evaluate('() => window.scrollBy(150, 200)');
    const screenshot = readPng(await app.screenshot({ fullPage: true, clip }));
    expect([screenshot.width, screenshot.height]).toEqual([150, 100]);
    expect(crop(screenshot, { x: 0, y: 0, width: 150, height: 100 }).equals(unscrolled)).toBe(true);
  });

  test('should clip elements to the viewport', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const screenshot = readPng(await app.screenshot({ clip: { x: 50, y: 450, width: 1000, height: 100 } }));
    expect([screenshot.width, screenshot.height]).toEqual([450, 50]);
    const inside = { x: 50, y: 450, width: 450, height: 50 };
    expect(crop(screenshot, { x: 0, y: 0, width: 450, height: 50 }).equals(crop(readPng(await app.screenshot()), inside))).toBe(true);
  });

  test('should throw on clip outside the viewport', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const error = await app.screenshot({ clip: { x: 50, y: 650, width: 100, height: 100 } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((error as Error).message).toContain('is outside the 500x500 viewport');
  });

  test('should throw on a negative clip size', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const error = await app.screenshot({ clip: { x: 50, y: 50, width: -100, height: 100 } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((error as Error).message).toContain('with a width and height above 0, got -100x100');
  });

  test('should run in parallel', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const screenshots: Rgba[] = [];
    for (let i = 0; i < 3; ++i) screenshots.push(readPng(await app.screenshot({ clip: { x: 50 * i, y: 0, width: 50, height: 50 } })));
    const viewport = readPng(await app.screenshot());
    for (const [i, screenshot] of screenshots.entries()) {
      expect(crop(screenshot, { x: 0, y: 0, width: 50, height: 50 }).equals(crop(viewport, { x: 50 * i, y: 0, width: 50, height: 50 }))).toBe(true);
    }
  });

  test('should take fullPage screenshots', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const height = Number(await browser.evaluate('() => document.documentElement.scrollHeight'));
    expect(height).toBeGreaterThan(500);
    const screenshot = readPng(await app.screenshot({ fullPage: true }));
    expect([screenshot.width, screenshot.height]).toEqual([500, height]);
    for (const top of [0, height - 500]) {
      await browser.evaluate(`() => window.scrollTo(0, ${top})`);
      const shown = { x: 0, y: top, width: 500, height: 500 };
      expect(crop(screenshot, shown).equals(crop(readPng(await app.screenshot()), { ...shown, y: 0 }))).toBe(true);
    }
  });

  test('should restore viewport after fullPage screenshot', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    await app.screenshot({ fullPage: true });
    expect(await browser.evaluate('() => [window.innerWidth, window.innerHeight]')).toEqual([500, 500]);
  });

  test.describe('mask option', () => {
    test('should work', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'mask-should-work', [{ selector: 'div', index: 5 }]);
      await expect(screen).toHaveScreenshot('mask-should-work', {
        mask: [browser.locator('div').nth(5)],
      });
    });

    test('should work with locator', async ({ app, browser }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'mask-should-work-with-locator', [{ selector: 'div', index: 5 }]);
      const bodyLocator = browser.locator('body');
      await expect(bodyLocator).toHaveScreenshot('mask-should-work-with-locator', {
        mask: [browser.locator('div').nth(5)],
      });
    });

    test('should mask multiple elements', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'should-mask-multiple-elements', [{ selector: 'div', index: 5 }, { selector: 'div', index: 12 }]);
      await expect(screen).toHaveScreenshot('should-mask-multiple-elements', {
        mask: [
          browser.locator('div').nth(5),
          browser.locator('div').nth(12),
        ],
      });
    });

    test('should mask inside iframe', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await attachFrame(browser, 'frame1', `${PREFIX}/grid.html`);
      await addStyleTag(browser, 'iframe { border: none; }');
      await storeMaskedReference(browser, app, 'should-mask-inside-iframe', [{ selector: 'div', index: 5 }, { frame: '#frame1', selector: 'div', index: 12 }]);
      await expect(screen).toHaveScreenshot('should-mask-inside-iframe', {
        mask: [
          browser.locator('div').nth(5),
          browser.frameLocator('#frame1').locator('div').nth(12),
        ],
      });
    });

    test('should mask in parallel', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/empty.html');
      await attachFrame(browser, 'frame1', `${PREFIX}/grid.html`);
      await attachFrame(browser, 'frame2', `${PREFIX}/grid.html`);
      await addStyleTag(browser, 'iframe { border: none; }');
      await storeMaskedReference(browser, app, 'should-mask-in-parallel-1', [{ frame: '#frame1', selector: 'div', index: 1 }]);
      await storeMaskedReference(browser, app, 'should-mask-in-parallel-2', [{ frame: '#frame2', selector: 'div', index: 3 }]);
      const results = await Promise.allSettled([
        expect(screen).toHaveScreenshot('should-mask-in-parallel-1', {
          mask: [browser.frameLocator('#frame1').locator('div').nth(1)],
        }),
        expect(screen).toHaveScreenshot('should-mask-in-parallel-2', {
          mask: [browser.frameLocator('#frame2').locator('div').nth(3)],
        }),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });

    test('should remove mask after screenshot', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      const screenshot1 = readFileSync(await app.screenshot());
      await storeMaskedReference(browser, app, 'should-remove-mask-after-screenshot', [{ selector: 'div', index: 1 }]);
      await expect(screen).toHaveScreenshot('should-remove-mask-after-screenshot', {
        mask: [browser.locator('div').nth(1)],
      });
      const screenshot2 = readFileSync(await app.screenshot());
      expect(screenshot1.equals(screenshot2)).toBe(true);
    });

    test('should work when subframe has stalled navigation', async ({ app, browser, screen }) => {
      let routed!: () => void;
      const routeReady = new Promise<void>((f) => (routed = f));
      let release!: () => void;
      const released = new Promise<void>((f) => (release = f));
      await browser.route('**/subframe.html', async (route) => {
        routed();
        await released;
        await route.fulfill({ body: '' });
      });

      await browser.goto(content('<iframe></iframe>'));
      await storeReference(app, 'mask-stalled-subframe');
      await browser.goto(content(`<iframe src='/subframe.html'></iframe>`), { waitUntil: 'domcontentloaded' });
      await routeReady;

      await expect(screen).toHaveScreenshot('mask-stalled-subframe', { mask: [browser.locator('non-existent')] });
      release();
      await expect(browser.frameLocator('iframe').locator('body')).toBeAttached();
    });

    test('should work when subframe used document.open after a weird url', async ({ app, browser, screen }) => {
      await browser.goto('/empty.html');
      await browser.evaluate(`() => {
        const iframe = document.createElement('iframe');
        iframe.src = 'javascript:hi';
        document.body.appendChild(iframe);
        iframe.contentDocument.open();
        iframe.contentDocument.write('Hello');
        iframe.contentDocument.close();
      }`);
      await storeReference(app, 'mask-document-open');
      await expect(screen).toHaveScreenshot('mask-document-open', { mask: [browser.locator('non-existent')] });
    });

    test('should work when mask color is not pink #F0F', async ({ app, browser, screen }) => {
      await browser.setViewport({ width: 500, height: 500 });
      await browser.goto('/grid.html');
      await storeMaskedReference(browser, app, 'mask-color-should-work', [{ selector: 'div', index: 5 }], '#00ff00');
      await expect(screen).toHaveScreenshot('mask-color-should-work', {
        mask: [browser.locator('div').nth(5)],
        maskColor: '#00FF00',
      });
    });
  });
});

test.describe('full page screenshot', { platforms: ['web'] }, () => {
  test('masks a password field below the viewport', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto(content(`
      <style>body { margin: 0; } input { position: absolute; top: 900px; left: 0; width: 200px; height: 40px; background: white; border: 0; }</style>
      <div style="height: 1200px;"></div>
      <input type="password" value="hunter2">
    `));
    const screenshot = readPng(await app.screenshot({ fullPage: true }));
    expect(screenshot.height).toBe(1200);
    expect(rgb(screenshot, 100, 920)).toEqual([0, 0, 0]);
    expect(rgb(screenshot, 100, 960)).toEqual([255, 255, 255]);
  });

  test('compares the whole page, masks where they sit on it however far it is scrolled', async ({ app, browser, screen }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    // The boxes take the page's own coordinates, so the reference holds wherever the page is scrolled.
    await browser.evaluate(`() => {
      for (const index of [5, 144]) {
        const rect = document.querySelectorAll('.box')[index].getBoundingClientRect();
        const box = document.createElement('div');
        box.setAttribute('data-test-mask', '');
        box.style.cssText = 'position: absolute; z-index: 2147483647; background: #ff00ff;';
        box.style.left = (rect.left + window.scrollX) + 'px';
        box.style.top = (rect.top + window.scrollY) + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        document.documentElement.appendChild(box);
      }
    }`);
    const file = storedPath('full-page-masks');
    mkdirSync(path.dirname(file), { recursive: true });
    stored.add(file);
    copyFileSync(await app.screenshot({ fullPage: true }), file);
    await browser.evaluate("() => { for (const box of document.querySelectorAll('[data-test-mask]')) box.remove(); }");
    await browser.evaluate('() => window.scrollTo(0, 300)');
    await expect(screen).toHaveScreenshot('full-page-masks', {
      fullPage: true,
      mask: [browser.locator('.box').nth(5), browser.locator('.box').nth(144)],
    });
  });

  test('refuses a clip past the end of the page', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const error = await app.screenshot({ fullPage: true, clip: { x: 0, y: 100_000, width: 10, height: 10 } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((error as Error).message).toContain('is outside the page');
  });

  test('compares a clip of the page below the viewport', async ({ app, browser, screen }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const clip = { x: 50, y: 700, width: 200, height: 100 };
    const file = storedPath('full-page-clip');
    mkdirSync(path.dirname(file), { recursive: true });
    stored.add(file);
    copyFileSync(await app.screenshot({ fullPage: true, clip }), file);
    await expect(screen).toHaveScreenshot('full-page-clip', { fullPage: true, clip });
    expect(await browser.evaluate('() => window.scrollY')).toBe(0);
  });
});

test('should capture css box-shadow', { platforms: ['web'], tags: ['playwright'] }, async ({ app, browser }) => {
  await browser.goto(content(`<div style="box-shadow: red 10px 10px 10px; width: 50px; height: 50px;"></div>`));
  const screenshot = readPng(await app.screenshot());
  expect(rgb(screenshot, 30, 30)).toEqual([255, 255, 255]);
  expect(rgb(screenshot, 62, 40)[0]).toBe(255);
  expect(rgb(screenshot, 62, 40)[1]).toBeLessThan(200);
  expect(rgb(screenshot, 100, 100)).toEqual([255, 255, 255]);
});

test.describe('locator screenshot', { platforms: ['web'] }, () => {
  test('captures the match and nothing around it', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const box = browser.locator('.box').nth(13);
    const rect = (await box.boundingBox())!;
    const shot = readPng(await box.screenshot('box'));
    expect([shot.width, shot.height]).toEqual([50, 50]);
    expect(crop(shot, { x: 0, y: 0, width: 50, height: 50 }).equals(crop(readPng(await app.screenshot()), rect))).toBe(true);
  });

  test('scrolls a match below the viewport into view first', async ({ app, browser }) => {
    await browser.setViewport({ width: 500, height: 500 });
    await browser.goto('/grid.html');
    const last = browser.locator('.box').last();
    const shot = readPng(await last.screenshot());
    expect([shot.width, shot.height]).toEqual([50, 50]);
    expect(await browser.evaluate('() => window.scrollY')).toBeGreaterThan(0);
    expect(crop(shot, { x: 0, y: 0, width: 50, height: 50 }).equals(crop(readPng(await app.screenshot()), (await last.boundingBox())!))).toBe(true);
  });
});
