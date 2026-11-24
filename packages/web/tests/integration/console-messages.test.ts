/**
 * Tests `browser.consoleMessages` and `browser.pageErrors` in a real browser.
 *
 * The lists have the messages and errors from the active tab since it
 * opened, across navigations. They don't include entries from a page
 * replaced by `app.restart()`, or from a persistent browser's first tab
 * before the attempt.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web, type Browser, type WebOptions } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const PAGES: Readonly<Record<string, string>> = {
  '/console': `<script>console.log('ready'); console.warn('slow'); console.error('broken', 42);</script>`,
  '/errors': `<script>
    Promise.reject(new Error('rejected'));
    setTimeout(() => { throw new Error('thrown'); });
  </script>`,
  '/values': `<script>
    Promise.reject('plain');
    setTimeout(() => { throw 7; });
  </script>`,
  '/quiet': '<p>quiet</p>',
};

function startServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Console</title>${PAGES[request.url ?? ''] ?? ''}`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-console', attemptId: 'c1', origin: 'test' };
}

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

describe('browser.consoleMessages and browser.pageErrors', () => {
  let server: Server;
  let origin: string;
  let artifactsDir: string;
  let engine: EngineHandle;
  let browser: Browser;
  let remote: RemoteChrome | undefined;

  beforeAll(async () => {
    ({ server, origin } = await startServer());
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-console-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Creates an engine with `options`, starts an attempt, and gets its `browser` fixture. */
  async function start(options: WebOptions = {}): Promise<void> {
    engine = web(options);
    await engine.init!({
      runId: 'run-console', targetName: 'web', projectRoot: process.cwd(),
      app: { site: '127.0.0.1' }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'c1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    browser = engine.fixtures!['browser']!({
      operation,
      app: { resolveUrl: (url: string) => new URL(url, origin).href },
      timeouts: { test: 30_000, action: 5_000, assertion: 5_000 },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext) as Browser;
  }

  afterEach(async () => {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    if (remote !== undefined) await closeRemoteChrome(remote);
    remote = undefined;
  });

  it('returns the console messages logged on the page, errors included', async () => {
    await start();
    await browser.goto('/console');

    await expect.poll(() => browser.consoleMessages()).toEqual([
      { type: 'log', text: 'ready' },
      { type: 'warning', text: 'slow' },
      { type: 'error', text: 'broken 42' },
    ]);
  });

  it('returns thrown errors and unhandled rejections with their message and stack', async () => {
    await start();
    await browser.goto('/errors');

    await expect.poll(async () => (await browser.pageErrors()).map((error) => error.message).toSorted()).toEqual(['rejected', 'thrown']);
    for (const error of await browser.pageErrors()) {
      expect(error.stack).toContain(error.message);
    }
  });

  it('returns a thrown or rejected value that isn\'t an Error as its text, with an empty stack', async () => {
    await start();
    await browser.goto('/values');

    await expect.poll(async () => (await browser.pageErrors()).toSorted((a, b) => a.message.localeCompare(b.message))).toEqual([
      { message: '7', stack: '' },
      { message: 'plain', stack: '' },
    ]);
  });

  it('keeps the messages and errors from earlier documents in the tab', async () => {
    await start();
    await browser.goto('/console');
    await browser.goto('/errors');
    await expect.poll(async () => (await browser.pageErrors()).length).toBe(2);

    await browser.goto('/quiet');

    expect(await browser.consoleMessages()).toHaveLength(3);
    expect(await browser.pageErrors()).toHaveLength(2);
  });

  it('starts empty on the new page after a restart', async () => {
    await start();
    await browser.goto('/console');
    await browser.goto('/errors');
    await expect.poll(async () => (await browser.pageErrors()).length).toBe(2);

    await engine.session!.restart!(operation());

    expect(await browser.consoleMessages()).toEqual([]);
    expect(await browser.pageErrors()).toEqual([]);
  });

  it('leaves out the messages and errors from a persistent browser\'s first tab before the attempt', async () => {
    remote = await launchRemoteChrome();
    const host = await chromium.connectOverCDP(remote.endpoint);
    const tab = host.contexts()[0]!.pages()[0]!;
    await tab.goto(`${origin}/console`);
    await tab.goto(`${origin}/errors`);
    await expect.poll(async () => (await tab.pageErrors({ filter: 'all' })).length).toBe(2);
    await host.close();

    const endpoint = remote.endpoint;
    await start({ connect: { cdpEndpoint: () => endpoint, reconnectEndpoint: () => endpoint } });
    await browser.goto('/quiet');

    expect(await browser.consoleMessages()).toEqual([]);
    expect(await browser.pageErrors()).toEqual([]);
  });

  it('rejects with INVALID_STATE before a page opens', async () => {
    await start();
    await expect(browser.consoleMessages()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(browser.pageErrors()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
