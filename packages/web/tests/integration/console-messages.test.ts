/**
 * Tests `browser.consoleMessages` and `browser.pageErrors` in a real browser.
 *
 * The lists have the messages and errors from the active tab since it
 * opened, across navigations, frames, and dedicated workers. Each tab has
 * separate lists. A persistent browser's first tab starts with empty lists,
 * so what it logged before the attempt is left out.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web, type Browser, type WebOptions } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-console', attemptId: 'c1', origin: 'test' };
}

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

describe('browser.consoleMessages and browser.pageErrors', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  let engine: EngineHandle;
  let browser: Browser;
  let remote: RemoteChrome | undefined;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-console-'));
  });

  afterAll(async () => {
    await app.close();
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
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
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
    await browser.goto('/page-errors');

    await expect.poll(async () => (await browser.pageErrors()).map((error) => error.message).toSorted()).toEqual(['rejected', 'thrown']);
    for (const error of await browser.pageErrors()) {
      expect(error.stack).toContain(error.message);
    }
  });

  it('returns a thrown or rejected value that isn\'t an Error as its text, with an empty stack', async () => {
    await start();
    await browser.goto('/thrown-values');

    await expect.poll(async () => (await browser.pageErrors()).toSorted((a, b) => a.message.localeCompare(b.message))).toEqual([
      { message: '7', stack: '' },
      { message: 'plain', stack: '' },
    ]);
  });

  it('includes the messages and errors from the tab\'s frames and dedicated workers', async () => {
    await start();
    await browser.goto('/nested-console');

    await expect.poll(async () => (await browser.consoleMessages()).map((message) => message.text).toSorted()).toEqual(['from frame', 'from worker']);
    await expect.poll(async () => (await browser.pageErrors()).map((error) => error.message)).toEqual(['frame error']);
  });

  it('keeps the messages and errors from earlier documents in the tab', async () => {
    await start();
    await browser.goto('/console');
    await browser.goto('/page-errors');
    await expect.poll(async () => (await browser.pageErrors()).length).toBe(2);

    await browser.goto('/');

    expect(await browser.consoleMessages()).toHaveLength(3);
    expect(await browser.pageErrors()).toHaveLength(2);
  });

  it('keeps a separate list for each tab', async () => {
    await start();
    await browser.goto('/console');
    await expect.poll(async () => (await browser.consoleMessages()).length).toBe(3);

    await browser.newTab();

    expect(await browser.consoleMessages()).toEqual([]);
    await browser.tabs()[0]!.activate();
    expect(await browser.consoleMessages()).toHaveLength(3);
  });

  it('leaves out what a persistent browser\'s first tab logged before the attempt, and keeps what its init scripts log', async () => {
    remote = await launchRemoteChrome();
    const host = await chromium.connectOverCDP(remote.endpoint);
    const tab = host.contexts()[0]!.pages()[0]!;
    await tab.goto(`${app.url}/console`);
    await tab.goto(`${app.url}/page-errors`);
    await expect.poll(async () => (await tab.pageErrors({ filter: 'all' })).length).toBe(2);
    await host.close();

    const endpoint = remote.endpoint;
    await start({
      connect: { cdpEndpoint: () => endpoint, reconnectEndpoint: () => endpoint },
      initScripts: ["throw new Error('from init script')"],
    });
    await browser.goto('/');

    expect(await browser.consoleMessages()).toEqual([]);
    await expect.poll(async () => (await browser.pageErrors()).map((error) => error.message)).toEqual(['from init script', 'from init script']);
  });
});
