/**
 * `tap` with a mouse button against a real page, through both kinds of target
 * the engine acts on: a deterministic locator and an element handle from an
 * agent observation. The page reads the button and the held keys off the
 * events the click fires.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocatorAction } from '@e2e-dev/core/engine';
import { dispatchLocatorAction } from '../../src/actions.ts';
import { ElementList } from '../../src/element-list.ts';
import type { ActionTarget } from '../../src/support.ts';

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
  page = await browser.newPage();
  await page.setContent(`<a href="/next">Next</a><p></p>
<script>
  const pressed = (event) => {
    event.preventDefault();
    document.querySelector('p').textContent = [event.type, event.button, event.shiftKey && 'shift'].filter((part) => part !== false).join(' ');
  };
  document.querySelector('a').addEventListener('click', pressed);
  document.querySelector('a').addEventListener('auxclick', pressed);
</script>`);
});

/** The link as the engine would hold it: a locator, or the element handle an observed ref resolves to. */
async function linkAs(kind: 'locator' | 'element'): Promise<ActionTarget> {
  const locator = page.locator('a');
  if (kind === 'locator') return { kind, locator };
  const walk = new ElementList(await locator.evaluateHandle((node) => [node]));
  return { kind, element: await walk.at(0) };
}

async function tap(target: ActionTarget, action: LocatorAction): Promise<string | null> {
  await dispatchLocatorAction(target, action, { timeoutMs: 2000, signal: new AbortController().signal }, () => {
    throw new Error('no second target');
  });
  return page.locator('p').textContent();
}

describe.each(['locator', 'element'] as const)('a tap on %s', (kind) => {
  it('with the middle button fires auxclick with button 1', async () => {
    expect(await tap(await linkAs(kind), { kind: 'tap', button: 'middle' })).toBe('auxclick 1');
  });

  it('with the middle button holds the modifiers it names', async () => {
    expect(await tap(await linkAs(kind), { kind: 'tap', button: 'middle', modifiers: ['Shift'] })).toBe('auxclick 1 shift');
  });

  it('with no button clicks with the primary one', async () => {
    expect(await tap(await linkAs(kind), { kind: 'tap' })).toBe('click 0');
  });
});
