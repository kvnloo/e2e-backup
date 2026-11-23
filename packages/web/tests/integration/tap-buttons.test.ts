/**
 * Tests `tap` with a mouse button on a real page, for both kinds of
 * `ActionTarget`: a locator from a test, and an element handle from an agent
 * observation. The button and held keys of each click event are written into
 * the page's text.
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

/** Returns the link as an action target: a locator, or the element handle an observed ref resolves to. */
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

  it('with the middle button and Shift fires auxclick with shiftKey', async () => {
    expect(await tap(await linkAs(kind), { kind: 'tap', button: 'middle', modifiers: ['Shift'] })).toBe('auxclick 1 shift');
  });

  it('with no button fires click with button 0', async () => {
    expect(await tap(await linkAs(kind), { kind: 'tap' })).toBe('click 0');
  });
});
