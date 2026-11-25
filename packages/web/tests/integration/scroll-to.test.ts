/**
 * `scrollTo` against a real page: which container a screen and a node
 * scroll, the edges of both axes in either writing direction, smooth-scroll
 * CSS, shadow roots, content that grows at the end, and the cases where
 * nothing scrolls.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EngineError, type ScrollEdge } from '@e2e-dev/core/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
import { scrollToEdge } from '../../src/scroll-to.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
});

const ROWS = Array.from({ length: 60 }, (_, index) => `<p style="height: 40px; margin: 0">Row ${index + 1}</p>`).join('');

/** Scrolls the screen, or the node `selector` names, to `edge` within `timeoutMs`. */
function scroll(edge: ScrollEdge, selector?: string, timeoutMs = 2_000): Promise<void> {
  const operation = { timeoutMs, signal: new AbortController().signal };
  return scrollToEdge(page, selector === undefined ? undefined : { kind: 'locator', locator: page.locator(selector) }, edge, operation);
}

/** The offsets of the page and of the element `selector` names. */
function offsets(selector?: string): Promise<{ top: number; left: number; maxTop: number; maxLeft: number }> {
  return page.evaluate((query) => {
    const element = query === undefined ? document.scrollingElement! : document.querySelector(query)!;
    return {
      top: element.scrollTop,
      left: element.scrollLeft,
      maxTop: element.scrollHeight - element.clientHeight,
      maxLeft: element.scrollWidth - element.clientWidth,
    };
  }, selector);
}

describe('scrollTo on the screen', () => {
  it('scrolls the page to its bottom and back to its top', async () => {
    await page.setContent(ROWS);
    await scroll('bottom');
    const bottom = await offsets();
    expect(bottom.maxTop).toBeGreaterThan(0);
    expect(bottom.top).toBe(bottom.maxTop);
    await scroll('top');
    expect((await offsets()).top).toBe(0);
  });

  it('scrolls the pane under the viewport center when the page itself does not scroll', async () => {
    await page.setContent(`
      <body style="margin: 0; overflow: hidden">
        <header style="height: 60px">Shell</header>
        <main id="pane" style="height: 540px; overflow-y: auto">${ROWS}</main>
      </body>`);
    await scroll('bottom');
    const pane = await offsets('#pane');
    expect(pane.top).toBe(pane.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('scrolls the page, not a pane that happens to sit under the center', async () => {
    await page.setContent(`<div style="height: 250px"></div><div id="pane" style="height: 200px; overflow-y: auto">${ROWS}</div>${ROWS}`);
    await scroll('bottom');
    const root = await offsets();
    expect(root.top).toBe(root.maxTop);
    expect((await offsets('#pane')).top).toBe(0);
  });

  it('lands at once under scroll-behavior: smooth', async () => {
    await page.setContent(`<style>html { scroll-behavior: smooth }</style>${ROWS}`);
    await scroll('bottom');
    const root = await offsets();
    expect(root.top).toBe(root.maxTop);
  });

  it.each(['open', 'closed'] as const)('reaches a pane inside a %s shadow root at the center', async (mode) => {
    // A navigation, not setContent: init scripts, the closed-root registry among them, run on a new document only.
    await page.goto(`data:text/html,${encodeURIComponent('<body style="margin: 0; overflow: hidden"><div id="host"></div></body>')}`);
    await page.evaluate(([rows, shadowMode]) => {
      const root = document.getElementById('host')!.attachShadow({ mode: shadowMode });
      root.innerHTML = `<div id="pane" style="height: 600px; overflow-y: auto">${rows}</div>`;
      (window as unknown as { pane: Element }).pane = root.getElementById('pane')!;
    }, [ROWS, mode] as const);
    await scroll('bottom');
    const pane = await page.evaluate(() => {
      const element = (window as unknown as { pane: Element }).pane;
      return { top: element.scrollTop, maxTop: element.scrollHeight - element.clientHeight };
    });
    expect(pane.maxTop).toBeGreaterThan(0);
    expect(pane.top).toBe(pane.maxTop);
  });

  it('resolves with nothing scrolled when the page is shorter than the viewport', async () => {
    await page.setContent('<p>Short</p>');
    await scroll('bottom');
    expect((await offsets()).top).toBe(0);
  });

  it('leaves a page locked with overflow: hidden alone', async () => {
    await page.setContent(`<body style="overflow: hidden">${ROWS}</body>`);
    await scroll('bottom');
    expect((await offsets()).top).toBe(0);
  });

  it('follows content that grows at the bottom until it stops growing', async () => {
    await page.setContent(`<div id="feed">${ROWS}</div>
      <script>
        let batches = 0;
        addEventListener('scroll', () => {
          if (batches < 3 && innerHeight + scrollY >= document.body.scrollHeight - 1) {
            batches += 1;
            document.getElementById('feed').insertAdjacentHTML('beforeend', '<p style="height: 400px">Batch ' + batches + '</p>');
          }
        });
      </script>`);
    await scroll('bottom');
    const bottom = await offsets();
    expect(await page.locator('text=Batch 3').count()).toBe(1);
    expect(bottom.top).toBe(bottom.maxTop);
  });

  it('gives up with OPERATION_TIMEOUT when the content never stops growing', async () => {
    await page.setContent(`${ROWS}
      <script>
        addEventListener('scroll', () => document.body.insertAdjacentHTML('beforeend', '<p style="height: 400px">More</p>'));
      </script>`);
    const failure = await scroll('bottom', undefined, 400).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', message: expect.stringContaining('more content kept loading at the bottom edge') });
  });
});

describe('scrollTo on a node', () => {
  const PANE = `<div id="pane" style="height: 300px; overflow-y: auto">${ROWS}</div>${ROWS}`;

  it('scrolls the node itself, not the page around it', async () => {
    await page.setContent(PANE);
    await scroll('bottom', '#pane');
    const pane = await offsets('#pane');
    expect(pane.top).toBe(pane.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('scrolls the nearest ancestor that scrolls when the node does not', async () => {
    await page.setContent(PANE);
    await scroll('bottom', '#pane p:first-child');
    const pane = await offsets('#pane');
    expect(pane.top).toBe(pane.maxTop);
  });

  it('scrolls the page from a node when the body\'s overflow belongs to the viewport, not the body itself', async () => {
    // Standards mode, where the root is the scrolling element: the body reports overflow-y auto and room to scroll, yet does not scroll.
    await page.setContent(`<!doctype html><style>html, body { height: 100% } body { overflow-x: hidden }</style><p id="first">Row 0</p>${ROWS}`);
    await scroll('bottom', '#first');
    const root = await offsets();
    expect(root.maxTop).toBeGreaterThan(0);
    expect(root.top).toBe(root.maxTop);
  });

  it.each([
    ['ltr', 'right'],
    ['ltr', 'left'],
    ['rtl', 'right'],
    ['rtl', 'left'],
  ] as const)('reaches the %s carousel\'s %s edge', async (dir, edge) => {
    const cards = Array.from({ length: 20 }, (_, index) => `<span style="display: inline-block; width: 200px">Card ${index + 1}</span>`).join('');
    await page.setContent(`<div id="carousel" dir="${dir}" style="width: 400px; overflow-x: auto; white-space: nowrap">${cards}</div>`);
    // Start in the middle so either edge is a move.
    await page.locator('#carousel').evaluate((element) => {
      element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2 * (getComputedStyle(element).direction === 'rtl' ? -1 : 1);
    });
    await scroll(edge, '#carousel');
    const carousel = await offsets('#carousel');
    // In right-to-left, the start is offset 0 at the right and the offsets run negative to the left.
    const expected = dir === 'ltr' ? (edge === 'left' ? 0 : carousel.maxLeft) : edge === 'right' ? 0 : -carousel.maxLeft;
    expect(Math.abs(carousel.left - expected)).toBeLessThanOrEqual(1);
  });

  it('scrolls the frame\'s own page from a node inside an iframe, and leaves the outer page alone', async () => {
    await page.setContent(`<iframe id="frame" style="height: 300px; width: 400px" srcdoc="${ROWS.replaceAll('"', '&quot;')}"></iframe>${ROWS}`);
    const inner = page.frameLocator('#frame').locator('p').first();
    await inner.waitFor();
    await scrollToEdge(page, { kind: 'locator', locator: inner }, 'bottom', { timeoutMs: 2_000, signal: new AbortController().signal });
    const frame = await page.frameLocator('#frame').locator(':root').evaluate((root) => ({ top: root.scrollTop, maxTop: root.scrollHeight - root.clientHeight }));
    expect(frame.maxTop).toBeGreaterThan(0);
    expect(frame.top).toBe(frame.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('walks from a slotted node up through its slot to the pane in the shadow root', async () => {
    await page.setContent(`<div id="host">${ROWS}</div>`);
    await page.evaluate(() => {
      const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<div id="pane" style="height: 300px; overflow-y: auto"><slot></slot></div>';
      (window as unknown as { pane: Element }).pane = root.getElementById('pane')!;
    });
    await scroll('bottom', '#host p:first-child');
    const pane = await page.evaluate(() => {
      const element = (window as unknown as { pane: Element }).pane;
      return { top: element.scrollTop, maxTop: element.scrollHeight - element.clientHeight };
    });
    expect(pane.maxTop).toBeGreaterThan(0);
    expect(pane.top).toBe(pane.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('waits for a node that is not visible yet, then scrolls it', async () => {
    await page.setContent(`<div id="pane" style="display: none; height: 300px; overflow-y: auto">${ROWS}</div>
      <script>setTimeout(() => { document.getElementById('pane').style.display = 'block'; }, 200);</script>`);
    await scroll('bottom', '#pane');
    const pane = await offsets('#pane');
    expect(pane.maxTop).toBeGreaterThan(0);
    expect(pane.top).toBe(pane.maxTop);
  });
});
