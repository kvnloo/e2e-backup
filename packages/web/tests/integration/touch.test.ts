/** Touch emulation in real Chromium. A tap sends touch events when `web({ hasTouch: true })` is set. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorAction, OperationContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface, type WebOptions } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const LISTEN = `<script>
  window.events = [];
  for (const type of ['touchstart', 'touchend', 'click']) {
    document.addEventListener(type, (event) => window.events.push(event.shiftKey ? type + '+shift' : type));
  }
</script>`;

const PAGE = `<button style="width:200px;height:100px">Go</button>${LISTEN}`;

/** A checkbox that doesn't show a box, so it's tapped through its label. */
const LABELLED = `<label><input type="checkbox" style="position:absolute;opacity:0;width:0;height:0;margin:0">Accept</label>${LISTEN}`;

/** A scrollable list with a button, placed below the top of a scrollable page. `:hover` needs standards mode. */
const LIST = `<!doctype html><div role="list" style="height:200px;overflow:auto;margin-top:300px"><button>Row</button><div style="height:2000px"></div></div><div style="height:3000px"></div>${LISTEN}`;

const signal = new AbortController().signal;
const operation = (): OperationContext => ({ signal, timeoutMs: 10_000, runId: 'touch', attemptId: 'a', origin: 'test' });
const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-touch-'));

afterAll(() => rmSync(projectRoot, { recursive: true, force: true }));

/** Runs `act` in one attempt of a surface built with `options`, and disposes the surface after it. */
async function withSurface(options: WebOptions, act: (surface: PlaywrightSurface) => Promise<void>): Promise<void> {
  const surface = new PlaywrightSurface(options);
  try {
    await surface.init({ runId: 'touch', targetName: 'web', projectRoot, app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'a', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await act(surface);
  } finally {
    await surface.dispose({ signal, timeoutMs: 10_000 });
  }
}

/** Runs `act` on a page with `content` and returns the open page's event log after `act` finishes. */
async function eventsOf(options: WebOptions, act: (surface: PlaywrightSurface) => Promise<void>, content = PAGE): Promise<string[]> {
  let events: string[] = [];
  await withSurface(options, async (surface) => {
    await (await surface.ensurePage()).setContent(content);
    await act(surface);
    events = await (await surface.ensurePage()).evaluate(() => (window as unknown as { events: string[] }).events);
  });
  return events;
}

/** Performs `action` on the first node of `role` the surface locates. */
async function performOn(surface: PlaywrightSurface, role: string, action: LocatorAction = { kind: 'tap' }): Promise<void> {
  const [node] = await surface.locate({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: role, exact: true } } }, operation());
  if (node === undefined) throw new Error(`no ${role} was located`);
  await surface.perform(node.ref, action, operation());
}

const tapButton = (surface: PlaywrightSurface) => performOn(surface, 'button');

describe('web({ hasTouch })', () => {
  it('taps a node with touch events followed by a click', async () => {
    expect(await eventsOf({ hasTouch: true }, tapButton)).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('sends touch events to the label when a checkbox has no box', async () => {
    const events = await eventsOf({ hasTouch: true }, async (surface) => {
      await performOn(surface, 'checkbox');
      expect(await (await surface.ensurePage()).isChecked('input')).toBe(true);
    }, LABELLED);
    expect(events.slice(0, 3)).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('keeps modifiers held for a touch tap and its click', async () => {
    const events = await eventsOf({ hasTouch: true }, (surface) => performOn(surface, 'button', { kind: 'tap', modifiers: ['Shift'] }));
    expect(events).toEqual(['touchstart+shift', 'touchend+shift', 'click+shift']);
  });

  it('taps a point with touch events', async () => {
    const events = await eventsOf({ hasTouch: true }, async (surface) => {
      await surface.observe(operation());
      await surface.performAt({ x: 50, y: 50 }, { kind: 'tap' }, operation());
    });
    expect(events).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('keeps tapping with touch events after the context is replaced', async () => {
    const events = await eventsOf({ hasTouch: true }, async (surface) => {
      await surface.reset(operation());
      await (await surface.ensurePage()).setContent(PAGE);
      await tapButton(surface);
    });
    expect(events).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('scrolls the list instead of the page after a touch tap inside it', async () => {
    await eventsOf({ hasTouch: true }, async (surface) => {
      await tapButton(surface);
      await performOn(surface, 'list', { kind: 'swipe', direction: 'down' });
      const [listTop, pageTop] = await (await surface.ensurePage()).evaluate(() => [document.querySelector('[role="list"]')?.scrollTop ?? 0, window.scrollY]);
      expect(listTop).toBeGreaterThan(0);
      expect(pageTop).toBe(0);
    }, LIST);
  });

  it('sends a mouse click with no touch events for click()', async () => {
    expect(await eventsOf({ hasTouch: true }, (surface) => performOn(surface, 'button', { kind: 'tap', click: true }))).toEqual(['click']);
  });

  it('sends a mouse click with no touch events for click() at a point', async () => {
    const events = await eventsOf({ hasTouch: true }, async (surface) => {
      await surface.observe(operation());
      await surface.performAt({ x: 50, y: 50 }, { kind: 'tap', click: true }, operation());
    });
    expect(events).toEqual(['click']);
  });

  it('clicks without touch events by default', async () => {
    expect(await eventsOf({}, tapButton)).toEqual(['click']);
  });
});

describe('web({ hasTouch }) navigation', () => {
  /** Serves a link to a route that responds after 400 ms. */
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/slow') await sleep(400);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/slow' ? '<h1>Next</h1>' : '<a href="/slow">Next</a>');
    })();
  });
  let url = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the server has no port');
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('waits for navigation after click(), like a mouse click', async () => {
    await withSurface({ hasTouch: true }, async (surface) => {
      const page = await surface.ensurePage();
      await page.goto(url);
      await performOn(surface, 'link', { kind: 'tap', click: true });
      expect(page.url()).toBe(`${url}/slow`);
    });
  });
});
