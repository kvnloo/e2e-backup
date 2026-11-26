/** Compile-time assertions for `browser.locator(selector, { within })`, a web-only scope that stays off shared types. */
import type { Locator, Screen } from '@e2e-dev/core';
import type { Browser, FrameScreen } from '../../src/index.ts';

declare const browser: Browser;
declare const frame: FrameScreen;
declare const screen: Screen;

const row: Locator = screen.getByRole('row', { name: 'Ada' });
void (browser.locator('td.price', { within: row }) satisfies Locator);
void browser.locator('td', { within: frame.getByRole('row').filter({ hasText: 'Ada' }).first() });

// @ts-expect-error within takes a locator, not a selector string.
void browser.locator('td', { within: 'tr' });
// @ts-expect-error a frame's locator has no within: the scope locator already names its frame.
void frame.locator('td', { within: row });
// @ts-expect-error the shared Locator gets no CSS chaining, so page objects stay portable.
void row.locator('td');
